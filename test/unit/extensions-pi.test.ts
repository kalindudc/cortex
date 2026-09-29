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

const { default: extension } = (await import("../../src/extensions/pi.ts")) as {
  default: (pi: unknown) => void;
};

type ExecResult = { code: number; killed: boolean; stdout: string; stderr: string };
type Exec = { cmd: string; args: string[]; opts: Record<string, unknown> };
// biome-ignore lint/suspicious/noExplicitAny: the fake pi runtime is untyped by design
type Any = any;

const ok = (stdout: string): ExecResult => ({ code: 0, killed: false, stdout, stderr: "" });
const context = (over: Record<string, unknown> = {}): ExecResult =>
  ok(JSON.stringify({ lane: "cortex", terms: [], primer: "PRIMER", hits: [], hitsText: "", ...over }));

/** A fake pi + ctx around one extension instance; `respond` answers every exec. */
function harness(respond: (args: string[]) => ExecResult = () => context()) {
  const handlers: Record<string, ((event: Any, ctx: Any) => Any)[]> = {};
  const tools: Record<string, Any> = {};
  const commands: Record<string, Any> = {};
  const execs: Exec[] = [];
  const statuses: (string | undefined)[] = [];
  const notes: string[] = [];
  const ctx = {
    cwd: "/repo",
    hasUI: true,
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
  return { tools, commands, execs, statuses, emit, prompt, recall, memory, ctx };
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
