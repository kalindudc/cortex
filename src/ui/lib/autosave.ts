// lib/autosave.ts — Debounced + max-wait commit hook for always-editable
// inputs.
//
// Every change calls schedule(); the commit fn fires on whichever comes
// first: 600 ms idle (debounce) or 3000 ms since the first dirty change
// (hard ceiling so a continuous typist still saves periodically). flush()
// commits immediately and is invoked on blur and on unmount so a fast
// task switch (parent key change) never drops the last keystroke.
//
// Errors are swallowed by the caller — commit functions are expected to
// wrap their api call in tryApi at the call site, so this hook does not
// need its own try/catch (matches the pattern in PostUpdateForm.submit).

import { useEffect, useRef } from "preact/hooks";

export function useAutosave(
  commit: () => void | Promise<void>,
  idleMs: number = 600,
  maxMs: number = 3000,
): { schedule: () => void; flush: () => void } {
  // commitRef refreshes every render so the latest closure (with current
  // signal values) is what fires when timers tick — mirrors the
  // onChangeRef pattern inside MdEditor.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  const flush = () => {
    if (!dirty.current) return;
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (maxTimer.current) {
      clearTimeout(maxTimer.current);
      maxTimer.current = null;
    }
    dirty.current = false;
    commitRef.current?.();
  };
  const schedule = () => {
    dirty.current = true;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(flush, idleMs);
    // Hard-ceiling timer arms only on the FIRST dirty change of a burst so
    // a continuous typist still gets a periodic flush.
    if (!maxTimer.current) maxTimer.current = setTimeout(flush, maxMs);
  };

  // Unmount-flush: guarantees the previous task's pending edits commit
  // before the new task's EditableTaskBody mounts (parent key=task.id
  // re-mounts on every task switch).
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return { schedule, flush };
}
