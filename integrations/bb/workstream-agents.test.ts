import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CortexRunner } from "./cli";
import { createWorkstreams, PREPARATION_MAX_AGE_MS } from "./workstreams";
import { registerWorkstreamAgents, workstreamConfiguration } from "./workstream-agents";
import { workstreamHandlers } from "./workstream-rpc";
import { workstreamRpcContract, type Knowledge, type WorkstreamBinding } from "./workstream-contract";

const T = "thr_aaaaaaaa",
  OTHER = "thr_bbbbbbbb",
  at = "2026-01-01T00:00:00.000Z";
const actor = { id: "you", type: "human" as const };
const w = {
  id: "ws_envoy",
  name: "Envoy",
  description: "",
  revision: 1,
  archived: false,
  createdAt: at,
  updatedAt: at,
  actor,
};
const applicability = { environment: { mode: "not-applicable" as const }, host: { mode: "not-applicable" as const } };
const entry: Knowledge = {
  id: "kn_one",
  workstreamId: w.id,
  subject: "auth",
  title: "Auth",
  text: "canonical finding",
  kind: "finding",
  state: "approved",
  facet: "orientation",
  applicability,
  sources: [{ ref: "bb:source", authorType: "agent", observedAt: at }],
  revision: 1,
  actor,
  createdAt: at,
  updatedAt: at,
  expiresAt: null,
  approval: { actor, at },
  supersedes: [],
  supersededBy: null,
  conflicts: [],
};
const binding: WorkstreamBinding = { workstreamId: w.id, topic: null, budgetTokens: 1000, requiredKnowledgeIds: [] };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
type Subscription = Parameters<BbPluginApi["sdk"]["subscribe"]>[0];
type ThreadChange = Parameters<Extract<Subscription, { event: "thread:changed" }>["callback"]>[0];

test("shared mutation and ordinary thread deletion signals are scoped, never blanket refresh", async () => {
  const s = setup();
  await s.harness.behavior.callRpc("knowledgePropose", {
    workstreamId: w.id,
    subject: "new",
    title: "new",
    text: "new",
    kind: "finding",
    facet: "orientation",
    applicability,
    sources: [],
  });
  expect(s.harness.realtimeSignals.filter(e => e.channel === "workstreams").map(e => e.payload)).toEqual([
    { workstreamId: w.id },
  ]);
  s.harness.realtimeSignals.length = 0;
  await s.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: OTHER }) });
  expect(s.harness.realtimeSignals.filter(e => e.channel === "workstreams").map(e => e.payload)).toEqual([
    { threadId: OTHER },
  ]);
});

function setup() {
  const subscriptions: Subscription[] = [];
  const mutations: Record<string, unknown>[] = [];
  let disputed = false;
  let thread = makeThreadResponse({ id: T, sectionId: "sec_envoy", environmentId: "env_test" });
  const runner: CortexRunner = {
    binary: "fake",
    async run(args, schema, options) {
      if (args[1] === "read")
        return schema.parse({
          workstream: w,
          entries: disputed ? [] : [entry],
          notices: disputed ? [{ id: entry.id, revision: 2, reason: "disputed", sources: [] }] : [],
          applicability,
          topic: null,
        });
      if (args[1] === "show") return schema.parse({ workstream: w, entries: [entry], total: 1, limit: 1, offset: 0 });
      if (args[1] === "entry")
        return schema.parse({ ...entry, id: args[2], workstreamId: args[2] === "kn_foreign" ? "ws_foreign" : w.id });
      if (args[1] === "mutate") {
        const input = JSON.parse(options!.input!);
        mutations.push(input);
        if (input.op === "conflict") disputed = true;
        return schema.parse({ outcome: "created", entry: { ...entry, state: "candidate", approval: null } });
      }
      throw new Error("No legacy CLI command is allowed");
    },
    async text() {
      throw new Error("No legacy text reads allowed");
    },
  };
  const host = createFakePluginHost({
    pluginId: "cortex",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          threadId === T
            ? thread
            : makeThreadResponse({ id: OTHER, sectionId: "sec_foreign", environmentId: "env_test" }),
      },
      environments: { get: async () => ({ id: "env_test", name: "sandbox", hostId: "host_test", path: "/sandbox" }) },
      subscribe: subscription => {
        subscriptions.push(subscription);
        return () => subscriptions.splice(subscriptions.indexOf(subscription), 1);
      },
    },
  });
  cleanups.push(() => host.harness.lifecycle.dispose());
  const service = createWorkstreams(host.bb, runner, { userAuthor: "you", widgetDefault: () => true });
  service.store.setSection("sec_envoy", 0, binding);
  service.store.setSection("sec_foreign", 0, { ...binding, workstreamId: "ws_foreign" });
  registerWorkstreamAgents(host.bb, service);
  host.bb.rpc.register(workstreamRpcContract, workstreamHandlers(service));
  const config = () =>
    makePluginAgentConfigurationContext({
      thread: { id: T, parentThreadId: thread.parentThreadId, sourceThreadId: thread.sourceThreadId },
      project: { id: thread.projectId },
      environment: { id: "env_test" },
      host: { id: "host_test" },
    });
  return {
    ...host,
    service,
    mutations,
    config,
    cold: () => {
      thread = makeThreadResponse({ ...thread, status: "pending", environmentId: null });
    },
    attach: (environmentId = "env_test") => {
      thread = makeThreadResponse({ ...thread, status: "starting", environmentId });
    },
    dispatch: (hostId: string | null = "host_test") =>
      host.harness.registrations.hooks["message.dispatch"]!(
        makeMessageDispatchHookContext({
          thread,
          project: { id: thread.projectId },
          environment: thread.environmentId ? { id: thread.environmentId } : null,
          host: hostId ? { id: hostId } : null,
          attempt: "start-turn",
        }),
      ),
    notifyThread: (event: ThreadChange) => {
      for (const subscription of subscriptions)
        if (subscription.event === "thread:changed") subscription.callback(event);
    },
    notifyEnvironment: (
      changes: Parameters<Extract<Subscription, { event: "environment:changed" }>["callback"]>[0]["changes"],
    ) => {
      for (const subscription of subscriptions)
        if (subscription.event === "environment:changed")
          subscription.callback({ type: "changed", entity: "environment", id: "env_test", changes });
    },
    notifyProject: (
      changes: Parameters<Extract<Subscription, { event: "project:changed" }>["callback"]>[0]["changes"],
    ) => {
      for (const subscription of subscriptions)
        if (subscription.event === "project:changed")
          subscription.callback({ type: "changed", entity: "project", id: thread.projectId, changes });
    },
    move: () => {
      thread = makeThreadResponse({ id: T, sectionId: "sec_foreign", environmentId: "env_test" });
    },
  };
}
const proposal = {
  subject: "new",
  title: "New",
  text: "new observation",
  facet: "orientation",
  applicability,
  sources: [],
};

describe("workstream agent and user boundaries", () => {
  test("cold normal dispatch survives initial environment attachment and advertises all four native tools", async () => {
    const s = setup();
    s.cold();
    expect(await s.dispatch()).toEqual({ action: "proceed" });
    s.attach();
    s.notifyThread({ type: "changed", entity: "thread", id: T, changes: ["environment-changed"] });
    const first = workstreamConfiguration(s.service, s.config(), "read");
    expect(first?.tools).toEqual([
      "cortex_update",
      "cortex_recall",
      "cortex_propose_knowledge",
      "cortex_report_correction",
    ]);
    expect(first?.instructions).toContain(entry.text);
    expect(workstreamConfiguration(s.service, s.config(), "read")).toEqual(first);
    expect(s.service.store.receipts(T, 50, 0).total).toBe(0);
  });
  test("admission status, provisioning output and workspace readiness do not erase a prepared start", async () => {
    const s = setup();
    s.cold();
    await s.dispatch();
    s.notifyThread({ type: "changed", entity: "thread", id: T, changes: ["status-changed"] });
    s.attach();
    s.notifyThread({ type: "changed", entity: "thread", id: T, changes: ["environment-changed"] });
    s.notifyThread({
      type: "changed",
      entity: "thread",
      id: T,
      changes: ["events-appended"],
      metadata: { eventTypes: ["system/thread-provisioning"] },
    });
    s.notifyEnvironment(["environment-created", "metadata-changed", "status-changed"]);
    s.notifyProject(["threads-changed"]);
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).toContain(entry.text);
  });
  test("warm dispatch survives non-scope status, queue and output notifications", async () => {
    const s = setup();
    await s.dispatch();
    const first = workstreamConfiguration(s.service, s.config(), "read");
    s.notifyThread({
      type: "changed",
      entity: "thread",
      id: T,
      changes: ["status-changed", "queue-changed", "events-appended", "read-state-changed"],
    });
    expect(workstreamConfiguration(s.service, s.config(), "read")).toEqual(first);
  });
  test("warm UI/composer context never authorizes unhooked configuration", async () => {
    const s = setup();
    await s.harness.behavior.callRpc("prepareThreadContext", { threadId: T });
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).not.toContain(entry.text);
    expect(workstreamConfiguration(s.service, s.config(), "read")?.tools).not.toContain("cortex_propose_knowledge");
  });
  test("cold admission without a public intended host cannot promote its first attachment", async () => {
    const s = setup();
    s.cold();
    await s.dispatch(null);
    s.attach();
    s.notifyThread({ type: "changed", entity: "thread", id: T, changes: ["environment-changed"] });
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).not.toContain(entry.text);
  });
  test("initial attachment to the wrong host is not approved by the cold admission", async () => {
    const s = setup();
    s.cold();
    await s.dispatch();
    s.attach();
    s.notifyThread({ type: "changed", entity: "thread", id: T, changes: ["environment-changed"] });
    const moved = makePluginAgentConfigurationContext({ ...s.config(), host: { id: "host_other" } });
    expect(workstreamConfiguration(s.service, moved, "read")?.instructions).not.toContain(entry.text);
  });
  test("created/composer preparations cannot authorize a cold Send-now bypass", async () => {
    const s = setup();
    s.cold();
    await s.service.context(T);
    s.attach();
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).not.toContain(entry.text);
    expect(workstreamConfiguration(s.service, s.config(), "read")?.tools).not.toContain("cortex_propose_knowledge");
  });
  test.each([
    "title-changed",
    "parent-changed",
  ] as const)("%s invalidates a cold dispatch before configure, including inherited children", async change => {
    const s = setup();
    s.cold();
    await s.dispatch();
    s.attach();
    s.notifyThread({ type: "changed", entity: "thread", id: OTHER, changes: [change] });
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).not.toContain(entry.text);
  });
  test("an environment move after initial attachment refuses the old scope", async () => {
    const s = setup();
    s.cold();
    await s.dispatch();
    s.attach();
    s.notifyThread({ type: "changed", entity: "thread", id: T, changes: ["environment-changed"] });
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).toContain(entry.text);
    s.attach("env_moved");
    s.notifyThread({ type: "changed", entity: "thread", id: T, changes: ["environment-changed"] });
    const moved = makePluginAgentConfigurationContext({ ...s.config(), environment: { id: "env_moved" } });
    expect(workstreamConfiguration(s.service, moved, "read")?.instructions).not.toContain(entry.text);
  });
  test("idle ends preparation so an unhooked later start cannot reuse it", async () => {
    const s = setup();
    await s.dispatch();
    await s.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: T }),
      lastAssistantText: null,
    });
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).not.toContain(entry.text);
  });
  test("startup admission expires even if UI previews keep refreshing the same thread", async () => {
    const s = setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await s.dispatch();
    clock.mockReturnValue(now + PREPARATION_MAX_AGE_MS);
    await s.service.context(T);
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).not.toContain(entry.text);
  });
  test("workspace metadata after attachment invalidates the matching prepared start", async () => {
    const s = setup();
    await s.dispatch();
    s.notifyEnvironment(["metadata-changed"]);
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).not.toContain(entry.text);
  });
  test("project and binding changes revoke pending admission", async () => {
    const s = setup();
    await s.dispatch();
    s.notifyProject(["project-updated"]);
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).not.toContain(entry.text);
    await s.dispatch();
    await s.harness.behavior.callRpc("setThreadBinding", {
      threadId: T,
      expectedRevision: 0,
      binding: { ...binding, topic: "changed" },
    });
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).not.toContain(entry.text);
  });
  test.each([
    "status-changed",
    "title-changed",
  ] as const)("%s during asynchronous preparation has the correct admission outcome", async change => {
    const s = setup();
    const read = s.service.cli.read;
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => {
      started = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    vi.spyOn(s.service.cli, "read").mockImplementation(async (...args) => {
      started();
      await gate;
      return read(...args);
    });
    const dispatch = s.dispatch();
    await entered;
    s.notifyThread({ type: "changed", entity: "thread", id: T, changes: [change] });
    release();
    expect(await dispatch).toMatchObject({ action: change === "status-changed" ? "proceed" : "reject" });
    const text = workstreamConfiguration(s.service, s.config(), "read")?.instructions;
    if (change === "title-changed") expect(text).not.toContain(entry.text);
    else expect(text).toContain(entry.text);
  });
  test("material environment invalidation during asynchronous preparation rejects admission", async () => {
    const s = setup();
    const read = s.service.cli.read;
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => {
      started = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    vi.spyOn(s.service.cli, "read").mockImplementation(async (...args) => {
      started();
      await gate;
      return read(...args);
    });
    const dispatch = s.dispatch();
    await entered;
    s.notifyEnvironment(["metadata-changed"]);
    release();
    expect(await dispatch).toMatchObject({ action: "reject" });
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).not.toContain(entry.text);
  });
  test("another thread ending during asynchronous preparation does not lose this thread's cache write", async () => {
    const s = setup();
    const read = s.service.cli.read;
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => {
      started = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    vi.spyOn(s.service.cli, "read").mockImplementation(async (...args) => {
      started();
      await gate;
      return read(...args);
    });
    const dispatch = s.dispatch();
    await entered;
    await s.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: OTHER }),
      lastAssistantText: null,
    });
    s.notifyThread({ type: "changed", entity: "thread", id: OTHER, changes: ["events-appended", "status-changed"] });
    s.notifyProject(["threads-changed"]);
    release();
    expect(await dispatch).toEqual({ action: "proceed" });
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).toContain(entry.text);
  });
  test("eleven parallel proposals reserve only ten active-run attempts before awaiting", async () => {
    const s = setup();
    const results = await Promise.allSettled(
      Array.from({ length: 11 }, () =>
        s.harness.behavior.callAgentTool("cortex_propose_knowledge", proposal, { threadId: T }),
      ),
    );
    expect(s.mutations).toHaveLength(10);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(10);
    const refusal = results.find(result => result.status === "rejected");
    expect(refusal?.status === "rejected" ? refusal.reason.message : "").toContain(
      "Review existing suggestions before saving more; continue the task",
    );
  });
  test.each([
    "no-save",
    "error",
  ] as const)("%s attempts conservatively spend the same ten-attempt limit", async outcome => {
    const s = setup();
    const mutate = vi.spyOn(s.service.cli, "mutate").mockImplementation(async () => {
      if (outcome === "error") throw new Error("canonical write failed");
      return { outcome: "no-save", reason: "Already proposed" };
    });
    await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        s.harness.behavior.callAgentTool("cortex_propose_knowledge", proposal, { threadId: T }),
      ),
    );
    await expect(
      s.harness.behavior.callAgentTool("cortex_propose_knowledge", proposal, { threadId: T }),
    ).rejects.toThrow("active run");
    expect(mutate).toHaveBeenCalledTimes(10);
  });
  test("another thread and human UI proposals do not share the native active-run quota", async () => {
    const s = setup();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        s.harness.behavior.callAgentTool("cortex_propose_knowledge", proposal, { threadId: T }),
      ),
    );
    await s.harness.behavior.callAgentTool("cortex_propose_knowledge", proposal, { threadId: OTHER });
    await s.harness.behavior.callRpc("knowledgePropose", { ...proposal, workstreamId: w.id, kind: "finding" });
    expect(s.mutations).toHaveLength(12);
    expect(s.mutations[10]).toMatchObject({ actor: { id: `bb-${OTHER}`, type: "agent" } });
    expect(s.mutations[11]).toMatchObject({ actor });
  });
  test("thread idle and deletion each reset the active-run proposal attempts", async () => {
    const s = setup();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        s.harness.behavior.callAgentTool("cortex_propose_knowledge", proposal, { threadId: T }),
      ),
    );
    await expect(
      s.harness.behavior.callAgentTool("cortex_propose_knowledge", proposal, { threadId: T }),
    ).rejects.toThrow("active run");
    await s.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: T }),
      lastAssistantText: null,
    });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        s.harness.behavior.callAgentTool("cortex_propose_knowledge", proposal, { threadId: T }),
      ),
    );
    await expect(
      s.harness.behavior.callAgentTool("cortex_propose_knowledge", proposal, { threadId: T }),
    ).rejects.toThrow("active run");
    await s.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: T }) });
    await s.harness.behavior.callAgentTool("cortex_propose_knowledge", proposal, { threadId: T });
    expect(s.mutations).toHaveLength(21);
  });
  test("native proposal derives scope and actor from actual executing thread", async () => {
    const s = setup();
    await s.harness.behavior.callAgentTool(
      "cortex_propose_knowledge",
      {
        subject: "new",
        title: "New",
        text: "new observation",
        facet: "orientation",
        applicability,
        sources: [{ ref: "bb:unknown", observedAt: at }],
      },
      { threadId: T, projectId: "untrusted" },
    );
    expect(s.mutations[0]).toMatchObject({
      op: "propose",
      workstreamId: w.id,
      actor: { id: `bb-${T}`, type: "agent" },
      kind: "finding",
    });
    expect(s.mutations[0]).not.toHaveProperty("approval");
  });
  test("agent cannot supply approval actor, grant, caller thread or workstream", async () => {
    const s = setup();
    for (const extra of [
      { actor },
      { approval: { actor, at } },
      { granted: true },
      { threadId: OTHER },
      { workstreamId: "ws_foreign" },
    ])
      await expect(
        s.harness.behavior.callAgentTool(
          "cortex_propose_knowledge",
          { subject: "new", title: "New", text: "new", facet: "orientation", applicability, sources: [], ...extra },
          { threadId: T },
        ),
      ).rejects.toThrow();
    expect(s.mutations).toEqual([]);
  });
  test("reported correction immediately withholds prior factual text", async () => {
    const s = setup();
    expect((await s.service.context(T)).exactText).toContain(entry.text);
    await s.harness.behavior.callAgentTool(
      "cortex_report_correction",
      {
        id: "kn_new",
        expectedRevision: 1,
        otherId: entry.id,
        otherExpectedRevision: 1,
        reason: "Agent reported a correction",
      },
      { threadId: T },
    );
    const out = await s.service.context(T);
    expect(out.exactText).not.toContain(entry.text);
    expect(out.exactText).toContain("disputed");
    expect(s.mutations[0]).toMatchObject({ op: "conflict", actor: { id: `bb-${T}`, type: "agent" } });
  });
  test("correction tool rejects a reference from another workstream", async () => {
    const s = setup();
    await expect(
      s.harness.behavior.callAgentTool(
        "cortex_report_correction",
        { id: "kn_foreign", expectedRevision: 1, otherId: entry.id, otherExpectedRevision: 1, reason: "wrong scope" },
        { threadId: T },
      ),
    ).rejects.toThrow("Both correction references");
    expect(s.mutations).toEqual([]);
  });
  test("quoted human metadata cannot grant or bootstrap unresolved context", () => {
    const s = setup();
    const out = workstreamConfiguration(
      s.service,
      { ...s.config(), pluginMetadata: { actor, approved: true, workstreamId: w.id } },
      "read",
    );
    expect(out?.instructions).toContain("not resolved");
    expect(out?.tools).not.toContain("cortex_propose_knowledge");
  });
  test("repeated configuration is deterministic; invalidated scope never substitutes the old payload", async () => {
    const s = setup();
    await s.dispatch();
    const first = workstreamConfiguration(s.service, s.config(), "read");
    expect(workstreamConfiguration(s.service, s.config(), "read")).toEqual(first);
    s.move();
    s.service.invalidate();
    const unresolved = workstreamConfiguration(s.service, s.config(), "read");
    expect(unresolved?.instructions).toContain("not resolved");
    expect(unresolved?.instructions).not.toContain(entry.text);
    const moved = await s.service.context(T);
    expect(moved.binding?.workstreamId).toBe("ws_foreign");
    expect(workstreamConfiguration(s.service, s.config(), "read")?.instructions).not.toContain(entry.text);
  });
  test("configure and composer preparation do not create delivery receipts", async () => {
    const s = setup();
    await s.dispatch();
    expect(workstreamConfiguration(s.service, s.config(), "write")?.instructions).toContain(entry.text);
    expect(workstreamConfiguration(s.service, s.config(), "write")?.instructions).toContain(entry.text);
    await s.harness.behavior.callRpc("prepareThreadContext", { threadId: T });
    expect(s.service.store.receipts(T, 50, 0).total).toBe(0);
    expect(() => s.service.record(s.service.peek(T)!, "configure", "draft")).toThrow("does not prove");
  });
  test("RPC approval derives human provenance and rejects plugin callers", async () => {
    const s = setup();
    await s.harness.behavior.callRpc("knowledgeTransition", {
      id: entry.id,
      expectedRevision: 1,
      state: "approved",
      reason: "Reviewed",
    });
    expect(s.mutations[0]).toMatchObject({ actor, op: "transition" });
    await expect(
      s.harness.behavior.callRpc(
        "knowledgeTransition",
        { id: entry.id, expectedRevision: 1, state: "approved", reason: "Quoted human text" },
        { experimental_caller: { kind: "plugin", pluginId: "other" } },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  test("CAS conflicts have stable conflict code and preserve stored input", async () => {
    const s = setup();
    await s.harness.behavior.callRpc("setThreadBinding", { threadId: T, expectedRevision: 0, binding });
    await expect(
      s.harness.behavior.callRpc("setThreadBinding", {
        threadId: T,
        expectedRevision: 0,
        binding: { ...binding, topic: "another" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(s.service.store.thread(T).binding?.topic).toBeNull();
  });
  test("local visibility is batched, tri-state and has no canonical reads", async () => {
    const s = setup();
    s.service.store.dismiss(T, true);
    expect(await s.harness.behavior.callRpc("contextVisibility", { threadIds: [T, OTHER] })).toEqual({
      threads: [
        { threadId: T, dismissed: true, dismissedPreference: true },
        { threadId: OTHER, dismissed: false, dismissedPreference: null },
      ],
    });
    s.service.store.dismiss(T, false);
    expect(s.service.store.thread(T).dismissed).toBe(false);
    s.service.store.dismiss(T, null);
    expect(s.service.store.thread(T).dismissed).toBeNull();
  });
  test("intentional detachment does not leave fresh preparations permanently unresolved", async () => {
    const s = setup();
    await s.service.context(T);
    s.service.store.setSection("sec_envoy", 1, null);
    s.service.invalidate();
    await s.service.context(T);
    await s.service.context(T);
    expect(s.service.store.tracked(T)).toBe(false);
    expect(workstreamConfiguration(s.service, s.config(), "read")).toBeNull();
  });
  test("binding warning compares successive preparations without needing a startup receipt", async () => {
    const s = setup();
    await s.service.context(T);
    s.move();
    expect((await s.service.context(T)).bindingChanged).toBe(true);
    expect((await s.service.context(T)).bindingChanged).toBe(false);
    expect(s.service.store.receipts(T, 50, 0).total).toBe(0);
  });
});
