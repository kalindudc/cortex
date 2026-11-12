import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, test, vi } from "vitest";
import type { z } from "zod";
import type { CortexRunner } from "./cli";
import { createWorkstreams } from "./workstreams";
import { createSections } from "./sections";
import { sectionRpcContract } from "./section-contract";
import { sectionHandlers } from "./section-rpc";
import { workstreamRpcContract, type Knowledge, type Workstream } from "./workstream-contract";
import { workstreamHandlers } from "./workstream-rpc";

const at = "2026-01-01T00:00:00.000Z";
const actor = { id: "you", type: "human" as const };
const applicability = { environment: { mode: "not-applicable" as const }, host: { mode: "not-applicable" as const } };
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const d of disposers.splice(0)) await d();
});
function setup() {
  let name = "Envoy";
  const subscriptions: Parameters<BbPluginApi["sdk"]["subscribe"]>[0][] = [];
  const workstreams = new Map<string, Workstream>();
  const entries = new Map<string, Knowledge>();
  const mutate = vi.fn<(input: Record<string, any>) => Promise<any>>(async input => {
    if (input.op === "create") {
      if (workstreams.has(input.id)) throw new Error("409 conflict: occupied ID");
      const workstream: Workstream = {
        id: input.id,
        name: input.name,
        description: input.description ?? "",
        revision: 1,
        actor: input.actor,
        archived: false,
        createdAt: at,
        updatedAt: at,
      };
      workstreams.set(input.id, workstream);
      return { outcome: "created", workstream };
    }
    throw new Error(`Unexpected mutation ${input.op}`);
  });
  const reads: string[][] = [];
  const runner: CortexRunner = {
    binary: "fake",
    async run(args, schema, options) {
      if (args[1] === "mutate") return schema.parse(await mutate(JSON.parse(options!.input!)));
      reads.push([...args]);
      if (args[1] === "show") {
        const workstream = workstreams.get(args[2]);
        if (!workstream) throw new Error("workstream not found");
        return schema.parse({ workstream, entries: [], total: 0, limit: 1, offset: 0 });
      }
      if (args[1] === "entry") {
        const e = entries.get(args[2]);
        if (!e) throw new Error("knowledge not found");
        return schema.parse(e);
      }
      if (args[1] === "read")
        return schema.parse({
          workstream: workstreams.get(args[2]),
          entries: [...entries.values()],
          notices: [],
          applicability,
          topic: null,
        });
      if (args[1] === "knowledge") return schema.parse({ items: [], total: 0, limit: 50, offset: 0 });
      throw new Error("Unexpected read");
    },
    async text() {
      throw new Error("Legacy read forbidden");
    },
  };
  const update = vi.fn(async ({ name: next }: { name: string }) => {
    name = next;
    return { id: "sec_one", name, updatedThreadCount: 1 };
  });
  const thread = makeThreadResponse({ id: "thr_aaaaaaaa", sectionId: "sec_one" });
  const message = {
    id: "msg_one",
    threadId: thread.id,
    messageSeq: 14,
    sourceSeqStart: 14,
    sourceSeqEnd: 14,
    role: "assistant" as const,
    text: "Exact original message quote",
    createdAt: Date.parse(at),
  };
  const host = createFakePluginHost({
    pluginId: "cortex",
    sdk: {
      subscribe: subscription => {
        subscriptions.push(subscription);
        return () => undefined;
      },
      threadSections: { list: async () => [{ id: "sec_one", name, createdAt: 0, updatedAt: 0 }], update },
      threads: {
        get: async () => thread,
        list: async () => [thread],
        message: async () => ({ message, before: [], after: [] }) as any,
      },
    },
  });
  disposers.push(() => host.harness.lifecycle.dispose());
  const ws = createWorkstreams(host.bb, runner, { userAuthor: "you", widgetDefault: () => true });
  const sections = createSections(host.bb, ws);
  host.bb.rpc.register(sectionRpcContract, sectionHandlers(sections));
  async function call<K extends keyof typeof sectionRpcContract>(
    method: K,
    input: unknown,
  ): Promise<z.infer<(typeof sectionRpcContract)[K]["output"]>> {
    return (await host.harness.behavior.callRpc(method, input)) as z.infer<(typeof sectionRpcContract)[K]["output"]>;
  }
  const connect = {
    requestId: randomUUID(),
    sectionId: "sec_one",
    expectedRevision: 0,
    expectedTitle: "Envoy",
    choice: { kind: "create", name: "Envoy" },
    markTitle: true,
  };
  return {
    ...host,
    ws,
    runner,
    sections,
    call,
    connect,
    mutate,
    update,
    reads,
    workstreams,
    entries,
    thread,
    message,
    rename: (n: string) => {
      name = n;
    },
    notifyNativeSections: () => {
      for (const sub of subscriptions)
        if (sub.event === "system:changed")
          sub.callback({ type: "changed", entity: "system", changes: ["ui-preferences-changed"] });
    },
  };
}

test("native section changes and section thread membership events publish only affected section ids", async () => {
  const s = setup();
  await s.call("sectionList", null);
  s.rename("Renamed natively");
  s.notifyNativeSections();
  await vi.waitFor(() => expect(s.harness.realtimeSignals.filter(e => e.channel === "sections")).toHaveLength(1));
  expect(s.harness.realtimeSignals.at(-1)).toEqual({ channel: "sections", payload: { sectionId: "sec_one" } });
  s.harness.realtimeSignals.length = 0;
  await s.harness.behavior.emitThreadEvent("thread.created", { thread: s.thread });
  expect(s.harness.realtimeSignals).toEqual([{ channel: "sections", payload: { sectionId: "sec_one" } }]);
  s.harness.realtimeSignals.length = 0;
  await s.harness.behavior.emitThreadEvent("thread.idle", { thread: s.thread, lastAssistantText: null });
  expect(s.harness.realtimeSignals).toEqual([]);
});

test("persists intended id before create, connects once and retries without duplicate workstream", async () => {
  const s = setup();
  s.mutate.mockImplementationOnce(async input => {
    expect(s.ws.store.jobs.get(input.requestId ?? s.connect.requestId)).not.toBeNull();
    const workstream: Workstream = {
      id: input.id,
      name: input.name,
      description: "",
      revision: 1,
      actor,
      archived: false,
      createdAt: at,
      updatedAt: at,
    };
    s.workstreams.set(input.id, workstream);
    throw new Error("response lost");
  });
  const first = await s.call("sectionConnect", s.connect);
  expect(first).toMatchObject({ status: "failed", bindingRevision: null });
  expect(s.ws.store.section("sec_one").revision).toBe(0);
  const retry = await s.call("sectionConnectRetry", { requestId: s.connect.requestId });
  expect(retry).toMatchObject({ status: "connected", bindingRevision: 1, marker: { status: "failed" } });
  expect(s.workstreams.size).toBe(1);
  expect(s.mutate).toHaveBeenCalledTimes(2);
  expect(s.reads.filter(a => a[1] === "show").every(a => a[2] === retry.workstreamId)).toBe(true);
  await s.call("sectionConnectRetry", { requestId: s.connect.requestId });
  expect(s.ws.store.section("sec_one").revision).toBe(1);
});

test("opaque collision verifies provenance and cannot bind a foreign id", async () => {
  const s = setup();
  s.mutate.mockImplementationOnce(async input => {
    s.workstreams.set(input.id, {
      id: input.id,
      name: input.name,
      description: "",
      actor: { id: "other", type: "human" },
      revision: 1,
      archived: false,
      createdAt: at,
      updatedAt: at,
    });
    throw new Error("409 conflict: occupied ID");
  });
  expect(await s.call("sectionConnect", s.connect)).toMatchObject({
    status: "failed",
    error: expect.stringMatching(/provenance|conflict/i),
  });
  expect(s.ws.store.section("sec_one").binding).toBeNull();
});

test("newer binding is never overwritten by partial-job recovery", async () => {
  const s = setup();
  s.mutate.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await s.call("sectionConnect", s.connect);
  s.ws.store.setSection("sec_one", 0, {
    workstreamId: "ws_elsewhere",
    topic: null,
    budgetTokens: 1000,
    requiredKnowledgeIds: [],
  });
  expect(await s.call("sectionConnectRetry", { requestId: s.connect.requestId })).toMatchObject({
    status: "failed",
    error: expect.stringMatching(/revision/i),
  });
  expect(s.ws.store.section("sec_one").binding!.workstreamId).toBe("ws_elsewhere");
  expect(s.mutate).toHaveBeenCalledTimes(1);
});

test("new native title decoration is disabled even for explicit true and old persisted connect retry", async () => {
  const s = setup();
  s.mutate.mockRejectedValueOnce(new Error("offline"));
  await s.call("sectionConnect", s.connect);
  const recovered = await s.call("sectionConnectRetry", { requestId: s.connect.requestId });
  expect(recovered.status).toBe("connected");
  expect(s.update).not.toHaveBeenCalled();
  await expect(s.call("sectionTitleMark", { sectionId: "sec_one", expectedTitle: "Envoy", action: "apply" })).rejects.toThrow(/text-only|disabled|SVG/i);
  expect(s.update).not.toHaveBeenCalled();
});
test("connect contract defaults native marks off", () => {
  const s = setup();
  const { markTitle: _old, ...input } = s.connect;
  expect(sectionRpcContract.sectionConnect.input.parse(input).markTitle).toBe(false);
});

test("unsupported decoration keeps the valid connection and exposes honest text-only refusal", async () => {
  const s = setup();
  const out = await s.call("sectionConnect", s.connect);
  expect(out).toMatchObject({ status: "connected", bindingRevision: 1, marker: { status: "failed", error: expect.stringMatching(/text-only|disabled/i) } });
  await expect(s.call("sectionTitleMark", { sectionId: "sec_one", expectedTitle: "Envoy", action: "apply" })).rejects.toThrow(/text-only|disabled/i);
  expect(s.workstreams.size).toBe(1);
  expect(s.update).not.toHaveBeenCalled();
});

test("does not decorate on load, duplicate user marks, remove user marks or fight manual renames", async () => {
  const s = setup();
  await s.call("sectionList", null);
  expect(s.update).not.toHaveBeenCalled();
  s.rename("🧠 Envoy");
  await s.call("sectionConnect", { ...s.connect, expectedTitle: "🧠 Envoy", markTitle: false });
  expect((await s.call("sectionList", null)).sections[0].name).toBe("🧠 Envoy");
  expect(
    await s.call("sectionTitleMark", { sectionId: "sec_one", expectedTitle: "🧠 Envoy", action: "remove" }),
  ).toMatchObject({ status: "user-marked" });
  expect(s.update).not.toHaveBeenCalled();
  s.rename("🧠 Envoy");
  s.ws.store.jobs.setMarker("sec_one", { status: "owned", originalTitle: "Envoy", decoratedTitle: "🧠 Envoy", error: null });
  const list = await s.call("sectionList", null);
  expect(list.sections[0]).toMatchObject({ name: "🧠 Envoy", canonicalName: "Envoy" });
  s.rename("Manually renamed");
  expect(
    await s.call("sectionTitleMark", { sectionId: "sec_one", expectedTitle: "Manually renamed", action: "remove" }),
  ).toMatchObject({ status: "conflict" });
  expect(s.update).not.toHaveBeenCalled();
});

test("Stop sharing preserves native title and owned history until a separate explicit Remove", async () => {
  const s = setup(); await s.call("sectionConnect", { ...s.connect, markTitle: false });
  s.rename("🧠 Envoy");
  const marker = { status: "owned" as const, originalTitle: "Envoy", decoratedTitle: "🧠 Envoy", error: null };
  s.ws.store.jobs.setMarker("sec_one", marker);
  s.bb.rpc.register(workstreamRpcContract, workstreamHandlers(s.ws, s.sections));
  const invalidate = vi.spyOn(s.ws, "invalidateScope");
  await s.harness.behavior.callRpc("setSectionBinding", { sectionId: "sec_one", expectedRevision: 1, binding: null });
  expect(s.ws.store.section("sec_one")).toMatchObject({ revision: 2, binding: null });
  expect(invalidate).toHaveBeenCalledWith({ sectionId: "sec_one" });
  expect(s.update).not.toHaveBeenCalled(); expect(s.ws.store.jobs.marker("sec_one")).toEqual(marker);
  const native = (await s.sections.sectionList()).sections[0]; expect(native).toMatchObject({ name: "🧠 Envoy" });
  const removed = await s.call("sectionTitleMark", { sectionId: "sec_one", expectedTitle: native.name, action: "remove" });
  expect(removed.status).toBe("unmarked"); expect(s.update).toHaveBeenCalledExactlyOnceWith({ id: "sec_one", name: "Envoy" });
  expect(s.ws.store.section("sec_one")).toMatchObject({ revision: 2, binding: null });
});
test("recorded owned unchanged decoration is removable without stripping original user styling", async () => {
  const s = setup();
  s.rename("🧠 🧠 User name");
  s.ws.store.jobs.setMarker("sec_one", { status: "owned", originalTitle: "🧠 User name", decoratedTitle: "🧠 🧠 User name", error: null });
  const result = await s.call("sectionTitleMark", { sectionId: "sec_one", expectedTitle: "🧠 🧠 User name", action: "remove" });
  expect(result.status).toBe("unmarked");
  expect(s.update).toHaveBeenCalledExactlyOnceWith({ id: "sec_one", name: "🧠 User name" });
});

function candidate(id: string, workstreamId: string): Knowledge {
  return {
    id,
    workstreamId,
    subject: "takeaway",
    title: "Captured fact",
    text: "Fact",
    kind: "finding",
    state: "candidate",
    facet: "orientation",
    applicability,
    sources: [{ ref: "original", excerpt: "original quote", authorType: "agent", observedAt: at }],
    actor,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    expiresAt: null,
    approval: null,
    supersedes: [],
    supersededBy: null,
    conflicts: [],
  };
}
function capturing(s: ReturnType<typeof setup>) {
  s.mutate.mockImplementation(async input => {
    if (s.entries.has(input.id)) throw new Error("409 occupied ID conflict");
    const entry = {
      ...candidate(input.id, input.workstreamId),
      title: input.title,
      subject: input.subject,
      text: input.text,
      kind: input.kind,
      actor: input.actor,
      applicability: input.applicability,
      sources: input.sources,
      state: input.op === "save-approved" ? ("approved" as const) : ("candidate" as const),
      approval: input.op === "save-approved" ? { actor: input.actor, at } : null,
    };
    s.entries.set(entry.id, entry);
    return { outcome: "created", entry };
  });
}
async function captureSetup() {
  const s = setup();
  const connection = await s.call("sectionConnect", s.connect);
  capturing(s);
  const input = {
    requestId: randomUUID(),
    sectionId: "sec_one",
    expectedBindingRevision: 1,
    source: {
      kind: "message",
      threadId: s.thread.id,
      messageId: s.message.id,
      messageSeq: 14,
      quote: "original message",
    },
    title: "Captured fact",
    text: "Fact",
    applicability,
    mode: "review",
    kind: "finding",
  };
  return { s, input, connection };
}

test("captures server-verified source and selected quote as finding candidate, never trusts role or arbitrary ref", async () => {
  const { s, input } = await captureSetup();
  const result = await s.call("sectionCapture", input);
  expect(result).toMatchObject({
    status: "saved",
    entry: {
      state: "candidate",
      kind: "finding",
      sources: [
        { ref: `@thread:${s.thread.id}#msg=14`, authorType: "agent", excerpt: "original message", observedAt: at },
      ],
    },
  });
  expect(s.ws.store.jobs.get(input.requestId)).toMatchObject({ input: null, sources: [] });
  expect(s.harness.inspection.registrations.agentTools).toEqual([]);
  const repeated = await s.call("sectionCaptureRetry", { requestId: input.requestId });
  expect(repeated.knowledgeId).toBe(result.knowledgeId);
  expect(s.entries.size).toBe(1);
  await expect(
    s.call("sectionCapture", { ...input, source: { ...input.source, role: "human" } }),
  ).rejects.toMatchObject({ code: "invalid_input" });
});

test.each([
  { quote: "invented quote" },
  { messageId: "wrong message" },
  { messageSeq: 15 },
  { threadId: "thr_bbbbbbbb" },
])("rejects unverifiable message source before writing %j", async change => {
  const { s, input } = await captureSetup();
  await expect(
    s.call("sectionCapture", { ...input, requestId: randomUUID(), source: { ...input.source, ...change } }),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(s.entries.size).toBe(0);
});

test.each([
  { raw: "A **bold fact** is here.", selected: "bold fact", accepted: true },
  { raw: "A **bold fact** is here.", selected: "A bold fact is here.", accepted: false },
  { raw: "```ts\nconst answer = 42;\n```", selected: "const answer = 42;", accepted: true },
  { raw: "[the endpoint](https://example.test)", selected: "the endpoint", accepted: true },
])("verifies messageAction-style formatted selections without silently saving the whole message: $selected", async ({
  raw,
  selected,
  accepted,
}) => {
  const { s, input } = await captureSetup();
  s.message.text = raw;
  const operation = s.call("sectionCapture", { ...input, source: { ...input.source, quote: selected } });
  if (accepted) expect(await operation).toMatchObject({ status: "saved", entry: { sources: [{ excerpt: selected }] } });
  else {
    await expect(operation).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("No whole-message fallback"),
    });
    expect(s.entries.size).toBe(0);
  }
});

test("same message selection and title retain a stable producer subject across requests; distinct takeaways are distinct", async () => {
  const { s, input } = await captureSetup();
  await s.call("sectionCapture", input);
  await s.call("sectionCapture", { ...input, requestId: randomUUID() });
  const mutations = s.mutate.mock.calls.map(c => c[0]).filter(c => c.op === "propose");
  expect(mutations[0].subject).toBe(mutations[1].subject);
  await s.call("sectionCapture", { ...input, requestId: randomUUID(), title: "Another distinct claim" });
  expect(s.mutate.mock.calls.at(-1)![0].subject).not.toBe(mutations[0].subject);
});

test("save and accept is one guarded core operation; unknown refuses before proposing", async () => {
  const { s, input } = await captureSetup();
  await expect(
    s.call("sectionCapture", {
      ...input,
      mode: "accept",
      reason: "I adopt this rule",
      applicability: { ...applicability, environment: { mode: "unknown" } },
    }),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(s.entries.size).toBe(0);
  const result = await s.call("sectionCapture", {
    ...input,
    mode: "accept",
    kind: "directive",
    reason: "I adopt this rule",
  });
  expect(result).toMatchObject({ status: "saved", entry: { state: "approved", kind: "directive", actor } });
  expect(s.mutate.mock.calls.at(-1)![0]).toMatchObject({ op: "save-approved", actor, reason: "I adopt this rule" });
});

test.each([
  "manual",
  "message",
] as const)("human-selected Rule saved for review keeps unknown applicability and remains ineligible until explicit known-scope accept (%s)", async sourceKind => {
  const { s, input } = await captureSetup();
  const unknown = { environment: { mode: "unknown" as const }, host: { mode: "unknown" as const } };
  const source = sourceKind === "manual" ? { kind: "manual", threadId: s.thread.id } : input.source;
  const saved = await s.call("sectionCapture", { ...input, source, kind: "directive", applicability: unknown });
  expect(saved).toMatchObject({
    status: "saved",
    entry: {
      state: "candidate",
      approval: null,
      kind: "directive",
      applicability: unknown,
      sources: [{ authorType: sourceKind === "manual" ? "human" : "agent" }],
    },
  });
  expect((await s.call("sectionEligibility", { sectionId: "sec_one" })).entries).toEqual([]);
  const entry = saved.entry!;
  s.mutate.mockImplementation(async mutation => {
    const updated = {
      ...entry,
      state: "approved" as const,
      revision: 2,
      applicability: mutation.applicability,
      approval: { actor, at },
    };
    s.entries.set(updated.id, updated);
    return { outcome: "updated", entry: updated };
  });
  const accepted = await s.call("sectionCandidateAccept", {
    sectionId: "sec_one",
    expectedBindingRevision: 1,
    id: entry.id,
    expectedRevision: 1,
    applicability,
    reason: "I explicitly adopt this sourced Rule everywhere",
  });
  expect(accepted.entry).toMatchObject({
    id: entry.id,
    kind: "directive",
    state: "approved",
    sources: entry.sources,
    applicability,
  });
  expect((await s.call("sectionEligibility", { sectionId: "sec_one" })).entries).toHaveLength(1);
});

test("lost saved response resumes same id with verified original provenance, never creates another candidate", async () => {
  const { s, input } = await captureSetup();
  const save = s.mutate.getMockImplementation()!;
  s.mutate.mockImplementationOnce(async mutation => {
    await save(mutation);
    throw new Error("response lost");
  });
  expect(await s.call("sectionCapture", input)).toMatchObject({ status: "failed" });
  const writesBeforeRetry = s.mutate.mock.calls.length;
  expect(await s.call("sectionCaptureRetry", { requestId: input.requestId })).toMatchObject({ status: "saved" });
  expect(s.mutate).toHaveBeenCalledTimes(writesBeforeRetry);
  expect(s.entries.size).toBe(1);
});

test("candidate edit persists chosen kind and applicability, including unknown, with no source rewriting", async () => {
  const { s, connection } = await captureSetup();
  const entry = candidate("kn_editable", connection.workstreamId);
  s.entries.set(entry.id, entry);
  const target = { environment: { mode: "value", value: "staging" }, host: { mode: "unknown" } };
  s.mutate.mockImplementation(async input => ({
    outcome: "updated",
    entry: { ...entry, kind: input.kind, applicability: input.applicability, revision: 2 },
  }));
  await s.call("sectionCandidateEdit", {
    sectionId: "sec_one",
    expectedBindingRevision: 1,
    id: entry.id,
    expectedRevision: 1,
    title: "Keep this draft",
    kind: "directive",
    applicability: target,
    reason: "Save my chosen scope",
  });
  expect(s.mutate.mock.calls.at(-1)![0]).toEqual({
    op: "edit",
    actor,
    id: entry.id,
    expectedRevision: 1,
    title: "Keep this draft",
    kind: "directive",
    applicability: target,
    reason: "Save my chosen scope",
  });
});

test("candidate acceptance preserves id, source, expected revision and explicit replacement; edit refuses approved and foreign entries", async () => {
  const { s, input, connection } = await captureSetup();
  const entry = candidate("kn_candidate", connection.workstreamId);
  s.entries.set(entry.id, entry);
  s.mutate.mockImplementation(async mutation => ({
    outcome: "updated",
    entry: { ...entry, revision: 2, state: "approved", approval: { actor, at } },
  }));
  const accept = {
    sectionId: "sec_one",
    expectedBindingRevision: 1,
    id: entry.id,
    expectedRevision: 1,
    applicability,
    title: "Final title",
    text: "Final rule",
    kind: "directive",
    reason: "Adopt with this scope",
    supersede: { id: "kn_old", expectedRevision: 2 },
  };
  s.entries.set("kn_old", { ...candidate("kn_old", connection.workstreamId), revision: 2, state: "approved" });
  await s.call("sectionCandidateAccept", accept);
  expect(s.mutate.mock.calls.at(-1)![0]).toEqual({
    op: "accept",
    actor,
    id: entry.id,
    expectedRevision: 1,
    applicability,
    title: accept.title,
    text: accept.text,
    kind: "directive",
    reason: accept.reason,
    supersede: accept.supersede,
  });
  expect(entry.sources[0].excerpt).toBe("original quote");
  await expect(s.call("sectionCandidateAccept", { ...accept, expectedRevision: 2 })).rejects.toMatchObject({
    code: "conflict",
  });
  await expect(
    s.call("sectionCandidateAccept", { ...accept, applicability: { ...applicability, host: { mode: "unknown" } } }),
  ).rejects.toMatchObject({ code: "invalid" });
  s.entries.set(entry.id, { ...entry, workstreamId: "ws_foreign" });
  await expect(
    s.call("sectionCandidateEdit", {
      sectionId: "sec_one",
      expectedBindingRevision: 1,
      id: entry.id,
      expectedRevision: 1,
      title: "x",
      reason: "edit",
    }),
  ).rejects.toMatchObject({ code: "invalid" });
  s.entries.set(entry.id, { ...entry, state: "approved" });
  await expect(
    s.call("sectionCandidateEdit", {
      sectionId: "sec_one",
      expectedBindingRevision: 1,
      id: entry.id,
      expectedRevision: 1,
      title: "x",
      reason: "edit",
    }),
  ).rejects.toMatchObject({ code: "invalid" });
});

test("bounded pending capture recovery survives restart, verifies saved ids and never retargets after a binding change", async () => {
  const { s, input, connection } = await captureSetup();
  const save = s.mutate.getMockImplementation()!;
  s.mutate.mockImplementationOnce(async mutation => {
    await save(mutation);
    throw new Error("ambiguous CLI timeout");
  });
  const failed = await s.call("sectionCapture", input);
  expect(failed.status).toBe("failed");
  s.mutate.mockRejectedValueOnce(new Error("offline"));
  const secondRequest = randomUUID();
  await s.call("sectionCapture", { ...input, requestId: secondRequest, title: "Another pending note" });
  let reloaded = s.ws;
  const fresh = await s.harness.lifecycle.reload(async bb => {
    reloaded = createWorkstreams(bb, s.runner, { userAuthor: "you", widgetDefault: () => true });
    bb.rpc.register(sectionRpcContract, sectionHandlers(createSections(bb, reloaded)));
  });
  disposers.push(() => fresh.harness.lifecycle.dispose());
  const call = <K extends keyof typeof sectionRpcContract>(method: K, input: unknown) =>
    fresh.harness.behavior.callRpc(method, input) as Promise<z.infer<(typeof sectionRpcContract)[K]["output"]>>;
  const page = await call("sectionCaptureJobs", { sectionId: "sec_one", limit: 1, offset: 0 });
  expect(page).toMatchObject({
    total: 2,
    limit: 1,
    offset: 0,
    jobs: [
      {
        requestId: input.requestId,
        knowledgeId: failed.intendedKnowledgeId,
        workstreamId: connection.workstreamId,
        expectedBindingRevision: 1,
        intent: { title: input.title },
        entry: { id: failed.intendedKnowledgeId },
      },
    ],
  });
  expect(s.reads.filter(a => a[1] === "entry").every(a => a[2] === failed.intendedKnowledgeId)).toBe(true);
  expect((await call("sectionCaptureJobs", { sectionId: "sec_one", limit: 1, offset: 1 })).jobs[0].requestId).toBe(
    secondRequest,
  );
  reloaded.store.setSection("sec_one", 1, {
    workstreamId: "ws_elsewhere",
    topic: null,
    budgetTokens: 1000,
    requiredKnowledgeIds: [],
  });
  const writes = s.mutate.mock.calls.length;
  const retried = await call("sectionCaptureRetry", { requestId: input.requestId });
  expect(retried).toMatchObject({
    status: "failed",
    knowledgeId: failed.intendedKnowledgeId,
    error: expect.stringMatching(/binding revision conflict/i),
  });
  expect(s.mutate).toHaveBeenCalledTimes(writes);
  await call("sectionCaptureDismiss", { sectionId: "sec_one", requestId: input.requestId });
  expect((await call("sectionCaptureJobs", { sectionId: "sec_one" })).total).toBe(1);
  expect(s.entries.size).toBe(1);
});

test("capture job recovery is strict, bounded, human-policy and cannot expose or dismiss a foreign section job", async () => {
  const { s, input } = await captureSetup();
  s.mutate.mockRejectedValueOnce(new Error("offline"));
  await s.call("sectionCapture", input);
  await expect(s.call("sectionCaptureJobs", { sectionId: "sec_one", limit: 51 })).rejects.toMatchObject({
    code: "invalid_input",
  });
  s.harness.sdk.stub("threadSections.list", async () => [
    { id: "sec_one", name: "Envoy", createdAt: 0, updatedAt: 0 },
    { id: "sec_foreign", name: "Foreign", createdAt: 0, updatedAt: 0 },
  ]);
  const readsBefore = s.reads.length;
  expect(await s.call("sectionCaptureJobs", { sectionId: "sec_foreign" })).toMatchObject({ jobs: [], total: 0 });
  expect(s.reads.length).toBe(readsBefore);
  await expect(
    s.call("sectionCaptureDismiss", { sectionId: "sec_foreign", requestId: input.requestId }),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    s.harness.behavior.callRpc(
      "sectionCaptureJobs",
      { sectionId: "sec_one" },
      { experimental_caller: { kind: "plugin", pluginId: "agent" } },
    ),
  ).rejects.toMatchObject({ code: "forbidden" });
  const page = await s.call("sectionCaptureJobs", { sectionId: "sec_one", offset: 1 });
  expect(page).toMatchObject({ jobs: [], total: 1, limit: 20, offset: 1 });
});

test("section review rejects foreign workstream metadata even when the entry id is in scope", async () => {
  const { s, connection } = await captureSetup();
  const run = s.runner.run;
  const workstream = s.workstreams.get(connection.workstreamId)!;
  s.runner.run = async (args, schema, options) => {
    if (args[1] === "knowledge")
      return schema.parse({
        items: [
          { entry: candidate("kn_review", workstream.id), workstream: { ...workstream, id: "ws_foreign" }, hints: [] },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      });
    return run(args, schema, options);
  };
  await expect(s.call("sectionDetail", { sectionId: "sec_one" })).rejects.toMatchObject({ code: "invalid" });
});

test("capture recovery never exposes a collided foreign row or proposes a replacement id", async () => {
  const { s, input, connection } = await captureSetup();
  s.mutate.mockImplementationOnce(async mutation => {
    s.entries.set(mutation.id, {
      ...candidate(mutation.id, connection.workstreamId),
      subject: mutation.subject,
      title: mutation.title,
      text: mutation.text,
      sources: mutation.sources,
      actor: { id: "foreign-author", type: "agent" },
    });
    throw new Error("409 occupied ID conflict");
  });
  const result = await s.call("sectionCapture", input);
  expect(result).toMatchObject({ status: "failed", entry: null, knowledgeId: null });
  const page = await s.call("sectionCaptureJobs", { sectionId: "sec_one" });
  expect(page.jobs[0]).toMatchObject({ entry: null, knowledgeId: null, error: expect.stringMatching(/provenance/i) });
  const count = s.mutate.mock.calls.length;
  expect(await s.call("sectionCaptureRetry", { requestId: input.requestId })).toMatchObject({
    status: "failed",
    entry: null,
  });
  expect(s.mutate).toHaveBeenCalledTimes(count);
  expect(s.entries.size).toBe(1);
});

test.each([
  ["Use Filter A", "use filter a"],
  ["Café Filter", "Cafe\u0301 Filter"],
  ["ＡＢＣ\u00a0ＦＩＬＴＥＲ", "abc filter"],
])("normalized canonical no-save persists its returned id: %s / %s", async (original, repeat) => {
  const { s, input } = await captureSetup();
  const first = await s.call("sectionCapture", { ...input, text: original });
  s.mutate.mockImplementationOnce(async () => ({ outcome: "no-save", entry: first.entry }));
  const requestId = randomUUID();
  const second = await s.call("sectionCapture", { ...input, requestId, text: repeat });
  expect(second).toMatchObject({ status: "no-save", knowledgeId: first.knowledgeId, error: null });
  expect(s.ws.store.jobs.get(requestId)).toMatchObject({
    canonicalId: first.knowledgeId,
    status: "no-save",
    input: null,
  });
  expect(s.entries.size).toBe(1);
});

test.each([
  "strict fact",
  "Strict  Fact",
  "Ｓｔｒｉｃｔ Ｆａｃｔ",
  "Different payload",
])("occupied intended-id recovery requires exact text, not normalized similarity: %s", async changed => {
  const { s, input } = await captureSetup();
  const save = s.mutate.getMockImplementation()!;
  s.mutate.mockImplementationOnce(async mutation => {
    await save({ ...mutation, text: changed });
    throw new Error("409 occupied ID conflict");
  });
  const requestId = randomUUID();
  const result = await s.call("sectionCapture", { ...input, requestId, text: "Strict Fact" });
  expect(result).toMatchObject({ status: "failed", knowledgeId: null, entry: null });
  const count = s.mutate.mock.calls.length;
  expect(await s.call("sectionCaptureRetry", { requestId })).toMatchObject({ status: "failed", entry: null });
  expect(s.mutate).toHaveBeenCalledTimes(count);
});

test("normalized no-save still verifies scope, applicability and original source evidence", async () => {
  const { s, input } = await captureSetup();
  const first = await s.call("sectionCapture", input);
  for (const change of [
    { workstreamId: "ws_other" },
    { applicability: { ...applicability, host: { mode: "unknown" } } },
    { sources: [] },
  ]) {
    s.mutate.mockImplementationOnce(async () => ({ outcome: "no-save", entry: { ...first.entry, ...change } }));
    expect(await s.call("sectionCapture", { ...input, requestId: randomUUID() })).toMatchObject({
      status: "failed",
      entry: null,
      knowledgeId: null,
    });
  }
});

test.each([
  8192, 8193, 9000,
])("source evidence boundary is checked before creating a job for whole messages and selections: %i", async length => {
  for (const selected of [false, true]) {
    const { s, input } = await captureSetup();
    s.message.text = "x".repeat(length);
    const requestId = randomUUID();
    const source = { ...input.source, quote: selected ? s.message.text : undefined };
    const writes = s.mutate.mock.calls.length;
    if (length === 8192) {
      const result = await s.call("sectionCapture", { ...input, requestId, source });
      expect(result).toMatchObject({ status: "saved", entry: { sources: [{ excerpt: s.message.text }] } });
    } else {
      await expect(s.call("sectionCapture", { ...input, requestId, source })).rejects.toMatchObject(
        selected
          ? {
              code: "invalid_input",
              issues: [{ message: expect.stringMatching(/8192|8,192/), path: ["source", "quote"] }],
            }
          : { code: "invalid", message: expect.stringMatching(/8192|8,192/) },
      );
      expect(s.ws.store.jobs.get(requestId)).toBeNull();
      expect(s.mutate).toHaveBeenCalledTimes(writes);
      expect(s.entries.size).toBe(0);
    }
  }
});

test.each([
  ["whole-overlimit", "quote"],
  ["unverified-quote", "quote"],
  ["thread-scope", "threadId"],
  ["message-id", "messageId"],
  ["message-sequence", "messageSeq"],
  ["message-thread", "threadId"],
  ["manual-thread", "threadId"],
])("fresh capture source refusal is actionable and definitive before persistence: %s", async (scenario, field) => {
  const { s, input } = await captureSetup();
  let source: Record<string, unknown> = { ...input.source };
  if (scenario === "whole-overlimit") {
    s.message.text = "x".repeat(9000);
    delete source.quote;
  }
  if (scenario === "unverified-quote") source.quote = "not present in raw message";
  if (scenario === "thread-scope" || scenario === "manual-thread") s.thread.sectionId = "sec_other";
  if (scenario === "message-id") source.messageId = "msg_other";
  if (scenario === "message-sequence") source.messageSeq = 15;
  if (scenario === "message-thread") s.message.threadId = "thr_bbbbbbbb";
  if (scenario === "manual-thread") source = { kind: "manual", threadId: s.thread.id };
  const writes = s.mutate.mock.calls.length;
  const error = await s.call("sectionCapture", { ...input, source }).then(
    () => null,
    e => e,
  );
  expect(error).toMatchObject({
    code: "invalid",
    message: expect.any(String),
    issues: [{ path: ["source", field], message: error.message }],
  });
  expect(s.ws.store.jobs.get(input.requestId)).toBeNull();
  expect(s.mutate).toHaveBeenCalledTimes(writes);
  expect(s.entries.size).toBe(0);
});

test("ordinary source transport failures remain generic invalid without a no-job issue", async () => {
  const { s, input } = await captureSetup();
  s.harness.sdk.stub("threads.message", async () => {
    throw new Error("ordinary source transport failure");
  });
  const error = await s.call("sectionCapture", input).then(
    () => null,
    e => e,
  );
  expect(error).toMatchObject({ code: "invalid", message: "ordinary source transport failure" });
  expect(error.issues ?? []).toEqual([]);
});

test("a persisted uncertain capture never emits a no-job source issue on retry", async () => {
  const { s, input } = await captureSetup();
  s.mutate.mockImplementationOnce(async () => {
    throw new Error("ambiguous CLI timeout");
  });
  expect(await s.call("sectionCapture", input)).toMatchObject({ status: "failed" });
  const original = s.ws.store.jobs.get(input.requestId)!;
  if (original.kind !== "capture") throw new Error("Expected a capture job");
  s.message.text = "The source was edited after the uncertain write.";
  const result = await s.call("sectionCaptureRetry", { requestId: input.requestId });
  expect(result).toMatchObject({
    status: "failed",
    knowledgeId: null,
    entry: null,
    error: expect.stringMatching(/quote cannot be verified/),
  });
  expect(result).not.toHaveProperty("issues");
  expect(s.ws.store.jobs.get(input.requestId)).toMatchObject({
    fingerprint: original.fingerprint,
    input: original.input,
    intendedId: original.intendedId,
    workstreamId: original.workstreamId,
    attempted: true,
  });
});

test("a job appearing during source preflight prevents a definitive no-job issue", async () => {
  const { s, input } = await captureSetup();
  s.mutate.mockImplementationOnce(async () => {
    throw new Error("ambiguous CLI timeout");
  });
  expect(await s.call("sectionCapture", input)).toMatchObject({ status: "failed" });
  const original = s.ws.store.jobs.get(input.requestId)!;
  if (original.kind !== "capture") throw new Error("Expected a capture job");
  const requestId = randomUUID();
  s.harness.sdk.stub("threads.message", async () => {
    s.ws.store.jobs.put({
      ...original,
      requestId,
      input: sectionRpcContract.sectionCapture.input.parse({ ...input, requestId }),
    });
    return { message: { ...s.message, text: "source no longer matches quote" }, before: [], after: [] } as any;
  });
  const error = await s.call("sectionCapture", { ...input, requestId }).then(
    () => null,
    e => e,
  );
  expect(error).toMatchObject({ code: "invalid" });
  expect(error.issues ?? []).toEqual([]);
  expect(s.ws.store.jobs.get(requestId)).toMatchObject({
    attempted: true,
    intendedId: original.intendedId,
    status: "failed",
  });
});

test("later invalid_input does not erase or retarget an earlier uncertain job and its saved result", async () => {
  const { s, input } = await captureSetup();
  const save = s.mutate.getMockImplementation()!;
  s.mutate.mockImplementationOnce(async mutation => {
    await save(mutation);
    throw new Error("ambiguous CLI timeout");
  });
  expect(await s.call("sectionCapture", input)).toMatchObject({ status: "failed", knowledgeId: null });
  const original = s.ws.store.jobs.get(input.requestId)!;
  if (original.kind !== "capture") throw new Error("Expected a capture job");
  const writes = s.mutate.mock.calls.length;
  await expect(
    s.call("sectionCapture", { ...input, source: { ...input.source, quote: "x".repeat(9000) } }),
  ).rejects.toMatchObject({ code: "invalid_input", issues: [{ path: ["source", "quote"] }] });
  expect(s.ws.store.jobs.get(input.requestId)).toEqual(original);
  const recovered = await s.call("sectionCaptureRetry", { requestId: input.requestId });
  expect(recovered).toMatchObject({
    status: "saved",
    knowledgeId: original.intendedId,
    entry: {
      id: original.intendedId,
      workstreamId: original.workstreamId,
      text: input.text,
      sources: [{ excerpt: input.source.quote }],
    },
  });
  expect(s.mutate).toHaveBeenCalledTimes(writes);
  expect(s.entries.size).toBe(1);
});

test("manual text is not an implicitly imported long message excerpt", async () => {
  const { s, input } = await captureSetup();
  const text = "m".repeat(9000);
  const result = await s.call("sectionCapture", { ...input, text, source: { kind: "manual", threadId: s.thread.id } });
  expect(result).toMatchObject({ status: "saved", entry: { text } });
  expect(
    result.entry?.sources.every(source => source.excerpt === undefined && source.ref.startsWith("bb:manual:")),
  ).toBe(true);
});

test("request id reuse with changed intent refuses and native/plugin callers cannot connect", async () => {
  const s = setup();
  await s.call("sectionConnect", s.connect);
  await expect(
    s.call("sectionConnect", { ...s.connect, choice: { kind: "create", name: "Other" } }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    s.harness.behavior.callRpc(
      "sectionConnectRetry",
      { requestId: s.connect.requestId },
      { experimental_caller: { kind: "plugin", pluginId: "agent" } },
    ),
  ).rejects.toMatchObject({ code: "forbidden" });
});
