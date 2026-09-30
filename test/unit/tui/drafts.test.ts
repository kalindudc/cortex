import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { HttpError, TransportError } from "../../../src/api.ts";
import type {
  CortexClient,
  DaemonIdentity,
  EditTaskRequest,
  TaskStateSnapshot,
  TaskWriteResult,
  Versions,
  WorkspaceSnapshot,
  WriteGuard,
} from "../../../src/contracts.ts";
import type { Lane, Task } from "../../../src/store.ts";
import { DEFAULT_CONFIG } from "../../../src/tui/config.ts";
import {
  createTaskDraft,
  type DraftField,
  IDLE_MS,
  MAX_MS,
  type Scheduler,
  type TaskDraft,
} from "../../../src/tui/drafts.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";
import { openPreferences } from "../../../src/tui/preferences.ts";
import { type OverlayHost, TuiSession } from "../../../src/tui/session.ts";
import { resolveTheme } from "../../../src/tui/theme.ts";

// Plan @400 N8/N16 (Task 9): the per-task draft controller, with an injected
// scheduler and GUARDED writes:
//   - 600 ms idle / 3 s maximum timers; per field ONE write in flight and ONE
//     trailing write carrying the latest text;
//   - "saved" only when the CURRENT text was acknowledged (never merely
//     dispatched, never a stale completion); retries keep newer typing;
//   - every write sends the field's expected token; a 412 keeps BOTH versions
//     as a conflict; Apply adopts the incoming version; Keep rebases on the
//     displayed incoming token and writes conditionally again;
//   - unrelated metadata never creates a body conflict.
// Then the session's quit guards and dirty-deletion handling.

// ---------- a daemon stand-in with real per-field tokens ----------

const task = (id: number, over: Partial<Task> = {}): Task => ({
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

interface PendingWrite {
  id: number;
  request: EditTaskRequest;
  guard: WriteGuard | undefined;
  resolve: (result: TaskWriteResult) => void;
  reject: (err: Error) => void;
}

/** One task on a "server" that bumps a field's token only when its value changes (like the store). */
function fakeServer(initial: Task = task(1)) {
  const current = structuredClone(initial);
  let n = 0;
  const versions: Versions = {
    entity: "e-0",
    title: "title-0",
    body: "body-0",
    priority: "p-0",
    lane: "l-0",
    status: "s-0",
  };
  const writes: PendingWrite[] = [];
  const stateAnswers: ((snap: TaskStateSnapshot) => void)[] = [];
  let deferStates = false;
  let stateCalls = 0;
  const bump = (scopes: (keyof Versions)[]) => {
    n++;
    for (const scope of scopes) versions[scope] = `${scope}-${n}`;
  };
  const snapshot = (): TaskStateSnapshot => ({
    task: structuredClone(current),
    updates: [],
    versions: { ...versions },
    cursor: `e:${n}`,
  });
  const apply = (fields: Partial<Pick<Task, "title" | "body" | "status" | "priority" | "tags">>) => {
    const scopes: (keyof Versions)[] = ["entity"];
    for (const [key, value] of Object.entries(fields) as [keyof typeof fields, unknown][]) {
      if (JSON.stringify(current[key]) === JSON.stringify(value)) continue;
      (current as unknown as Record<string, unknown>)[key] = value;
      if (key !== "tags") scopes.push(key as keyof Versions);
    }
    bump(scopes);
  };
  /** Commit (guard-checked, like the store) a pending write now; the returned function delivers its answer. */
  const commit = (index: number): (() => void) => {
    const w = writes.splice(index, 1)[0];
    if (w === undefined) throw new Error("no pending write");
    const stale = Object.entries(w.guard?.expected ?? {}).filter(
      ([scope, token]) => versions[scope as keyof Versions] !== token,
    );
    if (stale.length > 0) {
      const err = new HttpError(412, "version conflict", "version_conflict", undefined, {
        kind: "task",
        key: w.id,
        mismatches: stale.map(([scope, expected]) => ({
          scope: scope as keyof Versions,
          expected: expected as string,
          current: versions[scope as keyof Versions] ?? "",
        })),
        current: { ...versions },
      });
      return () => w.reject(err);
    }
    apply(w.request as Partial<Task>);
    const result: TaskWriteResult = { task: structuredClone(current), versions: { ...versions }, replayed: false };
    return () => w.resolve(result);
  };
  const client = {
    taskState: (_id: number) => {
      stateCalls++;
      if (!deferStates) return Promise.resolve(snapshot());
      return new Promise<TaskStateSnapshot>(resolve => stateAnswers.push(resolve));
    },
    versioned: {
      editTask: (id: number, request: EditTaskRequest, guard?: WriteGuard) =>
        new Promise<TaskWriteResult>((resolve, reject) => writes.push({ id, request, guard, resolve, reject })),
    },
  } as unknown as CortexClient;
  return {
    client,
    writes,
    versions,
    current: () => current,
    snapshot,
    stateCalls: () => stateCalls,
    /** Hold taskState answers until answerStates() (to race them against writes). */
    deferStates(on: boolean) {
      deferStates = on;
    },
    answerStates(snap: TaskStateSnapshot = snapshot()) {
      for (const answer of stateAnswers.splice(0)) answer(snap);
    },
    /** Commit the oldest pending write now, but answer it only when the returned function runs. */
    commit(index = 0): () => void {
      return commit(index);
    },
    /** Commit (guard-checked, like the store) and answer the oldest pending write. */
    ack(index = 0) {
      commit(index)();
    },
    fail(index = 0, error: Error = new HttpError(500, "database is locked")) {
      const w = writes.splice(index, 1)[0];
      if (w === undefined) throw new Error("no pending write");
      w.reject(error);
    },
    /** Another writer (the CLI, another TUI): committed at once. */
    external(fields: Partial<Pick<Task, "title" | "body" | "status" | "priority" | "tags">>) {
      apply(fields);
    },
  };
}

interface Timer {
  fn: () => void;
  ms: number;
}
function makeScheduler(): { scheduler: Scheduler; pending: Map<number, Timer>; fire: (ms?: number) => void } {
  const pending = new Map<number, Timer>();
  let next = 0;
  return {
    scheduler: {
      schedule: (fn, ms) => {
        const id = next++;
        pending.set(id, { fn, ms });
        return id;
      },
      clear: id => {
        pending.delete(id as number);
      },
    },
    pending,
    fire: (ms?: number) => {
      for (const [id, t] of [...pending]) {
        if (ms === undefined || t.ms === ms) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
};

function setup(initial: Task = task(1)) {
  const server = fakeServer(initial);
  const timers = makeScheduler();
  const replaced: DraftField[] = [];
  let changes = 0;
  const draft = createTaskDraft(server.snapshot(), server.client, timers.scheduler, {
    onChange: () => changes++,
    onReplace: field => replaced.push(field),
  });
  return { server, timers, draft, replaced, changes: () => changes };
}

// ---------- the controller ----------

describe("createTaskDraft: state and timers (ported from useAutosave/useTaskDraft)", () => {
  test("the initial state mirrors the TaskState; clean means saved", () => {
    const { draft } = setup();
    expect(draft.taskId).toBe(1);
    expect(draft.text("title")).toBe("task 1");
    expect(draft.text("body")).toBe("original body");
    expect(draft.state("title")).toBe("saved");
    expect(draft.state("body")).toBe("saved");
    expect(draft.saveState).toBe("saved");
    expect(draft.incoming("body")).toBeNull();
    expect(draft.unsaved()).toEqual([]);
  });

  test("set('title') normalizes newlines and goes pending; nothing is sent before a timer fires", () => {
    const { draft, server, timers } = setup();
    draft.set("title", "multi\nline\n\ntitle");
    expect(draft.text("title")).toBe("multi line title");
    expect(draft.state("title")).toBe("pending");
    expect(server.writes.length).toBe(0);
    expect([...timers.pending.values()].map(t => t.ms).sort((a, b) => a - b)).toEqual([IDLE_MS, MAX_MS]);
    expect(IDLE_MS).toBe(600);
    expect(MAX_MS).toBe(3000);
  });

  test("the idle timer sends ONE guarded write (the field's expected token, no receipt); its ack is saved", async () => {
    const { draft, server, timers } = setup();
    draft.set("title", "renamed");
    timers.fire(IDLE_MS);
    expect(draft.state("title")).toBe("saving");
    expect(server.writes.length).toBe(1);
    expect(server.writes[0]?.request).toEqual({ title: "renamed" });
    expect(server.writes[0]?.guard).toEqual({ expected: { title: "title-0" } });
    expect(timers.pending.size).toBe(0);
    server.ack();
    await tick();
    expect(draft.state("title")).toBe("saved");
    // The next write is guarded by the token the ack returned.
    draft.set("title", "renamed again");
    timers.fire(IDLE_MS);
    expect(server.writes[0]?.guard).toEqual({ expected: { title: server.versions.title } });
  });

  test("the 3 s maximum fires for a continuous typist whose idle timer keeps resetting", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "a");
    draft.set("body", "ab");
    draft.set("body", "abc");
    expect([...timers.pending.values()].map(t => t.ms).sort((a, b) => a - b)).toEqual([IDLE_MS, MAX_MS]);
    timers.fire(MAX_MS);
    expect(server.writes.length).toBe(1);
    expect(server.writes[0]?.request).toEqual({ body: "abc" });
    expect(timers.pending.size).toBe(0);
  });

  test("an empty body is sent as null (web parity)", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "");
    timers.fire(IDLE_MS);
    expect(server.writes[0]?.request).toEqual({ body: null });
    server.ack();
    await tick();
    expect(draft.state("body")).toBe("saved");
  });

  test("saves serialize per field: one in flight, then ONE trailing write with the latest text and the new token", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "v1");
    timers.fire(IDLE_MS);
    draft.set("body", "v2");
    timers.fire(IDLE_MS);
    draft.set("body", "v3");
    timers.fire(IDLE_MS);
    expect(server.writes.length).toBe(1);
    server.ack();
    await tick();
    expect(server.writes.length).toBe(1);
    expect(server.writes[0]?.request).toEqual({ body: "v3" });
    expect(server.writes[0]?.guard).toEqual({ expected: { body: server.versions.body } });
    server.ack();
    await tick();
    expect(draft.state("body")).toBe("saved");
    expect(server.current().body).toBe("v3");
  });

  test("a stale completion never labels newer text saved", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "old");
    timers.fire(IDLE_MS);
    draft.set("body", "newer text");
    server.ack();
    await tick();
    expect(draft.state("body")).not.toBe("saved");
    expect(server.writes.at(-1)?.request).toEqual({ body: "newer text" });
  });

  test("a failed save is 'failed' with its reason; newer typing is kept and retry() sends the LATEST text", async () => {
    const { draft, server, timers } = setup();
    draft.set("title", "will fail");
    timers.fire(IDLE_MS);
    server.fail();
    await tick();
    expect(draft.state("title")).toBe("failed");
    expect(draft.error("title")).toMatch(/database is locked/);
    draft.set("title", "will fail, then more");
    timers.pending.clear(); // the user retries before the timers
    const retried = draft.retry();
    expect(draft.state("title")).toBe("retrying");
    expect(server.writes[0]?.request).toEqual({ title: "will fail, then more" });
    server.ack();
    await retried;
    expect(draft.state("title")).toBe("saved");
    expect(server.current().title).toBe("will fail, then more");
  });

  test("an uncertain transport failure says it may have applied; the guarded retry then converges", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "maybe");
    timers.fire(IDLE_MS);
    // The write committed but the answer was lost.
    const w = server.writes[0];
    server.ack();
    await tick();
    expect(draft.state("body")).toBe("saved");
    void w;
    const lost = setup();
    lost.draft.set("body", "maybe");
    lost.timers.fire(IDLE_MS);
    lost.server.external({ body: "maybe" }); // applied...
    lost.server.fail(0, new TransportError("timeout", "PATCH", "/api/tasks/1", "timed out")); // ...answer lost
    await tick();
    expect(lost.draft.state("body")).toBe("failed");
    expect(lost.draft.error("body")).toMatch(/may have applied/);
    const retry = lost.draft.retry();
    lost.server.ack(); // 412: the token moved; the daemon has exactly our text
    await retry;
    expect(lost.draft.state("body")).toBe("saved");
    expect(lost.draft.incoming("body")).toBeNull();
  });

  test("flush() sends at once and resolves once the CURRENT text is acknowledged", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "flush me");
    draft.set("title", "and me");
    const flushed = draft.flush();
    expect(timers.pending.size).toBe(0);
    expect(server.writes.map(w => w.request)).toEqual([{ title: "and me" }, { body: "flush me" }]);
    let done = false;
    void flushed.then(() => {
      done = true;
    });
    server.ack();
    await tick();
    expect(done).toBe(false);
    server.ack();
    await flushed;
    expect(draft.saveState).toBe("saved");
    expect(draft.unsaved()).toEqual([]);
  });

  test("discard() cancels pending work: nothing is sent afterwards", () => {
    const { draft, server, timers } = setup();
    draft.set("body", "dropped");
    draft.discard();
    timers.fire();
    void draft.flush();
    expect(server.writes.length).toBe(0);
  });

  test("a write in flight at discard() settles WITHOUT being acknowledged: the kept copy stays unsaved (review F3)", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "kept words");
    timers.fire(IDLE_MS);
    expect(draft.state("body")).toBe("saving");
    const answer = server.commit(); // the daemon applied it; its answer arrives after the discard
    draft.discard();
    answer();
    await tick();
    expect(draft.text("body")).toBe("kept words");
    expect(draft.base("body")).toBe("original body");
    expect(draft.state("body")).toBe("pending");
    expect(draft.unsaved()).toEqual(["body"]);
    expect(server.writes.length).toBe(0); // and nothing more is sent
  });

  test("a read-back of the write in flight before discard() never makes the kept copy saved either (review F3)", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "kept words");
    timers.fire(IDLE_MS);
    const answer = server.commit();
    draft.receive(server.snapshot()); // our in-flight text, read back before its answer
    draft.discard();
    answer();
    await tick();
    expect(draft.state("body")).toBe("pending");
    expect(draft.unsaved()).toEqual(["body"]);
    draft.apply("body"); // inert once discarded
    draft.receive(server.snapshot());
    expect(draft.unsaved()).toEqual(["body"]);
  });
});

describe("createTaskDraft: reconciliation and conflicts (guarded, N8)", () => {
  test("our own echo converges without a false conflict or a replacement", async () => {
    const { draft, server, timers, replaced } = setup();
    draft.set("body", "mine");
    timers.fire(IDLE_MS);
    server.ack();
    await tick();
    draft.receive(server.snapshot());
    expect(draft.incoming("body")).toBeNull();
    expect(draft.text("body")).toBe("mine");
    expect(draft.state("body")).toBe("saved");
    expect(replaced).toEqual([]);
  });

  test("a clean incoming change is adopted (text and token) and reported as a replacement", async () => {
    const { draft, server, timers, replaced } = setup();
    server.external({ body: "server v2" });
    draft.receive(server.snapshot());
    expect(draft.text("body")).toBe("server v2");
    expect(draft.state("body")).toBe("saved");
    expect(replaced).toEqual(["body"]);
    draft.set("body", "server v2 + mine");
    timers.fire(IDLE_MS);
    expect(server.writes[0]?.guard).toEqual({ expected: { body: server.versions.body } });
  });

  test("unrelated metadata never creates a body conflict, even while the body is dirty", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "my unsaved body");
    server.external({ status: "review", priority: 2, tags: ["x"] });
    draft.receive(server.snapshot());
    expect(draft.state("body")).toBe("pending");
    expect(draft.incoming("body")).toBeNull();
    timers.fire(IDLE_MS);
    server.ack();
    await tick();
    expect(draft.state("body")).toBe("saved");
    expect(server.current().body).toBe("my unsaved body");
  });

  test("dirty + conflicting incoming: BOTH versions are kept and autosave pauses", () => {
    const { draft, server, timers } = setup();
    draft.set("body", "local edit");
    server.external({ body: "external edit" });
    draft.receive(server.snapshot());
    expect(draft.text("body")).toBe("local edit");
    expect(draft.incoming("body")).toBe("external edit");
    expect(draft.state("body")).toBe("conflict");
    expect(draft.saveState).toBe("conflict");
    timers.fire();
    expect(server.writes.length).toBe(0);
    expect(timers.pending.size).toBe(0);
    // Typing during the conflict is kept but not sent.
    draft.set("body", "local edit, more");
    timers.fire();
    expect(server.writes.length).toBe(0);
  });

  test("a 412 from a stale token keeps both versions: the incoming text is read, nothing is overwritten", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "mine");
    timers.fire(IDLE_MS);
    server.external({ body: "theirs" }); // lands before our write
    server.ack(); // -> 412
    await tick();
    expect(draft.state("body")).toBe("conflict");
    expect(draft.text("body")).toBe("mine");
    expect(draft.incoming("body")).toBe("theirs");
    expect(server.current().body).toBe("theirs");
    expect(server.writes.length).toBe(0);
  });

  test("Apply adopts the incoming version, cancels superseded work, and later edits write against it", async () => {
    const { draft, server, timers, replaced } = setup();
    draft.set("body", "local edit");
    server.external({ body: "external edit" });
    draft.receive(server.snapshot());
    draft.apply("body");
    expect(draft.text("body")).toBe("external edit");
    expect(draft.incoming("body")).toBeNull();
    expect(draft.state("body")).toBe("saved");
    expect(replaced).toEqual(["body"]);
    timers.fire();
    expect(server.writes.length).toBe(0);
    draft.set("body", "external edit, extended");
    timers.fire(IDLE_MS);
    server.ack();
    await tick();
    expect(draft.state("body")).toBe("saved");
    expect(server.current().body).toBe("external edit, extended");
  });

  test("Keep rebases on the DISPLAYED incoming token and writes conditionally, so it can conflict again", async () => {
    const { draft, server } = setup();
    draft.set("body", "mine");
    server.external({ body: "theirs" });
    draft.receive(server.snapshot());
    const shownToken = server.versions.body;
    const kept = draft.keep("body");
    expect(server.writes[0]?.request).toEqual({ body: "mine" });
    expect(server.writes[0]?.guard).toEqual({ expected: { body: shownToken } });
    // A third writer lands before our write: conflict again, now showing the newest text.
    server.external({ body: "third" });
    server.ack();
    await kept;
    expect(draft.state("body")).toBe("conflict");
    expect(draft.incoming("body")).toBe("third");
    expect(server.current().body).toBe("third");
    const again = draft.keep("body");
    server.ack();
    await again;
    expect(draft.state("body")).toBe("saved");
    expect(server.current().body).toBe("mine");
  });

  test("an old-base undo followed by Keep writes against the INCOMING revision", async () => {
    const { draft, server } = setup();
    draft.set("body", "my edit");
    server.external({ body: "their edit" });
    draft.receive(server.snapshot());
    const incomingToken = server.versions.body;
    // Undo in the editor brings the text back to the OLD base.
    draft.set("body", "original body");
    const kept = draft.keep("body");
    expect(server.writes.length).toBe(1);
    expect(server.writes[0]?.request).toEqual({ body: "original body" });
    expect(server.writes[0]?.guard).toEqual({ expected: { body: incomingToken } });
    server.ack();
    await kept;
    expect(draft.state("body")).toBe("saved");
    expect(server.current().body).toBe("original body");
  });

  test("Keep chosen while a save is still in flight waits for its answer (412), then writes over the version shown", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "mine");
    timers.fire(IDLE_MS);
    server.external({ body: "theirs" }); // lands before our write
    draft.receive(server.snapshot());
    expect(draft.incoming("body")).toBe("theirs");
    const shownToken = server.versions.body;
    const kept = draft.keep("body"); // our write is still in flight: decided once it answers
    expect(server.writes.length).toBe(1);
    server.ack(); // 412
    await tick();
    expect(server.writes.length).toBe(1);
    expect(server.writes[0]?.request).toEqual({ body: "mine" });
    expect(server.writes[0]?.guard).toEqual({ expected: { body: shownToken } });
    server.ack();
    await kept;
    expect(server.current().body).toBe("mine");
    expect(draft.incoming("body")).toBeNull();
    expect(draft.state("body")).toBe("saved");
  });

  test("Keep chosen while a save that then SUCCEEDS is in flight still writes ours over the version shown", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "mine");
    timers.fire(IDLE_MS);
    const answer = server.commit(); // ours commits first…
    server.external({ body: "theirs" }); // …theirs right after
    const shownToken = server.versions.body;
    draft.receive(server.snapshot()); // shown while our write is still unanswered
    expect(draft.incoming("body")).toBe("theirs");
    const kept = draft.keep("body");
    answer(); // our (older) acknowledgement arrives last
    await tick();
    expect(server.writes.length).toBe(1); // the Keep is not lost behind the stale ack
    expect(server.writes[0]?.request).toEqual({ body: "mine" });
    expect(server.writes[0]?.guard).toEqual({ expected: { body: shownToken } });
    expect(draft.state("body")).toBe("saving"); // never 'saved' while the daemon holds theirs
    server.ack();
    await kept;
    expect(server.current().body).toBe("mine");
    expect(draft.incoming("body")).toBeNull();
    expect(draft.state("body")).toBe("saved");
  });

  test("a Keep deferred behind an in-flight save never overwrites a NEWER version it did not show (412)", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "mine");
    timers.fire(IDLE_MS);
    server.external({ body: "theirs" });
    draft.receive(server.snapshot());
    const kept = draft.keep("body");
    server.external({ body: "theirs, newer" }); // lands before our write is answered
    server.ack(); // 412
    await kept;
    expect(server.writes.length).toBe(0); // nothing sent over a version the user never saw
    expect(draft.state("body")).toBe("conflict");
    expect(draft.incoming("body")).toBe("theirs, newer");
    expect(draft.text("body")).toBe("mine");
    expect(server.current().body).toBe("theirs, newer");
  });

  test("a Keep deferred behind a save that SUCCEEDS re-decides when a newer version is shown meanwhile", async () => {
    const { draft, server, timers, replaced } = setup();
    draft.set("body", "mine");
    timers.fire(IDLE_MS);
    const answer = server.commit();
    server.external({ body: "theirs" });
    draft.receive(server.snapshot());
    const kept = draft.keep("body");
    server.external({ body: "theirs, newer" });
    draft.receive(server.snapshot()); // now showing a version Keep was not chosen over
    answer();
    await kept;
    expect(server.writes.length).toBe(0);
    expect(draft.state("body")).toBe("conflict");
    expect(draft.incoming("body")).toBe("theirs, newer");
    expect(draft.text("body")).toBe("mine"); // never replaced behind the user's back
    expect(replaced).toEqual([]);
    expect(server.current().body).toBe("theirs, newer");
  });

  test("an incoming text equal to our base with a new token (A→B→A) rebases the token silently", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "mine");
    server.external({ body: "B" });
    server.external({ body: "original body" });
    draft.receive(server.snapshot());
    expect(draft.state("body")).toBe("pending");
    timers.fire(IDLE_MS);
    expect(server.writes[0]?.guard).toEqual({ expected: { body: server.versions.body } });
    server.ack();
    await tick();
    expect(draft.state("body")).toBe("saved");
  });

  test("title and body are independent: a body conflict never blocks a title save; each guard names only its field", async () => {
    const { draft, server, timers } = setup();
    draft.set("body", "my body");
    server.external({ body: "their body" });
    draft.receive(server.snapshot());
    draft.set("title", "my title");
    timers.fire(IDLE_MS);
    expect(server.writes.map(w => [w.request, w.guard])).toEqual([
      [{ title: "my title" }, { expected: { title: "title-0" } }],
    ]);
    server.ack();
    await tick();
    expect(draft.state("title")).toBe("saved");
    expect(draft.state("body")).toBe("conflict");
    expect(draft.unsaved()).toEqual(["body"]);
  });

  test("refresh() reads the TaskState, and drops an answer that one of our writes overtook", async () => {
    const { draft, server, timers } = setup();
    server.deferStates(true);
    const refreshed = draft.refresh(); // asked BEFORE our write
    const stale = server.snapshot();
    draft.set("body", "saved after the read");
    timers.fire(IDLE_MS);
    server.ack();
    await tick();
    expect(draft.state("body")).toBe("saved");
    server.answerStates(stale); // the old answer arrives after our ack: never applied
    await tick();
    expect(draft.text("body")).toBe("saved after the read");
    server.answerStates(); // the re-read
    await refreshed;
    expect(draft.text("body")).toBe("saved after the read");
    expect(draft.state("body")).toBe("saved");
    expect(server.stateCalls()).toBe(2);
  });
});

// ---------- the session: quit guards and dirty deletion ----------

const DB = "0b6a2f4e-0c1d-4e5f-8a9b-1c2d3e4f5a6b";
const IDENTITY: DaemonIdentity = {
  protocol: 1,
  instanceId: "instance-1",
  databaseId: DB,
  databasePath: "/tmp/cortex.db",
  endpoint: { kind: "unix", socketPath: "/tmp/cortex-x.sock" },
  pid: 4242,
};
const LANES: Lane[] = [{ name: "now", color: null, sort: 0 }];

/** Several tasks, token-bumping writes (answered at once unless held), and the live stream. */
function fakeDaemon(tasks: Task[]) {
  const server = new Map<number, Task>(tasks.map(t => [t.id, structuredClone(t)]));
  const versions = new Map<number, Versions>(
    tasks.map(t => [t.id, { entity: `e${t.id}`, title: `t${t.id}`, body: `b${t.id}`, status: `s${t.id}` }]),
  );
  let n = 0;
  let seq = 1;
  let session: TuiSession | null = null;
  let held: (() => void)[] | null = null;
  let stateFailure: Error | null = null;
  let heldStates: (() => void)[] | null = null;
  const failures: Error[] = [];
  let heldAnswers: (() => void)[] | null = null;
  const calls: { name: string; args: unknown[] }[] = [];
  const publish = (kind: "task.updated" | "task.removed", payload: unknown) =>
    session?.receive({ kind, cursor: `e:${++seq}`, payload });
  const mustTask = (id: number): Task => {
    const t = server.get(id);
    if (!t) throw new HttpError(404, `task ${id} not found`);
    return t;
  };
  const tokens = (id: number): Versions => versions.get(id) ?? {};
  const change = (id: number, fields: Partial<Task>) => {
    const t = mustTask(id);
    const v = tokens(id);
    n++;
    v.entity = `e${id}-${n}`;
    for (const [key, value] of Object.entries(fields)) {
      if (JSON.stringify((t as unknown as Record<string, unknown>)[key]) === JSON.stringify(value)) continue;
      (t as unknown as Record<string, unknown>)[key] = value;
      if (key === "title" || key === "body" || key === "status") v[key] = `${key[0]}${id}-${n}`;
    }
    publish("task.updated", structuredClone(t));
  };
  const client = {
    workspace: async (): Promise<WorkspaceSnapshot> => ({
      identity: IDENTITY,
      cursor: `e:${seq}`,
      tasks: [...server.values()].map(t => structuredClone(t)),
      lanes: LANES,
      tags: [],
      notifications: [],
    }),
    taskState: async (id: number): Promise<TaskStateSnapshot> => {
      calls.push({ name: "taskState", args: [id] });
      if (heldStates !== null) await new Promise<void>(resolve => heldStates?.push(resolve));
      if (stateFailure !== null) throw stateFailure;
      return { task: structuredClone(mustTask(id)), updates: [], versions: { ...tokens(id) }, cursor: `e:${seq}` };
    },
    versioned: {
      editTask: async (id: number, request: EditTaskRequest, guard?: WriteGuard): Promise<TaskWriteResult> => {
        calls.push({ name: "editTask", args: [id, request, guard] });
        if (held !== null) await new Promise<void>(resolve => held?.push(resolve));
        const failure = failures.shift();
        if (failure) throw failure;
        const t = mustTask(id);
        for (const [scope, expected] of Object.entries(guard?.expected ?? {})) {
          if (tokens(id)[scope as keyof Versions] !== expected) {
            throw new HttpError(412, "version conflict", "version_conflict", undefined, {
              kind: "task",
              key: id,
              mismatches: [],
              current: { ...tokens(id) },
            });
          }
        }
        change(id, request as Partial<Task>);
        const result = { task: structuredClone(t), versions: { ...tokens(id) }, replayed: false };
        // Committed (and published) now; answered only on releaseAnswers().
        if (heldAnswers !== null) await new Promise<void>(resolve => heldAnswers?.push(resolve));
        return result;
      },
      removeTask: async (id: number, guard?: WriteGuard) => {
        calls.push({ name: "removeTask", args: [id, guard] });
        mustTask(id);
        server.delete(id);
        publish("task.removed", { id });
        return { ok: true, replayed: false };
      },
    },
  };
  return {
    client: client as unknown as CortexClient,
    calls,
    server,
    edits: () => calls.filter(c => c.name === "editTask"),
    /** Another writer (committed and published at once). */
    external: (id: number, fields: Partial<Task>) => change(id, fields),
    removeElsewhere: (id: number) => {
      server.delete(id);
      publish("task.removed", { id });
    },
    hold: () => {
      held = [];
    },
    release: () => {
      const waiting = held ?? [];
      held = null;
      for (const resume of waiting) resume();
    },
    holdAnswers: () => {
      heldAnswers = [];
    },
    releaseAnswers: () => {
      const waiting = heldAnswers ?? [];
      heldAnswers = null;
      for (const resume of waiting) resume();
    },
    failNext: (error: Error) => void failures.push(error),
    failStates: (error: Error | null) => {
      stateFailure = error;
    },
    /** TaskState reads wait (a slow baseline) until releaseStates(). */
    holdStates: () => {
      heldStates = [];
    },
    releaseStates: () => {
      const waiting = heldStates ?? [];
      heldStates = null;
      for (const resume of waiting) resume();
    },
    attach: (s: TuiSession) => {
      session = s;
    },
  };
}

function fakeHost(): OverlayHost {
  return {
    columns: () => 100,
    rows: () => 30,
    showOverlay: (_component: Component): OverlayHandle => ({
      hide: () => {},
      setHidden: () => {},
      isHidden: () => false,
      focus: () => {},
      unfocus: () => {},
      isFocused: () => true,
      getBounds: () => undefined,
    }),
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-drafts-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function sessionWith(tasks: Task[] = [task(1), task(2, { title: "second", body: "second body" })]) {
  const daemon = fakeDaemon(tasks);
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const quits: boolean[] = [];
  const session = new TuiSession({
    client: daemon.client,
    identity: IDENTITY,
    keys: DEFAULT_KEYS,
    preferences: openPreferences(path.join(dir, "tui", "default.state.json")),
    schedule: (fn, ms) => {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    onQuit: force => quits.push(force),
  });
  session.applySnapshot({ identity: IDENTITY, cursor: "e:1", tasks, lanes: LANES, tags: [], notifications: [] });
  daemon.attach(session);
  session.setOverlayHost(fakeHost());
  session.setTheme(resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" } }));
  const fire = (ms: number) => {
    for (const t of timers.filter(x => x.live && x.ms === ms)) {
      t.live = false;
      t.fn();
    }
  };
  const draftOf = async (id: number): Promise<TaskDraft> => {
    const doc = await session.openDocument(id);
    if (doc?.draft == null) throw new Error(`no draft for @${id}`);
    return doc.draft;
  };
  return { session, daemon, quits, fire, draftOf };
}

describe("the session: :q guards (N16)", () => {
  test(":q refuses while a draft is unsaved and names it; :q! discards the local drafts and quits", async () => {
    const { session, daemon, quits, fire, draftOf } = sessionWith();
    (await draftOf(1)).set("body", "unsaved words");
    (await draftOf(2)).set("title", "unsaved title");
    await session.execute("q");
    expect(quits).toEqual([]);
    expect(session.status?.level).toBe("error");
    expect(session.status?.text).toMatch(/@1 body/);
    expect(session.status?.text).toMatch(/@2 title/);
    expect(session.status?.text).toMatch(/:q!/);
    expect(session.unsavedDrafts().map(d => `${d.taskId}:${d.field}:${d.state}`)).toEqual([
      "1:body:pending",
      "2:title:pending",
    ]);
    await session.execute("q!");
    expect(quits).toEqual([true]);
    fire(IDLE_MS);
    fire(MAX_MS);
    await tick();
    expect(daemon.edits()).toEqual([]);
  });

  test(":q names failing and conflicted drafts too", async () => {
    const { session, daemon, quits, fire, draftOf } = sessionWith();
    const one = await draftOf(1);
    one.set("body", "will fail");
    daemon.failNext(new HttpError(500, "disk full"));
    fire(IDLE_MS);
    await tick();
    expect(one.state("body")).toBe("failed");
    const two = await draftOf(2);
    two.set("body", "mine");
    daemon.external(2, { body: "theirs" });
    await tick();
    expect(two.state("body")).toBe("conflict");
    await session.execute("q");
    expect(quits).toEqual([]);
    expect(session.status?.text).toMatch(/@1 body \(save failed\)/);
    expect(session.status?.text).toMatch(/@2 body \(conflict\)/);
  });

  test(":wq and :x quit only after the saves are acknowledged", async () => {
    const { session, daemon, quits, draftOf } = sessionWith();
    (await draftOf(1)).set("body", "saved on the way out");
    daemon.hold();
    const quitting = session.execute("wq");
    await tick();
    expect(daemon.edits().length).toBe(1);
    expect(quits).toEqual([]);
    daemon.release();
    await quitting;
    expect(quits).toEqual([false]);
    expect(daemon.server.get(1)?.body).toBe("saved on the way out");
    const second = sessionWith();
    await second.session.execute("x");
    expect(second.quits).toEqual([false]);
  });

  test(":wq refuses to quit when a save ends in a conflict, and names it", async () => {
    const { session, daemon, quits, draftOf } = sessionWith();
    (await draftOf(1)).set("body", "mine");
    daemon.external(1, { body: "theirs" });
    await tick();
    await session.execute("wq");
    expect(quits).toEqual([]);
    expect(session.status?.text).toMatch(/@1 body \(conflict\)/);
    expect(session.status?.text).toMatch(/:apply|:keep/);
  });

  test(":w flushes every unsaved draft at once (no timers) and reports it", async () => {
    const { session, daemon, draftOf } = sessionWith();
    (await draftOf(1)).set("body", "written now");
    await session.execute("w");
    expect(daemon.server.get(1)?.body).toBe("written now");
    expect(session.unsavedDrafts()).toEqual([]);
    expect(session.status?.text).toMatch(/Saved/);
  });

  test(":apply and :keep resolve the current task's conflict from the keyboard", async () => {
    const { session, daemon, draftOf } = sessionWith();
    const one = await draftOf(1);
    one.set("body", "mine");
    daemon.external(1, { body: "theirs" });
    await tick();
    await session.execute("keep");
    await tick();
    expect(daemon.server.get(1)?.body).toBe("mine");
    one.set("body", "mine again");
    daemon.external(1, { body: "theirs again" });
    await tick();
    expect(one.state("body")).toBe("conflict");
    await session.execute("apply body");
    expect(one.text("body")).toBe("theirs again");
    expect(one.state("body")).toBe("saved");
    await session.execute("apply");
    expect(session.status?.text).toMatch(/No conflict/);
  });
});

describe("the session: INSERT input (N16/N17)", () => {
  test("INSERT's Ctrl-s is :w: the body saves at once and INSERT stays", async () => {
    const { session, daemon } = sessionWith();
    session.setFocus("document");
    session.startInsert();
    await tick();
    for (const ch of "quick ") session.input(ch);
    session.input("\x13");
    await tick();
    expect(daemon.server.get(1)?.body).toBe("quick original body");
    expect(session.keys.mode()).toBe("INSERT");
  });

  test("INSERT input typed before the baseline arrives is queued (and counts as unsaved), then applied in order", async () => {
    const { session } = sessionWith();
    session.setFocus("document");
    session.startInsert();
    for (const ch of "early ") session.input(ch);
    expect(session.documentOf(1)?.draft).toBeNull();
    expect(session.unsavedDrafts().map(d => `${d.taskId}:${d.field}`)).toEqual(["1:body"]);
    await tick();
    expect(session.documentOf(1)?.draft?.text("body")).toBe("early original body");
  });

  test("a baseline that cannot load is reported and KEEPS the typed keys; only an explicit action retries, replaying them first (review F13)", async () => {
    const { session, daemon } = sessionWith();
    daemon.failStates(new HttpError(500, "disk I/O error"));
    session.setFocus("document");
    session.startInsert();
    for (const ch of "ab") session.input(ch);
    await tick();
    expect(session.keys.mode()).toBe("NORMAL");
    expect(session.status?.text).toMatch(
      /Could not open @1 for editing: disk I\/O error; the 2 keys typed meanwhile are kept, not applied yet/,
    );
    expect(session.documentOf(1)?.error).toBe("disk I/O error");
    // Still the user's: unsaved (a failed load), until applied and saved or discarded by :q!.
    expect(session.unsavedDrafts().map(d => `${d.taskId}:${d.field}:${d.state}:${d.reason}`)).toEqual([
      "1:body:failed:not loaded: disk I/O error",
    ]);
    const reads = () => daemon.calls.filter(c => c.name === "taskState").length;
    const before = reads();
    await session.openDocument(1); // an explicit retry
    expect(reads()).toBe(before + 1);
    expect(session.unsavedDrafts().map(d => `${d.taskId}:${d.field}`)).toEqual(["1:body"]);
    daemon.failStates(null);
    session.startInsert();
    session.input("c"); // newer keys go after the kept ones
    await tick();
    expect(reads()).toBe(before + 2);
    expect(session.documentOf(1)?.draft?.text("body")).toBe("abcoriginal body");
    expect(session.documentOf(1)?.error).toBeNull();
  });

  test("a failed baseline with typed keys: :wq retries the load once and refuses to quit while it fails; a successful retry applies and saves them (review F13)", async () => {
    const { session, daemon, quits } = sessionWith();
    daemon.failStates(new HttpError(500, "disk I/O error"));
    session.setFocus("document");
    session.startInsert();
    for (const ch of "keep me ") session.input(ch);
    await tick();
    session.input("\x1b");
    const reads = () => daemon.calls.filter(c => c.name === "taskState").length;
    const before = reads();
    await session.execute("wq");
    expect(quits).toEqual([]);
    expect(reads()).toBe(before + 1); // "save every draft" loaded it once more
    expect(session.status?.text).toMatch(/Not quitting: @1 body \(not loaded: disk I\/O error\) not saved/);
    expect(session.unsavedDrafts().map(d => `${d.taskId}:${d.field}`)).toEqual(["1:body"]);
    await session.execute("q");
    expect(quits).toEqual([]);
    expect(daemon.edits()).toEqual([]);
    daemon.failStates(null);
    await session.execute("wq");
    expect(quits).toEqual([false]);
    expect(daemon.server.get(1)?.body).toBe("keep me original body");
  });

  test("the in-place title conflicts like the body: both are kept, Enter sends nothing, :keep title saves ours", async () => {
    const { session, daemon } = sessionWith();
    await session.execute("title");
    await tick();
    session.input("\x15");
    for (const ch of "Mine") session.input(ch);
    daemon.external(1, { title: "Theirs" });
    await tick();
    const draft = session.documentOf(1)?.draft;
    expect(draft?.state("title")).toBe("conflict");
    expect(draft?.incoming("title")).toBe("Theirs");
    session.input("\r");
    await tick();
    expect(session.keys.mode()).toBe("NORMAL");
    expect(daemon.server.get(1)?.title).toBe("Theirs");
    await session.execute("keep title");
    expect(daemon.server.get(1)?.title).toBe("Mine");
    expect(draft?.state("title")).toBe("saved");
  });
});

describe("the session: :w <path> exports the draft (N16)", () => {
  test(":w <path> writes the body draft to a NEW private file; it never overwrites; :w! <path> does", async () => {
    const { session, draftOf } = sessionWith();
    (await draftOf(1)).set("body", "line one\n\tline two\n");
    const file = path.join(dir, "export.md");
    await session.execute(`w ${file}`);
    expect(fs.readFileSync(file, "utf8")).toBe("line one\n\tline two\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(session.status?.text).toContain(file);
    (await draftOf(1)).set("body", "newer");
    await session.execute(`w ${file}`);
    expect(session.status?.level).toBe("error");
    expect(session.status?.text).toMatch(/exists.*:w!/);
    expect(fs.readFileSync(file, "utf8")).toBe("line one\n\tline two\n");
    fs.chmodSync(file, 0o644);
    await session.execute(`w! ${file}`);
    expect(fs.readFileSync(file, "utf8")).toBe("newer");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test(":w <path> and :w @id <path> during a slow baseline wait for it: the file has the keys typed meanwhile (review F12)", async () => {
    const { session, daemon } = sessionWith();
    daemon.holdStates();
    session.setFocus("document");
    session.startInsert();
    for (const ch of "rescued ") session.input(ch);
    session.input("\x1b");
    const plain = path.join(dir, "plain.md");
    const addressed = path.join(dir, "addressed.md");
    const exporting = [session.execute(`w ${plain}`), session.execute(`w @1 ${addressed}`)];
    await tick();
    expect(fs.existsSync(plain)).toBe(false); // never the saved body in its place
    expect(fs.existsSync(addressed)).toBe(false);
    daemon.releaseStates();
    await Promise.all(exporting);
    expect(fs.readFileSync(plain, "utf8")).toBe("rescued original body");
    expect(fs.readFileSync(addressed, "utf8")).toBe("rescued original body");
    expect(session.messages.filter(m => /^Exported @1's body/.test(m.text)).length).toBe(2);
  });

  test(":w <path> refuses when the baseline failed to load: no file, the typed keys stay kept (review F12)", async () => {
    const { session, daemon } = sessionWith();
    daemon.failStates(new HttpError(500, "disk I/O error"));
    session.setFocus("document");
    session.startInsert();
    for (const ch of "not the saved body") session.input(ch);
    await tick();
    const file = path.join(dir, "refused.md");
    await session.execute(`w ${file}`);
    expect(session.status?.level).toBe("error");
    expect(session.status?.text).toMatch(
      /Could not export @1: its document did not load \(disk I\/O error\).*kept.*:edit/,
    );
    await session.execute(`w @1 ${file}`);
    expect(session.status?.level).toBe("error");
    expect(fs.existsSync(file)).toBe(false);
    expect(session.unsavedDrafts().map(d => `${d.taskId}:${d.field}`)).toEqual(["1:body"]);
  });
});

describe("the session: deleting a task with a dirty draft (N16)", () => {
  test(":delete offers export or discard; y discards the draft and deletes; n keeps both", async () => {
    const { session, daemon, draftOf } = sessionWith();
    (await draftOf(1)).set("body", "precious unsaved text");
    await session.execute("delete");
    const dialog = session.dialog as unknown as { render(width: number): string[] } | null;
    const text = (dialog?.render(80) ?? []).map(l => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    expect(text).toMatch(/unsaved/i);
    expect(text).toMatch(/:w <path>/);
    session.input("n");
    await tick();
    expect(session.dialog).toBeNull();
    expect(daemon.server.has(1)).toBe(true);
    expect(session.unsavedDrafts().length).toBe(1);
    // Export from inside the confirmation, then discard and delete.
    await session.execute("delete");
    const file = path.join(dir, "rescued.md");
    await session.execute(`w ${file}`);
    expect(session.dialog).not.toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe("precious unsaved text");
    session.input("y");
    await tick();
    expect(daemon.server.has(1)).toBe(false);
    expect(session.unsavedDrafts()).toEqual([]);
    expect(daemon.edits()).toEqual([]);
  });

  test("a task deleted elsewhere keeps its dirty draft (named by :q, exportable) and drops a clean one", async () => {
    const { session, daemon, quits, draftOf } = sessionWith();
    (await draftOf(1)).set("body", "orphaned words");
    await draftOf(2);
    daemon.removeElsewhere(1);
    daemon.removeElsewhere(2);
    await tick();
    expect(session.status?.level).toBe("warn");
    expect(session.status?.text).toMatch(/@1.*deleted.*:w @1 <path>/);
    expect(session.documentOf(2)).toBeNull();
    await session.execute("q");
    expect(quits).toEqual([]);
    expect(session.status?.text).toMatch(/@1 body \(task deleted\)/);
    const file = path.join(dir, "orphan.md");
    await session.execute(`w ${file}`);
    expect(fs.readFileSync(file, "utf8")).toBe("orphaned words");
    await session.execute("q!");
    expect(quits).toEqual([true]);
  });

  test("every kept draft stays addressable: :w @<id> <path> exports each; a clean current document hides none (review F6)", async () => {
    const { session, daemon, quits, draftOf } = sessionWith([
      task(1),
      task(2, { title: "second", body: "second body" }),
      task(3, { title: "third", body: "third body" }),
    ]);
    (await draftOf(1)).set("body", "first kept words");
    (await draftOf(2)).set("body", "second kept words");
    daemon.removeElsewhere(1);
    daemon.removeElsewhere(2);
    await tick();
    expect(session.status?.text).toMatch(/@2: it was deleted elsewhere.*:w @2 <path> exports it/);
    session.select(3);
    await draftOf(3); // a CLEAN current document
    // :q names how to export EACH kept draft.
    await session.execute("q");
    expect(quits).toEqual([]);
    expect(session.status?.text).toMatch(/@1 body \(task deleted\), @2 body \(task deleted\)/);
    expect(session.status?.text).toContain(":w @1 <path>");
    expect(session.status?.text).toContain(":w @2 <path>");
    // A plain :w <path> guesses nothing between two kept drafts (and the clean document hides neither).
    const guess = path.join(dir, "guess.md");
    await session.execute(`w ${guess}`);
    expect(session.status?.level).toBe("error");
    expect(session.status?.text).toContain(":w @1 <path>");
    expect(session.status?.text).toContain(":w @2 <path>");
    expect(fs.existsSync(guess)).toBe(false);
    // Each by its address, the older one included; :w! @<id> replaces a file.
    const one = path.join(dir, "one.md");
    const two = path.join(dir, "two.md");
    await session.execute(`w @1 ${one}`);
    expect(session.status?.text).toContain(one);
    await session.execute(`w @2 ${two}`);
    expect(fs.readFileSync(one, "utf8")).toBe("first kept words");
    expect(fs.readFileSync(two, "utf8")).toBe("second kept words");
    await session.execute(`w @1 ${two}`);
    expect(session.status?.level).toBe("error");
    await session.execute(`w! @1 ${two}`);
    expect(fs.readFileSync(two, "utf8")).toBe("first kept words");
    expect(fs.statSync(two).mode & 0o777).toBe(0o600);
    // @<id> of a live task exports its body; an unknown one explains; a bare @<id> needs a path.
    const three = path.join(dir, "three.md");
    await session.execute(`w @3 ${three}`);
    expect(fs.readFileSync(three, "utf8")).toBe("third body");
    await session.execute(`w @9 ${path.join(dir, "nine.md")}`);
    expect(session.status?.text).toMatch(/No task or kept draft @9/);
    await session.execute("w @1");
    expect(session.status?.text).toMatch(/Usage: :w \[@id\] <path>/);
    // A DIRTY current document is what a plain :w <path> exports.
    (await draftOf(3)).set("body", "third, edited");
    const edited = path.join(dir, "edited.md");
    await session.execute(`w ${edited}`);
    expect(fs.readFileSync(edited, "utf8")).toBe("third, edited");
    // Exporting never discards: both still block :q until :q!.
    expect(
      session
        .unsavedDrafts()
        .filter(d => d.orphaned)
        .map(d => `${d.address} ${d.field}`),
    ).toEqual(["@1 body", "@2 body"]);
    await session.execute("q!");
    expect(quits).toEqual([true]);
    expect(daemon.edits().map(c => c.args[0])).not.toContain(1);
  });

  test("with ONE kept draft, a plain :w <path> exports it even while a clean current document is open (review F6)", async () => {
    const { session, daemon, draftOf } = sessionWith();
    (await draftOf(1)).set("body", "only kept words");
    daemon.removeElsewhere(1);
    await tick();
    session.select(2);
    await draftOf(2); // clean
    const file = path.join(dir, "kept.md");
    await session.execute(`w ${file}`);
    expect(fs.readFileSync(file, "utf8")).toBe("only kept words");
    expect(session.status?.text).toMatch(/kept draft @1/);
  });

  test("a task deleted elsewhere before its baseline arrived keeps the keys typed meanwhile as a kept draft (review F11)", async () => {
    const { session, daemon, quits } = sessionWith();
    daemon.holdStates();
    session.setFocus("document");
    session.startInsert();
    for (const ch of "last words") session.input(ch);
    daemon.removeElsewhere(1);
    daemon.releaseStates(); // its baseline read now answers 404
    await tick();
    expect(session.unsavedDrafts().map(d => `${d.address} ${d.field} ${d.orphaned} ${d.reason}`)).toEqual([
      "@1 body true task deleted",
    ]);
    expect(session.status?.text).toMatch(
      /@1: it was deleted elsewhere before it loaded for editing; its typed body input/,
    );
    await session.execute("q");
    expect(quits).toEqual([]);
    const file = path.join(dir, "last.md");
    await session.execute(`w ${file}`);
    expect(fs.readFileSync(file, "utf8")).toBe("last words");
    expect(daemon.edits()).toEqual([]);
  });

  test("a save answered after its task was deleted elsewhere never makes the kept draft saved: :q still refuses (review F3)", async () => {
    const { session, daemon, quits, fire, draftOf } = sessionWith();
    (await draftOf(1)).set("body", "racing words");
    daemon.holdAnswers();
    fire(IDLE_MS); // committed and published (the session reads it back); answered only later
    await tick();
    expect(daemon.server.get(1)?.body).toBe("racing words");
    daemon.removeElsewhere(1);
    await tick();
    daemon.releaseAnswers();
    await tick();
    expect(session.unsavedDrafts().map(d => `${d.taskId}:${d.field}:${d.orphaned}`)).toEqual(["1:body:true"]);
    await session.execute("q");
    expect(quits).toEqual([]);
    expect(session.status?.text).toMatch(/@1 body \(task deleted\)/);
  });
});
