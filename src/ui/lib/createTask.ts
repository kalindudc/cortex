// Create a new task with a placeholder title `untitled-<id>` and select it
// so the user can immediately rename via the active-pane title input. The
// two-request flow (POST then PATCH) is necessary because we don't know
// the id until the server assigns it. The pendingTitleFocus signal is
// picked up by EditableTaskBody's useEffect once the active pane re-
// renders — a setTimeout-based document.querySelector race lost focus
// every time Preact's reconciliation re-rendered the input.
//
// Extracted from SidebarPane so the command palette's "New task" entry
// can share the exact same flow without duplicating the two-phase
// request sequence.
import { api } from "../api/client.ts";
import { tryApi } from "../api/errors.ts";
import { pendingTitleFocus, selectedId } from "../state/signals.ts";

export async function createUntitledTask(lane: string): Promise<void> {
  const created = await tryApi(() => api.addTask({ title: "untitled", lane }));
  if (!created?.id) return;
  await tryApi(() => api.editTask(created.id, { title: `untitled-${created.id}` }));
  pendingTitleFocus.value = created.id;
  selectedId.value = created.id;
}
