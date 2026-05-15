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
});
