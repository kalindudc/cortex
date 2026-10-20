// lib/taskOrder.ts — the task list's sorts and groupings, used by the
// desktop renderer.

import { describe, expect, test } from "bun:test";
import { STATUS_LABEL } from "../../../src/lib/constants.ts";
import { searchPool } from "../../../src/lib/taskView.ts";
import {
  arrangeTasks,
  describeSort,
  GROUP_HELP,
  groupTasks,
  isDescending,
  isTaskGroup,
  isTaskSort,
  listedRows,
  SORT_FIELDS,
  SORT_HELP,
  sortField,
  sortOf,
  sortTasks,
  TASK_GROUPS,
  TASK_SORTS,
} from "../../../src/lib/taskOrder.ts";
import type { Lane, Task } from "../../../src/store.ts";

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
const lane = (name: string, sort: number): Lane => ({ name, color: null, sort });
const ids = (list: readonly Task[]) => list.map(t => t.id);

const LANES = [lane("now", 0), lane("later", 1)];
const POOL = [
  mk(3, { title: "task-12", lane: "later", status: "done", priority: 2, updated: 30 }),
  mk(1, { title: "task-2", lane: "zeta", status: "review", priority: null, updated: 50 }),
  mk(4, { title: "Task-2", lane: "now", status: "draft", priority: 0, updated: 10 }),
  mk(2, { title: "alpha", lane: "alpha", status: "blocked", priority: 2, updated: 50 }),
  mk(5, { title: "beta", lane: "now", status: "open", priority: null, updated: 20 }),
];

describe("sortTasks", () => {
  test("every order, ties by ascending id, `-` reversing only the key", () => {
    const by = (sort: (typeof TASK_SORTS)[number]) => ids(sortTasks(POOL, sort, LANES));
    expect(by("id")).toEqual([1, 2, 3, 4, 5]);
    expect(by("-id")).toEqual([5, 4, 3, 2, 1]);
    // Natural, case-insensitive: "task-2" and "Task-2" tie (ascending id), task-12 after them.
    expect(by("title")).toEqual([2, 5, 1, 4, 3]);
    expect(by("-title")).toEqual([3, 1, 4, 5, 2]);
    // Catalog order (now, later), then unknown lanes by name (alpha, zeta).
    expect(by("lane")).toEqual([4, 5, 3, 2, 1]);
    expect(by("-lane")).toEqual([1, 2, 3, 4, 5]);
    expect(by("status")).toEqual([4, 5, 1, 2, 3]);
    expect(by("-status")).toEqual([3, 2, 1, 5, 4]);
    // P0 first, unset last; equal priorities by ascending id.
    expect(by("priority")).toEqual([4, 2, 3, 1, 5]);
    // Reversed, tasks without a priority still come last.
    expect(by("-priority")).toEqual([2, 3, 4, 1, 5]);
    expect(by("updated")).toEqual([4, 5, 3, 1, 2]);
    // Reversed key, ties (1 and 2 at 50) still ascending id.
    expect(by("-updated")).toEqual([1, 2, 3, 5, 4]);
  });

  test("returns a new array and leaves the input alone", () => {
    const input = [...POOL];
    const out = sortTasks(input, "id");
    expect(out).not.toBe(input);
    expect(ids(input)).toEqual([3, 1, 4, 2, 5]);
  });

  test("without a catalog, lanes sort by name", () => {
    expect(ids(sortTasks(POOL, "lane"))).toEqual([2, 3, 4, 5, 1]);
  });
});

describe("groupTasks", () => {
  test("lane groups follow the catalog, then unknown lanes by name, with raw names, counts and starts", () => {
    const { rows, groups } = groupTasks(sortTasks(POOL, "id", LANES), "lane", LANES);
    expect(ids(rows)).toEqual([4, 5, 3, 2, 1]);
    expect(groups).toEqual([
      { key: "now", label: "now", status: null, start: 0, count: 2 },
      { key: "later", label: "later", status: null, start: 2, count: 1 },
      { key: "alpha", label: "alpha", status: null, start: 3, count: 1 },
      { key: "zeta", label: "zeta", status: null, start: 4, count: 1 },
    ]);
  });

  test("status groups run draft to done with STATUS_LABEL labels, keeping the sort inside each", () => {
    const pool = [...POOL, mk(6, { status: "open", title: "aaa" })];
    const { rows, groups } = groupTasks(sortTasks(pool, "title"), "status");
    expect(ids(rows)).toEqual([4, 6, 5, 1, 2, 3]);
    expect(groups.map(g => [g.key, g.label, g.status, g.start, g.count])).toEqual([
      ["draft", STATUS_LABEL.draft, "draft", 0, 1],
      ["open", STATUS_LABEL.open, "open", 1, 2],
      ["review", STATUS_LABEL.review, "review", 3, 1],
      ["blocked", STATUS_LABEL.blocked, "blocked", 4, 1],
      ["done", STATUS_LABEL.done, "done", 5, 1],
    ]);
  });

  test("no grouping, or no rows, gives no headers", () => {
    expect(groupTasks(POOL, "none").groups).toEqual([]);
    expect(groupTasks([], "lane")).toEqual({ rows: [], groups: [] });
  });
});

describe("arrangeTasks", () => {
  test("without a search: the sort, then the grouping", () => {
    const arranged = arrangeTasks(POOL, null, "-id", "status", LANES);
    expect(arranged.order).toBe("-id");
    expect(arranged.group).toBe("status");
    expect(ids(arranged.rows)).toEqual([4, 5, 1, 2, 3]);
    expect(arranged.groups.map(g => g.key)).toEqual(["draft", "open", "review", "blocked", "done"]);
  });

  test("a search keeps relevance in one flat list, whatever sort and group are passed", () => {
    const results = searchPool(POOL, "task");
    expect(results).not.toBeNull();
    for (const sort of TASK_SORTS) {
      for (const group of TASK_GROUPS) {
        const arranged = arrangeTasks(POOL, results, sort, group, LANES);
        expect(arranged.order).toBe("relevance");
        expect(arranged.group).toBe("none");
        expect(arranged.groups).toEqual([]);
        expect(ids(arranged.rows)).toEqual((results ?? []).map(r => r.task.id));
      }
    }
  });

  test("a search drops results outside the gated rows", () => {
    const results = searchPool(POOL, "task");
    const arranged = arrangeTasks(
      POOL.filter(t => t.status !== "done"),
      results,
      "id",
      "none",
      LANES,
    );
    expect(ids(arranged.rows)).not.toContain(3);
  });
});

describe("listedRows", () => {
  test("drops the rows of folded groups and keeps the rest in order", () => {
    const arranged = arrangeTasks(POOL, null, "id", "lane", LANES);
    const lanes = arranged.groups.map(g => g.key);
    expect(lanes).toEqual(["now", "later", "alpha", "zeta"]);
    expect(ids(listedRows(arranged, []))).toEqual(ids(arranged.rows));
    const withoutLater = listedRows(arranged, ["later"]);
    expect(withoutLater.some(t => t.lane === "later")).toBe(false);
    expect(ids(withoutLater)).toEqual(ids(arranged.rows.filter(t => t.lane !== "later")));
    expect(listedRows(arranged, lanes)).toEqual([]);
  });

  test("an ungrouped or searched list ignores folds", () => {
    const flat = arrangeTasks(POOL, null, "id", "none", LANES);
    expect(ids(listedRows(flat, ["now"]))).toEqual(ids(flat.rows));
    const searched = arrangeTasks(POOL, searchPool(POOL, "task"), "id", "lane", LANES);
    expect(ids(listedRows(searched, ["now"]))).toEqual(ids(searched.rows));
  });
});

describe("guards and help", () => {
  test("isTaskSort and isTaskGroup accept exactly the lists", () => {
    for (const s of TASK_SORTS) expect(isTaskSort(s)).toBe(true);
    for (const g of TASK_GROUPS) expect(isTaskGroup(g)).toBe(true);
    for (const bad of ["", "ID", "--id", "group", 1, null, undefined]) {
      expect(isTaskSort(bad)).toBe(false);
      expect(isTaskGroup(bad)).toBe(false);
    }
  });

  test("every field sorts both ways, and a sort splits into its field and direction", () => {
    expect(TASK_SORTS).toEqual(SORT_FIELDS.flatMap(f => [f, `-${f}` as const]));
    for (const f of SORT_FIELDS) {
      for (const descending of [false, true]) {
        const sort = sortOf(f, descending);
        expect(sortField(sort)).toBe(f);
        expect(isDescending(sort)).toBe(descending);
      }
    }
    expect(describeSort("title")).toBe("title");
    expect(describeSort("-id")).toBe("id descending");
  });

  test("every sort field and grouping has help text", () => {
    expect(Object.keys(SORT_HELP).sort()).toEqual([...SORT_FIELDS].sort());
    expect(Object.keys(GROUP_HELP).sort()).toEqual([...TASK_GROUPS].sort());
  });
});
