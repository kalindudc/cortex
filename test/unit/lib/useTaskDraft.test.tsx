// useTaskDraft — the ONE task draft owner (task 330, D1–D3).
//
// Deterministic async: api.editTask is mocked with DEFERRED promises the
// test resolves/rejects explicitly, and the debounce timers run on an
// injected Scheduler — no wall-clock waits, no timing guesses.

import { describe, test, expect, mock, beforeEach } from "bun:test";

interface DeferredCall {
  id: number;
  patch: Record<string, unknown>;
  resolve: (v?: unknown) => void;
  reject: (e: Error) => void;
}
const editCalls: DeferredCall[] = [];

mock.module("../../../src/ui/api/client.ts", () => ({
  api: {
    editTask: mock(
      (id: number, patch: Record<string, unknown>) =>
        new Promise((resolve, reject) => {
          editCalls.push({ id, patch, resolve, reject });
        }),
    ),
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
  },
}));

// Silence the error toast machinery — tryApi reports through showError.
mock.module("../../../src/ui/api/errors.ts", () => ({
  tryApi: async <T,>(fn: () => Promise<T>): Promise<T> => fn(),
  showError: () => {},
}));

import { render } from "@testing-library/preact";
import { h } from "preact";
import { useTaskDraft, pruneTaskDrafts, hasUnsavedDrafts, type TaskDraft } from "../../../src/ui/lib/useTaskDraft.ts";
import type { Scheduler } from "../../../src/ui/lib/autosave.ts";
import type { Task } from "../../../src/ui/api/types.ts";

const mkTask = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body: "original body",
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  ...over,
});

interface Pending {
  fn: () => void;
  ms: number;
}
function makeScheduler(): { scheduler: Scheduler; pending: Map<number, Pending>; fireAll: (ms?: number) => void } {
  const pending = new Map<number, Pending>();
  let nextId = 0;
  return {
    scheduler: {
      schedule: (fn, ms) => {
        const id = nextId++;
        pending.set(id, { fn, ms });
        return id;
      },
      clear: id => {
        pending.delete(id as number);
      },
    },
    pending,
    fireAll: (ms?: number) => {
      for (const [id, p] of [...pending]) {
        if (ms === undefined || p.ms === ms) {
          pending.delete(id);
          p.fn();
        }
      }
    },
  };
}

let draftRef: { current: TaskDraft | null } = { current: null };
function draft(): TaskDraft {
  if (!draftRef.current) throw new Error("Harness not mounted");
  return draftRef.current;
}
function Harness({ task, scheduler }: { task: Task; scheduler: Scheduler }): null {
  draftRef.current = useTaskDraft(task, scheduler);
  return null;
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe("useTaskDraft", () => {
  beforeEach(() => {
    editCalls.length = 0;
    draftRef = { current: null };
    // Isolate module-level draft memory between tests.
    pruneTaskDrafts([]);
  });

  test("initial state mirrors the task; clean → saved", () => {
    const { scheduler } = makeScheduler();
    render(h(Harness, { task: mkTask(1), scheduler }));
    expect(draft().title).toBe("task 1");
    expect(draft().body).toBe("original body");
    expect(draft().saveState).toBe("saved");
    expect(draft().external).toEqual({ title: null, body: null });
    expect(draft().bodyEpoch).toBe(0);
  });

  test("set('title') normalizes newlines and goes pending (D2)", () => {
    const { scheduler } = makeScheduler();
    render(h(Harness, { task: mkTask(1), scheduler }));
    draft().set("title", "multi\nline\n\ntitle");
    expect(draft().title).toBe("multi line title");
    expect(draft().saveState).toBe("pending");
  });

  test("idle timer fires → saving with the PATCH in flight; ack → saved", async () => {
    const { scheduler, fireAll } = makeScheduler();
    render(h(Harness, { task: mkTask(1), scheduler }));
    draft().set("title", "renamed");
    fireAll(600);
    expect(draft().saveState).toBe("saving");
    expect(editCalls.length).toBe(1);
    expect(editCalls[0].id).toBe(1);
    expect(editCalls[0].patch).toEqual({ title: "renamed" });
    editCalls[0].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
  });

  test("empty body converts to null in the PATCH (D2)", async () => {
    const { scheduler, fireAll } = makeScheduler();
    render(h(Harness, { task: mkTask(1), scheduler }));
    draft().set("body", "");
    fireAll(600);
    expect(editCalls[0].patch).toEqual({ body: null });
    editCalls[0].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
  });

  test("saves serialize per field: one in flight, latest trailing edit follows (D2)", async () => {
    const { scheduler, fireAll } = makeScheduler();
    render(h(Harness, { task: mkTask(1), scheduler }));
    draft().set("body", "v1");
    fireAll(600);
    expect(editCalls.length).toBe(1);
    // New edits while the PATCH is in flight — must NOT open a second request.
    draft().set("body", "v2");
    fireAll(600);
    draft().set("body", "v3");
    fireAll(600);
    expect(editCalls.length).toBe(1);
    // First ack lands → exactly one trailing save with the LATEST text.
    editCalls[0].resolve();
    await tick();
    expect(editCalls.length).toBe(2);
    expect(editCalls[1].patch).toEqual({ body: "v3" });
    editCalls[1].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
  });

  test("a stale completion never labels newer text Saved (D2)", async () => {
    const { scheduler, fireAll } = makeScheduler();
    render(h(Harness, { task: mkTask(1), scheduler }));
    draft().set("body", "old");
    fireAll(600);
    draft().set("body", "newer text"); // typed while PATCH('old') is in flight
    editCalls[0].resolve(); // stale ack
    await tick();
    expect(draft().saveState).not.toBe("saved");
    // The trailing save carries the newer text.
    const last = editCalls[editCalls.length - 1];
    expect(last.patch).toEqual({ body: "newer text" });
  });

  test("failed save → error state; retry() re-PATCHes the latest text", async () => {
    const { scheduler, fireAll } = makeScheduler();
    render(h(Harness, { task: mkTask(1), scheduler }));
    draft().set("title", "will fail");
    fireAll(600);
    editCalls[0].reject(new Error("boom"));
    await tick();
    expect(draft().saveState).toBe("error");
    draft().retry();
    await tick();
    expect(editCalls.length).toBe(2);
    expect(editCalls[1].patch).toEqual({ title: "will fail" });
    editCalls[1].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
  });

  test("own SSE echo converges without a false conflict (D3)", async () => {
    const { scheduler, fireAll } = makeScheduler();
    const { rerender } = render(h(Harness, { task: mkTask(1), scheduler }));
    draft().set("body", "mine");
    fireAll(600);
    editCalls[0].resolve();
    await tick();
    const epochBefore = draft().bodyEpoch;
    // Server echoes our own write back through SSE → task prop refresh.
    rerender(h(Harness, { task: mkTask(1, { body: "mine" }), scheduler }));
    expect(draft().external.body).toBeNull();
    expect(draft().body).toBe("mine");
    expect(draft().bodyEpoch).toBe(epochBefore); // no editor remount for own echo (D3/D4)
  });

  test("clean incoming change updates the draft and bumps bodyEpoch (D3)", () => {
    const { scheduler } = makeScheduler();
    const { rerender } = render(h(Harness, { task: mkTask(1), scheduler }));
    rerender(h(Harness, { task: mkTask(1, { body: "server v2" }), scheduler }));
    expect(draft().body).toBe("server v2");
    expect(draft().external.body).toBeNull();
    expect(draft().bodyEpoch).toBe(1);
  });

  test("dirty + conflicting incoming → both versions retained, autosave paused until resolution (D3)", () => {
    const { scheduler, fireAll, pending } = makeScheduler();
    const { rerender } = render(h(Harness, { task: mkTask(1), scheduler }));
    draft().set("body", "local edit");
    rerender(h(Harness, { task: mkTask(1, { body: "external edit" }), scheduler }));
    expect(draft().body).toBe("local edit"); // local retained
    expect(draft().external.body).toBe("external edit"); // external retained
    // Paused: firing every timer must not send the local text.
    fireAll();
    expect(editCalls.length).toBe(0);
    expect(pending.size).toBe(0);
  });

  test("Apply adopts the external text, cancels superseded pending work, bumps epoch (D3)", () => {
    const { scheduler, fireAll } = makeScheduler();
    const { rerender } = render(h(Harness, { task: mkTask(1), scheduler }));
    draft().set("body", "local edit");
    rerender(h(Harness, { task: mkTask(1, { body: "external edit" }), scheduler }));
    const epochBefore = draft().bodyEpoch;
    draft().apply("body");
    expect(draft().body).toBe("external edit");
    expect(draft().external.body).toBeNull();
    expect(draft().bodyEpoch).toBe(epochBefore + 1);
    expect(draft().saveState).toBe("saved");
    fireAll();
    expect(editCalls.length).toBe(0); // superseded work cancelled, nothing PATCHes
  });

  test("Keep my changes explicitly queues the local text (D3)", async () => {
    const { scheduler } = makeScheduler();
    const { rerender } = render(h(Harness, { task: mkTask(1), scheduler }));
    draft().set("body", "local edit");
    rerender(h(Harness, { task: mkTask(1, { body: "external edit" }), scheduler }));
    draft().keep("body");
    await tick();
    expect(draft().external.body).toBeNull();
    expect(editCalls.length).toBe(1);
    expect(editCalls[0].patch).toEqual({ body: "local edit" });
    editCalls[0].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
  });

  test("unmount flushes the old task's pending edit (D2 unmount-flush)", () => {
    const { scheduler } = makeScheduler();
    const { unmount } = render(h(Harness, { task: mkTask(7), scheduler }));
    draft().set("title", "last keystroke");
    unmount();
    expect(editCalls.length).toBe(1);
    expect(editCalls[0].id).toBe(7);
    expect(editCalls[0].patch).toEqual({ title: "last keystroke" });
  });

  test("failed unmount-flush snapshot is recovered on remount and re-queued (D2 memory recovery)", async () => {
    const { scheduler } = makeScheduler();
    const first = render(h(Harness, { task: mkTask(9, { body: "base" }), scheduler }));
    draft().set("body", "unsaved work");
    first.unmount(); // flush fires PATCH
    expect(editCalls.length).toBe(1);
    editCalls[0].reject(new Error("network down"));
    await tick();
    expect(hasUnsavedDrafts()).toBe(true);

    // Remount the same task (server value unchanged) → text restored and
    // the interrupted save is re-queued.
    const next = makeScheduler();
    render(h(Harness, { task: mkTask(9, { body: "base" }), scheduler: next.scheduler }));
    expect(draft().body).toBe("unsaved work");
    expect(draft().saveState).toBe("pending");
    next.fireAll(600);
    expect(editCalls.length).toBe(2);
    expect(editCalls[1].patch).toEqual({ body: "unsaved work" });
    editCalls[1].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
    expect(hasUnsavedDrafts()).toBe(false);
  });

  test("recovered snapshot against a MOVED server value surfaces a conflict, not a silent overwrite", async () => {
    const { scheduler } = makeScheduler();
    const first = render(h(Harness, { task: mkTask(11, { body: "base" }), scheduler }));
    draft().set("body", "my unsaved");
    first.unmount();
    editCalls[0].reject(new Error("down"));
    await tick();

    // Someone else moved the body while we were away.
    const next = makeScheduler();
    render(h(Harness, { task: mkTask(11, { body: "someone elses text" }), scheduler: next.scheduler }));
    expect(draft().body).toBe("my unsaved");
    expect(draft().external.body).toBe("someone elses text");
    next.fireAll();
    expect(editCalls.length).toBe(1); // paused — no automatic overwrite
  });

  test("pruneTaskDrafts drops snapshots for deleted tasks", async () => {
    const { scheduler } = makeScheduler();
    const first = render(h(Harness, { task: mkTask(13), scheduler }));
    draft().set("body", "orphaned");
    first.unmount();
    editCalls[0].reject(new Error("down"));
    await tick();
    expect(hasUnsavedDrafts()).toBe(true);
    pruneTaskDrafts([1, 2, 3]); // 13 is gone
    expect(hasUnsavedDrafts()).toBe(false);
  });
});
