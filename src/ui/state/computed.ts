// state/computed.ts — Derived values over signals.ts.
//
// Pure read-from-signals computations. No side effects.

import { computed, type ReadonlySignal } from "@preact/signals";
import type { Task, Update } from "../api/types.ts";
import { tasks, filters, selectedId, showAllTasks, updates, workspaceQuery } from "./signals.ts";
import { searchTasks, type TaskSearchResult } from "../lib/fuzzy.ts";

// Sentinel value for "filter to untagged tasks". Picked to be collision-free
// against TAG_NAME_RE (/^[a-z0-9_@-]{1,32}$/, src/store.ts:55) — the null
// byte cannot appear in a real tag name, so equality checks are safe.
export const UNTAGGED = "\u0000untagged";

// Full-pool search results for the workspace query (W3). Memoized by the
// computed: recomputes ONLY when tasks or the query change — structured
// filter changes reuse the cached result. Runs against the COMPLETE task
// pool BEFORE any structured filter intersects, so `#tag` exact-match
// resolution (fuzzy.ts falls back to substring when no exact tag exists in
// the searched pool) behaves identically whatever lane/status is selected.
// null = empty query = no search restriction (distinct from "no matches").
const searchResults: ReadonlySignal<TaskSearchResult[] | null> = computed(() => {
  const q = workspaceQuery.value.trim();
  if (!q) return null;
  return searchTasks(tasks.value, q);
});

// Composed task filter over the workspace query + unified `filters` signal:
//   query  — membership in the full-pool search results (AND)
//   status — task.status equality (AND)
//   lane   — task.lane equality   (AND)
//   tag    — OR over the array; an entry is satisfied when the task carries
//            that tag, OR the entry is the UNTAGGED sentinel and the task
//            has zero tags. Empty array = no tag filter.
// Any null/empty slot is a no-op. Output preserves server (priority) order.
export const filteredTasks: ReadonlySignal<Task[]> = computed(() => {
  const { status, lane, tag } = filters.value;
  let out = tasks.value;
  const results = searchResults.value;
  if (results != null) {
    const matched = new Set(results.map(r => r.task.id));
    out = out.filter(t => matched.has(t.id));
  }
  if (status) out = out.filter(t => t.status === status);
  if (lane) out = out.filter(t => t.lane === lane);
  if (tag.length > 0) {
    out = out.filter(t => {
      const taskTags = Array.isArray(t.tags) ? t.tags : [];
      // Match if any selected tag is present on the task, OR if UNTAGGED is
      // selected and the task has no tags at all.
      return tag.some(sel => (sel === UNTAGGED ? taskTags.length === 0 : taskTags.includes(sel)));
    });
  }
  return out;
});

// Done-view exception (W4): the include-done gate is bypassed while the
// status filter IS "done" — selecting the Done view must show done tasks
// regardless of the eye toggle. Everywhere else showAllTasks keeps its
// meaning. Shared by visibleTasks and the activeTask fallback so the
// sidebar list and the default selection can never disagree.
const includeDone: ReadonlySignal<boolean> = computed(() => showAllTasks.value || filters.value.status === "done");

// Composed with the include-done gate above: when hidden, done tasks are
// filtered out. Single source of truth for "what the user actually sees" —
// consumed by the task list, the StatusBar shown count and the display
// ordering below, so all stay in lockstep.
export const visibleTasks: ReadonlySignal<Task[]> = computed(() => {
  const list = filteredTasks.value;
  return includeDone.value ? list : list.filter(t => t.status !== "done");
});

// Display order for the task list and Next/Previous cycling (W4):
//   empty query    → natural title order (numeric-aware, so task-2 sorts
//                    before task-12) — the order the sidebar has always
//                    rendered;
//   nonempty query → search relevance order straight from searchTasks
//                    (score descending).
// activeTask's priority FALLBACK intentionally does NOT consume this — it
// keeps the server's priority order via filteredTasks.
export const orderedVisibleTasks: ReadonlySignal<Task[]> = computed(() => {
  const list = visibleTasks.value;
  const results = searchResults.value;
  if (results == null) {
    return [...list].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
  }
  const visibleIds = new Set(list.map(t => t.id));
  return results.filter(r => visibleIds.has(r.task.id)).map(r => r.task);
});

// Legacy alias retained while call sites migrate. Delete once nothing
// imports tasksInLane (search src/ for remaining references after the
// SidebarPane swap lands).
export const tasksInLane = filteredTasks;

export const activeTask: ReadonlySignal<Task | null> = computed(() => {
  // Two-stage filter:
  //   1. selectedId branch runs against the UNGATED pool — an explicit user
  //      selection (click in sidebar OR restored from localStorage) wins
  //      over the showAllTasks toggle. Toggling the eye off while reading
  //      a done task must not yank it from the active pane, and a stored
  //      selectedId pointing at a done task must restore on reload.
  //   2. The priority fallback applies the showAllTasks gate so a lane of
  //      only-done tasks (with no selection) doesn't surface one through
  //      the back door even though the sidebar hides it.
  const base = filteredTasks.value;
  if (selectedId.value != null) {
    // Filter governs the sidebar LIST only — the right-pane active task
    // is invariant under filter changes. Look up against the UNFILTERED
    // pool so a lane/status/tag filter that excludes the active task does
    // NOT yank the user onto a different one. The priority-fallback branch
    // below (selectedId == null) still operates over the filtered+gated
    // view to honor "no selection → top of current view".
    const t = tasks.value.find(x => x.id === selectedId.value);
    if (t) return t;
  }
  const list = includeDone.value ? base : base.filter(t => t.status !== "done");
  // Fall back to the highest-priority open task in the current view.
  return list.find(t => t.status !== "done") ?? list[0] ?? null;
});

export const inboxList: ReadonlySignal<Update[]> = computed(() => {
  const at = activeTask.value;
  if (!at) return [];
  return [...(updates.value[at.id] ?? [])].reverse();
});

// Tasks currently in the blocked status. Drives the sticky red top-bar in
// App() and the click-to-jump behaviour (selects the first one).
export const blockedTasks: ReadonlySignal<Task[]> = computed(() => tasks.value.filter(t => t.status === "blocked"));

// Authors of the active task derived from its loaded updates. Group by
// author, take MAX(created) as last_seen and COUNT(*) as posts. Sorted
// by most-recent post first to match the global /api/authors shape.
// Pure client-side derivation — Update rows already include `author`
// and `created`, so no extra fetch is needed.
export interface TaskAuthor {
  author: string;
  last_seen: number;
  posts: number;
}
export const taskAuthors: ReadonlySignal<TaskAuthor[]> = computed(() => {
  const at = activeTask.value;
  if (!at) return [];
  const list = updates.value[at.id] ?? [];
  const acc = new Map<string, TaskAuthor>();
  for (const u of list) {
    const prev = acc.get(u.author);
    if (!prev) {
      acc.set(u.author, { author: u.author, last_seen: u.created, posts: 1 });
    } else {
      prev.posts += 1;
      if (u.created > prev.last_seen) prev.last_seen = u.created;
    }
  }
  return Array.from(acc.values()).sort((a, b) => b.last_seen - a.last_seen);
});
