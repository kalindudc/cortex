// Document identity: task id, wrapping title, and one quiet metadata row.
// TaskToolbar owns status/actions; this header shares the SAME TaskDraft as
// the editor/preview. Title focus, autosave and conflict resolution stay here.
import type { JSX, VNode } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";
import type { Task } from "../../api/types.ts";
import type { TaskDraft } from "../../lib/useTaskDraft.ts";
import { pendingTitleFocus } from "../../state/signals.ts";
import { fmtTime } from "../../lib/format.ts";
import { tip } from "../../state/tooltip.ts";
import { LaneChipButton } from "../chips/LaneChipButton.tsx";
import { PriorityChipButton } from "../chips/PriorityChip.tsx";
import { TagsHeaderChip } from "../chips/TagsHeaderChip.tsx";
import { ExternalChangeBanner } from "./ExternalChangeBanner.tsx";

const SAVE_LABEL: Record<TaskDraft["saveState"], string | null> = {
  saved: null,
  pending: "Unsaved changes…",
  saving: "Saving…",
  error: "Save failed",
};

export function TaskHeader({ task, draft }: { task: Task; draft: TaskDraft }): VNode {
  const editingTitle = useSignal(false);
  const titleInputRef = useRef<HTMLTextAreaElement>(null);
  const titleTriggerRef = useRef<HTMLButtonElement>(null);
  const returnTitleFocus = useRef(false);
  useLayoutEffect(() => {
    if (!editingTitle.value && returnTitleFocus.current) {
      returnTitleFocus.current = false;
      titleTriggerRef.current?.focus();
    }
  }, [editingTitle.value]);
  useEffect(() => {
    if (pendingTitleFocus.value !== task.id) return;
    editingTitle.value = true;
  }, [task.id, pendingTitleFocus.value]);
  useEffect(() => {
    if (!editingTitle.value) return;
    const timer = setTimeout(() => {
      const input = titleInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
      if (pendingTitleFocus.peek() === task.id) pendingTitleFocus.value = null;
    }, 0);
    return () => clearTimeout(timer);
  }, [editingTitle.value]);

  const stopEditing = (restoreFocus = false): void => {
    if (!editingTitle.peek()) return;
    if (restoreFocus) returnTitleFocus.current = true;
    draft.flush();
    editingTitle.value = false;
  };
  const saveLabel = SAVE_LABEL[draft.saveState];

  return (
    <header class="task-header">
      <div class="document-kicker">
        <span>Task</span>
        <span class="task-id num" {...tip(`Task ${task.id}`)}>
          [{task.id}]
        </span>
        <span aria-hidden="true">·</span>
        <span class="task-updated" {...tip("Last updated")}>
          Updated {fmtTime(task.updated)}
        </span>
      </div>
      {draft.external.title != null ? (
        <ExternalChangeBanner
          label="Title"
          incoming={draft.external.title}
          onApply={() => draft.apply("title")}
          onDismiss={() => draft.keep("title")}
        />
      ) : null}
      <div class="task-title-row">
        {editingTitle.value ? (
          <div class="title-input-wrap grow" data-replicated-value={`${draft.title} `}>
            <textarea
              ref={titleInputRef}
              class="title-input"
              rows={1}
              value={draft.title}
              placeholder="Task title"
              aria-label="Task title"
              onInput={(event: JSX.TargetedInputEvent<HTMLTextAreaElement>) =>
                draft.set("title", event.currentTarget.value)
              }
              onKeyDown={(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
                if (event.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  stopEditing(true);
                } else if (event.key === "Escape") {
                  event.stopPropagation();
                  stopEditing(true);
                }
              }}
              onBlur={() => stopEditing()}
            />
          </div>
        ) : (
          <h1 class="task-title-display grow">
            <button
              type="button"
              class={`task-title-trigger${draft.title.trim() === "" ? " is-empty" : ""}`}
              ref={titleTriggerRef}
              aria-describedby={`title-edit-hint-${task.id}`}
              onClick={() => {
                editingTitle.value = true;
              }}
              {...tip("Click to edit title")}
            >
              {draft.title.trim() === "" ? "Untitled task" : draft.title}
            </button>
          </h1>
        )}
        <span id={`title-edit-hint-${task.id}`} class="visually-hidden">
          Activate to edit the task title.
        </span>
      </div>
      <div class="task-header-trailing">
        <div class="task-props">
          <LaneChipButton task={task} />
          <PriorityChipButton task={task} />
          <TagsHeaderChip task={task} />
        </div>
      </div>
      {saveLabel != null ? (
        <span
          class={`draft-state draft-state-${draft.saveState}`}
          role={draft.saveState === "error" ? "alert" : "status"}
        >
          {saveLabel}
          {draft.saveState === "error" ? (
            <button type="button" class="draft-retry" onClick={() => draft.retry()}>
              Retry
            </button>
          ) : null}
        </span>
      ) : null}
    </header>
  );
}
