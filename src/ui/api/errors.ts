// api/errors.ts — Error surfacing for the cortex dashboard.
//
// `showError` pushes an error entry into the notifications drawer (the
// floating .toast element is gone — errors live in the same drawer as
// status transitions so the user has one inbox to scan).
// `tryApi` wraps a Promise-returning thunk so the standard error path is
// "call showError and re-throw" — callers can still .catch() when they need
// to branch on the failure (the thrown error keeps its original shape).

import { pushNotification } from "../state/notifications.ts";

export function showError(e: unknown): void {
  const msg = String((e as { message?: string } | null)?.message ?? e);
  pushNotification({ kind: "error", title: "Error", message: msg });
}

export async function tryApi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    showError(e);
    throw e;
  }
}
