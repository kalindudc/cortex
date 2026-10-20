// Document identity: task id, clamped title, and one quiet metadata row.
// TaskToolbar owns status/actions; this header shares the SAME TaskDraft as
// the editor/preview. Title focus, autosave and conflict resolution stay here.
//
// The header stays pinned above the scrolling reader/editor, so the DISPLAY
// title clamps to TITLE_CLAMP_LINES (CSS line clamp; the full text stays in
// the DOM as the button's accessible name). When the text really overflows,
// the heading is marked `.is-clamped` and the title can reveal itself IN
// FLOW: it grows and the metadata row, reader and editor move down with it,
// so the reveal reads as the same document growing rather than a layer.
// Reveal state (`.is-title-revealed` on the header) is owned here, not by
// :hover, for two reasons: (1) it arms only after the pointer has RESTED on
// the title for TITLE_REVEAL_INTENT_MS, so passing through the header on the
// way to the document never bounces the layout; (2) once revealed it stays
// until the pointer leaves the whole header, so the metadata row cannot jump
// away from a pointer travelling down to it. Keyboard focus-visible reveals
// through CSS alone. The title textarea (editing) is exempt: it always shows
// every line in flow.
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

/** Lines the pinned display title shows before it clamps. Published to CSS as
 *  `--title-clamp-lines` so document.css / motion.css never repeat the number. */
export const TITLE_CLAMP_LINES = 2;
/** How long the pointer must rest on a clamped title before it reveals. A
 *  hover-intent threshold (interaction), not a motion delay: nothing is
 *  animating while it runs, and keyboard focus reveals at once. */
export const TITLE_REVEAL_INTENT_MS = 150;

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
  const titleClamped = useSignal(false);
  const titleRevealed = useSignal(false);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleInputRef = useRef<HTMLTextAreaElement>(null);
  const titleTriggerRef = useRef<HTMLButtonElement>(null);
  const titleDisplayRef = useRef<HTMLHeadingElement>(null);
  const titleTextRef = useRef<HTMLSpanElement>(null);
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

  // Does the display title overflow its clamp? scrollHeight is the full text
  // height even while the line clamp hides the tail, and it is compared with
  // the CONSTANT clamp height rather than clientHeight, so a revealed (grown)
  // title still reads as clamped. The heading is observed for width/wrap
  // changes; a reveal resizes it too, which merely re-measures to the same
  // answer and never restarts the transition (same custom-property value).
  useLayoutEffect(() => {
    if (editingTitle.value) return;
    const heading = titleDisplayRef.current;
    const text = titleTextRef.current;
    if (!heading || !text) return;
    const measure = (): void => {
      const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
      const full = text.scrollHeight;
      text.style.setProperty("--title-full-height", `${full}px`);
      titleClamped.value = Number.isFinite(lineHeight) && full > lineHeight * TITLE_CLAMP_LINES + 1;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(heading);
    return () => observer.disconnect();
  }, [editingTitle.value, draft.title]);

  const cancelReveal = (): void => {
    if (revealTimer.current == null) return;
    clearTimeout(revealTimer.current);
    revealTimer.current = null;
  };
  const armReveal = (): void => {
    if (titleRevealed.peek()) return;
    cancelReveal();
    revealTimer.current = setTimeout(() => {
      revealTimer.current = null;
      titleRevealed.value = true;
    }, TITLE_REVEAL_INTENT_MS);
  };
  const dismissReveal = (): void => {
    cancelReveal();
    titleRevealed.value = false;
  };
  // Task navigation and unmount both drop a reveal that belonged to the
  // previous title; a pointer parked on the header must not carry it over.
  useEffect(() => {
    dismissReveal();
    return cancelReveal;
  }, [task.id]);

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
    <header class={`task-header${titleRevealed.value ? " is-title-revealed" : ""}`} onMouseLeave={dismissReveal}>
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
          <h1
            class={`task-title-display grow${titleClamped.value ? " is-clamped" : ""}`}
            style={{ "--title-clamp-lines": String(TITLE_CLAMP_LINES) }}
            ref={titleDisplayRef}
            onMouseEnter={armReveal}
            onMouseLeave={cancelReveal}
          >
            <button
              type="button"
              class={`task-title-trigger${draft.title.trim() === "" ? " is-empty" : ""}`}
              ref={titleTriggerRef}
              aria-describedby={`title-edit-hint-${task.id}`}
              onClick={() => {
                dismissReveal();
                requestTitleEdit();
              }}
              {...tip("Click to edit title")}
            >
              <span class="task-title-text" ref={titleTextRef}>
                {draft.title.trim() === "" ? "Untitled task" : draft.title}
              </span>
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
