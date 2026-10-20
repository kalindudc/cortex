// state/selection.ts — Cycle the active selection through the DISPLAYED rows.
//
// Used by the command palette's "Next task" / "Previous task" entries.
// Follows listedTasks: the Sort and Group settings for an empty workspace
// query, search relevance order for a nonempty one, include-done gate
// applied, and without the rows of folded groups. When the active task is
// not among those rows (a filter, the search or a folded group hides it),
// Next selects the FIRST row and Previous the LAST — deterministic re-entry
// points into the visible list.
// The stepping rule itself is lib/taskView.ts's pure stepSelection.

import { listedTasks, activeTask } from "./computed.ts";
import { selectedId } from "./signals.ts";
import { stepSelection } from "../../lib/taskView.ts";

export function moveSelection(delta: number): void {
  const next = stepSelection(listedTasks.value, activeTask.value?.id ?? null, delta);
  if (next !== null) selectedId.value = next;
}
