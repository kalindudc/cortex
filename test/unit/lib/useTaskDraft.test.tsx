// useTaskDraft — the ONE browser task draft owner (task 330, D1–D3; plan
// @400 N8/N16, Task 9).
//
// Deterministic async: the daemon is a fake with REAL per-field version
// tokens (a token moves only when its field's value changes, like the
// store). Every TaskState read and every guarded write is a DEFERRED promise
// the test answers explicitly, and the debounce timers run on an injected
// Scheduler — no wall-clock waits, no timing guesses.
//
// Contract under test:
//   - editing starts only once an atomic TaskState (text + tokens) is known;
//   - every save is a versioned write guarded by that field's token, and
//     the acknowledged versions become the new baseline; "saved" means the
//     CURRENT text was acknowledged;
//   - a 412 keeps BOTH versions (the incoming one read atomically); Apply
//     adopts it; Keep rebases on the displayed incoming token and writes
//     conditionally again, so it can conflict again;
//   - unrelated metadata never creates a title/body conflict, anchor 409s
//     stay plain errors, and stale answers never revert saved text.

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { HttpError } from "../../../src/api.ts";
import type {
  EditTaskRequest,
  ResourceScope,
  TaskStateSnapshot,
  TaskWriteResult,
  Versions,
  WriteGuard,
} from "../../../src/contracts.ts";

// ---------- a daemon stand-in with real per-field tokens ----------

const SCOPES: readonly ResourceScope[] = ["entity", "title", "body", "priority", "lane", "status"];
interface ServerTask {
  task: Task;
  versions: Versions;
}
const serverTasks = new Map<number, ServerTask>();
let tokenSeq = 0;

function serverPut(t: Task): void {
  const versions: Versions = {};
  for (const scope of SCOPES) versions[scope] = `${scope}-${++tokenSeq}`;
  serverTasks.set(t.id, { task: structuredClone(t), versions });
}
function serverOf(id: number): ServerTask {
  const s = serverTasks.get(id);
  if (!s) throw new Error(`fake server has no task ${id}`);
  return s;
}
function stateOf(id: number): TaskStateSnapshot {
  const s = serverOf(id);
  return { task: structuredClone(s.task), updates: [], versions: { ...s.versions }, cursor: `e1:${tokenSeq}` };
}
/** Another writer (the TUI, the CLI) commits `fields`: only the changed fields' tokens (and entity) move. */
function serverWrite(id: number, fields: Partial<Task>): Task {
  const s = serverOf(id);
  const bumped: ResourceScope[] = ["entity"];
  for (const [key, value] of Object.entries(fields) as [keyof Task, unknown][]) {
    if (JSON.stringify(s.task[key]) === JSON.stringify(value)) continue;
    (s.task as unknown as Record<string, unknown>)[key] = value;
    if ((SCOPES as readonly string[]).includes(key)) bumped.push(key as ResourceScope);
  }
  for (const scope of bumped) s.versions[scope] = `${scope}-${++tokenSeq}`;
  return structuredClone(s.task);
}
function conflictError(id: number, stale: [string, string][]): HttpError {
  const current = serverOf(id).versions;
  return new HttpError(412, `task ${id} changed since it was read`, "version_conflict", undefined, {
    kind: "task",
    key: id,
    mismatches: stale.map(([scope, expected]) => ({
      scope: scope as ResourceScope,
      expected,
      current: current[scope as ResourceScope] ?? "",
    })),
    current: { ...current },
  });
}

interface DeferredCall {
  id: number;
  patch: EditTaskRequest;
  guard: WriteGuard | undefined;
  /** Commit like the daemon: a stale guard rejects with a 412, else the write lands and its versions answer. */
  resolve: () => void;
  /** Commit now (guard-checked) but deliver the answer only when the returned function runs. */
  commit: () => () => void;
  reject: (e: Error) => void;
}
interface StateCall {
  id: number;
  /** Answer with `snap`, or with the fake server's CURRENT state. */
  resolve: (snap?: TaskStateSnapshot) => void;
  reject: (e: Error) => void;
}
const editCalls: DeferredCall[] = [];
const stateCalls: StateCall[] = [];
const legacyEdits: unknown[] = [];
const shownErrors: unknown[] = [];

mock.module("../../../src/ui/api/client.ts", () => ({
  api: {
    taskState: mock(
      (id: number) =>
        new Promise<TaskStateSnapshot>((resolve, reject) => {
          stateCalls.push({ id, resolve: snap => resolve(snap ?? stateOf(id)), reject });
        }),
    ),
    versioned: {
      editTask: mock(
        (id: number, patch: EditTaskRequest, guard?: WriteGuard) =>
          new Promise<TaskWriteResult>((resolve, reject) => {
            const commit = (): (() => void) => {
              const s = serverOf(id);
              const stale = Object.entries(guard?.expected ?? {}).filter(
                ([scope, token]) => s.versions[scope as ResourceScope] !== token,
              ) as [string, string][];
              if (stale.length > 0) {
                const err = conflictError(id, stale);
                return () => reject(err);
              }
              const fields: Partial<Task> = {};
              if (patch.title !== undefined) fields.title = patch.title;
              if (patch.body !== undefined) fields.body = patch.body;
              const task = serverWrite(id, fields);
              const versions = { ...serverOf(id).versions };
              return () => resolve({ task, versions, replayed: false });
            };
            editCalls.push({ id, patch, guard, reject, commit, resolve: () => commit()() });
          }),
      ),
    },
    // The legacy unguarded write must never be used by the draft.
    editTask: mock((id: number, patch: unknown) => {
      legacyEdits.push({ id, patch });
      return Promise.resolve({});
    }),
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
  },
}));

// Record the error toasts (tryApi/showError report through the drawer).
mock.module("../../../src/ui/api/errors.ts", () => ({
  tryApi: async <T,>(fn: () => Promise<T>): Promise<T> => fn(),
  showError: (e: unknown) => {
    shownErrors.push(e);
  },
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

/** Answer every pending TaskState read with the fake server's current state until none is left. */
async function serveReads(): Promise<void> {
  await tick();
  for (let round = 0; round < 10 && stateCalls.length > 0; round++) {
    for (const call of stateCalls.splice(0)) call.resolve();
    await tick();
  }
}
/** Put `t` on the fake server (unless it is already there), render its draft and serve its baseline read. */
async function mountReady(t: Task, scheduler: Scheduler) {
  if (!serverTasks.has(t.id)) serverPut(t);
  const view = render(h(Harness, { task: t, scheduler }));
  await serveReads();
  expect(draft().ready).toBe(true);
  return view;
}
const token = (id: number, scope: ResourceScope): string => serverOf(id).versions[scope] ?? "";

describe("useTaskDraft", () => {
  beforeEach(() => {
    editCalls.length = 0;
    stateCalls.length = 0;
    legacyEdits.length = 0;
    shownErrors.length = 0;
    serverTasks.clear();
    draftRef = { current: null };
    // Isolate module-level draft memory between tests.
    pruneTaskDrafts([]);
  });

  test("initial state mirrors the task; clean → saved", async () => {
    const { scheduler } = makeScheduler();
    await mountReady(mkTask(1), scheduler);
    expect(draft().title).toBe("task 1");
    expect(draft().body).toBe("original body");
    expect(draft().saveState).toBe("saved");
    expect(draft().external).toEqual({ title: null, body: null });
    expect(draft().bodyEpoch).toBe(0);
  });

  test("set('title') normalizes newlines and goes pending (D2)", async () => {
    const { scheduler } = makeScheduler();
    await mountReady(mkTask(1), scheduler);
    draft().set("title", "multi\nline\n\ntitle");
    expect(draft().title).toBe("multi line title");
    expect(draft().saveState).toBe("pending");
  });

  test("idle timer fires → saving with the PATCH in flight; ack → saved", async () => {
    const { scheduler, fireAll } = makeScheduler();
    await mountReady(mkTask(1), scheduler);
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
    await mountReady(mkTask(1), scheduler);
    draft().set("body", "");
    fireAll(600);
    expect(editCalls[0].patch).toEqual({ body: null });
    editCalls[0].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
  });

  test("saves serialize per field: one in flight, latest trailing edit follows (D2)", async () => {
    const { scheduler, fireAll } = makeScheduler();
    await mountReady(mkTask(1), scheduler);
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
    await mountReady(mkTask(1), scheduler);
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
    await mountReady(mkTask(1), scheduler);
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
    const { rerender } = await mountReady(mkTask(1), scheduler);
    draft().set("body", "mine");
    fireAll(600);
    editCalls[0].resolve();
    await tick();
    const epochBefore = draft().bodyEpoch;
    // Server echoes our own write back through SSE → task prop refresh.
    rerender(h(Harness, { task: mkTask(1, { body: "mine" }), scheduler }));
    await tick();
    expect(stateCalls.length).toBe(0); // the copy matches the acknowledged baseline: nothing to read
    expect(draft().external.body).toBeNull();
    expect(draft().body).toBe("mine");
    expect(draft().bodyEpoch).toBe(epochBefore); // no editor remount for own echo (D3/D4)
  });

  test("clean incoming change updates the draft and bumps bodyEpoch (D3)", async () => {
    const { scheduler } = makeScheduler();
    const { rerender } = await mountReady(mkTask(1), scheduler);
    rerender(h(Harness, { task: serverWrite(1, { body: "server v2" }), scheduler }));
    await serveReads();
    expect(draft().body).toBe("server v2");
    expect(draft().external.body).toBeNull();
    expect(draft().bodyEpoch).toBe(1);
  });

  test("dirty + conflicting incoming → both versions retained, autosave paused until resolution (D3)", async () => {
    const { scheduler, fireAll, pending } = makeScheduler();
    const { rerender } = await mountReady(mkTask(1), scheduler);
    draft().set("body", "local edit");
    rerender(h(Harness, { task: serverWrite(1, { body: "external edit" }), scheduler }));
    await serveReads();
    expect(draft().body).toBe("local edit"); // local retained
    expect(draft().external.body).toBe("external edit"); // external retained
    // Paused: firing every timer must not send the local text.
    fireAll();
    expect(editCalls.length).toBe(0);
    expect(pending.size).toBe(0);
  });

  test("Apply adopts the external text, cancels superseded pending work, bumps epoch (D3)", async () => {
    const { scheduler, fireAll } = makeScheduler();
    const { rerender } = await mountReady(mkTask(1), scheduler);
    draft().set("body", "local edit");
    rerender(h(Harness, { task: serverWrite(1, { body: "external edit" }), scheduler }));
    await serveReads();
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
    const { rerender } = await mountReady(mkTask(1), scheduler);
    draft().set("body", "local edit");
    rerender(h(Harness, { task: serverWrite(1, { body: "external edit" }), scheduler }));
    await serveReads();
    draft().keep("body");
    await tick();
    expect(draft().external.body).toBeNull();
    expect(editCalls.length).toBe(1);
    expect(editCalls[0].patch).toEqual({ body: "local edit" });
    editCalls[0].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
  });

  test("unmount flushes the old task's pending edit (D2 unmount-flush)", async () => {
    const { scheduler } = makeScheduler();
    const { unmount } = await mountReady(mkTask(7), scheduler);
    draft().set("title", "last keystroke");
    unmount();
    expect(editCalls.length).toBe(1);
    expect(editCalls[0].id).toBe(7);
    expect(editCalls[0].patch).toEqual({ title: "last keystroke" });
  });

  test("failed unmount-flush snapshot is recovered on remount and re-queued (D2 memory recovery)", async () => {
    const { scheduler } = makeScheduler();
    const first = await mountReady(mkTask(9, { body: "base" }), scheduler);
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
    expect(draft().body).toBe("unsaved work"); // shown while the baseline loads
    await serveReads();
    expect(draft().body).toBe("unsaved work");
    expect(draft().saveState).toBe("pending");
    next.fireAll(600);
    expect(editCalls.length).toBe(2);
    expect(editCalls[1].patch).toEqual({ body: "unsaved work" });
    expect(editCalls[1].guard).toEqual({ expected: { body: token(9, "body") } });
    editCalls[1].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
    expect(hasUnsavedDrafts()).toBe(false);
  });

  test("recovered snapshot against a MOVED server value surfaces a conflict, not a silent overwrite", async () => {
    const { scheduler } = makeScheduler();
    const first = await mountReady(mkTask(11, { body: "base" }), scheduler);
    draft().set("body", "my unsaved");
    first.unmount();
    editCalls[0].reject(new Error("down"));
    await tick();

    // Someone else moved the body while we were away.
    const moved = serverWrite(11, { body: "someone elses text" });
    const next = makeScheduler();
    render(h(Harness, { task: moved, scheduler: next.scheduler }));
    await serveReads();
    expect(draft().body).toBe("my unsaved");
    expect(draft().external.body).toBe("someone elses text");
    next.fireAll();
    expect(editCalls.length).toBe(1); // paused — no automatic overwrite
  });

  test("pruneTaskDrafts drops snapshots for deleted tasks", async () => {
    const { scheduler } = makeScheduler();
    const first = await mountReady(mkTask(13), scheduler);
    draft().set("body", "orphaned");
    first.unmount();
    editCalls[0].reject(new Error("down"));
    await tick();
    expect(hasUnsavedDrafts()).toBe(true);
    pruneTaskDrafts([1, 2, 3]); // 13 is gone
    expect(hasUnsavedDrafts()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Atomic baselines and guarded writes (plan @400 N8, Task 9)
// ---------------------------------------------------------------------------

describe("useTaskDraft guarded drafts (N8)", () => {
  beforeEach(() => {
    editCalls.length = 0;
    stateCalls.length = 0;
    legacyEdits.length = 0;
    shownErrors.length = 0;
    serverTasks.clear();
    draftRef = { current: null };
    pruneTaskDrafts([]);
  });

  test("editing is disabled until the atomic baseline (text + tokens) is known; the read seeds the text", async () => {
    const { scheduler, pending } = makeScheduler();
    serverPut(mkTask(1, { body: "snapshot body" }));
    serverWrite(1, { body: "fresh body" }); // newer than the list snapshot the prop came from
    render(h(Harness, { task: mkTask(1, { body: "snapshot body" }), scheduler }));
    await tick();
    expect(draft().ready).toBe(false);
    expect(draft().loadError).toBeNull();
    expect(draft().body).toBe("snapshot body"); // reading shows the snapshot meanwhile
    expect(stateCalls.map(c => c.id)).toEqual([1]);
    draft().set("body", "typed too early");
    expect(draft().body).toBe("snapshot body"); // ignored: no baseline yet
    expect(pending.size).toBe(0);
    await serveReads();
    expect(draft().ready).toBe(true);
    expect(draft().body).toBe("fresh body"); // text AND tokens came from the one atomic read
    expect(draft().saveState).toBe("saved");
    expect(draft().bodyEpoch).toBe(0); // no editor existed yet: nothing to replace
  });

  test("a failed baseline read keeps editing disabled with its reason; reload() reads again", async () => {
    const { scheduler } = makeScheduler();
    serverPut(mkTask(1));
    render(h(Harness, { task: mkTask(1), scheduler }));
    await tick();
    stateCalls.splice(0)[0].reject(new Error("daemon unreachable"));
    await tick();
    expect(draft().ready).toBe(false);
    expect(draft().loadError).toContain("daemon unreachable");
    draft().set("body", "typed");
    expect(draft().body).toBe("original body");
    draft().reload();
    expect(draft().loadError).toBeNull();
    await serveReads();
    expect(draft().ready).toBe(true);
    expect(draft().loadError).toBeNull();
  });

  test("every save is a versioned write guarded by that field's token; the ack's versions become the baseline", async () => {
    const { scheduler, fireAll } = makeScheduler();
    await mountReady(mkTask(1), scheduler);
    const body0 = token(1, "body");
    draft().set("body", "v1");
    fireAll(600);
    expect(editCalls[0].guard).toEqual({ expected: { body: body0 } });
    expect(legacyEdits).toEqual([]); // never the unguarded legacy write
    editCalls[0].resolve();
    await tick();
    const body1 = token(1, "body");
    expect(body1).not.toBe(body0);
    draft().set("body", "v2");
    fireAll(600);
    expect(editCalls[1].guard).toEqual({ expected: { body: body1 } });
    editCalls[1].resolve();
    await tick();
    // The title is guarded by its own token only.
    draft().set("title", "renamed");
    fireAll(600);
    expect(editCalls[2].guard).toEqual({ expected: { title: token(1, "title") } });
    editCalls[2].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
    expect(serverOf(1).task).toMatchObject({ title: "renamed", body: "v2" });
  });

  test("a 412 keeps BOTH versions: the incoming one is read atomically, nothing is overwritten or toasted", async () => {
    const { scheduler, fireAll } = makeScheduler();
    await mountReady(mkTask(1), scheduler);
    draft().set("body", "mine");
    fireAll(600);
    serverWrite(1, { body: "theirs" }); // the TUI saved the same field first
    editCalls[0].resolve(); // stale guard → 412
    await tick();
    expect(stateCalls.length).toBe(1); // the draft reads the incoming version
    await serveReads();
    expect(draft().body).toBe("mine");
    expect(draft().external.body).toBe("theirs");
    expect(draft().saveState).toBe("pending");
    expect(shownErrors).toEqual([]); // a conflict is not an error
    expect(serverOf(1).task.body).toBe("theirs"); // no silent overwrite
    fireAll();
    expect(editCalls.length).toBe(1); // paused until Apply / Keep
  });

  test("Apply after a 412 adopts the incoming version and its token", async () => {
    const { scheduler, fireAll } = makeScheduler();
    await mountReady(mkTask(1), scheduler);
    draft().set("body", "mine");
    fireAll(600);
    serverWrite(1, { body: "theirs" });
    editCalls[0].resolve();
    await serveReads();
    const epoch = draft().bodyEpoch;
    draft().apply("body");
    expect(draft().body).toBe("theirs");
    expect(draft().external.body).toBeNull();
    expect(draft().saveState).toBe("saved");
    expect(draft().bodyEpoch).toBe(epoch + 1);
    draft().set("body", "theirs, extended");
    fireAll(600);
    expect(editCalls[1].guard).toEqual({ expected: { body: token(1, "body") } });
    editCalls[1].resolve();
    await tick();
    expect(serverOf(1).task.body).toBe("theirs, extended");
  });

  test("Keep rebases on the DISPLAYED incoming token and writes conditionally, so it can conflict again", async () => {
    const { scheduler, fireAll } = makeScheduler();
    await mountReady(mkTask(1), scheduler);
    draft().set("body", "mine");
    fireAll(600);
    serverWrite(1, { body: "theirs" });
    const theirs = token(1, "body");
    editCalls[0].resolve();
    await serveReads();
    expect(draft().external.body).toBe("theirs");

    draft().keep("body");
    await tick();
    expect(editCalls[1].patch).toEqual({ body: "mine" });
    expect(editCalls[1].guard).toEqual({ expected: { body: theirs } });
    // Someone saved once more before our Keep landed: conflict again, with the newest version shown.
    serverWrite(1, { body: "theirs again" });
    editCalls[1].resolve();
    await serveReads();
    expect(draft().body).toBe("mine");
    expect(draft().external.body).toBe("theirs again");
    expect(serverOf(1).task.body).toBe("theirs again");

    draft().keep("body");
    await tick();
    expect(editCalls[2].guard).toEqual({ expected: { body: token(1, "body") } });
    editCalls[2].resolve();
    await tick();
    expect(serverOf(1).task.body).toBe("mine");
    expect(draft().external.body).toBeNull();
    expect(draft().saveState).toBe("saved");
  });

  test("unrelated metadata (status, tags, priority) never creates a title/body conflict", async () => {
    const { scheduler, fireAll } = makeScheduler();
    const { rerender } = await mountReady(mkTask(1), scheduler);
    const body0 = token(1, "body");
    draft().set("body", "dirty body");
    rerender(h(Harness, { task: serverWrite(1, { status: "blocked", tags: ["x"], priority: 2 }), scheduler }));
    await tick();
    expect(stateCalls.length).toBe(0); // title/body unchanged: nothing to reconcile
    fireAll(600);
    expect(editCalls[0].guard).toEqual({ expected: { body: body0 } });
    editCalls[0].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
    expect(draft().external).toEqual({ title: null, body: null });

    // A title change elsewhere makes the draft read the task while the body is dirty:
    // the read carries new title/status tokens but the SAME body token.
    draft().set("body", "dirty again");
    rerender(h(Harness, { task: serverWrite(1, { title: "renamed elsewhere", status: "review" }), scheduler }));
    await serveReads();
    expect(draft().title).toBe("renamed elsewhere"); // the clean title follows
    expect(draft().body).toBe("dirty again");
    expect(draft().external).toEqual({ title: null, body: null });
    fireAll(600);
    editCalls[1].resolve();
    await tick();
    expect(draft().saveState).toBe("saved");
    expect(serverOf(1).task).toMatchObject({ title: "renamed elsewhere", body: "dirty again", status: "review" });
  });

  test("a deferred stale read never reverts acknowledged text: a read one of our writes overtook is read again", async () => {
    const { scheduler, fireAll } = makeScheduler();
    const { rerender } = await mountReady(mkTask(1), scheduler);
    draft().set("body", "saved text");
    fireAll(600);
    // A title change elsewhere triggers a read while our body write is in flight.
    const renamed = serverWrite(1, { title: "renamed" });
    const beforeOurWrite = stateOf(1);
    rerender(h(Harness, { task: renamed, scheduler }));
    await tick();
    expect(stateCalls.length).toBe(1);
    editCalls[0].resolve(); // our write commits and acks
    await tick();
    expect(draft().saveState).toBe("saved");
    stateCalls.splice(0)[0].resolve(beforeOurWrite); // an answer that predates our write
    await tick();
    expect(draft().body).toBe("saved text"); // not reverted
    expect(draft().external.body).toBeNull();
    expect(stateCalls.length).toBe(1); // read again instead
    await serveReads();
    expect(draft().title).toBe("renamed");
    expect(draft().body).toBe("saved text");
    expect(draft().saveState).toBe("saved");
  });

  test("a read answered after a newer change arrived is dropped; the newest read wins", async () => {
    const { scheduler } = makeScheduler();
    const { rerender } = await mountReady(mkTask(1), scheduler);
    rerender(h(Harness, { task: serverWrite(1, { body: "external v1" }), scheduler }));
    await tick();
    expect(stateCalls.length).toBe(1);
    const v1 = stateOf(1);
    rerender(h(Harness, { task: serverWrite(1, { body: "external v2" }), scheduler }));
    await tick();
    expect(stateCalls.length).toBe(1); // one read in flight at a time
    stateCalls.splice(0)[0].resolve(v1); // older than the copy we already hold
    await tick();
    expect(draft().body).toBe("original body");
    expect(stateCalls.length).toBe(1);
    await serveReads();
    expect(draft().body).toBe("external v2");
  });

  test("an external change while our save is in flight is kept as a conflict, never replacing typing", async () => {
    const { scheduler, fireAll } = makeScheduler();
    const { rerender } = await mountReady(mkTask(1), scheduler);
    draft().set("body", "mine");
    fireAll(600);
    draft().set("body", "mine, more");
    rerender(h(Harness, { task: serverWrite(1, { body: "theirs" }), scheduler }));
    await serveReads();
    expect(draft().body).toBe("mine, more");
    expect(draft().external.body).toBe("theirs");
    editCalls[0].resolve(); // committed after theirs → 412
    await serveReads();
    expect(draft().body).toBe("mine, more");
    expect(draft().external.body).toBe("theirs");
    expect(serverOf(1).task.body).toBe("theirs");
    expect(editCalls.length).toBe(1);
  });

  test("Keep chosen while a save is still in flight waits for its answer, then writes over the version shown", async () => {
    const { scheduler, fireAll } = makeScheduler();
    const { rerender } = await mountReady(mkTask(1), scheduler);
    draft().set("body", "mine");
    fireAll(600);
    rerender(h(Harness, { task: serverWrite(1, { body: "theirs" }), scheduler }));
    await serveReads();
    expect(draft().external.body).toBe("theirs");
    const theirs = token(1, "body");
    draft().keep("body"); // our write is still in flight: decided once it settles
    expect(editCalls.length).toBe(1);
    editCalls[0].resolve(); // theirs committed first → 412
    await serveReads();
    expect(editCalls.length).toBe(2);
    expect(editCalls[1].patch).toEqual({ body: "mine" });
    expect(editCalls[1].guard).toEqual({ expected: { body: theirs } });
    editCalls[1].resolve();
    await tick();
    expect(serverOf(1).task.body).toBe("mine");
    expect(draft().external.body).toBeNull();
    expect(draft().saveState).toBe("saved");
  });

  test("Keep chosen while a save that then SUCCEEDS is in flight still writes ours over the newer version", async () => {
    const { scheduler, fireAll } = makeScheduler();
    const { rerender } = await mountReady(mkTask(1), scheduler);
    draft().set("body", "mine");
    fireAll(600);
    const answer = editCalls[0].commit(); // ours commits first…
    rerender(h(Harness, { task: serverWrite(1, { body: "theirs" }), scheduler })); // …theirs right after
    const theirs = token(1, "body");
    await serveReads();
    expect(draft().external.body).toBe("theirs");
    draft().keep("body");
    answer(); // our (older) acknowledgement arrives last
    await serveReads();
    expect(editCalls.length).toBe(2); // the Keep is not lost behind the stale ack
    expect(editCalls[1].guard).toEqual({ expected: { body: theirs } });
    editCalls[1].resolve();
    await tick();
    expect(serverOf(1).task.body).toBe("mine");
    expect(draft().external.body).toBeNull();
    expect(draft().saveState).toBe("saved");
  });

  test("a Keep deferred behind an in-flight save never overwrites a NEWER version it did not show", async () => {
    const { scheduler, fireAll } = makeScheduler();
    const { rerender } = await mountReady(mkTask(1), scheduler);
    draft().set("body", "mine");
    fireAll(600);
    rerender(h(Harness, { task: serverWrite(1, { body: "theirs" }), scheduler }));
    await serveReads();
    draft().keep("body");
    serverWrite(1, { body: "theirs, newer" }); // lands before our write is answered
    editCalls[0].resolve(); // 412
    await serveReads();
    expect(editCalls.length).toBe(1); // nothing sent over a version the user never saw
    expect(draft().external.body).toBe("theirs, newer");
    expect(draft().body).toBe("mine");
    expect(serverOf(1).task.body).toBe("theirs, newer");
  });

  test("a 412 whose read finds our own base text (changed and changed back) re-sends once with the new token", async () => {
    const { scheduler, fireAll } = makeScheduler();
    await mountReady(mkTask(1), scheduler);
    draft().set("body", "mine");
    fireAll(600);
    serverWrite(1, { body: "briefly different" });
    serverWrite(1, { body: "original body" });
    editCalls[0].resolve(); // 412: the token moved though the text is what we edited against
    await serveReads();
    expect(editCalls.length).toBe(2);
    expect(editCalls[1].guard).toEqual({ expected: { body: token(1, "body") } });
    editCalls[1].resolve();
    await tick();
    expect(serverOf(1).task.body).toBe("mine");
    expect(draft().external.body).toBeNull();
    expect(draft().saveState).toBe("saved");
  });

  test("anchor 409s and other failures stay errors, distinct from version conflicts", async () => {
    const { scheduler, fireAll } = makeScheduler();
    await mountReady(mkTask(1), scheduler);
    draft().set("body", "x");
    fireAll(600);
    editCalls[0].reject(new HttpError(409, "body-search anchor matched 2 times", "body_search_ambiguous", 2));
    await tick();
    expect(draft().saveState).toBe("error");
    expect(draft().external.body).toBeNull();
    expect(stateCalls.length).toBe(0); // not treated as a conflict: nothing to read
    expect(shownErrors.length).toBe(1);
  });

  test("a baseline read answered after unmount is ignored", async () => {
    const { scheduler } = makeScheduler();
    serverPut(mkTask(1));
    const view = render(h(Harness, { task: mkTask(1), scheduler }));
    await tick();
    const ref = draft();
    view.unmount();
    stateCalls.splice(0)[0].resolve();
    await tick();
    expect(ref.ready).toBe(false);
    expect(editCalls.length).toBe(0);
    expect(hasUnsavedDrafts()).toBe(false);
  });
});
