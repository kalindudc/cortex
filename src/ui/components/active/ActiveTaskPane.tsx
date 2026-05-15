// ActiveTaskPane — the right-pane editor for the currently-selected task.
//
// Header: id chip, lane chip (with picker), priority chip (inline edit),
// tags chip (with picker), status pill (with popover).
// Body: EditableTaskBody (title input + CodeMirror description).
// Foot: next-status button, last-updated stamp, delete button, post-update form.

import type { VNode } from "preact";

import { activeTask } from "../../state/computed.ts";
import { modal, statusPopover, postUpdateOpen } from "../../state/signals.ts";
import { togglePopover } from "../../state/popovers.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { STATUS_LABEL, nextStatusFor, nextActionLabel } from "../../lib/constants.ts";
import { fmtTime } from "../../lib/format.ts";
import { kbd } from "../../lib/keys.ts";
import { Icon } from "../Icon.tsx";
import { LaneChipButton } from "../chips/LaneChipButton.tsx";
import { PriorityChipButton } from "../chips/PriorityChip.tsx";
import { TagsHeaderChip } from "../chips/TagsHeaderChip.tsx";
import { StatusPopover } from "../chips/StatusPopover.tsx";
import { EditableTaskBody } from "./EditableTaskBody.tsx";
import { PostUpdateForm } from "./PostUpdateForm.tsx";

export function ActiveTaskPane(): VNode {
  const at = activeTask.value;
  if (!at)
    return (
      <section class="pane pane-active">
        <div class="empty">
          <Icon name="checkCircle" size={32} />
          <div class="empty-title">All caught up</div>
          <div class="empty-sub">
            Add a task in the lanes pane, or press <span class="kbd">{kbd("P")}</span> to open the command palette.
          </div>
        </div>
      </section>
    );

  const next = nextStatusFor(at.status);
  const nextLabel = nextActionLabel(at.status);

  return (
    <section class="pane pane-active">
      <header class="active-header">
        <span class="meta num">[{at.id}]</span>
        <LaneChipButton task={at} />
        <PriorityChipButton task={at} />
        <TagsHeaderChip task={at} />
        <span class="grow"></span>
        <div style="position:relative" data-pop>
          <button
            class="status-pill"
            data-pop
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              togglePopover(statusPopover);
            }}
            onDragOver={(e: DragEvent) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).classList.add("dragover");
            }}
            onDragLeave={(e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("dragover")}
          >
            <span class={`dot dot-status-${at.status}`}></span>
            <span>{STATUS_LABEL[at.status]}</span>
            <Icon name="chevronDown" size={12} />
          </button>
          <StatusPopover task={at} />
        </div>
      </header>

      <div class="active-body">
        {/* key={at.id} re-mounts EditableTaskBody on every task switch. The
             previous instance's unmount-flush commits any pending autosave
             before this fresh mount initializes its local title/body signals
             from the new task — so a fast switch never drops keystrokes and
             never lets stale state bleed across tasks. */}
        <EditableTaskBody key={at.id} task={at} />
      </div>

      <footer class="active-foot">
        <div class="row" style={postUpdateOpen.value ? "margin-bottom:12px" : ""}>
          <button class="btn btn-primary" onClick={() => tryApi(() => api.setStat(at.id, next))}>
            <span>{nextLabel}</span>
          </button>
          <span class="grow"></span>
          {/* Inline collapsible toggle for the Post-update form. Centered
               in the toolbar row between the primary status-change button
               (left) and the updated-stamp + delete-button cluster (right)
               via flanking .grow spacers. The Cmd/Ctrl+/ hotkey hint lives
               on this button so it is visible even when the form is
               collapsed (the form-internal hint moved here so there's one
               source of truth). */}
          <button
            type="button"
            class="btn post-update-toggle"
            aria-expanded={postUpdateOpen.value}
            title={postUpdateOpen.value ? "Hide post-update form" : "Show post-update form"}
            onClick={() => (postUpdateOpen.value = !postUpdateOpen.value)}
          >
            <Icon name={postUpdateOpen.value ? "chevronDown" : "chevronUp"} size={12} />
            <span>Post update</span>
            <span class="kbd">{kbd("/")}</span>
          </button>
          <span class="grow"></span>
          <span class="meta">Updated {fmtTime(at.updated)}</span>
          {/* Dedicated delete button. Visible always (no hidden overflow menu)
               because deletion is a primary destructive action you should be
               able to discover at a glance. The confirm-delete modal still
               gates the actual destruction. */}
          <button
            class="btn btn-icon btn-danger"
            title="Delete task"
            onClick={() => (modal.value = { kind: "confirm-delete", id: at.id })}
          >
            <Icon name="trash" />
          </button>
        </div>
        {postUpdateOpen.value ? <PostUpdateForm task={at} /> : null}
      </footer>
    </section>
  );
}
