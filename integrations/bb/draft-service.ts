import { randomUUID } from "node:crypto";
import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision, PluginAgentConfiguration, PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createDraftExecutionResolver } from "./draft-execution";
import { DRAFT_LIMITS, DRAFT_DEADLINE_MS, draftJobSchema, draftRecordSchema, draftRpcMethods, type DraftConfig, type DraftJob, type DraftRecord, type DraftSelection } from "./draft-contract";
import { DRAFT_BOOTSTRAP, DRAFT_WORKER_INSTRUCTIONS, draftWorkerMarkerSchema, hasDraftMarker } from "./draft-policy";
import { draftHash, draftProposals, extractDraftSource, turnOutcomes, validateDraftOutput, verifyDraftSource } from "./draft-validation";
import type { Knowledge } from "./workstream-contract";
import type { Workstreams } from "./workstreams";

type WorkerThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
type TimelineRows = Extract<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>, { rows: unknown }>["rows"];
const textOf = (parts: readonly { type: string; text?: string }[]) => parts.map(p => p.type === "text" ? p.text ?? "" : "").join("");
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 8000);
const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const sourceKey = (s: Knowledge["sources"][number]) => JSON.stringify([s.ref, s.authorType, s.observedAt, s.excerpt ?? ""]);
/** The model a draft chose for itself, re-checked at Start instead of the Drafting setting. */
function overrideOf(r: DraftRecord): DraftSelection | undefined {
  return r.execution.origin === "override" ? executionConfig(r, false).selection ?? undefined : undefined;
}
function executionConfig(r: DraftRecord, follow = true): DraftConfig {
  return { revision: r.execution.configRevision, selection: follow && r.execution.origin === "source-thread" ? null : { providerId: r.execution.providerId, model: r.execution.model, reasoningLevel: r.execution.reasoningLevel, ...(r.execution.serviceTier === undefined ? {} : { serviceTier: r.execution.serviceTier }) }, updatedAt: null, updatedBy: null };
}
export function draftPayload(r: DraftRecord): string {
  return JSON.stringify({ protocol: "cortex-draft.v1", requestId: r.requestId, instructions: DRAFT_WORKER_INSTRUCTIONS,
    sourceLabel: r.source.label, data: r.source.messages.map(m => ({ messageId: m.messageId, messageSeq: m.messageSeq, role: m.role, reportedAuthorType: m.authorType, quote: m.quote })),
    output: { findings: "At most 3 objects with title (200 chars), text (4000 chars) and sources [{messageId,messageSeq,quote}]. Exact quotes must come from DATA. No kind, scope, authority, approval, tool actions or extra fields. Return {findings:[]} when nothing is supported. JSON only, at most 32768 UTF-8 bytes." },
  });
}
export function createDraftService(bb: BbPluginApi, workstreams: Workstreams) {
  const store = workstreams.store.drafts;
  const resolver = createDraftExecutionResolver(bb, store);
  const locks = new Map<string, Promise<unknown>>();
  function exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task); locks.set(id, next);
    void next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => undefined);
    return next;
  }
  const view = (record: DraftRecord) => {
    const selected = Object.fromEntries(Object.keys(draftJobSchema.shape).map(key => [key, record[key as keyof DraftRecord]]));
    return draftJobSchema.parse({ ...selected, candidateResults: record.candidateResults.slice(0, record.findingCount ?? 0) });
  };
  function current(id: string): DraftRecord { const r = store.get(id); if (!r) throw new Error("Draft job not found."); return r; }
  function change(id: string, patch: Partial<DraftRecord>): DraftRecord {
    const r = current(id); const next = store.update({ ...r, ...patch }, r.revision);
    bb.realtime.publish("drafts", { sectionId: next.sectionId, requestId: id, revision: next.revision }); return next;
  }
  function checkLive(r: DraftRecord) {
    if (r.cancellation.state !== "none") throw new Error("Draft cancellation is already requested; no new inference or write is allowed.");
    if (Date.now() >= Date.parse(r.deadlineAt)) throw new Error("Draft deadline expired; stop/discover the existing worker, never resend source.");
  }
  async function verifySource(r: DraftRecord, signal?: AbortSignal) {
    const binding = workstreams.store.section(r.sectionId);
    if (binding.revision !== r.bindingRevision || binding.binding?.workstreamId !== r.workstreamId) throw new Error("Draft binding changed. A fresh explicit source is required; the note was not retargeted.");
    const thread = await bb.sdk.threads.get({ threadId: r.sourceThreadId, signal });
    if (thread.id !== r.sourceThreadId || thread.sectionId !== r.sectionId || thread.archivedAt !== null || thread.deletedAt !== null || thread.visibility !== "visible") throw new Error("Draft source thread changed or became unavailable.");
    const canonical = await workstreams.cli.show({ id: r.workstreamId, limit: 1, offset: 0 }, signal);
    if (canonical.workstream.id !== r.workstreamId || canonical.workstream.revision !== r.workstreamRevision || canonical.workstream.archived) throw new Error("Draft canonical workstream changed; refresh explicit source.");
    const messages: unknown[] = [];
    for (const m of r.source.messages) { const result = await bb.sdk.threads.message({ threadId: r.sourceThreadId, seq: m.messageSeq, before: 0, after: 0, signal }); messages.push(result.message); }
    verifyDraftSource(r.source, messages);
    const again = workstreams.store.section(r.sectionId);
    if (again.revision !== r.bindingRevision || again.binding?.workstreamId !== r.workstreamId) throw new Error("Draft binding changed during source verification.");
  }
  async function ownWorker(r: DraftRecord, workerId = r.worker.threadId, signal?: AbortSignal): Promise<WorkerThread> {
    if (!workerId || !r.personalProjectId) throw new Error("Owned drafting worker identity is unresolved.");
    const thread = await bb.sdk.threads.get({ threadId: workerId, signal });
    if (thread.id !== workerId || thread.projectId !== r.personalProjectId || thread.parentThreadId !== r.sourceThreadId || thread.parentNotifications !== "off" || thread.sourceThreadId !== null || thread.originKind !== null || thread.originPluginId !== bb.pluginId || thread.visibility !== "hidden" || thread.sectionId !== null || thread.providerId !== r.execution.providerId || thread.deletedAt !== null) throw new Error("Draft worker origin/personal/parent/provider identity could not be verified. No foreign worker was changed.");
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: workerId, signal });
    const marker = draftWorkerMarkerSchema.safeParse(metadata.cortexDraftWorker);
    if (!marker.success || marker.data.requestId !== r.requestId || marker.data.nonce !== r.workerNonce) throw new Error("Draft worker private nonce mapping does not match.");
    if (thread.environmentId !== null) {
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId, signal });
      if (environment.id !== thread.environmentId || environment.hostId !== r.execution.hostId || environment.projectId !== r.personalProjectId || environment.workspaceProvisionType !== "personal") throw new Error("Draft worker environment is not the pinned personal host route.");
    }
    return thread;
  }
  async function setupQueue(r: DraftRecord, workerId: string, signal?: AbortSignal) {
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId: workerId, signal });
    if (rows.length !== 1) throw new Error("Draft setup queue is incomplete/consumed or has extra rows. Stop/discover, never send a replacement message.");
    const row = rows[0];
    if (row.threadId !== workerId || row.origin !== "plugin" || row.originPluginId !== bb.pluginId || row.senderThreadId !== r.sourceThreadId || row.initiator !== "agent" || row.payload.kind !== "inline" || row.content.length !== 1 || textOf(row.content) !== DRAFT_BOOTSTRAP || row.state !== "scheduled" || row.sendAt === null || row.sendAt <= Date.now() || row.model !== r.execution.model || row.reasoningLevel !== r.execution.reasoningLevel || row.serviceTier !== (r.execution.serviceTier ?? "default") || row.permissionMode !== "accept-edits") throw new Error("Draft setup row expired, changed, or was consumed. It will never receive a new inference message.");
    if (r.bootstrapQueueId !== null && (r.bootstrapQueueId !== row.id || r.setupUpdatedAt !== row.updatedAt || r.setupSendAt !== row.sendAt)) throw new Error("Draft setup queue revision changed. Refresh recovery; no automatic rebase or resend.");
    return row;
  }
  function verifyOwnedQueue(r: DraftRecord, row: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>>[number], workerId: string) {
    const part = row.content[0];
    const exactText = row.content.length === 1 && part.type === "text" && part.mentions.length === 0 && part.visibility === undefined && Object.keys(part).every(key => ["type", "text", "mentions", "visibility"].includes(key));
    const bootstrap = exactText && part.text === DRAFT_BOOTSTRAP;
    const activation = exactText && r.activationHash !== null && r.activationHash === draftHash(draftPayload(r)) && part.text === draftPayload(r);
    const pinnedInput = bootstrap
      ? row.id === r.bootstrapQueueId && r.setupUpdatedAt !== null && row.updatedAt === r.setupUpdatedAt && r.setupSendAt !== null && row.sendAt === r.setupSendAt && row.state === "scheduled"
      : activation && r.activationAttempted && row.id === r.activationQueueId && r.activationUpdatedAt !== null && row.updatedAt === r.activationUpdatedAt && row.sendAt === null;
    if (!pinnedInput || row.threadId !== workerId || row.origin !== "plugin" || row.originPluginId !== bb.pluginId || row.senderThreadId !== r.sourceThreadId || row.initiator !== "agent" || row.payload.kind !== "inline" || row.groupWithNext || row.systemNotice !== null || row.model !== r.execution.model || row.reasoningLevel !== r.execution.reasoningLevel || row.serviceTier !== (r.execution.serviceTier ?? "default") || row.permissionMode !== "accept-edits") throw new Error("Draft queue input, execution, schedule or version changed/unverified; the row was preserved. Resolve the original queued row explicitly, then retry cancellation. No source was resent or worker hidden.");
  }
  async function stopOwned(id: string, signal?: AbortSignal) {
    const r = current(id); const thread = await ownWorker(r, undefined, signal);
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId: thread.id, signal });
    if (rows.length > 1 || rows.some(q => q.id !== r.bootstrapQueueId || q.threadId !== thread.id || q.originPluginId !== bb.pluginId)) throw new Error("Unexpected worker queue contents; cancellation remains unconfirmed.");
    for (const row of rows) verifyOwnedQueue(r, row, thread.id);
    // Public delete has no revision CAS; an edit after this verified read remains a host-side race.
    for (const row of rows) await bb.sdk.threads.queuedMessages.delete({ threadId: thread.id, queuedMessageId: row.id });
    let stopError: unknown = null;
    try { await bb.sdk.threads.stop({ threadId: thread.id, signal }); } catch (e) { stopError = e; }
    const live = await ownWorker(current(id), undefined, signal);
    const remaining = await bb.sdk.threads.queuedMessages.list({ threadId: live.id, signal });
    if (remaining.length || !["idle", "error"].includes(live.status) || !["idle", "error"].includes(live.runtime.displayStatus)) throw new Error(stopError ? errorText(stopError) : "Worker inactivity is not confirmed; cancellation remains requested.");
    let next = change(id, { worker: { state: "stopped", threadId: live.id } });
    if (next.cancellation.state !== "none") next = change(id, { cancellation: { ...next.cancellation, state: "confirmed", confirmedAt: new Date().toISOString() }, status: "stopped", active: false, retry: next.output === null ? "none" : "lookup-save" });
    if (live.archivedAt === null) { await bb.sdk.threads.archive({ threadId: live.id, signal }); next = change(id, { archived: true }); }
    else if (!next.archived) next = change(id, { archived: true });
    return next;
  }
  async function sourcePreview(input: z.infer<typeof draftRpcMethods.draftSourcePreview.input>, signal?: AbortSignal) {
    const section = (await bb.sdk.threadSections.list({ signal })).find(s => s.id === input.sectionId);
    if (!section) throw new Error("Source section not found.");
    const binding = workstreams.store.section(input.sectionId);
    if (!binding.binding || binding.revision !== input.expectedBindingRevision) throw new Error("Draft source binding revision conflict. Refresh the section.");
    const thread = await bb.sdk.threads.get({ threadId: input.sourceThreadId, signal });
    if (thread.id !== input.sourceThreadId || thread.sectionId !== input.sectionId || thread.archivedAt !== null || thread.deletedAt !== null || thread.visibility !== "visible") throw new Error("Choose a visible source thread in this connected section.");
    const canonical = await workstreams.cli.show({ id: binding.binding.workstreamId, limit: 1, offset: 0 }, signal);
    if (canonical.workstream.archived) throw new Error("The connected workstream is archived.");
    const timeline = await bb.sdk.threads.timeline({ threadId: thread.id, segmentLimit: String(DRAFT_LIMITS.segments), includeNestedRows: "true", summaryOnly: "false", deferContent: "false", signal });
    const turns = timeline.rows.some(row => row.kind === "conversation") ? await outcomesOf(thread.id, signal) : new Map();
    const execution = await resolver.resolve(thread.id, signal, undefined, undefined, input.selection);
    const again = await bb.sdk.threads.get({ threadId: thread.id, signal });
    if (again.sectionId !== input.sectionId || again.archivedAt !== null || again.deletedAt !== null || workstreams.store.section(input.sectionId).revision !== binding.revision) throw new Error("Draft source changed during preview. Refresh preview; no source was retargeted.");
    const source = extractDraftSource({ sectionId: input.sectionId, sourceThreadId: thread.id, bindingRevision: binding.revision, workstreamId: canonical.workstream.id, workstreamRevision: canonical.workstream.revision, historySnapshot: timeline.timelinePage.historySnapshot }, timeline.rows, Date.now(), turns);
    return store.snapshotPut(source, execution.execution, execution.personalProjectId);
  }
  async function start(input: z.infer<typeof draftRpcMethods.draftStart.input>, signal?: AbortSignal): Promise<DraftJob> {
    return exclusive(input.requestId, async () => {
      const parsed = draftRpcMethods.draftStart.input.parse(input); const old = store.get(parsed.requestId);
      if (old) { if (old.fingerprint !== draftHash(JSON.stringify(parsed))) throw new Error("Draft request ID conflict: original intent is immutable."); return view(old); }
      const preview = store.snapshotGet(parsed.sourceSnapshotId);
      if (!preview) throw new Error("Draft source snapshot expired or unavailable. Refresh preview.");
      const { execution, personalProjectId, ...source } = preview; const now = new Date().toISOString();
      const deadlineAt = new Date(Math.min(Date.now() + DRAFT_DEADLINE_MS, Date.parse(source.expiresAt))).toISOString();
      const r = store.create(draftRecordSchema.parse({ requestId: parsed.requestId, revision: 1, sectionId: parsed.sectionId, sourceThreadId: parsed.sourceThreadId, sourceSnapshotId: parsed.sourceSnapshotId, bindingRevision: parsed.expectedBindingRevision, workstreamId: source.workstreamId, workstreamRevision: source.workstreamRevision, requestedAt: now, updatedAt: now, deadlineAt,
        status: "prepared", execution, worker: { threadId: null, state: "not-requested" }, cancellation: { state: "none", requestedAt: null, confirmedAt: null }, candidateResults: Array.from({ length: 3 }, () => ({ intendedId: `kn_${randomUUID()}`, canonicalId: null, status: "pending", error: null })), progress: "Checking the exact preview/source before native setup.", error: null, retry: "none", intent: parsed, fingerprint: draftHash(JSON.stringify(parsed)), source, requester: workstreams.human(), workerNonce: randomUUID(), bootstrapQueueId: null, activationQueueId: null, active: true, output: null, personalProjectId }));
      bb.realtime.publish("drafts", { sectionId: r.sectionId, requestId: r.requestId, revision: r.revision });
      try {
        checkLive(current(r.requestId)); await verifySource(r, signal);
        const fresh = await resolver.resolve(r.sourceThreadId, signal, executionConfig(r), undefined, overrideOf(r));
        resolver.compare(fresh.execution, r.execution);
        if (fresh.personalProjectId !== r.personalProjectId) throw new Error("Draft preview personal route changed. Refresh preview.");
        checkLive(current(r.requestId));
        const sendAt = Date.now() + 24 * 60 * 60_000;
        change(r.requestId, { status: "setup-requested", worker: { state: "requesting", threadId: null }, setupSendAt: sendAt, progress: "Creating only an inert future setup row; no source has been sent." });
        let created: WorkerThread;
        try { created = await bb.sdk.threads.spawn({ projectId: r.personalProjectId!, parentThreadId: r.sourceThreadId, senderThreadId: r.sourceThreadId, parentNotifications: "off", visibility: "hidden", sectionId: null, environment: { type: "host", workspace: { type: "personal" }, hostId: r.execution.hostId }, providerId: r.execution.providerId, model: r.execution.model, reasoningLevel: r.execution.reasoningLevel, ...(r.execution.serviceTier === undefined ? {} : { serviceTier: r.execution.serviceTier }), permissionMode: "accept-edits", startedOnBehalfOf: { initiator: "agent", senderThreadId: r.sourceThreadId }, origin: "plugin", input: [{ type: "text", text: DRAFT_BOOTSTRAP, mentions: [] }], sendAt, pluginMetadata: { memoryMode: "off", cortexDraftWorker: { role: "draft-worker", requestId: r.requestId, nonce: r.workerNonce } } }); }
        catch (e) { change(r.requestId, { status: "setup-uncertain", worker: { state: "unknown", threadId: null }, error: errorText(e), retry: "discover-stop", progress: "Setup response is uncertain. Discover the original nonce; never respawn." }); return view(current(r.requestId)); }
        await ownWorker(current(r.requestId), created.id, signal);
        change(r.requestId, { worker: { state: "known", threadId: created.id } });
        const row = await setupQueue(current(r.requestId), created.id, signal);
        change(r.requestId, { worker: { state: "known", threadId: created.id }, bootstrapQueueId: row.id, setupUpdatedAt: row.updatedAt, setupSendAt: row.sendAt });
        checkLive(current(r.requestId)); await verifySource(current(r.requestId), signal);
        const pinned = await resolver.resolve(r.sourceThreadId, signal, executionConfig(r, false), { hostId: r.execution.hostId, personalProjectId: r.personalProjectId! }, overrideOf(r));
        resolver.compare({ ...pinned.execution, origin: r.execution.origin }, r.execution);
        const ready = current(r.requestId); checkLive(ready);
        const unchanged = await setupQueue(ready, created.id, signal);
        checkLive(current(r.requestId));
        const payload = draftPayload(ready);
        change(r.requestId, { status: "activating", activationQueueId: unchanged.id, activationHash: draftHash(payload), activationAttempted: true, progress: "One CAS replacement of the inert row requests normal dispatch." });
        const activated = await bb.sdk.threads.queuedMessages.update({ threadId: created.id, queuedMessageId: unchanged.id, expectedUpdatedAt: unchanged.updatedAt, input: [{ type: "text", text: payload, mentions: [] }], sendAt: null });
        const confirmed = { ...current(r.requestId), activationUpdatedAt: activated.updatedAt };
        verifyOwnedQueue(confirmed, activated, created.id);
        change(r.requestId, { activationUpdatedAt: activated.updatedAt });
        const after = current(r.requestId);
        if (after.cancellation.state === "none" && after.status === "activating") change(r.requestId, { status: "queued", progress: "Waiting for the approved normal dispatch." });
      } catch (e) {
        const latest = current(r.requestId);
        change(r.requestId, { status: latest.cancellation.state === "confirmed" ? "stopped" : latest.cancellation.state !== "none" ? "cancel-requested" : latest.worker.state === "not-requested" ? "failed" : "needs-recovery", active: latest.worker.state !== "not-requested", error: errorText(e), retry: latest.worker.state === "not-requested" ? "none" : "discover-stop" });
      }
      return view(current(r.requestId));
    });
  }
  function guard(ctx: MessageDispatchHookContext): MessageDispatchHookDecision | null {
    const r = store.byWorker(ctx.thread.id);
    if (!r) return restricted(ctx.thread.id, undefined, ctx.thread) ? { action: "reject", message: "Draft worker mapping is incomplete; only an inert setup was authorized. Recover the original private job; no source dispatch is admitted." } : null;
    const rejected = (reason: string): MessageDispatchHookDecision => ({ action: "reject", message: reason });
    if (r.worker.state !== "known" || r.cancellation.state !== "none" || Date.now() >= Date.parse(r.deadlineAt) || !["activating", "queued", "running", "needs-recovery"].includes(r.status) || !r.activationAttempted || !r.activationHash) return rejected("Cortex drafting worker is not admitted in its private phase/deadline. Stop/discover, never Send now.");
    if (ctx.thread.projectId !== r.personalProjectId || ctx.thread.parentThreadId !== r.sourceThreadId || ctx.thread.visibility !== "hidden" || ctx.thread.originPluginId !== bb.pluginId || ctx.host?.id !== r.execution.hostId || ctx.requestedExecution.providerId !== r.execution.providerId || ctx.requestedExecution.model !== r.execution.model || ctx.requestedExecution.reasoningLevel !== r.execution.reasoningLevel || ctx.requestedExecution.serviceTier !== (r.execution.serviceTier ?? "default") || ctx.requestedExecution.permissionMode !== "accept-edits") return rejected("Draft worker dispatch host/provider/model identity differs from the pinned execution.");
    if (ctx.attempt !== "start-turn" || ctx.queuedMessages.length !== 1 || ctx.queuedMessages[0].id !== r.activationQueueId || ctx.queuedMessages[0].payload.kind !== "inline" || ctx.origin !== "plugin" || ctx.originPluginId !== bb.pluginId || ctx.senderThreadId !== r.sourceThreadId || ctx.initiator !== "agent" || ctx.input.blocks.length !== 1 || ctx.input.blocks[0].type !== "text" || draftHash(ctx.input.text) !== r.activationHash || draftHash(textOf(ctx.queuedMessages[0].content)) !== r.activationHash) return rejected("Only the privately mapped original queue CAS may dispatch this source. No inline, extra row, follow-up or retry is allowed.");
    const binding = workstreams.store.section(r.sectionId);
    if (binding.revision !== r.bindingRevision || binding.binding?.workstreamId !== r.workstreamId) return rejected("Draft section binding changed before dispatch.");
    if (r.admittedRequestId === null) change(r.requestId, { status: "running", admittedRequestId: ctx.queuedMessages[0].id, retry: "none", progress: "Native worker is running with Cortex tools and memory withheld. Provider-native tools are not sandboxed." });
    return { action: "proceed" };
  }
  function restricted(threadId: string, metadata?: unknown, thread?: Partial<WorkerThread>): boolean {
    if (store.ownsWorker(threadId) || hasDraftMarker(metadata)) return true;
    if (!thread || thread.originPluginId !== bb.pluginId || thread.visibility !== "hidden") return false;
    return store.active().some(r => ["requesting", "unknown"].includes(r.worker.state) && r.personalProjectId === thread.projectId && r.sourceThreadId === thread.parentThreadId);
  }
  function configuration(ctx: PluginAgentConfigurationContext): PluginAgentConfiguration | null {
    if (!restricted(ctx.thread.id, ctx.pluginMetadata)) return null;
    const r = store.byWorker(ctx.thread.id);
    const admitted = r?.admittedRequestId !== null && r?.worker.state === "known" && r?.cancellation.state === "none" && Date.now() < Date.parse(r.deadlineAt);
    return { tools: [], skills: [], instructions: admitted ? DRAFT_WORKER_INSTRUCTIONS : "This Cortex drafting marker is restrictive only. No approved private normal-dispatch admission is present. Do not process source or use tools; stop/recover through the Cortex job UI." };
  }
  async function discover(id: string, signal?: AbortSignal) {
    const r = current(id);
    if (r.worker.threadId !== null) {
      const thread = await ownWorker(r, undefined, signal);
      if (r.bootstrapQueueId === null && !r.activationAttempted) {
        const rows = await bb.sdk.threads.queuedMessages.list({ threadId: thread.id, signal });
        if (rows.length > 1 || rows.some(q => q.threadId !== thread.id || q.originPluginId !== bb.pluginId || textOf(q.content) !== DRAFT_BOOTSTRAP)) throw new Error("Known setup queue is incomplete or changed; no input was deleted or activated.");
        const row = rows[0];
        if (row) change(id, { bootstrapQueueId: row.id, setupUpdatedAt: row.updatedAt, setupSendAt: r.setupSendAt ?? row.sendAt });
      }
      return thread;
    }
    if (r.worker.state === "not-requested") throw new Error("No native worker was requested.");
    const matches = new Set<string>();
    for (const archived of [false, true]) {
      let complete = false;
      for (let page = 0; page < 4; page++) {
        const rows = await bb.sdk.threads.list({ projectId: r.personalProjectId!, parentThreadId: r.sourceThreadId, originPluginId: bb.pluginId, includeHidden: true, archived, limit: 50, offset: page * 50, signal });
        for (const t of rows) {
          if (t.originPluginId !== bb.pluginId || t.projectId !== r.personalProjectId || t.parentThreadId !== r.sourceThreadId || t.visibility !== "hidden") continue;
          const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: t.id, signal });
          const marker = draftWorkerMarkerSchema.safeParse(metadata.cortexDraftWorker);
          if (marker.success && marker.data.requestId === r.requestId && marker.data.nonce === r.workerNonce) matches.add(t.id);
        }
        if (rows.length < 50) { complete = true; break; }
      }
      if (!complete) throw new Error("Draft worker lookup exceeded its bounded page budget. No inference was retried.");
    }
    if (matches.size !== 1) throw new Error("Draft worker lookup is incomplete/unresolved or has duplicate nonce matches. No worker was selected or respawned.");
    const thread = await ownWorker(r, [...matches][0], signal);
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId: thread.id, signal });
    if (rows.length > 1 || rows.some(q => q.threadId !== thread.id || q.originPluginId !== bb.pluginId || textOf(q.content) !== DRAFT_BOOTSTRAP)) throw new Error("Discovered setup contents cannot be mapped safely. No replacement inference was sent.");
    const row = rows[0];
    change(id, { worker: { state: "known", threadId: thread.id }, bootstrapQueueId: row?.id ?? null, setupUpdatedAt: row?.updatedAt ?? null, setupSendAt: r.setupSendAt ?? row?.sendAt ?? null, status: r.cancellation.state !== "none" ? "cancel-requested" : "needs-recovery", retry: "discover-stop", progress: "Original worker discovered. This recovery never activates/resends source; stop it before a fresh explicit inference." });
    return thread;
  }
  function verifyEntry(entry: Knowledge, proposal: ReturnType<typeof draftProposals>[number], duplicate: boolean) {
    if (entry.workstreamId !== proposal.workstreamId || JSON.stringify(entry.applicability) !== JSON.stringify(proposal.applicability) || entry.kind !== "finding" || entry.facet !== "orientation" || entry.expiresAt !== null) throw new Error("Draft canonical scope/kind/approval conflict.");
    if (duplicate) {
      const keys = new Set(entry.sources.map(sourceKey));
      if (normalize(entry.text) !== normalize(proposal.text) || normalize(entry.subject) !== normalize(proposal.subject) || !proposal.sources.every(s => keys.has(sourceKey(s)))) throw new Error("Draft no-save claim/source conflict.");
    } else if (entry.state !== "candidate" || entry.approval !== null || entry.id !== proposal.id || entry.revision !== 1 || entry.subject !== proposal.subject || entry.title !== proposal.title || entry.text !== proposal.text || JSON.stringify(entry.actor) !== JSON.stringify(proposal.actor) || JSON.stringify(entry.sources) !== JSON.stringify(proposal.sources)) throw new Error("Occupied draft candidate ID has different original payload/provenance/revision. It was not accepted or overwritten.");
  }
  async function save(id: string, signal?: AbortSignal) {
    let r = current(id);
    if (r.output === null) return view(r);
    const proposals = draftProposals(r, r.output);
    for (let i = 0; i < proposals.length; i++) {
      r = current(id); const slot = r.candidateResults[i]; if (slot.canonicalId !== null) continue;
      const proposal = proposals[i]; let entry: Knowledge | null = null; let duplicate = false;
      try {
        if (r.proposalAttemptedIds.includes(proposal.id)) {
          try { entry = await workstreams.cli.knowledge(proposal.id, signal); } catch (e) { if (!/404|not found/i.test(errorText(e))) throw e; }
          if (entry) verifyEntry(entry, proposal, false);
        }
        if (!entry) {
          r = current(id); checkLive(r); await verifySource(r, signal); checkLive(current(id));
          change(id, { status: "saving", proposalAttemptedIds: [...new Set([...r.proposalAttemptedIds, proposal.id])] });
          const result = await workstreams.cli.mutate(proposal, signal);
          if (!result.entry || !["created", "no-save"].includes(result.outcome)) throw new Error("Draft proposal returned no canonical saved entry.");
          entry = result.entry; duplicate = result.outcome === "no-save"; verifyEntry(entry, proposal, duplicate);
        }
        r = current(id); const results = [...r.candidateResults]; results[i] = { ...results[i], canonicalId: entry.id, status: duplicate ? "no-save" : "saved", error: null };
        change(id, { candidateResults: results }); workstreams.invalidateScope({ workstreamId: r.workstreamId });
      } catch (e) {
        r = current(id); const results = [...r.candidateResults]; results[i] = { ...results[i], status: "failed", error: errorText(e) };
        change(id, { candidateResults: results, status: r.cancellation.state === "none" ? "needs-recovery" : "stopped", active: r.worker.state !== "stopped", error: errorText(e), retry: "lookup-save" }); return view(current(id));
      }
    }
    r = current(id);
    return view(change(id, { status: r.cancellation.state !== "none" ? "stopped" : proposals.length === 0 ? "nothing-to-save" : "completed", active: false, output: null, error: null, retry: "none", progress: proposals.length === 0 ? "Nothing supported was found; no canonical write was made." : "Finding candidates were saved for explicit human review; no Rule was approved." }));
  }
  /** The thread's recent turn outcomes; a flat timeline has no turn rows, so completion comes from these events. */
  async function outcomesOf(threadId: string, signal?: AbortSignal) {
    return turnOutcomes(await bb.sdk.threads.events.list({ threadId, types: ["turn/completed"], order: "desc", limit: "100", signal }), threadId);
  }
  /** The worker's single completed turn: its id, its one request and its answer, from turn rows or a flat timeline. */
  async function workerTurn(threadId: string, rows: TimelineRows, signal?: AbortSignal) {
    const grouped = rows.filter((row): row is Extract<typeof row, { kind: "turn" }> => row.kind === "turn");
    if (grouped.length > 0) {
      if (grouped.length !== 1) throw new Error("Worker completed output is ambiguous or contains another turn.");
      const turn = grouped[0]; const children = turn.children ?? [];
      if (children.some(c => c.kind === "conversation" && (c.threadId !== threadId || c.turnId !== turn.turnId))) throw new Error("Worker message thread/turn provenance does not match its completed turn.");
      if (turn.threadId !== threadId || turn.status !== "completed" || turn.completedAt === null || children.length > DRAFT_LIMITS.rows) throw new Error("Worker output does not belong to the single completed activated source turn.");
      const messages = children.flatMap(c => c.kind === "conversation" ? [c] : []);
      return { turnId: turn.turnId, requests: messages.filter(c => c.role === "user"), answers: messages.filter(c => c.role === "assistant") };
    }
    const outcomes = [...(await outcomesOf(threadId, signal))];
    if (outcomes.length !== 1 || outcomes[0]![1].status !== "completed") throw new Error("Worker completed output is ambiguous or contains another turn.");
    const turnId = outcomes[0]![0];
    const messages = rows.flatMap(row => row.kind === "conversation" ? [row] : []);
    // The request arrives as the thread's first message, before bb assigns it a turn; every answer must be the turn's.
    if (messages.some(m => m.threadId !== threadId || (m.role === "assistant" ? m.turnId !== turnId : m.turnId !== null && m.turnId !== turnId))) throw new Error("Worker message thread/turn provenance does not match its completed turn.");
    return { turnId, requests: messages.filter(m => m.role === "user"), answers: messages.filter(m => m.role === "assistant") };
  }
  async function collectUnlocked(threadId: string, signal?: AbortSignal): Promise<void> {
    let r = store.byWorker(threadId); if (!r || r.output !== null || ["completed", "nothing-to-save", "failed", "stopped"].includes(r.status)) return;
    if (r.cancellation.state !== "none") { await stopOwned(r.requestId, signal); return; }
    try {
      checkLive(r); const thread = await ownWorker(r, undefined, signal);
      if (thread.status !== "idle" || thread.runtime.displayStatus !== "idle") return;
      if (!r.admittedRequestId || !r.activationHash || !r.activationAttempted) throw new Error("No privately admitted source turn was observed; setup output cannot become findings.");
      const page = await bb.sdk.threads.timeline({ threadId, segmentLimit: "2", summaryOnly: "false", deferContent: "false", includeNestedRows: "true", signal });
      if (page.rows.length > DRAFT_LIMITS.rows) throw new Error("Worker output exceeds bounded turn rows.");
      const turn = await workerTurn(threadId, page.rows, signal);
      if (turn.requests.length !== 1 || draftHash(turn.requests[0]!.text) !== r.activationHash) throw new Error("Worker output does not belong to the single completed activated source turn.");
      const answer = turn.answers.map(c => c.text).join("\n");
      const output = validateDraftOutput(answer, r.source); await verifySource(r, signal); checkLive(current(r.requestId));
      r = change(r.requestId, { status: "validating", output, findingCount: output.findings.length, terminalTurnId: turn.turnId, progress: "Source and strict JSON are verified. Confirming worker inactivity before saving candidates." });
      await stopOwned(r.requestId, signal); await save(r.requestId, signal);
    } catch (e) {
      r = current(r.requestId); change(r.requestId, { status: r.cancellation.state !== "none" ? "cancel-requested" : "failed", error: errorText(e), retry: r.output === null ? "discover-stop" : "lookup-save" });
      try { await stopOwned(r.requestId, signal); const after = current(r.requestId); if (after.cancellation.state === "none") change(r.requestId, { active: false }); } catch (stopError) { change(r.requestId, { error: `${errorText(e)}; cleanup unconfirmed: ${errorText(stopError)}`.slice(0, 8000), status: current(r.requestId).cancellation.state !== "none" ? "cancel-requested" : "needs-recovery", retry: "discover-stop" }); }
    }
  }
  async function collect(threadId: string, signal?: AbortSignal) { const r = store.byWorker(threadId); if (r) await exclusive(r.requestId, () => collectUnlocked(threadId, signal)); }
  async function reconcile(id: string, signal?: AbortSignal): Promise<DraftJob> {
    return exclusive(id, async () => {
      try {
        let r = current(id); if (r.worker.state === "not-requested" || r.worker.state === "stopped") return view(r);
        const thread = await discover(id, signal); r = current(id);
        if (r.cancellation.state !== "none") await stopOwned(id, signal);
        else if (Date.now() >= Date.parse(r.deadlineAt)) { change(id, { cancellation: { state: "requested", requestedAt: new Date().toISOString(), confirmedAt: null }, status: "cancel-requested", progress: "Draft deadline reached; stopping the owned worker." }); await stopOwned(id, signal); }
        else if (r.activationAttempted && r.admittedRequestId && thread.status === "idle") await collectUnlocked(thread.id, signal);
        else if (r.activationAttempted && thread.status === "active") change(id, { status: "running", retry: "none" });
      } catch (e) { const r = current(id); change(id, { status: r.cancellation.state !== "none" ? "cancel-requested" : "needs-recovery", error: errorText(e), retry: "discover-stop" }); }
      return view(current(id));
    });
  }
  async function failed(threadId: string, signal?: AbortSignal) {
    const job = store.byWorker(threadId);
    if (!job || ["completed", "nothing-to-save", "stopped"].includes(job.status)) return;
    await exclusive(job.requestId, async () => {
      change(job.requestId, { status: "failed", error: "Native drafting worker failed. Recover existing writes or stop it; no new inference is retried.", retry: "discover-stop" });
      try { await stopOwned(job.requestId, signal); change(job.requestId, { active: false }); }
      catch (e) { change(job.requestId, { status: "needs-recovery", error: errorText(e), retry: "discover-stop" }); }
    });
  }
  async function cancel(input: z.infer<typeof draftRpcMethods.draftCancel.input>, signal?: AbortSignal) {
    workstreams.human(); const cancelled = store.cancel(input.sectionId, input.requestId, input.expectedRevision);
    bb.realtime.publish("drafts", { sectionId: input.sectionId, requestId: input.requestId, revision: cancelled.revision });
    if (cancelled.worker.state === "not-requested" || cancelled.worker.state === "stopped") return view(cancelled);
    return reconcile(input.requestId, signal);
  }
  async function resumeSave(input: z.infer<typeof draftRpcMethods.draftResumeSave.input>, signal?: AbortSignal) {
    workstreams.human(); return exclusive(input.requestId, async () => {
      const r = current(input.requestId);
      if (r.sectionId !== input.sectionId || r.revision !== input.expectedRevision) throw new Error("Draft job scope/revision conflict. Read the existing job; no new inference was requested.");
      if (r.output === null) return view(r);
      if (r.worker.state !== "stopped") { try { await stopOwned(r.requestId, signal); } catch (e) { return view(change(r.requestId, { status: "needs-recovery", error: errorText(e), retry: "discover-stop" })); } }
      return save(r.requestId, signal);
    });
  }
  return { store, resolver, view, human: workstreams.human, sourcePreview, start, guard, restricted, configuration, reconcile, collect, failed, cancel, resumeSave,
    configGet: store.configGet,
    configSet(input: z.infer<typeof draftRpcMethods.draftConfigSet.input>) { const next = store.configSet(input.expectedRevision, input.selection, workstreams.human()); bb.realtime.publish("drafts", { configRevision: next.revision }); return next; },
    capabilities: () => ({ available: true, reason: null, maxActivePerSection: 1 as const, maxActiveGlobal: 3 as const, maxFindings: 3 as const, maxMessages: 12 as const, maxSourceChars: 16384 as const, maxQuoteChars: 8192 as const, maxOutputBytes: 32768 as const }),
    job(input: z.infer<typeof draftRpcMethods.draftJob.input>) { const r = store.get(input.requestId); if (!r || r.sectionId !== input.sectionId) throw new Error("Draft job not found in selected section."); return view(r); },
    jobs(input: z.infer<typeof draftRpcMethods.draftJobs.input>) { const page = store.list(input.sectionId, input.limit, input.offset); return { ...page, jobs: page.jobs.map(view) }; },
  };
}
export type DraftService = ReturnType<typeof createDraftService>;
