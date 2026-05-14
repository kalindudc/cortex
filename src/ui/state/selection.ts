// state/selection.ts — Cycle the active selection through tasksInLane.
//
// Used by the command palette's "Next task" / "Previous task" entries.

import { tasksInLane, activeTask } from "./computed.ts";
import { selectedId } from "./signals.ts";

export function moveSelection(delta: number): void {
  const list = tasksInLane.value;
  if (list.length === 0) return;
  const at = activeTask.value;
  const i = Math.max(0, list.findIndex(t => at != null && t.id === at.id));
  const next = list[(i + delta + list.length) % list.length];
  selectedId.value = next.id;
}
