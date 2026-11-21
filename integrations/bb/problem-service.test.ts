import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, test, vi } from "vitest";
import { createWorkstreams } from "./workstreams";
import { createSections } from "./sections";
import { createProblems } from "./problem-service";
import { problemHandlers } from "./problem-rpc";
import { problemRpcMethods } from "./problem-contract";
import { workstreamHandlers } from "./workstream-rpc";
import { workstreamRpcContract } from "./workstream-contract";
import type { CortexRunner } from "./cli";
import { createDraftService, type DraftService } from "./draft-service";
import type { Knowledge } from "./workstream-contract";
const at = "2026-01-01T00:00:00.000Z";
const actor = { id: "human", type: "human" } as const;
const applicability = { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } } as const;
const ws = { id: "ws_one", revision: 1, name: "Payments", description: "", archived: false, actor, createdAt: at, updatedAt: at };
test("problems read uses one canonical read per connected section; jobs stay local, and author is listable", async () => {
  const host = createFakePluginHost({ pluginId: "cortex", sdk: {
    threadSections: { list: async () => [{ id: "sec_one", name: "Payments", createdAt: 0, updatedAt: 0 }, { id: "sec_two", name: "Billing", createdAt: 0, updatedAt: 0 }] },
    threads: { list: async () => [] },
    subscribe: () => () => {},
  } });
  const run = vi.fn(async (args, schema) => {
    if (args[1] === "read") return schema.parse({ workstream: ws, entries: [], notices: [], applicability, topic: null });
    if (args[1] === "knowledge") return schema.parse({ items: [{ workstream: ws, hints: [], entry: { id: "kn_target", workstreamId: ws.id, subject: "deploy", title: "Deploy to staging", text: "Check the rollout", kind: "finding", state: "approved", facet: "orientation", applicability: { ...applicability, environment: { mode: "value", value: "staging" } }, sources: [], revision: 1, actor, createdAt: at, updatedAt: at, expiresAt: null, approval: { actor, at }, supersedes: [], conflicts: [], supersededBy: null } }], total: 1, limit: 100, offset: 0 });
    if (args[1] === "show") return schema.parse({ workstream: ws, entries: [], total: 0, limit: 1, offset: 0 });
    throw new Error("Unexpected CLI call");
  });
  const service = createWorkstreams(host.bb, { binary: "fake", run, text: async () => { throw new Error("No text reads"); } } as CortexRunner, { userAuthor: null, widgetDefault: () => false });
  const sections = createSections(host.bb, service);
  const jobs = vi.fn(() => ({ jobs: [], total: 0, limit: 50, offset: 0 }));
  const read = createProblems(host.bb, sections, service, { jobs } as unknown as DraftService);
  try {
    service.store.setSection("sec_one", 0, { workstreamId: ws.id, topic: null, budgetTokens: 3000, requiredKnowledgeIds: ["kn_missing"], applicability });
    host.bb.rpc.register(problemRpcMethods, problemHandlers(read, service));
    const result = await host.harness.behavior.callRpc("problems", null) as Awaited<ReturnType<typeof read>>;
    // The staging-only entry reaches no thread in a section that targets any environment.
    expect(result.problems.map(row => row.kind)).toEqual(["human-author", "missing-required", "unreached"]);
    expect(run.mock.calls.filter(([args]) => args[1] === "read")).toHaveLength(1);
    expect(jobs).toHaveBeenCalledTimes(2);
    const unknown = { ...applicability, environment: { mode: "unknown" as const } };
    const binding = { workstreamId: ws.id, topic: null, budgetTokens: 3000, requiredKnowledgeIds: [], applicability: unknown };
    service.store.setSection("sec_one", 1, binding);
    service.store.setSection("sec_two", 0, binding);
    service.invalidateScope({ workstreamId: ws.id });
    const targets = await host.harness.behavior.callRpc("problems", null) as Awaited<ReturnType<typeof read>>;
    expect(targets.problems.filter(row => row.kind === "target")).toHaveLength(2);
    expect(targets.problems.filter(row => row.kind === "unreached")).toHaveLength(0);
    // One shared knowledge read per problems read, reused by both sections and the unreached check.
    expect(run.mock.calls.filter(([args]) => args[1] === "knowledge")).toHaveLength(2);
  } finally { await host.harness.lifecycle.dispose(); }
});
test("Remove from required preserves other binding fields and rejects a stale revision", async () => {
  const host = createFakePluginHost({ pluginId: "cortex" });
  const runner = { binary: "fake", run: async (_args, schema) => schema.parse({ workstream: ws, entries: [], total: 0, limit: 1, offset: 0 }), text: async () => "" } as CortexRunner;
  const service = createWorkstreams(host.bb, runner, { userAuthor: "human", widgetDefault: () => false });
  try {
    const binding = { workstreamId: ws.id, topic: null, budgetTokens: 3000, requiredKnowledgeIds: ["kn_missing", "kn_keep"], applicability };
    const row = service.store.setSection("sec_one", 0, binding);
    host.bb.rpc.register(workstreamRpcContract, workstreamHandlers(service));
    const input = { sectionId: "sec_one", expectedRevision: row.revision, binding: { ...binding, requiredKnowledgeIds: ["kn_keep"] } };
    await host.harness.behavior.callRpc("setSectionBinding", input);
    expect(service.store.section("sec_one").binding).toEqual(input.binding);
    await expect(host.harness.behavior.callRpc("setSectionBinding", input)).rejects.toMatchObject({ code: "conflict" });
    expect(service.store.section("sec_one").binding?.requiredKnowledgeIds).toEqual(["kn_keep"]);
  } finally { await host.harness.lifecycle.dispose(); }
});

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0)) await dispose();
});

function setupProblems() {
  const section = { id: "sec_one", name: "Payments", createdAt: 0, updatedAt: 0 };
  const host = createFakePluginHost({ pluginId: "cortex", sdk: {
    threadSections: { list: async () => [section] },
    threads: { list: async () => [] },
    subscribe: () => () => {},
  } });
  disposers.push(() => host.harness.lifecycle.dispose());
  const entry: Knowledge = {
    id: "kn_extra", workstreamId: ws.id, subject: "deploy", title: "Deploy to staging", text: "Check the rollout",
    kind: "finding", state: "approved", facet: "another-topic", applicability, sources: [], revision: 1,
    actor, createdAt: at, updatedAt: at, expiresAt: null, approval: { actor, at }, supersedes: [], conflicts: [], supersededBy: null,
  };
  const fixture = { entry, failBrief: false, failCatalog: false, catalogGate: undefined as Promise<void> | undefined, show: undefined as undefined | (() => Promise<unknown>) };
  const execute: CortexRunner["run"] = async (args, schema, options) => {
    if (args[1] === "read") {
      if (fixture.failBrief) throw new Error("brief temporarily unavailable");
      return schema.parse({ workstream: ws, entries: [], notices: [], applicability, topic: null });
    }
    if (args[1] === "knowledge") {
      if (fixture.failCatalog) throw new Error("catalog temporarily unavailable");
      const snapshot = fixture.entry;
      await fixture.catalogGate;
      options?.signal?.throwIfAborted();
      return schema.parse({ items: [{ workstream: ws, hints: [], entry: snapshot }], total: 1, limit: 100, offset: 0 });
    }
    if (args[1] === "show" && fixture.show) return schema.parse(await fixture.show());
    throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
  };
  const runner: CortexRunner = { binary: "fake", run: execute, text: async () => { throw new Error("No text reads"); } };
  const run = vi.spyOn(runner, "run");
  const service = createWorkstreams(host.bb, runner, { userAuthor: "human", widgetDefault: () => false });
  const sections = createSections(host.bb, service);
  const drafts = createDraftService(host.bb, service);
  const binding = { workstreamId: ws.id, topic: null, budgetTokens: 3000, requiredKnowledgeIds: [], applicability };
  service.store.setSection(section.id, 0, binding);
  const readProblems = createProblems(host.bb, sections, service, drafts);
  host.bb.rpc.register(problemRpcMethods, problemHandlers(readProblems, service));
  const call = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);
  const read = (signal?: AbortSignal) => host.harness.behavior.callRpc("problems", null, { signal }) as Promise<Awaited<ReturnType<ReturnType<typeof createProblems>>>>;
  const startGatedRead = () => {
    const before = run.mock.calls.filter(([args]) => args[1] === "knowledge").length;
    let release!: () => void;
    fixture.catalogGate = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const result = read(controller.signal);
    const started = () => vi.waitFor(() => expect(run.mock.calls.filter(([args]) => args[1] === "knowledge")).toHaveLength(before + 1));
    return { result, started, controller, release };
  };
  return { host, read, readProblems, call, run, sections, section, service, fixture, binding, startGatedRead };
}

test("concurrent problems RPCs share one set of SDK lists and fake CLI invocations", async () => {
  const { host, read, run } = setupProblems();
  const results = await Promise.all(Array.from({ length: 5 }, () => read()));
  expect(results[0]?.problems).toMatchObject([{ kind: "unreached" }]);
  expect(results).toEqual(Array(5).fill(results[0]));
  expect(run.mock.calls.map(([args]) => args[1])).toEqual(["read", "knowledge"]);
  expect(host.harness.inspection.sdk.callsTo("threadSections.list")).toHaveLength(2);
  expect(host.harness.inspection.sdk.callsTo("threads.list")).toHaveLength(1);
});

test("a hung SDK call times out for all waiters and the next request recomputes", async () => {
  vi.useFakeTimers();
  // Node's AbortSignal.timeout uses a timer that Vitest cannot advance directly.
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Read timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  const { host, read, readProblems, run, section } = setupProblems();
  const hung = vi.fn(() => new Promise<never>(() => {}));
  host.harness.sdk.stub("threads.list", hung);
  const reads = Promise.allSettled([readProblems(), readProblems()]);
  const onSettled = vi.fn();
  void reads.then(onSettled);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
  expect(hung).toHaveBeenCalledExactlyOnceWith({ signal: expect.objectContaining({ aborted: false }) });
  expect(run).not.toHaveBeenCalled();
  expect(onSettled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(hung).toHaveBeenCalledExactlyOnceWith({ signal: expect.objectContaining({ aborted: true }) });
  expect(await reads).toMatchObject(Array(2).fill({ status: "rejected", reason: { name: "TimeoutError" } }));

  host.harness.sdk.stub("threads.list", async () => []);
  expect((await read()).problems).toMatchObject([{ kind: "unreached", sectionId: section.id }]);
  await read();
  expect(run.mock.calls.map(([args]) => args[1])).toEqual(["read", "knowledge"]);
  expect(host.harness.inspection.sdk.callsTo("threads.list")).toHaveLength(2);
});

test("disposing the plugin aborts an in-flight shared read", async () => {
  const { host, readProblems } = setupProblems();
  const hung = vi.fn(() => new Promise<never>(() => {}));
  host.harness.sdk.stub("threads.list", hung);
  const settled = Promise.allSettled([readProblems()]);
  expect(hung).toHaveBeenCalledExactlyOnceWith({ signal: expect.objectContaining({ aborted: false }) });
  await host.harness.lifecycle.dispose();
  expect(await settled).toMatchObject([{ status: "rejected", reason: { name: "AbortError" } }]);
});

test("a healthy result is reused until exactly 30 seconds, even across a thread-only invalidation", async () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  const { read, run, fixture, service } = setupProblems();
  const old = await read();
  fixture.entry = { ...fixture.entry, revision: 2 };
  service.invalidate("thr_aaaaaaaa");
  vi.advanceTimersByTime(29_999);
  expect(await read()).toEqual(old);
  expect(run).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1);
  expect((await read()).problems).toMatchObject([{ entries: [{ revision: 2 }] }]);
  expect(run).toHaveBeenCalledTimes(4);
});

test.each(["broad", "section scope", "workstream scope", "sections publish"] as const)("%s invalidates a warm read", async kind => {
  const { read, run, sections, section, service, binding, fixture } = setupProblems();
  await read();
  const before = run.mock.calls.length;
  if (kind === "sections publish") {
    section.name = "Renamed section";
    await sections.markTitle({ sectionId: section.id, action: "remove", expectedTitle: section.name });
    expect((await read()).problems).toMatchObject([{ sectionName: section.name }]);
  } else if (kind === "section scope") {
    service.store.setSection(section.id, 1, { ...binding, requiredKnowledgeIds: ["kn_missing"] });
    service.invalidateScope({ sectionId: section.id });
    expect((await read()).problems).toMatchObject([{ kind: "missing-required" }, { kind: "unreached" }]);
  } else {
    fixture.entry = { ...fixture.entry, revision: 2 };
    if (kind === "broad") service.invalidate();
    else service.invalidateScope({ workstreamId: ws.id });
    expect((await read()).problems).toMatchObject([{ entries: [{ revision: 2 }] }]);
  }
  expect(run).toHaveBeenCalledTimes(before + 2);
  await read();
  expect(run).toHaveBeenCalledTimes(before + 2);
});

test("a pending connection that replaces a failed job clears its cached problem", async () => {
  const { read, run, section, sections, service, fixture } = setupProblems();
  const input = { sectionId: section.id, expectedRevision: 1, expectedTitle: section.name, markTitle: false,
    choice: { kind: "reuse" as const, workstreamId: ws.id, expectedWorkstreamRevision: ws.revision } };
  fixture.show = async () => { throw new Error("temporarily unavailable"); };
  expect((await sections.connect({ ...input, requestId: "00000000-0000-4000-8000-000000000001" })).status).toBe("failed");
  expect((await read()).problems.map(row => row.kind)).toEqual(["connection", "unreached"]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.show = async () => { await gate; return { workstream: ws, entries: [], total: 0, limit: 1, offset: 0 }; };
  const connecting = sections.connect({ ...input, requestId: "00000000-0000-4000-8000-000000000002" });
  try {
    await vi.waitFor(() => expect(service.store.jobs.latest(section.id)?.status).toBe("pending"));
    expect((await read()).problems.map(row => row.kind)).toEqual(["unreached"]);
    const calls = run.mock.calls.length;
    await read();
    expect(run).toHaveBeenCalledTimes(calls);
  } finally {
    release();
    await connecting;
  }
});

test("an older in-flight read neither serves the new generation nor overwrites it", async () => {
  const { read, run, fixture, service, startGatedRead } = setupProblems();
  const old = startGatedRead();
  try {
    await old.started();
    fixture.catalogGate = undefined;
    fixture.entry = { ...fixture.entry, revision: 2 };
    service.invalidateScope({ workstreamId: ws.id }, false);
    const fresh = await read();
    expect(fresh.problems).toMatchObject([{ entries: [{ revision: 2 }] }]);
    old.release();
    expect((await old.result).problems).toMatchObject([{ entries: [{ revision: 1 }] }]);
    expect(await read()).toEqual(fresh);
    expect(run).toHaveBeenCalledTimes(4);
  } finally {
    old.release();
    await old.result;
  }
});

test("cancelling the first RPC stops only that wait, not the other caller or computation", async () => {
  const { read, run, startGatedRead } = setupProblems();
  const old = startGatedRead();
  let cancellation: unknown;
  const cancelled = old.result.then(() => { cancellation = null; }, error => { cancellation = error; });
  try {
    await old.started();
    const other = read();
    old.controller.abort(new Error("caller disconnected"));
    await vi.waitFor(() => expect(cancellation).toMatchObject({ message: "caller disconnected" }), { timeout: 250 });
    old.release();
    expect((await other).problems).toMatchObject([{ kind: "unreached" }]);
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(["read", "knowledge"]);
  } finally {
    old.release();
    await cancelled;
  }
});

test.each(["brief", "shown catalog", "unreached-only catalog"] as const)("a failed %s read is not cached", async failure => {
  const { read, fixture, run, section, service, binding } = setupProblems();
  if (failure === "shown catalog") service.store.setSection(section.id, 1, { ...binding, applicability: undefined });
  fixture.failBrief = failure === "brief";
  fixture.failCatalog = !fixture.failBrief;
  const degraded = { brief: [{ kind: "unavailable" }], "shown catalog": [{ kind: "catalog-read" }], "unreached-only catalog": [] };
  expect((await read()).problems).toMatchObject(degraded[failure]);
  fixture.failBrief = fixture.failCatalog = false;
  expect((await read()).problems).toMatchObject([{ kind: "unreached" }]);
  const calls = run.mock.calls.length;
  await read();
  expect(run).toHaveBeenCalledTimes(calls);
});

test.each(["cached", "in-flight"] as const)("dismiss reads fresh rather than using an older %s result; undo refreshes the list", async oldKind => {
  const { read, call, run, section, fixture, startGatedRead } = setupProblems();
  const old = oldKind === "in-flight" ? startGatedRead() : null;
  try {
    if (old) await old.started();
    else expect((await read()).problems).toMatchObject([{ kind: "unreached" }]);
    fixture.catalogGate = undefined;
    fixture.entry = { ...fixture.entry, revision: 2 };
    const input = { sectionId: section.id, id: fixture.entry.id, expectedRevision: 2 };
    await expect(call("problemEntryDismiss", input)).resolves.toEqual({ dismissed: true });
    expect((await read()).problems).toEqual([]);
    const beforeUndo = run.mock.calls.length;
    await expect(call("problemEntryUndo", input)).resolves.toEqual({ dismissed: false });
    expect((await read()).problems).toMatchObject([{ entries: [{ revision: 2 }] }]);
    expect(run).toHaveBeenCalledTimes(beforeUndo + 2);
    await read();
    expect(run).toHaveBeenCalledTimes(beforeUndo + 2);
  } finally {
    old?.release();
    await old?.result;
  }
});
