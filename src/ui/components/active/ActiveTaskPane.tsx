// ActiveTaskPane — workspace shell for the currently-selected task.
//
// Empty state when nothing is selected; otherwise the TaskDocument keyed by
// task id (a task switch remounts the whole document: fresh draft seeded
// from recovery memory, editor re-created lazily, saved body-mode preference
// and Document entry applied by state/workspace.ts).
//
// When the active task falls OUTSIDE the current filter rows (W4) a notice
// explains why the list doesn't show it and offers Clear filters — the
// active task itself is invariant under filter changes.

import type { VNode } from "preact";

import { activeTask, orderedVisibleTasks } from "../../state/computed.ts";
import { clearAllFilters } from "../../state/signals.ts";
import { kbd } from "../../lib/keys.ts";
import { Icon } from "../Icon.tsx";
import { TaskDocument } from "./TaskDocument.tsx";

export function ActiveTaskPane(): VNode {
  const at = activeTask.value;
  if (!at)
    return (
      <section class="pane pane-active">
        <div class="empty">
          <Icon name="checkCircle" size={32} />
          <div class="empty-title">All caught up</div>
          <div class="empty-sub">
            Add a task in the sidebar, or press <span class="kbd">{kbd("P")}</span> to open the command palette.
          </div>
        </div>
      </section>
    );

  const outside = !orderedVisibleTasks.value.some(t => t.id === at.id);

  return (
    <section class="pane pane-active">
      {outside ? (
        <div class="outside-filter-notice" role="status">
          <span>This task is outside the current filters — it stays open, but the task list doesn't show it.</span>
          <button type="button" class="btn" onClick={() => clearAllFilters()}>
            Clear filters
          </button>
        </div>
      ) : null}
      <TaskDocument key={at.id} task={at} />
    </section>
  );
}
