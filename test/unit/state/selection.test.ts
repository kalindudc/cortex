// Unit tests for state/selection.ts — Next/Previous task cycling.
//
// The workspace plan (task 330, W4) changes the cycle source from the
// filter-only tasksInLane to orderedVisibleTasks: the DISPLAYED rows
// (natural title order for an empty query, search relevance for a nonempty
// query, done-visibility gate applied). When the active task is outside the
// displayed rows, Next selects the first row and Previous the last.

import { describe, test, expect, beforeEach } from "bun:test";
import { tasks, filters, selectedId, showAllTasks, workspaceQuery } from "../../../src/ui/state/signals.ts";
import { moveSelection } from "../../../src/ui/state/selection.ts";
import type { Task } from "../../../src/ui/api/types.ts";

const mkTask = (id: number, title: string, over: Partial<Task> = {}): Task => ({
  id,
  lane: "now",
  title,
  body: null,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  ...over,
});

describe("state/selection moveSelection", () => {
  beforeEach(() => {
    tasks.value = [];
    filters.value = { status: null, lane: null, tag: [] };
    selectedId.value = null;
    showAllTasks.value = false;
    workspaceQuery.value = "";
  });

  test("empty visible list → no-op", () => {
    moveSelection(1);
    expect(selectedId.value).toBeNull();
  });

  test("cycles in displayed (natural title) order, not server order", () => {
    // Server order: by priority — id 3 first. Title order: alpha(1), beta(2), gamma(3).
    tasks.value = [mkTask(3, "gamma", { priority: 0 }), mkTask(1, "alpha", { priority: 5 }), mkTask(2, "beta")];
    selectedId.value = 1; // "alpha", first displayed row
    moveSelection(1);
    expect(selectedId.value).toBe(2); // "beta" is next by title, NOT gamma by priority
    moveSelection(1);
    expect(selectedId.value).toBe(3);
    moveSelection(1); // wraps
    expect(selectedId.value).toBe(1);
  });

  test("natural numeric title order: task-2 precedes task-12", () => {
    tasks.value = [mkTask(12, "task-12"), mkTask(2, "task-2")];
    selectedId.value = 2;
    moveSelection(1);
    expect(selectedId.value).toBe(12);
  });

  test("previous wraps from the first displayed row to the last", () => {
    tasks.value = [mkTask(1, "alpha"), mkTask(2, "beta")];
    selectedId.value = 1;
    moveSelection(-1);
    expect(selectedId.value).toBe(2);
  });

  test("nonempty query → cycles in search relevance order", () => {
    tasks.value = [
      mkTask(1, "zzz", { body: "needle mentioned once" }),
      mkTask(2, "needle exact title"),
      mkTask(3, "unrelated"),
    ];
    workspaceQuery.value = "needle";
    // Relevance: title match (id 2) scores above body match (id 1); id 3 filtered out.
    selectedId.value = 2;
    moveSelection(1);
    expect(selectedId.value).toBe(1);
    moveSelection(1); // wraps within the 2 matching rows
    expect(selectedId.value).toBe(2);
  });

  test("active task outside displayed rows: Next selects the FIRST row", () => {
    tasks.value = [
      mkTask(1, "alpha", { lane: "a" }),
      mkTask(2, "beta", { lane: "b" }),
      mkTask(3, "gamma", { lane: "b" }),
    ];
    selectedId.value = 1;
    filters.value = { status: null, lane: "b", tag: [] }; // active task 1 now outside rows
    moveSelection(1);
    expect(selectedId.value).toBe(2); // first displayed row (beta)
  });

  test("active task outside displayed rows: Previous selects the LAST row", () => {
    tasks.value = [
      mkTask(1, "alpha", { lane: "a" }),
      mkTask(2, "beta", { lane: "b" }),
      mkTask(3, "gamma", { lane: "b" }),
    ];
    selectedId.value = 1;
    filters.value = { status: null, lane: "b", tag: [] };
    moveSelection(-1);
    expect(selectedId.value).toBe(3); // last displayed row (gamma)
  });

  test("done tasks are excluded from cycling when hidden by the include-done gate", () => {
    tasks.value = [mkTask(1, "alpha"), mkTask(2, "beta", { status: "done" }), mkTask(3, "gamma")];
    selectedId.value = 1;
    moveSelection(1);
    expect(selectedId.value).toBe(3); // beta (done) skipped
  });
});
