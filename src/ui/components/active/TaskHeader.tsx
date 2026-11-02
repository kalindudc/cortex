// Document identity: task id, title, and one quiet metadata row.
// TaskToolbar owns status/actions; this header shares the SAME TaskDraft as
// the editor/preview. Title focus, autosave and conflict resolution stay here.
//
// Title editing starts only once the draft's atomic baseline (text + version
// tokens) is known. A request made earlier (click, Enter/Space
// on the trigger, or pendingTitleFocus) waits for it with an honest status,
// or the failure and a Retry; a queued click is dropped if focus moved away
// meanwhile, so a late baseline never steals focus. Plain navigation shows
// no loading chrome: reading needs no baseline.
import type { JSX, VNode } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";
import type { Task } from "../../api/types.ts";
import type { TaskDraft } from "../../lib/useTaskDraft.ts";
import { pendingTitleFocus } from "../../state/signals.ts";
import { fmtTime } from "../../../lib/format.ts";
import { tip } from "../../state/tooltip.ts";
import { LaneChipButton } from "../chips/LaneChipButton.tsx";
import { PriorityChipButton } from "../chips/PriorityChip.tsx";
import { TagsHeaderChip } from "../chips/TagsHeaderChip.tsx";
import { ExternalChangeBanner } from "./ExternalChangeBanner.tsx";

const SAVE_LABEL: Record<TaskDraft["saveState"], string | null> = {
  saved: null,
  pending: "Unsaved changes…",
  saving: "Saving…",
  retrying: "Retrying…",
  failed: "Save failed",
};

export function TaskHeader({ task, draft }: { task: Task; draft: TaskDraft }): VNode {
  const editingTitle = useSignal(false);
  // A title edit requested before the draft's atomic baseline was known,
  // with the element that had focus then: the edit starts once the baseline
  // arrives, but only if focus is still there (a late answer never steals
  // focus from whatever the user moved on to).
  const titleWanted = useSignal<{ focus: Element | null } | null>(null);
  const titleInputRef = useRef<HTMLTextAreaElement>(null);
  const titleTriggerRef = useRef<HTMLButtonElement>(null);
  const returnTitleFocus = useRef(false);
  useLayoutEffect(() => {
    if (!editingTitle.value && returnTitleFocus.current) {
      returnTitleFocus.current = false;
      titleTriggerRef.current?.focus();
    }
  }, [editingTitle.value]);
  // Editing waits for the atomic baseline: the one-shot
  // pending request is consumed once the draft is ready.
  useEffect(() => {
    if (pendingTitleFocus.value !== task.id || !draft.ready) return;
    editingTitle.value = true;
  }, [task.id, pendingTitleFocus.value, draft.ready]);
  useEffect(() => {
    const wanted = titleWanted.peek();
    if (!draft.ready || wanted == null) return;
    titleWanted.value = null;
    if (document.activeElement === wanted.focus) editingTitle.value = true;
  }, [draft.ready]);
  const requestTitleEdit = (): void => {
    if (draft.ready) {
      editingTitle.value = true;
      return;
    }
    titleWanted.value = { focus: document.activeElement };
    if (draft.loadError != null) draft.reload();
  };
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
  // The baseline's state is shown only once a title edit is actually waiting
  // for it: reading needs no baseline, so plain navigation shows no chrome.
  const waitingForBaseline =
    !draft.ready && (titleWanted.value != null || pendingTitleFocus.value === task.id) ? draft.loadError : undefined;

  return (
    <header class="task-header">
      <div class="document-kicker">
        <span class="task-id num" {...tip(`Task ${task.id}`)}>
          @{task.id}
        </span>
        <span aria-hidden="true">·</span>
        <span class="task-updated" {...tip("Last updated")}>
          Updated {fmtTime(task.updated)}
        </span>
        {task.memory_excluded ? (
          <>
            <span aria-hidden="true">·</span>
            <span class="task-memory-off" {...tip("Kept out of agent memory; reading it by id still works")}>
              memory off
            </span>
          </>
        ) : null}
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
              onClick={requestTitleEdit}
              {...tip("Click to edit title")}
            >
              <span class="task-title-text">{draft.title.trim() === "" ? "Untitled task" : draft.title}</span>
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
      {waitingForBaseline === null ? (
        <span class="draft-state draft-state-loading" role="status">
          Loading the latest version for editing…
        </span>
      ) : waitingForBaseline !== undefined ? (
        <span class="draft-state draft-state-failed" role="alert">
          Editing is unavailable: {waitingForBaseline}
          <button type="button" class="draft-retry" onClick={() => draft.reload()}>
            Retry
          </button>
        </span>
      ) : saveLabel != null ? (
        <span
          class={`draft-state draft-state-${draft.saveState}`}
          role={draft.saveState === "failed" ? "alert" : "status"}
        >
          {saveLabel}
          {draft.saveState === "failed" && draft.failure !== null ? `: ${draft.failure}` : null}
          {draft.saveState === "failed" ? (
            <button type="button" class="draft-retry" onClick={() => draft.retry()}>
              Retry
            </button>
          ) : null}
        </span>
      ) : null}
    </header>
  );
}
