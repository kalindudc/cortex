// PriorityChip / PriorityChipButton — priority badges for task surfaces.
//
// Static `PriorityChip` is used inside list-row task surfaces (LanesPane,
// TagsPane) where the chip lives INSIDE a <button class="task-row"> — a
// nested <button> would be invalid HTML and would steal the row's click.
// The active-task header instead uses `PriorityChipButton`, which morphs
// into an inline <input> on click.

import type { JSX, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import type { Task } from "../../api/types.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { closeAllPopovers } from "../../state/popovers.ts";
import { priorityClass } from "../../lib/constants.ts";

// Static priority badge. Used by list-row task surfaces (LanesPane,
// TagsPane) where the chip lives INSIDE a <button class="task-row"> — a
// nested <button> would be invalid HTML and would steal the row's click.
// The active-task header instead uses PriorityChipButton (below), which
// morphs into an inline <input> on click.
export function PriorityChip({ priority }: { priority: number | null }): VNode | null {
  // Unset priority renders nothing on list-row surfaces — the chip is
  // opt-in metadata, and visual emptiness is the correct signal.
  if (priority === null) return null;
  return (
    <span class={`priority-chip ${priorityClass(priority)}`} title={`Priority ${priority} (0 = highest)`}>
      P{priority}
    </span>
  );
}

// Self-editing variant of PriorityChip used in the active-task header.
// The pill IS the input: clicking the button morphs the same surface into
// a number <input> styled identically to the pill (same border-radius,
// height, padding via the shared .priority-chip class). Enter commits;
// Esc and blur cancel — matches the user's spec for transient inline
// editing without a separate popover.
//
// Why local editing signal instead of a global one: only one priority
// chip is ever rendered (in ActiveTaskPane header), so a global signal
// would be ceremony for nothing; local state also avoids the global
// outside-click cascade re-opening logic that the old popover needed.
export function PriorityChipButton({ task }: { task: Task }): VNode {
  const editing = useSignal(false);
  const val = useSignal(String(task.priority ?? ""));
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-sync from prop when the task's priority changes externally (SSE
  // echo, palette quick-action). Skip while editing so we don't stomp
  // mid-typing. Null → empty string so the input starts blank when unset.
  useEffect(() => {
    if (!editing.value) val.value = String(task.priority ?? "");
  }, [task.priority]);

  // Focus + select on entering edit mode so a single keystroke replaces
  // the value (the common case: P2 → P0). Same setTimeout(0) defensive
  // pattern TagPicker uses to win the race against the post-render paint.
  useEffect(() => {
    if (!editing.value) return;
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [editing.value]);

  const cancel = () => {
    val.value = String(task.priority ?? "");
    editing.value = false;
  };
  const commit = async () => {
    const trimmed = val.value.trim();
    editing.value = false;
    // Empty input → clear to null. No-op when already null so the user
    // doesn't fire a redundant PATCH by clicking the unset affordance and
    // hitting Enter.
    if (trimmed === "") {
      if (task.priority === null) return;
      await tryApi(() => api.editTask(task.id, { priority: null }));
      return;
    }
    // Priority is null or a NONNEGATIVE INTEGER. Fractions and negatives
    // are rejected outright — never truncated to a nearby integer (H2).
    if (!/^\d+$/.test(trimmed)) {
      val.value = String(task.priority ?? "");
      return;
    }
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n) || n === task.priority) {
      val.value = String(task.priority ?? "");
      return;
    }
    await tryApi(() => api.editTask(task.id, { priority: n }));
  };

  if (editing.value) {
    return (
      <input
        ref={inputRef}
        type="number"
        min="0"
        class={`prop-trigger priority-chip priority-chip-input ${priorityClass(task.priority)}`}
        aria-label="Priority"
        value={val.value}
        onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (val.value = e.currentTarget.value)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            cancel();
          }
        }}
        onBlur={cancel}
        title="Enter commits, Esc or click-out cancels; empty + Enter clears"
      />
    );
  }
  // Unset affordance: quiet labeled call-to-action (H1: 'Set priority',
  // not a cryptic '+ P?'). Same click → editing morph; the input starts
  // empty (see val initialiser) so a single keystroke enters the value.
  if (task.priority === null) {
    return (
      <button
        class="prop-trigger priority-chip priority-chip-unset"
        title="Set priority (0 = highest)"
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          closeAllPopovers();
          editing.value = true;
        }}
      >
        Set priority
      </button>
    );
  }
  return (
    <button
      class={`prop-trigger priority-chip ${priorityClass(task.priority)}`}
      title={`Priority ${task.priority} (0 = highest) — click to edit`}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        // Close any open popover so the editing surface is the only active
        // transient UI — same single-popover-at-a-time invariant.
        closeAllPopovers();
        editing.value = true;
      }}
    >
      <span class="prop-label">Priority:</span>
      <span class="prop-value">P{task.priority}</span>
    </button>
  );
}
