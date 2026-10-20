// ModalRoot — single mount point for every overlay/modal in the app.
// Switches on `modal.value.kind`. Returns null when no modal is open.

import type { VNode } from "preact";
import { useEffect } from "preact/hooks";

import { modal, filters, setFilter, selectedId } from "../../state/signals.ts";
import { clearWorkspaceTransientState } from "../../state/workspace.ts";
import { DialogFrame } from "./DialogFrame.tsx";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { LaneEditModal } from "./LaneEditModal.tsx";
import { TagEditModal } from "./TagEditModal.tsx";
import { NewLaneModal } from "./NewLaneModal.tsx";
import { NewTagModal } from "./NewTagModal.tsx";
import { TagFilterModal } from "./TagFilterModal.tsx";
import { UpdateDetailModal } from "./UpdateDetailModal.tsx";
import { RenderMarkdownModal } from "./RenderMarkdownModal.tsx";
import { SettingsModal } from "./SettingsModal.tsx";
import type { Update } from "../../api/types.ts";

export function ModalRoot(): VNode | null {
  const m = modal.value;
  // Single active layer: a modal opening retargets the lower transient
  // layers (mobile drawer, drag tray, popovers) before it takes the top.
  useEffect(() => {
    if (m != null && m.kind !== "filter-tags") clearWorkspaceTransientState();
  }, [m?.kind]);
  if (!m) return null;
  const close = () => (modal.value = null);
  if (m.kind === "confirm-delete") {
    return (
      <DialogFrame label="Delete task" onClose={close}>
        <div class="modal">
          <h2>Delete task?</h2>
          <p class="meta" style="margin:0">
            This permanently removes the task and its updates. Cannot be undone.
          </p>
          <div class="modal-actions">
            <button class="btn" onClick={close}>
              Cancel
            </button>
            <button
              class="btn btn-primary"
              onClick={async () => {
                await tryApi(() => api.delTask(m.id as number));
                selectedId.value = null;
                close();
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </DialogFrame>
    );
  }
  if (m.kind === "lane-edit") {
    return <LaneEditModal name={m.name as string} close={close} />;
  }
  if (m.kind === "new-lane") {
    return <NewLaneModal close={close} />;
  }
  if (m.kind === "new-tag") {
    return <NewTagModal close={close} />;
  }
  if (m.kind === "filter-tags") {
    return <TagFilterModal close={close} />;
  }
  if (m.kind === "tag-edit") {
    return <TagEditModal name={m.name as string} close={close} />;
  }
  if (m.kind === "update-detail") {
    return <UpdateDetailModal update={m.update as Update} close={close} />;
  }
  if (m.kind === "settings") {
    return <SettingsModal close={close} />;
  }
  if (m.kind === "render-markdown") {
    return <RenderMarkdownModal taskId={m.taskId as number} close={close} />;
  }
  if (m.kind === "confirm-tag-delete") {
    const tagName = m.name as string;
    const taskCount = (m.taskCount as number) ?? 0;
    return (
      <DialogFrame label="Delete tag" onClose={close}>
        <div class="modal">
          <h2>
            Delete tag <span class="meta">#{tagName}</span>?
          </h2>
          <p class="meta" style="margin:0">
            {taskCount > 0
              ? `${taskCount} task${taskCount === 1 ? " carries" : "s carry"} this tag. Deleting will remove the tag from those tasks (the tasks themselves are NOT deleted).`
              : "This tag is not used by any task."}
          </p>
          <div class="modal-actions">
            <button class="btn" onClick={close}>
              Cancel
            </button>
            <button
              class="btn btn-primary"
              style="background:var(--err)"
              onClick={async () => {
                await tryApi(() => api.delTag(tagName, taskCount > 0));
                if (filters.value.tag.includes(tagName)) {
                  setFilter(
                    "tag",
                    filters.value.tag.filter(n => n !== tagName),
                  );
                }
                close();
              }}
            >
              Delete tag
            </button>
          </div>
        </div>
      </DialogFrame>
    );
  }
  if (m.kind === "confirm-lane-delete") {
    const laneName = m.name as string;
    return (
      <DialogFrame label="Delete lane" onClose={close}>
        <div class="modal">
          <h2>
            Delete lane <span class="meta">{laneName}</span>?
          </h2>
          <p class="meta" style="margin:0">
            The lane must be empty. The default <code>now</code> lane cannot be deleted.
          </p>
          <div class="modal-actions">
            <button class="btn" onClick={close}>
              Cancel
            </button>
            <button
              class="btn btn-primary"
              style="background:var(--err)"
              onClick={async () => {
                await tryApi(() => api.delLane(laneName));
                if (filters.value.lane === laneName) setFilter("lane", null);
                close();
              }}
            >
              Delete lane
            </button>
          </div>
        </div>
      </DialogFrame>
    );
  }
  return null;
}
