// state/computed.ts — Derived values over signals.ts.
//
// Pure read-from-signals computations. No side effects.

import { computed, type ReadonlySignal } from "@preact/signals";
import type { Task, Update } from "../api/types.ts";
import { tasks, filters, selectedId, updates } from "./signals.ts";

// Sentinel value for "filter to untagged tasks". Picked to be collision-free
// against TAG_NAME_RE (/^[a-z0-9_@-]{1,32}$/, src/store.ts:55) — the null
// byte cannot appear in a real tag name, so equality checks are safe.
export const UNTAGGED = "\u0000untagged";

// Composed task filter over the unified `filters` signal:
//   status — task.status equality (AND)
//   lane   — task.lane equality   (AND)
//   tag    — OR over the array; an entry is satisfied when the task carries
//            that tag, OR the entry is the UNTAGGED sentinel and the task
//            has zero tags. Empty array = no tag filter.
// Any null/empty slot is a no-op.
export const filteredTasks: ReadonlySignal<Task[]> = computed(() => {
  const { status, lane, tag } = filters.value;
  let out = tasks.value;
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

// Legacy alias retained while call sites migrate. Delete once nothing
// imports tasksInLane (search src/ for remaining references after the
// SidebarPane swap lands).
export const tasksInLane = filteredTasks;

export const activeTask: ReadonlySignal<Task | null> = computed(() => {
  const list = filteredTasks.value;
  if (selectedId.value != null) {
    const t = list.find(x => x.id === selectedId.value);
    if (t) return t;
  }
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
