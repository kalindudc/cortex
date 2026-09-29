import { describe, expect, mock, test } from "bun:test";

// The embedded pi extension (`src/extensions/pi.ts`, @ts-nocheck) imports pi's
// runtime packages, which cortex does not depend on. Mock both BEFORE the
// dynamic import, then drive its handlers with a fake `pi` and `ctx`.
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
};
const { memoryRole, focusFromBash, shouldCheckpoint, checkpointPrompt } = helpers;

type ExecResult = { code: number; killed: boolean; stdout: string; stderr: string };
type Exec = { cmd: string; args: string[]; opts: Record<string, unknown> };
// biome-ignore lint/suspicious/noExplicitAny: the fake pi runtime is untyped by design
type Any = any;

const ok = (stdout: string): ExecResult => ({ code: 0, killed: false, stdout, stderr: "" });
const context = (over: Record<string, unknown> = {}): ExecResult =>
  ok(JSON.stringify({ lane: "cortex", terms: [], primer: "PRIMER", hits: [], hitsText: "", ...over }));

/** A fake pi + ctx around one extension instance; `respond` answers every exec. */
function harness(respond: (args: string[]) => ExecResult = () => context(), opts: { hasUI?: boolean } = {}) {
  const handlers: Record<string, ((event: Any, ctx: Any) => Any)[]> = {};
  const tools: Record<string, Any> = {};
  const commands: Record<string, Any> = {};
  const execs: Exec[] = [];
  const statuses: (string | undefined)[] = [];
  const notes: string[] = [];
  const ctx = {
    cwd: "/repo",
    hasUI: opts.hasUI ?? true,
    ui: {
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      notify: (text: string) => notes.push(text),
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
  return { tools, commands, execs, statuses, emit, prompt, recall, memory, tool, settle, compact, ctx };
}

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
    expect(exec.args).not.toContain("--no-primer");
    expect(exec.opts).toMatchObject({ cwd: "/repo", timeout: 3000 });
  });

  test("unforced: the primer goes into sections.cortex_memory, byte-identical on the 2nd prompt without a refetch", async () => {
    let primer = "PRIMER v1";
    const h = harness(() => context({ primer }));
    const first = await h.prompt("fix the mouse wheel");
    expect(first.event.systemPromptOptions.sections.cortex_memory).toBe("PRIMER v1");
    expect(first.result).toBeUndefined();
    primer = "PRIMER v2";
    const second = await h.prompt("now the scroll multiplier");
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
    expect(h.statuses.at(-1)).toBe("memory: 2 new");

    // Under two content words: no exec at all.
    await h.prompt("yes");
    await h.prompt("ok continue");
    await h.prompt("do it");
    expect(h.execs).toHaveLength(1);

    const later = await h.prompt("check the scroll multiplier");
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

  test("an exec failure never throws: no injection, status 'memory: unavailable', and the primer is not refetched", async () => {
    let fail = true;
    const h = harness(() => (fail ? { code: 1, killed: false, stdout: "", stderr: "boom" } : context()));
    const first = await h.prompt("fix the mouse wheel");
    expect(first.result).toBeUndefined();
    expect(first.event.systemPromptOptions.sections.cortex_memory).toBeUndefined();
    expect(h.statuses.at(-1)).toBe("memory: unavailable");
    expect(await h.memory()).toContain("last error: boom");

    fail = false;
    const second = await h.prompt("now the scroll multiplier");
    expect(h.execs[1].args).toContain("--no-primer");
    expect(second.event.systemPromptOptions.sections.cortex_memory).toBeUndefined();
  });

  test("a killed (timed-out) exec and unreadable JSON count as failures too", async () => {
    // The killed reply carries valid JSON, so only the `killed` check rejects it.
    const replies = [{ ...context(), killed: true }, ok("not json")];
    for (const reply of replies) {
      const h = harness(() => reply);
      const { result } = await h.prompt("fix the mouse wheel");
      expect(result).toBeUndefined();
      expect(h.statuses.at(-1)).toBe("memory: unavailable");
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
    expect(await h.memory()).toContain("prompts 0 · context spawns 0");
  });

  test("an agent_start without a preceding before_agent_start counts as a silent run", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel");
    expect(await h.memory()).toContain("runs without memory 0");
    await h.emit("agent_start");
    await h.emit("agent_end", { type: "agent_end", messages: [] });
    expect(await h.memory()).toContain("runs without memory 1");
  });

  test("/memory shows the lane, primer, injected hits and stats", async () => {
    const h = harness(() => context({ hits: [{ id: 7 }], hitsText: "HIT SEVEN" }));
    await h.prompt("fix the mouse wheel");
    const text = await h.memory();
    expect(text).toContain("lane: cortex");
    expect(text).toContain("PRIMER");
    expect(text).toContain("shown streams: @7");
    expect(text).toContain("HIT SEVEN");
    expect(text).toContain(`injected ${"HIT SEVEN".length} chars`);
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
    await h.prompt("check the scroll multiplier");
    expect(flag(h.execs.at(-1)?.args ?? [], "exclude")).toBe("12");
  });

  test("keywords search this lane (--limit=5) unless all_lanes", async () => {
    const h = harness(args => (args[1] === "search" ? ok("RESULTS") : context()));
    await h.prompt("fix the mouse wheel");
    await h.recall("--wheel notches");
    expect(h.execs.at(-1)?.args).toEqual(["memory", "search", "wheel notches", "--limit=5", "--lane=cortex"]);
    await h.recall("wheel notches", { all_lanes: true });
    expect(h.execs.at(-1)?.args).toEqual(["memory", "search", "wheel notches", "--limit=5"]);
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
      await h.prompt("fix the mouse wheel");
      expect(h.execs[0].args).not.toContain("--no-primer");
      const text = await h.memory();
      expect(text).toContain("role: writer");
      expect(text).toContain("last error: CORTEX_MEMORY=bogus is not write|read|off; ignored");
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
    const later = await h.prompt("now the scroll multiplier");
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
    expect(await h.memory()).toContain("role: reader");
    expect(await h.memory()).toContain("files changed this request: 0");
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
    await h.tool("edit", { path: "a.ts" });
    await h.tool("write", { path: "b.ts" });
    await h.tool("write", { path: "a.ts" });
    await h.tool("edit", { path: "c.ts" }, { isError: true });
    expect(await h.memory()).toContain("files changed this request: 2");
    await h.prompt("now the scroll multiplier");
    expect(await h.memory()).toContain("files changed this request: 0");
  });

  test("bash `cortex edit` names a focus stream and counts as a memory write (no checkpoint)", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel");
    await h.tool("edit", { path: "a.ts" });
    await h.tool("bash", { command: "cortex edit 12 --body-search 'old' --body-replace 'new'" });
    expect(await h.memory()).toContain("focus streams: @12");
    expect(await h.settle()).toBeUndefined();
  });

  test("bash `cortex add` output '[34] t' adds focus 34 and counts as a memory write", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel");
    await h.tool("edit", { path: "a.ts" });
    await h.tool("bash", { command: 'cortex add "wheel" --lane cortex --body-file -' }, { output: "[34] wheel\n" });
    expect(await h.memory()).toContain("focus streams: @34");
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
    expect(await h.memory()).toContain("focus streams: (none)");
    await h.tool("cortex_update", { task_id: 3, message: "progress" });
    expect(await h.memory()).toContain("focus streams: @3");
    expect(await h.settle()).toBeUndefined();
  });

  test("focus keeps the 5 most recent streams, deduped, across requests; session_start clears it", async () => {
    const h = harness();
    await h.prompt("fix the mouse wheel");
    for (const id of [1, 2, 3, 4, 5, 6]) await h.tool("bash", { command: `cortex show ${id}` });
    await h.prompt("now the scroll multiplier");
    await h.tool("bash", { command: "cortex show 3" });
    expect(await h.memory()).toContain("focus streams: @3, @6, @5, @4, @2 \u00b7");
    await h.emit("session_start", { type: "session_start", reason: "new" });
    expect(await h.memory()).toContain("focus streams: (none)");
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
    expect(h.statuses.at(-1)).toBe("memory: checkpoint");

    // The checkpoint turn continues the same run: agent_start/agent_end again, then settle.
    await h.emit("agent_start");
    await h.emit("agent_end", { type: "agent_end", messages: [] });
    expect(await h.settle()).toBeUndefined();
    const text = await h.memory();
    expect(text).toContain("checkpoints: 1");
    expect(text).toContain("runs without memory 0");

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
    expect(await h.memory()).toContain("last error: daemon down");
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
    expect(await h.memory()).toContain("breadcrumbs: 2");
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
    const text = await h.memory();
    expect(text).toContain("breadcrumbs: 0");
    expect(text).toContain("last error: nope");
  });
});
