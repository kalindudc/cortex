import { randomUUID } from "node:crypto";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, test, vi } from "vitest";
import type { CortexRunner } from "./cli";
import { createPendingContext, PENDING_MENTION_CONTEXT, PENDING_UNKNOWN, pendingHandlers } from "./pending-context";
import {
  PENDING_MENTION_PROVIDER,
  PENDING_TTL_MS,
  type PendingChange,
  type PendingSelection,
  pendingContextRpcContract,
} from "./pending-context-contract";
import { createSections } from "./sections";
import { registerWorkstreamAgents } from "./workstream-agents";
import type { Knowledge, Workstream } from "./workstream-contract";
import { createWorkstreams } from "./workstreams";

test("preview exposes required ids and section sizes; refusal records bb's actual placement", async () => {
  const s = setup();
  s.ws.store.setSection("sec_one", 1, { ...binding, requiredKnowledgeIds: ["kn_ports"] });
  const view = await s.call("newThreadContext", { projectId: "project-1", sectionId: "sec_one", pendingId: null }) as any;
  expect(view.section.requiredKnowledgeIds).toEqual(["kn_ports"]);
  expect(view.sectionSummaries).toEqual(expect.arrayContaining([expect.objectContaining({ sectionId: "sec_one", entries: 2, estimatedTokens: expect.any(Number) })]));
  const created = await s.set([{ knowledgeId: "kn_deploy", canonicalRevision: 1, excluded: true, text: null }], { expectedBindingRevision: 2 });
  await s.dispatch(T3, [s.pill(created!.id)]);
  expect(s.ws.store.pending.get(created!.id)?.refusedPlacement).toMatchObject({ sectionId: "sec_two", at: expect.any(String) });
});

const at = "2026-01-01T00:00:00.000Z";
const actor = { id: "you", type: "human" as const };
const applicability = { environment: { mode: "not-applicable" as const }, host: { mode: "not-applicable" as const } };
const binding = { workstreamId: "ws_envoy", topic: null, budgetTokens: 2000, requiredKnowledgeIds: [], applicability };
const workstream: Workstream = {
  id: "ws_envoy",
  name: "Envoy cluster-service",
  description: "",
  revision: 1,
  archived: false,
  actor,
  createdAt: at,
  updatedAt: at,
};
const knowledge = (id: string, title: string): Knowledge => ({
  id,
  workstreamId: "ws_envoy",
  subject: id,
  title,
  text: `${title}: the saved wording.`,
  kind: "directive",
  state: "approved",
  facet: "orientation",
  applicability,
  sources: [{ ref: "manual", authorType: "human", observedAt: at }],
  revision: 1,
  actor,
  createdAt: at,
  updatedAt: at,
  expiresAt: null,
  approval: { actor, at },
  supersedes: [],
  supersededBy: null,
  conflicts: [],
});
type ThreadResponse = ReturnType<typeof makeThreadResponse>;
const T1 = "thr_aaaaaaaa",
  T2 = "thr_bbbbbbbb",
  T3 = "thr_cccccccc";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of disposers.splice(0)) await dispose();
});

function setup() {
  const entries = new Map([
    ["kn_ports", knowledge("kn_ports", "Admin port is 9901")],
    ["kn_deploy", knowledge("kn_deploy", "Deploy through the pipeline")],
  ]);
  const reads: string[] = [];
  const runner: CortexRunner = {
    binary: "fake",
    async run(args, schema) {
      if (args[1] === "read") {
        reads.push(args[2]!);
        return schema.parse({ workstream, entries: [...entries.values()], notices: [], applicability, topic: null });
      }
      if (args[1] === "show") return schema.parse({ workstream, entries: [], total: 0, limit: 1, offset: 0 });
      throw new Error(`Unexpected CLI ${args.join(" ")}`);
    },
    async text() {
      throw new Error("No legacy fallback");
    },
  };
  const threads = new Map<string, ThreadResponse>([
    [T1, makeThreadResponse({ id: T1, projectId: "project-1", sectionId: "sec_one", status: "pending" })],
    [T2, makeThreadResponse({ id: T2, projectId: "project-1", sectionId: "sec_one", status: "pending" })],
    [T3, makeThreadResponse({ id: T3, projectId: "project-1", sectionId: "sec_two", status: "pending" })],
  ]);
  const host = createFakePluginHost({
    pluginId: "cortex",
    sdk: {
      subscribe: () => () => undefined,
      threadSections: {
        list: async () => [
          { id: "sec_one", name: "Envoy", createdAt: 0, updatedAt: 0 },
          { id: "sec_two", name: "OTLP", createdAt: 0, updatedAt: 0 },
        ],
      },
      threads: { get: async ({ threadId }) => threads.get(threadId)!, list: async () => [...threads.values()] },
    },
  });
  disposers.push(() => host.harness.lifecycle.dispose());
  const ws = createWorkstreams(host.bb, runner, { userAuthor: "you", widgetDefault: () => true });
  const sections = createSections(host.bb, ws);
  ws.store.setSection("sec_one", 0, binding);
  ws.store.setSection("sec_two", 0, binding);
  const memory = {
    mode: "write" as const,
    summary: { cached: true, ids: [12], chars: 80, shortened: false },
    lookup: { maxTasks: 5, providers: ["pi"] },
  };
  const memoryCalls: Array<[string | null, string | null]> = [];
  const pending = createPendingContext(host.bb, ws, sections, {
    memory: (projectId, scoped) => {
      memoryCalls.push([projectId, scoped]);
      return memory;
    },
  });
  registerWorkstreamAgents(host.bb, ws, undefined, pending);
  host.bb.rpc.register(pendingContextRpcContract, pendingHandlers(pending));
  const hook = host.harness.inspection.registrations.hooks["message.dispatch"]!;
  const call = (method: string, input: unknown, caller?: { kind: "plugin"; pluginId: string }) =>
    host.harness.behavior.callRpc(method, input, caller ? { experimental_caller: caller } : undefined);
  const set = async (changes: PendingChange[], extra: Record<string, unknown> = {}) =>
    ((await call("pendingContextSet", {
      pendingId: null,
      projectId: "project-1",
      sectionId: "sec_one",
      expectedBindingRevision: 1,
      draftKey: "draft-root",
      changes,
      ...extra,
    })) as { pending: PendingSelection | null }).pending;
  const pill = (id: string, pluginId = "cortex", provider = PENDING_MENTION_PROVIDER) => ({
    start: 0,
    end: 7,
    resource: { kind: "plugin" as const, pluginId, itemId: `${provider}:${id}`, label: "Cortex: 1 change" },
  });
  const dispatch = (
    threadId: string,
    mentions: ReturnType<typeof pill>[],
    overrides: Partial<Pick<MessageDispatchHookContext, "origin" | "attempt" | "senderThreadId" | "initiator">> & {
      status?: ThreadResponse["status"];
    } = {},
  ) => {
    const { status, ...rest } = overrides;
    return hook(
      makeMessageDispatchHookContext({
        thread: { ...threads.get(threadId)!, ...(status ? { status } : {}) },
        project: { id: "project-1" },
        origin: "app",
        input: { blocks: [{ type: "text", text: "Cortex look at the ports", mentions }], text: "Cortex look at the ports" },
        ...rest,
      }),
    );
  };
  const context = (threadId: string, mentions: ReturnType<typeof pill>[]) =>
    makeMessageDispatchHookContext({
      thread: threads.get(threadId)!,
      project: { id: "project-1" },
      origin: "app",
      input: { blocks: [{ type: "text", text: "Cortex", mentions }], text: "Cortex" },
    });
  return { ...host, ws, entries, reads, set, call, pill, dispatch, threads, memory, memoryCalls, pending, context };
}

const leaveOut: PendingChange = { knowledgeId: "kn_deploy", canonicalRevision: 1, excluded: true, text: null };
const edit: PendingChange = { knowledgeId: "kn_ports", canonicalRevision: 1, excluded: false, text: "Admin port is 9902 here." };

test("a pending selection is created, updated in place and removed by a reset", async () => {
  const s = setup();
  const created = await s.set([leaveOut]);
  expect(created).toMatchObject({
    sectionId: "sec_one",
    workstreamId: "ws_envoy",
    bindingRevision: 1,
    projectId: "project-1",
    draftKey: "draft-root",
    actor,
    caller: "client",
    singleUse: true,
    usedBy: null,
    changes: [leaveOut],
  });
  expect(Date.parse(created!.expiresAt) - Date.parse(created!.updatedAt)).toBe(PENDING_TTL_MS);
  const updated = await s.set([leaveOut, edit], { pendingId: created!.id });
  expect(updated).toMatchObject({ id: created!.id, createdAt: created!.createdAt, changes: [leaveOut, edit] });
  expect(await s.set([], { pendingId: created!.id })).toBeNull();
  expect(s.ws.store.pending.get(created!.id)).toBeNull();
  const view = (await s.call("newThreadContext", {
    projectId: "project-1",
    sectionId: "sec_one",
    pendingId: created!.id,
  })) as { pendingProblem: string | null };
  expect(view.pendingProblem).toBe(PENDING_UNKNOWN);
});

test("the preview shows the brief with this draft's changes applied, beside the shared brief", async () => {
  const s = setup();
  const created = await s.set([leaveOut, edit]);
  const view = (await s.call("newThreadContext", {
    projectId: "project-1",
    sectionId: "sec_one",
    pendingId: created!.id,
  })) as any;
  expect(view.section).toEqual({
    id: "sec_one",
    requiredKnowledgeIds: [],
    bindingRevision: 1,
    binding: { workstreamId: "ws_envoy", workstreamName: "Envoy cluster-service", topic: null },
  });
  expect(view.base.entries.map((e: any) => e.knowledge.id)).toEqual(["kn_deploy", "kn_ports"]);
  expect(view.applied.entries.map((e: any) => [e.knowledge.id, e.text, e.origin])).toEqual([
    ["kn_ports", "Admin port is 9902 here.", "thread-only"],
  ]);
  expect(view.applied.exclusions).toContainEqual({ id: "kn_deploy", reason: "left out of this thread" });
  expect(view.pendingProblem).toBeNull();
  expect(view.memory).toEqual(s.memory);
  expect(s.memoryCalls.at(-1)?.[1]).toContain("Admin port is 9902 here.");
  expect(s.memoryCalls.at(-1)?.[1]).not.toContain("Deploy through the pipeline");
});

test("no section chosen previews ordinary memory and section-menu sizes", async () => {
  const s = setup();
  const view = (await s.call("newThreadContext", { projectId: "project-1", sectionId: null, pendingId: null })) as any;
  expect(view).toMatchObject({ section: null, base: null, applied: null, pending: null, pendingProblem: null });
  expect(view.sectionSummaries).toHaveLength(2);
  expect(s.reads).toEqual(["ws_envoy", "ws_envoy"]);
});

test("a section with sharing off previews nothing shared and refuses changes", async () => {
  const s = setup();
  s.ws.store.setSection("sec_two", 1, null);
  const view = (await s.call("newThreadContext", { projectId: "project-1", sectionId: "sec_two", pendingId: null })) as any;
  expect(view.section.binding).toBeNull();
  expect(view.base.status).toBe("unbound");
  await expect(s.set([leaveOut], { sectionId: "sec_two", expectedBindingRevision: 2 })).rejects.toThrow(
    /Nothing is shared in this section/,
  );
});

test.each([
  ["another plugin", {}, { kind: "plugin" as const, pluginId: "other" }, /Use the Cortex card/],
  ["a stale section revision", { expectedBindingRevision: 2 }, undefined, /Sharing in this section changed/],
  [
    "knowledge outside the brief",
    { changes: [{ ...leaveOut, knowledgeId: "kn_unknown" }] },
    undefined,
    /not in the brief/,
  ],
  ["a stale knowledge revision", { changes: [{ ...leaveOut, canonicalRevision: 3 }] }, undefined, /changed since/],
  ["two changes to one entry", { changes: [leaveOut, { ...edit, knowledgeId: "kn_deploy" }] }, undefined, /only one change/],
])("set refuses %s", async (_name, extra, caller, message) => {
  const s = setup();
  const input = {
    pendingId: null,
    projectId: "project-1",
    sectionId: "sec_one",
    expectedBindingRevision: 1,
    draftKey: "draft-root",
    changes: [leaveOut],
    ...extra,
  };
  await expect(s.call("pendingContextSet", input, caller)).rejects.toThrow(message);
});

test("a change that both leaves out and edits, or does neither, is invalid", async () => {
  const s = setup();
  await expect(s.set([{ ...leaveOut, text: "both" }])).rejects.toThrow();
  await expect(s.set([{ ...edit, text: null }])).rejects.toThrow();
});

test("another draft cannot change a selection", async () => {
  const s = setup();
  const created = await s.set([leaveOut]);
  await expect(s.set([edit], { pendingId: created!.id, draftKey: "draft-other" })).rejects.toThrow(/another draft/);
  expect(s.ws.store.pending.get(created!.id)?.changes).toEqual([leaveOut]);
});

test("a first message without the pill behaves as today and writes no overrides", async () => {
  const s = setup();
  await s.set([leaveOut]);
  expect(await s.dispatch(T1, [])).toEqual({ action: "proceed" });
  expect(s.ws.store.thread(T1)).toMatchObject({ revision: 0, overrides: [] });
  expect(s.ws.peek(T1)?.entries.map(e => e.knowledge.id)).toEqual(["kn_deploy", "kn_ports"]);
});

test("the first message with the pill writes the changes as the thread's overrides once, before its context", async () => {
  const s = setup();
  const created = await s.set([leaveOut, edit]);
  expect(await s.dispatch(T1, [s.pill(created!.id)])).toEqual({ action: "proceed" });
  const prefs = s.ws.store.thread(T1);
  expect(prefs.revision).toBe(2);
  expect(prefs.overrides.map(o => [o.knowledgeId, o.excluded, o.text, o.actor])).toEqual([
    ["kn_deploy", true, null, actor],
    ["kn_ports", false, "Admin port is 9902 here.", actor],
  ]);
  const prepared = s.ws.peek(T1)!;
  expect(prepared.entries.map(e => [e.knowledge.id, e.text])).toEqual([["kn_ports", "Admin port is 9902 here."]]);
  expect(prepared.exactText).not.toContain("Deploy through the pipeline");
  expect(s.ws.store.pending.get(created!.id)).toMatchObject({ usedBy: T1 });
  // A retry of the failed turn and a drained queued attempt on the same thread change nothing.
  expect(await s.dispatch(T1, [s.pill(created!.id)], { status: "error", origin: null })).toEqual({
    action: "proceed",
  });
  expect(await s.dispatch(T1, [s.pill(created!.id)])).toEqual({ action: "proceed" });
  expect(s.ws.store.thread(T1).revision).toBe(2);
});

test("concurrent attempts on one thread write the overrides exactly once", async () => {
  const s = setup();
  const created = await s.set([leaveOut]);
  const attempt = () => s.pending.admit(s.context(T1, [s.pill(created!.id)]));
  expect(await Promise.all([attempt(), attempt(), attempt()])).toEqual([null, null, null]);
  expect(s.ws.store.thread(T1)).toMatchObject({ revision: 1 });
  expect(s.ws.store.thread(T1).overrides).toHaveLength(1);
  expect(await s.dispatch(T1, [s.pill(created!.id)])).toEqual({ action: "proceed" });
  expect(s.ws.store.thread(T1).revision).toBe(1);
});

test("a used selection is single use: another thread with the same pill is refused", async () => {
  const s = setup();
  const created = await s.set([leaveOut]);
  await s.dispatch(T1, [s.pill(created!.id)]);
  const decision = await s.dispatch(T2, [s.pill(created!.id)]);
  expect(decision).toMatchObject({ action: "reject", message: expect.stringMatching(/already used by another thread/) });
  expect(s.ws.store.thread(T2).overrides).toEqual([]);
});

test("a thread deleted after its first dispatch was refused releases its selection for the restored draft", async () => {
  const s = setup();
  const created = await s.set([leaveOut]);
  await s.dispatch(T1, [s.pill(created!.id)]);
  await s.harness.behavior.emitThreadEvent("thread.deleted", { thread: s.threads.get(T1)! } as never);
  expect(s.ws.store.pending.get(created!.id)?.usedBy).toBeNull();
  expect(await s.dispatch(T2, [s.pill(created!.id)])).toEqual({ action: "proceed" });
  expect(s.ws.store.thread(T2).overrides).toHaveLength(1);
});

test("an expired selection is refused and changes nothing", async () => {
  const s = setup();
  const created = await s.set([leaveOut]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + PENDING_TTL_MS + 1);
  expect(await s.dispatch(T1, [s.pill(created!.id)])).toMatchObject({
    action: "reject",
    message: expect.stringMatching(/expired/),
  });
  expect(s.ws.store.thread(T1).overrides).toEqual([]);
});

test("a thread bb files in another section is refused, leaving the selection unused", async () => {
  const s = setup();
  const created = await s.set([leaveOut]);
  expect(await s.dispatch(T3, [s.pill(created!.id)])).toMatchObject({
    action: "reject",
    message: expect.stringMatching(/different section/),
  });
  expect(s.ws.store.pending.get(created!.id)?.usedBy).toBeNull();
  expect(s.ws.store.thread(T3).overrides).toEqual([]);
});

test("a changed section binding or knowledge revision refuses the send", async () => {
  const s = setup();
  const created = await s.set([leaveOut]);
  s.ws.store.setSection("sec_one", 1, { ...binding, budgetTokens: 1500 });
  expect(await s.dispatch(T1, [s.pill(created!.id)])).toMatchObject({
    action: "reject",
    message: expect.stringMatching(/Sharing in this section changed/),
  });
  const again = setup();
  const second = await again.set([leaveOut]);
  again.entries.set("kn_deploy", { ...again.entries.get("kn_deploy")!, revision: 2 });
  expect(await again.dispatch(T1, [again.pill(second!.id)])).toMatchObject({
    action: "reject",
    message: expect.stringMatching(/edited or withdrawn/),
  });
  expect(again.ws.store.thread(T1).overrides).toEqual([]);
});

test("a forged pill confers nothing", async () => {
  const s = setup();
  for (const id of [randomUUID(), "not-a-uuid"])
    expect(await s.dispatch(T1, [s.pill(id)])).toEqual({ action: "reject", message: PENDING_UNKNOWN });
  expect(s.ws.store.thread(T1).overrides).toEqual([]);
  // Another plugin's mention, even with Cortex's provider name, is not Cortex's pill.
  const created = await s.set([leaveOut]);
  expect(await s.dispatch(T1, [s.pill(created!.id, "impostor")])).toEqual({ action: "proceed" });
  expect(s.ws.store.thread(T1).overrides).toEqual([]);
  expect(await s.dispatch(T1, [s.pill(created!.id), s.pill(randomUUID())])).toMatchObject({
    action: "reject",
    message: expect.stringMatching(/more than one Cortex pill/),
  });
});

test.each([
  ["a follow-up in a running thread", { status: "idle" as const }],
  ["a message that joins a running turn", { attempt: "join-turn" as const }],
  ["a CLI or SDK send", { origin: "cli" as const }],
  ["a plugin send", { origin: "plugin" as const }],
  ["an agent's send", { initiator: "agent" as const, senderThreadId: T2 }],
])("a pill copied into %s confers nothing", async (_name, overrides) => {
  const s = setup();
  const created = await s.set([leaveOut]);
  expect(await s.dispatch(T1, [s.pill(created!.id)], overrides)).toMatchObject({
    action: "reject",
    message: expect.stringMatching(/apply only to the first message/),
  });
  expect(s.ws.store.thread(T1).overrides).toEqual([]);
  expect(s.ws.store.pending.get(created!.id)?.usedBy).toBeNull();
});

test("the pill resolves to a benign reference, never the context text", async () => {
  const s = setup();
  const created = await s.set([edit]);
  const provider = s.harness.inspection.registrations.mentionProviders.find(p => p.id === PENDING_MENTION_PROVIDER)!;
  expect(await provider.search({ trigger: "@", query: "", projectId: "project-1", threadId: null })).toEqual([]);
  const resolved = await provider.resolve(created!.id);
  expect(resolved).toEqual({ context: PENDING_MENTION_CONTEXT });
  expect(resolved.context).not.toContain("9902");
});
