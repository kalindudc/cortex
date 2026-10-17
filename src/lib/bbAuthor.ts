// The same pattern `cortex resume` accepts, so every defaulted bb author can be resumed.
const BB_THREAD_RE = /^thr_[0-9a-z]{6,40}$/;

export function authorForBbThread(explicit: string | undefined, threadId: string | undefined): string | undefined {
  if (explicit !== undefined) return explicit;
  if (threadId !== undefined && BB_THREAD_RE.test(threadId)) return `bb-${threadId}`;
  return undefined;
}
