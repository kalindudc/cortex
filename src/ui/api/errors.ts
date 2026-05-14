// api/errors.ts — Error toast surfacing for the cortex dashboard.
//
// `showError` writes a 4s-self-clearing message to the `errorMsg` signal.
// `tryApi` wraps a Promise-returning thunk so the standard error path is
// "call showError and re-throw" — callers can still .catch() when they need
// to branch on the failure (the thrown error keeps its original shape).

import { errorMsg } from "../state/signals.ts";

export function showError(e: unknown): void {
  const msg = String((e as { message?: string } | null)?.message ?? e);
  errorMsg.value = msg;
  // Clear the toast after 4s — but only if it's still the same message we
  // set. Otherwise a newer error would flash and immediately disappear.
  setTimeout(() => {
    if (errorMsg.value === msg) errorMsg.value = null;
  }, 4000);
}

export async function tryApi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    showError(e);
    throw e;
  }
}
