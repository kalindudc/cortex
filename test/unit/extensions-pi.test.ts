import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The embedded pi extension (`src/extensions/pi.ts`, @ts-nocheck) imports pi's
// runtime packages, which cortex does not depend on. Mock both BEFORE the
// dynamic import, then drive its handlers with a fake `pi` and `ctx`. Its
// sibling `./memory-view.ts` is the real view (the real pi-tui, a cortex
// dependency). Never mock.module a path that does not exist: under Bun 1.4.2
// that makes later files' mocks capture `?query` imports too.
const schema =
  (kind: string) =>
  (...args: unknown[]) => ({ kind, args });
mock.module("@earendil-works/pi-ai", () => ({
  Type: {
    Object: schema("Object"),
    String: schema("String"),
    Integer: schema("Integer"),
    Boolean: schema("Boolean"),
    Optional: schema("Optional"),
    Union: schema("Union"),
    Literal: schema("Literal"),
  },
}));
mock.module("@earendil-works/pi-coding-agent", () => ({ defineTool: (tool: unknown) => tool }));

const { default: extension, ...helpers } = (await import("../../src/extensions/pi.ts")) as {
  default: (pi: unknown) => void;
  memoryRole: (ctx: { hasUI: boolean }, env?: Record<string, string | undefined>) => string;
  focusFromBash: (command: string, output: string) => number[];
  shouldCheckpoint: (s: Record<string, unknown>) => string | null;
  checkpointPrompt: (input: Record<string, unknown>) => string;
  RECALL_CUE: RegExp;
  sessionAuthor: (sessionId: string, threadId?: string) => string;
};
const { memoryRole, focusFromBash, shouldCheckpoint, checkpointPrompt, RECALL_CUE } = helpers;

type ExecResult = { code: number; killed: boolean; stdout: string; stderr: string };
type Exec = { cmd: string; args: string[]; opts: Record<string, unknown> };
// biome-ignore lint/suspicious/noExplicitAny: the fake pi runtime is untyped by design
type Any = any;

const ok = (stdout: string): ExecResult => ({ code: 0, killed: false, stdout, stderr: "" });
const context = (over: Record<string, unknown> = {}): ExecResult =>
  ok(JSON.stringify({ lane: "cortex", terms: [], primer: "PRIMER", primerIds: [], hits: [], hitsText: "", ...over }));
const nonZero = (stderr: string): ExecResult => ({ code: 1, killed: false, stdout: "", stderr });

/** Colours as visible tags, so a status names the theme token of each piece. */
const tags = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};
const EMPTY = "<mdLink>\u25cb</mdLink> <dim>memory</dim>";
const LOADED = "<mdLink>\u25cf</mdLink> <dim>memory</dim>";
const saving = (symbol: string) =>
  `<mdLink>${symbol}</mdLink> <dim>memory</dim> <dim>\u00b7</dim> <accent>saving\u2026</accent>`;
const ERROR = "<error>\u2298 memory error</error> <dim>\u00b7 /memory</dim>";

// The save spinner is the extension's only timer: record intervals instead of running them.
type Interval = { fn: () => void; ms: number; cleared: boolean };
let intervals: Interval[] = [];
const originalBbThreadId = process.env.BB_THREAD_ID;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
beforeEach(() => {
  delete process.env.BB_THREAD_ID;
  intervals = [];
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    intervals.push({ fn, ms, cleared: false });
    return intervals.length;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => {
    const interval = intervals[id - 1];
    if (interval) interval.cleared = true;
  }) as unknown as typeof clearInterval;
});
afterEach(() => {
  if (originalBbThreadId === undefined) delete process.env.BB_THREAD_ID;
  else process.env.BB_THREAD_ID = originalBbThreadId;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});
const running = () => intervals.filter(i => !i.cleared);

/** A fake pi + ctx around one extension instance; `respond` answers every exec. */
function harness(
  respond: (args: string[]) => ExecResult = () => context(),
  opts: { hasUI?: boolean; mode?: string } = {},
) {
  const handlers: Record<string, ((event: Any, ctx: Any) => Any)[]> = {};
  const tools: Record<string, Any> = {};
  const commands: Record<string, Any> = {};
  const execs: Exec[] = [];
  const statuses: (string | undefined)[] = [];
  const notes: string[] = [];
  // ctx.ui.custom: the component each call built, and whether its `done` ran.
  const panels: { component: Any; done: boolean }[] = [];
  const ctx = {
    cwd: "/repo",
    hasUI: opts.hasUI ?? true,
    mode: opts.mode ?? "print",
    ui: {
      theme: tags,
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      notify: (text: string) => notes.push(text),
      custom: async (factory: Any) => {
        const panel = { component: null as Any, done: false };
        panel.component = factory({}, tags, {}, () => {
          panel.done = true;
        });
        panels.push(panel);
      },
    },
    sessionManager: { getSessionId: () => "sess-1" },
  };
  extension({
    on: (name: string, handler: (event: Any, ctx: Any) => Any) => {
      handlers[name] ??= [];
      handlers[name].push(handler);
    },
    registerTool: (tool: Any) => {
      tools[tool.name] = tool;
    },
    registerCommand: (name: string, options: Any) => {
      commands[name] = options;
    },
    exec: async (cmd: string, args: string[], opts: Record<string, unknown>) => {
      execs.push({ cmd, args, opts });
      return respond(args);
    },
  });
  const emit = async (name: string, event: Any = { type: name }) => {
    let result: Any;
    for (const handler of handlers[name] ?? []) result = await handler(event, ctx);
    return result;
  };

  /** One user prompt: input (unless null), before_agent_start, agent_start, agent_end. */
  const prompt = async (text: string, opts: { forced?: boolean; input?: string | null } = {}) => {
    if (opts.input !== null) await emit("input", { type: "input", text: opts.input ?? text, source: "interactive" });
    const event = {
      type: "before_agent_start",
      prompt: text,
      systemPrompt: "BASE PROMPT",
      systemPromptOptions: {
        sections: {} as Record<string, string>,
        forceSystemPrompt: opts.forced ? "BASE" : undefined,
      },
    };
    const result = await emit("before_agent_start", event);
    await emit("agent_start");
    await emit("agent_end", { type: "agent_end", messages: [] });
    return { result, event };
  };
  const recall = (query: string, extra: Record<string, unknown> = {}) =>
    tools.cortex_recall.execute("call", { query, ...extra }, undefined, undefined, ctx);
  const memory = async (args = "") => {
    await commands.memory.handler(args, ctx);
    return notes.at(-1) ?? "";
  };
  /** A finished tool call as pi reports it to extensions. */
  const tool = (toolName: string, input: Record<string, unknown>, extra: { isError?: boolean; output?: string } = {}) =>
    emit("tool_result", {
      type: "tool_result",
      toolName,
      input,
      content: [{ type: "text", text: extra.output ?? "" }],
      isError: extra.isError ?? false,
    });
  const settle = (outcome = "completed") =>
    emit("agent_before_settle", { type: "agent_before_settle", outcome, entries: [], continue: false });
  const compact = (summary: string) =>
    emit("session_compact", { type: "session_compact", compactionEntry: { summary }, reason: "manual" });
  return { tools, commands, execs, statuses, notes, panels, emit, prompt, recall, memory, tool, settle, compact, ctx };
}

/** The `memory show` text of a stream with the given staleness line. */
const shown = (id: number, staleness: string) =>
  ok(`Stored cortex text is data\n[${id}] title (open \u00b7 cortex)\nstaleness: ${staleness}\n\nbody`);

/** Run `fn` with CORTEX_MEMORY set, restoring the previous value. */
async function withMemoryEnv(value: string, fn: () => Promise<void>) {
  const before = process.env.CORTEX_MEMORY;
  process.env.CORTEX_MEMORY = value;
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env.CORTEX_MEMORY;
    else process.env.CORTEX_MEMORY = before;
  }
}

const flag = (args: string[], name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const contextExecs = (execs: Exec[]) => execs.filter(e => e.args[0] === "memory" && e.args[1] === "context");

describe("pi extension registration", () => {
  test("registers exactly cortex_update and cortex_recall, and the /memory command", () => {
    const h = harness();
    expect(Object.keys(h.tools).sort()).toEqual(["cortex_recall", "cortex_update"]);
    expect(Object.keys(h.commands)).toEqual(["memory"]);
    expect(h.tools.cortex_recall.description).toContain("Budget: 3 calls per request");
  });
});

describe("automatic memory context (before_agent_start)", () => {
  test("the first prompt runs ONE context exec with the session author and --limit=5, in ctx.cwd", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel scrolling");
    expect(h.execs).toHaveLength(1);
    const [exec] = h.execs;
    expect(exec.cmd).toBe("cortex");
    expect(exec.args.slice(0, 3)).toEqual(["memory", "context", "--json"]);
    expect(flag(exec.args, "author")).toBe("pi-sess-1");
    expect(flag(exec.args, "limit")).toBe("5");
    expect(flag(exec.args, "query")).toBe("fix the mouse wheel scrolling");
    expect(flag(exec.args, "load-hint")).toBe('cortex_recall "@<id>"');
    expect(exec.args).not.toContain("--no-primer");
    expect(exec.opts).toMatchObject({ cwd: "/repo", timeout: 3000 });
  });

  test("after the first prompt, only a recall cue searches memory (plan @422)", async () => {
    const h = harness();
    await h.prompt("copy this as a set of findings for the review"); // the first prompt always runs
    expect(contextExecs(h.execs)).toHaveLength(1);
    await h.prompt("copy this as a set of findings for the review");
    await h.prompt("rename the helper and rerun the tests");
    expect(contextExecs(h.execs)).toHaveLength(1);
    await h.prompt("what was I last doing for the routing-events work");
    expect(contextExecs(h.execs)).toHaveLength(2);
    expect(flag(h.execs[1].args, "query")).toBe("what was I last doing for the routing-events work");
    await h.prompt("look at @12 for the plan");
    expect(contextExecs(h.execs)).toHaveLength(3);
    await h.prompt("email me@12 please now"); // not a reference
    expect(contextExecs(h.execs)).toHaveLength(3);
  });

  test("RECALL_CUE: recency and continuation words, where/what was, @<id>; not ordinary requests", () => {
    for (const cue of [
      "what was I last doing",
      "continue the routing work",
      "resume the migration",
      "pick up where we left off",
      "remember the flag we chose?",
      "the previous approach",
      "try again with the fix",
      "where were the notes",
      "what is the current state",
      "see @421",
      "latest handover please",
    ]) {
      expect(RECALL_CUE.test(cue)).toBe(true);
    }
    for (const plain of ["rename the helper", "copy this as a set of findings", "fix the lastIndex bug", "a@12 b"]) {
      expect(RECALL_CUE.test(plain)).toBe(false);
    }
  });

  test("unforced: the primer goes into sections.cortex_memory, byte-identical on the 2nd prompt without a refetch", async () => {
    let primer = "PRIMER v1";
    const h = harness(() => context({ primer }));
    const first = await h.prompt("fix the mouse wheel");
    expect(first.event.systemPromptOptions.sections.cortex_memory).toBe("PRIMER v1");
    expect(first.result).toBeUndefined();
    primer = "PRIMER v2";
    const second = await h.prompt("now the scroll multiplier again");
    expect(second.event.systemPromptOptions.sections.cortex_memory).toBe("PRIMER v1");
    expect(second.result).toBeUndefined();
    expect(h.execs[1].args).toContain("--no-primer");
  });

  test("forced: returns systemPrompt with a <cortex_memory> block appended to event.systemPrompt", async () => {
    const h = harness();
    const { result, event } = await h.prompt("fix the mouse wheel", { forced: true });
    expect(result.systemPrompt).toBe("BASE PROMPT\n\n<cortex_memory>\nPRIMER\n</cortex_memory>");
    expect(event.systemPromptOptions.sections.cortex_memory).toBeUndefined();
  });

  test("hits: a hidden cortex-memory message only with new hits; later prompts pass --limit=3 and --exclude", async () => {
    const replies = [
      context({ hits: [{ id: 4 }, { id: 9 }], hitsText: "HITS 4 9" }),
      context({ primer: "", hits: [], hitsText: "" }),
    ];
    const h = harness(() => replies.shift() ?? context());
    const first = await h.prompt("continue the mouse wheel work");
    expect(first.result.message).toEqual({
      customType: "cortex-memory",
      content: "HITS 4 9",
      display: false,
      details: { ids: [4, 9] },
    });
    expect(h.statuses.at(-1)).toBe(LOADED);

    // Under two content words: no exec at all.
    await h.prompt("yes");
    await h.prompt("ok continue");
    await h.prompt("do it");
    expect(h.execs).toHaveLength(1);

    const later = await h.prompt("check the scroll multiplier again");
    expect(h.execs).toHaveLength(2);
    expect(flag(h.execs[1].args, "limit")).toBe("3");
    expect(flag(h.execs[1].args, "exclude")).toBe("4,9");
    expect(h.execs[1].args).toContain("--no-primer");
    expect(later.result).toBeUndefined();
    expect(later.event.systemPromptOptions.sections.cortex_memory).toBe("PRIMER");
  });

  test("the query comes from the RAW input with a leading /command stripped, not the expanded prompt", async () => {
    const h = harness();
    await h.prompt("<skill body ... thousands of chars> fix mouse wheel", { input: "/skill:x fix mouse wheel" });
    expect(flag(h.execs[0].args, "query")).toBe("fix mouse wheel");
  });

  test("steer/followUp input does not leak into the next prompt's query; leading dashes are stripped", async () => {
    const h = harness();
    await h.emit("input", {
      type: "input",
      text: "steer text about something",
      source: "interactive",
      streamingBehavior: "steer",
    });
    await h.prompt("-- rewrite the recall budget", { input: null });
    expect(flag(h.execs[0].args, "query")).toBe("rewrite the recall budget");
  });

  test("an exec failure never throws: no injection, the error status, and the primer is not refetched", async () => {
    let fail = true;
    const h = harness(() => (fail ? nonZero("boom") : context({ hits: [{ id: 4 }], hitsText: "HIT 4" })));
    const first = await h.prompt("fix the mouse wheel");
    expect(first.result).toBeUndefined();
    expect(first.event.systemPromptOptions.sections.cortex_memory).toBeUndefined();
    expect(h.statuses.at(-1)).toBe(ERROR);
    expect(await h.memory()).toContain("\u2298 error \u2014 boom");

    // The next successful memory call clears the error.
    fail = false;
    const second = await h.prompt("continue with the scroll multiplier");
    expect(h.execs[1].args).toContain("--no-primer");
    expect(second.event.systemPromptOptions.sections.cortex_memory).toBeUndefined();
    expect(h.statuses.at(-1)).toBe(LOADED);
    expect(await h.memory()).not.toContain("boom");
  });

  test("a killed (timed-out) exec and unreadable JSON count as failures too", async () => {
    // The killed reply carries valid JSON, so only the `killed` check rejects it.
    const replies = [{ ...context(), killed: true }, ok("not json")];
    for (const reply of replies) {
      const h = harness(() => reply);
      const { result } = await h.prompt("fix the mouse wheel");
      expect(result).toBeUndefined();
      expect(h.statuses.at(-1)).toBe(ERROR);
    }
  });

  test("session_compact and /memory refresh refetch the primer; session_start resets everything", async () => {
    const h = harness(() => context({ hits: [{ id: 4 }], hitsText: "HIT 4" }));
    await h.prompt("fix the mouse wheel");
    await h.emit("session_compact");
    await h.prompt("yes");
    expect(contextExecs(h.execs)).toHaveLength(2);
    expect(h.execs[1].args).not.toContain("--no-primer");
    expect(flag(h.execs[1].args, "exclude")).toBeUndefined();

    await h.memory("refresh");
    await h.prompt("yes");
    expect(h.execs[2].args).not.toContain("--no-primer");

    await h.emit("session_start", { type: "session_start", reason: "new" });
    const text = await h.memory();
    expect(text).toContain("\u25cb ready \u2014 nothing loaded yet");
    expect(text).not.toContain("This session");
  });

  test("an agent_start without a preceding before_agent_start counts as a silent run", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel");
    expect(await h.memory()).not.toContain("without memory");
    await h.emit("agent_start");
    await h.emit("agent_end", { type: "agent_end", messages: [] });
    expect(await h.memory()).toContain("1 prompt \u00b7 1 agent run without memory");
  });

  test("/memory lists each stream in context with its reason, never the raw primer or hit text", async () => {
    const replies = [
      context({ primer: "PRIMER TEXT", primerIds: [3, 5], hits: [{ id: 7 }], hitsText: "HIT SEVEN" }),
      ok(
        JSON.stringify([
          { id: 3, title: "three", status: "open", lane: "cortex" },
          { id: 5, title: "five", status: "review", lane: "infra" },
          { id: 7, title: "seven", status: "done", lane: "cortex" },
          { id: 8, title: "not listed", status: "open", lane: "cortex" },
        ]),
      ),
    ];
    const h = harness(() => replies.shift() ?? context());
    await h.prompt("fix the mouse wheel");
    const text = await h.memory();
    expect(text).toStartWith("\u25cf Memory \u2014 writer \u00b7 lane cortex\n");
    expect(text).toContain("In context (3)");
    expect(text).toContain("@7  done     seven \u00b7 matched \u201cfix the mouse wheel\u201d");
    expect(text).toContain("@5  review   five \u00b7 infra \u00b7 session summary");
    expect(text).toContain("@3  open     three \u00b7 session summary");
    expect(text.indexOf("@7")).toBeLessThan(text.indexOf("@5"));
    expect(text).toContain("working \u2014 1 lookup, last");
    const tokens = Math.round(("PRIMER TEXT".length + "HIT SEVEN".length) / 4);
    expect(text).toContain(`~${tokens} tokens of memory added`);
    expect(text).not.toContain("PRIMER TEXT");
    expect(text).not.toContain("HIT SEVEN");
    expect(text).not.toContain("not listed");
  });
});

describe("cortex_recall", () => {
  test('"@12" loads the stream with memory show and marks it shown', async () => {
    const h = harness(args => (args[1] === "show" ? ok("STREAM 12") : context()));
    await h.prompt("fix the mouse wheel");
    const r = await h.recall("@12");
    expect(r.content[0].text).toBe("STREAM 12");
    expect(r.details).toBeUndefined();
    expect(h.execs.at(-1)?.args).toEqual(["memory", "show", "12"]);
    expect(h.execs.at(-1)?.opts).toMatchObject({ cwd: "/repo", timeout: 5000 });
    await h.prompt("check the scroll multiplier again");
    expect(flag(h.execs.at(-1)?.args ?? [], "exclude")).toBe("12");
  });

  test('"@12#next" loads one section; it is a different recall from "@12"', async () => {
    const h = harness(args => (args[1] === "show" ? ok("SECTION") : context()));
    await h.prompt("fix the mouse wheel");
    await h.recall("@12#next");
    expect(h.execs.at(-1)?.args).toEqual(["memory", "show", "12", "--section=next"]);
    await h.recall("12# open questions ");
    expect(h.execs.at(-1)?.args).toEqual(["memory", "show", "12", "--section=open questions"]);
    expect((await h.recall("@12")).content[0].text).toBe("SECTION");
    expect(h.execs.at(-1)?.args).toEqual(["memory", "show", "12"]);
  });

  test("keywords search every lane with this lane boosted (--limit=5); there is no all_lanes parameter", async () => {
    const h = harness(args => (args[1] === "search" ? ok("RESULTS") : context()));
    await h.prompt("fix the mouse wheel");
    await h.recall("--wheel notches");
    expect(h.execs.at(-1)?.args).toEqual(["memory", "search", "wheel notches", "--limit=5", "--boost=cortex"]);
    expect(h.tools.cortex_recall.parameters.args[0]).not.toHaveProperty("all_lanes");
    expect(h.tools.cortex_recall.description).toContain("every lane");
    expect(h.tools.cortex_recall.promptGuidelines.join("\n")).toContain("not `cortex show`/`cortex ls` in bash");
  });

  test("the budget is 3 calls per request; a repeated query short-circuits; a new prompt resets both", async () => {
    const h = harness(args => (args[1] === "context" ? context() : ok("OK")));
    await h.prompt("fix the mouse wheel");
    const before = h.execs.length;
    await h.recall("wheel");
    const dup = await h.recall(" WHEEL ");
    expect(dup.content[0].text).toBe("Already recalled in this request; see the earlier result.");
    await h.recall("scroll");
    const spent = await h.recall("notches");
    expect(spent.content[0].text).toBe(
      "Recall budget for this request is spent; continue the task with what you have.",
    );
    expect(h.execs.length - before).toBe(2);

    await h.prompt("yes");
    const again = await h.recall("wheel");
    expect(again.content[0].text).toBe("OK");
  });

  test("parallel duplicate calls (one assistant message) spawn once; a failed recall can be retried", async () => {
    let fail = false;
    const h = harness(args =>
      args[1] === "context" ? context() : fail ? { code: 1, killed: false, stdout: "", stderr: "boom" } : ok("STREAM"),
    );
    await h.prompt("fix the mouse wheel");
    const before = h.execs.length;
    const [a, b] = await Promise.all([h.recall("@1"), h.recall("@1")]);
    expect([a.content[0].text, b.content[0].text].sort()).toEqual([
      "Already recalled in this request; see the earlier result.",
      "STREAM",
    ]);
    expect(h.execs.length - before).toBe(1);

    await h.prompt("yes");
    fail = true;
    await expect(h.recall("wheel")).rejects.toThrow("boom");
    fail = false;
    expect((await h.recall("wheel")).content[0].text).toBe("STREAM");
  });

  test("a non-zero exit and a { code: 0, killed: true } result both THROW", async () => {
    for (const reply of [
      { code: 1, killed: false, stdout: "", stderr: "task 12 not found" },
      { code: 0, killed: true, stdout: "", stderr: "" },
    ]) {
      const h = harness(args => (args[1] === "context" ? context() : reply));
      await h.prompt("fix the mouse wheel");
      await expect(h.recall("@12")).rejects.toThrow(reply.stderr || /timed out or was aborted/);
    }
  });
});

describe("cortex_update", () => {
  const update = (h: ReturnType<typeof harness>, params: Record<string, unknown>) =>
    h.tools.cortex_update.execute("call", params, undefined, undefined, h.ctx);

  test("posts with the pi session author in ctx.cwd and returns stdout", async () => {
    const h = harness(() => ok("✓ update [1] posted on task 3\n"));
    const r = await update(h, { task_id: 3, message: "hi", status: "review", body: "detail" });
    expect(h.execs[0].args).toEqual(["update", "3", "-m", "hi", "--as", "pi-sess-1", "-s", "review", "-b", "detail"]);
    expect(h.execs[0].opts).toMatchObject({ cwd: "/repo" });
    expect(r).toEqual({ content: [{ type: "text", text: "✓ update [1] posted on task 3\n" }], details: undefined });
  });

  test("a non-zero exit and a { code: 0, killed: true } result both THROW", async () => {
    const failing = harness(() => ({ code: 1, killed: false, stdout: "", stderr: "error: task 3 not found" }));
    await expect(update(failing, { task_id: 3, message: "hi" })).rejects.toThrow("error: task 3 not found");
    const killed = harness(() => ({ code: 0, killed: true, stdout: "", stderr: "" }));
    await expect(update(killed, { task_id: 3, message: "hi" })).rejects.toThrow(/timed out or was aborted/);
  });
});

describe("bb thread authors", () => {
  /** Drive the primer, checkpoint, compaction and cortex_update once; return the author each used. */
  async function authors() {
    const h = harness(args =>
      args[0] === "update" ? ok("\u2713 update posted") : args[1] === "show" ? ok("STREAM 5") : context(),
    );
    await h.prompt("continue the mouse wheel work");
    const primer = flag(h.execs[0].args, "author");
    await h.recall("@5");
    await h.tool("edit", { path: "src/tui/mouse.ts" });
    const checkpoint = (await h.settle()).entries[0].content.match(/--as (\S+)/)?.[1];
    await h.compact("progress summary");
    const compaction = h.execs.at(-1)?.args.at(-1);
    await h.tools.cortex_update.execute("call", { task_id: 3, message: "hi" }, undefined, undefined, h.ctx);
    const tool = h.execs.at(-1)?.args.at(-1);
    return { primer, checkpoint, compaction, tool };
  }
  const all = (author: string) => ({ primer: author, checkpoint: author, compaction: author, tool: author });

  test("a valid BB_THREAD_ID gives bb-<thread id> at every call site", async () => {
    process.env.BB_THREAD_ID = "thr_2qj8qzdqqr";
    expect(await authors()).toEqual(all("bb-thr_2qj8qzdqqr"));
  });

  test("an unset or invalid BB_THREAD_ID keeps the pi session author", async () => {
    expect(await authors()).toEqual(all("pi-sess-1"));
    for (const id of ["", "thr_BAD", "thr_abc12", "abc_123456"]) {
      process.env.BB_THREAD_ID = id;
      expect(await authors()).toEqual(all("pi-sess-1"));
    }
  });
});

describe("memory roles", () => {
  test("memoryRole: a UI makes a writer, headless a reader; CORTEX_MEMORY read/write/off win; unknown falls back", () => {
    expect(memoryRole({ hasUI: true }, {})).toBe("writer");
    expect(memoryRole({ hasUI: false }, {})).toBe("reader");
    for (const hasUI of [true, false]) {
      expect(memoryRole({ hasUI }, { CORTEX_MEMORY: "write" })).toBe("writer");
      expect(memoryRole({ hasUI }, { CORTEX_MEMORY: "read" })).toBe("reader");
      expect(memoryRole({ hasUI }, { CORTEX_MEMORY: "off" })).toBe("off");
    }
    expect(memoryRole({ hasUI: true }, { CORTEX_MEMORY: "bogus" })).toBe("writer");
    expect(memoryRole({ hasUI: false }, { CORTEX_MEMORY: "constructor" })).toBe("reader");
  });

  test("an unknown CORTEX_MEMORY keeps the default role and is reported as the last error", async () => {
    await withMemoryEnv("bogus", async () => {
      const h = harness();
      await h.emit("session_start", { type: "session_start", reason: "startup" });
      expect(h.statuses.at(-1)).toBe(ERROR);
      const text = await h.memory();
      expect(text).toContain("Memory \u2014 writer");
      expect(text).toContain("error \u2014 CORTEX_MEMORY=bogus is not write|read|off; ignored");
      await h.prompt("fix the mouse wheel");
      expect(h.execs[0].args).not.toContain("--no-primer");
    });
  });

  test("reader (no UI): hits only, with --no-primer and --limit=3, and nothing under 2 content words", async () => {
    const h = harness(() => context({ hits: [{ id: 4 }], hitsText: "HIT 4" }), { hasUI: false });
    const first = await h.prompt("fix the mouse wheel", { forced: true });
    expect(h.execs).toHaveLength(1);
    expect(h.execs[0].args).toContain("--no-primer");
    expect(flag(h.execs[0].args, "limit")).toBe("3");
    expect(first.result.systemPrompt).toBeUndefined();
    expect(first.result.message.content).toBe("HIT 4");
    expect(first.event.systemPromptOptions.sections.cortex_memory).toBeUndefined();
    await h.prompt("yes");
    expect(h.execs).toHaveLength(1);
    await h.prompt("now the scroll multiplier"); // no recall cue after the first prompt
    expect(h.execs).toHaveLength(1);
    const later = await h.prompt("continue with the scroll multiplier");
    expect(later.event.systemPromptOptions.sections.cortex_memory).toBeUndefined();
    expect(h.execs[1].args).toContain("--no-primer");
    expect(flag(h.execs[1].args, "limit")).toBe("3");
  });

  test("reader: the 3rd recall returns the budget text; no checkpoint and no breadcrumbs", async () => {
    const h = harness(args => (args[1] === "context" ? context() : ok("OK")), { hasUI: false });
    await h.prompt("fix the mouse wheel");
    await h.recall("@5");
    await h.recall("scroll");
    const spent = await h.recall("notches");
    expect(spent.content[0].text).toBe(
      "Recall budget for this request is spent; continue the task with what you have.",
    );
    for (const path of ["a.ts", "b.ts", "c.ts"]) await h.tool("edit", { path });
    const text = await h.memory();
    expect(text).toContain("Memory \u2014 reader");
    expect(text).toContain("read-only session (delegate): prompt hits and 2 recalls a request, never writes");
    expect(text).not.toContain("Working on");
    expect(h.statuses).toEqual([]);
    expect(await h.settle()).toBeUndefined();
    const before = h.execs.length;
    await h.compact("progress summary");
    expect(h.execs).toHaveLength(before);
  });

  test("CORTEX_MEMORY=read makes a UI session a reader; CORTEX_MEMORY=write makes a headless one a writer", async () => {
    await withMemoryEnv("read", async () => {
      const h = harness();
      await h.prompt("fix the mouse wheel");
      expect(h.execs[0].args).toContain("--no-primer");
    });
    await withMemoryEnv("write", async () => {
      const h = harness(() => context(), { hasUI: false });
      const { event } = await h.prompt("fix the mouse wheel");
      expect(event.systemPromptOptions.sections.cortex_memory).toBe("PRIMER");
    });
  });

  test("CORTEX_MEMORY=off: no exec on any event", async () => {
    await withMemoryEnv("off", async () => {
      const h = harness();
      const { result } = await h.prompt("fix the mouse wheel");
      expect(result).toBeUndefined();
      await h.tool("bash", { command: "cortex show 5" });
      for (const path of ["a.ts", "b.ts", "c.ts"]) await h.tool("edit", { path });
      expect(await h.settle()).toBeUndefined();
      await h.compact("progress summary");
      expect(h.execs).toHaveLength(0);
    });
  });
});

describe("writer tracking (tool_result)", () => {
  test("focusFromBash: named stream ids, and a `cortex add` id from its text or JSON output", () => {
    expect(focusFromBash("cortex edit 12 --body-search 'a' --body-replace 'b' && cortex update 13 -m hi", "")).toEqual([
      12, 13,
    ]);
    expect(focusFromBash("cortex mv 4 later; cortex memory show 8; cortex show 9", "")).toEqual([4, 8, 9]);
    expect(focusFromBash("cortex ls; cortex search 12", "")).toEqual([]);
    expect(focusFromBash('cortex add "t" --lane x', "[34] t\n")).toEqual([34]);
    expect(focusFromBash('cortex add "t" --json', '{"id":35,"lane":"x"}')).toEqual([35]);
    expect(focusFromBash("echo done", "[36] t")).toEqual([]);
  });

  test("edit/write add their paths once; an error result is ignored; a new request resets them", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel");
    await h.tool("bash", { command: "cortex show 5" });
    await h.tool("edit", { path: "a.ts" });
    await h.tool("write", { path: "b.ts" });
    await h.tool("write", { path: "a.ts" });
    await h.tool("edit", { path: "c.ts" }, { isError: true });
    const r = await h.settle();
    expect(r.entries[0].content).toContain("Files changed:\n- a.ts\n- b.ts\n\n");
    await h.prompt("now the scroll multiplier");
    expect(await h.settle()).toBeUndefined();
  });

  test("bash `cortex edit` names a focus stream and counts as a memory write (no checkpoint)", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel");
    await h.tool("edit", { path: "a.ts" });
    await h.tool("bash", { command: "cortex edit 12 --body-search 'old' --body-replace 'new'" });
    expect(await h.memory()).toContain("Working on\n    @12\n");
    expect(await h.settle()).toBeUndefined();
  });

  test("bash `cortex add` output '[34] t' adds focus 34 and counts as a memory write", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel");
    await h.tool("edit", { path: "a.ts" });
    await h.tool("bash", { command: 'cortex add "wheel" --lane cortex --body-file -' }, { output: "[34] wheel\n" });
    expect(await h.memory()).toContain("Working on\n    @34\n");
    expect(await h.settle()).toBeUndefined();
  });

  test("a read-only cortex command gives focus but writes nothing (the checkpoint fires)", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel");
    await h.tool("bash", { command: "cortex show 8" });
    await h.tool("edit", { path: "a.ts" });
    expect((await h.settle()).continue).toBe(true);
  });

  test("cortex_update adds its task to focus and counts as a memory write; a failed one does not", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel");
    await h.tool("edit", { path: "a.ts" });
    await h.tool("cortex_update", { task_id: 4, message: "x" }, { isError: true });
    expect(await h.memory()).toContain("Working on\n    none yet\n");
    await h.tool("cortex_update", { task_id: 3, message: "progress" });
    expect(await h.memory()).toContain("Working on\n    @3\n");
    expect(await h.settle()).toBeUndefined();
  });

  test("focus keeps the 5 most recent streams, deduped, across requests; session_start clears it", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel");
    for (const id of [1, 2, 3, 4, 5, 6]) await h.tool("bash", { command: `cortex show ${id}` });
    await h.prompt("now the scroll multiplier");
    await h.tool("bash", { command: "cortex show 3" });
    expect(await h.memory()).toContain("Working on\n    @3\n    @6\n    @5\n    @4\n    @2\n\n");
    await h.emit("session_start", { type: "session_start", reason: "new" });
    expect(await h.memory()).toContain("Working on\n    none yet\n");
  });
});

describe("memory checkpoint (agent_before_settle)", () => {
  test("shouldCheckpoint truth table", () => {
    const base = { role: "writer", outcome: "completed", checkpointed: false, wroteMemory: false, edited: 1, focus: 1 };
    expect(shouldCheckpoint(base)).toBe("update");
    expect(shouldCheckpoint({ ...base, focus: 0, edited: 3 })).toBe("attach");
    expect(shouldCheckpoint({ ...base, focus: 0, edited: 2 })).toBeNull();
    expect(shouldCheckpoint({ ...base, edited: 0 })).toBeNull();
    expect(shouldCheckpoint({ ...base, outcome: "aborted" })).toBeNull();
    expect(shouldCheckpoint({ ...base, outcome: "error" })).toBeNull();
    expect(shouldCheckpoint({ ...base, checkpointed: true })).toBeNull();
    expect(shouldCheckpoint({ ...base, wroteMemory: true })).toBeNull();
    expect(shouldCheckpoint({ ...base, role: "reader" })).toBeNull();
    expect(shouldCheckpoint({ ...base, role: "off" })).toBeNull();
  });

  test("checkpointPrompt: the four options, the stream template, \u2264 10 files and the closing line", () => {
    const edited = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
    const attach = checkpointPrompt({ kind: "attach", edited, focus: [], candidates: "", author: "pi-sess-1" });
    expect(attach).toStartWith("Memory checkpoint (automatic, once per request)");
    for (const option of ["UPDATE", "ATTACH", "CREATE", "NOTHING"]) expect(attach).toContain(`- ${option}:`);
    for (const heading of ["## Goal", "## State", "## Decisions", "## Next", "## Files", "Verified: YYYY-MM-DD"]) {
      expect(attach).toContain(heading);
    }
    expect(attach).toContain("--as pi-sess-1");
    expect(attach).toContain("never a body edit");
    expect(attach).toContain("- f9.ts");
    expect(attach).not.toContain("- f10.ts");
    expect(attach).toContain("and 2 more");
    expect(attach).toContain("(none found)");
    expect(attach).toEndWith("Reply with one short line naming your choice.");
    const update = checkpointPrompt({ kind: "update", edited: ["a.ts"], focus: [9, 5], candidates: "", author: "x" });
    expect(update).toContain("Focus streams (most recent first): @9, @5");
  });

  test("update: ONE hidden checkpoint message + continue, then nothing in the same request; a new request re-arms it", async () => {
    const h = harness(args => (args[1] === "show" ? ok("STREAM 5") : context()));
    await h.prompt("continue the mouse wheel work");
    await h.recall("@5");
    await h.tool("edit", { path: "src/tui/mouse.ts" });
    const r = await h.settle();
    expect(r.continue).toBe(true);
    expect(r.entries).toHaveLength(1);
    const [entry] = r.entries;
    expect(entry).toMatchObject({
      type: "custom_message",
      customType: "cortex-memory-checkpoint",
      display: false,
      details: { kind: "update", focus: [5] },
    });
    expect(entry.content).toStartWith("Memory checkpoint (automatic, once per request)");
    expect(entry.content).toContain("- src/tui/mouse.ts");
    expect(entry.content).toContain("@5");
    expect(h.statuses.at(-1)).toBe(saving("\u25dc"));

    // The checkpoint turn continues the same run: agent_start/agent_end again, then settle.
    await h.emit("agent_start");
    await h.emit("agent_end", { type: "agent_end", messages: [] });
    expect(h.statuses.at(-1)).toBe(LOADED);
    expect(await h.settle()).toBeUndefined();
    const text = await h.memory();
    expect(text).toContain("1 checkpoint");
    expect(text).not.toContain("without memory");

    await h.prompt("now the dialog rows");
    expect(await h.settle()).toBeUndefined();
    await h.tool("write", { path: "src/tui/dialog.ts" });
    expect((await h.settle()).continue).toBe(true);
  });

  test("aborted or errored requests never checkpoint", async () => {
    const h = harness(args => (args[1] === "show" ? ok("STREAM 5") : context()));
    await h.prompt("continue the mouse wheel work");
    await h.recall("@5");
    await h.tool("edit", { path: "a.ts" });
    expect(await h.settle("aborted")).toBeUndefined();
    expect(await h.settle("error")).toBeUndefined();
    expect((await h.settle()).continue).toBe(true);
  });

  test("attach: \u2265 3 files and no focus run ONE --no-primer candidate search on the last substantive query", async () => {
    const candidates = context({
      primer: "",
      hits: [{ id: 21 }],
      hitsText: "[21] open \u00b7 cortex \u00b7 wheel stream",
    });
    const h = harness(args => (args.includes("--no-primer") ? candidates : context()));
    await h.prompt("refactor the wheel notch handling");
    await h.prompt("yes");
    await h.tool("edit", { path: "a.ts" });
    await h.tool("edit", { path: "b.ts" });
    expect(await h.settle()).toBeUndefined();
    await h.tool("write", { path: "c.ts" });
    const before = h.execs.length;
    const r = await h.settle();
    const execs = h.execs.slice(before);
    expect(execs).toHaveLength(1);
    expect(execs[0].args).toEqual([
      "memory",
      "context",
      "--json",
      "--no-primer",
      "--query=refactor the wheel notch handling",
      "--limit=3",
    ]);
    expect(execs[0].opts).toMatchObject({ cwd: "/repo", timeout: 3000 });
    expect(r.continue).toBe(true);
    expect(r.entries[0].details).toEqual({ kind: "attach", focus: [] });
    expect(r.entries[0].content).toContain("[21] open \u00b7 cortex \u00b7 wheel stream");
  });

  test("attach: a failed candidate search still checkpoints, without candidates", async () => {
    const h = harness(args =>
      args.includes("--no-primer") ? { code: 1, killed: false, stdout: "", stderr: "daemon down" } : context(),
    );
    await h.prompt("refactor the wheel notch handling");
    for (const path of ["a.ts", "b.ts", "c.ts"]) await h.tool("edit", { path });
    const r = await h.settle();
    expect(r.continue).toBe(true);
    expect(r.entries[0].content).toContain("(none found)");
    expect(await h.memory()).toContain("error \u2014 daemon down");
  });
});

describe("compaction breadcrumbs (session_compact)", () => {
  test("the summary goes on the 2 newest focus streams, newest first, truncated to 4000 chars", async () => {
    const h = harness(args => (args[0] === "update" ? ok("\u2713 update posted") : context()));
    await h.prompt("fix the mouse wheel");
    for (const id of [5, 7, 9]) await h.tool("bash", { command: `cortex show ${id}` });
    const before = h.execs.length;
    await h.compact(`-${"x".repeat(5000)}`);
    const updates = h.execs.slice(before);
    expect(updates.map(e => e.args[1])).toEqual(["9", "7"]);
    for (const e of updates) {
      expect(e.cmd).toBe("cortex");
      expect(e.args.slice(0, 5)).toEqual(["update", e.args[1], "-m", "auto: progress snapshot at compaction", "-b"]);
      expect(e.args[5]).toHaveLength(4000);
      expect(e.args.slice(6)).toEqual(["--as", "pi-sess-1"]);
      expect(e.opts).toMatchObject({ cwd: "/repo", timeout: 3000 });
    }
    expect(await h.memory()).toContain("2 compaction snapshots");
  });

  test("no focus or an empty summary: no exec; a failed update never throws and is reported", async () => {
    const h = harness(args =>
      args[0] === "update" ? { code: 1, killed: false, stdout: "", stderr: "nope" } : context(),
    );
    await h.prompt("fix the mouse wheel");
    const before = h.execs.length;
    await h.compact("progress summary");
    expect(h.execs).toHaveLength(before);
    await h.tool("bash", { command: "cortex show 5" });
    await h.compact("   ");
    expect(h.execs).toHaveLength(before);
    await h.compact("progress summary");
    expect(h.execs).toHaveLength(before + 1);
    expect(h.statuses.at(-1)).toBe(ERROR);
    const text = await h.memory();
    expect(text).not.toContain("compaction snapshot");
    expect(text).toContain("error \u2014 nope");
  });
});

describe("the memory status and /memory (plan @423)", () => {
  const update = (h: ReturnType<typeof harness>, params: Record<string, unknown>) =>
    h.tools.cortex_update.execute("call", params, undefined, undefined, h.ctx);
  const STALE = "<warning>\u25d0</warning> <text>memory</text> <dim>\u00b7</dim> <warning>@421 stale</warning>";

  test("session_start shows \u25cb, a prompt with hits \u25cf; compaction and /memory refresh go back to \u25cb", async () => {
    const h = harness(() => context({ hits: [{ id: 4 }], hitsText: "HIT 4" }));
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    expect(h.statuses).toEqual([EMPTY]);
    await h.prompt("fix the mouse wheel");
    expect(h.statuses.at(-1)).toBe(LOADED);
    await h.compact("");
    expect(h.statuses.at(-1)).toBe(EMPTY);
    await h.prompt("continue the mouse wheel work");
    expect(h.statuses.at(-1)).toBe(LOADED);
    await h.memory("refresh");
    expect(h.statuses.at(-1)).toBe(EMPTY);
    expect(await h.memory()).toContain("In context (0)");
  });

  test("the primer's streams are the session summary, hits matched the prompt, recalls were recalled; the first reason wins", async () => {
    const search = ok(
      "header\n- [11] open \u00b7 infra \u00b7 active 2026-09-01 \u00b7 a\n- [12] open \u00b7 cortex \u00b7 active 2026-09-01 \u00b7 b",
    );
    const h = harness(args => {
      if (args[1] === "show") return shown(Number(args[2]), "fresh \u00b7 synced 2026-09-01 (1d)");
      if (args[1] === "search") return search;
      return context({ primerIds: [3], hits: [{ id: 3 }, { id: 4 }], hitsText: "HITS" });
    });
    await h.prompt("fix the mouse wheel");
    await h.recall("@9");
    await h.recall("wheel notches");
    await h.recall("@4");
    const text = await h.memory();
    // Rows below "In context" (the recalled @ids are also focus streams under "Working on").
    const lines = text.slice(text.indexOf("  In context (5)\n")).split("\n");
    const row = (id: number) => lines.find(line => line.startsWith(`    @${id} `)) ?? "";
    const order = lines.filter(line => /^ {4}@\d/.test(line)).map(line => line.trim().split(" ")[0]);
    expect(order).toEqual(["@12", "@11", "@9", "@4", "@3"]);
    expect(text).toContain("  Working on\n    @4\n    @9\n");
    expect(row(3)).toContain("session summary");
    expect(row(4)).toContain("matched \u201cfix the mouse wheel\u201d");
    for (const id of [9, 11, 12]) expect(row(id)).toContain("recalled by the agent");
  });

  test("a failed cortex_update or recall sets the error status before it throws; the next success clears it", async () => {
    let fail = true;
    const h = harness(args => {
      if (args[0] === "update") return fail ? nonZero("error: task 3 not found") : ok("\u2713 update");
      if (args[1] === "show") return fail ? nonZero("show failed") : shown(5, "fresh \u00b7 synced 2026-09-01 (1d)");
      return context();
    });
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await expect(update(h, { task_id: 3, message: "hi" })).rejects.toThrow("error: task 3 not found");
    expect(h.statuses.at(-1)).toBe(ERROR);
    expect(await h.memory()).toContain("\u2298 error \u2014 error: task 3 not found");
    fail = false;
    await update(h, { task_id: 3, message: "hi" });
    expect(h.statuses.at(-1)).toBe(EMPTY);

    fail = true;
    await expect(h.recall("@5")).rejects.toThrow("show failed");
    expect(h.statuses.at(-1)).toBe(ERROR);
    fail = false;
    await h.recall("@5");
    expect(h.statuses.at(-1)).toBe(LOADED);
  });

  test("a stale recall flags @id stale until the next prompt, a fresh recall of it or a bash `cortex edit` of it", async () => {
    let verdict = "stale \u00b7 synced 2026-09-01 (28d) \u00b7 changed: src/a.ts, src/b.ts \u00b7 missing: gone.ts";
    const h = harness(args => (args[1] === "show" ? shown(Number(args[2]), verdict) : context()));
    await h.prompt("fix the mouse wheel");
    await h.recall("@421");
    expect(h.statuses.at(-1)).toBe(STALE);
    expect(await h.memory()).toContain("\u25d0 stale \u2014 @421: changed: src/a.ts, src/b.ts \u00b7 missing: gone.ts");
    verdict = "fresh \u00b7 synced 2026-09-01 (1d)";
    await h.recall("@7");
    expect(h.statuses.at(-1)).toBe(STALE);
    await h.recall("@421#next");
    expect(h.statuses.at(-1)).toBe(LOADED);

    verdict = "stale \u00b7 synced 2026-09-01 (40d) \u00b7 old";
    await h.prompt("now the scroll multiplier");
    await h.recall("@421");
    expect(await h.memory()).toContain("@421: old");
    await h.prompt("rename the helper");
    expect(h.statuses.at(-1)).toBe(LOADED);

    await h.recall("@421");
    expect(h.statuses.at(-1)).toBe(STALE);
    await h.tool("bash", { command: "cortex edit 42 --body-search a --body-replace b" });
    await h.tool("bash", { command: "cortex edit 421 --body-search a --body-replace b" }, { isError: true });
    expect(h.statuses.at(-1)).toBe(STALE);
    await h.tool("bash", { command: "cortex edit 421 --body-search a --body-replace b" });
    expect(h.statuses.at(-1)).toBe(LOADED);
  });

  test("a checkpoint starts ONE 150 ms spinner (\u25dc\u25dd\u25de\u25df); agent_end, session_start and session_shutdown stop it", async () => {
    const h = harness(args => (args[1] === "show" ? ok("STREAM 5") : context()));
    const checkpoint = async () => {
      await h.prompt("continue the mouse wheel work");
      await h.recall("@5");
      await h.tool("edit", { path: "a.ts" });
      expect((await h.settle()).continue).toBe(true);
    };
    await checkpoint();
    expect(running()).toHaveLength(1);
    expect(running()[0]?.ms).toBe(150);
    expect(h.statuses.at(-1)).toBe(saving("\u25dc"));
    for (const symbol of ["\u25dd", "\u25de", "\u25df", "\u25dc"]) {
      running()[0]?.fn();
      expect(h.statuses.at(-1)).toBe(saving(symbol));
    }
    await h.emit("agent_end", { type: "agent_end", messages: [] });
    expect(running()).toHaveLength(0);
    expect(h.statuses.at(-1)).toBe(LOADED);

    await checkpoint();
    expect(running()).toHaveLength(1);
    await h.emit("session_start", { type: "session_start", reason: "new" });
    expect(running()).toHaveLength(0);
    expect(h.statuses.at(-1)).toBe(EMPTY);

    await checkpoint();
    await h.emit("session_shutdown", { type: "session_shutdown" });
    expect(running()).toHaveLength(0);
    expect(intervals).toHaveLength(3);
  });

  test("a headless writer checkpoints without a spinner or a status", async () => {
    await withMemoryEnv("write", async () => {
      const h = harness(args => (args[1] === "show" ? ok("STREAM 5") : context()), { hasUI: false });
      await h.prompt("continue the mouse wheel work");
      await h.recall("@5");
      await h.tool("edit", { path: "a.ts" });
      expect((await h.settle()).continue).toBe(true);
      expect(intervals).toHaveLength(0);
      expect(h.statuses).toEqual([]);
    });
  });

  test("/memory in the TUI opens the panel after exactly ONE `cortex ls --json`; r re-reads on the next prompt", async () => {
    const listed = ok(JSON.stringify([{ id: 4, title: "four", status: "open", lane: "cortex" }]));
    const h = harness(args => (args[0] === "ls" ? listed : context({ hits: [{ id: 4 }], hitsText: "HIT 4" })), {
      mode: "tui",
    });
    await h.prompt("fix the mouse wheel");
    const before = h.execs.length;
    await h.commands.memory.handler("", h.ctx);
    const execs = h.execs.slice(before);
    expect(execs.map(e => e.args)).toEqual([["ls", "--json"]]);
    expect(execs[0]?.opts).toMatchObject({ cwd: "/repo", timeout: 3000 });
    expect(h.notes).toEqual([]);
    expect(h.panels).toHaveLength(1);
    const panel = h.panels[0];
    const lines: string[] = panel?.component.render(80) ?? [];
    expect(lines.join("\n")).toContain("four");
    expect(lines.join("\n")).toContain("<b>Memory</b>");

    panel?.component.handleInput("r");
    expect(panel?.done).toBe(true);
    expect(h.notes).toEqual(["cortex memory: re-read on the next prompt"]);
    expect(h.statuses.at(-1)).toBe(EMPTY);
    await h.prompt("yes");
    expect(contextExecs(h.execs).at(-1)?.args).not.toContain("--no-primer");

    await h.commands.memory.handler("", h.ctx);
    h.panels[1]?.component.handleInput("q");
    expect(h.panels[1]?.done).toBe(true);
    expect(h.notes).toHaveLength(1);
  });

  test("/memory outside the TUI notifies the plain text; nothing to list spawns nothing; a failed ls shows ids only", async () => {
    for (const mode of ["rpc", "print"]) {
      const h = harness(() => context(), { mode });
      const text = await h.memory();
      expect(h.execs).toHaveLength(0);
      expect(h.panels).toHaveLength(0);
      expect(text).toStartWith("\u25cb Memory \u2014 writer\n");
      expect(text).not.toContain("\x1b");
    }
    const h = harness(args =>
      args[0] === "ls" ? nonZero("daemon down") : context({ hits: [{ id: 4 }], hitsText: "H" }),
    );
    await h.prompt("fix the mouse wheel");
    const text = await h.memory();
    expect(text).toContain("    @4 \u00b7 matched \u201cfix the mouse wheel\u201d");
    expect(text).toContain("titles unavailable: cortex ls --json failed");
    expect(h.statuses.at(-1)).toBe(LOADED);
  });
});
