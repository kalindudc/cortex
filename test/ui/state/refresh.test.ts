// state/refresh.ts — task-safe Related fetching.
//
// Both async paths (refresh() and the activeTask effect) must publish
// Related results ONLY for the still-current request/task generation: a
// slow response for task A can never appear under task B, a stale error
// can never mask a current success, and failures surface an explicit
// error/retry state instead of a silent empty success.
//
// The api client is mocked with DEFERRED promises resolved out of order.
// The module keeps internal state (lastActive, request generation) across
// tests in the shared bun process, so every test uses its OWN task ids and
// filters relatedCalls by task id instead of relying on global counts.
//
// LIVE SYNCHRONIZATION is tested further down through
// connectLive() with a plain EventTarget standing in for the browser's
// EventSource: `ready` snapshots via GET /api/workspace, frames arriving
// during that fetch are buffered and applied only after the snapshot's
// cursor, obsolete responses never overwrite newer state, resync/gap/epoch
// changes and reconnects resnapshot, notification.changed refetches the
// notifications, and ONLY the explicit task.blocked event raises a desktop
// alert.

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

interface DeferredRelated {
  taskId: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}
interface Deferred<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}
const relatedCalls: DeferredRelated[] = [];
const updatesCalls: number[] = [];
// What GET /api/tasks/:id/updates answers per task (empty unless a test sets it).
const updatesLists = new Map<number, Update[]>();
const workspaceCalls: Deferred<WorkspaceSnapshot>[] = [];
const notificationCalls: Deferred<Notification[]>[] = [];
// The daemon's atomic task states (text + tokens) that mounted drafts read,
// and the guarded writes they send.
const draftStates = new Map<number, TaskStateSnapshot>();
const stateReads: number[] = [];
const draftWrites: { id: number; patch: unknown; guard: unknown }[] = [];

mock.module("../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    notifications: mock(
      () =>
        new Promise<Notification[]>((resolve, reject) => {
          notificationCalls.push({ resolve, reject });
        }),
    ),
    workspace: mock(
      () =>
        new Promise<WorkspaceSnapshot>((resolve, reject) => {
          workspaceCalls.push({ resolve, reject });
        }),
    ),
    updates: mock((taskId: number) => {
      updatesCalls.push(taskId);
      return Promise.resolve(structuredClone(updatesLists.get(taskId) ?? []));
    }),
    related: mock(
      (taskId: number) =>
        new Promise((resolve, reject) => {
          relatedCalls.push({ taskId, resolve, reject });
        }),
    ),
    editTask: mock(() => Promise.resolve({})),
    taskState: mock((id: number) => {
      stateReads.push(id);
      const state = draftStates.get(id);
      return state ? Promise.resolve(structuredClone(state)) : Promise.reject(new Error(`no task ${id}`));
    }),
    versioned: {
      editTask: mock((id: number, patch: unknown, guard: unknown) => {
        draftWrites.push({ id, patch, guard });
        return new Promise(() => {}); // never answered: these tests only watch what is sent
      }),
    },
  },
}));
mock.module("../../../src/ui/api/errors.ts", () => ({
  tryApi: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  showError: () => {},
}));

import {
  tasks,
  selectedId,
  filters,
  workspaceQuery,
  relatedTasks,
  relatedError,
  relatedLoading,
  showAllTasks,
  liveState,
} from "../../../src/ui/state/signals.ts";
import { notifications } from "../../../src/ui/state/notifications.ts";
import type { Task, RelatedTasks, Notification, Update } from "../../../src/ui/api/types.ts";
import type { TaskStateSnapshot, WorkspaceSnapshot } from "../../../src/contracts.ts";
import { act, render } from "@testing-library/preact";
import { h, type ComponentChild } from "preact";
import { activeTask, inboxList } from "../../../src/ui/state/computed.ts";
import { useTaskDraft, pruneTaskDrafts, type TaskDraft } from "../../../src/ui/lib/useTaskDraft.ts";
import type { Scheduler } from "../../../src/ui/lib/autosave.ts";

// Fresh module instance bound to THIS file's api mock.
// @ts-expect-error — cache-bust query suffix has no .d.ts; runtime-only.
const refreshMod = await import("../../../src/ui/state/refresh.ts?b=refresh-test");
const { fetchRelated, retryRelated, connectLive, onDatabaseChange } = refreshMod as {
  fetchRelated: (taskId: number) => Promise<void>;
  retryRelated: () => void;
  connectLive: (source: EventTarget, options?: { coalesceMs?: number }) => () => void;
  onDatabaseChange: (listener: () => void) => () => void;
};

const mkTask = (id: number): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body: null,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  memory_excluded: false,
});

const ALL_IDS = [11, 12, 21, 31, 41, 42, 51, 61, 71, 72];
const buckets = (n: number): RelatedTasks => ({ referencedBy: [mkTask(n)], references: [], shared: [] });
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
const callsFor = (taskId: number): DeferredRelated[] => relatedCalls.filter(c => c.taskId === taskId);

describe("state/refresh related-fetch generations (N2)", () => {
  beforeEach(() => {
    relatedCalls.length = 0;
    updatesCalls.length = 0;
    tasks.value = ALL_IDS.map(mkTask);
    filters.value = { status: null, lane: null, tag: [] };
    workspaceQuery.value = "";
    showAllTasks.value = false;
    relatedTasks.value = null;
    relatedError.value = null;
    relatedLoading.value = null;
  });

  test("a slow response for task A never publishes under task B (out-of-order)", async () => {
    selectedId.value = 11; // effect → fetchRelated(11)
    selectedId.value = 12; // effect → fetchRelated(12); 11 still in flight
    const a = callsFor(11);
    const b = callsFor(12);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    b[0].resolve(buckets(12));
    await tick();
    expect(relatedTasks.value).toEqual(buckets(12));
    // Task A's slow response lands late — must be discarded.
    a[0].resolve(buckets(11));
    await tick();
    expect(relatedTasks.value).toEqual(buckets(12));
    expect(relatedError.value).toBeNull();
    expect(relatedLoading.value).toBeNull();
  });

  test("a newer request supersedes an older one for the SAME task", async () => {
    selectedId.value = 21; // effect-driven fetch (older generation)
    void fetchRelated(21); // explicit newer generation
    const calls = callsFor(21);
    expect(calls.length).toBe(2);
    calls[1].resolve(buckets(2)); // newest generation wins
    await tick();
    expect(relatedTasks.value).toEqual(buckets(2));
    calls[0].resolve(buckets(1)); // stale — discarded
    await tick();
    expect(relatedTasks.value).toEqual(buckets(2));
  });

  test("failure publishes a keyed error with loading cleared; retry refetches", async () => {
    selectedId.value = 31;
    const first = callsFor(31);
    expect(first.length).toBe(1);
    expect(relatedLoading.value?.taskId).toBe(31);
    expect(relatedLoading.value?.generation).toBeGreaterThan(0);
    first[0].reject(new Error("related backend down"));
    await tick();
    expect(relatedError.value).toEqual({ taskId: 31, message: "related backend down" });
    expect(relatedLoading.value).toBeNull();

    retryRelated();
    await tick();
    const retries = callsFor(31);
    expect(retries.length).toBe(2);
    retries[1].resolve(buckets(31));
    await tick();
    expect(relatedTasks.value).toEqual(buckets(31));
    expect(relatedError.value).toBeNull();
  });

  test("a stale error after switching tasks is discarded (no error flash on B)", async () => {
    selectedId.value = 41;
    selectedId.value = 42;
    callsFor(41)[0].reject(new Error("stale failure"));
    await tick();
    expect(relatedError.value).toBeNull(); // stale error suppressed
    callsFor(42)[0].resolve(buckets(42));
    await tick();
    expect(relatedTasks.value).toEqual(buckets(42));
    expect(relatedError.value).toBeNull();
  });

  test("empty buckets are a CONFIRMED empty, distinct from loading", async () => {
    selectedId.value = 51;
    callsFor(51)[0].resolve({ referencedBy: [], references: [], shared: [] });
    await tick();
    expect(relatedTasks.value).toEqual({ referencedBy: [], references: [], shared: [] });
    expect(relatedLoading.value).toBeNull();
    expect(relatedError.value).toBeNull();
  });

  test("a fetch that is already stale at START performs no request or state write", async () => {
    selectedId.value = 71;
    const currentCall = callsFor(71)[0];
    currentCall.resolve(buckets(71));
    await tick();
    const beforeCalls = relatedCalls.length;
    await fetchRelated(999);
    expect(relatedCalls.length).toBe(beforeCalls);
    expect(relatedTasks.value).toEqual(buckets(71));
    expect(relatedLoading.value).toBeNull();
  });

  test("losing the active task invalidates an in-flight Related request", async () => {
    selectedId.value = 72;
    const inFlight = callsFor(72).at(-1);
    if (!inFlight) throw new Error("expected task 72 Related call");
    tasks.value = [];
    selectedId.value = null;
    await tick();
    expect(relatedTasks.value).toBeNull();
    expect(relatedLoading.value).toBeNull();
    expect(relatedError.value).toBeNull();
    inFlight.resolve(buckets(71));
    await tick();
    expect(relatedTasks.value).toBeNull();
  });

  test("the activeTask effect fetches updates keyed by the task id", async () => {
    selectedId.value = 61;
    await tick();
    expect(updatesCalls).toContain(61);
  });
});

// ---------------------------------------------------------------------------
// Live synchronization
// ---------------------------------------------------------------------------

const mkNotif = (id: number, read = false): Notification => ({
  id,
  task_id: null,
  author: null,
  status: "open",
  title: `notification ${id}`,
  message: "",
  read,
  created: id,
});
const snapshot = (cursor: string, ids: number[], notifs: Notification[] = []): WorkspaceSnapshot => ({
  identity: null,
  cursor,
  tasks: ids.map(mkTask),
  lanes: [],
  tags: [],
  notifications: notifs,
});
const taskIds = (): number[] => tasks.value.map(t => t.id);
const notifIds = (): number[] => notifications.value.map(n => n.id);
// Several timer turns: the (0ms) coalescing timer plus the promise chains behind it.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await tick();
};

/** A plain EventTarget standing in for the browser's EventSource, wired through connectLive. */
function liveSource() {
  const source = new EventTarget();
  const detach = connectLive(source, { coalesceMs: 0 });
  const send = (kind: string, id: string, payload: unknown): void => {
    source.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(payload), lastEventId: id }));
  };
  const ready = (cursor: string): void =>
    send("ready", cursor, { cursor, epoch: cursor.split(":")[0], instanceId: null, databaseId: "db-1" });
  const drop = (): void => {
    source.dispatchEvent(new Event("error"));
  };
  return { source, detach, send, ready, drop };
}

describe("state/refresh live synchronization (N12)", () => {
  let live: ReturnType<typeof liveSource> | null = null;
  const open = (): ReturnType<typeof liveSource> => {
    live = liveSource();
    return live;
  };

  beforeEach(() => {
    workspaceCalls.length = 0;
    notificationCalls.length = 0;
    relatedCalls.length = 0;
    selectedId.value = null;
    tasks.value = [];
    notifications.value = [];
  });
  afterEach(() => {
    live?.detach();
    live = null;
  });

  test("ready takes a workspace snapshot and applies it; nothing is fetched before ready", async () => {
    const s = open();
    await settle();
    expect(workspaceCalls.length).toBe(0);
    expect(liveState.value).toBe("connecting");
    s.ready("e1:5");
    await settle();
    expect(workspaceCalls.length).toBe(1);
    expect(liveState.value).toBe("live");
    workspaceCalls[0].resolve(snapshot("e1:5", [101, 102], [mkNotif(1)]));
    await settle();
    expect(taskIds()).toEqual([101, 102]);
    expect(notifIds()).toEqual([1]);
    expect(workspaceCalls.length).toBe(1);
  });

  test("frames arriving during the snapshot fetch are applied after it, only past its cursor", async () => {
    const s = open();
    s.ready("e1:5");
    await settle();
    s.send("task.updated", "e1:6", mkTask(101));
    s.send("notification.added", "e1:7", mkNotif(901));
    await settle();
    // One snapshot in flight at a time; buffered frames wait for its cursor.
    expect(workspaceCalls.length).toBe(1);
    expect(notifIds()).toEqual([]);
    // Read BEFORE both writes (cursor e1:5): neither write may be lost.
    workspaceCalls[0].resolve(snapshot("e1:5", [101]));
    await settle();
    expect(taskIds()).toEqual([101]);
    expect(notifIds()).toEqual([901]);
    expect(workspaceCalls.length).toBe(2); // task.updated e1:6 needs a newer snapshot
    workspaceCalls[1].resolve(snapshot("e1:7", [101, 102], [mkNotif(901)]));
    await settle();
    expect(taskIds()).toEqual([101, 102]);
    expect(notifIds()).toEqual([901]); // replaced by the snapshot, never duplicated
    expect(workspaceCalls.length).toBe(2);
  });

  // A failed snapshot applied nothing, so the notification frames buffered
  // during it apply as if none had been in flight; an idle stream may never send another
  // `ready`, and the bell feed must not lose a persisted row until then.
  test("a failed snapshot still applies the notification frames buffered during it", async () => {
    const s = open();
    s.ready("e1:1");
    await settle();
    workspaceCalls[0].resolve(snapshot("e1:1", [601], [mkNotif(1)]));
    await settle();
    s.send("task.updated", "e1:2", mkTask(601));
    await settle();
    expect(workspaceCalls.length).toBe(2); // in flight: the next frames are buffered
    s.send("notification.added", "e1:3", mkNotif(2));
    s.send("notification.changed", "e1:4", { action: "read", id: 1, task_id: null });
    await settle();
    expect(notifIds()).toEqual([1]);
    expect(notificationCalls.length).toBe(0);
    workspaceCalls[1].reject(new Error("workspace read failed"));
    await settle();
    expect(notifIds()).toEqual([2, 1]);
    expect(notificationCalls.length).toBe(1); // the buffered change refetches
    notificationCalls[0].resolve([mkNotif(2), mkNotif(1, true)]);
    await settle();
    expect(notifications.value.map(n => [n.id, n.read])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  test("a failed first snapshot re-reads for the notification frames buffered during it", async () => {
    const s = open();
    s.ready("e1:1");
    await settle();
    s.send("notification.added", "e1:2", mkNotif(3));
    await settle();
    workspaceCalls[0].reject(new Error("workspace read failed"));
    await settle();
    // Nothing shown to compare the frame with: a snapshot issued after it covers it.
    expect(workspaceCalls.length).toBe(2);
    workspaceCalls[1].resolve(snapshot("e1:2", [], [mkNotif(3)]));
    await settle();
    expect(notifIds()).toEqual([3]);
  });

  test("frames at or before the snapshot cursor are skipped; later frames refresh", async () => {
    const s = open();
    s.ready("e1:5");
    await settle();
    // Served AFTER four more writes, so the snapshot already contains them.
    workspaceCalls[0].resolve(snapshot("e1:9", [101], [mkNotif(902)]));
    await settle();
    s.send("task.updated", "e1:6", mkTask(101));
    s.send("notification.added", "e1:7", mkNotif(902));
    s.send("update.posted", "e1:8", { id: 1, task_id: 101 });
    s.send("notification.changed", "e1:9", { action: "read", id: 902, task_id: null });
    await settle();
    expect(workspaceCalls.length).toBe(1);
    expect(notificationCalls.length).toBe(0);
    expect(notifIds()).toEqual([902]);
    s.send("task.added", "e1:10", mkTask(103));
    await settle();
    expect(workspaceCalls.length).toBe(2);
  });

  test("a burst of changes coalesces into one follow-up snapshot", async () => {
    const s = open();
    s.ready("e1:1");
    await settle();
    workspaceCalls[0].resolve(snapshot("e1:1", [101]));
    await settle();
    s.send("task.updated", "e1:2", mkTask(101));
    s.send("tag.changed", "e1:3", { name: "x", color: null, created: 0 });
    s.send("lane.changed", "e1:4", { name: "now", color: null, sort: 0 });
    await settle();
    expect(workspaceCalls.length).toBe(2);
  });

  test("a reconnect supersedes the in-flight snapshot and its late (obsolete) response is ignored", async () => {
    const s = open();
    s.ready("e1:5");
    await settle();
    s.send("task.updated", "e1:6", mkTask(199)); // pending work from the old connection
    s.drop();
    expect(liveState.value).toBe("stale");
    s.ready("e2:0"); // the daemon restarted: new epoch
    await settle();
    expect(workspaceCalls.length).toBe(2);
    expect(liveState.value).toBe("live");
    workspaceCalls[1].resolve(snapshot("e2:0", [201]));
    await settle();
    expect(taskIds()).toEqual([201]);
    workspaceCalls[0].resolve(snapshot("e1:5", [199])); // obsolete
    await settle();
    expect(taskIds()).toEqual([201]);
    // Nothing from the old epoch is still "required": no follow-up snapshots.
    expect(workspaceCalls.length).toBe(2);
    // The new connection's frames are compared with the new snapshot.
    s.send("task.added", "e2:1", mkTask(202));
    await settle();
    expect(workspaceCalls.length).toBe(3);
  });

  test("a reconnect resnapshots only when writes may have been missed", async () => {
    const s = open();
    s.ready("e1:3");
    await settle();
    workspaceCalls[0].resolve(snapshot("e1:3", [301]));
    await settle();
    s.drop();
    s.ready("e1:3"); // nothing was published while disconnected
    await settle();
    expect(workspaceCalls.length).toBe(1);
    s.drop();
    s.ready("e1:6"); // three writes happened while disconnected
    await settle();
    expect(workspaceCalls.length).toBe(2);
    workspaceCalls[1].resolve(snapshot("e1:6", [301, 302]));
    await settle();
    expect(taskIds()).toEqual([301, 302]);
  });

  test("resync, a sequence gap and an epoch change each resnapshot; duplicate/stale frames are dropped", async () => {
    const s = open();
    s.ready("e1:1");
    await settle();
    workspaceCalls[0].resolve(snapshot("e1:1", [401]));
    await settle();
    s.send("resync", "e1:40", { reason: "overflow", cursor: "e1:40" });
    await settle();
    expect(workspaceCalls.length).toBe(2);
    workspaceCalls[1].resolve(snapshot("e1:40", [401, 402]));
    await settle();
    expect(taskIds()).toEqual([401, 402]);

    // A contiguous notification.added frame applies without a snapshot...
    s.send("notification.added", "e1:41", mkNotif(41));
    await settle();
    expect(notifIds()).toEqual([41]);
    expect(workspaceCalls.length).toBe(2);
    // ...duplicate and stale frames are dropped...
    s.send("notification.added", "e1:41", mkNotif(41));
    s.send("task.updated", "e1:30", mkTask(401));
    await settle();
    expect(notifIds()).toEqual([41]);
    expect(workspaceCalls.length).toBe(2);
    // ...a missed sequence number means missed writes: resnapshot...
    s.send("notification.added", "e1:43", mkNotif(43));
    await settle();
    expect(workspaceCalls.length).toBe(3);
    workspaceCalls[2].resolve(snapshot("e1:43", [401, 402], [mkNotif(43), mkNotif(41)]));
    await settle();
    expect(notifIds()).toEqual([43, 41]);
    // ...and a frame from another publisher lifetime is not comparable: resnapshot.
    s.send("notification.added", "e2:1", mkNotif(44));
    await settle();
    expect(workspaceCalls.length).toBe(4);
  });

  test("notification.changed refetches notifications; obsolete refetch answers are ignored", async () => {
    const s = open();
    s.ready("e1:1");
    await settle();
    workspaceCalls[0].resolve(snapshot("e1:1", [501], [mkNotif(1)]));
    await settle();

    s.send("notification.changed", "e1:2", { action: "read", id: 1, task_id: null });
    await settle();
    expect(notificationCalls.length).toBe(1);
    notificationCalls[0].resolve([mkNotif(1, true)]);
    await settle();
    expect(notifications.value.map(n => n.read)).toEqual([true]);

    // A refetch overtaken by a newer notification frame is obsolete: its
    // answer (read before the new row existed) must not erase that row.
    s.send("notification.changed", "e1:3", { action: "unread", id: 1, task_id: null });
    await settle();
    expect(notificationCalls.length).toBe(2);
    s.send("notification.added", "e1:4", mkNotif(2));
    await settle();
    expect(notifIds()).toEqual([2, 1]);
    notificationCalls[1].resolve([mkNotif(1, false)]);
    await settle();
    expect(notifIds()).toEqual([2, 1]);
    expect(notificationCalls.length).toBe(3); // one trailing refetch replaces it
    notificationCalls[2].resolve([mkNotif(2), mkNotif(1, false)]);
    await settle();
    expect(notifIds()).toEqual([2, 1]);
    expect(notifications.value.map(n => n.read)).toEqual([false, false]);

    // A snapshot issued later supersedes an earlier refetch as well.
    s.send("notification.changed", "e1:5", { action: "dismiss", id: 2, task_id: null });
    await settle();
    expect(notificationCalls.length).toBe(4);
    s.send("resync", "e1:9", { reason: "overflow", cursor: "e1:9" });
    await settle();
    expect(workspaceCalls.length).toBe(2);
    workspaceCalls[1].resolve(snapshot("e1:9", [501], [mkNotif(1, true)]));
    await settle();
    notificationCalls[3].resolve([mkNotif(2), mkNotif(1)]); // read before that snapshot: obsolete
    await settle();
    expect(notifIds()).toEqual([1]);
    expect(notifications.value[0].read).toBe(true);
    expect(notificationCalls.length).toBe(4);
  });

  // A status change also publishes its audit row as update.posted. The
  // inbox is the server's list for the active task, re-read after the (coalesced) snapshot,
  // never the frames' payloads appended: each update shows exactly once.
  test("a status post's message and audit frames show each update once in the active inbox", async () => {
    const s = open();
    s.ready("e1:1");
    await settle();
    workspaceCalls[0].resolve(snapshot("e1:1", [81]));
    selectedId.value = 81;
    await settle();
    expect(inboxList.value).toEqual([]);
    const row = (id: number, summary: string): Update => ({
      id,
      task_id: 81,
      author: "agent-1",
      summary,
      body: null,
      severity: "progress",
      created: id,
    });
    const message = row(1, "ready for a look");
    const audit = row(2, "status \u2192 review");
    updatesLists.set(81, [message, audit]);
    // One status post, as the daemon publishes it: message, audit row, notification, task.
    s.send("update.posted", "e1:2", message);
    s.send("update.posted", "e1:3", audit);
    s.send("notification.added", "e1:4", mkNotif(950));
    s.send("task.updated", "e1:5", { ...mkTask(81), status: "review" });
    s.send("update.posted", "e1:3", audit); // a duplicate frame is dropped
    await settle();
    expect(workspaceCalls.length).toBe(2); // the burst coalesced into one snapshot
    workspaceCalls[1].resolve(snapshot("e1:5", [81]));
    await settle();
    expect(inboxList.value.map(u => u.id)).toEqual([2, 1]);
    // Even the same row again at a later cursor only re-reads the list: still once.
    s.send("update.posted", "e1:6", audit);
    await settle();
    workspaceCalls[2].resolve(snapshot("e1:6", [81]));
    await settle();
    expect(inboxList.value.map(u => [u.id, u.summary])).toEqual([
      [2, "status \u2192 review"],
      [1, "ready for a look"],
    ]);
    updatesLists.delete(81);
  });

  test("detaching stops following the stream", async () => {
    const s = open();
    s.detach();
    s.ready("e1:1");
    await settle();
    expect(workspaceCalls.length).toBe(0);
  });
});

// A `ready` naming another database (for example after `cortex reset`)
// announces the change before the new snapshot is requested, so state keyed
// by the old database's task ids can be set aside first.
describe("state/refresh database identity change", () => {
  let live: ReturnType<typeof liveSource> | null = null;
  let unsubscribe: (() => void) | null = null;
  // workspaceCalls.length at each listener call: how many snapshots were requested before it.
  let calls: number[] = [];
  const open = (): ReturnType<typeof liveSource> => {
    live = liveSource();
    return live;
  };
  const readyOn = (s: ReturnType<typeof liveSource>, cursor: string, databaseId: string): void =>
    s.send("ready", cursor, { cursor, epoch: cursor.split(":")[0], instanceId: null, databaseId });

  beforeEach(() => {
    workspaceCalls.length = 0;
    calls = [];
    unsubscribe = onDatabaseChange(() => calls.push(workspaceCalls.length));
  });
  afterEach(() => {
    unsubscribe?.();
    live?.detach();
    live = null;
  });

  test("the first ready only records the id, and the same id again changes nothing", async () => {
    const s = open();
    s.ready("e1:1");
    await settle();
    s.drop();
    s.ready("e2:0");
    await settle();
    expect(calls).toEqual([]);
  });

  test("another database id calls the listener once, before its snapshot is requested", async () => {
    const s = open();
    s.ready("e1:1");
    await settle();
    workspaceCalls[0].resolve(snapshot("e1:1", [701]));
    await settle();
    s.drop();
    readyOn(s, "e2:0", "db-2");
    await settle();
    expect(calls).toEqual([1]);
    expect(workspaceCalls.length).toBe(2);
    readyOn(s, "e2:0", "db-2");
    await settle();
    expect(calls).toEqual([1]);
  });

  test("a ready without data, or without a string databaseId, is ignored", async () => {
    const { source } = open();
    source.dispatchEvent(
      new MessageEvent("ready", { lastEventId: "e1:1", data: JSON.stringify({ databaseId: "db-1" }) }),
    );
    source.dispatchEvent(new MessageEvent("ready", { lastEventId: "e2:0" }));
    source.dispatchEvent(new MessageEvent("ready", { lastEventId: "e3:0", data: "not json" }));
    source.dispatchEvent(new MessageEvent("ready", { lastEventId: "e4:0", data: JSON.stringify({ databaseId: 7 }) }));
    await settle();
    expect(calls).toEqual([]);
    source.dispatchEvent(
      new MessageEvent("ready", { lastEventId: "e5:0", data: JSON.stringify({ databaseId: "db-2" }) }),
    );
    await settle();
    expect(calls.length).toBe(1);
  });

  test("an unsubscribed listener is not called", async () => {
    const s = open();
    unsubscribe?.();
    unsubscribe = null;
    s.ready("e1:1");
    await settle();
    readyOn(s, "e2:0", "db-2");
    await settle();
    expect(calls).toEqual([]);
  });
});

describe("state/refresh blocked-transition alerts (N12)", () => {
  class FakeNotification {
    static permission: string = "granted";
    static requestPermission = mock(() => Promise.resolve("granted"));
    static shown: { title: string; options?: NotificationOptions }[] = [];
    constructor(title: string, options?: NotificationOptions) {
      FakeNotification.shown.push({ title, options });
    }
  }
  const g = globalThis as { Notification?: unknown };
  const original = g.Notification;
  let live: ReturnType<typeof liveSource> | null = null;
  const blockedTask = (id: number, extra: Partial<Task> = {}): Task => ({ ...mkTask(id), status: "blocked", ...extra });
  const transition = (id: number, previous: string) => ({ task: blockedTask(id), previous, author: "agent-1" });

  beforeEach(() => {
    workspaceCalls.length = 0;
    notificationCalls.length = 0;
    selectedId.value = null;
    tasks.value = [];
    notifications.value = [];
    FakeNotification.permission = "granted";
    FakeNotification.shown = [];
    FakeNotification.requestPermission.mockClear();
    g.Notification = FakeNotification;
  });
  afterEach(() => {
    live?.detach();
    live = null;
    g.Notification = original;
  });

  test("edits of an already-blocked task never alert; each transition alerts exactly once", async () => {
    live = liveSource();
    const s = live;
    s.ready("e1:1");
    await settle();
    workspaceCalls[0].resolve({ ...snapshot("e1:1", []), tasks: [blockedTask(601)] });
    await settle();
    expect(FakeNotification.shown).toEqual([]); // a snapshot never alerts

    // Edits of the blocked task publish task.updated whose payload is blocked.
    s.send("task.updated", "e1:2", blockedTask(601, { body: "more detail" }));
    s.send("task.updated", "e1:3", blockedTask(601, { priority: 1 }));
    await settle();
    expect(FakeNotification.shown).toEqual([]);

    // blocked -> open -> blocked: the daemon publishes task.blocked for the transition only.
    s.send("task.updated", "e1:4", mkTask(601));
    s.send("task.updated", "e1:5", blockedTask(601));
    s.send("task.blocked", "e1:6", transition(601, "open"));
    await settle();
    expect(FakeNotification.shown).toEqual([
      { title: "cortex: task blocked", options: { body: "task 601", tag: "task-601" } },
    ]);

    // A duplicate delivery of that frame is dropped.
    s.send("task.blocked", "e1:6", transition(601, "open"));
    await settle();
    expect(FakeNotification.shown.length).toBe(1);

    // Reconnecting resnapshots (the task is still blocked) without alerting again.
    s.drop();
    s.ready("e1:9");
    await settle();
    for (const call of workspaceCalls) call.resolve({ ...snapshot("e1:9", []), tasks: [blockedTask(601)] });
    await settle();
    expect(FakeNotification.shown.length).toBe(1);

    // The next real transition alerts once more.
    s.send("task.updated", "e1:10", mkTask(601));
    s.send("task.updated", "e1:11", blockedTask(601));
    s.send("task.blocked", "e1:12", transition(601, "open"));
    await settle();
    expect(FakeNotification.shown.length).toBe(2);
  });

  test("an undecided permission is requested instead of alerting; denied stays silent", async () => {
    live = liveSource();
    const s = live;
    s.ready("e1:1");
    await settle();
    workspaceCalls[0].resolve(snapshot("e1:1", [602]));
    await settle();
    FakeNotification.permission = "default";
    s.send("task.blocked", "e1:2", transition(602, "open"));
    await settle();
    expect(FakeNotification.shown).toEqual([]);
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    FakeNotification.permission = "denied";
    s.send("task.blocked", "e1:3", transition(602, "review"));
    await settle();
    expect(FakeNotification.shown).toEqual([]);
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Snapshots and task drafts
// ---------------------------------------------------------------------------

describe("state/refresh snapshots reach task drafts only through the draft (N8)", () => {
  // TaskDocument hands the ACTIVE task to its draft; this probe does the same.
  const probe: { current: TaskDraft | null } = { current: null };
  const idleScheduler: Scheduler = { schedule: () => 0, clear: () => {} }; // autosave never fires
  function DraftOwner({ task }: { task: Task }): null {
    probe.current = useTaskDraft(task, idleScheduler);
    return null;
  }
  function ActiveDraft(): ComponentChild {
    const at = activeTask.value;
    return at ? h(DraftOwner, { key: at.id, task: at }) : null;
  }
  const draft = (): TaskDraft => {
    if (!probe.current) throw new Error("no draft mounted");
    return probe.current;
  };
  const drafted = (over: Partial<Task> = {}): Task => ({ ...mkTask(81), title: "drafted", body: "base", ...over });
  const stateOf = (task: Task, body: string, status = "s-1"): TaskStateSnapshot => ({
    task,
    updates: [],
    versions: { entity: `e-${body}-${status}`, title: "t-1", body: `b-${body}`, status },
    cursor: "e1:1",
  });
  let live: ReturnType<typeof liveSource> | null = null;
  // A snapshot re-renders the document outside any event handler; act()
  // flushes the effects that follow (a browser runs them on the next frame).
  const applied = (work: () => void): Promise<void> =>
    act(async () => {
      work();
      await settle();
    });

  beforeEach(() => {
    workspaceCalls.length = 0;
    notificationCalls.length = 0;
    stateReads.length = 0;
    draftWrites.length = 0;
    draftStates.clear();
    pruneTaskDrafts([]);
    probe.current = null;
    tasks.value = [];
    notifications.value = [];
    selectedId.value = null;
  });
  afterEach(() => {
    live?.detach();
    live = null;
  });

  test("a snapshot changing a drafted field never overwrites typing: both versions are kept, nothing is written", async () => {
    live = liveSource();
    const s = live;
    s.ready("e1:1");
    await settle();
    draftStates.set(81, stateOf(drafted(), "base"));
    workspaceCalls[0].resolve({ ...snapshot("e1:1", []), tasks: [drafted()] });
    await settle();
    selectedId.value = 81;
    render(h(ActiveDraft, {}));
    await settle();
    expect(draft().ready).toBe(true);
    draft().set("body", "typed in the browser");

    // Another writer (another window) saves the body; the stream reports it and the next snapshot carries it.
    const theirs = drafted({ body: "from another window" });
    draftStates.set(81, stateOf(theirs, "from another window"));
    s.send("task.updated", "e1:2", theirs);
    await settle();
    expect(workspaceCalls.length).toBe(2);
    await applied(() => workspaceCalls[1].resolve({ ...snapshot("e1:2", []), tasks: [theirs] }));
    await settle();
    expect(tasks.value[0].body).toBe("from another window"); // the list shows the daemon's text…
    expect(draft().body).toBe("typed in the browser"); // …the draft keeps the typing…
    expect(draft().external.body).toBe("from another window"); // …and shows the incoming version beside it
    expect(draftWrites).toEqual([]); // applying snapshots never writes

    // A metadata-only snapshot (status) is not a title/body change: no read, no new conflict.
    const reads = stateReads.length;
    const blocked = { ...theirs, status: "review" as const };
    draftStates.set(81, stateOf(blocked, "from another window", "s-2"));
    s.send("task.updated", "e1:3", blocked);
    await settle();
    await applied(() => workspaceCalls[2].resolve({ ...snapshot("e1:3", []), tasks: [blocked] }));
    await settle();
    expect(tasks.value[0].status).toBe("review");
    expect(stateReads.length).toBe(reads);
    expect(draft().body).toBe("typed in the browser");
    expect(draft().external.body).toBe("from another window");
    expect(draftWrites).toEqual([]);
  });
});
