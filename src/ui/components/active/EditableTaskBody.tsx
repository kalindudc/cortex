// EditableTaskBody — always-editable surface that owns the title input +
// body MdEditor for the active task. Mounted under key={task.id} by
// ActiveTaskPane, so a task switch re-mounts this component: useSignal
// initializers re-run (fresh title/body from the new task), useAutosave
// timers reset, and the previous instance's unmount-flush commits any
// pending edit.
//
// Three-signal-per-field state for safe concurrent editing:
//   - localSig    : what the user is currently editing.
//   - serverSig   : last value we know the server has. Updated optimistically
//                   on autosave commit start (rolled back on failure) so our
//                   own SSE echo doesn't read as an external change.
//   - externalSig : pending external value when localSig is dirty AND a
//                   different value arrives via SSE. null = no pending
//                   external. Surfaces the banner above the field.
//
// SSE-watch effect classifies every (server-sourced) prop change into:
//   1. incoming === server                   → no-op (steady state / echo)
//   4. incoming === local                    → converge: serverSig <- incoming
//   2. local === server, server !== incoming → live update: both <- incoming
//   5. else                                  → conflict: external <- incoming
//
// bodyEpoch increments whenever the body MdEditor needs to be re-mounted
// with a new initial value (Apply or live-update case 2). MdEditor's
// editor instance is mount-once for in-flight edit safety, so changing
// bodySig externally doesn't refresh the visible CodeMirror contents —
// the key={"body-"+epoch} forces a fresh mount. Title is a controlled
// <input> so it auto-syncs from titleSig with no extra plumbing.

import type { JSX, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import type { Task } from "../../api/types.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { pendingTitleFocus } from "../../state/signals.ts";
import { useAutosave } from "../../lib/autosave.ts";
import { MdEditor } from "./MdEditor.tsx";
import { ExternalChangeBanner } from "./ExternalChangeBanner.tsx";

export function EditableTaskBody({ task }: { task: Task }): VNode {
  const titleSig = useSignal(task.title);
  const bodySig = useSignal(task.body || "");
  const titleServerSig = useSignal(task.title);
  const bodyServerSig = useSignal(task.body || "");
  const titleExternal = useSignal<string | null>(null);
  const bodyExternal = useSignal<string | null>(null);
  const bodyEpoch = useSignal(0);
  // Imperative focus handle for the title input. Used by the pendingTitleFocus
  // effect below to grab focus when SidebarPane has just created an
  // `untitled-<id>` task and wants the user to immediately rename it. Pure
  // imperative wiring — normal edits don't go through this.
  const titleInputRef = useRef<HTMLTextAreaElement>(null);

  // pendingTitleFocus consumer (one-shot semantics): if the signal matches
  // this task's id when we mount (or update), focus + select the input and
  // clear the signal. Mounted under key={task.id} so a task switch always
  // re-runs this effect with a fresh task prop.
  useEffect(() => {
    if (pendingTitleFocus.value !== task.id) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
    pendingTitleFocus.value = null;
  }, [task.id]);

  // SSE-watch: title. Fires whenever the parent re-renders us with a new
  // task.title (SSE refresh → tasks.value = ts → task prop changes).
  useEffect(() => {
    const inc = task.title;
    if (inc === titleServerSig.value) return; // case 1: echo / no news
    if (inc === titleSig.value) {
      // case 4: converge
      titleServerSig.value = inc;
      titleExternal.value = null;
      return;
    }
    if (titleSig.value === titleServerSig.value) {
      // case 2: live update
      titleSig.value = inc;
      titleServerSig.value = inc;
      titleExternal.value = null;
      return;
    }
    titleExternal.value = inc; // case 5: conflict
  }, [task.title]);

  // SSE-watch: body. Same logic. Bumps bodyEpoch on case 2 so MdEditor
  // re-mounts with the new value (the editor doesn't sync from value
  // after mount).
  useEffect(() => {
    const inc = task.body || "";
    if (inc === bodyServerSig.value) return;
    if (inc === bodySig.value) {
      bodyServerSig.value = inc;
      bodyExternal.value = null;
      return;
    }
    if (bodySig.value === bodyServerSig.value) {
      bodySig.value = inc;
      bodyServerSig.value = inc;
      bodyExternal.value = null;
      bodyEpoch.value++;
      return;
    }
    bodyExternal.value = inc;
  }, [task.body]);

  // Per-field autosave with optimistic serverSig update. Setting
  // serverSig BEFORE the PATCH means our own SSE echo lands as case 1
  // (no false conflict banner from our own write). Rollback on failure
  // restores the prior baseline so the next dirty check is correct.
  const titleSave = useAutosave(async () => {
    const v = titleSig.value;
    const prev = titleServerSig.value;
    titleServerSig.value = v;
    try {
      await tryApi(() => api.editTask(task.id, { title: v }));
    } catch (err) {
      titleServerSig.value = prev;
      throw err;
    }
  });
  const bodySave = useAutosave(async () => {
    const v = bodySig.value;
    const prev = bodyServerSig.value;
    bodyServerSig.value = v;
    try {
      await tryApi(() => api.editTask(task.id, { body: v || null }));
    } catch (err) {
      bodyServerSig.value = prev;
      throw err;
    }
  });

  // Banner actions. Apply replaces local + server with the external value
  // (no save needed — server already has it). Dismiss just clears the
  // banner; the next autosave will PATCH local, overwriting the external,
  // explicitly. Body Apply also bumps bodyEpoch to push the new doc into
  // the CodeMirror editor.
  const applyTitle = () => {
    const incoming = titleExternal.value;
    if (incoming === null) return; // banner already dismissed; no-op
    titleSig.value = incoming;
    titleServerSig.value = incoming;
    titleExternal.value = null;
  };
  const dismissTitle = () => {
    titleExternal.value = null;
  };
  const applyBody = () => {
    const incoming = bodyExternal.value;
    if (incoming === null) return;
    bodySig.value = incoming;
    bodyServerSig.value = incoming;
    bodyExternal.value = null;
    bodyEpoch.value++;
  };
  const dismissBody = () => {
    bodyExternal.value = null;
  };

  return (
    <div class="editable-task-body">
      {titleExternal.value !== null ? (
        <ExternalChangeBanner
          label="Title"
          incoming={titleExternal.value}
          onApply={applyTitle}
          onDismiss={dismissTitle}
        />
      ) : null}
      {/* CSS-only autosize. The wrapper is a single-cell CSS grid; its
           ::after pseudo-element mirrors the textarea content via
           data-replicated-value and shares the same grid-area. The cell
           sizes to the taller of {textarea, ::after} — since the textarea
           has overflow:hidden, the visible ::after is what drives the
           height. No JS height calc, no rAF, no scrollHeight reads.
           Trailing space on data-replicated-value keeps the last line's
           height stable when the value is empty. */}
      <div class="title-input-wrap" data-replicated-value={`${titleSig.value} `}>
        <textarea
          ref={titleInputRef}
          class="title-input"
          rows={1}
          value={titleSig.value}
          placeholder="Task title"
          onInput={(e: JSX.TargetedInputEvent<HTMLTextAreaElement>) => {
            // Strip newlines defensively — task.title is a single-line semantic
            // field even though the surface is a wrapping textarea (lane row
            // tooltips, palette result rows, .task-title row all expect single line).
            titleSig.value = e.currentTarget.value.replace(/\n+/g, " ");
            titleSave.schedule();
          }}
          onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === "Enter") {
              e.preventDefault();
              titleSave.flush();
            }
          }}
          onBlur={() => titleSave.flush()}
        />
      </div>
      {bodyExternal.value !== null ? (
        <ExternalChangeBanner label="Body" incoming={bodyExternal.value} onApply={applyBody} onDismiss={dismissBody} />
      ) : null}
      {/* Body autosave does NOT register an explicit blur handler — some
           browsers do not fire blur on tab-hide. The 600 ms idle timer
           catches normal focus moves; the 3 s max-wait is the worst-case
           safety net; Cmd/Ctrl+S inside the editor flushes immediately
           (onSubmit -> bodySave.flush). */}
      <MdEditor
        key={`body-${bodyEpoch.value}`}
        value={bodySig.value}
        placeholder="Add a description…"
        onChange={v => {
          bodySig.value = v;
          bodySave.schedule();
        }}
        onSubmit={() => bodySave.flush()}
      />
    </div>
  );
}
