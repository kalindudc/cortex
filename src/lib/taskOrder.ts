// The task list's order, used by the desktop
// renderer: nine sorts (a leading `-` reverses the key; ties always break by
// ascending id) and three groupings (a header per lane, in lane-catalog
// order, or per status, draft to done). A search ignores both and keeps the
// relevance ranking in one flat list. Pure: the renderer bundles this file.

import type { Lane, Task, TaskStatus } from "../store.ts";
import { STATUS, STATUS_LABEL } from "./constants.ts";
import type { TaskSearchResult } from "./fuzzy.ts";
import { orderTasks } from "./taskView.ts";

/** The task list's orders: a leading `-` reverses one; ties always break by ascending id. */
export const TASK_SORTS = [
  "id",
  "-id",
  "title",
  "-title",
  "lane",
  "status",
  "priority",
  "updated",
  "-updated",
] as const;
export type TaskSort = (typeof TASK_SORTS)[number];
/** The task list's groupings: a header row per lane or status. */
export const TASK_GROUPS = ["none", "lane", "status"] as const;
export type TaskGroup = (typeof TASK_GROUPS)[number];

export const SORT_HELP: Readonly<Record<TaskSort, string>> = {
  id: "ascending task id (the default)",
  "-id": "newest task first",
  title: "title, A to Z (numbers in order)",
  "-title": "title, Z to A",
  lane: "lane order, then id",
  status: "draft, open, review, blocked, done",
  priority: "P0 first, unset last",
  updated: "least recently updated first",
  "-updated": "most recently updated first",
};

export const GROUP_HELP: Readonly<Record<TaskGroup, string>> = {
  none: "one flat list",
  lane: "a header per lane, with its count",
  status: "a header per status, with its count",
};

export const isTaskSort = (value: unknown): value is TaskSort => (TASK_SORTS as readonly unknown[]).includes(value);
export const isTaskGroup = (value: unknown): value is TaskGroup => (TASK_GROUPS as readonly unknown[]).includes(value);

/** One group header of a grouped list: `count` rows from `start`. */
export interface TaskListGroup {
  /** The lane name or the status. */
  readonly key: string;
  /** Raw text (a lane name is untrusted: escape it before rendering). */
  readonly label: string;
  readonly status: TaskStatus | null;
  readonly start: number;
  readonly count: number;
}

export interface TaskArrangement {
  /** The displayed rows in display order. Never capped. */
  readonly rows: Task[];
  /** The order shown: the sort, or relevance while a query ranks the results. */
  readonly order: TaskSort | "relevance";
  /** The grouping shown (none while a query ranks the results). */
  readonly group: TaskGroup;
  /** The group headers in display order (empty without grouping). */
  readonly groups: readonly TaskListGroup[];
}

type LaneRank = ReadonlyMap<string, number>;

const laneRanks = (lanes: readonly Lane[]): LaneRank => new Map(lanes.map((l, i) => [l.name, i]));

/** Lanes by the catalog order; lanes missing from it after, by name. */
function compareLanes(a: string, b: string, rank: LaneRank): number {
  const ra = rank.get(a) ?? Number.POSITIVE_INFINITY;
  const rb = rank.get(b) ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

const statusRank = (status: TaskStatus): number => (STATUS as readonly TaskStatus[]).indexOf(status);
// Natural title collation (numeric-aware: task-2 before task-12).
const compareTitles = (a: Task, b: Task): number =>
  a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });

function sortRanked(list: readonly Task[], sort: TaskSort, rank: LaneRank): Task[] {
  const desc = sort.startsWith("-");
  const key = (desc ? sort.slice(1) : sort) as "id" | "title" | "lane" | "status" | "priority" | "updated";
  const compare = (a: Task, b: Task): number => {
    switch (key) {
      case "id":
        return a.id - b.id;
      case "title":
        return compareTitles(a, b);
      case "lane":
        return compareLanes(a.lane, b.lane, rank);
      case "status":
        return statusRank(a.status) - statusRank(b.status);
      case "priority": {
        const pa = a.priority ?? Number.POSITIVE_INFINITY;
        const pb = b.priority ?? Number.POSITIVE_INFINITY;
        return pa === pb ? 0 : pa < pb ? -1 : 1;
      }
      case "updated":
        return a.updated - b.updated;
    }
  };
  return [...list].sort((a, b) => {
    const primary = compare(a, b);
    if (primary !== 0) return desc ? -primary : primary;
    return a.id - b.id;
  });
}

function groupRanked(
  sorted: readonly Task[],
  group: TaskGroup,
  rank: LaneRank,
): { rows: Task[]; groups: TaskListGroup[] } {
  if (group === "none" || sorted.length === 0) return { rows: [...sorted], groups: [] };
  const keyOf = (t: Task): string => (group === "lane" ? t.lane : t.status);
  const buckets = new Map<string, Task[]>();
  for (const t of sorted) {
    const bucket = buckets.get(keyOf(t));
    if (bucket === undefined) buckets.set(keyOf(t), [t]);
    else bucket.push(t);
  }
  const keys = [...buckets.keys()].sort((a, b) =>
    group === "lane" ? compareLanes(a, b, rank) : statusRank(a as TaskStatus) - statusRank(b as TaskStatus),
  );
  const rows: Task[] = [];
  const groups: TaskListGroup[] = [];
  for (const key of keys) {
    const members = buckets.get(key) ?? [];
    const status = group === "status" ? (key as TaskStatus) : null;
    groups.push({
      key,
      label: status === null ? key : STATUS_LABEL[status],
      status,
      start: rows.length,
      count: members.length,
    });
    rows.push(...members);
  }
  return { rows, groups };
}

/**
 * `list` in a sort order (a new array): id, title (natural), lane (the
 * catalog order), status (draft, open, review, blocked, done), priority (P0
 * first, unset last) or updated; a leading `-` reverses the key. Ties always
 * break by ascending id.
 */
export function sortTasks(list: readonly Task[], sort: TaskSort, lanes: readonly Lane[] = []): Task[] {
  return sortRanked(list, sort, laneRanks(lanes));
}

/** Stable-group sorted rows by lane (catalog order) or status, with one header per group. */
export function groupTasks(
  sorted: readonly Task[],
  group: TaskGroup,
  lanes: readonly Lane[] = [],
): { rows: Task[]; groups: TaskListGroup[] } {
  return groupRanked(sorted, group, laneRanks(lanes));
}

/**
 * The displayed list for `gated` (the filtered, done-gated tasks): with
 * search `results`, their relevance order in one flat list; otherwise
 * `sort`, then `group`.
 */
export function arrangeTasks(
  gated: readonly Task[],
  results: readonly TaskSearchResult[] | null,
  sort: TaskSort,
  group: TaskGroup,
  lanes: readonly Lane[],
): TaskArrangement {
  if (results !== null) {
    // The shared src/lib helpers are typed over mutable arrays; none mutates.
    return { rows: orderTasks(gated as Task[], results), order: "relevance", group: "none", groups: [] };
  }
  const rank = laneRanks(lanes);
  const { rows, groups } = groupRanked(sortRanked(gated, sort, rank), group, rank);
  return { rows, order: sort, group, groups };
}
