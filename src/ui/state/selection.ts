// state/selection.ts — Cycle the active selection through the DISPLAYED rows.
//
// Used by the command palette's "Next task" / "Previous task" entries.
// Follows orderedVisibleTasks (W4): natural title order for an empty
// workspace query, search relevance order for a nonempty one, include-done
// gate applied. When the active task is not among the displayed rows (its
// lane/status/tag/search excludes it), Next selects the FIRST row and
// Previous the LAST — deterministic re-entry points into the visible list.

import { orderedVisibleTasks, activeTask } from "./computed.ts";
import { selectedId } from "./signals.ts";

export function moveSelection(delta: number): void {
  const list = orderedVisibleTasks.value;
  if (list.length === 0) return;
  const at = activeTask.value;
  const i = list.findIndex(t => at != null && t.id === at.id);
  if (i === -1) {
    // Active task outside the displayed rows: enter the list at the edge
    // matching the direction of travel.
    const entry = delta > 0 ? list[0] : list[list.length - 1];
    selectedId.value = entry.id;
    return;
  }
  const next = list[(i + delta + list.length) % list.length];
  selectedId.value = next.id;
}
