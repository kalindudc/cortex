// Unit tests for useAutosave — drives the debounce + max-wait timers via an
// injected Scheduler. No real wall-clock waits. Uses a tiny Harness component
// to mount the hook because @testing-library/preact 3.x doesn't ship renderHook.

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { render } from "@testing-library/preact";
import { h } from "preact";
import { useAutosave, type Scheduler } from "../../../src/ui/lib/autosave.ts";

interface Pending {
  fn: () => void;
  ms: number;
}

function makeScheduler(): {
  scheduler: Scheduler;
  pending: Map<number, Pending>;
  fire: (id: number) => void;
  fireFirstWithMs: (ms: number) => number | undefined;
} {
  const pending = new Map<number, Pending>();
  let nextId = 0;
  const scheduler: Scheduler = {
    schedule: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clear: id => {
      pending.delete(id as number);
    },
  };
  return {
    scheduler,
    pending,
    fire: (id: number) => {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        entry.fn();
      }
    },
    fireFirstWithMs: (ms: number) => {
      for (const [id, p] of pending) {
        if (p.ms === ms) {
          pending.delete(id);
          p.fn();
          return id;
        }
      }
      return undefined;
    },
  };
}

// Tiny harness that mounts the hook and exposes its return value to the test.
// `apiRef.current` is updated each render with the latest api surface.
let apiRef: { current: { schedule: () => void; flush: () => void; cancel: () => void } | null } = { current: null };

// Unwrap helper. If the Harness was rendered, apiRef.current is set; if not,
// the test setup is broken and we want a loud failure instead of a silent
// nullable-deref. Avoids the non-null `!` operator (Biome treats it as
// lint/style/noNonNullAssertion error).
function api(): { schedule: () => void; flush: () => void; cancel: () => void } {
  if (!apiRef.current) throw new Error("Harness not mounted: apiRef.current is null");
  return apiRef.current;
}

function Harness({
  commit,
  scheduler,
  idleMs = 600,
  maxMs = 3000,
}: {
  commit: () => void;
  scheduler: Scheduler;
  idleMs?: number;
  maxMs?: number;
}): null {
  apiRef.current = useAutosave(commit, idleMs, maxMs, scheduler);
  return null;
}

describe("useAutosave", () => {
  beforeEach(() => {
    apiRef = { current: null };
  });

  test("schedule() arms idle timer that calls commit when fired", () => {
    const commit = mock(() => {});
    const { scheduler, pending, fireFirstWithMs } = makeScheduler();

    render(h(Harness, { commit, scheduler }));
    api().schedule();

    // Two pending timers: idle (600 ms) and max (3000 ms).
    expect(pending.size).toBe(2);
    // Fire the idle timer.
    fireFirstWithMs(600);

    expect(commit).toHaveBeenCalledTimes(1);
  });

  test("rapid schedule() resets the idle timer but keeps the same max-ceiling timer", () => {
    const commit = mock(() => {});
    const { scheduler, pending } = makeScheduler();

    render(h(Harness, { commit, scheduler }));
    api().schedule();
    api().schedule();
    api().schedule();

    // The old idle timers must have been cleared — we expect exactly one
    // idle (600 ms) and one max (3000 ms) entry pending.
    const msList = [...pending.values()].map(p => p.ms).sort((a, b) => a - b);
    expect(msList).toEqual([600, 3000]);
    expect(commit).toHaveBeenCalledTimes(0);
  });

  test("3 s max-wait fires even when idle keeps being reset", () => {
    const commit = mock(() => {});
    const { scheduler, pending, fireFirstWithMs } = makeScheduler();

    render(h(Harness, { commit, scheduler }));
    api().schedule();
    api().schedule();
    api().schedule();

    // Fire only the max-ceiling timer — simulates a continuous typist whose
    // idle timer is being reset on every keystroke.
    fireFirstWithMs(3000);

    expect(commit).toHaveBeenCalledTimes(1);
    // Both timers should have been cleared by flush().
    expect(pending.size).toBe(0);
  });

  test("flush() fires immediately and clears both timers", () => {
    const commit = mock(() => {});
    const { scheduler, pending } = makeScheduler();

    render(h(Harness, { commit, scheduler }));
    api().schedule();
    expect(pending.size).toBe(2);

    api().flush();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
  });

  test("flush() is a no-op when nothing is dirty", () => {
    const commit = mock(() => {});
    const { scheduler, pending } = makeScheduler();

    render(h(Harness, { commit, scheduler }));
    api().flush();

    expect(commit).toHaveBeenCalledTimes(0);
    expect(pending.size).toBe(0);
  });

  test("unmount triggers flush of pending edits", () => {
    const commit = mock(() => {});
    const { scheduler, pending } = makeScheduler();

    const { unmount } = render(h(Harness, { commit, scheduler }));
    api().schedule();
    expect(pending.size).toBe(2);

    unmount();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
  });

  test("unmount without any pending edits does not call commit", () => {
    const commit = mock(() => {});
    const { scheduler } = makeScheduler();

    const { unmount } = render(h(Harness, { commit, scheduler }));
    unmount();

    expect(commit).toHaveBeenCalledTimes(0);
  });

  // ---- cancel() (task 330: pause/discard unsent work without committing) ----

  test("cancel() clears both timers WITHOUT committing", () => {
    const commit = mock(() => {});
    const { scheduler, pending } = makeScheduler();

    render(h(Harness, { commit, scheduler }));
    api().schedule();
    expect(pending.size).toBe(2);

    api().cancel();

    expect(commit).toHaveBeenCalledTimes(0);
    expect(pending.size).toBe(0);
  });

  test("flush() after cancel() is a no-op (nothing dirty anymore)", () => {
    const commit = mock(() => {});
    const { scheduler } = makeScheduler();

    render(h(Harness, { commit, scheduler }));
    api().schedule();
    api().cancel();
    api().flush();

    expect(commit).toHaveBeenCalledTimes(0);
  });

  test("unmount after cancel() does not resurrect the cancelled commit", () => {
    const commit = mock(() => {});
    const { scheduler } = makeScheduler();

    const { unmount } = render(h(Harness, { commit, scheduler }));
    api().schedule();
    api().cancel();
    unmount();

    expect(commit).toHaveBeenCalledTimes(0);
  });

  test("schedule() after cancel() re-arms both timers normally", () => {
    const commit = mock(() => {});
    const { scheduler, pending, fireFirstWithMs } = makeScheduler();

    render(h(Harness, { commit, scheduler }));
    api().schedule();
    api().cancel();
    api().schedule();

    expect(pending.size).toBe(2);
    fireFirstWithMs(600);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
