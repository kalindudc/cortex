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

// Scheduler abstraction so unit tests can drive the debounce + max-wait timers
// without real wall-clock waits. bun:test does NOT mock setTimeout/clearTimeout
// (see oven-sh/bun docs/test/dates-times.mdx — "Timers are not impacted yet");
// the only way to test the debounce + ceiling logic in <1ms is to inject a
// scheduler whose schedule() returns synchronously and lets the test fire
// pending callbacks at will. Production callers omit the argument and get the
// default { schedule: setTimeout, clear: clearTimeout } so runtime behavior is
// bit-identical to the pre-injection version.
export interface Scheduler {
  schedule: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

const defaultScheduler: Scheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  clear: id => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function useAutosave(
  commit: () => void | Promise<void>,
  idleMs: number = 600,
  maxMs: number = 3000,
  scheduler: Scheduler = defaultScheduler,
): { schedule: () => void; flush: () => void } {
  // commitRef refreshes every render so the latest closure (with current
  // signal values) is what fires when timers tick — mirrors the
  // onChangeRef pattern inside MdEditor.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const idleTimer = useRef<unknown>(null);
  const maxTimer = useRef<unknown>(null);
  const dirty = useRef(false);

  const flush = () => {
    if (!dirty.current) return;
    if (idleTimer.current !== null) {
      scheduler.clear(idleTimer.current);
      idleTimer.current = null;
    }
    if (maxTimer.current !== null) {
      scheduler.clear(maxTimer.current);
      maxTimer.current = null;
    }
    dirty.current = false;
    commitRef.current?.();
  };
  const schedule = () => {
    dirty.current = true;
    if (idleTimer.current !== null) scheduler.clear(idleTimer.current);
    idleTimer.current = scheduler.schedule(flush, idleMs);
    // Hard-ceiling timer arms only on the FIRST dirty change of a burst so
    // a continuous typist still gets a periodic flush.
    if (maxTimer.current === null) maxTimer.current = scheduler.schedule(flush, maxMs);
  };

  // Unmount-flush: guarantees the previous task's pending edits commit
  // before the new task's EditableTaskBody mounts (parent key=task.id
  // re-mounts on every task switch).
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return { schedule, flush };
}
