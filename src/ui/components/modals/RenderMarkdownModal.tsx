// RenderMarkdownModal — read-only renderer for a task body.
//
// Mounts under the `render-markdown` modal kind (see ModalRoot.tsx). A
// COMPATIBILITY consumer of the shared MarkdownView surface — the normal
// task-reading path renders in place inside TaskDocument; this
// modal remains for legacy/palette entry points. Sanitization, mermaid
// lifecycle, heading ids, refs and copy controls all come from
// MarkdownView — no separate render pipeline here.

import type { VNode } from "preact";

import { tasks } from "../../state/signals.ts";
import { MarkdownView } from "../active/MarkdownView.tsx";
import { DialogFrame } from "./DialogFrame.tsx";

export function RenderMarkdownModal({ taskId, close }: { taskId: number; close: () => void }): VNode {
  // Look up from the live `tasks` signal (not a passed-in Task) so SSE
  // body edits flow through to the modal while it is open.
  const task = tasks.value.find(t => t.id === taskId);
  const hasBody = !!task?.body && task.body.trim().length > 0;
  return (
    <DialogFrame label="Task document" onClose={close}>
      <div class="modal modal--wide modal--render-markdown">
        <h2>{task?.title ?? `Task ${taskId}`}</h2>
        <div class="update-body">
          {task == null ? (
            <p class="meta" style="margin:0">
              Task no longer exists.
            </p>
          ) : hasBody ? (
            <MarkdownView source={task.body as string} idPrefix={`modal-task-${taskId}`} />
          ) : (
            <p class="meta" style="margin:0">
              Nothing to render.
            </p>
          )}
        </div>
        <div class="modal-actions">
          <button class="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
