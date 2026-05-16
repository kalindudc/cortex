// state/refresh.ts — Server-pull entrypoints + reactive update fetcher.
//
// `refresh()` is the standard "the server says something changed" entry,
// called at boot and on every SSE event from the daemon (debounced in
// index.tsx). `fetchAuthors()` is the lazy load of the author rollup invoked
// when the user opens the Authors tab.
//
// The module-level `effect` watches `activeTask` and lazy-fetches its
// updates so the inbox pane is populated even if the task was created
// mid-session.

import { effect } from "@preact/signals";
import { api } from "../api/client.ts";
import { showError } from "../api/errors.ts";
import { tasks, lanes, tags, updates, authors, relatedTasks } from "./signals.ts";
import { notifications } from "./notifications.ts";
import { activeTask } from "./computed.ts";

// Lazy load of the author rollup. Called when the user opens the Authors
// tab in the inbox pane. Errors surface via the standard toast.
export async function fetchAuthors(): Promise<void> {
  try {
    authors.value = await fetch("/api/authors").then(r => r.json());
  } catch (e) {
    showError(e);
  }
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
    const at = activeTask.value;
    if (at) {
      updates.value = { ...updates.value, [at.id]: await api.updates(at.id) };
      // Related is non-critical — swallow per-request errors so a
      // missing/slow endpoint never blocks the rest of the dashboard.
      try {
        relatedTasks.value = await api.related(at.id);
      } catch {
        /* swallow — Related view will keep showing prior data */
      }
    } else {
      relatedTasks.value = null;
    }
  } catch (err) {
    showError(err);
  }
}

// Reactive: when activeTask changes id, lazily fetch its updates so the inbox
// pane is populated even if the task was created mid-session.
let lastActive: number | null = null;
effect(() => {
  const at = activeTask.value;
  if (at && at.id !== lastActive) {
    lastActive = at.id;
    api
      .updates(at.id)
      .then(u => {
        updates.value = { ...updates.value, [at.id]: u };
      })
      .catch(() => {
        /* swallow — listing is non-critical */
      });
    // Clear stale data so the Related tab shows a loading state instead
    // of the previous task's buckets while the fetch is in flight.
    relatedTasks.value = null;
    api
      .related(at.id)
      .then(r => {
        relatedTasks.value = r;
      })
      .catch(() => {
        /* swallow — Related is non-critical */
      });
  }
});
