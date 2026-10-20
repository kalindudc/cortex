// lib/taskView.ts — the PURE task-list derivations behind the desktop
// app's task list. Every function maps inputs to a result.

import { describe, test, expect } from "bun:test";
import type { Task } from "../../../src/store.ts";
import {
  UNTAGGED,
  filterTasks,
  gateDone,
  includesDone,
  orderTasks,
  pickActiveTask,
  searchPool,
  stepSelection,
  type TaskFilters,
} from "../../../src/lib/taskView.ts";

const mk = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body: null,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  memory_excluded: false,
  ...over,
});

const NONE: TaskFilters = { status: null, lane: null, tag: [] };
const ids = (list: readonly Task[]) => list.map(t => t.id);

describe("searchPool", () => {
  test("an empty or blank query is no restriction (null), distinct from no matches ([])", () => {
    const tasks = [mk(1, { title: "alpha" })];
    expect(searchPool(tasks, "")).toBeNull();
    expect(searchPool(tasks, "   ")).toBeNull();
    expect(searchPool(tasks, "zzz")).toEqual([]);
    expect(searchPool(tasks, "alpha")?.map(r => r.task.id)).toEqual([1]);
  });
});

describe("filterTasks", () => {
  test("returns the input array itself when nothing restricts it", () => {
    const tasks = [mk(1), mk(2)];
    expect(filterTasks(tasks, null, NONE)).toBe(tasks);
  });

  test("query AND status AND lane AND tag compose; tags OR within the slot", () => {
    const tasks = [
      mk(1, { title: "needle one", tags: ["bug"] }),
      mk(2, { title: "needle two" }),
      mk(3, { lane: "b", title: "needle three", tags: ["bug"] }),
      mk(4, { status: "blocked", title: "needle four", tags: ["bug"] }),
      mk(5, { title: "haystack", tags: ["bug"] }),
      mk(6, { title: "needle six", tags: ["ui"] }),
    ];
    const results = searchPool(tasks, "needle");
    expect(ids(filterTasks(tasks, results, { status: "open", lane: "now", tag: ["bug"] }))).toEqual([1]);
    expect(ids(filterTasks(tasks, results, { status: "open", lane: "now", tag: ["bug", "ui"] }))).toEqual([1, 6]);
  });

  test("the UNTAGGED sentinel admits tasks without tags, OR-ed with named tags", () => {
    const tasks = [mk(1, { tags: ["bug"] }), mk(2), mk(3, { tags: ["ui"] })];
    expect(ids(filterTasks(tasks, null, { ...NONE, tag: [UNTAGGED] }))).toEqual([2]);
    expect(ids(filterTasks(tasks, null, { ...NONE, tag: [UNTAGGED, "ui"] }))).toEqual([2, 3]);
  });

  test("keeps the server (priority) order", () => {
    const tasks = [mk(3, { title: "c" }), mk(1, { title: "a" }), mk(2, { title: "b" })];
    expect(ids(filterTasks(tasks, null, { ...NONE, lane: "now" }))).toEqual([3, 1, 2]);
  });
});

describe("the Done-view exception (includesDone + gateDone)", () => {
  test("a status filter of done forces include-done; elsewhere the toggle keeps its meaning", () => {
    expect(includesDone(false, { status: "done" })).toBe(true);
    expect(includesDone(false, { status: "open" })).toBe(false);
    expect(includesDone(false, { status: null })).toBe(false);
    expect(includesDone(true, { status: null })).toBe(true);
    const tasks = [mk(1, { status: "done" }), mk(2)];
    expect(ids(gateDone(tasks, false))).toEqual([2]);
    expect(gateDone(tasks, true)).toBe(tasks);
  });
});

describe("orderTasks", () => {
  test("no query: natural title order (task-2 before task-12), server priority discarded", () => {
    const list = [mk(12, { title: "task-12", priority: 0 }), mk(2, { title: "task-2", priority: 5 })];
    expect(ids(orderTasks(list, null))).toEqual([2, 12]);
  });

  test("a query: relevance order, restricted to the given rows", () => {
    const tasks = [mk(1, { title: "zzz", body: "needle in body" }), mk(2, { title: "needle title" }), mk(3)];
    const results = searchPool(tasks, "needle");
    expect(ids(orderTasks([tasks[0] as Task, tasks[1] as Task], results))).toEqual([2, 1]);
    expect(ids(orderTasks([tasks[0] as Task], results))).toEqual([1]);
  });
});

describe("pickActiveTask", () => {
  const pool = [mk(1, { lane: "a" }), mk(2, { lane: "b" }), mk(3, { lane: "a", status: "done" })];

  test("an explicit selection wins from the WHOLE pool, even when filters exclude it", () => {
    const filtered = filterTasks(pool, null, { ...NONE, lane: "b" });
    expect(pickActiveTask(pool, filtered, 1, false)?.id).toBe(1);
    expect(pickActiveTask(pool, filtered, 3, false)?.id).toBe(3);
  });

  test("without a (live) selection: the first non-done task of the filtered server order", () => {
    const tasks = [mk(1, { title: "beta" }), mk(2, { title: "alpha" })];
    expect(pickActiveTask(tasks, tasks, null, false)?.id).toBe(1);
    expect(pickActiveTask(tasks, tasks, 99, false)?.id).toBe(1);
  });

  test("a lane of only done tasks has no fallback unless done tasks are included", () => {
    const ghosts = [mk(1, { status: "done" }), mk(2, { status: "done" })];
    expect(pickActiveTask(ghosts, ghosts, null, false)).toBeNull();
    expect(pickActiveTask(ghosts, ghosts, null, true)?.id).toBe(1);
  });
});

describe("stepSelection (Next/Previous task)", () => {
  const rows = [mk(1), mk(2), mk(3)];

  test("steps with wrap-around in both directions", () => {
    expect(stepSelection(rows, 1, 1)).toBe(2);
    expect(stepSelection(rows, 3, 1)).toBe(1);
    expect(stepSelection(rows, 1, -1)).toBe(3);
  });

  test("from outside the rows: Next enters at the first row, Previous at the last", () => {
    expect(stepSelection(rows, 42, 1)).toBe(1);
    expect(stepSelection(rows, null, -1)).toBe(3);
  });

  test("no rows: nothing to select", () => {
    expect(stepSelection([], 1, 1)).toBeNull();
  });
});
