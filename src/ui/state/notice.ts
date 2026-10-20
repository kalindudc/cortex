// The status bar's one-line notice for the outcome of a command. A newer notice replaces the shown one, and
// each clears itself after NOTICE_MS unless a newer one took its place.

import { signal, type Signal } from "@preact/signals";

export interface Notice {
  readonly id: number;
  readonly text: string;
}

export const NOTICE_MS = 6000;

export const notice: Signal<Notice | null> = signal<Notice | null>(null);

let nextId = 1;

export function showNotice(text: string): void {
  const id = nextId++;
  notice.value = { id, text };
  setTimeout(() => {
    if (notice.peek()?.id === id) notice.value = null;
  }, NOTICE_MS);
}
