import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Component, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import { HttpError, TransportError } from "../../../src/api.ts";
import type {
  CortexClient,
  DaemonIdentity,
  LiveEvent,
  PostUpdateRequest,
  PostUpdateResult,
  WorkspaceSnapshot,
  WriteGuard,
} from "../../../src/contracts.ts";
import type { RelatedTasks, Task, Update } from "../../../src/store.ts";
import { type Activity, createActivity, MAX_SUMMARY, RELATED_COALESCE_MS } from "../../../src/tui/activity.ts";
import { DEFAULT_CONFIG } from "../../../src/tui/config.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";
import { openPreferences } from "../../../src/tui/preferences.ts";
import { type OverlayHost, type SessionOptions, TuiSession } from "../../../src/tui/session.ts";
import { resolveTheme } from "../../../src/tui/theme.ts";

// Plan @400 Task 11 part A (P7, N9, N16, N17): the task panels and the update
// composer. Activity lists the selected task's updates newest first (keyed by
// update id: the cursor and the expanded cards survive live churn), each
// expandable to its body rendered by the terminal reader plus its Markdown
// source; Related has loading, a task-keyed error with an explicit retry, a
// confirmed empty and the three buckets; Authors is the per-task rollup. The
// composer is explicit-submit only: the author and text are captured at
// submit, one request is in flight, an identical retry reuses its mutation id,
// the 4096 limit has a visible count, failures and newer typing are kept, the
// draft clears only when the post of its exact revision is acknowledged, and
// the post is a human's (an author, no notify, no status), as the web's.

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

const MINUTE = 60_000;
const PI_AUTHOR = "pi-0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const update = (id: number, taskId: number, over: Partial<Update> = {}): Update => ({
  id,
  task_id: taskId,
  author: "alice",
  summary: `update ${id}`,
  body: null,
  severity: "progress",
  created: Date.now() - 60 * MINUTE,
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

/** Every read and post waits until the test answers it. */
function fakeClient(snapshot: WorkspaceSnapshot) {
  const reads: { id: number; answer: Deferred<Update[]> }[] = [];
  const relatedReads: { id: number; answer: Deferred<RelatedTasks> }[] = [];
  const posts: {
    id: number;
    request: PostUpdateRequest;
    guard: WriteGuard | undefined;
    answer: Deferred<PostUpdateResult>;
  }[] = [];
  const state = { me: "kalindu", meCalls: 0 };
  const client = {
    workspace: async () => snapshot,
    updates: (id: number) => {
      const answer = deferred<Update[]>();
      reads.push({ id, answer });
      return answer.promise;
    },
    related: (id: number) => {
      const answer = deferred<RelatedTasks>();
      relatedReads.push({ id, answer });
      return answer.promise;
    },
    me: async () => {
      state.meCalls++;
      return { author: state.me };
    },
    versioned: {
      postUpdate: (id: number, request: PostUpdateRequest, guard?: WriteGuard) => {
        const answer = deferred<PostUpdateResult>();
        posts.push({ id, request, guard, answer });
        return answer.promise;
      },
    },
  };
  return { client: client as unknown as CortexClient, reads, relatedReads, posts, state };
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-activity-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** A manual scheduler: timers run only when the test flushes them. */
function manualClock() {
  let timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    pending: () => timers.filter(t => !t.cancelled).map(t => t.ms),
    flush: () => {
      const due = timers.filter(t => !t.cancelled);
      timers = [];
      for (const t of due) t.fn();
    },
  };
}

/** The Related coalescing windows pending (the session also schedules its preference saves). */
const windows = (clock: ReturnType<typeof manualClock>): number[] =>
  clock.pending().filter(ms => ms === RELATED_COALESCE_MS);
const plain = (lines: readonly string[]): string => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

function setup(
  tasks: Task[] = [task(1), task(2)],
  schedule: (fn: () => void, ms: number) => () => void = () => () => {},
  options: Partial<SessionOptions> = {},
) {
  const snapshot: WorkspaceSnapshot = {
    identity: IDENTITY,
    cursor: "e:1",
    tasks,
    lanes: [],
    tags: [],
    notifications: [],
  };
  const fake = fakeClient(snapshot);
  const quits: boolean[] = [];
  const session = new TuiSession({
    client: fake.client,
    identity: IDENTITY,
    keys: DEFAULT_KEYS,
    preferences: openPreferences(path.join(dir, "tui", "default.state.json")),
    schedule,
    onQuit: force => quits.push(force),
    ...options,
  });
  session.applySnapshot(snapshot);
  session.setTheme(resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" } }));
  const overlays = fakeHost();
  session.setOverlayHost(overlays.host);
  const activity: Activity = createActivity(session);
  activity.height = 40;
  const view = (width = 90): string => plain(activity.render(width));
  const type = (...inputs: string[]) => {
    for (const input of inputs) session.input(input);
  };
  /** The composer's frame (the top overlay). */
  const composer = (width = 76): string => plain(overlays.stack.at(-1)?.component.render(width) ?? []);
  // Frames after every snapshot a test applies (the session ignores frames its snapshot covers).
  let seq = 100;
  const frame = (kind: LiveEvent["kind"], payload: unknown) =>
    session.receive({ kind, cursor: `e:${++seq}`, payload } as LiveEvent);
  const posted = (u: Update) => frame("update.posted", u);
  const ack = (i: number, u: Update, replayed = false) => {
    const post = fake.posts[i];
    if (post === undefined) throw new Error(`no post ${i}`);
    post.answer.resolve({ update: u, audit: null, task: task(u.task_id), versions: {}, replayed });
  };
  return { session, activity, fake, overlays, view, type, composer, frame, posted, ack, quits, snapshot };
}

/** Show a panel and answer its first thread read. */
async function showActivity(h: ReturnType<typeof setup>, updates: Update[]) {
  await h.session.execute("activity");
  h.view();
  const read = h.fake.reads.at(-1);
  if (read === undefined) throw new Error("the Activity panel did not read the thread");
  read.answer.resolve(updates);
  await settle();
}

describe("the Activity panel (P7)", () => {
  test(":activity shows the selected task's updates newest first: full author, relative time, severity label", async () => {
    const h = setup();
    await showActivity(h, [
      update(1, 1, { summary: "first note", created: Date.now() - 120 * MINUTE }),
      update(2, 1, {
        summary: "second note",
        created: Date.now() - 5 * MINUTE,
        severity: "blocked",
        author: PI_AUTHOR,
      }),
    ]);
    expect(h.session.panel).toBe("activity");
    expect(h.session.focus).toBe("document");
    expect(h.fake.reads.map(r => r.id)).toEqual([1]);
    const text = h.view();
    expect(text.indexOf("second note")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("second note")).toBeLessThan(text.indexOf("first note"));
    expect(text).toContain(PI_AUTHOR);
    expect(text).toContain("5m ago");
    expect(text).toContain("2h ago");
    // Severity is a label with a marker, never tint alone.
    expect(text).toMatch(/■ blocked/);
    expect(text).toMatch(/● progress/);
  });

  test("Enter expands a card: the body rendered by the terminal reader, its source behind :source; summary-only cards say so", async () => {
    const h = setup();
    await showActivity(h, [
      update(1, 1, { summary: "just a summary", created: Date.now() - 10 * MINUTE }),
      update(2, 1, { summary: "with body", body: "## Detail\n\nsome **text**", created: Date.now() - MINUTE }),
    ]);
    expect(h.view()).not.toContain("Detail");
    h.activity.activate(); // the cursor starts on the newest card
    let text = h.view();
    expect(text).toContain("Detail");
    expect(text).not.toContain("## Detail");
    expect(text).toContain("some text");
    expect(text).toContain(":source");
    await h.session.execute("source");
    text = h.view();
    expect(text).toContain("## Detail");
    expect(text).toContain("some **text**");
    h.activity.move(1);
    h.activity.activate();
    expect(h.view()).toContain("No body: the summary is the whole update");
  });

  test("hostile author, summary and body text cannot reach the terminal as controls", async () => {
    const h = setup();
    await showActivity(h, [
      update(1, 1, {
        author: "evil\x1b]52;c;AAAA\x07",
        summary: "boom\x1b[2J\x9b31m",
        body: "\x1b]8;;http://evil.example\x07click\x1b]8;;\x07",
      }),
    ]);
    h.activity.activate();
    const raw = h.activity.render(90).join("\n");
    expect(raw).not.toContain("\x1b]52");
    expect(raw).not.toContain("\x1b[2J");
    expect(raw).not.toContain("\x1b]8;;http://evil");
    expect(raw).not.toContain("\x9b");
    expect(plain([raw])).toContain("^[");
  });

  test("the cursor and expanded cards follow update ids through live frames; a frame is deduped by id", async () => {
    const h = setup();
    await showActivity(h, [update(7, 1, { summary: "keep me open", body: "content here" })]);
    h.activity.activate();
    expect(h.view()).toContain("content here");
    h.posted(update(8, 1, { summary: "new arrival", created: Date.now() }));
    h.posted(update(8, 1, { summary: "new arrival", created: Date.now() }));
    const text = h.view();
    expect(text.split("new arrival").length - 1).toBe(1);
    expect(text.indexOf("new arrival")).toBeLessThan(text.indexOf("keep me open"));
    // The expanded card is still expanded and still has the cursor.
    expect(text).toContain("content here");
    expect(text).toMatch(/▌▾ alice/);
    // A frame for another task never lands in this thread.
    h.posted(update(9, 2, { summary: "elsewhere" }));
    expect(h.view()).not.toContain("elsewhere");
  });

  test("loading, then a failure with an explicit retry (:activity), then a confirmed empty", async () => {
    const h = setup();
    await h.session.execute("activity");
    expect(h.view()).toContain("Loading the activity");
    h.fake.reads[0]?.answer.reject(new Error("daemon unavailable"));
    await settle();
    let text = h.view();
    expect(text).toContain("error: could not load the activity: daemon unavailable");
    expect(text).toContain(":activity retries");
    // Rendering never retries by itself.
    h.view();
    expect(h.fake.reads.length).toBe(1);
    await h.session.execute("activity");
    expect(h.fake.reads.length).toBe(2);
    h.fake.reads[1]?.answer.resolve([]);
    await settle();
    text = h.view();
    expect(text).toContain("No updates yet");
    expect(text).toContain("c posts one");
  });

  test("a slow answer for another task never shows under the current one", async () => {
    const h = setup();
    await h.session.execute("activity");
    h.view(); // reads task 1
    h.session.select(2);
    h.view(); // reads task 2
    expect(h.fake.reads.map(r => r.id)).toEqual([1, 2]);
    h.fake.reads[1]?.answer.resolve([update(20, 2, { summary: "task two note" })]);
    await settle();
    h.fake.reads[0]?.answer.resolve([update(10, 1, { summary: "task one note" })]);
    await settle();
    const text = h.view();
    expect(text).toContain("task two note");
    expect(text).not.toContain("task one note");
    // Task 1 keeps its own thread for when it is shown again (no second read).
    h.session.select(1);
    expect(h.view()).toContain("task one note");
    expect(h.fake.reads.length).toBe(2);
  });

  test("a snapshot re-reads the shown thread, and frames that land during the read are kept", async () => {
    const h = setup();
    await showActivity(h, [update(1, 1, { summary: "old" })]);
    h.session.applySnapshot({ ...h.snapshot, cursor: "e:9" });
    h.view();
    expect(h.fake.reads.length).toBe(2);
    h.posted({ ...update(3, 1, { summary: "arrived during the read" }) });
    // The read started before that frame: its answer lacks it, the frame is kept.
    h.fake.reads[1]?.answer.resolve([update(1, 1, { summary: "old" }), update(2, 1, { summary: "missed frame" })]);
    await settle();
    const text = h.view();
    expect(text).toContain("missed frame");
    expect(text).toContain("arrived during the read");
  });
});

describe("reconciling snapshots without re-reading everything (Task 11 part B)", () => {
  test("a catalog-only snapshot keeps every thread; a resync (frames may be missed) re-reads the shown one", async () => {
    const h = setup();
    await showActivity(h, [update(1, 1, { summary: "kept" })]);
    // lane.changed: a coalesced snapshot for the catalogs; no frame was missed.
    h.frame("lane.changed", { name: "now" });
    await h.session.snapshotNow();
    h.view();
    expect(h.fake.reads.length).toBe(1);
    h.frame("resync", { reason: "overflow", cursor: "e:200" });
    await settle();
    h.view();
    expect(h.fake.reads.length).toBe(2);
  });

  test("a post buffered during a catalog snapshot that covers it still joins a read thread, and a thread being read (review F9)", async () => {
    const h = setup();
    const workspace = h.fake.client as unknown as { workspace: () => Promise<WorkspaceSnapshot> };
    const answers: Deferred<WorkspaceSnapshot>[] = [];
    workspace.workspace = () => {
      const answer = deferred<WorkspaceSnapshot>();
      answers.push(answer);
      return answer.promise;
    };
    /** A lane change's snapshot is in flight while a post arrives; the daemon read it after the post. */
    const postDuringCatalogSnapshot = async (u: Update) => {
      h.frame("lane.changed", { name: "now" });
      const snapshotting = h.session.snapshotNow();
      h.posted(u); // buffered: the snapshot is in flight
      answers.at(-1)?.resolve({ ...h.snapshot, cursor: `e:${100 + answers.length * 2}` });
      await snapshotting;
    };
    // A thread already read: the snapshot (it has no updates) covers the post, which must still join it.
    await showActivity(h, [update(1, 1, { summary: "already read" })]);
    await postDuringCatalogSnapshot(update(2, 1, { summary: "posted during the snapshot" }));
    expect(h.view()).toContain("posted during the snapshot");
    expect(h.fake.reads.length).toBe(1); // without a re-read
    // A thread being read: the post is kept across a read that answers without it.
    h.session.select(2);
    h.view();
    expect(h.fake.reads.map(r => r.id)).toEqual([1, 2]);
    await postDuringCatalogSnapshot(update(3, 2, { summary: "posted while reading" }));
    h.fake.reads[1]?.answer.resolve([update(4, 2, { summary: "read before the post" })]);
    await settle();
    const text = h.view();
    expect(text).toContain("read before the post");
    expect(text).toContain("posted while reading");
    expect(h.fake.reads.length).toBe(2);
  });
});

describe("the Related panel (P7)", () => {
  const related = (over: Partial<RelatedTasks> = {}): RelatedTasks => ({
    referencedBy: [],
    references: [],
    shared: [],
    ...over,
  });

  test("loading is distinct from a confirmed empty, which names the three buckets", async () => {
    const h = setup();
    await h.session.execute("related");
    expect(h.session.panel).toBe("related");
    expect(h.view()).toContain("Loading related tasks");
    expect(h.fake.relatedReads.map(r => r.id)).toEqual([1]);
    h.fake.relatedReads[0]?.answer.resolve(related());
    await settle();
    const text = h.view();
    expect(text).not.toContain("Loading");
    expect(text).toContain("REFERENCED BY · 0");
    expect(text).toContain("REFERENCES · 0");
    expect(text).toContain("SHARED TAGS · 0");
    expect(text).toContain("no inbound references");
    expect(text).toContain("no outbound references");
    expect(text).toContain("no shared tags");
  });

  test("a failure is keyed to its task with an explicit retry; a stale answer for another task is discarded", async () => {
    const h = setup();
    await h.session.execute("related");
    h.view();
    h.fake.relatedReads[0]?.answer.reject(new Error("backend unavailable"));
    await settle();
    expect(h.view()).toContain("error: could not load related tasks: backend unavailable");
    expect(h.view()).toContain(":related retries");
    expect(h.fake.relatedReads.length).toBe(1);
    // Another task: its own read; task 1's error never shows there.
    h.session.select(2);
    let text = h.view();
    expect(text).not.toContain("backend unavailable");
    expect(text).toContain("Loading related tasks");
    // The retry for task 1 after switching back.
    h.session.select(1);
    await h.session.execute("related");
    expect(h.fake.relatedReads.map(r => r.id)).toEqual([1, 2, 1]);
    // Task 2's slow answer lands after the switch: never painted on task 1.
    h.fake.relatedReads[1]?.answer.resolve(related({ shared: [task(2, { title: "wrong task" })] }));
    await settle();
    text = h.view();
    expect(text).not.toContain("wrong task");
    expect(text).toContain("Loading related tasks");
    h.fake.relatedReads[2]?.answer.resolve(related({ references: [task(2, { title: "task two" })] }));
    await settle();
    expect(h.view()).toContain("[2] task two");
  });

  test("Related re-reads coalesce: a burst of changes while it is shown reads ONCE when the window closes", async () => {
    const clock = manualClock();
    const h = setup([task(1), task(2)], clock.schedule);
    await h.session.execute("related");
    h.view();
    h.fake.relatedReads[0]?.answer.resolve(related({ shared: [task(2, { title: "first answer" })] }));
    await settle();
    expect(h.view()).toContain("first answer");
    h.frame("task.updated", task(2, { title: "renamed" }));
    h.frame("task.updated", task(1, { body: "mentions @2" }));
    h.posted(update(7, 1, { summary: "see @2" }));
    // The answer shown stays until the window closes: no read per frame or per render.
    h.view();
    h.view();
    expect(h.fake.relatedReads.length).toBe(1);
    expect(windows(clock)).toEqual([RELATED_COALESCE_MS]);
    clock.flush();
    h.view();
    expect(h.fake.relatedReads.map(r => r.id)).toEqual([1, 1]);
    // A change while that read is in flight: one more read, after another window.
    h.frame("task.updated", task(2, { title: "again" }));
    h.fake.relatedReads[1]?.answer.resolve(related({ references: [task(2, { title: "second answer" })] }));
    await settle();
    h.view();
    expect(h.fake.relatedReads.length).toBe(2);
    clock.flush();
    h.view();
    expect(h.fake.relatedReads.length).toBe(3);
  });

  test("a window opened for one task never reads it after a switch; the switched-to task reads at once", async () => {
    const clock = manualClock();
    const h = setup([task(1), task(2)], clock.schedule);
    await h.session.execute("related");
    h.view();
    h.fake.relatedReads[0]?.answer.resolve(related({ shared: [task(2, { title: "for task 1" })] }));
    await settle();
    h.frame("task.updated", task(2, { title: "changed" }));
    expect(windows(clock)).toEqual([RELATED_COALESCE_MS]);
    h.session.select(2);
    h.view();
    expect(h.fake.relatedReads.map(r => r.id)).toEqual([1, 2]);
    clock.flush();
    h.view();
    expect(h.fake.relatedReads.map(r => r.id)).toEqual([1, 2]);
    h.fake.relatedReads[1]?.answer.resolve(related({ referencedBy: [task(1, { title: "for task 2" })] }));
    await settle();
    const text = h.view();
    expect(text).toContain("for task 2");
    expect(text).not.toContain("for task 1");
  });

  test("a hidden Related panel opens no window; it reads when shown again", async () => {
    const clock = manualClock();
    const h = setup([task(1), task(2)], clock.schedule);
    await h.session.execute("related");
    h.view();
    h.fake.relatedReads[0]?.answer.resolve(related());
    await settle();
    h.session.setPanel("document");
    h.frame("task.updated", task(2, { title: "changed" }));
    expect(windows(clock)).toEqual([]);
    await h.session.execute("related");
    h.view();
    expect(h.fake.relatedReads.length).toBe(2);
  });

  test("Enter follows a related task like an @id reference: the list filters clear", async () => {
    const h = setup([task(1), task(2, { title: "second task" })]);
    h.session.setQuery("task 1");
    await h.session.execute("related");
    h.view();
    h.fake.relatedReads[0]?.answer.resolve(related({ referencedBy: [task(2, { title: "second task" })] }));
    await settle();
    expect(h.view()).toMatch(/▌ \[2\] second task/);
    h.activity.activate();
    expect(h.session.selectedTask()?.id).toBe(2);
    expect(h.session.query).toBe("");
    expect(h.session.panel).toBe("related");
  });
});

describe("the Authors panel (P7)", () => {
  test("a per-task rollup: most recent first, with post counts", async () => {
    const h = setup();
    await h.session.execute("authors");
    expect(h.session.panel).toBe("authors");
    h.view();
    h.fake.reads[0]?.answer.resolve([
      update(1, 1, { author: "alice", created: Date.now() - 50 * MINUTE }),
      update(2, 1, { author: "alice", created: Date.now() - 3 * MINUTE }),
      update(3, 1, { author: "bob", created: Date.now() - 20 * MINUTE }),
    ]);
    await settle();
    const rows = h
      .view()
      .split("\n")
      .filter(l => /alice|bob/.test(l));
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatch(/alice\s+3m ago\s+2/);
    expect(rows[1]).toMatch(/bob\s+20m ago\s+1/);
  });

  test("[ and ] (session.cyclePanel) step Document → Activity → Related → Authors → Document", () => {
    const h = setup();
    expect(h.session.panel).toBe("document");
    h.session.cyclePanel(1);
    expect(h.session.panel).toBe("activity");
    h.session.cyclePanel(1);
    h.session.cyclePanel(1);
    expect(h.session.panel).toBe("authors");
    h.session.cyclePanel(1);
    expect(h.session.panel).toBe("document");
    h.session.cyclePanel(-1);
    expect(h.session.panel).toBe("authors");
  });
});

describe("the update composer (P7, N9, N16, N17)", () => {
  test("c / :post opens it in INSERT for the current task: j, q and : are text; the count is visible", async () => {
    const h = setup();
    await h.session.execute("post");
    expect(h.session.dialog?.label).toBe("post update");
    expect(h.session.keys.mode()).toBe("INSERT");
    expect(h.composer()).toContain("0/4096");
    expect(h.composer()).toContain("@1");
    h.type(..."note: j q");
    expect(h.activity.draftText(1)).toBe("note: j q");
    expect(h.activity.marker(1)).toBeNull(); // the open composer shows it; the header marker is for a closed one
    expect(h.composer()).toContain("9/4096");
    expect(h.session.selectedTask()?.id).toBe(1); // j did not move the list
    await settle();
    expect(h.composer()).toContain("kalindu"); // the default author (/api/me)
  });

  test(":w posts ONCE with the captured author and text, as a human (no notify, no status), and a mutation id; the ack clears it", async () => {
    const h = setup();
    await h.session.execute("post");
    h.type(..."hello world", "\x1b", ":", "w", "\r");
    await settle();
    expect(h.fake.posts.length).toBe(1);
    const post = h.fake.posts[0];
    expect(post?.id).toBe(1);
    expect(post?.request).toEqual({ author: "kalindu", summary: "hello world" });
    expect(typeof post?.guard?.mutationId).toBe("string");
    expect(post?.guard?.expected).toBeUndefined();
    // Still open and the draft kept until the acknowledgement.
    expect(h.activity.draftText(1)).toBe("hello world");
    expect(h.composer()).toContain("Posting");
    h.ack(0, update(50, 1, { summary: "hello world", author: "kalindu" }));
    await settle();
    expect(h.activity.draftText(1)).toBeNull();
    expect(h.session.dialog).toBeNull();
    expect(h.session.status?.text).toContain("Posted an update to @1");
    expect(h.session.panel).toBe("activity");
  });

  test("duplicate submits while one is in flight send ONE request; blank text never posts", async () => {
    const h = setup();
    await h.session.execute("post");
    h.type("\x1b", ":", "w", "\r");
    await settle();
    expect(h.fake.posts.length).toBe(0);
    expect(h.session.status?.text).toContain("Nothing to post");
    h.type("i", ..."   ");
    h.type("\x1b", ":", "w", "\r");
    await settle();
    expect(h.fake.posts.length).toBe(0);
    h.type("i", ..."once", "\x13"); // Ctrl-s in INSERT is :w
    await settle();
    h.type("\x13", "\x13");
    await settle();
    expect(h.fake.posts.length).toBe(1);
    expect(h.fake.posts[0]?.request.summary).toBe("   once");
  });

  test("more than 4096 characters is refused with the count shown; nothing is sent", async () => {
    const h = setup();
    await h.session.execute("post");
    h.type(`\x1b[200~${"x".repeat(MAX_SUMMARY + 4)}\x1b[201~`);
    expect(h.activity.draftText(1)?.length).toBe(MAX_SUMMARY + 4);
    expect(h.composer()).toContain("4100/4096");
    expect(h.composer()).toContain("4 over the limit");
    h.type("\x13");
    await settle();
    expect(h.fake.posts.length).toBe(0);
    expect(h.session.status?.text).toContain("4096");
  });

  test("newer typing during a submit survives the ack (the clear is revision-scoped)", async () => {
    const h = setup();
    await h.session.execute("post");
    h.type(..."first", "\x13");
    await settle();
    h.type(..." and more");
    h.ack(0, update(51, 1, { summary: "first" }));
    await settle();
    expect(h.activity.draftText(1)).toBe("first and more");
    expect(h.session.dialog?.label).toBe("post update");
    expect(h.composer()).toContain("you typed more since");
  });

  test("a failure keeps the text and the error; an identical retry reuses the mutation id, a changed text gets a new one", async () => {
    const h = setup();
    await h.session.execute("post");
    h.type(..."will fail", "\x13");
    await settle();
    h.fake.posts[0]?.answer.reject(new TransportError("timeout", "POST", "/api/tasks/1/updates", "request timed out"));
    await settle();
    expect(h.activity.draftText(1)).toBe("will fail");
    expect(h.composer()).toContain("not posted");
    expect(h.session.status?.text).toContain("may have been posted");
    h.type("\x13");
    await settle();
    expect(h.fake.posts.length).toBe(2);
    expect(h.fake.posts[1]?.guard?.mutationId).toBe(h.fake.posts[0]?.guard?.mutationId as string);
    h.fake.posts[1]?.answer.reject(new HttpError(500, "disk full"));
    await settle();
    h.type(..."!", "\x13");
    await settle();
    expect(h.fake.posts.length).toBe(3);
    expect(h.fake.posts[2]?.request.summary).toBe("will fail!");
    expect(h.fake.posts[2]?.guard?.mutationId).not.toBe(h.fake.posts[0]?.guard?.mutationId as string);
    // A replayed acknowledgement (the lost first answer) clears it like any other.
    h.ack(2, update(52, 1, { summary: "will fail!" }), true);
    await settle();
    expect(h.activity.draftText(1)).toBeNull();
  });

  test(":q closes it and KEEPS the task's draft with a marker; reopening restores it; :q! discards it", async () => {
    const h = setup();
    await h.session.execute("post");
    h.type(..."keep this", "\x1b", ":", "q", "\r");
    await settle();
    expect(h.session.dialog).toBeNull();
    expect(h.activity.draftText(1)).toBe("keep this");
    expect(
      plain([
        h.activity
          .marker(1)
          ?.map(s => s.text)
          .join("") ?? "",
      ]),
    ).toContain("Unsent update");
    expect(h.activity.unsent().map(u => u.taskId)).toEqual([1]);
    // Navigating away keeps it too.
    h.session.select(2);
    h.session.select(1);
    await h.session.execute("post");
    expect(h.composer()).toContain("keep this");
    h.type("\x1b", ":", "q", "!", "\r");
    await settle();
    expect(h.session.dialog).toBeNull();
    expect(h.activity.draftText(1)).toBeNull();
    expect(h.activity.marker(1)).toBeNull();
    // Esc then q in its NORMAL mode is :q as well (and keeps the draft).
    await h.session.execute("post");
    h.type(..."again", "\x1b", "q");
    expect(h.session.dialog).toBeNull();
    expect(h.activity.draftText(1)).toBe("again");
  });

  test("per-task drafts: a deferred ack after switching tasks clears only the ORIGINAL task's draft", async () => {
    const h = setup();
    await h.session.execute("post");
    h.type(..."posting from one", "\x13");
    await settle();
    h.type("\x1b", ":", "q", "\r");
    await settle();
    h.session.select(2);
    await h.session.execute("post");
    h.type(..."typing on two");
    h.ack(0, update(60, 1, { summary: "posting from one" }));
    await settle();
    expect(h.activity.draftText(2)).toBe("typing on two");
    expect(h.activity.draftText(1)).toBeNull();
    expect(h.session.dialog?.label).toBe("post update"); // task 2's composer stays open
  });

  test("the acknowledged update is inserted once, deduped against its SSE echo (either order)", async () => {
    const h = setup();
    await showActivity(h, []);
    await h.session.execute("post");
    h.type(..."dedupe me", "\x13");
    await settle();
    const created = update(70, 1, { summary: "dedupe me", created: Date.now() });
    h.posted(created); // the echo beats the answer
    h.ack(0, created);
    await settle();
    expect(h.view().split("dedupe me").length - 1).toBe(1);
    await h.session.execute("post");
    h.type(..."answer first", "\x13");
    await settle();
    const second = update(71, 1, { summary: "answer first", created: Date.now() + 1 });
    h.ack(1, second);
    await settle();
    h.posted(second);
    expect(h.view().split("answer first").length - 1).toBe(1);
  });

  test("the application :q refuses while a composer draft is unsent and names it; :q! discards it", async () => {
    const h = setup();
    await h.session.execute("post");
    h.type(..."unsent words", "\x1b", ":", "q", "\r");
    await settle();
    await h.session.execute("q");
    expect(h.quits).toEqual([]);
    expect(h.session.status?.text).toContain("Not quitting");
    expect(h.session.status?.text).toContain("unsent update for @1");
    await h.session.execute("wq");
    expect(h.quits).toEqual([]);
    await h.session.execute("q!");
    expect(h.quits).toEqual([true]);
    expect(h.activity.draftText(1)).toBeNull();
  });

  test(":post <text> posts directly; a failure keeps it as the task's draft for :w", async () => {
    const h = setup();
    const running = h.session.execute("post quick note");
    await settle();
    expect(h.fake.posts[0]?.request).toEqual({ author: "kalindu", summary: "quick note" });
    h.fake.posts[0]?.answer.reject(new HttpError(400, "task 1 not found"));
    await running;
    expect(h.activity.draftText(1)).toBe("quick note");
    expect(h.session.status?.text).toContain("task 1 not found");
    // With an unsent draft, :post <other text> refuses rather than mixing them.
    await h.session.execute("post something else");
    expect(h.fake.posts.length).toBe(1);
    expect(h.session.status?.text).toContain("unsent update");
  });

  test("the Author field (Tab) changes the author captured at submit; typing after submit cannot change it", async () => {
    const h = setup();
    await h.session.execute("post");
    await settle();
    h.type(..."by someone else", "\t");
    for (let i = 0; i < "kalindu".length; i++) h.type("\x7f");
    h.type(..."reviewer", "\x13");
    await settle();
    h.type(..."-late");
    expect(h.fake.posts[0]?.request).toEqual({ author: "reviewer", summary: "by someone else" });
  });

  test("a removed task drops its composer draft with its text in :messages", async () => {
    const h = setup();
    await h.session.execute("post");
    h.type(..."orphaned words", "\x1b", ":", "q", "\r");
    await settle();
    h.frame("task.removed", { id: 1 });
    expect(h.activity.draftText(1)).toBeNull();
    expect(h.session.messages.map(m => m.text).join("\n")).toContain("orphaned words");
    // A snapshot without the task drops it the same way (a missed task.removed frame).
    await h.session.execute("post");
    h.type(..."second orphan", "\x1b", ":", "q", "\r");
    await settle();
    expect(h.session.selectedTask()?.id).toBe(2);
    h.session.applySnapshot({ ...h.snapshot, cursor: "e:500", tasks: [task(1)] });
    expect(h.activity.draftText(2)).toBeNull();
    expect(h.session.messages.at(-1)?.text).toContain("second orphan");
  });

  test("a replaced database drops every composer draft (never posted into it), keeping the text in :messages", async () => {
    const h = setup();
    await h.session.execute("post");
    h.type(..."old database words", "\x1b", ":", "q", "\r");
    await settle();
    h.activity.reset("belongs to the replaced database");
    expect(h.activity.draftText(1)).toBeNull();
    expect(h.activity.unsent()).toEqual([]);
    expect(h.session.messages.at(-1)?.text).toContain("@1 belongs to the replaced database");
    expect(h.session.messages.at(-1)?.text).toContain("old database words");
    expect(h.fake.posts.length).toBe(0);
  });

  test(":post whose default author is still being read when the database is replaced posts NOTHING, in either database (review F10)", async () => {
    const OTHER_DB = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
    const REPLACED: DaemonIdentity = { ...IDENTITY, instanceId: "instance-2", databaseId: OTHER_DB, pid: 5151 };
    const newPosts: unknown[] = [];
    // The replacement has its own @1: a post begun for the old database must never land there.
    const next = {
      health: async () => ({ ok: true, version: "test", identity: REPLACED }),
      workspace: async (): Promise<WorkspaceSnapshot> => ({
        identity: REPLACED,
        cursor: "g:1",
        tasks: [task(1, { title: "the new database's task" })],
        lanes: [],
        tags: [],
        notifications: [],
      }),
      me: async () => ({ author: "someone else" }),
      versioned: {
        postUpdate: async (...args: unknown[]) => {
          newPosts.push(args);
          return { update: update(90, 1), audit: null, task: task(1), versions: {}, replayed: false };
        },
      },
    } as unknown as CortexClient;
    const h = setup(undefined, undefined, { connect: () => next });
    const me = deferred<{ author: string }>();
    (h.fake.client as unknown as { me: () => Promise<{ author: string }> }).me = () => me.promise;
    const running = h.session.execute("post quick note");
    await settle();
    h.session.receive({
      kind: "ready",
      cursor: "g:0",
      payload: { cursor: "g:0", epoch: "g", instanceId: "instance-2", databaseId: OTHER_DB },
    });
    for (let i = 0; i < 5; i++) await settle();
    expect(h.session.identity.databaseId).toBe(OTHER_DB);
    expect(h.session.loaded).toBe(true); // writes are allowed in the replacement again
    me.resolve({ author: "kalindu" }); // the OLD daemon's late answer
    await running;
    for (let i = 0; i < 5; i++) await settle();
    expect(newPosts).toEqual([]);
    expect(h.fake.posts).toEqual([]);
    expect(h.session.status?.text).toMatch(
      /Update to @1 not posted: The database was replaced before this could run: nothing was changed/,
    );
    // The replacement dropped the old database's composer draft (never carried to the new @1); its text is kept in :messages.
    expect(h.activity.draftText(1)).toBeNull();
    expect(h.session.messages.some(m => /@1 belongs to the replaced database.*"quick note"/.test(m.text))).toBe(true);
  });
});
