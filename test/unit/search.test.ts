import { test, expect, describe } from "bun:test";
import type { Task } from "../../src/store.ts";
import { rankTasks, formatSearchLine, parseSelectedId } from "../../src/commands/search.ts";

// Pure-helper coverage for `cortex search`. The interactive fzf path is
// exercised manually / by humans — these tests pin the ranking, the fzf
// line format (field 1 MUST stay the bare task id), and the accepted-line
// parser that the interactive path depends on.

function mkTask(overrides: Partial<Task> & { id: number; title: string }): Task {
  return {
    lane: "now",
    body: null,
    status: "open",
    priority: null,
    created: 0,
    updated: 0,
    tags: [],
    memory_excluded: false,
    ...overrides,
  };
}

describe("rankTasks", () => {
  const tasks: Task[] = [
    mkTask({ id: 3, title: "gamma cleanup", priority: 0 }),
    mkTask({ id: 1, title: "alpha api gateway", body: "first task body", priority: 2 }),
    mkTask({ id: 2, title: "beta worker", body: "mentions alpha in the body", priority: 1, tags: ["infra"] }),
  ];

  test("empty and blank queries return every task sorted by id", () => {
    expect(rankTasks(tasks, "").map(t => t.id)).toEqual([1, 2, 3]);
    expect(rankTasks(tasks, "   ").map(t => t.id)).toEqual([1, 2, 3]);
  });

  test("does not mutate the input array order", () => {
    rankTasks(tasks, "");
    expect(tasks.map(t => t.id)).toEqual([3, 1, 2]);
  });

  test("ranks title matches above body matches and drops non-matches", () => {
    expect(rankTasks(tasks, "alpha").map(t => t.id)).toEqual([1, 2]);
  });

  test("@<digits> jumps to the exact id", () => {
    expect(rankTasks(tasks, "@2").map(t => t.id)).toEqual([2]);
    expect(rankTasks(tasks, "@99")).toEqual([]);
  });

  test("#tag returns tasks carrying the tag", () => {
    expect(rankTasks(tasks, "#infra").map(t => t.id)).toEqual([2]);
  });

  test("no match returns []", () => {
    expect(rankTasks(tasks, "zzz-nothing")).toEqual([]);
  });
});

describe("formatSearchLine", () => {
  test("plain line: id field, [id] badge title, truncated tags, lane", () => {
    const task = mkTask({ id: 7, title: "ship it", status: "done", tags: ["a", "b", "c", "d"], lane: "later" });
    expect(formatSearchLine(task, false)).toBe("7\t[7] ✓ ship it [#a #b #c +1] (later)");
  });

  test("no tags → no bracket segment", () => {
    const task = mkTask({ id: 5, title: "bare", status: "blocked" });
    expect(formatSearchLine(task, false)).toBe("5\t[5] ■ bare (now)");
  });

  test("colorized line keeps field 1 as the bare id", () => {
    const task = mkTask({ id: 12, title: "colored", tags: ["x"] });
    const line = formatSearchLine(task, true);
    expect(line.startsWith("12\t")).toBe(true);
    expect(line).toContain("\x1b[");
    expect(parseSelectedId(line)).toBe(12);
  });
});

describe("parseSelectedId", () => {
  test("recovers the id from field 1", () => {
    expect(parseSelectedId("42\t[42] ○ anything (now)")).toBe(42);
  });

  test("rejects garbage, empty, and non-positive ids", () => {
    expect(parseSelectedId("")).toBeNull();
    expect(parseSelectedId("nope\tstuff")).toBeNull();
    expect(parseSelectedId("0\tzero")).toBeNull();
    expect(parseSelectedId("-3\tneg")).toBeNull();
  });
});
