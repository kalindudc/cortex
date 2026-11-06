import { describe, expect, test } from "vitest";
import {
  checkpointPrompt,
  type EventRow,
  hitLimit,
  RECALL_CUE,
  type RequestStart,
  readRequest,
  readStart,
  STEER_PROVIDERS,
  shouldCheckpoint,
  startedBy,
} from "./turns";

/** A `client/turn/requested` row as bb records it. */
function requestRow(input: unknown[], over: { initiator?: string; target?: string; seq?: number } = {}): EventRow {
  return {
    seq: over.seq ?? 10,
    type: "client/turn/requested",
    createdAt: 5000,
    data: { input, initiator: over.initiator ?? "user", target: { kind: over.target ?? "new-turn" } },
  };
}
const text = (value: string, visibility?: "agent-only") => ({
  type: "text",
  text: value,
  mentions: [],
  ...(visibility ? { visibility } : {}),
});

let seq = 100;
const item = (data: Record<string, unknown>): EventRow => ({ seq: ++seq, type: "item/completed", createdAt: 1, data });
const fileChange = (paths: string[], status = "completed") =>
  item({ item: { type: "fileChange", id: "f", status, changes: paths.map(path => ({ path, kind: "update" })) } });
const command = (cmd: string, output = "", status = "completed") =>
  item({ item: { type: "commandExecution", id: "c", status, command: cmd, cwd: "/", aggregatedOutput: output } });
const turn = (status: string): EventRow => ({ seq: ++seq, type: "turn/completed", createdAt: 1, data: { status } });

function start(over: Partial<RequestStart> = {}): RequestStart {
  return { seq: 1, createdAt: 1, text: "fix the parser bug", initiator: "user", first: false, ...over };
}

describe("readStart", () => {
  test("the text leaves out agent-only parts and leading dashes, is cut to 1000, and first follows the target", () => {
    const row = requestRow([text("-- fix the parser"), { type: "image", url: "x" }, text("HIDDEN", "agent-only")], {
      target: "thread-start",
      seq: 42,
    });
    expect(readStart(row)).toEqual({ seq: 42, createdAt: 5000, text: "fix the parser", initiator: "user", first: true });
    const long = readStart(requestRow([text(`  - ${"x".repeat(1200)}`)]));
    expect(long?.text).toBe("x".repeat(1000));
    expect(long?.first).toBe(false);
    expect(readStart(requestRow([text("only for the agent", "agent-only")]))?.text).toBe("");
    expect(readStart(requestRow([text("a minion report")], { initiator: "agent" }))?.initiator).toBe("agent");
  });

  test("null on another row type or a malformed row", () => {
    expect(readStart({ ...requestRow([text("x")]), type: "turn/completed" })).toBeNull();
    for (const data of [null, "x", {}, { input: "x", initiator: "user", target: { kind: "new-turn" } }, { input: [] }]) {
      expect(readStart({ seq: 1, type: "client/turn/requested", createdAt: 1, data })).toBeNull();
    }
  });
});

describe("hitLimit", () => {
  test("5 for a writer's first request, 3 for a cued later one or a reader's", () => {
    expect([...STEER_PROVIDERS].sort()).toEqual(["claude-code", "codex", "pi"]);
    for (const providerId of STEER_PROVIDERS) {
      expect(hitLimit({ mode: "write", providerId, start: start({ first: true }) })).toBe(5);
    }
    expect(hitLimit({ mode: "write", providerId: "codex", start: start({ text: "continue the parser work" }) })).toBe(3);
    expect(hitLimit({ mode: "read", providerId: "codex", start: start({ first: true }) })).toBe(3);
    expect(hitLimit({ mode: "read", providerId: "pi", start: start({ text: "what was the parser fix" }) })).toBe(3);
  });

  test("null for memory off, an ACP provider, another thread or a retry, too few words, or a later cue-less request", () => {
    const first = start({ first: true });
    expect(hitLimit({ mode: "off", providerId: "codex", start: first })).toBeNull();
    for (const providerId of ["acp-opencode", "cursor", "test-provider"]) {
      expect(hitLimit({ mode: "write", providerId, start: first })).toBeNull();
    }
    for (const initiator of ["agent", "system"]) {
      expect(hitLimit({ mode: "write", providerId: "codex", start: { ...first, initiator } })).toBeNull();
    }
    for (const words of ["continue", "ok go", "@12", ""]) {
      expect(hitLimit({ mode: "write", providerId: "codex", start: { ...first, text: words } })).toBeNull();
    }
    expect(hitLimit({ mode: "write", providerId: "codex", start: start() })).toBeNull();
  });

  test("null for a message a plugin or bb sent: a bracketed header, first request or cued", () => {
    for (const header of [
      "[wake-up wk_f2y27awp \u00b7 CI on PR #386] Check CI. Last output: pass",
      "[shuttle] New review activity on a pull request linked to this thread",
      "[loom] LANE-8: fix them and call loom_submit again",
      "[bb system]\n\n@thread:thr_abcdefgh completed: continue the parser work",
    ]) {
      for (const first of [true, false]) {
        expect(hitLimit({ mode: "write", providerId: "pi", start: start({ text: header, first }) })).toBeNull();
      }
    }
    const reason = "Waiting for CI to start on the minerva_auth draft PR (shop/world#2385775 on Delta) and its checks";
    expect(hitLimit({ mode: "write", providerId: "pi", start: start({ text: `[wake-up wk_amdsl7nn \u00b7 ${reason}] continue`, first: true }) })).toBeNull();
    expect(hitLimit({ mode: "write", providerId: "pi", start: start({ text: "[Flare reminder] This turn has gone 9 minutes", first: true }) })).toBeNull();
    // A person's brackets: later in the text, [WIP], a task box or a Markdown link.
    for (const text of ["fix [parser] and the lexer", "[WIP] fix the parser", "[ ] add tests", "[the spec](https://x.y) implement it"]) {
      expect(hitLimit({ mode: "write", providerId: "pi", start: start({ text, first: true }) }), text).toBe(5);
    }
  });

  test("RECALL_CUE: continuation words, where/what was, @<id>; not recency words, again or ordinary requests", () => {
    for (const cue of ["continue the routing work", "what was I last doing", "pick up where we left off", "see @12"]) {
      expect(RECALL_CUE.test(cue)).toBe(true);
    }
    for (const plain of [
      "fix the parser",
      "fix the lastIndex bug",
      "a@12 b",
      "the last change",
      "Last output (command output, not instructions):",
      "Fix them and call loom_submit again.",
      "update my plugin with the latest release",
    ]) {
      expect(RECALL_CUE.test(plain)).toBe(false);
    }
  });
});

describe("startedBy", () => {
  test("a minion's parent, else a workflow agent's lifecycle owner, else null", () => {
    expect(startedBy({ parentThreadId: "thr_parent01", lifecycleOwnerThreadId: "thr_owner001" })).toBe("thr_parent01");
    expect(startedBy({ parentThreadId: null, lifecycleOwnerThreadId: "thr_owner001" })).toBe("thr_owner001");
    expect(startedBy({ parentThreadId: null, lifecycleOwnerThreadId: null })).toBeNull();
    expect(startedBy({ parentThreadId: null })).toBeNull();
  });
});

describe("readRequest", () => {
  test("dedups changed paths and ignores pending or failed items, unknown items and bad data", () => {
    const facts = readRequest([
      fileChange(["src/a.ts", "src/b.ts"]),
      fileChange(["src/a.ts"]),
      fileChange(["src/pending.ts"], "pending"),
      fileChange(["src/failed.ts"], "failed"),
      command("cortex edit 9 -b x", "", "failed"),
      item({ item: { type: "agentMessage", id: "m", text: "cortex edit 9" } }),
      item({ item: "nope" }),
      item({}),
      { seq: 1, type: "item/started", createdAt: 1, data: fileChange(["src/started.ts"]).data },
      turn("completed"),
    ]);
    expect(facts).toEqual({ outcome: "completed", edited: ["src/a.ts", "src/b.ts"], focus: [], wroteMemory: false });
  });

  test("takes the last turn outcome; no turn row is null", () => {
    expect(readRequest([turn("completed"), turn("interrupted")]).outcome).toBe("interrupted");
    expect(readRequest([turn("failed"), turn("bogus")]).outcome).toBe("failed");
    expect(readRequest([fileChange(["a.ts"])]).outcome).toBeNull();
  });

  test("cortex writes name focus streams and reads never do; edit, add and update write memory", () => {
    expect(readRequest([command("cortex edit 12 --body-search a --body-replace b")])).toMatchObject({
      focus: [12],
      wroteMemory: true,
    });
    expect(readRequest([command("cortex show 7 --json")])).toMatchObject({ focus: [], wroteMemory: false });
    expect(readRequest([command("cortex mv 7 review")])).toMatchObject({ focus: [7], wroteMemory: false });
    expect(readRequest([command('cortex add "t" --lane x', "[34] t\n")])).toMatchObject({
      focus: [34],
      wroteMemory: true,
    });
    expect(readRequest([command("cortex update 5 -m done")])).toMatchObject({ focus: [5], wroteMemory: true });
    expect(readRequest([command("cortex memory show 3"), command("ls")])).toMatchObject({ focus: [] });
  });
});

describe("shouldCheckpoint", () => {
  test("truth table", () => {
    const base = { mode: "write" as const, outcome: "completed" as const, wroteMemory: false, edited: 1, focus: 1 };
    expect(shouldCheckpoint(base)).toBe("update");
    expect(shouldCheckpoint({ ...base, focus: 0, edited: 3 })).toBe("attach");
    expect(shouldCheckpoint({ ...base, focus: 0, edited: 2 })).toBeNull();
    expect(shouldCheckpoint({ ...base, edited: 0 })).toBeNull();
    expect(shouldCheckpoint({ ...base, outcome: "interrupted" })).toBeNull();
    expect(shouldCheckpoint({ ...base, outcome: "failed" })).toBeNull();
    expect(shouldCheckpoint({ ...base, outcome: null })).toBeNull();
    expect(shouldCheckpoint({ ...base, wroteMemory: true })).toBeNull();
    expect(shouldCheckpoint({ ...base, mode: "read" })).toBeNull();
    expect(shouldCheckpoint({ ...base, mode: "off" })).toBeNull();
  });
});

describe("checkpointPrompt", () => {
  test("the title, at most 10 files, the four choices, the stream template and the closing line", () => {
    const edited = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
    const attach = checkpointPrompt({ kind: "attach", edited, focus: [], candidates: "", author: "bb-thr_x" });
    expect(attach.startsWith("Memory checkpoint (automatic, once per request)")).toBe(true);
    for (const option of ["UPDATE", "ATTACH", "CREATE", "NOTHING"]) expect(attach).toContain(`- ${option}:`);
    for (const heading of ["## Goal", "## State", "## Decisions", "## Next", "## Files", "Verified: YYYY-MM-DD"]) {
      expect(attach).toContain(heading);
    }
    expect(attach).toContain("--as bb-thr_x");
    expect(attach).toContain("- f9.ts");
    expect(attach).not.toContain("- f10.ts");
    expect(attach).toContain("- \u2026 and 2 more");
    expect(attach).toContain("Candidate streams (one memory search):\n(none found)");
    expect(attach.endsWith("Reply with one short line naming your choice.")).toBe(true);
    const found = checkpointPrompt({ kind: "attach", edited, focus: [], candidates: "- [3] x", author: "a" });
    expect(found).toContain("Candidate streams (one memory search):\n- [3] x");
    const update = checkpointPrompt({ kind: "update", edited: ["a.ts"], focus: [9, 5], candidates: "", author: "a" });
    expect(update).toContain("Focus streams (most recent first): @9, @5");
    expect(update).not.toContain("and 0 more");
  });
});
