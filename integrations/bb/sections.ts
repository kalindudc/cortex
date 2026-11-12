import { createHash, randomUUID } from "node:crypto";
import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { Workstreams } from "./workstreams";
import { composeThreadContext } from "./workstreams";
import {
  KNOWLEDGE_SOURCE_EXCERPT_MAX,
  SOURCE_EXCERPT_LIMIT_MESSAGE,
  type Knowledge,
  type Workstream,
} from "./workstream-contract";
import {
  type CaptureInput,
  type CaptureJob,
  type ConnectionJob,
  type ConnectInput,
  type Section,
  type SectionEligibility,
  type TitleMark,
  sectionRpcMethods,
} from "./section-contract";
import { type JobRecord, unmarked } from "./section-store";
import { registerSectionEvents } from "./section-events";
import type { z } from "zod";

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const conflict = (e: unknown) => /409|conflict|occupied/i.test(errorText(e));
const known = (a: CaptureInput["applicability"]) => a.environment.mode !== "unknown" && a.host.mode !== "unknown";
type ConnectRecord = Extract<JobRecord, { kind: "connect" }>;
type CaptureRecord = Extract<JobRecord, { kind: "capture" }>;

export function createSections(bb: BbPluginApi, service: Workstreams) {
  const { cli, store } = service;
  const jobs = store.jobs;
  const running = new Map<string, Promise<unknown>>();
  async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = running.get(key);
    const next = prior ? prior.catch(() => undefined).then(operation) : operation();
    running.set(key, next);
    try {
      return await next;
    } finally {
      if (running.get(key) === next) running.delete(key);
    }
  }
  function publish(sectionId: string, workstreamId?: string, requestId?: string) {
    bb.realtime.publish("sections", {
      sectionId,
      ...(workstreamId ? { workstreamId } : {}),
      ...(requestId ? { requestId } : {}),
    });
  }
  const observer = registerSectionEvents(bb, sectionId => publish(sectionId));
  async function native(sectionId: string, signal?: AbortSignal) {
    const sections = await bb.sdk.threadSections.list({ signal });
    const section = sections.find(s => s.id === sectionId);
    if (!section) throw new Error("Section not found; its canonical workstream was not removed.");
    return section;
  }
  function observedMarker(sectionId: string, name: string): TitleMark {
    const mark = jobs.marker(sectionId);
    if (mark.status === "owned" && name !== mark.decoratedTitle)
      return {
        ...mark,
        status: "conflict",
        error:
          "Section was manually renamed. Cortex will not overwrite it; rename conflicts require explicit recovery.",
      };
    if (mark.status === "unmarked" && name.startsWith("🧠")) return { ...mark, status: "user-marked" };
    return mark;
  }
  async function markTitle(input: z.infer<typeof sectionRpcMethods.sectionTitleMark.input>): Promise<TitleMark> {
    if (input.action === "apply")
      throw new experimental_PluginRpcRefusal({ code: "invalid", message: "Native section titles are text-only. New title decoration is disabled; use the Brain SVG on supported Cortex surfaces. No section was renamed." });
    return serial(`title:${input.sectionId}`, async () => {
      const current = await native(input.sectionId);
      const old = jobs.marker(input.sectionId);
      const save = (value: TitleMark) => {
        const result = jobs.setMarker(input.sectionId, value);
        publish(input.sectionId);
        return result;
      };
      if (current.name !== input.expectedTitle)
        return save({
          ...old,
          status: "conflict",
          error:
            "Section title changed before the rename. Re-read the actual title and retry explicitly; the public title API has no compare-and-swap.",
        });
      if (
        old.decoratedTitle !== null &&
        old.originalTitle !== null &&
        current.name !== old.decoratedTitle &&
        current.name !== old.originalTitle
      )
        return save({
          ...old,
          status: "conflict",
          error: "Section was manually renamed. Cortex will not overwrite or strip the changed title.",
        });
      if (old.decoratedTitle === null || old.originalTitle === null)
        return current.name.startsWith("🧠") ? save({ ...unmarked(), status: "user-marked" }) : save(unmarked());
      if (current.name !== old.decoratedTitle) return save(unmarked());
      const originalTitle = old.originalTitle;
      const decoratedTitle = old.decoratedTitle;
      const desired = originalTitle;
      // Retain ownership evidence until the non-CAS removal is confirmed.
      save({
        status: "failed",
        originalTitle,
        decoratedTitle,
        error: "Title update is pending; retry explicitly if its response is lost.",
      });
      try {
        const response = await bb.sdk.threadSections.update({ id: input.sectionId, name: desired });
        const after = await native(input.sectionId);
        if (response.id !== input.sectionId || response.name !== desired || after.name !== desired)
          return save({
            status: "conflict",
            originalTitle,
            decoratedTitle,
            error: "The section changed during rename. The title API has no CAS; inspect and retry explicitly.",
          });
        return save(unmarked());
      } catch (e) {
        return save({ status: "failed", originalTitle, decoratedTitle, error: errorText(e) });
      }
    });
  }
  function connectionResult(record: ConnectRecord): ConnectionJob {
    return {
      requestId: record.requestId,
      sectionId: record.input.sectionId,
      workstreamId: record.intendedId,
      expectedRevision: record.input.expectedRevision,
      bindingRevision: record.bindingRevision,
      status: record.status,
      error: record.error,
      marker: jobs.marker(record.input.sectionId),
    };
  }
  function verifyCreation(w: Workstream, record: ConnectRecord) {
    const choice = record.input.choice;
    if (
      choice.kind !== "create" ||
      w.id !== record.intendedId ||
      w.revision !== 1 ||
      w.archived ||
      w.name !== choice.name ||
      w.description !== (choice.description ?? "") ||
      fingerprint(w.actor) !== fingerprint(record.actor)
    )
      throw new Error(
        "Occupied workstream ID conflict: intended creation content/provenance does not match. No foreign workstream was connected.",
      );
  }
  async function resumeConnect(record: ConnectRecord, signal?: AbortSignal): Promise<ConnectionJob> {
    const input = record.input;
    if (record.status === "connected")
      return {
        ...connectionResult(record),
        marker: observedMarker(input.sectionId, (await native(input.sectionId, signal)).name),
      };
    try {
      const section = await native(input.sectionId, signal);
      const binding = store.section(input.sectionId);
      if (binding.revision !== input.expectedRevision)
        throw new Error(
          `Section binding revision conflict: expected ${input.expectedRevision}, current ${binding.revision}. Retry cannot overwrite a newer connection.`,
        );
      if (section.name !== input.expectedTitle)
        throw new Error("Section title conflict: re-read before starting a new connection request.");
      if (record.status !== "connecting") {
        if (input.choice.kind === "create") {
          let workstream: Workstream;
          try {
            const result = await cli.mutate(
              {
                op: "create",
                id: record.intendedId,
                name: input.choice.name,
                description: input.choice.description,
                actor: record.actor,
              },
              signal,
            );
            if (!result.workstream || result.outcome !== "created")
              throw new Error("Creation returned no canonical workstream");
            workstream = result.workstream;
          } catch (e) {
            if (!conflict(e)) throw e;
            workstream = (await cli.show({ id: record.intendedId, limit: 1, offset: 0 }, signal)).workstream;
          }
          verifyCreation(workstream, record);
        } else {
          const { workstream } = await cli.show({ id: record.intendedId, limit: 1, offset: 0 }, signal);
          if (
            workstream.id !== record.intendedId ||
            workstream.archived ||
            workstream.revision !== input.choice.expectedWorkstreamRevision
          )
            throw new Error("Workstream revision conflict or archived workstream. Re-read before connecting.");
        }
        record.status = "connecting";
        record.error = null;
        jobs.put(record);
      } else {
        const { workstream } = await cli.show({ id: record.intendedId, limit: 1, offset: 0 }, signal);
        if (input.choice.kind === "create") verifyCreation(workstream, record);
        else if (
          workstream.id !== record.intendedId ||
          workstream.archived ||
          workstream.revision !== input.choice.expectedWorkstreamRevision
        )
          throw new Error("Workstream revision conflict; re-read before connecting.");
      }
      const row = store.connectJob(record, {
        workstreamId: record.intendedId,
        topic: null,
        budgetTokens: 1000,
        requiredKnowledgeIds: [],
      });
      record.bindingRevision = row.revision;
      record.status = "connected";
      record.error = null;
      service.invalidateScope({ sectionId: input.sectionId });
      publish(input.sectionId, record.intendedId, record.requestId);
      if (input.markTitle) {
        try {
          await markTitle({ sectionId: input.sectionId, expectedTitle: input.expectedTitle, action: "apply" });
        } catch (e) {
          jobs.setMarker(input.sectionId, { ...jobs.marker(input.sectionId), status: "failed", error: errorText(e) });
          publish(input.sectionId);
        }
      }
    } catch (e) {
      record.status = "failed";
      record.error = errorText(e);
      jobs.put(record);
      publish(input.sectionId, record.intendedId, record.requestId);
    }
    return connectionResult(record);
  }
  async function connect(input: ConnectInput, signal?: AbortSignal) {
    return serial(`connect:${input.sectionId}`, async () => {
      let record = jobs.get(input.requestId);
      const hash = fingerprint(input);
      if (record && (record.kind !== "connect" || record.fingerprint !== hash))
        throw new Error("Request ID conflict: this request already has different intent.");
      if (!record) {
        record = {
          kind: "connect",
          requestId: input.requestId,
          fingerprint: hash,
          input,
          actor: service.human(),
          intendedId: input.choice.kind === "create" ? `ws_${randomUUID()}` : input.choice.workstreamId,
          status: "pending",
          bindingRevision: null,
          error: null,
        };
        jobs.put(record);
      }
      return resumeConnect(record as ConnectRecord, signal);
    });
  }
  async function connectRetry(requestId: string, signal?: AbortSignal) {
    const record = jobs.get(requestId);
    if (!record || record.kind !== "connect") throw new Error("Connection job not found");
    return serial(`connect:${record.input.sectionId}`, async () =>
      resumeConnect(jobs.get(requestId) as ConnectRecord, signal),
    );
  }
  async function sectionList(signal?: AbortSignal): Promise<{ sections: Section[] }> {
    const [sections, threads] = await Promise.all([
      bb.sdk.threadSections.list({ signal }),
      bb.sdk.threads.list({ signal }),
    ]);
    observer.rememberSections(sections);
    observer.rememberThreads(threads);
    return {
      sections: sections.map(s => {
        const marker = observedMarker(s.id, s.name),
          job = jobs.latest(s.id);
        return {
          id: s.id,
          name: s.name,
          canonicalName: marker.status === "owned" ? marker.originalTitle! : s.name,
          threadCount: threads.filter(t => t.sectionId === s.id).length,
          binding: store.section(s.id),
          marker,
          connectionJob: job?.kind === "connect" ? connectionResult(job) : null,
        };
      }),
    };
  }
  async function eligibility(
    sectionId: string,
    signal?: AbortSignal,
    overrides: Parameters<typeof composeThreadContext>[0]["overrides"] = [],
  ): Promise<SectionEligibility> {
    await native(sectionId, signal);
    const binding = store.section(sectionId).binding;
    const base = {
      computedAt: new Date().toISOString(),
      status: "unbound" as const,
      error: null,
      entries: [],
      notices: [],
      exclusions: [],
      exactText: "",
      estimatedTokens: 0,
      budgetTokens: binding?.budgetTokens ?? 1000,
    };
    if (!binding) return base;
    try {
      const applicability = binding.applicability ?? {
        environment: { mode: "unknown" as const },
        host: { mode: "unknown" as const },
      };
      const out = await cli.read(binding.workstreamId, binding.topic, applicability, signal);
      if (out.workstream.id !== binding.workstreamId)
        throw new Error("Returned workstream does not match section binding");
      return {
        ...base,
        ...composeThreadContext({
          binding,
          applicability,
          entries: out.entries,
          notices: out.notices,
          overrides,
          grants: [],
          now: Date.now(),
        }),
      };
    } catch (e) {
      return { ...base, status: "unavailable", error: `${errorText(e)}. No legacy fallback.` };
    }
  }
  async function detail(input: z.infer<typeof sectionRpcMethods.sectionDetail.input>, signal?: AbortSignal) {
    const [list, threads, preview] = await Promise.all([
      sectionList(signal),
      bb.sdk.threads.list({ signal }),
      eligibility(input.sectionId, signal),
    ]);
    const section = list.sections.find(s => s.id === input.sectionId);
    if (!section) throw new Error("Section not found");
    const review = section.binding.binding
      ? await cli.knowledgeList(
          {
            workstreamId: section.binding.binding.workstreamId,
            reviewOnly: true,
            limit: input.limit,
            offset: input.offset,
          },
          signal,
        )
      : { items: [], total: 0, limit: input.limit, offset: input.offset };
    if (
      review.items.some(
        i =>
          i.entry.workstreamId !== section.binding.binding?.workstreamId ||
          i.workstream.id !== section.binding.binding?.workstreamId,
      )
    )
      throw new Error("Review returned records outside section workstream");
    return {
      section,
      threads: threads
        .filter(t => t.sectionId === section.id)
        .map(t => ({ id: t.id, name: t.title ?? t.titleFallback ?? "Untitled thread" })),
      eligibility: preview,
      review,
    };
  }
  async function bound(sectionId: string, expectedRevision: number, signal?: AbortSignal) {
    await native(sectionId, signal);
    const row = store.section(sectionId);
    if (row.revision !== expectedRevision)
      throw new Error(`Section binding revision conflict: expected ${expectedRevision}, current ${row.revision}.`);
    if (!row.binding) throw new Error("Connect this section before saving knowledge.");
    return row.binding;
  }
  async function sources(input: CaptureInput, signal?: AbortSignal, preflight = false) {
    const reject = (field: "quote" | "threadId" | "messageId" | "messageSeq", message: string): never => {
      if (preflight && !jobs.get(input.requestId))
        throw new experimental_PluginRpcRefusal({
          code: "invalid",
          message,
          issues: [{ path: ["source", field], message }],
        });
      throw new Error(message);
    };
    const source = input.source;
    if (source.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: source.threadId, signal });
      if (thread.id !== source.threadId || thread.sectionId !== input.sectionId)
        reject("threadId", "Source thread is not in the selected section.");
    }
    if (source.kind === "manual")
      return [
        {
          ref: `bb:manual:${input.requestId}:section:${input.sectionId}${source.threadId ? `:thread:${source.threadId}` : ""}`,
          authorType: "human" as const,
          observedAt: new Date().toISOString(),
          status: "available" as const,
        },
      ];
    const result = await bb.sdk.threads.message({
      threadId: source.threadId,
      seq: source.messageSeq,
      before: 0,
      after: 0,
      signal,
    });
    const message = result.message;
    if (!message || message.id !== source.messageId)
      reject("messageId", "Message source reference does not match the actual public SDK message.");
    if (message.threadId !== source.threadId)
      reject("threadId", "Message source thread does not match the actual public SDK message.");
    if (message.messageSeq !== source.messageSeq)
      reject("messageSeq", "Message source sequence does not match the actual public SDK message.");
    const excerpt = source.quote ?? message.text;
    if (excerpt.length > KNOWLEDGE_SOURCE_EXCERPT_MAX) reject("quote", SOURCE_EXCERPT_LIMIT_MESSAGE);
    if (!excerpt || !message.text.includes(excerpt))
      reject(
        "quote",
        "Selected quote cannot be verified in the original raw message. No whole-message fallback was saved. Select a raw span within 8192 characters, explicitly capture a shorter whole message, or write a manual takeaway.",
      );
    const authorType =
      message.role === "assistant"
        ? ("agent" as const)
        : message.initiator === "user"
          ? ("human" as const)
          : message.initiator;
    return [
      {
        ref: `@thread:${source.threadId}#msg=${message.messageSeq}`,
        excerpt,
        authorType,
        observedAt: new Date(message.createdAt).toISOString(),
        status: "available" as const,
      },
    ];
  }
  function proposal(record: CaptureRecord) {
    const input = record.input!;
    return {
      id: record.intendedId,
      workstreamId: record.workstreamId,
      actor: record.actor,
      subject:
        input.subject ??
        (input.source.kind === "message"
          ? `message:${fingerprint({ source: record.sources[0].ref, quote: record.sources[0].excerpt, title: input.title.trim() })}`
          : `capture:${record.requestId}`),
      title: input.title,
      text: input.text,
      kind: input.kind,
      facet: "orientation",
      applicability: input.applicability,
      sources: record.sources,
    };
  }
  function verifyCapture(entry: Knowledge, record: CaptureRecord, duplicate: boolean) {
    const desired = proposal(record);
    if (
      entry.workstreamId !== desired.workstreamId ||
      fingerprint(entry.applicability) !== fingerprint(desired.applicability)
    )
      throw new Error("Canonical capture conflict: workstream or applicability does not match.");
    if (duplicate) {
      const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
      const sourceKey = (source: Knowledge["sources"][number]) =>
        JSON.stringify([source.ref, source.authorType, source.observedAt, source.excerpt ?? ""]);
      const existingSources = new Set(entry.sources.map(sourceKey));
      if (
        normalized(entry.text) !== normalized(desired.text) ||
        normalized(entry.subject) !== normalized(desired.subject) ||
        entry.kind !== desired.kind ||
        entry.facet !== desired.facet ||
        entry.expiresAt !== null ||
        !desired.sources.every(source => existingSources.has(sourceKey(source)))
      )
        throw new Error(
          "Canonical no-save conflict: normalized claim, subject or original source evidence does not match.",
        );
      return;
    }
    if (
      entry.id !== desired.id ||
      entry.text !== desired.text ||
      entry.revision !== 1 ||
      entry.subject !== desired.subject ||
      entry.title !== desired.title ||
      entry.kind !== desired.kind ||
      entry.facet !== desired.facet ||
      entry.expiresAt !== null ||
      fingerprint(entry.actor) !== fingerprint(desired.actor) ||
      fingerprint(entry.sources) !== fingerprint(desired.sources) ||
      (record.input!.mode === "accept"
        ? entry.state !== "approved" || fingerprint(entry.approval?.actor) !== fingerprint(record.actor)
        : entry.state !== "candidate")
    )
      throw new Error(
        "Occupied knowledge ID conflict: original content/provenance/revision does not match. No foreign record was accepted.",
      );
  }
  function captureView(record: CaptureRecord, entry: Knowledge | null): CaptureJob {
    return {
      requestId: record.requestId,
      sectionId: record.sectionId,
      intendedKnowledgeId: record.intendedId,
      knowledgeId: record.canonicalId,
      status: record.status,
      entry,
      error: record.error,
    };
  }
  async function captureResult(record: CaptureRecord, signal?: AbortSignal): Promise<CaptureJob> {
    const entry = record.canonicalId ? await cli.knowledge(record.canonicalId, signal) : null;
    if (entry && (entry.id !== record.canonicalId || entry.workstreamId !== record.workstreamId))
      throw new Error("Canonical capture id/workstream conflict");
    return captureView(record, entry);
  }
  async function recoverCapture(record: CaptureRecord, signal?: AbortSignal): Promise<Knowledge | null> {
    if (!record.attempted) return null;
    let entry: Knowledge;
    try {
      entry = await cli.knowledge(record.canonicalId ?? record.intendedId, signal);
    } catch (e) {
      if (!record.canonicalId && /404|not found/i.test(errorText(e))) return null;
      throw e;
    }
    verifyCapture(entry, record, record.canonicalId !== null && record.canonicalId !== record.intendedId);
    record.canonicalId = entry.id;
    return entry;
  }
  async function resumeCapture(record: CaptureRecord, signal?: AbortSignal) {
    if (record.dismissed)
      throw new Error("Capture job was explicitly dismissed. It will not be retried automatically.");
    if (record.status === "saved" || record.status === "no-save") return captureResult(record, signal);
    try {
      const recovered = await recoverCapture(record, signal);
      const binding = await bound(record.sectionId, record.input!.expectedBindingRevision, signal);
      if (binding.workstreamId !== record.workstreamId)
        throw new Error("Section workstream conflict; capture was not saved.");
      // Unsaved retries revalidate the exact message without replacing its original timestamp.
      if (!recovered && record.input!.source.kind === "message") {
        const verified = await sources(record.input!, signal);
        if (fingerprint(verified) !== fingerprint(record.sources))
          throw new Error("Original message source changed; retry refuses to replace its provenance.");
      } else if (!recovered && record.input!.source.threadId) {
        const thread = await bb.sdk.threads.get({ threadId: record.input!.source.threadId, signal });
        if (thread.id !== record.input!.source.threadId || thread.sectionId !== record.sectionId)
          throw new Error("Manual source thread moved outside section scope.");
      }
      let entry: Knowledge;
      let duplicate = false;
      if (recovered) entry = recovered;
      else {
        record.attempted = true;
        jobs.put(record);
        try {
          const result = await cli.mutate(
            {
              op: record.input!.mode === "accept" ? "save-approved" : "propose",
              ...proposal(record),
              ...(record.input!.mode === "accept" ? { reason: record.input!.reason } : {}),
            },
            signal,
          );
          if (!result.entry || (result.outcome !== "created" && result.outcome !== "no-save"))
            throw new Error("Capture returned no canonical saved entry");
          if (record.input!.mode === "accept" && result.outcome === "no-save")
            throw new Error("Approval cannot silently accept a duplicate entry.");
          entry = result.entry;
          duplicate = result.outcome === "no-save";
        } catch (e) {
          if (!conflict(e)) throw e;
          entry = await cli.knowledge(record.intendedId, signal);
        }
      }
      verifyCapture(entry, record, duplicate);
      record.canonicalId = entry.id;
      record.status = duplicate ? "no-save" : "saved";
      record.error = null;
      // Only pending intent is stored here; completed canonical knowledge belongs solely to Cortex.
      record.input = null;
      record.sources = [];
      jobs.put(record);
      try {
        service.invalidateScope({ workstreamId: record.workstreamId });
        publish(record.sectionId, record.workstreamId, record.requestId);
      } catch (e) {
        bb.log.warn(`Cortex capture saved, but realtime refresh failed: ${errorText(e)}`);
      }
      return {
        requestId: record.requestId,
        sectionId: record.sectionId,
        intendedKnowledgeId: record.intendedId,
        knowledgeId: entry.id,
        status: record.status,
        entry,
        error: null,
      };
    } catch (e) {
      record.status = "failed";
      record.error = errorText(e);
      jobs.put(record);
      publish(record.sectionId, record.workstreamId, record.requestId);
      return captureResult(record, signal);
    }
  }
  async function capture(input: CaptureInput, signal?: AbortSignal) {
    return serial(`request:${input.requestId}`, async () => {
      let record = jobs.get(input.requestId);
      const hash = fingerprint(input);
      if (record && (record.kind !== "capture" || record.fingerprint !== hash))
        throw new Error("Request ID conflict: this capture already has different intent.");
      if (!record) {
        if (input.mode === "accept" && (!known(input.applicability) || !input.reason))
          throw new Error("Choose both applicability dimensions and an explicit acceptance reason before saving.");
        const binding = await bound(input.sectionId, input.expectedBindingRevision, signal);
        const evidence = await sources(input, signal, true);
        record = {
          kind: "capture",
          requestId: input.requestId,
          fingerprint: hash,
          input,
          sectionId: input.sectionId,
          workstreamId: binding.workstreamId,
          actor: service.human(),
          intendedId: `kn_${randomUUID()}`,
          canonicalId: null,
          sources: evidence,
          status: "pending",
          error: null,
          attempted: false,
          dismissed: false,
        };
        jobs.put(record);
      }
      return resumeCapture(record as CaptureRecord, signal);
    });
  }
  async function captureRetry(requestId: string, signal?: AbortSignal) {
    return serial(`request:${requestId}`, async () => {
      const record = jobs.get(requestId);
      if (!record || record.kind !== "capture") throw new Error("Capture job not found");
      return resumeCapture(record, signal);
    });
  }
  async function captureJobs(input: z.infer<typeof sectionRpcMethods.sectionCaptureJobs.input>, signal?: AbortSignal) {
    await native(input.sectionId, signal);
    const page = jobs.pendingCaptures(input.sectionId, input.limit, input.offset);
    const items = [];
    for (const record of page.jobs) {
      signal?.throwIfAborted();
      if (!record.input) throw new Error("Pending capture intent is unavailable; do not recreate or retarget it.");
      let entry: Knowledge | null = null;
      try {
        entry = await recoverCapture(record, signal);
      } catch (e) {
        record.error = `${record.error ?? "Capture recovery"}; canonical verification failed: ${errorText(e)}`;
      }
      items.push({
        ...captureView(record, entry),
        workstreamId: record.workstreamId,
        expectedBindingRevision: record.input.expectedBindingRevision,
        intent: {
          title: record.input.title,
          kind: record.input.kind,
          applicability: record.input.applicability,
          mode: record.input.mode,
        },
        sources: record.sources,
      });
    }
    return { jobs: items, total: page.total, limit: page.limit, offset: page.offset };
  }
  async function captureDismiss(
    input: z.infer<typeof sectionRpcMethods.sectionCaptureDismiss.input>,
    signal?: AbortSignal,
  ) {
    await native(input.sectionId, signal);
    return serial(`request:${input.requestId}`, async () => {
      const record = jobs.get(input.requestId);
      if (!record || record.kind !== "capture" || record.sectionId !== input.sectionId)
        throw new Error("Capture job not found in this section");
      record.dismissed = true;
      jobs.put(record);
      publish(record.sectionId, record.workstreamId, record.requestId);
      return { requestId: record.requestId, dismissed: true as const };
    });
  }
  async function candidateEntry(
    input: z.infer<typeof sectionRpcMethods.sectionCandidateEdit.input>,
    signal?: AbortSignal,
  ) {
    const binding = await bound(input.sectionId, input.expectedBindingRevision, signal);
    const entry = await cli.knowledge(input.id, signal);
    if (entry.id !== input.id || entry.workstreamId !== binding.workstreamId)
      throw new Error("Candidate is outside this section's connected workstream.");
    if (entry.revision !== input.expectedRevision)
      throw new Error(`Candidate revision conflict: current ${entry.revision}. Your draft was not applied.`);
    if (entry.state !== "candidate")
      throw new Error("This record is not a candidate. Use its explicit review actions.");
    return entry;
  }
  async function candidateEdit(
    input: z.infer<typeof sectionRpcMethods.sectionCandidateEdit.input>,
    signal?: AbortSignal,
  ) {
    const entry = await candidateEntry(input, signal);
    const { sectionId: _sectionId, expectedBindingRevision: _bindingRevision, ...edit } = input;
    const result = await cli.mutate({ op: "edit", ...edit, actor: service.human() }, signal);
    service.invalidateScope({ workstreamId: entry.workstreamId });
    return result;
  }
  async function candidateAccept(
    input: z.infer<typeof sectionRpcMethods.sectionCandidateAccept.input>,
    signal?: AbortSignal,
  ) {
    if (!known(input.applicability))
      throw new Error("Choose both applicability dimensions before accepting; unknown is not Everywhere.");
    const entry = await candidateEntry(input, signal);
    if (input.supersede) {
      const other = await cli.knowledge(input.supersede.id, signal);
      if (other.id !== input.supersede.id || other.workstreamId !== entry.workstreamId)
        throw new Error("Replacement is outside this workstream.");
    }
    const { sectionId: _sectionId, expectedBindingRevision: _bindingRevision, ...accept } = input;
    const result = await cli.mutate({ op: "accept", ...accept, actor: service.human() }, signal);
    service.invalidateScope({ workstreamId: entry.workstreamId });
    return result;
  }
  return {
    sectionList,
    detail,
    eligibility,
    connect,
    connectRetry,
    markTitle,
    capture,
    captureRetry,
    captureJobs,
    captureDismiss,
    candidateEdit,
    candidateAccept,
    human: service.human,
  };
}
export type Sections = ReturnType<typeof createSections>;
