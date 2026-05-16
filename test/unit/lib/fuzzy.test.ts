// fuzzy.ts — lightweight client-side task fuzzy scorer.

import { describe, test, expect } from "bun:test";
import { searchTasks } from "../../../src/ui/lib/fuzzy.ts";
import type { Task } from "../../../src/ui/api/types.ts";

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    lane: "now",
    title: "Fix the bug",
    body: "There is a bug in the parser",
    status: "open",
    priority: 1,
    created: 0,
    updated: 0,
    tags: ["bug", "ui"],
    ...over,
  };
}

describe("searchTasks", () => {
  test("empty query returns empty array", () => {
    expect(searchTasks([task()], "")).toEqual([]);
    expect(searchTasks([task()], "   ")).toEqual([]);
  });

  test("title match scores higher than body match", () => {
    const tasks = [
      task({ id: 1, title: "Parser bug", body: "minor issue" }),
      task({ id: 2, title: "Refactor", body: "There is a bug in the parser" }),
    ];
    const results = searchTasks(tasks, "parser");
    expect(results.length).toBe(2);
    expect(results[0].task.id).toBe(1); // title match first
    expect(results[1].task.id).toBe(2); // body match second
  });

  test("@prefix searches only titles", () => {
    const tasks = [
      task({ id: 1, title: "Parser bug", body: "There is a bug in the parser" }),
      task({ id: 2, title: "Refactor", body: "There is a bug in the parser" }),
    ];
    const results = searchTasks(tasks, "@parser");
    expect(results.length).toBe(1);
    expect(results[0].task.id).toBe(1);
  });

  test("#prefix searches only tags", () => {
    const tasks = [
      task({ id: 1, title: "Alpha", tags: ["bug", "ui"] }),
      task({ id: 2, title: "Beta", tags: ["feature"] }),
    ];
    const results = searchTasks(tasks, "#bug");
    expect(results.length).toBe(1);
    expect(results[0].task.id).toBe(1);
  });

  test("multi-token query requires all tokens (AND semantics)", () => {
    const tasks = [
      task({ id: 1, title: "Fix the bug", body: "", tags: [] }),
      task({ id: 2, title: "Fix the leak", body: "", tags: [] }),
    ];
    const results = searchTasks(tasks, "fix bug");
    expect(results.length).toBe(1);
    expect(results[0].task.id).toBe(1);
  });

  test("tag match scores higher than body match in default mode", () => {
    const tasks = [
      task({ id: 1, title: "Alpha", body: "nothing here", tags: ["parser"] }),
      task({ id: 2, title: "Beta", body: "parser is broken", tags: [] }),
    ];
    const results = searchTasks(tasks, "parser");
    expect(results.length).toBe(2);
    expect(results[0].task.id).toBe(1); // tag match > body match
  });

  test("case-insensitive matching", () => {
    const tasks = [task({ title: "UPPERCASE" })];
    const results = searchTasks(tasks, "uppercase");
    expect(results.length).toBe(1);
  });

  // --- @<digits> exact-id shortcut

  test('"@123" jumps directly to the task with id 123 (single result)', () => {
    const tasks = [
      task({ id: 12, title: "Twelve" }),
      task({ id: 123, title: "Onetwothree" }),
      task({ id: 1234, title: "Onetwothreefour" }),
    ];
    const results = searchTasks(tasks, "@123");
    expect(results.length).toBe(1);
    expect(results[0].task.id).toBe(123);
    expect(results[0].score).toBe(Number.POSITIVE_INFINITY);
  });

  test('"@<digits>" with no matching task returns empty array', () => {
    const tasks = [task({ id: 1 })];
    expect(searchTasks(tasks, "@9999")).toEqual([]);
  });

  test('"@<non-digits>" falls through to existing title-fuzzy behaviour', () => {
    const tasks = [task({ id: 1, title: "Parser bug" }), task({ id: 2, title: "Refactor", body: "parser issue" })];
    const results = searchTasks(tasks, "@parser");
    expect(results.length).toBe(1);
    expect(results[0].task.id).toBe(1);
  });

  // --- #<exact-tag> shortcut

  test('"#bug" with an EXACT tag match returns every task carrying that tag', () => {
    const tasks = [
      task({ id: 1, title: "A", tags: ["bug", "ui"], priority: 1 }),
      task({ id: 2, title: "B", tags: ["bug"], priority: 0 }),
      task({ id: 3, title: "C", tags: ["feature"] }),
    ];
    const results = searchTasks(tasks, "#bug");
    expect(results.map(r => r.task.id)).toEqual([2, 1]); // priority asc
  });

  test('"#bug" sorts by priority ASC then id ASC', () => {
    const tasks = [
      task({ id: 5, title: "A", tags: ["bug"], priority: 5 }),
      task({ id: 3, title: "B", tags: ["bug"], priority: 0 }),
      task({ id: 8, title: "C", tags: ["bug"], priority: 5 }),
    ];
    const results = searchTasks(tasks, "#bug");
    expect(results.map(r => r.task.id)).toEqual([3, 5, 8]);
  });

  test('"#fe" with NO exact tag falls through to substring fuzzy (existing behaviour)', () => {
    const tasks = [task({ id: 1, title: "A", tags: ["feature"] }), task({ id: 2, title: "B", tags: ["bug"] })];
    const results = searchTasks(tasks, "#fe");
    expect(results.length).toBe(1);
    expect(results[0].task.id).toBe(1);
  });

  test('"#bug" with NO task carrying the exact tag falls through to substring fuzzy', () => {
    // No task has tag exactly == "bug" but one has "bugfix" which contains "bug".
    const tasks = [task({ id: 1, title: "A", tags: ["bugfix"] })];
    const results = searchTasks(tasks, "#bug");
    expect(results.length).toBe(1);
    expect(results[0].task.id).toBe(1);
  });
});
