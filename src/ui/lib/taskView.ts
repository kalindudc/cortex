// lib/taskView.ts — The PURE task-list derivations behind state/computed.ts
// and state/selection.ts, shared with the terminal workspace
// (src/tui/workspace.ts). No signals, DOM or fetch: every function maps its
// inputs to a result, so both clients compute the list the same way.
//
//   searchPool     — full-pool search (W3): runs on the COMPLETE task pool
//                    BEFORE any structured filter, so `#tag` exact-match
//                    resolution never depends on the lane/status in view.
//   filterTasks    — query membership AND status AND lane AND tags (OR,
//                    plus the UNTAGGED sentinel); server (priority) order.
//   includesDone   — the Done-view exception (W4): a status filter of done
//   / gateDone       shows done tasks whatever the include-done toggle says.
//   orderTasks     — display order (W4): natural title order without a
//                    query, search relevance with one.
//   pickActiveTask — an explicit selection wins from the WHOLE pool (filters
//                    never yank it); otherwise the first non-done task of
//                    the filtered, gated SERVER order.
//   stepSelection  — Next/Previous task through the displayed rows.

import type { Task, TaskStatus } from "../api/types.ts";
import { searchTasks, type TaskSearchResult } from "./fuzzy.ts";

// Sentinel value for "filter to untagged tasks". Picked to be collision-free
// against TAG_NAME_RE (/^[a-z0-9_@-]{1,32}$/, src/store.ts) — the null byte
// cannot appear in a real tag name, so equality checks are safe.
export const UNTAGGED = "\u0000untagged";

/** The three structured filter slots (the browser's `Filters` signal shape). */
export interface TaskFilters {
  readonly status: TaskStatus | null;
  readonly lane: string | null;
  /** OR-composed tag names (or UNTAGGED). Empty = no tag filter. */
  readonly tag: readonly string[];
}

/** Full-pool search results for a workspace query; null for an empty query (no restriction, distinct from no matches). */
export function searchPool(tasks: Task[], query: string): TaskSearchResult[] | null {
  const q = query.trim();
  if (!q) return null;
  return searchTasks(tasks, q);
}

/**
 * Compose the query results with the filter slots. Any null/empty slot is a
 * no-op; the output keeps the server (priority) order and is the input array
 * itself when nothing restricts it.
 */
export function filterTasks(tasks: Task[], results: readonly TaskSearchResult[] | null, filters: TaskFilters): Task[] {
  const { status, lane, tag } = filters;
  let out = tasks;
  if (results != null) {
    const matched = new Set(results.map(r => r.task.id));
    out = out.filter(t => matched.has(t.id));
  }
  if (status) out = out.filter(t => t.status === status);
  if (lane) out = out.filter(t => t.lane === lane);
  if (tag.length > 0) {
    out = out.filter(t => {
      const taskTags = Array.isArray(t.tags) ? t.tags : [];
      // Any selected tag present on the task, OR UNTAGGED selected and the task has no tags at all.
      return tag.some(sel => (sel === UNTAGGED ? taskTags.length === 0 : taskTags.includes(sel)));
    });
  }
  return out;
}

/** Whether done tasks show: the include-done toggle, or a status filter of done (the Done-view exception). */
export function includesDone(showAll: boolean, filters: Pick<TaskFilters, "status">): boolean {
  return showAll || filters.status === "done";
}

/** Drop done tasks unless they are included (the input array itself when they are). */
export function gateDone(list: Task[], includeDone: boolean): Task[] {
  return includeDone ? list : list.filter(t => t.status !== "done");
}

/**
 * Display order: natural title order (numeric-aware, so task-2 sorts before
 * task-12) for an empty query; search relevance (score descending) for a
 * nonempty one, restricted to `list`.
 */
export function orderTasks(list: Task[], results: readonly TaskSearchResult[] | null): Task[] {
  if (results == null) {
    return [...list].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
  }
  const visibleIds = new Set(list.map(t => t.id));
  return results.filter(r => visibleIds.has(r.task.id)).map(r => r.task);
}

/**
 * The active task. An explicit selection is looked up in the WHOLE pool: a
 * lane/status/tag/search filter that excludes it never yanks the user onto
 * another task, and the include-done gate never hides it. Without a (live)
 * selection: the first non-done task of the filtered, gated view in server
 * (priority) order, not display order.
 */
export function pickActiveTask(
  pool: readonly Task[],
  filtered: Task[],
  selectedId: number | null,
  includeDone: boolean,
): Task | null {
  if (selectedId != null) {
    const t = pool.find(x => x.id === selectedId);
    if (t) return t;
  }
  const list = gateDone(filtered, includeDone);
  return list.find(t => t.status !== "done") ?? list[0] ?? null;
}

/**
 * Next (+1) / Previous (-1) through the displayed rows, wrapping around. When
 * the active task is not among them, Next enters at the FIRST row and
 * Previous at the LAST. Returns the task id to select, or null without rows.
 */
export function stepSelection(rows: readonly Task[], activeId: number | null, delta: number): number | null {
  if (rows.length === 0) return null;
  const i = activeId == null ? -1 : rows.findIndex(t => t.id === activeId);
  if (i === -1) {
    const entry = delta > 0 ? rows[0] : rows[rows.length - 1];
    return entry ? entry.id : null;
  }
  const n = rows.length;
  const next = rows[(((i + delta) % n) + n) % n];
  return next ? next.id : null;
}
