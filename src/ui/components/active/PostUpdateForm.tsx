// PostUpdateForm — inline Activity composer.
//
// Labeled author + summary (4096-char limit, Mod-Enter/Mod-S posting via
// the shared onSubmitKeys matcher — IME-safe). Summary/author DRAFTS are
// kept per task in module memory so hiding the panel or switching tasks
// cannot discard or misattribute text; the task id and payload are captured
// AT DISPATCH so a slow response can never post to — or clear — another
// task's draft. Clearing is revision-scoped: only the exact submitted text
// clears on ack, newer typing and failed text always survive. The returned
// update is inserted into the updates signal once, deduped against its SSE
// echo by id.
//
// The submit closure is published to window.__cortexPostUpdate for the
// global Cmd/Ctrl+Enter fallback and UNREGISTERED on unmount so a hidden or
// stale form can never submit an old task closure. Focus arrives via
// workspace.requestPostUpdate → postUpdateFocusRequest.

import type { JSX, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import type { Task, Update } from "../../api/types.ts";
import { meAuthor, updates, postUpdateFocusRequest } from "../../state/signals.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { autosizeRef } from "../../lib/autosize.ts";
import { onSubmitKeys, kbd } from "../../lib/keys.ts";

declare global {
  interface Window {
    __cortexPostUpdate?: () => void;
  }
}

// ---- per-task composer drafts (module memory) ----
interface PostDraft {
  summary: string;
  author: string | null; // null = follow meAuthor until the user edits it
  revision: number;
}
const postDrafts = new Map<number, PostDraft>();
function draftFor(taskId: number): PostDraft {
  let d = postDrafts.get(taskId);
  if (!d) {
    d = { summary: "", author: null, revision: 0 };
    postDrafts.set(taskId, d);
  }
  return d;
}
/** Test-only reset of the module draft memory. */
export function clearPostDrafts(): void {
  postDrafts.clear();
  consumedFocusRequest = 0;
}

// Focus-request consumption marker (module-level, NOT a per-mount ref):
// requestPostUpdate bumps the counter BEFORE the form mounts when the
// disclosure was collapsed — a fresh mount must still consume the pending
// request, while a boot-time mount (counter untouched) must NOT steal
// focus.
let consumedFocusRequest = 0;

// Insert an update into the task's thread once (dedupe by id — the SSE
// echo may land before or after the API response).
function insertUpdate(taskId: number, u: Update): void {
  const list = updates.value[taskId] ?? [];
  if (list.some(x => x.id === u.id)) return;
  updates.value = { ...updates.value, [taskId]: [...list, u] };
}

export function PostUpdateForm({ task }: { task: Task }): VNode {
  const taskId = task.id;
  const stored = draftFor(taskId);
  const summary = useSignal(stored.summary);
  const author = useSignal(stored.author ?? meAuthor.value);
  const submitting = useSignal(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // meAuthor may resolve after mount; follow it until the user edits.
  useEffect(() => {
    if (draftFor(taskId).author == null) author.value = meAuthor.value;
  }, [meAuthor.value]);

  // Focus routing: requestPostUpdate bumps the counter after selecting
  // Activity + expanding the disclosure; we scroll into view and focus —
  // whether the form was already mounted (effect rerun) or mounts just now
  // (initial run sees the unconsumed counter).
  useEffect(() => {
    if (postUpdateFocusRequest.value === consumedFocusRequest) return;
    consumedFocusRequest = postUpdateFocusRequest.value;
    const ta = taRef.current;
    if (!ta) return;
    ta.scrollIntoView?.({ block: "nearest" });
    ta.focus();
  }, [postUpdateFocusRequest.value]);

  const setSummary = (v: string): void => {
    summary.value = v;
    const d = draftFor(taskId);
    d.summary = v;
    d.revision++;
  };
  const setAuthor = (v: string): void => {
    author.value = v;
    draftFor(taskId).author = v;
  };

  const submit = async (): Promise<void> => {
    // Capture EVERYTHING at dispatch: a re-render or task switch
    // after this point cannot change what we post or what we clear.
    const id = taskId;
    const d = draftFor(id);
    const payload = { author: author.value, summary: summary.value };
    const revisionAtDispatch = d.revision;
    if (!payload.summary.trim()) return;
    if (submitting.value) return; // duplicate-submit guard
    submitting.value = true;
    try {
      const created = await tryApi(() => api.postUpd(id, payload));
      insertUpdate(id, created as Update);
      // Clear ONLY the submitted revision — newer typing survives.
      const now = draftFor(id);
      if (now.revision === revisionAtDispatch) {
        now.summary = "";
        now.revision++;
        if (id === taskId) summary.value = "";
      }
    } catch {
      // tryApi already reported; the draft (and textarea) keep the text.
    } finally {
      submitting.value = false;
    }
  };

  // Publish the CURRENT closure for the global Cmd/Ctrl+Enter fallback;
  // unregister on unmount so a stale form can never submit.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const call = (): void => void submitRef.current();
    window.__cortexPostUpdate = call;
    return () => {
      if (window.__cortexPostUpdate === call) delete window.__cortexPostUpdate;
    };
  }, []);

  const len = summary.value.length;
  const onKeys = onSubmitKeys(() => void submit());

  return (
    <form
      class="compose"
      onSubmit={(e: Event) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={onKeys}
    >
      <label class="compose-label" for="post-update-input">
        Update summary
      </label>
      <textarea
        id="post-update-input"
        class="autosize"
        ref={el => {
          taRef.current = el;
          autosizeRef(el);
        }}
        placeholder="Post an update…"
        rows={2}
        maxlength={4096}
        value={summary.value}
        onInput={(e: JSX.TargetedInputEvent<HTMLTextAreaElement>) => setSummary(e.currentTarget.value)}
        onKeyDown={onKeys}
      />
      <div class="compose-foot">
        <div class="compose-author">
          <label for="post-update-author">Author</label>
          <input
            id="post-update-author"
            class="author"
            title="Author (default from gh / git / hostname)"
            value={author.value}
            onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => setAuthor(e.currentTarget.value)}
          />
        </div>
        <div class="compose-submit-row">
          <span class={`char-counter num${len > 4000 ? " warn" : ""}`}>{len}/4096</span>
          <button
            type="submit"
            class="btn btn-primary compose-submit"
            disabled={submitting.value || summary.value.trim() === ""}
          >
            <span>Post update</span>
            <span class="kbd">{kbd("\u21b5")}</span>
          </button>
        </div>
      </div>
    </form>
  );
}
