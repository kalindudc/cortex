// state/computed.ts — Derived values over signals.ts.
//
// Pure read-from-signals computations. No side effects. The derivations
// themselves live in lib/taskView.ts (pure functions); this module only wires them to the signals.

import { computed, type ReadonlySignal } from "@preact/signals";
import type { Task, Update } from "../api/types.ts";
import { tasks, filters, lanes, selectedId, showAllTasks, updates, workspaceQuery } from "./signals.ts";
import { taskGroup, taskSort } from "./settings.ts";
import type { TaskSearchResult } from "../../lib/fuzzy.ts";
import { type Candidate, resumeCandidates } from "../../lib/resume.ts";
import { arrangeTasks, type TaskArrangement } from "../../lib/taskOrder.ts";
import { UNTAGGED, filterTasks, gateDone, includesDone, pickActiveTask, searchPool } from "../../lib/taskView.ts";

// The "filter to untagged tasks" sentinel (defined in lib/taskView.ts).
export { UNTAGGED };

// Full-pool search results for the workspace query. Memoized by the
// computed: recomputes ONLY when tasks or the query change — structured
// filter changes reuse the cached result. Runs against the COMPLETE task
// pool BEFORE any structured filter intersects, so `#tag` exact-match
// resolution (fuzzy.ts falls back to substring when no exact tag exists in
// the searched pool) behaves identically whatever lane/status is selected.
// null = empty query = no search restriction (distinct from "no matches").
const searchResults: ReadonlySignal<TaskSearchResult[] | null> = computed(() =>
  searchPool(tasks.value, workspaceQuery.value),
);

// Composed task filter over the workspace query + unified `filters` signal:
//   query  — membership in the full-pool search results (AND)
//   status — task.status equality (AND)
//   lane   — task.lane equality   (AND)
//   tag    — OR over the array; an entry is satisfied when the task carries
//            that tag, OR the entry is the UNTAGGED sentinel and the task
//            has zero tags. Empty array = no tag filter.
// Any null/empty slot is a no-op. Output preserves server (priority) order.
export const filteredTasks: ReadonlySignal<Task[]> = computed(() =>
  filterTasks(tasks.value, searchResults.value, filters.value),
);

// Done-view exception: the include-done gate is bypassed while the
// status filter IS "done" — selecting the Done view must show done tasks
// regardless of the eye toggle. Everywhere else showAllTasks keeps its
// meaning. Shared by visibleTasks and the activeTask fallback so the
// sidebar list and the default selection can never disagree.
const includeDone: ReadonlySignal<boolean> = computed(() => includesDone(showAllTasks.value, filters.value));

// Composed with the include-done gate above: when hidden, done tasks are
// filtered out. Single source of truth for "what the user actually sees" —
// consumed by the task list, the StatusBar shown count and the display
// ordering below, so all stay in lockstep.
export const visibleTasks: ReadonlySignal<Task[]> = computed(() => gateDone(filteredTasks.value, includeDone.value));

// Display order for the task list and Next/Previous cycling
// (lib/taskOrder.ts):
//   empty query    → the Sort setting (ascending id by default), then the
//                    Group setting's headers (by lane or status);
//   nonempty query → search relevance order straight from searchTasks
//                    (score descending), in one flat list.
// activeTask's priority FALLBACK intentionally does NOT consume this — it
// keeps the server's priority order via filteredTasks.
export const taskArrangement: ReadonlySignal<TaskArrangement> = computed(() =>
  arrangeTasks(visibleTasks.value, searchResults.value, taskSort.value, taskGroup.value, lanes.value),
);
export const orderedVisibleTasks: ReadonlySignal<Task[]> = computed(() => taskArrangement.value.rows);

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
  // Filter governs the sidebar LIST only — the right-pane active task is
  // invariant under filter changes (pickActiveTask looks the selection up
  // in the UNFILTERED pool); the fallback falls to the highest-priority
  // open task of the filtered+gated view ("no selection → top of view").
  return pickActiveTask(tasks.value, filteredTasks.value, selectedId.value, includeDone.value);
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
// by most-recent post first.
// Pure client-side derivation — Update rows already include `author`
// and `created`, so no extra fetch is needed.
export interface TaskAuthor {
  author: string;
  last_seen: number;
  posts: number;
}
// The active task's resumable sessions (pi or bb authors), newest first,
// for display only: main re-checks every resume request itself.
export const resumeCandidatesForTask: ReadonlySignal<Candidate[]> = computed(() => {
  const at = activeTask.value;
  return at ? resumeCandidates(updates.value[at.id] ?? []) : [];
});

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
