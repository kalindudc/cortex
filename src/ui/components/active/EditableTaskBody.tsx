// EditableTaskBody — thin CodeMirror binding for the task BODY (task 330).
//
// All reconciliation state lives in the shared TaskDraft (lib/useTaskDraft
// — D1): this component just binds the editor to it. Title editing moved to
// TaskHeader; conflict banners and save feedback render OUTSIDE this
// component (TaskDocument/TaskHeader) so they stay visible while the
// editor is hidden.
//
// The editor mounts once per (task, bodyEpoch) — TaskDocument keys this
// component by the draft's external-replacement epoch and the parent keys
// by task id (D4). `visible` HIDES rather than unmounts so cursor, undo
// history and pending edits survive Read/Activity/Related passes; the
// hidden host is removed from layout and the tab order (V3).
//
// Editing starts only once the draft's atomic baseline (text + version
// tokens, plan @400 N8) is known: until then an honest loading status (or
// the failure with a Retry) holds the editor's place, and the editor mounts
// ONCE, seeded with the baseline text — never swapped in just to animate.

import type { VNode } from "preact";

import type { TaskDraft } from "../../lib/useTaskDraft.ts";
import { MdEditor, type MdEditorHandle } from "./MdEditor.tsx";

export interface EditableTaskBodyProps {
  draft: TaskDraft;
  visible: boolean;
  onReady?: (handle: MdEditorHandle | null) => void;
}

export function EditableTaskBody({ draft, visible, onReady }: EditableTaskBodyProps): VNode {
  return (
    // `hidden` on the wrapper removes the whole editor column from layout
    // and the tab order while Read/Activity are shown (V3/D4); the inner
    // MdEditor host is hidden too so CodeMirror never paints or focuses.
    <div class="editable-task-body" hidden={!visible}>
      {/* Body autosave has no blur handler by design — some browsers do not
          fire blur on tab-hide. The draft's 600ms idle timer catches normal
          focus moves; the 3s max-wait is the safety net; Mod-S inside the
          editor flushes immediately. */}
      {draft.ready ? (
        <MdEditor
          key={`body-${draft.bodyEpoch}`}
          value={draft.body}
          placeholder="Add a description…"
          visible={visible}
          onReady={onReady}
          onChange={v => draft.set("body", v)}
          onSubmit={() => draft.flush()}
        />
      ) : draft.loadError == null ? (
        <div class="editor-baseline" role="status">
          Loading the latest version for editing…
        </div>
      ) : (
        <div class="editor-baseline is-error" role="alert">
          <span>Editing is unavailable: {draft.loadError}</span>
          <button type="button" class="draft-retry" onClick={() => draft.reload()}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
