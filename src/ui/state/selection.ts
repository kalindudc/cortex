// state/selection.ts — Cycle the active selection through the DISPLAYED rows.
//
// Used by the command palette's "Next task" / "Previous task" entries.
// Follows orderedVisibleTasks: natural title order for an empty
// workspace query, search relevance order for a nonempty one, include-done
// gate applied. When the active task is not among the displayed rows (its
// lane/status/tag/search excludes it), Next selects the FIRST row and
// Previous the LAST — deterministic re-entry points into the visible list.
// The stepping rule itself is lib/taskView.ts's pure stepSelection.

import { orderedVisibleTasks, activeTask } from "./computed.ts";
import { selectedId } from "./signals.ts";
import { stepSelection } from "../../lib/taskView.ts";

export function moveSelection(delta: number): void {
  const next = stepSelection(orderedVisibleTasks.value, activeTask.value?.id ?? null, delta);
  if (next !== null) selectedId.value = next;
}
