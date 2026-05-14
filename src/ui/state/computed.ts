// state/computed.ts — Derived values over signals.ts.
//
// Pure read-from-signals computations. No side effects.

import { computed, type ReadonlySignal } from "@preact/signals";
import type { Task, Update } from "../api/types.ts";
import { tasks, selectedLane, selectedTag, selectedId, updates } from "./signals.ts";

// Sentinel value for "filter to untagged tasks". Picked to be collision-free
// against TAG_NAME_RE (/^[a-z0-9_@-]{1,32}$/, src/store.ts:55) — the null
// byte cannot appear in a real tag name, so equality checks are safe.
export const UNTAGGED = "\u0000untagged";

export const tasksInLane: ReadonlySignal<Task[]> = computed(() => {
  const lane = selectedLane.value;
  const tag = selectedTag.value;
  let out = tasks.value;
  if (lane) out = out.filter(t => t.lane === lane);
  if (tag === UNTAGGED) {
    out = out.filter(t => !Array.isArray(t.tags) || t.tags.length === 0);
  } else if (tag) {
    out = out.filter(t => Array.isArray(t.tags) && t.tags.includes(tag));
  }
  return out;
});

export const activeTask: ReadonlySignal<Task | null> = computed(() => {
  const list = tasksInLane.value;
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
