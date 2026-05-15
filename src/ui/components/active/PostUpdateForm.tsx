// PostUpdateForm — compose textarea + author input + submit for posting
// updates on the active task. Re-publishes its submit closure to
// window.__cortexPostUpdate on every render so the global Cmd/Ctrl+Enter
// handler in index.tsx can flush the latest closure (with the current task
// + signal values).

import type { JSX, VNode } from "preact";
import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";

import type { Task } from "../../api/types.ts";
import { meAuthor } from "../../state/signals.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { autosizeRef } from "../../lib/autosize.ts";
import { onSubmitKeys, kbd } from "../../lib/keys.ts";

// PostUpdateForm publishes its submit closure to window.__cortexPostUpdate
// for the global Cmd/Ctrl+Enter handler. Strict mode requires we declare
// the field on Window.
declare global {
  interface Window {
    __cortexPostUpdate?: () => void;
  }
}

export function PostUpdateForm({ task }: { task: Task }): VNode {
  const summary = useSignal("");
  // Default to the resolved "me" identity (gh username -> git -> hostname).
  // If meAuthor resolves AFTER mount and the user hasn't typed anything yet,
  // pick up the resolved value via the effect below.
  const author = useSignal(meAuthor.value);
  useEffect(() => {
    if (author.value === "me" || author.value === "") author.value = meAuthor.value;
  }, [meAuthor.value]);
  const len = summary.value.length;
  // Single submit path called from both onSubmit and the global Cmd/Ctrl+Enter
  // handler in index.tsx. We re-publish on every render so window.__cortexPostUpdate
  // always points at the current closure (with the current task + signal values).
  const submit = async () => {
    if (!summary.value.trim()) return;
    await tryApi(() => api.postUpd(task.id, { author: author.value, summary: summary.value }));
    summary.value = "";
  };
  window.__cortexPostUpdate = submit;
  return (
    <form
      class="compose"
      onSubmit={(e: Event) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={onSubmitKeys(submit)}
    >
      <textarea
        id="post-update-input"
        class="autosize"
        ref={autosizeRef}
        placeholder="Post an update…"
        rows={2}
        maxlength={1024}
        value={summary.value}
        onInput={(e: JSX.TargetedInputEvent<HTMLTextAreaElement>) => (summary.value = e.currentTarget.value)}
        onKeyDown={onSubmitKeys(submit)}
      />
      <div class="compose-foot">
        <input
          class="author"
          title="Author (default from gh / git / hostname)"
          value={author.value}
          onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (author.value = e.currentTarget.value)}
        />
        <span class="grow"></span>
        <span class={`char-counter num${len > 1000 ? " warn" : ""}`}>{len}/1024</span>
        {/* The Cmd/Ctrl+/ focus hint moved to the collapsible toggle button
             in ActiveTaskPane so it is visible even when this form is
             unmounted (collapsed state). Only the submit-key hint stays
             here since it only applies while the textarea is focused. */}
        <button type="submit" class="btn btn-primary" style="height:24px; padding:0 10px">
          <span>Post</span>
          <span class="kbd">{kbd("\u21b5")}</span>
        </button>
      </div>
    </form>
  );
}
