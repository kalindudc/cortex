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
import type { MemoryView } from "./memory";
import plugin, { instructionsFor, USAGE, usageFor } from "./server";
import { REMOTE_REASON } from "./state";
import { routeCortexEvent } from "./watch";

const THREAD = "thr_aaaaaaaa";
const REMOTE = "thr_bbbbbbbb";
const OTHER = "thr_cccccccc";
/** A thread whose title lookup fails. */
const GONE = "thr_ffffffff";
/** A top-level pi thread, and a pi thread started by it. */
const PI = "thr_pppppppp";
const PI_CHILD = "thr_qqqqqqqq";
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
  /** Threads whose lookup fails from now on. */
  const broken = new Set<string>();
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => {
        if (threadId === GONE || broken.has(threadId)) throw new Error("HTTP 404: thread not found");
        return makeThreadResponse({
          id: threadId,
          projectId: PROJECT,
          title: `Thread ${threadId}`,
          environmentId: threadId === REMOTE ? "env_remote" : "env_local",
          ...(threadId === PI || threadId === PI_CHILD ? { providerId: "pi" } : {}),
          ...(threadId === PI_CHILD ? { parentThreadId: PI } : {}),
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
  const resolve = (
    providerId: string,
    over: { thread?: { id?: string; parentThreadId?: string | null }; pluginMetadata?: Record<string, string> } = {},
  ) =>
    harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ provider: { id: providerId }, project: { id: PROJECT }, ...over }),
    );
  return { bb, harness, cortex, checkout, metadata, broken, argvs, resolve };
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
    expect(await call("@4")).toBe(
      `TEXT memory show 4 cwd=${s.checkout}\nstaleness: stale \u00b7 synced 2026-01-01 (1d) \u00b7 changed: src/a.ts\n`,
    );
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

  test("a changed task refreshes every cached primer that lists it, even one for another lane", async () => {
    const fixture = baseFixture();
    // This project's primer is for lane "other" but lists task 1 (lane cortex) among other lanes' streams.
    fixture.context = { lane: "other", primer: "PRIMER", primerIds: [1] };
    fixture.watch = { lines: [line("task.updated", { id: 1, lane: "cortex" })] };
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

  test("setMemoryExcluded runs memory exclude|include, drops cached reads, publishes, and returns the fresh detail", async () => {
    const s = await setup({ fixture: writableFixture() });
    const before = (await s.harness.behavior.callRpc("task", { threadId: THREAD, taskId: 1 })) as Record<string, any>;
    // The fixture's cortex prints no memory_excluded, like one that predates exclusion.
    expect(before.task.memoryExcluded).toBeNull();
    const excluded = (await s.harness.behavior.callRpc("setMemoryExcluded", {
      threadId: THREAD,
      taskId: 1,
      excluded: true,
    })) as Record<string, any>;
    expect(s.argvs()).toContainEqual(["memory", "exclude", "1", "--json"]);
    expect(excluded.task.memoryExcluded).toBe(true);
    expect(s.harness.inspection.realtimeSignals).toEqual(expect.arrayContaining([threadSignal(THREAD), taskSignal(1)]));
    const included = (await s.harness.behavior.callRpc("setMemoryExcluded", {
      threadId: THREAD,
      taskId: 1,
      excluded: false,
    })) as Record<string, any>;
    expect(s.argvs()).toContainEqual(["memory", "include", "1", "--json"]);
    expect(included.task.memoryExcluded).toBe(false);
    await expect(
      s.harness.behavior.callRpc("setMemoryExcluded", { threadId: THREAD, taskId: 1, excluded: "yes" }),
    ).rejects.toThrow();
  });

  test("the thread's list asks for excluded tasks too: it is the user's own view", async () => {
    const s = await setup();
    await s.harness.behavior.callRpc("threadState", { threadId: THREAD });
    expect(s.argvs()).toContainEqual(["memory", "streams", `--author=bb-${THREAD}`, "--with-excluded", "--json"]);
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

function memoryView(over: Partial<MemoryView> = {}): MemoryView {
  return {
    role: "writer",
    lane: "cortex",
    error: "",
    stale: null,
    saving: false,
    recallBudget: 2,
    focus: [],
    inContext: [],
    stats: { prompts: 0, lookups: 0, lastMs: 0, chars: 0, checkpoints: 0, breadcrumbs: 0, silentRuns: 0 },
    ...over,
  };
}

describe("memory", () => {
  const REPORT_URL: [string, unknown] = ["CORTEX_BB_MEMORY_URL", { serverPath: "/api/v1/plugins/cortex/http/memory" }];
  const pairs = (entries: Array<{ name: string; value: unknown }>) => entries.map(entry => [entry.name, entry.value]);
  const env = async (s: Setup, threadId: string) =>
    pairs(await s.harness.behavior.resolveProviderEnv("pi", { threadId, projectId: PROJECT, hostId: "host_local" }));
  const rpc = (s: Setup, method: string, input: unknown) =>
    s.harness.behavior.callRpc(method, input) as Promise<Record<string, any>>;
  const memory = (s: Setup, threadId: string) => rpc(s, "memory", { threadId });
  const post = (s: Setup, body: unknown) =>
    s.harness.behavior.fetchHttp("POST", "/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const memorySignals = (s: Setup) => s.harness.inspection.realtimeSignals.filter(signal => signal.channel === "memory");
  const names = (tools: Array<{ name: string }>) => tools.map(tool => tool.name).sort();

  test("four settings with their defaults; a change applies to the next configure and environment and signals every thread", async () => {
    const s = await setup();
    const descriptors = s.harness.inspection.registrations.settingsDescriptors;
    expect(Object.keys(descriptors)).toEqual(["cortexPath", "memory", "memoryChip", "taskChip"]);
    expect(descriptors.memory).toMatchObject({
      type: "select",
      label: "Agent memory",
      options: ["auto", "write", "read", "off"],
      default: "auto",
    });
    expect(descriptors.memoryChip).toMatchObject({ type: "boolean", label: "Memory icon", default: true });
    expect(descriptors.taskChip).toMatchObject({ type: "boolean", label: "Task chip in the thread header", default: true });
    await warm(s);
    expect(await env(s, PI)).toEqual([REPORT_URL]);
    await s.harness.behavior.setSettings({ memory: "read" });
    expect(memorySignals(s)).toContainEqual({ channel: "memory", payload: null });
    expect((await s.resolve("codex")).instructions).toBe(USAGE);
    expect(await env(s, PI)).toEqual([REPORT_URL, ["CORTEX_MEMORY", "read"]]);
  });

  test("configure: the summary only when saving, no recall when off, child threads look up only, the thread's choice wins", async () => {
    const s = await setup();
    await warm(s);
    const write = await s.resolve("codex");
    expect(write.instructions).toContain("<cortex_memory>");
    expect(names(write.tools)).toEqual(["cortex_recall", "cortex_update"]);
    const child = await s.resolve("codex", { thread: { parentThreadId: THREAD } });
    expect(child.instructions).toBe(USAGE);
    expect(names(child.tools)).toEqual(["cortex_recall", "cortex_update"]);

    await s.harness.behavior.setSettings({ memory: "read" });
    const read = await s.resolve("codex");
    expect(read.instructions).toBe(USAGE);
    expect(names(read.tools)).toEqual(["cortex_recall", "cortex_update"]);

    await s.harness.behavior.setSettings({ memory: "off" });
    const off = await s.resolve("codex");
    expect(names(off.tools)).toEqual(["cortex_update"]);
    expect(off.instructions).toBe(usageFor(false));
    expect(off.instructions).toContain("One tool uses it:");
    expect(off.instructions).not.toContain("cortex_recall");
    expect(off.instructions).not.toContain("Memory is a hint");

    expect((await s.resolve("codex", { pluginMetadata: { memoryMode: "write" } })).instructions).toContain(
      "<cortex_memory>",
    );
    expect(names((await s.resolve("codex", { pluginMetadata: { memoryMode: "always" } })).tools)).toEqual([
      "cortex_update",
    ]);
    const pi = await s.resolve("pi");
    expect(pi.tools).toEqual([]);
    expect(pi.instructions ?? "").toBe("");
  });

  test("pi environment: the report address always, CORTEX_MEMORY only to look up only or turn off, never write", async () => {
    const s = await setup();
    expect(await env(s, PI)).toEqual([REPORT_URL]);
    expect(await env(s, PI_CHILD)).toEqual([REPORT_URL, ["CORTEX_MEMORY", "read"]]);
    s.metadata.set(PI, { memoryMode: "off" });
    expect(await env(s, PI)).toEqual([REPORT_URL, ["CORTEX_MEMORY", "off"]]);
    s.metadata.set(PI_CHILD, { memoryMode: "write" });
    expect(await env(s, PI_CHILD)).toEqual([REPORT_URL]);
    s.metadata.delete(PI_CHILD);
    await s.harness.behavior.setSettings({ memory: "write" });
    expect(await env(s, PI_CHILD)).toEqual([REPORT_URL]);
    const entries = await s.harness.behavior.resolveProviderEnv("pi", { threadId: PI, projectId: PROJECT, hostId: "h" });
    expect(entries.every(entry => entry.reason.length > 0)).toBe(true);
  });

  test("a failed lookup repeats the thread's last entries, or the setting's for a top-level thread", async () => {
    const s = await setup();
    expect(await env(s, PI_CHILD)).toEqual([REPORT_URL, ["CORTEX_MEMORY", "read"]]);
    s.broken.add(PI_CHILD);
    await s.harness.behavior.setSettings({ memory: "off" });
    expect(await env(s, PI_CHILD)).toEqual([REPORT_URL, ["CORTEX_MEMORY", "read"]]);
    s.broken.add(PI);
    expect(await env(s, PI)).toEqual([REPORT_URL, ["CORTEX_MEMORY", "off"]]);
    await s.harness.behavior.setSettings({ memory: "auto" });
    expect(await env(s, PI)).toEqual([REPORT_URL]);
    expect(s.harness.inspection.logEntries.some(entry => entry.message.includes("its environment stays"))).toBe(true);
  });

  test("a valid report is stored and signalled, and its answer carries the last re-read; an older report is ignored", async () => {
    const s = await setup();
    const first = await post(s, { threadId: PI, sentAt: 100, view: memoryView({ focus: [1] }) });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ refreshAt: 0 });
    expect(memorySignals(s)).toEqual([{ channel: "memory", payload: { threadId: PI } }]);
    const stored = await memory(s, PI);
    expect(stored).toMatchObject({ pi: true, child: false, setting: "auto", override: null, mode: "write", refreshAt: 0 });
    expect(stored.view).toEqual(memoryView({ focus: [1] }));
    expect(stored.reportedAt).toBeGreaterThan(0);

    const asked = await rpc(s, "refreshMemory", { threadId: PI });
    expect(asked.refreshAt).toBeGreaterThan(0);
    const older = await post(s, { threadId: PI, sentAt: 50, view: memoryView({ focus: [2] }) });
    expect(older.status).toBe(200);
    expect(await older.json()).toEqual({ refreshAt: asked.refreshAt });
    expect((await memory(s, PI)).view.focus).toEqual([1]);
    expect(memorySignals(s)).toHaveLength(2);
  });

  test("the route rejects invalid JSON, a bad thread id, an over-long list and a body over 256 KiB, storing nothing", async () => {
    const s = await setup();
    const valid = { threadId: PI, sentAt: 1, view: memoryView() };
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, via: "recall" as const }));
    const cases: Array<[unknown, number]> = [
      ["{not json", 400],
      [{ ...valid, threadId: "thread-1" }, 400],
      [{ ...valid, sentAt: -1 }, 400],
      [{ ...valid, view: memoryView({ inContext: rows }) }, 400],
      [{ ...valid, pad: "x".repeat(300 * 1024) }, 413],
    ];
    for (const [body, status] of cases) expect((await post(s, body)).status).toBe(status);
    expect((await memory(s, PI)).view).toBeNull();
    expect(memorySignals(s)).toEqual([]);
  });

  test("another provider's view: the summary, recalls, a stale or failed recall, and thread.active clears stale", async () => {
    const fixture = baseFixture();
    fixture.context = { lane: "cortex", primer: "PRIMER: [1] open \u00b7 cortex", primerIds: [1, 3] };
    const s = await setup({ fixture });
    await warm(s);
    await s.resolve("codex", { thread: { id: THREAD } });
    expect(memorySignals(s)).toContainEqual({ channel: "memory", payload: { threadId: THREAD } });
    const first = await memory(s, THREAD);
    expect(first).toMatchObject({ pi: false, child: false, mode: "write" });
    expect(first.view).toEqual(
      memoryView({
        recallBudget: 3,
        inContext: [
          { id: 3, via: "summary" },
          { id: 1, via: "summary" },
        ],
        stats: { ...memoryView().stats, chars: "PRIMER: [1] open \u00b7 cortex".length },
      }),
    );

    const call = (query: string) => s.harness.behavior.callAgentTool("cortex_recall", { query }, { threadId: THREAD });
    await call("@4");
    let view = (await memory(s, THREAD)).view;
    expect(view.stale).toEqual({ id: 4, detail: "changed: src/a.ts" });
    expect(view.inContext[0]).toEqual({ id: 4, via: "recall" });
    expect(view.focus).toEqual([4]);
    expect(view.stats.lookups).toBe(1);
    await expect(call("@77")).rejects.toThrow(/not found/);
    view = (await memory(s, THREAD)).view;
    expect(view.error).toMatch(/task 77 not found/);
    expect(view.stale?.id).toBe(4);

    await s.harness.behavior.callAgentTool("cortex_update", { task_id: 2, message: "x" }, { threadId: THREAD });
    view = (await memory(s, THREAD)).view;
    expect(view.focus).toEqual([2, 4]);
    expect(view.error).toBe("");
    await expect(
      s.harness.behavior.callAgentTool("cortex_update", { task_id: 77, message: "x" }, { threadId: THREAD }),
    ).rejects.toThrow(/not found/);
    expect((await memory(s, THREAD)).view.error).toMatch(/task 77 not found/);

    await s.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: THREAD, projectId: PROJECT }),
    });
    expect((await memory(s, THREAD)).view.stale).toBeNull();
    await s.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: THREAD }) });
    expect((await memory(s, THREAD)).view).toBeNull();
  });

  test("another provider's view follows its next configure after a mode change, keeping what it recalled", async () => {
    const s = await setup();
    await s.resolve("codex", { thread: { id: THREAD } });
    await s.harness.behavior.callAgentTool("cortex_recall", { query: "@1" }, { threadId: THREAD });
    expect((await memory(s, THREAD)).view).toMatchObject({ role: "writer", inContext: [{ id: 1, via: "recall" }] });
    await rpc(s, "setMemoryMode", { threadId: THREAD, mode: "read" });
    expect(s.metadata.get(THREAD)).toEqual({ memoryMode: "read" });
    const signals = memorySignals(s).length;
    // bb passes the thread's plugin metadata to configure.
    await s.resolve("codex", { thread: { id: THREAD }, pluginMetadata: { memoryMode: "read" } });
    expect(memorySignals(s)).toHaveLength(signals + 1);
    const after = await memory(s, THREAD);
    expect(after).toMatchObject({ override: "read", mode: "read" });
    expect(after.view).toMatchObject({ role: "reader", inContext: [{ id: 1, via: "recall" }], focus: [1] });
    await s.resolve("codex", { thread: { id: THREAD }, pluginMetadata: { memoryMode: "read" } });
    expect(memorySignals(s)).toHaveLength(signals + 1);
  });

  test("setMemoryMode sets and removes the thread's choice; taskRows runs one ls in id order; re-reading is for pi", async () => {
    const s = await setup();
    expect(await rpc(s, "setMemoryMode", { threadId: THREAD, mode: "read" })).toMatchObject({
      override: "read",
      mode: "read",
    });
    expect(s.metadata.get(THREAD)).toEqual({ memoryMode: "read" });
    expect(memorySignals(s)).toEqual([{ channel: "memory", payload: { threadId: THREAD } }]);
    expect(await rpc(s, "setMemoryMode", { threadId: THREAD, mode: null })).toMatchObject({
      override: null,
      mode: "write",
    });
    expect(s.metadata.get(THREAD)).toEqual({});
    await rpc(s, "setMemoryMode", { threadId: THREAD, mode: "off" });
    await rpc(s, "pin", { threadId: THREAD, taskId: 1 });
    expect(s.metadata.get(THREAD)).toMatchObject({ memoryMode: "off", pinnedTaskId: 1 });
    await expect(rpc(s, "setMemoryMode", { threadId: THREAD, mode: "save" })).rejects.toThrow();

    const before = s.argvs().length;
    const rows = await rpc(s, "taskRows", { ids: [4, 99, 1] });
    expect(rows.tasks).toEqual([
      { id: 4, title: "Stale one", lane: "cortex", status: "open" },
      { id: 1, title: "Task 1", lane: "cortex", status: "open" },
    ]);
    expect(s.argvs().slice(before)).toEqual([["ls", "--json"]]);

    await expect(rpc(s, "refreshMemory", { threadId: THREAD })).rejects.toThrow(/Re-reading applies to pi threads/);
    expect(await memory(s, PI)).toMatchObject({ pi: true, view: null, reportedAt: null, refreshAt: 0 });
    const asked = await rpc(s, "refreshMemory", { threadId: PI });
    expect(asked.refreshAt).toBeGreaterThan(0);
    expect((await memory(s, PI)).refreshAt).toBe(asked.refreshAt);
    expect(await memory(s, PI_CHILD)).toMatchObject({ pi: true, child: true, mode: "read" });
  });

  test("the memory RPCs explain why when cortex is missing", async () => {
    const s = await setup({ cortexPath: "/nonexistent/cortex" });
    const calls: Array<[string, unknown]> = [
      ["memory", { threadId: THREAD }],
      ["taskRows", { ids: [1] }],
      ["setMemoryMode", { threadId: THREAD, mode: null }],
      ["refreshMemory", { threadId: PI }],
    ];
    for (const [method, input] of calls) {
      await expect(s.harness.behavior.callRpc(method, input)).rejects.toThrow(/Cortex is unavailable/);
    }
  });
});
