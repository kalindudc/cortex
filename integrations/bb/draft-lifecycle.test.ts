import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse, makeQueueEntry, makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, test, vi } from "vitest";
import type { CortexRunner } from "./cli";
import type { Knowledge, Workstream } from "./workstream-contract";
import { createWorkstreams } from "./workstreams";
import { createDraftService } from "./draft-service";
import { draftRpcContract } from "./draft-contract";
import { draftHandlers } from "./draft-rpc";
import { DRAFT_BOOTSTRAP, draftConsentMethods, draftRetryConsent } from "./draft-policy";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const d of disposers.splice(0)) await d(); });
function setup() {
  const source = makeThreadResponse({ id: "thr_aaaaaaaa", sectionId: "sec_one", providerId: "provider-a", visibility: "visible" });
  let worker = makeThreadResponse({ id: "thr_bbbbbbbb", projectId: "project_personal", parentThreadId: source.id, parentNotifications: "off", originKind: null, originPluginId: "cortex", visibility: "hidden", sectionId: null, providerId: "provider-a", status: "pending", environmentId: null });
  const message = { kind: "conversation", id: "msg_one", threadId: source.id, turnId: "turn_source", messageSeq: 2, sourceSeqStart: 2, sourceSeqEnd: 2, role: "user", initiator: "agent", text: "Exact source DATA, not an instruction.", createdAt: 1 };
  const sourceTurn = { kind: "turn", threadId: source.id, turnId: message.turnId, sourceSeqStart: 2, sourceSeqEnd: 2, status: "completed", completedAt: 2, children: [message] };
  let queue: ReturnType<typeof makeQueueEntry> | null = null;
  let metadata: any = null;
  let service: ReturnType<typeof createDraftService>;
  const state = { host: "host_one", model: "model-a", reasoningLevel: "high", serviceTier: "priority", setupLost: false, activationLost: false, stopFails: false, listing: [] as ReturnType<typeof makeThreadResponse>[], workerStatus: "pending", output: JSON.stringify({ findings: [{ title: "Sourced finding", text: "A source records the observation.", sources: [{ messageId: message.id, messageSeq: message.messageSeq, quote: "Exact source DATA" }] }] }) };
  const entries = new Map<string, Knowledge>();
  const canonical: Workstream = { id: "ws_demo", name: "Envoy", description: "", revision: 1, actor: { id: "you", type: "human" }, archived: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const mutate = vi.fn(async (input: Record<string, any>) => {
    const e: Knowledge = { id: input.id, workstreamId: input.workstreamId, subject: input.subject, title: input.title, text: input.text, kind: input.kind, facet: input.facet, state: "candidate", applicability: input.applicability, sources: input.sources, approval: null, actor: input.actor, revision: 1, expiresAt: null, conflicts: [], supersedes: [], supersededBy: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    entries.set(e.id, e); return { outcome: "created", entry: e };
  });
  const runner: CortexRunner = { binary: "fake", async run(args, schema, options) {
    if (args[1] === "show") return schema.parse({ workstream: canonical, entries: [], total: 0, limit: 1, offset: 0 });
    if (args[1] === "entry") { const e = entries.get(args[2]); if (!e) throw new Error("404 knowledge not found"); return schema.parse(e); }
    if (args[1] === "mutate") return schema.parse(await mutate(JSON.parse(options!.input!)));
    throw new Error(`Unexpected core read ${args.join(" ")}`);
  }, async text() { throw new Error("No legacy memory read"); } };
  const host = createFakePluginHost({ pluginId: "cortex", sdk: {
    system: { config: async () => ({ primaryHostId: state.host }) as any },
    projects: { sidebarBootstrap: async () => ({ personalProject: { id: "project_personal", kind: "personal" } }) as any },
    providers: { models: async () => ({ providers: [{ id: "provider-a", available: true, capabilities: { modelCatalogScope: "host", permissionModes: ["accept-edits"], supportsServiceTier: true } }], models: [{ model: state.model, routeProviderId: "provider-a", supportedReasoningEfforts: [{ reasoningEffort: state.reasoningLevel }], supportedServiceTiers: [{ id: state.serviceTier }] }] }) as any },
    threadSections: { list: async () => [{ id: "sec_one", name: "Envoy", createdAt: 0, updatedAt: 0 }] },
    threads: {
      get: async ({ threadId }) => threadId === source.id ? source : ({ ...worker, status: state.workerStatus }) as any,
      getPluginMetadata: async () => metadata,
      defaultExecutionOptions: async () => ({ model: state.model, reasoningLevel: state.reasoningLevel, serviceTier: state.serviceTier, permissionMode: "full", source: "client/thread/start" }) as any,
      timeline: async ({ threadId }) => ({ rows: threadId === source.id ? [sourceTurn] : [{ kind: "turn", threadId: worker.id, turnId: "turn_worker", status: "completed", completedAt: 3, sourceSeqStart: 1, sourceSeqEnd: 3, children: [{ kind: "conversation", role: "user", text: lastActivation(), threadId: worker.id, turnId: "turn_worker" }, { kind: "conversation", role: "assistant", text: state.output, threadId: worker.id, turnId: "turn_worker" }] }], timelinePage: { historySnapshot: "history_one" } }) as any,
      message: async () => ({ message, before: [], after: [] }) as any,
      list: async () => state.listing,
      spawn: async input => {
        expect(input.input).toEqual([{ type: "text", text: DRAFT_BOOTSTRAP, mentions: [] }]);
        expect(JSON.stringify(input)).not.toContain(message.text);
        const r = service.store.active()[0]; expect(r.worker.state).toBe("requesting"); expect(r.personalProjectId).toBe("project_personal");
        metadata = input.pluginMetadata;
        queue = makeQueueEntry({ id: "queued_one", threadId: worker.id, content: input.input as any, sendAt: input.sendAt!, state: "scheduled", origin: "plugin", originPluginId: "cortex", initiator: "agent", senderThreadId: source.id, model: "model-a", reasoningLevel: "high", serviceTier: "priority", permissionMode: "accept-edits", updatedAt: Date.now() });
        state.listing = [worker];
        if (state.setupLost) throw new Error("spawn response lost");
        return worker;
      },
      queuedMessages: {
        list: async () => queue ? [queue] : [],
        update: async input => {
          const r = service.store.active()[0]; expect(r.worker.threadId).toBe(worker.id); expect(r.activationHash).not.toBeNull(); expect(r.activationAttempted).toBe(true);
          if (!queue || input.queuedMessageId !== queue.id || input.expectedUpdatedAt !== queue.updatedAt) throw new Error("409 queue revision conflict");
          queue = { ...queue, content: input.input as any, sendAt: input.sendAt!, updatedAt: queue.updatedAt + 1, state: "queued" };
          expect(service.guard(dispatch())).toEqual({ action: "proceed" });
          state.workerStatus = "active";
          if (state.activationLost) throw new Error("activation response lost");
          return queue;
        },
        delete: async () => { queue = null; return { ok: true }; },
      },
      stop: async () => { if (state.stopFails) throw new Error("stop response lost"); state.workerStatus = "idle"; queue = null; return { ok: true }; },
      archive: async () => { expect(state.workerStatus).toBe("idle"); expect(queue).toBeNull(); worker = { ...worker, archivedAt: Date.now() }; return { ok: true }; },
    },
  } });
  disposers.push(() => host.harness.lifecycle.dispose());
  const ws = createWorkstreams(host.bb, runner, { userAuthor: "you", widgetDefault: () => true });
  ws.store.setSection("sec_one", 0, { workstreamId: canonical.id, topic: null, budgetTokens: 1000, requiredKnowledgeIds: [] }, { id: "you", type: "human" });
  service = createDraftService(host.bb, ws);
  host.bb.rpc.register(draftRpcContract, draftHandlers(service));
  function lastActivation() { const calls = host.harness.inspection.sdk.callsTo("threads.queuedMessages.update"); return ((calls.at(-1)?.[0] as any)?.input ?? []).map((p: any) => p.text).join(""); }
  function dispatch() { return makeMessageDispatchHookContext({ thread: worker, project: { id: "project_personal", kind: "personal" } as any, host: makeHostResponse({ id: "host_one" }), queuedMessages: queue ? [queue] : [], input: { blocks: queue?.content ?? [], text: queue?.content.map((p: any) => p.text ?? "").join("") ?? "" }, requestedExecution: { providerId: "provider-a", model: "model-a", reasoningLevel: "high", serviceTier: "priority", permissionMode: "accept-edits" }, origin: "plugin", originPluginId: "cortex", senderThreadId: source.id, initiator: "agent" }); }
  async function intent() { const preview = await service.sourcePreview({ sectionId: "sec_one", expectedBindingRevision: 1, sourceThreadId: source.id }); return { requestId: randomUUID(), sectionId: "sec_one", expectedBindingRevision: 1, sourceThreadId: source.id, sourceSnapshotId: preview.snapshotId, expectedConfigRevision: preview.execution.configRevision }; }
  return { ...host, service, ws, entries, mutate, state, source, message, canonical, intent, dispatch, worker: () => worker, metadata: () => metadata, queue: () => queue, setQueue: (next: typeof queue) => { queue = next; }, lastActivation };
}

test.each(["bootstrap", "activation"] as const)("cancellation preserves observed edits to the owned %s row", async phase => {
  const s = setup(); const input = await s.intent();
  if (phase === "bootstrap") s.state.setupLost = true;
  await s.service.start(input); if (phase === "bootstrap") await s.service.reconcile(input.requestId);
  const original = s.queue()!;
  const edited = { ...original, updatedAt: original.updatedAt + 1, content: [{ type: "text" as const, text: "Human-edited queued content: keep this note", mentions: [] }] };
  s.setQueue(edited);
  const r = s.service.store.get(input.requestId)!;
  const result = await s.service.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: r.revision });
  expect(result.cancellation.state).toBe("requested"); expect(result.status).toBe("cancel-requested");
  expect(result.error).toMatch(/queue.*(changed|version|unverified).*preserved/i);
  expect(s.queue()).toEqual(edited); expect(s.service.store.active()).toHaveLength(1);
  for (const call of ["threads.queuedMessages.delete", "threads.stop", "threads.archive"] as const) expect(s.harness.inspection.sdk.callsTo(call)).toHaveLength(0);
  await s.service.reconcile(input.requestId);
  expect(s.queue()).toEqual(edited); expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(phase === "bootstrap" ? 0 : 1);
});
test.each(["bootstrap", "activation"] as const)("cancellation verifies the %s row execution, schedule, provenance and unchanged version", async phase => {
  for (const patch of [{ updatedAt: 1 }, { model: "changed" }, { reasoningLevel: "low" }, { serviceTier: "default" }, { permissionMode: "full" as const }, { sendAt: 1 }, { origin: "app" as const }, { originPluginId: "other" }, { senderThreadId: "thr_cccccccc" }, { initiator: "user" as const }, { groupWithNext: true }]) {
    const s = setup(); const input = await s.intent(); if (phase === "bootstrap") s.state.setupLost = true;
    await s.service.start(input); if (phase === "bootstrap") await s.service.reconcile(input.requestId);
    const edited = { ...s.queue()!, ...patch }; s.setQueue(edited);
    const r = s.service.store.get(input.requestId)!;
    const result = await s.service.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: r.revision });
    expect(result.cancellation.state, JSON.stringify(patch)).toBe("requested"); expect(s.queue()).toEqual(edited);
    for (const call of ["threads.queuedMessages.delete", "threads.stop", "threads.archive"] as const) expect(s.harness.inspection.sdk.callsTo(call)).toHaveLength(0);
  }
});
test("restart preserves an observed edited bootstrap instead of rebasing its original version", async () => {
  const s = setup(); const input = await s.intent(); s.state.setupLost = true; await s.service.start(input); await s.service.reconcile(input.requestId);
  const q = s.queue()!; const edited = { ...q, updatedAt: q.updatedAt + 1 }; s.setQueue(edited);
  let restored: ReturnType<typeof createDraftService> | undefined;
  const fresh = await s.harness.lifecycle.reload(async bb => { const ws = createWorkstreams(bb, { binary: "fake", run: async () => { throw new Error("No core read expected"); }, text: async () => { throw new Error("No legacy memory"); } }, { userAuthor: "you", widgetDefault: () => true }); restored = createDraftService(bb, ws); });
  const r = restored!.store.get(input.requestId)!; const result = await restored!.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: r.revision });
  expect(result.cancellation.state).toBe("requested"); expect(s.queue()).toEqual(edited); expect(restored!.store.get(input.requestId)!.setupUpdatedAt).toBe(q.updatedAt);
  for (const call of ["threads.queuedMessages.delete", "threads.stop", "threads.archive", "threads.spawn", "threads.queuedMessages.update"] as const) expect(fresh.harness.inspection.sdk.callsTo(call)).toHaveLength(0);
});
test.each(["bootstrap", "activation"] as const)("public %s text-block property order is not a queue edit", async phase => {
  const s = setup(); const input = await s.intent(); if (phase === "bootstrap") s.state.setupLost = true;
  await s.service.start(input); if (phase === "bootstrap") await s.service.reconcile(input.requestId);
  const q = s.queue()!; const part = q.content[0]; if (part.type !== "text") throw new Error("Expected owned text");
  s.setQueue({ ...q, content: [{ mentions: part.mentions, text: part.text, type: "text" }] });
  const r = s.service.store.get(input.requestId)!;
  const result = await s.service.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: r.revision });
  expect(result.cancellation.state, result.error ?? undefined).toBe("confirmed");
});
test("normal setup failure preserves a subsequent human edit on cancellation", async () => {
  const s = setup(); const input = await s.intent(); const catalog = await s.bb.sdk.providers.models({ hostId: "host_one", providerId: "provider-a", projectId: "project_personal" }); let calls = 0;
  s.harness.sdk.stub("providers.models", async () => { if (++calls > 1) throw new Error("catalog unavailable after setup"); return catalog; });
  const first = await s.service.start(input); expect(first.status).toBe("needs-recovery");
  expect(s.service.store.get(input.requestId)!.bootstrapQueueId).toBe("queued_one");
  const q = s.queue()!; const edited = { ...q, updatedAt: q.updatedAt + 1 }; s.setQueue(edited);
  const result = await s.service.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: first.revision });
  expect(result.cancellation.state).toBe("requested"); expect(s.queue()).toEqual(edited); expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(0);
});
test("lost activation response cannot adopt an observed activation revision for deletion", async () => {
  const s = setup(); const input = await s.intent(); s.state.activationLost = true; const first = await s.service.start(input); const q = s.queue()!;
  const result = await s.service.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: first.revision });
  expect(result.cancellation.state).toBe("requested"); expect(result.error).toMatch(/version|unverified/i); expect(s.queue()).toEqual(q);
  expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(0);
  expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(1);
  s.setQueue(null); const stopped = await s.service.reconcile(input.requestId); expect(stopped.cancellation.state).toBe("confirmed");
});
test("known unchanged activation version is pinned privately and remains safe to cancel after reload", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input);
  expect(s.service.store.get(input.requestId)!).toMatchObject({ activationUpdatedAt: s.queue()!.updatedAt });
  let restored: ReturnType<typeof createDraftService> | undefined;
  const fresh = await s.harness.lifecycle.reload(async bb => { const ws = createWorkstreams(bb, { binary: "fake", run: async () => { throw new Error("No core read expected"); }, text: async () => { throw new Error("No legacy memory"); } }, { userAuthor: "you", widgetDefault: () => true }); restored = createDraftService(bb, ws); });
  const r = restored!.store.get(input.requestId)!; const result = await restored!.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: r.revision });
  expect(result.cancellation.state, result.error ?? undefined).toBe("confirmed"); expect(fresh.harness.inspection.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(1);
});
test("legacy jobs without a confirmed activation version preserve their queued row", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input);
  const db = s.bb.storage.database(); db.prepare("UPDATE cortex_draft_jobs SET payload=json_remove(payload,'$.activationUpdatedAt') WHERE request_id=?").run(input.requestId);
  const r = s.service.store.get(input.requestId)!; const q = s.queue()!;
  const result = await s.service.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: r.revision });
  expect(result.cancellation.state).toBe("requested"); expect(s.queue()).toEqual(q); expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(0);
});
test("draft RPC config is human-policy CAS; native tools never register privileged draft methods; signals only drafts", async () => {
  const s = setup();
  expect(await s.harness.behavior.callRpc("draftConfigGet", null)).toMatchObject({ revision: 0, selection: null });
  await expect(s.harness.behavior.callRpc("draftConfigSet", { expectedRevision: 0, selection: null }, { experimental_caller: { kind: "plugin", pluginId: "other" } })).rejects.toThrow(/UI|explicit|provenance/i);
  await s.harness.behavior.callRpc("draftConfigSet", { expectedRevision: 0, selection: null });
  expect(s.harness.realtimeSignals).toEqual([{ channel: "drafts", payload: { configRevision: 1 } }]);
  await expect(s.harness.behavior.callRpc("draftConfigSet", { expectedRevision: 0, selection: null })).rejects.toThrow(/revision/i);
  expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

test("cancellation confirmed during read-only preflight is never overwritten by the stale start", async () => {
  const s = setup(); const input = await s.intent();
  const catalog = await s.bb.sdk.providers.models({ hostId: "host_one", providerId: "provider-a", projectId: "project_personal" });
  let release = () => {}; let entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  s.harness.sdk.stub("providers.models", async () => { entered = true; await gate; return catalog; });
  const starting = s.service.start(input);
  await vi.waitFor(() => expect(entered).toBe(true));
  const r = s.service.store.get(input.requestId)!;
  const cancelled = await s.service.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: r.revision });
  expect(cancelled.cancellation.state).toBe("confirmed"); release();
  const result = await starting;
  expect(result.status).toBe("stopped"); expect(result.cancellation.state).toBe("confirmed");
  expect(s.service.store.active()).toHaveLength(0); expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});
test("foreign nested worker messages are never converted into canonical findings", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  s.harness.sdk.stub("threads.timeline", async () => ({ rows: [{ kind: "turn", threadId: s.worker().id, turnId: "turn_worker", status: "completed", completedAt: 3, sourceSeqStart: 1, sourceSeqEnd: 3, children: [{ kind: "conversation", role: "user", text: s.lastActivation(), threadId: "thr_cccccccc", turnId: "turn_worker" }, { kind: "conversation", role: "assistant", text: s.state.output, threadId: "thr_cccccccc", turnId: "turn_worker" }] }], timelinePage: { historySnapshot: "history_one" } }) as any);
  await s.service.collect(s.worker().id);
  expect(s.mutate).not.toHaveBeenCalled(); expect(s.service.store.get(input.requestId)!.error).toMatch(/worker|thread|turn/i);
});
test.each(["personalProjectId", "bootstrapQueueId", "activationQueueId", "activationHash", "setupUpdatedAt", "setupSendAt", "activationUpdatedAt", "admittedRequestId"] as const)("persisted execution/activation identity is immutable after pinning: %s", async field => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); const r = s.service.store.get(input.requestId)!;
  const value = field === "setupUpdatedAt" || field === "setupSendAt" || field === "activationUpdatedAt" ? r[field]! + 1 : field === "activationHash" ? "a".repeat(64) : "changed";
  expect(() => s.service.store.update({ ...r, [field]: value }, r.revision)).toThrow(/immutable|pinned|identity/i);
});

test("completed output stays pinned when future-job config changes", async () => {
  const s = setup(); const input = await s.intent(); const started = await s.service.start(input);
  s.service.configSet({ expectedRevision: 0, selection: { providerId: "provider-b", model: "other-model", reasoningLevel: "low" } });
  expect(s.service.store.get(input.requestId)!.execution).toEqual(started.execution);
  s.state.workerStatus = "idle"; s.setQueue(null); await s.service.collect(s.worker().id);
  expect(s.service.store.get(input.requestId)!.status).toBe("completed");
  expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});
test("unknown setup discovery is bounded, empty or duplicate matches remain uncertain without respawn", async () => {
  const s = setup(); const input = await s.intent(); s.state.setupLost = true; await s.service.start(input);
  s.state.listing = []; await s.service.reconcile(input.requestId);
  expect(s.service.store.get(input.requestId)!.worker.threadId).toBeNull();
  s.state.listing = [s.worker(), makeThreadResponse({ ...s.worker(), id: "thr_cccccccc" })];
  await s.service.reconcile(input.requestId); expect(s.service.store.get(input.requestId)!.worker.threadId).toBeNull();
  s.state.listing = Array.from({ length: 50 }, (_, i) => makeThreadResponse({ ...s.worker(), id: `thr_page${String(i).padStart(6, "0")}` }));
  const before = s.harness.inspection.sdk.callsTo("threads.list").length;
  await s.service.reconcile(input.requestId);
  expect(s.harness.inspection.sdk.callsTo("threads.list").length - before).toBe(4);
  expect(s.service.store.get(input.requestId)!.error).toMatch(/bounded page/i);
  expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(0);
});
test("restart keeps request, worker nonce, execution and stable IDs; recovery cannot spawn or activate again", async () => {
  const s = setup(); const input = await s.intent(); s.state.setupLost = true; await s.service.start(input);
  const original = s.service.store.get(input.requestId)!;
  let reloadedService: ReturnType<typeof createDraftService> | null = null;
  const fresh = await s.harness.lifecycle.reload(async bb => {
    const ws = createWorkstreams(bb, { binary: "fake", run: async () => { throw new Error("No core read expected in discovery"); }, text: async () => { throw new Error("No legacy memory"); } }, { userAuthor: "you", widgetDefault: () => true });
    reloadedService = createDraftService(bb, ws);
  });
  const restored = reloadedService!;
  await restored.reconcile(input.requestId);
  expect(restored.store.get(input.requestId)!).toMatchObject({ workerNonce: original.workerNonce, execution: original.execution, candidateResults: original.candidateResults });
  expect(fresh.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect(fresh.harness.inspection.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(0);
});
test("expired/consumed inert setup never receives a replacement source and remains safe to cancel", async () => {
  const s = setup(); const input = await s.intent(); s.state.setupLost = true; await s.service.start(input);
  const q = s.queue()!; vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(q.sendAt! + 1);
    const r = await s.service.reconcile(input.requestId);
    expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(0);
    expect(r.cancellation.state, r.error ?? undefined).toBe("confirmed");
    expect(s.queue()).toBeNull();
  } finally { vi.useRealTimers(); }
});
test("empty strict findings completes nothing-to-save with no canonical write", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null); s.state.output = '{"findings":[]}';
  await s.service.collect(s.worker().id); const r = s.service.store.get(input.requestId)!;
  expect(r.status).toBe("nothing-to-save"); expect(s.mutate).not.toHaveBeenCalled(); expect(s.service.job({ sectionId: "sec_one", requestId: input.requestId }).candidateResults).toEqual([]);
});
test("occupied intended candidate with a newer/foreign payload is refused during lookup recovery", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  const base = s.mutate.getMockImplementation()!; s.mutate.mockImplementationOnce(async p => { await base(p); const e = s.entries.get(p.id)!; s.entries.set(p.id, { ...e, text: "changed content", revision: 2 }); throw new Error("response lost"); });
  await s.service.collect(s.worker().id); const r = s.service.store.get(input.requestId)!;
  const result = await s.service.resumeSave({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: r.revision });
  expect(result.status).toBe("needs-recovery"); expect(result.error).toMatch(/Occupied|payload|provenance/i); expect(s.mutate).toHaveBeenCalledTimes(1);
});

test("failed setup-row read retains verified worker identity and can map only for explicit cancellation", async () => {
  const s = setup(); const input = await s.intent(); let failed = false;
  s.harness.sdk.stub("threads.queuedMessages.list", async () => { if (!failed) { failed = true; throw new Error("queue response lost"); } return s.queue() ? [s.queue()!] : []; });
  const first = await s.service.start(input); expect(first.worker.threadId).toBe(s.worker().id);
  expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(0);
  const stopped = await s.service.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: first.revision });
  expect(stopped.cancellation.state, stopped.error ?? undefined).toBe("confirmed");
  expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

test("cancel during partial canonical save confirms the already stopped worker and preserves the committed suggestion", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  const one = JSON.parse(s.state.output).findings[0]; s.state.output = JSON.stringify({ findings: [one, { ...one, title: "Second claim", text: "Another finding." }] });
  const base = s.mutate.getMockImplementation()!; let release = () => {}; let entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  s.mutate.mockImplementationOnce(async p => { const result = await base(p); entered = true; await gate; return result; });
  const collecting = s.service.collect(s.worker().id);
  await vi.waitFor(() => expect(entered).toBe(true));
  const saving = s.service.store.get(input.requestId)!;
  const cancelling = s.service.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: saving.revision });
  try {
    await vi.waitFor(() => expect(s.service.store.get(input.requestId)!.cancellation.state).not.toBe("none"));
    expect(s.service.store.get(input.requestId)!.cancellation.state).toBe("confirmed");
  } finally { release(); }
  await cancelling; await collecting;
  const r = s.service.store.get(input.requestId)!;
  expect(r.status).toBe("stopped"); expect(r.candidateResults[0].canonicalId).not.toBeNull(); expect(r.candidateResults[1].canonicalId).toBeNull(); expect(s.mutate).toHaveBeenCalledTimes(1);
});
test("native job deadline rejects dispatch and scheduled reconciliation confirms owned stop without inference", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); const deadline = Date.parse(s.service.store.get(input.requestId)!.deadlineAt);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(deadline + 1);
    expect(s.service.guard(s.dispatch())?.action).toBe("reject");
    const stopped = await s.service.reconcile(input.requestId); expect(stopped.cancellation.state).toBe("confirmed"); expect(stopped.status).toBe("stopped");
    expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
test.each(["rejected", "recheck", "archived", "approved"] as const)("canonical no-save records a matching historical %s finding without changing it", async state => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  const base = s.mutate.getMockImplementation()!;
  s.mutate.mockImplementationOnce(async p => { const result = await base({ ...p, id: "kn_existing" }); result.entry.state = state; result.entry.revision = 2; if (state === "approved") result.entry.approval = { actor: { id: "you", type: "human" }, at: result.entry.updatedAt }; return { ...result, outcome: "no-save" }; });
  await s.service.collect(s.worker().id); const r = s.service.store.get(input.requestId)!;
  expect(r.status, r.error ?? undefined).toBe("completed"); expect(r.candidateResults[0]).toMatchObject({ canonicalId: "kn_existing", status: "no-save" });
  expect(s.entries.get("kn_existing")).toMatchObject({ state, revision: 2 }); expect(s.entries.size).toBe(1);
  const again = await s.service.resumeSave({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: r.revision });
  expect(again.status).toBe("completed"); expect(s.mutate).toHaveBeenCalledTimes(1);
});
test.each(["workstream", "applicability", "source", "subject", "text", "kind", "facet", "expiry"] as const)("historical no-save refuses mismatched canonical %s", async field => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  const base = s.mutate.getMockImplementation()!;
  s.mutate.mockImplementationOnce(async p => {
    const result = await base({ ...p, id: "kn_existing" }); const e = result.entry; e.state = "rejected"; e.revision = 2;
    if (field === "workstream") e.workstreamId = "ws_other";
    if (field === "applicability") e.applicability = { environment: { mode: "not-applicable" }, host: { mode: "unknown" } };
    if (field === "source") e.sources = [{ ...e.sources[0], excerpt: "Foreign evidence" }];
    if (field === "subject") e.subject = "other subject";
    if (field === "text") e.text = "other fact";
    if (field === "kind") e.kind = "directive";
    if (field === "facet") e.facet = "pitfall";
    if (field === "expiry") e.expiresAt = "2026-01-01T00:00:00.000Z";
    return { ...result, outcome: "no-save" };
  });
  await s.service.collect(s.worker().id); const r = s.service.store.get(input.requestId)!;
  expect(r.status).toBe("needs-recovery"); expect(r.candidateResults[0].canonicalId).toBeNull(); expect(s.mutate).toHaveBeenCalledTimes(1);
});
test.each(["state", "approval", "actor", "normalized-text"] as const)("occupied intended-ID recovery still refuses non-original %s", async field => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  const base = s.mutate.getMockImplementation()!;
  s.mutate.mockImplementationOnce(async p => { await base(p); const e = s.entries.get(p.id)!;
    if (field === "state") e.state = "rejected";
    if (field === "approval") e.approval = { actor: { id: "you", type: "human" }, at: e.updatedAt };
    if (field === "actor") e.actor = { id: "other", type: "agent" };
    if (field === "normalized-text") e.text = e.text.toUpperCase();
    throw new Error("canonical response lost");
  });
  await s.service.collect(s.worker().id); const r = s.service.store.get(input.requestId)!;
  const result = await s.service.resumeSave({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: r.revision });
  expect(result.status).toBe("needs-recovery"); expect(result.candidateResults[0].canonicalId).toBeNull(); expect(result.error).toMatch(/Occupied/); expect(s.mutate).toHaveBeenCalledTimes(1);
});
test("canonical no-save persists its returned ID and core normalization without weakening occupied-ID checks", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  const base = s.mutate.getMockImplementation()!;
  s.mutate.mockImplementationOnce(async p => { const result = await base({ ...p, id: "kn_existing" }); result.entry.text = 'Ａ SOURCE RECORDS THE OBSERVATION.'; return { ...result, outcome: "no-save" }; });
  await s.service.collect(s.worker().id); const r = s.service.store.get(input.requestId)!;
  expect(r.status, r.error ?? undefined).toBe("completed"); expect(r.candidateResults[0]).toMatchObject({ canonicalId: "kn_existing", status: "no-save" }); expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

test("preview persists execution/personal route with bounded verified source and never leaks canonical context", async () => {
  const s = setup(); const input = await s.intent(); const saved = s.service.store.snapshotGet(input.sourceSnapshotId)!;
  expect(saved.execution).toMatchObject({ hostId: "host_one", model: "model-a", origin: "source-thread", configRevision: 0 });
  expect(saved.personalProjectId).toBe("project_personal"); expect(saved.messages[0].authorType).toBe("agent");
  expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});
test("start writes intent and known mapping before one CAS activation on the original benign queue", async () => {
  const s = setup(); const input = await s.intent(); const result = await s.service.start(input);
  expect(result.status).toBe("running"); expect(result.worker.threadId).toBe(s.worker().id);
  expect(s.service.store.get(input.requestId)!.candidateResults[0].intendedId).toMatch(/^kn_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  expect(s.lastActivation()).toContain(s.message.text);
  const spawn = s.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0] as any;
  expect(spawn).toMatchObject({ projectId: "project_personal", parentThreadId: s.source.id, parentNotifications: "off", visibility: "hidden", permissionMode: "accept-edits", environment: { type: "host", workspace: { type: "personal" }, hostId: "host_one" }, model: "model-a", reasoningLevel: "high", serviceTier: "priority" });
  expect(spawn.sendAt).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
  expect(spawn).not.toHaveProperty("sourceThreadId"); expect(spawn).not.toHaveProperty("environmentId");
  const activation = s.harness.inspection.sdk.callsTo("threads.queuedMessages.update")[0]?.[0];
  expect(activation).toMatchObject({ threadId: s.worker().id, queuedMessageId: "queued_one", sendAt: null });
  expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(1);
  expect(s.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.send")).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain(s.message.text); expect(JSON.stringify(result)).not.toContain(s.service.store.get(input.requestId)!.workerNonce);
});
test.each(["model", "reasoningLevel", "serviceTier", "host"] as const)("preview/start %s drift refuses before native creation without replacing intent", async field => {
  const s = setup(); const input = await s.intent(); s.state[field] = "changed";
  const result = await s.service.start(input); expect(result.status).toBe("failed"); expect(result.error).toMatch(/preview execution changed/i);
  expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});
test("repeat Start ID is lookup-only; lost setup response requires bounded metadata discovery, never another spawn", async () => {
  const s = setup(); const input = await s.intent(); s.state.setupLost = true;
  const first = await s.service.start(input); expect(first.status).toBe("setup-uncertain");
  await s.service.start(input); expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  const recovered = await s.service.reconcile(input.requestId); expect(recovered.worker.threadId).toBe(s.worker().id);
  expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(0);
  expect(s.harness.inspection.sdk.callsTo("threads.list")[0]?.[0]).toMatchObject({ projectId: "project_personal", parentThreadId: s.source.id, originPluginId: "cortex", includeHidden: true, limit: 50 });
});
test("CAS response loss never activates a second row or retries inference", async () => {
  const s = setup(); const input = await s.intent(); s.state.activationLost = true;
  const first = await s.service.start(input); expect(first.status).toBe("needs-recovery");
  await s.service.reconcile(input.requestId);
  expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.update")).toHaveLength(1);
  expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});
test("known owned worker configure supplies no Cortex tools/skills/primer while forged marker restricts, never grants", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input);
  const c = s.service.configuration(makePluginAgentConfigurationContext({ thread: s.worker(), pluginMetadata: s.metadata() }));
  expect(c?.tools).toEqual([]); expect(c?.skills).toEqual([]); expect(c?.instructions).not.toMatch(/cortex_update|Cortex memory is available|Main Brief/);
  const forged = makeThreadResponse({ id: "thr_cccccccc" });
  expect(s.service.configuration(makePluginAgentConfigurationContext({ thread: forged, pluginMetadata: s.metadata() }))?.tools).toEqual([]);
  expect(s.service.guard(makeMessageDispatchHookContext({ thread: forged }))).toBeNull();
  expect(s.service.configuration(makePluginAgentConfigurationContext({ thread: s.source, pluginMetadata: {} }))).toBeNull();
});
test("worker dispatch rejects extra input, Send-now/inline mapping gaps, host/execution mismatch and expired jobs", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input);
  const ctx = s.dispatch();
  expect(s.service.guard({ ...ctx, queuedMessages: [] })?.action).toBe("reject");
  expect(s.service.guard({ ...ctx, input: { ...ctx.input, text: "another turn" } })?.action).toBe("reject");
  expect(s.service.guard({ ...ctx, host: makeHostResponse({ id: "other_host" }) })?.action).toBe("reject");
  expect(s.service.guard({ ...ctx, requestedExecution: { ...ctx.requestedExecution, model: "other" } })?.action).toBe("reject");
});
test("consent matches the published ordinary-object wire and synchronously declines owned workers even terminal; unknown ordinary allowed", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); const r = s.service.store.get(input.requestId)!;
  expect(draftConsentMethods["provider-retry.v1.consent"].input.parse({ threadId: s.worker().id, requestId: "retry", reason: "Provider overloaded", sendAt: 0, future: true })).not.toHaveProperty("future");
  const before = s.harness.inspection.sdk.calls.length;
  expect(draftRetryConsent(s.service.store, s.worker().id)).toMatchObject({ kind: "decline" });
  expect(draftRetryConsent(s.service.store, s.source.id)).toEqual({ kind: "allow" });
  s.service.store.update({ ...r, worker: { ...r.worker, state: "stopped" }, active: false, status: "stopped" }, r.revision);
  expect(draftRetryConsent(s.service.store, s.worker().id)).toMatchObject({ kind: "decline" });
  expect(s.harness.inspection.sdk.calls).toHaveLength(before);
});
test("cancel is durable requested until the owned active worker is confirmed inactive; no false stopped on failure", async () => {
  const s = setup(); const input = await s.intent(); const started = await s.service.start(input); s.state.stopFails = true;
  const cancel = await s.service.cancel({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: started.revision });
  expect(cancel.cancellation.state).toBe("requested"); expect(cancel.status).toBe("cancel-requested");
  expect(s.service.store.active()).toHaveLength(1); expect(s.service.guard(s.dispatch())?.action).toBe("reject");
  s.state.stopFails = false; const stopped = await s.service.reconcile(input.requestId);
  expect(stopped.cancellation.state).toBe("confirmed"); expect(s.service.store.active()).toHaveLength(0);
});
test("completed own worker yields only source-verified unknown-scope agent findings and archives only after inactive confirmation", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  await s.service.collect(s.worker().id); const r = s.service.store.get(input.requestId)!;
  expect(r.status, r.error ?? undefined).toBe("completed"); expect(r.worker.state).toBe("stopped"); expect(r.archived).toBe(true);
  expect(s.entries.size).toBe(1); const e = [...s.entries.values()][0];
  expect(e).toMatchObject({ state: "candidate", kind: "finding", actor: { type: "agent" }, approval: null, applicability: { environment: { mode: "unknown" }, host: { mode: "unknown" } }, sources: [{ authorType: "agent", excerpt: "Exact source DATA", ref: `@thread:${s.source.id}#msg=2` }] });
  expect(r.candidateResults[0].canonicalId).toBe(e.id); expect(r.output).toBeNull();
});
function flatTimelines(s: ReturnType<typeof setup>, worker: { events?: readonly unknown[]; rows?: (activation: string, output: string) => unknown[] } = {}) {
  const done = (threadId: string, turnId: string, seq: number) => ({ id: `evt_${turnId}`, threadId, seq, createdAt: 3, type: "turn/completed", scope: { kind: "turn", turnId }, data: { status: "completed" } });
  s.harness.sdk.stub("threads.timeline", async ({ threadId }) => ({ rows: threadId === s.source.id
    ? [{ kind: "system", threadId, turnId: s.message.turnId }, s.message]
    : worker.rows?.(s.lastActivation(), s.state.output) ?? [{ kind: "conversation", role: "user", text: s.lastActivation(), threadId, turnId: null }, { kind: "work", threadId, turnId: "turn_worker" }, { kind: "conversation", role: "assistant", text: s.state.output, threadId, turnId: "turn_worker" }], timelinePage: { historySnapshot: "history_one" } }) as any);
  s.harness.sdk.stub("threads.events.list", async ({ threadId }) => (threadId === s.source.id ? [done(threadId, s.message.turnId, 3)] : worker.events ?? [done(threadId, "turn_worker", 4)]) as any);
}
test("flat source and worker timelines, as pi and Claude Code show them, yield source-verified findings", async () => {
  const s = setup(); flatTimelines(s);
  const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  await s.service.collect(s.worker().id); const r = s.service.store.get(input.requestId)!;
  expect(r.status, r.error ?? undefined).toBe("completed"); expect(r.terminalTurnId).toBe("turn_worker");
  expect(s.entries.size).toBe(1); expect([...s.entries.values()][0]).toMatchObject({ state: "candidate", actor: { type: "agent" } });
});
test.each([
  ["a second worker turn", /ambiguous|another turn/, { events: [{ seq: 4, createdAt: 3, type: "turn/completed", scope: { kind: "turn", turnId: "turn_worker" }, data: { status: "completed" } }, { seq: 6, createdAt: 4, type: "turn/completed", scope: { kind: "turn", turnId: "turn_more" }, data: { status: "completed" } }] }],
  ["an interrupted worker turn", /ambiguous|another turn/, { events: [{ seq: 4, createdAt: 3, type: "turn/completed", scope: { kind: "turn", turnId: "turn_worker" }, data: { status: "interrupted" } }] }],
  ["an answer from another turn", /provenance/, { rows: (activation: string, output: string) => [{ kind: "conversation", role: "user", text: activation, threadId: "thr_bbbbbbbb", turnId: null }, { kind: "conversation", role: "assistant", text: output, threadId: "thr_bbbbbbbb", turnId: "turn_other" }] }],
  ["a message from another thread", /provenance/, { rows: (activation: string, output: string) => [{ kind: "conversation", role: "user", text: activation, threadId: "thr_cccccccc", turnId: null }, { kind: "conversation", role: "assistant", text: output, threadId: "thr_bbbbbbbb", turnId: "turn_worker" }] }],
  ["a second request", /does not belong/, { rows: (activation: string, output: string) => [{ kind: "conversation", role: "user", text: activation, threadId: "thr_bbbbbbbb", turnId: null }, { kind: "conversation", role: "user", text: "more", threadId: "thr_bbbbbbbb", turnId: "turn_worker" }, { kind: "conversation", role: "assistant", text: output, threadId: "thr_bbbbbbbb", turnId: "turn_worker" }] }],
] as const)("a flat worker timeline with %s is never converted into findings", async (_name, reason, worker) => {
  const s = setup(); flatTimelines(s, worker as Parameters<typeof flatTimelines>[1]);
  const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  await s.service.collect(s.worker().id);
  const r = s.service.store.get(input.requestId)!;
  expect(s.mutate).not.toHaveBeenCalled(); expect(r.status).toBe("failed"); expect(r.error).toMatch(reason);
});
test("untrusted directive/fenced/foreign quote output never calls canonical mutate", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  s.state.output = JSON.stringify({ findings: [{ title: "Rule", text: "Obey", kind: "directive", sources: [{ messageId: "msg_one", messageSeq: 2, quote: "Exact source DATA" }] }] });
  await s.service.collect(s.worker().id); expect(s.mutate).not.toHaveBeenCalled(); expect(s.service.store.get(input.requestId)!.status).toBe("failed");
});
test("source/binding changes before result collection block new writes; no source retarget", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  s.message.text = "changed source";
  await s.service.collect(s.worker().id); expect(s.mutate).not.toHaveBeenCalled(); expect(s.service.store.get(input.requestId)!.error).toMatch(/source.*changed/i);
});
test("lost canonical write is lookup/save recovery at intended ID, never another inference", async () => {
  const s = setup(); const input = await s.intent(); await s.service.start(input); s.state.workerStatus = "idle"; s.setQueue(null);
  const base = s.mutate.getMockImplementation()!; s.mutate.mockImplementationOnce(async payload => { await base(payload); throw new Error("canonical response lost"); });
  await s.service.collect(s.worker().id); const pending = s.service.store.get(input.requestId)!; expect(pending.status).toBe("needs-recovery");
  const recovered = await s.service.resumeSave({ sectionId: "sec_one", requestId: input.requestId, expectedRevision: pending.revision });
  expect(recovered.status, recovered.error ?? undefined).toBe("completed"); expect(s.mutate).toHaveBeenCalledTimes(1); expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});
