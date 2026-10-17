import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakeCortex, type FakeCortex, type FakeFixture, type FakeTask } from "./fake-cortex";
import plugin, { instructionsFor, USAGE } from "./server";
import { REMOTE_REASON } from "./state";
import { routeCortexEvent } from "./watch";

const THREAD = "thr_aaaaaaaa";
const REMOTE = "thr_bbbbbbbb";
const OTHER = "thr_cccccccc";
/** A thread whose title lookup fails. */
const GONE = "thr_ffffffff";
const PROJECT = "proj_1";
const USER = "kalindu-test";

function task(id: number, extra: Partial<FakeTask["task"]> = {}, rest: Partial<FakeTask> = {}): FakeTask {
  return {
    task: { id, title: `Task ${id}`, status: "open", lane: "cortex", tags: [], body: `body ${id}`, created: 1000, ...extra },
    updates: [],
    ...rest,
  };
}

function baseFixture(): FakeFixture {
  return {
    context: { lane: "cortex", primer: "PRIMER: [1] open \u00b7 cortex" },
    tasks: {
      "1": task(1),
      "2": task(2, { status: "blocked" }),
      // Activity 2500: the status audit at 5000 is not activity.
      "3": task(3, {}, {
        updates: [
          { id: 30, task_id: 3, author: "pi-x", summary: "status \u2192 done", body: null, created: 5000 },
          { id: 31, task_id: 3, author: "pi-x", summary: "real work", body: "- detail", created: 2500 },
        ],
      }),
      "4": task(4, { title: "Stale one" }, { staleness: { verdict: "stale", changed: ["src/a.ts"] } }),
    },
    streams: {
      [`bb-${THREAD}`]: [
        { id: 1, title: "Task 1", lane: "cortex", status: "open", activity: 3000 },
        { id: 2, title: "Task 2", lane: "cortex", status: "blocked", activity: 2000 },
      ],
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const disposers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function setup(options: { fixture?: FakeFixture; running?: string[]; cortexPath?: string } = {}) {
  const cortex: FakeCortex = createFakeCortex(options.fixture ?? baseFixture());
  disposers.push(cortex.cleanup);
  const checkout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bb-checkout-")));
  disposers.push(() => fs.rmSync(checkout, { recursive: true, force: true }));
  const metadata = new Map<string, Record<string, unknown>>();
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => {
        if (threadId === GONE) throw new Error("HTTP 404: thread not found");
        return makeThreadResponse({
          id: threadId,
          projectId: PROJECT,
          title: `Thread ${threadId}`,
          environmentId: threadId === REMOTE ? "env_remote" : "env_local",
        });
      },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
      updatePluginMetadata: async ({
        threadId,
        set = {},
        remove = [],
      }: {
        threadId: string;
        set?: Record<string, unknown>;
        remove?: string[];
      }) => {
        const next: Record<string, unknown> = { ...(metadata.get(threadId) ?? {}), ...set };
        for (const key of remove) delete next[key];
        metadata.set(threadId, next);
        return next;
      },
      listRunning: async () => (options.running ?? []).map(id => ({ id, hostId: "host_local" })),
    },
    environments: {
      get: async ({ environmentId }: { environmentId: string }) => ({
        id: environmentId,
        hostId: environmentId === "env_remote" ? "host_remote" : "host_local",
        path: checkout,
      }),
    },
    system: { config: async () => ({ primaryHostId: "host_local" }) },
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "cortex",
    settings: { cortexPath: options.cortexPath ?? cortex.binary },
    sdk: sdk as never,
  });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const argvs = () => cortex.calls().map(call => call.argv);
  const resolve = (providerId: string) =>
    harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ provider: { id: providerId }, project: { id: PROJECT } }),
    );
  return { bb, harness, cortex, checkout, metadata, argvs, resolve };
}

const threadSignal = (threadId: string) => ({ channel: "thread", payload: { threadId } });
const taskSignal = (taskId: number) => ({ channel: "task", payload: { taskId } });
const ids = (state: unknown) => (state as { links: Array<{ id: number }> }).links.map(link => link.id);

async function warm(s: Setup, threadId = THREAD): Promise<void> {
  await s.harness.behavior.emitThreadEvent("thread.active", {
    thread: makeThreadResponse({ id: threadId, projectId: PROJECT }),
  });
  await vi.waitFor(async () => expect((await s.resolve("codex")).instructions).toContain("PRIMER"));
}

test("imports only the public SDK, zod, Node, the vendored UI and test tooling; never cortex's source", () => {
  const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), {
    allow: [/^react(-dom)?(\/|$)/, /^@radix-ui\//, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/, /^sonner$/, /^vitest(\/|$)/, /^@testing-library\//, /^@\//],
  });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});

describe("agent configuration", () => {
  test("pi threads get no tools, skills or instructions; other providers get both tools and the usage block", async () => {
    const s = await setup();
    const pi = await s.resolve("pi");
    expect(pi.tools).toEqual([]);
    expect(pi.skills).toEqual([]);
    expect(pi.instructions ?? "").toBe("");
    const codex = await s.resolve("codex");
    expect(codex.tools.map(tool => tool.name).sort()).toEqual(["cortex_recall", "cortex_update"]);
    expect(codex.skills).toEqual([]);
    // A cold cache contributes only the usage block and never runs the CLI.
    expect(codex.instructions).toBe(USAGE);
    expect(s.argvs().filter(argv => argv[1] === "context")).toEqual([]);
  });

  test("a warmed project adds its primer; running threads warm at startup", async () => {
    const s = await setup({ running: [THREAD] });
    await vi.waitFor(async () => expect((await s.resolve("codex")).instructions).toContain("<cortex_memory>"));
    const contexts = s.cortex.calls().filter(call => call.argv[1] === "context");
    expect(contexts).toEqual([{ argv: ["memory", "context", "--json"], cwd: s.checkout }]);
    expect((await s.resolve("pi")).instructions ?? "").toBe("");
  });

  test("instructions stay within 4,096 characters", () => {
    expect(instructionsFor(null)).toBe(USAGE);
    const long = instructionsFor("x".repeat(10_000));
    expect(long.length).toBeLessThanOrEqual(4096);
    expect(long.endsWith("</cortex_memory>")).toBe(true);
  });

  test("a remote checkout never warms a primer", async () => {
    const s = await setup();
    await s.harness.behavior.emitThreadEvent("thread.created", {
      thread: makeThreadResponse({ id: REMOTE, projectId: PROJECT }),
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(s.argvs().filter(argv => argv[1] === "context")).toEqual([]);
  });
});

describe("cortex_update", () => {
  test("posts as bb-<thread>, in attached flag form, and signals the thread and task", async () => {
    const s = await setup();
    const out = await s.harness.behavior.callAgentTool(
      "cortex_update",
      { task_id: 4, message: "-did things", status: "review", body: "- a\n- b" },
      { threadId: THREAD },
    );
    expect(out).toBe("\u2713 update [900] posted on task 4\n\u2713 status \u2192 review");
    expect(s.argvs()).toContainEqual([
      "update",
      "4",
      "--message=-did things",
      `--as=bb-${THREAD}`,
      "--status=review",
      "--body=- a\n- b",
      "--json",
    ]);
    expect(s.harness.inspection.realtimeSignals).toEqual(
      expect.arrayContaining([threadSignal(THREAD), taskSignal(4)]),
    );
  });

  test("rejects invalid arguments before running the CLI, and throws on a CLI failure", async () => {
    const s = await setup();
    const before = s.argvs().length;
    for (const input of [
      { task_id: 0, message: "x" },
      { task_id: 1, message: "two\nlines" },
      { task_id: 1, message: "   " },
      { task_id: 1, message: "x".repeat(4097) },
      { task_id: 1, message: "x", status: "bogus" },
    ]) {
      await expect(s.harness.behavior.callAgentTool("cortex_update", input, { threadId: THREAD })).rejects.toThrow();
    }
    expect(s.argvs().length).toBe(before);
    await expect(
      s.harness.behavior.callAgentTool("cortex_update", { task_id: 77, message: "x" }, { threadId: THREAD }),
    ).rejects.toThrow(/not found/);
  });
});

describe("cortex_recall", () => {
  test("loads a stream or a section with the CLI's text, run in the thread's checkout", async () => {
    const s = await setup();
    const call = (query: string) => s.harness.behavior.callAgentTool("cortex_recall", { query }, { threadId: THREAD });
    expect(await call("@4")).toBe(`TEXT memory show 4 cwd=${s.checkout}\n`);
    expect(await call("@4#next")).toContain("#next");
    expect(s.argvs()).toContainEqual(["memory", "show", "4", "--section=next"]);
  });

  test("searches with a sanitized query, boosted by the project lane once known", async () => {
    const s = await setup();
    await warm(s);
    const out = await s.harness.behavior.callAgentTool("cortex_recall", { query: "--fix the bug" }, { threadId: THREAD });
    expect(out).toContain("boost=cortex");
    expect(s.argvs()).toContainEqual(["memory", "search", "fix the bug", "--limit=5", "--boost=cortex"]);
  });

  test("three calls per request, reset when the thread goes idle", async () => {
    const s = await setup();
    const call = (query: string) => s.harness.behavior.callAgentTool("cortex_recall", { query }, { threadId: THREAD });
    await call("@1");
    await call("@2");
    await call("@3");
    expect(await call("@4")).toMatch(/budget for this request is spent/);
    await s.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD }),
      lastAssistantText: null,
    });
    expect(await call("@4")).toContain("TEXT memory show 4");
  });

  test("a repeated query short-circuits, also while in flight; a failure releases its claim", async () => {
    const s = await setup();
    const call = (query: string) => s.harness.behavior.callAgentTool("cortex_recall", { query }, { threadId: THREAD });
    const [first, second] = await Promise.all([call("@1"), call(" @1 ")]);
    expect([first, second].filter(out => String(out).startsWith("Already recalled"))).toHaveLength(1);
    // A duplicate still spends budget, so the failure case starts a fresh request.
    await s.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD }),
      lastAssistantText: null,
    });
    await expect(call("@77")).rejects.toThrow(/not found/);
    s.cortex.setFixture({ ...baseFixture(), tasks: { ...baseFixture().tasks, "77": task(77) } });
    expect(await call("@77")).toContain("TEXT memory show 77");
  });

  test("a checkout on another machine is never checked and says so", async () => {
    const s = await setup();
    const out = await s.harness.behavior.callAgentTool("cortex_recall", { query: "@4" }, { threadId: REMOTE });
    expect(out).toContain(`cwd=${fs.realpathSync(os.tmpdir())}`);
    expect(out).toContain(`(staleness unverifiable: ${REMOTE_REASON})`);
  });
});

describe("rpc", () => {
  test("threadState lists authored tasks newest activity first, health follows the focus task", async () => {
    const s = await setup();
    const state = (await s.harness.behavior.callRpc("threadState", { threadId: THREAD })) as Record<string, unknown>;
    expect(ids(state)).toEqual([1, 2]);
    expect(state.focusTaskId).toBe(1);
    expect(state.pinnedTaskId).toBeNull();
    expect(state.health).toEqual({ kind: "ok" });
    const empty = (await s.harness.behavior.callRpc("threadState", { threadId: OTHER })) as Record<string, unknown>;
    expect(empty).toMatchObject({ links: [], focusTaskId: null, health: { kind: "ok" } });
  });

  test("link, pin and unlink: manual activity skips status audits, pins win, authored tasks stay", async () => {
    const s = await setup();
    const rpc = (method: string, input: unknown) =>
      s.harness.behavior.callRpc(method, input) as Promise<Record<string, unknown>>;
    expect(ids(await rpc("link", { threadId: THREAD, taskId: 3 }))).toEqual([1, 3, 2]);
    const pinned = await rpc("pin", { threadId: THREAD, taskId: 2 });
    expect(pinned).toMatchObject({ focusTaskId: 2, pinnedTaskId: 2, health: { kind: "blocked" } });
    const stale = await rpc("pin", { threadId: THREAD, taskId: 4 });
    expect(stale).toMatchObject({ focusTaskId: 4, health: { kind: "stale", message: "changed: src/a.ts" } });
    expect(s.metadata.get(THREAD)).toEqual({ pinnedTaskId: 4, linkedTaskIds: [3, 4] });
    const unlinked = await rpc("unlink", { threadId: THREAD, taskId: 1 });
    expect(ids(unlinked)).toContain(1);
    const unpinned = await rpc("unlink", { threadId: THREAD, taskId: 4 });
    expect(unpinned).toMatchObject({ pinnedTaskId: null, focusTaskId: 1 });
    expect(ids(unpinned)).toEqual([1, 3, 2]);
    expect(s.harness.inspection.realtimeSignals.filter(signal => signal.channel === "thread")).toHaveLength(5);
  });

  test("concurrent links on one thread both land", async () => {
    const s = await setup();
    await Promise.all([
      s.harness.behavior.callRpc("link", { threadId: THREAD, taskId: 3 }),
      s.harness.behavior.callRpc("link", { threadId: THREAD, taskId: 4 }),
    ]);
    expect((s.metadata.get(THREAD)?.linkedTaskIds as number[]).sort()).toEqual([3, 4]);
  });

  test("rejects unknown tasks and invalid input; ignores invalid metadata", async () => {
    const s = await setup();
    await expect(s.harness.behavior.callRpc("link", { threadId: THREAD, taskId: 99 })).rejects.toThrow(/not available/);
    await expect(s.harness.behavior.callRpc("threadState", { threadId: "nope" })).rejects.toThrow();
    await expect(s.harness.behavior.callRpc("task", { threadId: THREAD, taskId: 0 })).rejects.toThrow();
    await expect(s.harness.behavior.callRpc("pin", { threadId: THREAD, taskId: "2" })).rejects.toThrow();
    s.metadata.set(THREAD, { pinnedTaskId: "x", linkedTaskIds: [3, -1] });
    const state = (await s.harness.behavior.callRpc("threadState", { threadId: THREAD })) as Record<string, unknown>;
    expect(ids(state)).toEqual([1, 2]);
    expect(state.pinnedTaskId).toBeNull();
  });

  test("a fresh task's detail is strict JSON: staleness carries no undefined reason", async () => {
    const s = await setup();
    const detail = (await s.harness.behavior.callRpc("task", { threadId: THREAD, taskId: 1 })) as Record<string, unknown>;
    expect(detail.staleness).toEqual({ verdict: "fresh" });
  });

  test("task detail: body, updates and staleness, cached until the task changes, unverifiable off-machine", async () => {
    const s = await setup();
    const detail = (await s.harness.behavior.callRpc("task", { threadId: THREAD, taskId: 4 })) as Record<string, unknown>;
    expect(detail).toMatchObject({
      task: { id: 4, title: "Stale one", body: "body 4" },
      staleness: { verdict: "stale", reason: "changed: src/a.ts" },
    });
    const shows = () => s.argvs().filter(argv => argv[0] === "show" && argv[1] === "4").length;
    await s.harness.behavior.callRpc("task", { threadId: THREAD, taskId: 4 });
    expect(shows()).toBe(1);
    await s.harness.behavior.callAgentTool("cortex_update", { task_id: 4, message: "x" }, { threadId: THREAD });
    await s.harness.behavior.callRpc("task", { threadId: THREAD, taskId: 4 });
    expect(shows()).toBeGreaterThan(1);
    const remote = (await s.harness.behavior.callRpc("task", { threadId: REMOTE, taskId: 4 })) as Record<string, unknown>;
    expect(remote.staleness).toEqual({ verdict: "unverifiable", reason: REMOTE_REASON });
    const memoryShow = s.cortex.calls().find(call => call.argv[1] === "show" && call.cwd !== s.checkout);
    expect(memoryShow?.cwd).toBe(fs.realpathSync(os.tmpdir()));
  });
});

describe("watch", () => {
  const line = (kind: string, payload: unknown) => JSON.stringify({ kind, cursor: "e:1", payload });

  test("routes every frame, including other shells' updates, and stops its child on abort", async () => {
    const fixture = baseFixture();
    fixture.watch = {
      lines: [
        JSON.stringify({ kind: "ready" }),
        line("update.posted", { id: 1, task_id: 1, author: `bb-${OTHER}`, summary: "s" }),
        line("update.posted", { id: 2, task_id: 2, author: "pi-0192", summary: "s" }),
        "not json",
        line("task.updated", { id: 3, lane: "cortex", title: "t" }),
        line("task.removed", { id: 9 }),
        line("task.blocked", { task: { id: 2, lane: "cortex" }, previous: "open", author: "x" }),
        line("notification.added", { id: 1 }),
      ],
    };
    const s = await setup({ fixture });
    const service = s.harness.behavior.runService("watch");
    await vi.waitFor(() => expect(s.harness.inspection.realtimeSignals).toHaveLength(7));
    expect(s.harness.inspection.realtimeSignals).toEqual([
      { channel: "all", payload: null },
      taskSignal(1),
      threadSignal(OTHER),
      taskSignal(2),
      taskSignal(3),
      taskSignal(9),
      taskSignal(2),
    ]);
    expect(s.harness.inspection.logEntries.some(entry => entry.message.includes("malformed"))).toBe(true);
    service.controller.abort();
    await service.done;
    expect(fs.existsSync(path.join(s.cortex.dir, "watch-terminated"))).toBe(true);
  });

  test("a line split inside a UTF-8 character still parses", async () => {
    const fixture = baseFixture();
    const bytes = [...Buffer.from(`${line("task.updated", { id: 5, lane: "caf\u00e9" })}\n`)];
    const cut = bytes.indexOf(0xc3) + 1;
    fixture.watch = { chunks: [bytes.slice(0, cut), bytes.slice(cut)] };
    const s = await setup({ fixture });
    const service = s.harness.behavior.runService("watch");
    await vi.waitFor(() => expect(s.harness.inspection.realtimeSignals).toEqual([taskSignal(5)]));
    service.controller.abort();
    await service.done;
  });

  test("an unexpected exit rejects so the host restarts the service", async () => {
    const fixture = baseFixture();
    fixture.watch = { exitCode: 2 };
    const s = await setup({ fixture });
    await expect(s.harness.behavior.runService("watch").done).rejects.toThrow(/watch gave up/);
  });

  test("ready re-warms cached primers after a debounce", async () => {
    const fixture = baseFixture();
    fixture.watch = { lines: [JSON.stringify({ kind: "resync" })] };
    const s = await setup({ fixture });
    await warm(s);
    const contexts = () => s.argvs().filter(argv => argv[1] === "context").length;
    expect(contexts()).toBe(1);
    const service = s.harness.behavior.runService("watch");
    await vi.waitFor(() => expect(contexts()).toBe(2), { timeout: 4000 });
    service.controller.abort();
    await service.done;
  });

  test("routeCortexEvent refreshes before it publishes and ignores malformed frames", () => {
    const order: string[] = [];
    const publish = (channel: string) => order.push(`publish:${channel}`);
    const refresh = (taskId: number | null, lane?: string) => order.push(`refresh:${taskId}:${lane ?? "-"}`);
    routeCortexEvent({ kind: "update.posted", payload: { task_id: 7, author: `bb-${THREAD}` } }, publish, refresh);
    routeCortexEvent({ kind: "task.added", payload: { id: 8, lane: "x" } }, publish, refresh);
    for (const bad of [null, 5, "x", { kind: 1 }, { kind: "update.posted", payload: { task_id: -1 } }, { kind: "task.updated" }]) {
      routeCortexEvent(bad, publish, refresh);
    }
    expect(order).toEqual(["refresh:7:-", "publish:task", "publish:thread", "refresh:8:x", "publish:task"]);
  });
});

describe("needs configuration", () => {
  test("a missing binary reports how to fix it, registers no tools or watch, and RPC explains why", async () => {
    const s = await setup({ cortexPath: "/nonexistent/cortex" });
    expect(s.harness.inspection.needsConfigurationMessages[0]).toMatch(/cortexPath.*bb plugin reload cortex/s);
    expect(s.harness.inspection.registrations.agentTools).toEqual([]);
    expect(s.harness.inspection.registrations.services).toEqual([]);
    await expect(s.harness.behavior.callRpc("threadState", { threadId: THREAD })).rejects.toThrow(/Cortex is unavailable/);
  });

  test("a cortex without watch is outdated", async () => {
    const s = await setup({ fixture: { ...baseFixture(), commands: ["memory"] } });
    expect(s.harness.inspection.needsConfigurationMessages[0]).toMatch(/cortex watch/);
  });
});

/** The base fixture for a cortex with `update --as-me` (doctor names the user). */
function writableFixture(): FakeFixture {
  const fixture = baseFixture();
  fixture.author = USER;
  return fixture;
}

const PLAN_BODY = [
  "# Plan: something",
  "",
  "## Low-Level Tasks",
  "",
  "1. CREATE the thing.",
  "```",
  "2. not a task: inside a fence",
  "```",
  "2. UPDATE the other thing.",
  "3. Test it.",
  "",
  "## Validation Gates",
  "4. not counted",
].join("\n");

describe("task detail", () => {
  test("times, update kinds, sync, plan progress and author labels", async () => {
    const fixture = writableFixture();
    fixture.tasks = {
      "7": task(7, { tags: ["plan"], body: PLAN_BODY, created: 1000, updated: 9000 }, {
        synced: 1500,
        staleness: { verdict: "stale", changed: ["src/a.ts"], missing: ["gone.ts"], old: true, ageDays: 40, behind: 3 },
        updates: [
          { id: 70, task_id: 7, author: `bb-${OTHER}`, summary: "created", body: null, created: 1000 },
          { id: 71, task_id: 7, author: `bb-${OTHER}`, summary: "task 1: did one", body: null, created: 2000 },
          { id: 72, task_id: 7, author: `bb-${GONE}`, summary: "task 3: did three", body: "- x", created: 3000 },
          { id: 73, task_id: 7, author: "pi-01a145fc-cdce-7707", summary: "task 3: again", body: null, created: 4000 },
          { id: 74, task_id: 7, author: USER, summary: "status \u2192 review", body: null, created: 5000 },
          { id: 75, task_id: 7, author: "planner-1a2b3c4d", summary: "task 9: out of range", body: null, created: 6000 },
        ],
      }),
    };
    const s = await setup({ fixture });
    const detail = (await s.harness.behavior.callRpc("task", { threadId: THREAD, taskId: 7 })) as Record<string, any>;
    expect(detail.task).toMatchObject({ id: 7, created: 1000, updated: 9000 });
    expect(detail.updates.map((u: Record<string, unknown>) => [u.id, u.kind, u.to ?? null])).toEqual([
      [70, "created", null],
      [71, "note", null],
      [72, "note", null],
      [73, "note", null],
      [74, "status", "review"],
      [75, "note", null],
    ]);
    expect("to" in detail.updates[0]).toBe(false);
    expect(detail.sync).toEqual({
      syncedAt: 1500,
      changed: ["src/a.ts"],
      missing: ["gone.ts"],
      old: true,
      ageDays: 40,
      notFolded: 3,
    });
    expect(detail.progress).toEqual({ done: 2, total: 3 });
    expect(detail.authors).toEqual({
      [`bb-${OTHER}`]: { kind: "thread", label: `Thread ${OTHER}`, threadId: OTHER },
      [`bb-${GONE}`]: { kind: "thread", label: GONE, threadId: GONE },
      "pi-01a145fc-cdce-7707": { kind: "pi", label: "pi session 01a145fc" },
      [USER]: { kind: "you", label: "You" },
      "planner-1a2b3c4d": { kind: "other", label: "planner-1a2b3c4d" },
    });
  });

  test("progress is null for a task not tagged plan, and authors never claim 'you' without doctor's author", async () => {
    const fixture = baseFixture();
    (fixture.tasks as Record<string, FakeTask>)["8"] = task(8, { body: PLAN_BODY }, {
      updates: [{ id: 80, task_id: 8, author: USER, summary: "task 1: x", body: null, created: 2000 }],
    });
    const s = await setup({ fixture });
    const detail = (await s.harness.behavior.callRpc("task", { threadId: THREAD, taskId: 8 })) as Record<string, any>;
    expect(detail.progress).toBeNull();
    expect(detail.authors[USER]).toEqual({ kind: "other", label: USER });
  });
});

describe("writes as the user", () => {
  test("doctor's author turns writes on; without it the tab is read-only and writes never run", async () => {
    const off = await setup();
    expect(off.argvs()).toContainEqual(["doctor", "--json"]);
    expect(await off.harness.behavior.callRpc("threadState", { threadId: THREAD })).toMatchObject({ canWrite: false });
    await expect(
      off.harness.behavior.callRpc("setStatus", { threadId: THREAD, taskId: 1, status: "done" }),
    ).rejects.toThrow(/Update cortex to change status from bb/);
    await expect(
      off.harness.behavior.callRpc("postNote", { threadId: THREAD, taskId: 1, text: "hi" }),
    ).rejects.toThrow(/Update cortex/);
    expect(off.argvs().filter(argv => argv[0] === "update")).toEqual([]);

    const on = await setup({ fixture: writableFixture() });
    expect(await on.harness.behavior.callRpc("threadState", { threadId: THREAD })).toMatchObject({ canWrite: true });
  });

  test("a failing doctor leaves the tab read-only and logs why", async () => {
    const s = await setup({ fixture: { ...writableFixture(), doctorFails: true } });
    expect(await s.harness.behavior.callRpc("threadState", { threadId: THREAD })).toMatchObject({ canWrite: false });
    expect(s.harness.inspection.logEntries.some(entry => entry.message.includes("read-only"))).toBe(true);
  });

  test("setStatus runs update --as-me, drops the cached reads, publishes, and returns the fresh detail", async () => {
    const s = await setup({ fixture: writableFixture() });
    const before = (await s.harness.behavior.callRpc("task", { threadId: THREAD, taskId: 1 })) as Record<string, any>;
    expect(before.task.status).toBe("open");
    const after = (await s.harness.behavior.callRpc("setStatus", {
      threadId: THREAD,
      taskId: 1,
      status: "done",
    })) as Record<string, any>;
    expect(s.argvs()).toContainEqual(["update", "1", "--as-me", "--status=done", "--json"]);
    expect(after.task.status).toBe("done");
    expect(after.updates.at(-1)).toMatchObject({ author: USER, kind: "status", to: "done" });
    expect(after.authors[USER]).toEqual({ kind: "you", label: "You" });
    expect(s.harness.inspection.realtimeSignals).toEqual(expect.arrayContaining([threadSignal(THREAD), taskSignal(1)]));
    // The thread's list shows the new status too: its stream rows were dropped.
    const shows = s.argvs().filter(argv => argv[0] === "show" && argv[1] === "1").length;
    expect(shows).toBe(2);
  });

  test("setStatus validates its input and surfaces a CLI failure", async () => {
    const s = await setup({ fixture: { ...writableFixture(), updateFails: "task 1 is locked" } });
    for (const input of [
      { threadId: THREAD, taskId: 1, status: "bogus" },
      { threadId: THREAD, taskId: 0, status: "done" },
      { threadId: "nope", taskId: 1, status: "done" },
    ]) {
      await expect(s.harness.behavior.callRpc("setStatus", input)).rejects.toThrow();
    }
    expect(s.argvs().filter(argv => argv[0] === "update")).toEqual([]);
    await expect(
      s.harness.behavior.callRpc("setStatus", { threadId: THREAD, taskId: 1, status: "done" }),
    ).rejects.toThrow(/task 1 is locked/);
  });

  test("postNote: the first non-empty line is -m, the trimmed rest -b, with an optional status", async () => {
    const s = await setup({ fixture: writableFixture() });
    const detail = (await s.harness.behavior.callRpc("postNote", {
      threadId: THREAD,
      taskId: 4,
      text: "\n  -first line  \n\n  - a\n  - b\n\n",
      status: "review",
    })) as Record<string, any>;
    expect(s.argvs()).toContainEqual([
      "update",
      "4",
      "--as-me",
      "--message=-first line",
      "--body=- a\n  - b",
      "--status=review",
      "--json",
    ]);
    expect(detail.task.status).toBe("review");
    expect(detail.updates.slice(-2).map((u: Record<string, unknown>) => [u.kind, u.summary])).toEqual([
      ["note", "-first line"],
      ["status", "status \u2192 review"],
    ]);
    await s.harness.behavior.callRpc("postNote", { threadId: THREAD, taskId: 4, text: "only a summary" });
    expect(s.argvs()).toContainEqual(["update", "4", "--as-me", "--message=only a summary", "--json"]);
    expect(s.harness.inspection.realtimeSignals).toEqual(expect.arrayContaining([threadSignal(THREAD), taskSignal(4)]));
  });

  test("postNote rejects an empty note or an over-long first line before any CLI call", async () => {
    const s = await setup({ fixture: writableFixture() });
    for (const text of ["", "   \n \n", "x".repeat(4097)]) {
      await expect(s.harness.behavior.callRpc("postNote", { threadId: THREAD, taskId: 4, text })).rejects.toThrow();
    }
    await expect(
      s.harness.behavior.callRpc("postNote", { threadId: THREAD, taskId: 4, text: "x", status: "nope" }),
    ).rejects.toThrow();
    expect(s.argvs().filter(argv => argv[0] === "update")).toEqual([]);
  });
});

describe("finding tasks", () => {
  test("searchTasks: a number or #n loads that task; words search; at most 8 rows, without bodies", async () => {
    const fixture = baseFixture();
    const tasks = fixture.tasks as Record<string, FakeTask>;
    for (let id = 10; id < 20; id++) tasks[String(id)] = task(id, { title: `Widget ${id}` });
    const s = await setup({ fixture });
    const search = (query: string) =>
      s.harness.behavior.callRpc("searchTasks", { query }) as Promise<{ tasks: Array<Record<string, unknown>> }>;
    expect((await search("4")).tasks).toEqual([{ id: 4, title: "Stale one", lane: "cortex", status: "open" }]);
    expect((await search(" #2 ")).tasks).toEqual([{ id: 2, title: "Task 2", lane: "cortex", status: "blocked" }]);
    expect((await search("999")).tasks).toEqual([]);
    const widgets = (await search("widget")).tasks;
    expect(widgets).toHaveLength(8);
    expect(Object.keys(widgets[0] ?? {}).sort()).toEqual(["id", "lane", "status", "title"]);
    expect(s.argvs()).toContainEqual(["search", "widget", "--json"]);
    await search("--widget");
    expect(s.argvs()).toContainEqual(["search", "widget", "--json"]);
    const before = s.argvs().length;
    expect((await search("--")).tasks).toEqual([]);
    expect(s.argvs().length).toBe(before);
    await expect(s.harness.behavior.callRpc("searchTasks", { query: "   " })).rejects.toThrow();
  });

  test("recentTasks: the thread's lane, five newest not done; every lane when the lane is unknown", async () => {
    const fixture = baseFixture();
    const tasks = fixture.tasks as Record<string, FakeTask>;
    for (let id = 10; id < 18; id++) {
      tasks[String(id)] = task(id, { updated: 10_000 + id, status: id === 17 ? "done" : "open" });
    }
    tasks["30"] = task(30, { lane: "elsewhere", updated: 99_999 });
    const s = await setup({ fixture });
    await warm(s);
    const recent = (await s.harness.behavior.callRpc("recentTasks", { threadId: THREAD })) as {
      lane: string | null;
      tasks: Array<{ id: number }>;
    };
    expect(s.argvs()).toContainEqual(["ls", "--lane=cortex", "--json"]);
    expect(recent.lane).toBe("cortex");
    expect(recent.tasks.map(row => row.id)).toEqual([16, 15, 14, 13, 12]);
    const remote = (await s.harness.behavior.callRpc("recentTasks", { threadId: REMOTE })) as { lane: string | null };
    expect(remote.lane).toBe("cortex");
  });

  test("recentTasks lists every lane before any primer is cached", async () => {
    const fixture = baseFixture();
    (fixture.tasks as Record<string, FakeTask>)["30"] = task(30, { lane: "elsewhere", updated: 99_999 });
    const s = await setup({ fixture });
    const recent = (await s.harness.behavior.callRpc("recentTasks", { threadId: REMOTE })) as {
      lane: string | null;
      tasks: Array<{ id: number }>;
    };
    expect(recent.lane).toBeNull();
    expect(s.argvs()).toContainEqual(["ls", "--json"]);
    expect(recent.tasks[0]?.id).toBe(30);
  });

  test("threadState marks which tasks the thread posted to", async () => {
    const s = await setup();
    await s.harness.behavior.callRpc("link", { threadId: THREAD, taskId: 3 });
    await s.harness.behavior.callRpc("link", { threadId: THREAD, taskId: 1 });
    const state = (await s.harness.behavior.callRpc("threadState", { threadId: THREAD })) as {
      links: Array<{ id: number; authored: boolean; manual: boolean }>;
    };
    expect(state.links.map(link => [link.id, link.authored, link.manual])).toEqual([
      [1, true, true],
      [3, false, true],
      [2, true, false],
    ]);
  });
});
