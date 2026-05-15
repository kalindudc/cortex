// api/errors.ts — Error surfacing for the cortex dashboard.
//
// `showError` pushes an EPHEMERAL error entry into the notifications
// drawer via pushLocalError. Errors are deliberately NOT persisted to
// the server — they typically fire when the server is unreachable, and
// surfacing stale errors after a reload would be misleading. They live
// alongside server-persisted notifications in the same drawer feed via
// the merged tagged-union signal in state/notifications.ts.
// `tryApi` wraps a Promise-returning thunk so the standard error path is
// "call showError and re-throw" — callers can still .catch() when they need
// to branch on the failure (the thrown error keeps its original shape).

import { pushLocalError } from "../state/notifications.ts";

export function showError(e: unknown): void {
  const msg = String((e as { message?: string } | null)?.message ?? e);
  pushLocalError({ title: "Error", message: msg });
}

export async function tryApi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    showError(e);
    throw e;
  }
}
