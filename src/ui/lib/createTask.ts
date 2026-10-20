// Create a new task with a placeholder title `untitled-<id>` and select it
// so the user can immediately rename via the active-pane title input. ONE
// atomic request (`untitled: true`): the daemon names
// the task from its new id inside the create transaction, so there is no
// follow-up PATCH and never an intermediate "untitled" row. The
// pendingTitleFocus signal is picked up by TaskHeader once the task's draft
// has its baseline — a setTimeout-based document.querySelector race lost
// focus every time Preact's reconciliation re-rendered the input.
//
// Extracted from SidebarPane so the command palette's "New task" entry
// can share the exact same flow.
import { api } from "../api/client.ts";
import { tryApi } from "../api/errors.ts";
import { pendingTitleFocus, selectedId } from "../state/signals.ts";

export async function createUntitledTask(lane: string): Promise<void> {
  const created = await tryApi(() => api.addTask({ untitled: true, lane }));
  if (!created?.id) return;
  pendingTitleFocus.value = created.id;
  selectedId.value = created.id;
}
