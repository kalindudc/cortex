// lib/closeGuard.ts — the renderer half of the desktop close guard: it
// reports the unsaved-draft counts to main on every change, answers main's
// Save all by saving every mounted draft, and turns unsaved drafts into
// orphans when the app is connected to another database. `window.cortex` is
// a fake that records what the renderer sends; the live stream is a plain
// EventTarget wired through the real connectLive.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { TaskStateSnapshot, TaskWriteResult, WorkspaceSnapshot } from "../../../src/contracts.ts";
import type { DraftReport } from "../../../src/desktop/ipc.ts";
import type { Task } from "../../../src/ui/api/types.ts";

const mkTask = (id: number, body = "base"): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  memory_excluded: false,
});

// How the next guarded write answers: "ok" commits it, anything else fails it.
let writeOutcome: "ok" | "fail" = "ok";
let bodyToken = 1;
const workspaceIds: number[][] = [];
let cursor = "e1:1";

mock.module("../../../src/ui/api/client.ts", () => ({
  api: {
    taskState: mock(
      (id: number): Promise<TaskStateSnapshot> =>
        Promise.resolve({
          task: mkTask(id),
          updates: [],
          versions: { title: `title-${id}`, body: `body-${bodyToken}` },
          cursor: "e1:1",
        }),
    ),
    versioned: {
      editTask: mock((id: number, patch: { body?: string | null }): Promise<TaskWriteResult> => {
        if (writeOutcome !== "ok") return Promise.reject(new Error("offline"));
        bodyToken++;
        return Promise.resolve({
          task: mkTask(id, patch.body ?? ""),
          versions: { title: `title-${id}`, body: `body-${bodyToken}` },
          replayed: false,
        });
      }),
    },
    workspace: mock(
      (): Promise<WorkspaceSnapshot> =>
        Promise.resolve({
          identity: null,
          cursor,
          tasks: (workspaceIds.shift() ?? []).map(id => mkTask(id)),
          lanes: [],
          tags: [],
          notifications: [],
        }),
    ),
    notifications: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    related: mock(() => Promise.resolve({ referencedBy: [], references: [], shared: [] })),
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
  },
}));
mock.module("../../../src/ui/api/errors.ts", () => ({
  tryApi: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  showError: () => {},
}));

import { render } from "@testing-library/preact";
import { h } from "preact";
import { startCloseGuard } from "../../../src/ui/lib/closeGuard.ts";
import {
  discardOrphan,
  orphanedDrafts,
  pruneTaskDrafts,
  useTaskDraft,
  type TaskDraft,
} from "../../../src/ui/lib/useTaskDraft.ts";
import { connectLive } from "../../../src/ui/state/refresh.ts";

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await tick();
};

const reports: DraftReport[] = [];
let saveAll: (() => Promise<DraftReport>) | null = null;
let release: (() => void) | null = null;
const lastReport = (): DraftReport | undefined => reports.at(-1);

let draftRef: TaskDraft | null = null;
function Harness({ task }: { task: Task }): null {
  draftRef = useTaskDraft(task);
  return null;
}
const draft = (): TaskDraft => {
  if (!draftRef) throw new Error("harness not mounted");
  return draftRef;
};

const source = new EventTarget();
/** A (re)connection: every one starts a new epoch, so it takes a new snapshot. */
let epoch = 0;
const ready = (databaseId: string): void => {
  source.dispatchEvent(new Event("error"));
  cursor = `e${++epoch}:1`;
  source.dispatchEvent(
    new MessageEvent("ready", {
      lastEventId: cursor,
      data: JSON.stringify({ cursor, epoch: `e${epoch}`, instanceId: null, databaseId }),
    }),
  );
};

let stopGuard: () => void = () => {};
let stopLive: () => void = () => {};
const w = window as unknown as { cortex?: unknown };
const previousBridge = w.cortex;

beforeAll(() => {
  pruneTaskDrafts([]);
  for (const o of orphanedDrafts.value) discardOrphan(o.taskId, o.field);
  w.cortex = {
    drafts: {
      report: (state: DraftReport) => reports.push({ ...state }),
      onSaveAll: (handler: () => Promise<DraftReport>) => {
        saveAll = handler;
        return () => {
          saveAll = null;
        };
      },
      onRelease: (handler: () => void) => {
        release = handler;
        return () => {
          release = null;
        };
      },
      export: async () => ({ saved: false }),
    },
  };
  stopGuard = startCloseGuard();
  stopLive = connectLive(source, { coalesceMs: 0 });
});
afterAll(() => {
  stopLive();
  stopGuard();
  w.cortex = previousBridge;
});

describe("startCloseGuard", () => {
  test("reports the counts at once and registers the Save all handler", () => {
    expect(lastReport()).toEqual({ dirty: 0, orphaned: 0 });
    expect(saveAll).not.toBeNull();
  });

  test("a dirty draft reports dirty 1; Save all flushes it and answers dirty 0", async () => {
    workspaceIds.push([61]);
    ready("close-guard-db-1");
    await settle();
    render(h(Harness, { task: mkTask(61) }));
    await settle();
    expect(draft().ready).toBe(true);
    draft().set("body", "typed");
    expect(lastReport()).toEqual({ dirty: 1, orphaned: 0 });
    writeOutcome = "ok";
    const answer = await (saveAll as () => Promise<DraftReport>)();
    expect(answer).toEqual({ dirty: 0, orphaned: 0 });
    expect(lastReport()).toEqual({ dirty: 0, orphaned: 0 });
    expect(draft().saveState).toBe("saved");
  });

  test("an unmounted draft whose save failed stays dirty, and Save all cannot clear it", async () => {
    workspaceIds.push([61, 62]);
    ready("close-guard-db-1"); // a reconnect to the same database: task 62 is live
    await settle();
    const view = render(h(Harness, { task: mkTask(62) }));
    await settle();
    draft().set("body", "will fail");
    writeOutcome = "fail";
    await draft().flush();
    view.unmount();
    await settle();
    expect(lastReport()).toEqual({ dirty: 1, orphaned: 0 });
    expect(await (saveAll as () => Promise<DraftReport>)()).toEqual({ dirty: 1, orphaned: 0 });
  });

  test("a database change turns the dirty draft into an orphan", async () => {
    workspaceIds.push([62]);
    ready("close-guard-db-2");
    await settle();
    expect(lastReport()).toEqual({ dirty: 0, orphaned: 1 });
    expect(orphanedDrafts.value).toEqual([{ taskId: 62, field: "body", text: "will fail" }]);
    discardOrphan(62, "body");
    expect(lastReport()).toEqual({ dirty: 0, orphaned: 0 });
  });

  test("a release from main stops the beforeunload warning, even with a dirty draft", async () => {
    const unloadPrevented = (): boolean => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const view = render(h(Harness, { task: mkTask(63) }));
    await settle();
    draft().set("body", "still dirty");
    expect(lastReport()).toEqual({ dirty: 1, orphaned: 0 });
    expect(unloadPrevented()).toBe(true);
    (release as () => void)();
    expect(unloadPrevented()).toBe(false);
    draft().set("body", "dirtier");
    expect(unloadPrevented()).toBe(false);
    // The test/ui files share one process: leave no draft behind.
    view.unmount();
    pruneTaskDrafts([]);
    for (const o of orphanedDrafts.value) discardOrphan(o.taskId, o.field);
  });

  test("the disposer stops reporting and unregisters Save all and release", () => {
    stopGuard();
    stopGuard = () => {};
    expect(saveAll).toBeNull();
    expect(release).toBeNull();
    const count = reports.length;
    pruneTaskDrafts([]);
    expect(reports.length).toBe(count);
  });
});
