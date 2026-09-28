import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Component, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import type {
  BlockedTransition,
  CortexClient,
  DaemonIdentity,
  LiveEvent,
  WorkspaceSnapshot,
} from "../../../src/contracts.ts";
import type { Notification, Task } from "../../../src/store.ts";
import { DEFAULT_CONFIG } from "../../../src/tui/config.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";
import {
  countUnread,
  createNotifications,
  type LocalError,
  mergeFeed,
  type Notifications,
} from "../../../src/tui/notifications.ts";
import { openPreferences } from "../../../src/tui/preferences.ts";
import { type OverlayHost, TuiSession } from "../../../src/tui/session.ts";
import { resolveTheme } from "../../../src/tui/theme.ts";

// Plan @400 Task 11 part B (P8, N12, N15): the web's bell drawer
// (src/ui/state/notifications.ts, NotificationDrawer.tsx) for one terminal
// session. The feed merges the daemon's persisted notifications with this
// session's own errors, unread first and newest first inside each group (the
// web's order). Read state is SHARED (read, unread, all read, dismiss and
// clear go to the daemon and every client re-reads on notification.changed);
// errors and the highlighted row are the session's. Attention (a status flash
// by default, the terminal bell when enabled) follows ONLY the daemon's
// explicit task.blocked transition frame: never a snapshot, a reconnect or a
// task.updated copy of an already-blocked task.

const DB = "0b6a2f4e-0c1d-4e5f-8a9b-1c2d3e4f5a6b";
const IDENTITY: DaemonIdentity = {
  protocol: 1,
  instanceId: "instance-1",
  databaseId: DB,
  databasePath: "/tmp/cortex.db",
  endpoint: { kind: "unix", socketPath: "/tmp/cortex-x.sock" },
  pid: 4242,
};

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body: null,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  ...over,
});

const notif = (id: number, created: number, over: Partial<Notification> = {}): Notification => ({
  id,
  task_id: id,
  author: "pi-agent",
  status: "open",
  title: `[${id}] task ${id}`,
  message: "created",
  read: false,
  created,
  ...over,
});

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(err: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Every notifications read and acknowledgement waits until the test answers it. */
function fakeClient(snapshot: WorkspaceSnapshot) {
  const reads: Deferred<Notification[]>[] = [];
  const acks: { call: string; answer: Deferred<void> }[] = [];
  let workspaces = 0;
  const ack = (call: string) => {
    const answer = deferred<void>();
    acks.push({ call, answer });
    return answer.promise;
  };
  const client = {
    workspace: async () => {
      workspaces++;
      return snapshot;
    },
    notifications: () => {
      const answer = deferred<Notification[]>();
      reads.push(answer);
      return answer.promise;
    },
    markNotifRead: (id: number) => ack(`read ${id}`),
    markNotifUnread: (id: number) => ack(`unread ${id}`),
    markAllNotifRead: () => ack("read-all"),
    delNotif: (id: number) => ack(`dismiss ${id}`),
    clearNotifs: () => ack("clear"),
  };
  return { client: client as unknown as CortexClient, reads, acks, workspaces: () => workspaces };
}

/** The toolkit's overlay stack, reduced to what dialogs rely on. */
function fakeHost(columns = 100, rows = 30) {
  const stack: { component: Component; options: OverlayOptions | undefined }[] = [];
  const host: OverlayHost = {
    columns: () => columns,
    rows: () => rows,
    showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
      const entry = { component, options };
      stack.push(entry);
      return {
        hide: () => {
          const at = stack.indexOf(entry);
          if (at >= 0) stack.splice(at, 1);
        },
        setHidden: () => {},
        isHidden: () => false,
        focus: () => {},
        unfocus: () => {},
        isFocused: () => stack.at(-1) === entry,
        getBounds: () => undefined,
      };
    },
  };
  return { host, stack };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-notifications-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const plain = (lines: readonly string[]): string => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

function setup(
  options: { notifications?: Notification[]; tasks?: Task[]; bell?: boolean; flash?: boolean; now?: number } = {},
) {
  const snapshot: WorkspaceSnapshot = {
    identity: IDENTITY,
    cursor: "e:1",
    tasks: options.tasks ?? [task(1), task(2), task(3, { status: "blocked" })],
    lanes: [],
    tags: [],
    notifications: options.notifications ?? [],
  };
  const fake = fakeClient(snapshot);
  const session = new TuiSession({
    client: fake.client,
    identity: IDENTITY,
    keys: DEFAULT_KEYS,
    preferences: openPreferences(path.join(dir, "tui", "default.state.json")),
    schedule: () => () => {},
    now: () => options.now ?? 5000,
  });
  session.applySnapshot(snapshot);
  session.setTheme(resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" } }));
  const overlays = fakeHost();
  session.setOverlayHost(overlays.host);
  const written: string[] = [];
  const feed: Notifications = createNotifications(session, {
    bell: options.bell ?? false,
    flash: options.flash ?? true,
    write: data => written.push(data),
  });
  let seq = 100;
  const frame = (kind: LiveEvent["kind"], payload: unknown, cursor = `e:${++seq}`) =>
    session.receive({ kind, cursor, payload } as LiveEvent);
  const type = (...inputs: string[]) => {
    for (const input of inputs) session.input(input);
  };
  /** The notifications dialog's frame (the top overlay). */
  const dialog = (width = 90): string => plain(overlays.stack.at(-1)?.component.render(width) ?? []);
  const order = () => feed.feed().map(r => (r.kind === "notif" ? `n${r.row.id}` : `e${r.row.id}`));
  return { session, feed, fake, overlays, frame, type, dialog, order, written, snapshot };
}

const blocked = (t: Task, author = "pi-agent"): BlockedTransition => ({
  task: { ...t, status: "blocked" },
  previous: t.status,
  author,
});

describe("the merged feed (the web's order and count)", () => {
  const err = (id: number, at: number, read = false): LocalError => ({ id, text: `error ${id}`, at, read });

  test("unread first, then newest first inside each group, across persisted rows and local errors", () => {
    const rows = mergeFeed(
      [notif(1, 1000), notif(2, 4000), notif(3, 2000, { read: true }), notif(4, 6000, { read: true })],
      [err(-1, 5000), err(-2, 7000, true)],
    );
    expect(rows.map(r => (r.kind === "notif" ? `n${r.row.id}` : `e${r.row.id}`))).toEqual([
      "e-1",
      "n2",
      "n1",
      "e-2",
      "n4",
      "n3",
    ]);
    expect(countUnread(rows)).toBe(3);
  });

  test("an empty feed counts nothing", () => {
    expect(mergeFeed([], [])).toEqual([]);
    expect(countUnread([])).toBe(0);
  });
});

describe("persisted notifications and local errors (P8)", () => {
  test("the feed shows the snapshot's notifications and this session's errors; only errors become local rows", () => {
    const h = setup({ notifications: [notif(1, 1000), notif(2, 3000, { read: true })] });
    h.session.notify("info", "just a notice");
    h.session.notify("warn", "a warning");
    h.session.notify("error", "Could not reach the daemon");
    expect(h.order()).toEqual(["e-1", "n1", "n2"]);
    expect(h.feed.unread()).toBe(2);
    const local = h.feed.feed()[0];
    expect(local?.kind).toBe("error");
    expect(local?.kind === "error" ? local.row.text : "").toBe("Could not reach the daemon");
  });

  test("a notification.added frame prepends its row once; the count follows", () => {
    const h = setup({ notifications: [notif(1, 1000)] });
    h.frame("notification.added", notif(2, 2000, { status: "blocked" }));
    h.frame("notification.added", notif(2, 2000, { status: "blocked" }));
    expect(h.order()).toEqual(["n2", "n1"]);
    expect(h.feed.unread()).toBe(2);
  });

  test("read, unread, all read, dismiss and clear go to the daemon and show at once; errors stay local", async () => {
    const h = setup({ notifications: [notif(1, 1000), notif(2, 2000)] });
    h.session.notify("error", "boom");
    h.feed.markRead(1);
    expect(h.feed.feed().find(r => r.kind === "notif" && r.row.id === 1)?.row.read).toBe(true);
    h.feed.markUnread(1);
    expect(h.feed.feed().find(r => r.kind === "notif" && r.row.id === 1)?.row.read).toBe(false);
    h.feed.markRead(-1); // the local error: never sent
    expect(h.feed.unread()).toBe(2);
    h.feed.dismiss(2);
    expect(h.order()).toEqual(["n1", "e-1"]);
    h.feed.markAllRead();
    expect(h.feed.unread()).toBe(0);
    h.feed.clearAll();
    expect(h.feed.feed()).toEqual([]);
    expect(h.fake.acks.map(a => a.call)).toEqual(["read 1", "unread 1", "dismiss 2", "read-all", "clear"]);
    for (const a of h.fake.acks) a.answer.resolve();
    await settle();
    expect(h.fake.reads.length).toBe(0); // nothing to reconcile: every acknowledgement landed
  });

  test("dismissing a local error removes it without a request", () => {
    const h = setup();
    h.session.notify("error", "first");
    h.session.notify("error", "second");
    const second = h.feed.feed()[0];
    expect(second?.kind === "error" ? second.row.text : "").toBe("second");
    h.feed.dismiss(second?.row.id ?? 0);
    expect(h.feed.feed().map(r => (r.kind === "error" ? r.row.text : ""))).toEqual(["first"]);
    expect(h.fake.acks).toEqual([]);
  });

  test("a failed acknowledgement is reported as an error and re-read, so the feed shows the daemon's state", async () => {
    const h = setup({ notifications: [notif(1, 1000)] });
    h.feed.markRead(1);
    expect(h.feed.unread()).toBe(0);
    h.fake.acks[0]?.answer.reject(new Error("socket hung up"));
    await settle();
    expect(h.session.status?.level).toBe("error");
    expect(h.session.status?.text).toContain("socket hung up");
    expect(h.fake.reads.length).toBe(1);
    h.fake.reads[0]?.resolve([notif(1, 1000)]);
    await settle();
    // The daemon still has it unread; the failure is a local error row beside it.
    const persisted = h.feed.feed().find(r => r.kind === "notif");
    expect(persisted?.row.read).toBe(false);
    expect(h.feed.feed().some(r => r.kind === "error" && r.row.text.includes("socket hung up"))).toBe(true);
  });
});

describe("shared read state converges through notification.changed (N12)", () => {
  test("notification.changed re-reads ONLY the notifications (no workspace snapshot)", async () => {
    const h = setup({ notifications: [notif(1, 1000)] });
    const before = h.fake.workspaces();
    h.frame("notification.changed", { action: "read", id: 1, task_id: null });
    expect(h.fake.reads.length).toBe(1);
    h.fake.reads[0]?.resolve([notif(1, 1000, { read: true })]);
    await settle();
    expect(h.feed.unread()).toBe(0);
    expect(h.fake.workspaces()).toBe(before);
  });

  test("a burst coalesces into one read in flight plus ONE trailing read; the overtaken answer is dropped", async () => {
    const h = setup({ notifications: [notif(1, 1000), notif(2, 2000)] });
    h.frame("notification.changed", { action: "read", id: 1, task_id: null });
    h.frame("notification.changed", { action: "read", id: 2, task_id: null });
    h.frame("notification.changed", { action: "dismiss", id: 2, task_id: null });
    expect(h.fake.reads.length).toBe(1);
    // The first answer predates the later changes: dropped, then one more read.
    h.fake.reads[0]?.resolve([notif(1, 1000, { read: true }), notif(2, 2000)]);
    await settle();
    expect(h.feed.unread()).toBe(2);
    expect(h.fake.reads.length).toBe(2);
    h.fake.reads[1]?.resolve([notif(1, 1000, { read: true })]);
    await settle();
    expect(h.order()).toEqual(["n1"]);
    expect(h.feed.unread()).toBe(0);
  });

  test("a read in flight when this session acknowledges never undoes the acknowledgement; a read after it confirms", async () => {
    const h = setup({ notifications: [notif(1, 1000), notif(2, 2000)] });
    h.frame("notification.changed", { action: "read", id: 2, task_id: null }); // another client
    h.feed.markRead(1);
    // The read began before our acknowledgement: its answer is obsolete.
    h.fake.reads[0]?.resolve([notif(1, 1000), notif(2, 2000, { read: true })]);
    await settle();
    expect(h.feed.feed().find(r => r.row.id === 1)?.row.read).toBe(true);
    expect(h.fake.reads.length).toBe(1); // reads wait while the acknowledgement is in flight
    h.fake.acks[0]?.answer.resolve();
    await settle();
    expect(h.fake.reads.length).toBe(2);
    h.fake.reads[1]?.resolve([notif(1, 1000, { read: true }), notif(2, 2000, { read: true })]);
    await settle();
    expect(h.feed.unread()).toBe(0);
  });

  test("a snapshot that lands while an acknowledgement is in flight keeps it shown until a later read confirms", async () => {
    const h = setup({ notifications: [notif(1, 1000)] });
    h.feed.markRead(1);
    h.session.applySnapshot({ ...h.snapshot, cursor: "e:50", notifications: [notif(1, 1000)] });
    expect(h.feed.unread()).toBe(0);
    h.fake.acks[0]?.answer.resolve();
    await settle();
    expect(h.fake.reads.length).toBe(1);
    h.fake.reads[0]?.resolve([notif(1, 1000, { read: true })]);
    await settle();
    expect(h.feed.unread()).toBe(0);
  });
});

describe(":notifications (the bell drawer as a keyboard-complete dialog)", () => {
  test("opens the feed unread first with text marks; r u a x X act on the highlighted row or all", async () => {
    const h = setup({
      notifications: [
        notif(1, 1000, { title: "[1] task 1", message: "created" }),
        notif(2, 2000, { title: "[2] task 2", message: "open → review", status: "review", read: true }),
      ],
    });
    await h.session.execute("notifications");
    let text = h.dialog();
    expect(text).toContain("NOTIFICATIONS");
    expect(text).toContain("1 unread");
    expect(text).toMatch(/✉[^\n]*\[1\] task 1/);
    expect(text).toContain("open → review");
    expect(text.indexOf("[1] task 1")).toBeLessThan(text.indexOf("[2] task 2"));
    h.type("r"); // the highlighted (first) row
    expect(h.fake.acks.map(a => a.call)).toEqual(["read 1"]);
    h.type("u");
    expect(h.fake.acks.map(a => a.call)).toEqual(["read 1", "unread 1"]);
    h.type("x");
    expect(h.fake.acks.at(-1)?.call).toBe("dismiss 1");
    h.type("a");
    expect(h.fake.acks.at(-1)?.call).toBe("read-all");
    h.type("X");
    expect(h.fake.acks.at(-1)?.call).toBe("clear");
    text = h.dialog();
    expect(text).toContain("No notifications");
  });

  test("Enter opens the row's task (filters untouched, :back returns) and marks it read, closing the dialog", async () => {
    const h = setup({ notifications: [notif(2, 2000, { task_id: 2, title: "[2] task 2" })] });
    h.session.setQuery("task");
    h.session.select(1);
    await h.session.execute("notifications");
    h.type("\r");
    expect(h.session.selectedId).toBe(2);
    expect(h.session.query).toBe("task");
    expect(h.overlays.stack.length).toBe(0);
    expect(h.fake.acks.map(a => a.call)).toEqual(["read 2"]);
    h.session.back();
    expect(h.session.selectedId).toBe(1);
  });

  test("a row whose task is gone says so and is still marked read; an error row is marked read locally", async () => {
    const h = setup({ notifications: [notif(9, 2000, { task_id: 9, title: "[9] gone" })] });
    await h.session.execute("notifications");
    h.type("\r");
    expect(h.session.status?.text).toContain("@9 no longer exists");
    expect(h.fake.acks.map(a => a.call)).toEqual(["read 9"]);
    h.session.notify("error", "local failure");
    await h.session.execute("notifications");
    h.type("\r");
    expect(h.feed.feed().find(r => r.kind === "error")?.row.read).toBe(true);
    expect(h.fake.acks.length).toBe(1);
  });

  test(":notifications takes no argument", async () => {
    const h = setup();
    await h.session.execute("notifications now");
    expect(h.session.status?.level).toBe("error");
    expect(h.overlays.stack.length).toBe(0);
  });
});

describe("attention only for blocked transitions (P8)", () => {
  test("task.blocked flashes the status line by default (no bell); the bell rings only when enabled", () => {
    const h = setup();
    h.frame("task.blocked", blocked(task(2, { title: "needs a decision" })));
    expect(h.session.status?.level).toBe("warn");
    expect(h.session.status?.text).toContain("@2");
    expect(h.session.status?.text).toContain("blocked");
    expect(h.session.status?.text).toContain("needs a decision");
    expect(h.written).toEqual([]);
    const loud = setup({ bell: true });
    loud.frame("task.blocked", blocked(task(1)));
    expect(loud.written).toEqual(["\x07"]);
  });

  test("off entirely when both are disabled", () => {
    const h = setup({ bell: false, flash: false });
    h.frame("task.blocked", blocked(task(2)));
    expect(h.session.status).toBeNull();
    expect(h.written).toEqual([]);
  });

  test("never for a snapshot, a reconnect, or edits to an already-blocked task; a duplicate frame alerts once", () => {
    const h = setup({ bell: true });
    // Snapshots (a reconnect resnapshots) with blocked tasks and blocked notifications: silent.
    h.session.applySnapshot({
      ...h.snapshot,
      cursor: "e:60",
      tasks: [task(1, { status: "blocked" }), task(3, { status: "blocked" })],
      notifications: [notif(3, 3000, { status: "blocked" })],
    });
    h.session.receive({
      kind: "ready",
      cursor: "e:60",
      payload: { cursor: "e:60", epoch: "e", instanceId: "instance-1", databaseId: DB },
    } as LiveEvent);
    // A body edit on a task that is (still) blocked publishes task.updated only.
    h.frame("task.updated", task(3, { status: "blocked", body: "more detail" }));
    h.frame("task.updated", task(1, { status: "blocked", title: "renamed" }));
    expect(h.written).toEqual([]);
    expect(h.session.status).toBeNull();
    // The one explicit transition frame, delivered twice: one alert.
    h.frame("task.blocked", blocked(task(2)), "e:70");
    h.frame("task.blocked", blocked(task(2)), "e:70");
    expect(h.written).toEqual(["\x07"]);
  });
});
