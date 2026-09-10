// state/refresh.ts — Server-pull entrypoints + reactive update fetcher.
//
// `refresh()` is the standard "the server says something changed" entry,
// called at boot and on every SSE event from the daemon (debounced in
// index.tsx). `fetchAuthors()` is the lazy load of the author rollup invoked
// when the user opens the Authors tab.
//
// TASK-SAFE RELATED (task 330, N2): every Related fetch carries a request
// generation and re-checks the ACTIVE task before publishing — in BOTH
// async paths (refresh() and the activeTask effect). A slow response or
// failure for task A can never appear under task B, a stale response can
// never replace a newer success, and failures publish an explicit
// error/retry state (relatedError) instead of a silent empty success.
// Update lists are keyed by task id in the `updates` map, so a late updates
// response lands under its own key harmlessly.

import { effect } from "@preact/signals";
import { api } from "../api/client.ts";
import { showError } from "../api/errors.ts";
import { tasks, lanes, tags, updates, authors, relatedTasks, relatedLoading, relatedError } from "./signals.ts";
import { notifications } from "./notifications.ts";
import { activeTask } from "./computed.ts";
import { pruneTaskDrafts } from "../lib/useTaskDraft.ts";

// Lazy load of the author rollup. Called when the user opens the Authors
// tab. Errors surface via the standard toast.
export async function fetchAuthors(): Promise<void> {
  try {
    authors.value = await fetch("/api/authors").then(r => r.json());
  } catch (e) {
    showError(e);
  }
}

// Monotonic request generation for Related fetches. A publication is valid
// only when (a) its generation is still the newest AND (b) the task it was
// fetched for is still the active task.
let relatedGen = 0;

export async function fetchRelated(taskId: number): Promise<void> {
  // A refresh path may resume after its task was already replaced/deleted.
  // Reject that request BEFORE touching global state or issuing I/O.
  if (activeTask.peek()?.id !== taskId) return;

  const gen = ++relatedGen;
  relatedLoading.value = { taskId, generation: gen };
  relatedError.value = null;
  const current = (): boolean => gen === relatedGen && activeTask.peek()?.id === taskId;
  try {
    const r = await api.related(taskId);
    if (!current()) return; // stale generation or task switched — discard
    relatedTasks.value = r;
    relatedLoading.value = null;
  } catch (err) {
    if (!current()) return; // stale failure — never paint it on the current task
    relatedError.value = {
      taskId,
      message: err instanceof Error ? err.message : String(err),
    };
    relatedLoading.value = null;
  }
}

// Explicit retry for the Related error state (N2).
export function retryRelated(): void {
  const at = activeTask.peek();
  if (at) void fetchRelated(at.id);
}

// Re-pulls tasks + lanes (and updates for the active task) from the server.
// Called at boot and on every SSE event from the daemon (debounced in index.tsx).
export async function refresh(): Promise<void> {
  try {
    const [ts, ls, tg, nf] = await Promise.all([api.tasks(), api.lanes(), api.tags(), api.notifications()]);
    tasks.value = ts;
    lanes.value = ls;
    tags.value = tg;
    notifications.value = nf;
    // Confirmed deletions release their recovery drafts (D2).
    pruneTaskDrafts(ts.map(t => t.id));
    const at = activeTask.peek();
    if (at) {
      const taskId = at.id;
      const u = await api.updates(taskId);
      // Keyed by the ORIGINAL task id — a task switch mid-flight cannot
      // misfile another task's thread (N2).
      updates.value = { ...updates.value, [taskId]: u };
      void fetchRelated(taskId);
    } else {
      // Invalidate any request that began before this refresh discovered
      // there is no active task (for example, the selected task was deleted).
      relatedGen++;
      relatedTasks.value = null;
      relatedLoading.value = null;
      relatedError.value = null;
    }
  } catch (err) {
    showError(err);
  }
}

// Reactive: when activeTask changes id, lazily fetch its updates so the
// Activity panel is populated even if the task was created mid-session.
let lastActive: number | null = null;
effect(() => {
  const at = activeTask.value;
  if (!at) {
    if (lastActive == null) return;
    lastActive = null;
    // No current owner: invalidate all pending generations and clear every
    // part of the global Related view state synchronously.
    relatedGen++;
    relatedTasks.value = null;
    relatedLoading.value = null;
    relatedError.value = null;
    return;
  }
  if (at.id === lastActive) return;

  lastActive = at.id;
  const taskId = at.id;
  api
    .updates(taskId)
    .then(u => {
      updates.value = { ...updates.value, [taskId]: u }; // keyed by task id
    })
    .catch(() => {
      /* swallow — listing is non-critical */
    });
  // Clear stale data so the Related tab shows a loading state instead
  // of the previous task's buckets while the fetch is in flight.
  relatedTasks.value = null;
  void fetchRelated(taskId);
});
