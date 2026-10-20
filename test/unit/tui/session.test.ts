import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import type { CortexClient, DaemonIdentity, LiveEvent, TaskState, WorkspaceSnapshot } from "../../../src/contracts.ts";
import type { Lane, Task } from "../../../src/store.ts";
import { UNTAGGED } from "../../../src/lib/taskView.ts";
import { COMMANDS, CommandError, type CommandSpec } from "../../../src/tui/commands.ts";
import { DEFAULT_CONFIG, loadConfig } from "../../../src/tui/config.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";
import { openPreferences, type PreferenceSession } from "../../../src/tui/preferences.ts";
import { type OverlayHost, type SessionDialog, TuiSession, type SessionOptions } from "../../../src/tui/session.ts";

// Plan @400 N15/N17: one TuiSession per terminal UI. Shared data (tasks,
// catalogs, notifications) comes ONLY from the daemon: a workspace snapshot
// plus the live stream, applying just the events after the snapshot's cursor
// and resnapshotting on ready/resync/epoch. Selection, focus, the list view
// (search, filter slots, include-done), the jump history, scroll, the prompt
// and its histories, messages and the connection state belong to the
// session. No process-wide singletons.

const DB = "0b6a2f4e-0c1d-4e5f-8a9b-1c2d3e4f5a6b";
const OTHER_DB = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";

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
  created: 1,
  updated: 1,
  tags: [],
  memory_excluded: false,
  ...over,
});

// In the daemon's order (ORDER BY sort, name), which the session keeps.
const LANES: Lane[] = [
  { name: "now", color: null, sort: 0 },
  { name: "later", color: null, sort: 1 },
];

const snapshot = (cursor: string, tasks: Task[], lanes: Lane[] = LANES): WorkspaceSnapshot => ({
  identity: IDENTITY,
  cursor,
  tasks,
  lanes,
  tags: [],
  notifications: [],
});

const ev = (kind: LiveEvent["kind"], cursor: string, payload: unknown = {}): LiveEvent => ({ kind, cursor, payload });

type Pending = { resolve(s: WorkspaceSnapshot): void; reject(e: Error): void };

function fakeClient(identity: DaemonIdentity = IDENTITY) {
  const pending: Pending[] = [];
  let healthCalls = 0;
  const client = {
    workspace: () =>
      new Promise<WorkspaceSnapshot>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    health: async () => {
      healthCalls++;
      return { ok: true, version: "test", identity };
    },
  };
  return { client: client as unknown as CortexClient, pending, healthCalls: () => healthCalls };
}

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

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let dir: string;
let prefsFile: string;
let tomlFile: string;
let prefs: PreferenceSession;
let clock: ReturnType<typeof manualClock>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-session-"));
  prefsFile = path.join(dir, "tui", "default.state.json");
  tomlFile = path.join(dir, "tui.toml");
  prefs = openPreferences(prefsFile);
  clock = manualClock();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeSession(over: Partial<SessionOptions> = {}): { session: TuiSession; fake: ReturnType<typeof fakeClient> } {
  const fake = fakeClient();
  const session = new TuiSession({
    client: fake.client,
    identity: IDENTITY,
    keys: DEFAULT_KEYS,
    preferences: prefs,
    configFile: tomlFile,
    schedule: clock.schedule,
    now: () => 1000,
    ...over,
  });
  return { session, fake };
}

/** The state file as written (it holds only each database's last task), or null before the first save. */
const stateFile = (): Record<string, unknown> | null =>
  fs.existsSync(prefsFile) ? JSON.parse(fs.readFileSync(prefsFile, "utf8")) : null;

const ids = (tasks: readonly Task[]) => tasks.map(t => t.id);

describe("workspace list", () => {
  test("one flat list in ascending id order across lanes (the default sort), done hidden", () => {
    const { session } = makeSession();
    session.applySnapshot(
      snapshot("e:1", [
        task(5, { lane: "later", title: "alpha" }),
        task(2, { title: "task-12" }),
        task(3, { title: "task-2" }),
        task(4, { title: "shipped", status: "done" }),
        task(1, { lane: "later", title: "zeta" }),
      ]),
    );
    expect(session.loaded).toBe(true);
    expect(session.sort).toBe("id");
    expect(session.group).toBe("none");
    expect(ids(session.visibleTasks())).toEqual([1, 2, 3, 5]);
    // The fallback follows the server order, not the display order.
    expect(session.selectedTask()?.id).toBe(5);
    expect(session.workspace().activeIndex).toBe(3);
  });

  test(":sort and :group reorder the list for this session only; a session starts from tui.toml's sort and group", () => {
    const { session } = makeSession();
    session.applySnapshot(
      snapshot("e:1", [
        task(1, { lane: "later", title: "zeta" }),
        task(2, { title: "task-12", status: "review" }),
        task(3, { title: "task-2", status: "draft" }),
      ]),
    );
    session.setSort("title");
    expect(ids(session.visibleTasks())).toEqual([3, 2, 1]);
    session.setGroup("status");
    expect(ids(session.visibleTasks())).toEqual([3, 1, 2]);
    expect(session.workspace().groups.map(g => g.key)).toEqual(["draft", "open", "review"]);
    session.setSort("-id");
    expect(ids(session.visibleTasks())).toEqual([3, 1, 2]);
    session.setGroup("none");
    expect(ids(session.visibleTasks())).toEqual([3, 2, 1]);
    session.savePreferences();
    expect(stateFile()).not.toHaveProperty("view");
    prefs = openPreferences(prefsFile);
    const restored = makeSession().session;
    expect([restored.sort, restored.group]).toEqual(["id", "none"]);
    const configured = makeSession({ settings: { sort: "-updated", group: "lane" } }).session;
    expect([configured.sort, configured.group]).toEqual(["-updated", "lane"]);
  });

  test("the list model is memoized per input; a selection change alone reuses the searched rows", () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1, { title: "a" }), task(2, { title: "b" })]));
    const first = session.workspace();
    expect(session.workspace()).toBe(first);
    session.select(2);
    const moved = session.workspace();
    expect(moved.rows).toBe(first.rows);
    expect(moved.active?.id).toBe(2);
    session.setQuery("b");
    expect(session.workspace().rows).not.toBe(first.rows);
  });

  test("the list query uses the full-pool search and lasts only for the session", () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1, { title: "fix login" }), task(2, { title: "write docs" })]));
    session.setQuery("login");
    expect(ids(session.visibleTasks())).toEqual([1]);
    session.setQuery("");
    expect(ids(session.visibleTasks())).toEqual([1, 2]);
    session.setQuery("docs");
    session.savePreferences();
    expect(JSON.stringify(stateFile())).not.toContain("docs");
    prefs = openPreferences(prefsFile);
    expect(makeSession().session.query).toBe("");
  });

  test("an explicit selection survives the filter that hides it; no selection falls back to the first visible", () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1, { title: "a" }), task(2, { title: "b", status: "done" })]));
    expect(session.selectedTask()?.id).toBe(1);
    session.select(2);
    expect(session.selectedTask()?.id).toBe(2);
    expect(session.isVisible(2)).toBe(false);
    expect(ids(session.visibleTasks())).toEqual([1]);
  });

  test("startup selection: the requested task, else this database's saved last task, else the fallback", () => {
    prefs.setDatabase(DB, "lastTask", 2);
    prefs.setDatabase(OTHER_DB, "lastTask", 3);
    const tasks = [task(1, { title: "a" }), task(2, { title: "b" }), task(3, { title: "c" })];
    const saved = makeSession().session;
    saved.applySnapshot(snapshot("e:1", tasks));
    expect(saved.selectedId).toBe(2);
    const requested = makeSession({ initialTask: 3 }).session;
    requested.applySnapshot(snapshot("e:1", tasks));
    expect(requested.selectedId).toBe(3);
  });

  test("j/k style moves (with counts) stay inside the visible list; first/last jump to its ends; outside enters at the edge", () => {
    const { session } = makeSession();
    session.applySnapshot(
      snapshot(
        "e:1",
        [1, 2, 3, 4].map(id => task(id, { title: `t${id}` })),
      ),
    );
    session.moveSelection(1);
    expect(session.selectedId).toBe(2);
    session.moveSelection(5);
    expect(session.selectedId).toBe(4);
    session.moveSelection(-2);
    expect(session.selectedId).toBe(2);
    session.selectEdge("first");
    expect(session.selectedId).toBe(1);
    session.moveSelection(-1);
    expect(session.selectedId).toBe(1);
    session.selectEdge("last");
    expect(session.selectedId).toBe(4);
    session.setFilter({ status: null, lane: null, tags: ["x"] });
    session.applySnapshot(
      snapshot("e:2", [...[1, 2, 3].map(id => task(id, { title: `t${id}`, tags: ["x"] })), task(4, { title: "t4" })]),
    );
    session.moveSelection(-1);
    expect(session.selectedId).toBe(3);
  });

  test("n/N step through the search results with wrap-around; without a search they explain", () => {
    const { session } = makeSession();
    session.applySnapshot(
      snapshot("e:1", [task(1, { title: "alpha one" }), task(2, { title: "alpha two" }), task(3, { title: "beta" })]),
    );
    session.stepResult(1);
    expect(session.status?.text).toMatch(/No search/);
    session.setQuery("alpha");
    expect(session.selectedTask()?.id).toBe(1);
    session.stepResult(1);
    expect(session.selectedId).toBe(2);
    session.stepResult(1);
    expect(session.selectedId).toBe(1);
    expect(session.status?.text).toMatch(/wrapped to the first/);
    session.stepResult(-1);
    expect(session.selectedId).toBe(2);
    session.select(3);
    session.stepResult(-1);
    expect(session.selectedId).toBe(2);
    session.setQuery("zzz");
    session.stepResult(1);
    expect(session.status?.text).toMatch(/No task matches \/zzz/);
  });

  test("filter slots and include-done are this session's (tui.toml's done sets how it starts)", () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1, { tags: ["bug"] }), task(2, { status: "done" })]));
    session.setFilter({ status: "open", lane: "now", tags: ["bug", UNTAGGED] });
    session.setIncludeDone(true);
    session.select(1);
    session.savePreferences();
    // Only the last task is kept: { version, databases: { <uuid>: { lastTask } } }.
    expect(stateFile()).toEqual({ version: 1, databases: { [DB]: { lastTask: 1 } } });
    expect(fs.existsSync(tomlFile)).toBe(false);
    prefs = openPreferences(prefsFile);
    const restored = makeSession().session;
    restored.applySnapshot(snapshot("e:1", [task(1, { tags: ["bug"] }), task(2, { status: "done" })]));
    expect(restored.filter).toEqual({ status: null, lane: null, tags: [] });
    expect(restored.includeDone).toBe(false);
    expect(restored.selectedId).toBe(1);
    expect(makeSession({ settings: { done: true } }).session.includeDone).toBe(true);
  });

  test("clearing keeps include-done; a header tag label appends to the tag filter", () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1, { tags: ["bug", "ui"] })]));
    session.setQuery("x");
    session.setFilter({ status: "open", lane: null, tags: ["bug"] });
    session.setIncludeDone(true);
    session.clearFilters();
    expect([session.query, session.filter, session.includeDone]).toEqual([
      "",
      { status: null, lane: null, tags: [] },
      true,
    ]);
    session.appendTagFilter("bug");
    session.appendTagFilter("ui");
    session.appendTagFilter("bug");
    expect(session.filter.tags).toEqual(["bug", "ui"]);
  });

  test("jumps build the :back/:forward history, skipping tasks deleted since", () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1, { title: "a" }), task(2, { title: "b" }), task(3, { title: "c" })]));
    session.jump(2);
    session.jump(3);
    session.receive(ev("task.removed", "e:2", { id: 2 }));
    session.back();
    expect(session.selectedId).toBe(1);
    session.forward();
    expect(session.selectedId).toBe(3);
    expect(() => session.jump(99)).toThrow(/@99/);
  });

  test("the selection and document scroll are per session; the saved last task follows the selection", () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1, { title: "a" }), task(2, { title: "b" })]));
    session.select(2);
    session.scrollDocument(5);
    expect(session.docScroll(2)).toBe(5);
    session.select(1);
    expect(session.docScroll(1)).toBe(0);
    session.savePreferences();
    expect(openPreferences(prefsFile).database(DB).lastTask).toBe(1);
  });
});

describe("focus and views", () => {
  test("focus moves only through explicit calls, cycling tasks <-> document", () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1)]));
    expect(session.focus).toBe("tasks");
    session.cycleFocus(1);
    expect(session.focus).toBe("document");
    session.cycleFocus(1);
    expect(session.focus).toBe("tasks");
    session.cycleFocus(-1);
    expect(session.focus).toBe("document");
    session.moveSelection(1);
    expect(session.focus).toBe("document");
  });

  test("hiding the task list moves focus to the document; focusing tasks shows it again", () => {
    const { session } = makeSession();
    session.toggleTaskList();
    expect(session.taskListVisible).toBe(false);
    expect(session.focus).toBe("document");
    session.cycleFocus(1);
    expect(session.focus).toBe("document");
    session.setFocus("tasks");
    expect(session.taskListVisible).toBe(true);
    session.savePreferences();
    expect(fs.existsSync(tomlFile)).toBe(false);
  });

  test("help and messages open as views; closing returns to the workspace", () => {
    const { session } = makeSession();
    session.openView("help");
    expect(session.view).toBe("help");
    session.scrollView(3);
    expect(session.viewScroll).toBe(3);
    session.closeView();
    expect(session.view).toBe("workspace");
    session.openView("messages");
    expect(session.viewScroll).toBe(0);
  });
});

describe("density: the spacing (a terminal cannot set its font size)", () => {
  test("the density is tui.toml's density (the session's settings), else comfortable", () => {
    expect(makeSession().session.density).toBe("comfortable");
    expect(makeSession({ settings: { density: "compact" } }).session.density).toBe("compact");
    expect(makeSession({ settings: { density: "comfortable" } }).session.density).toBe("comfortable");
  });

  test("setDensity redraws at once for this session; tui.toml is not written", () => {
    let changes = 0;
    const { session } = makeSession({ onChange: () => changes++ });
    session.setDensity("compact");
    expect(session.density).toBe("compact");
    expect(changes).toBeGreaterThan(0);
    clock.flush();
    expect(session.savePreferences()).toBe(true);
    expect(fs.existsSync(tomlFile)).toBe(false);
  });
});

describe("settings: a session starts from tui.toml; only saveSetting writes it", () => {
  const startup = (s: TuiSession) => [
    s.includeDone,
    s.taskListVisible,
    s.lineNumbers,
    s.sort,
    s.group,
    s.preferredMode,
    s.scrollRows,
  ];

  test("they start from the session's settings, else the defaults", () => {
    expect(startup(makeSession().session)).toEqual([false, true, false, "id", "none", "read", 3]);
    const set = makeSession({
      settings: { done: true, tasks: false, number: true, sort: "title", group: "status", mode: "split", scroll: 1 },
    }).session;
    expect(startup(set)).toEqual([true, false, true, "title", "status", "split", 1]);
  });

  test("no command or shortcut outlives the session: tui.toml is untouched and the state file keeps only the last task", () => {
    fs.writeFileSync(tomlFile, "tasks = true\n");
    const { session } = makeSession({ settings: loadConfig(tomlFile).config });
    session.applySnapshot(snapshot("e:1", [task(1), task(2, { status: "done" })]));
    session.setIncludeDone(true);
    session.setLineNumbers(true);
    session.setTaskListVisible(false);
    session.setSort("title");
    session.setGroup("lane");
    session.setDensity("compact");
    session.setScrollRows(7);
    session.setDocumentMode("split");
    session.setQuery("task");
    session.setFilter({ status: "open", lane: null, tags: [] });
    session.select(2);
    clock.flush();
    // Focusing the hidden list shows it, for this session only.
    session.setFocus("tasks");
    expect(session.savePreferences()).toBe(true);
    expect(fs.readFileSync(tomlFile, "utf8")).toBe("tasks = true\n");
    expect(stateFile()).toEqual({ version: 1, databases: { [DB]: { lastTask: 2 } } });
    expect([session.includeDone, session.taskListVisible, session.sort, session.scrollRows]).toEqual([
      true,
      true,
      "title",
      7,
    ]);
  });

  test("saveSetting writes one line now (null removes it); two sessions keep each other's keys", () => {
    fs.writeFileSync(tomlFile, "# mine\n");
    const a = makeSession().session;
    const b = makeSession({ preferences: openPreferences(prefsFile) }).session;
    expect(a.configFile).toBe(tomlFile);
    a.saveSetting("number", true);
    b.saveSetting("density", "compact");
    a.saveSetting("theme", "cortex-light");
    expect(loadConfig(tomlFile)).toEqual({
      config: { ...DEFAULT_CONFIG, density: "compact", number: true, theme: "cortex-light" },
      problems: [],
    });
    a.saveSetting("theme", null);
    expect(fs.readFileSync(tomlFile, "utf8")).toBe('# mine\nnumber = true\ndensity = "compact"\n');
    // Saving a setting never applies it: the :config pane does, after the write.
    expect([a.lineNumbers, b.density]).toEqual([false, "comfortable"]);
  });

  test("a refused write is a CommandError naming the file, and changes nothing", () => {
    fs.writeFileSync(tomlFile, "not = [toml");
    const { session } = makeSession();
    expect(() => session.saveSetting("scroll", 5)).toThrow(CommandError);
    expect(() => session.saveSetting("scroll", 5)).toThrow(`Could not save ${tomlFile}: not valid TOML`);
    fs.writeFileSync(tomlFile, "scroll = 4\n");
    expect(() => session.saveSetting("scroll", 0)).toThrow(/scroll: must be a whole number from 1 to 20/);
    expect(fs.readFileSync(tomlFile, "utf8")).toBe("scroll = 4\n");
  });

  test("without a configFile, saveSetting refuses and the setters still work for the session", () => {
    const { session } = makeSession({ configFile: undefined });
    expect(session.configFile).toBeUndefined();
    expect(() => session.saveSetting("number", true)).toThrow(
      "Settings are not saved in this session: it has no tui.toml",
    );
    session.setLineNumbers(true);
    expect(session.savePreferences()).toBe(true);
    expect(session.lineNumbers).toBe(true);
    expect(fs.existsSync(tomlFile)).toBe(false);
  });
});

describe("INSERT ends before its target leaves the screen (review F14)", () => {
  /** One task, typed into in Edit; its title/body writes are recorded (autosave waits for the manual clock). */
  async function typing() {
    const t = task(1, { title: "Title", body: "body" });
    const versions = { entity: "e", title: "t", body: "b", priority: "p", lane: "l", status: "s" };
    const edits: unknown[] = [];
    const client = {
      ...(fakeClient().client as unknown as Record<string, unknown>),
      taskState: async (): Promise<TaskState> => ({ task: t, updates: [], versions }),
      versioned: {
        editTask: async (_id: number, request: Record<string, unknown>) => {
          edits.push(request);
          return { task: { ...t, ...request }, versions, replayed: false };
        },
      },
    } as unknown as CortexClient;
    const { session } = makeSession({ client });
    session.applySnapshot(snapshot("e:1", [t]));
    session.setDocumentMode("edit");
    session.setFocus("document");
    await session.openDocument(1);
    const body = () => session.documentOf(1)?.draft?.text("body");
    /** `i` on the body. */
    const insert = () => {
      session.startInsert();
      expect([session.keys.mode(), session.insertTarget?.target]).toEqual(["INSERT", "body"]);
    };
    const probe: SessionDialog = {
      label: "probe",
      mode: () => "NORMAL",
      hints: () => "",
      handleRaw: () => false,
      handleKey: () => {},
      search: () => {},
      write: () => false,
      quit: () => {},
      blocksCommands: () => false,
      close: () => session.removeDialog(probe),
    };
    return { session, body, insert, probe, edits };
  }

  test("Read, another view, the list, Split's preview half, the title or a dialog: INSERT ends, the next key is never typed", async () => {
    const { session, body, insert, probe } = await typing();
    insert();
    session.input("x");
    expect(body()).toBe("xbody");
    const hiding: [string, () => void][] = [
      ["Read", () => session.setDocumentMode("read")],
      [":messages", () => session.openView("messages")],
      ["help", () => session.openView("help")],
      ["the list", () => session.setFocus("tasks")],
      ["the preview half", () => session.setSplitHalf("preview")],
      ["the title", () => session.setDocumentTarget("title")],
      ["a dialog", () => session.pushDialog(probe)],
    ];
    for (const [what, hide] of hiding) {
      session.closeDialogs();
      session.closeView();
      session.setFocus("document");
      session.setDocumentTarget("body");
      session.setDocumentMode(what === "the preview half" ? "split" : "edit");
      insert();
      hide();
      expect([what, session.keys.mode(), session.insertTarget]).toEqual([what, "NORMAL", null]);
      session.input("j");
      expect([what, body()]).toEqual([what, "xbody"]);
    }
  });

  test("what keeps the editor on screen with the keyboard keeps INSERT; a title INSERT ends (and saves) the same way; :title shows the workspace", async () => {
    const { session, body, insert, edits } = await typing();
    insert();
    session.setDocumentMode("split"); // its editor half
    session.setSplitHalf("editor");
    session.setFocus("document");
    session.setDocumentTarget("body");
    session.setDocumentMode("edit");
    expect(session.keys.mode()).toBe("INSERT");
    session.input("y");
    expect(body()).toBe("ybody");
    session.input("\x1b");
    session.editTitle();
    session.input("!");
    session.openView("messages");
    expect([session.keys.mode(), session.titleEdit]).toEqual(["NORMAL", null]);
    await settle();
    expect(edits).toContainEqual({ title: "Title!" }); // the draft flushes (the typed body too)
    // :title from a view edits the title where it is shown: the workspace.
    await session.execute("title");
    expect([session.view, session.titleEdit?.taskId, session.keys.mode()]).toEqual(["workspace", 1, "INSERT"]);
  });
});

describe("live synchronization (N12)", () => {
  test("a ready covered by the applied snapshot needs no new snapshot; later events apply incrementally", async () => {
    const { session, fake } = makeSession();
    session.applySnapshot(snapshot("e:5", [task(1, { title: "old" })]));
    session.receive(ev("ready", "e:5", { cursor: "e:5", epoch: "e", instanceId: "instance-1", databaseId: DB }));
    expect(fake.pending.length).toBe(0);
    session.receive(ev("task.updated", "e:6", task(1, { title: "new" })));
    session.receive(ev("task.added", "e:7", task(2, { title: "two" })));
    expect(session.tasks.map(t => t.title)).toEqual(["new", "two"]);
    session.receive(ev("task.removed", "e:8", { id: 1 }));
    expect(ids(session.tasks)).toEqual([2]);
    // Duplicates and frames the state already covers change nothing.
    session.receive(ev("task.added", "e:7", task(1, { title: "ghost" })));
    expect(ids(session.tasks)).toEqual([2]);
    await settle();
    expect(fake.pending.length).toBe(0);
  });

  test("a ready past the applied cursor takes a snapshot; frames during the fetch replay after it", async () => {
    const { session, fake } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1)]));
    session.receive(ev("ready", "e:3", { cursor: "e:3", epoch: "e", instanceId: "instance-1", databaseId: DB }));
    expect(fake.pending.length).toBe(1);
    // Arrive while the snapshot is in flight: one is covered by it, one is not.
    session.receive(ev("task.added", "e:4", task(4, { title: "covered" })));
    session.receive(ev("task.added", "e:6", task(6, { title: "after" })));
    fake.pending[0]?.resolve(snapshot("e:5", [task(1), task(4, { title: "covered" }), task(5)]));
    await settle();
    expect(ids(session.tasks)).toEqual([1, 4, 5, 6]);
  });

  test("resync forces a snapshot and a newer request makes an older answer obsolete", async () => {
    const { session, fake } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1)]));
    session.receive(ev("resync", "e:2", { reason: "overflow", cursor: "e:2" }));
    session.receive(ev("resync", "e:3", { reason: "gap", cursor: "e:3" }));
    expect(fake.pending.length).toBe(2);
    fake.pending[1]?.resolve(snapshot("e:3", [task(3)]));
    await settle();
    fake.pending[0]?.resolve(snapshot("e:2", [task(2)]));
    await settle();
    expect(ids(session.tasks)).toEqual([3]);
  });

  test("an event from another epoch (not comparable with the state) takes a snapshot", async () => {
    const { session, fake } = makeSession();
    session.applySnapshot(snapshot("e:9", [task(1)]));
    session.receive(ev("task.added", "f:1", task(2)));
    expect(fake.pending.length).toBe(1);
    expect(ids(session.tasks)).toEqual([1]);
  });

  test("catalog changes coalesce into one snapshot after the window", async () => {
    const { session, fake } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1)]));
    session.receive(ev("lane.changed", "e:2", { name: "now" }));
    session.receive(ev("tag.changed", "e:3", { name: "bug" }));
    expect(fake.pending.length).toBe(0);
    expect(clock.pending()).toEqual([50]);
    clock.flush();
    expect(fake.pending.length).toBe(1);
    fake.pending[0]?.resolve(snapshot("e:3", [task(1, { lane: "later" })]));
    await settle();
    expect(session.tasks[0]?.lane).toBe("later");
  });

  test("task frames keep the catalogs honest: counts follow the task pool; an unknown tag or lane takes one snapshot", async () => {
    const { session, fake } = makeSession();
    session.applySnapshot({
      ...snapshot("e:1", [task(1, { tags: ["bug"] }), task(2)]),
      tags: [{ name: "bug", color: "#dc2626", created: 5, task_count: 1 }],
    });
    // A delta on a known tag: the count moves with the pool, no snapshot.
    session.receive(ev("task.updated", "e:2", task(2, { tags: ["bug"] })));
    expect(session.tags).toEqual([{ name: "bug", color: "#dc2626", created: 5, task_count: 2 }]);
    session.receive(ev("task.removed", "e:3", { id: 1 }));
    expect(session.tags[0]?.task_count).toBe(1);
    expect(clock.pending()).toEqual([]);
    // A task write that auto-created a tag (or a lane) publishes only the task: refresh the catalogs once.
    session.receive(ev("task.updated", "e:4", task(2, { tags: ["bug", "fresh"] })));
    session.receive(ev("task.added", "e:5", task(3, { lane: "someday" })));
    expect(clock.pending()).toEqual([50]);
    clock.flush();
    expect(fake.pending.length).toBe(1);
    fake.pending[0]?.resolve({
      ...snapshot(
        "e:5",
        [task(2, { tags: ["bug", "fresh"] }), task(3, { lane: "someday" })],
        [...LANES, { name: "someday", color: null, sort: 0 }],
      ),
      tags: [
        { name: "bug", color: "#dc2626", created: 5, task_count: 1 },
        { name: "fresh", color: null, created: 9, task_count: 1 },
      ],
    });
    await settle();
    expect(session.tags.map(t => t.name)).toEqual(["bug", "fresh"]);
    expect(session.lanes.map(l => l.name)).toContain("someday");
  });

  test("a failed snapshot is reported and retried; the connection state is the session's", async () => {
    const { session, fake } = makeSession();
    session.setConnection("stale");
    expect(session.connection).toBe("stale");
    session.receive(ev("resync", "e:2", { reason: "gap", cursor: "e:2" }));
    fake.pending[0]?.reject(new Error("socket hung up"));
    await settle();
    expect(session.status?.level).toBe("error");
    expect(session.status?.text).toContain("socket hung up");
    expect(clock.pending().length).toBe(1);
    clock.flush();
    expect(fake.pending.length).toBe(2);
  });

  test("a restarted daemon (new instance in ready) is verified, then used for the snapshot", async () => {
    const restarted: DaemonIdentity = { ...IDENTITY, instanceId: "instance-2", pid: 5151 };
    const next = fakeClient(restarted);
    const connected: string[] = [];
    const { session, fake } = makeSession({
      connect: instanceId => {
        connected.push(instanceId);
        return next.client;
      },
    });
    session.applySnapshot(snapshot("e:3", [task(1)]));
    session.receive(ev("ready", "g:0", { cursor: "g:0", epoch: "g", instanceId: "instance-2", databaseId: DB }));
    await settle();
    expect(connected).toEqual(["instance-2"]);
    expect(next.healthCalls()).toBe(1);
    expect(fake.pending.length).toBe(0);
    expect(next.pending.length).toBe(1);
    next.pending[0]?.resolve(snapshot("g:0", [task(7)]));
    await settle();
    expect(session.identity.instanceId).toBe("instance-2");
    expect(ids(session.tasks)).toEqual([7]);
  });
});

describe("reconciliation keeps each session's place (Task 11 part B, G3)", () => {
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
  const state = (t: Task, body: string, token: string): TaskState => ({
    task: { ...t, body },
    updates: [],
    versions: { entity: "e0", title: `title-${t.title}`, body: token, priority: "p0", lane: "l0", status: "s0" },
  });
  /** A session whose workspace reads and task-state reads wait for the test. */
  function documents() {
    const fake = fakeClient();
    const states: { id: number; answer: Deferred<TaskState> }[] = [];
    const client = {
      ...(fake.client as unknown as Record<string, unknown>),
      taskState: (id: number) => {
        const answer = deferred<TaskState>();
        states.push({ id, answer });
        return answer.promise;
      },
    } as unknown as CortexClient;
    const { session } = makeSession({ client });
    return { session, fake, states };
  }

  test("a burst of live copies of a drafted task re-reads its versions ONCE in flight, then once for the newest", async () => {
    const { session, states } = documents();
    const one = task(1, { body: "base" });
    session.applySnapshot(snapshot("e:1", [one, task(2)]));
    const loading = session.openDocument(1);
    states[0]?.answer.resolve(state(one, "base", "b0"));
    await loading;
    session.receive(ev("task.updated", "e:2", task(1, { body: "one" })));
    session.receive(ev("task.updated", "e:3", task(1, { body: "two" })));
    session.receive(ev("task.updated", "e:4", task(1, { body: "three" })));
    expect(states.length).toBe(2);
    states[1]?.answer.resolve(state(one, "one", "b1"));
    await settle();
    await settle();
    // The newest copy ("three") is past what that read returned: one more read.
    expect(states.length).toBe(3);
    states[2]?.answer.resolve(state(one, "three", "b3"));
    await settle();
    await settle();
    expect(states.length).toBe(3);
    expect(session.documentOf(1)?.draft?.text("body")).toBe("three");
  });

  test("a resync snapshot keeps the selection (even filtered out), the focus and a dirty draft in the same editor", async () => {
    const { session, fake, states } = documents();
    session.applySnapshot(snapshot("e:1", [task(1), task(2, { body: "" })]));
    session.select(2);
    session.setFocus("document");
    const loading = session.openDocument(2);
    states[0]?.answer.resolve(state(task(2), "", "b0"));
    await loading;
    const doc = session.documentOf(2);
    const editor = doc?.editor;
    doc?.draft?.set("body", "typing in progress");
    session.setQuery("task 1"); // task 2 is filtered out; the explicit selection survives
    session.receive(ev("resync", "e:5", { reason: "overflow", cursor: "e:5" }));
    fake.pending[0]?.resolve(snapshot("e:5", [task(1), task(2, { body: "", lane: "later" }), task(3)]));
    await settle();
    expect(ids(session.tasks)).toEqual([1, 2, 3]);
    expect(session.selectedId).toBe(2);
    expect(session.focus).toBe("document");
    expect(session.documentOf(2)?.editor).toBe(editor);
    expect(session.documentOf(2)?.draft?.text("body")).toBe("typing in progress");
    expect(states.length).toBe(1); // the body did not change: nothing to re-read
  });

  test("an overflow resync says this session fell behind; gap and epoch resyncs stay quiet", async () => {
    const { session, fake } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1)]));
    session.receive(ev("resync", "e:2", { reason: "gap", cursor: "e:2" }));
    expect(session.status).toBeNull();
    session.receive(ev("resync", "e:3", { reason: "overflow", cursor: "e:3" }));
    expect(session.status?.level).toBe("info");
    expect(session.status?.text).toContain("fell behind the live updates");
    expect(fake.pending.length).toBe(2);
  });

  test("resyncing shows while a failed snapshot waits for its retry, and clears once one lands", async () => {
    const { session, fake } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1)]));
    expect(session.resyncing).toBe(false);
    session.receive(ev("resync", "e:2", { reason: "gap", cursor: "e:2" }));
    fake.pending[0]?.reject(new Error("socket hung up"));
    await settle();
    expect(session.resyncing).toBe(true);
    clock.flush();
    fake.pending[1]?.resolve(snapshot("e:2", [task(1)]));
    await settle();
    expect(session.resyncing).toBe(false);
  });

  test("a restarted daemon that does not verify yet is retried; frames wait and the old client is never read", async () => {
    const restarted: DaemonIdentity = { ...IDENTITY, instanceId: "instance-2", pid: 5151 };
    const next = fakeClient(restarted);
    let healthy = false;
    const flaky = {
      ...(next.client as unknown as Record<string, unknown>),
      health: async () => {
        if (!healthy) throw new Error("not listening yet");
        return { ok: true, version: "test", identity: restarted };
      },
    } as unknown as CortexClient;
    const { session, fake } = makeSession({ connect: () => flaky });
    session.applySnapshot(snapshot("e:3", [task(1)]));
    session.receive(ev("ready", "g:0", { cursor: "g:0", epoch: "g", instanceId: "instance-2", databaseId: DB }));
    await settle();
    expect(session.status?.text).toContain("retrying");
    expect(session.resyncing).toBe(true);
    session.receive(ev("task.added", "g:1", task(8)));
    expect(ids(session.tasks)).toEqual([1]);
    expect(fake.pending.length).toBe(0);
    healthy = true;
    clock.flush();
    await settle();
    expect(next.pending.length).toBe(1);
    next.pending[0]?.resolve(snapshot("g:0", [task(7)]));
    await settle();
    expect(ids(session.tasks)).toEqual([7, 8]);
    expect(session.identity.instanceId).toBe("instance-2");
    expect(session.resyncing).toBe(false);
  });
});

describe("a replaced database (review F2)", () => {
  const REPLACED: DaemonIdentity = { ...IDENTITY, instanceId: "instance-2", databaseId: OTHER_DB, pid: 5151 };
  /** The replacement daemon: its snapshots wait for the test; every write it receives is recorded. */
  function replacement() {
    const next = fakeClient(REPLACED);
    const writes: string[] = [];
    const client = {
      ...(next.client as unknown as Record<string, unknown>),
      taskState: async (id: number): Promise<TaskState> => ({
        task: task(id),
        updates: [],
        versions: { entity: "e", title: "t", body: "b", priority: "p", lane: "l", status: "s" },
      }),
      versioned: new Proxy(
        {},
        {
          get:
            (_target, name) =>
            async (...args: unknown[]) => {
              writes.push(`${String(name)}:${JSON.stringify(args[0])}`);
              return { task: task(99), versions: {}, replayed: false };
            },
        },
      ),
    } as unknown as CortexClient;
    return { next, writes, client };
  }

  test("the old workspace is cleared and every write refused until the replacement's FIRST snapshot applied", async () => {
    const { next, writes, client } = replacement();
    const { session } = makeSession({ connect: () => client });
    session.applySnapshot(snapshot("e:3", [task(1), task(2)]));
    session.select(2);
    session.setQuery("task");
    session.setFilter({ status: "open", lane: null, tags: [] });
    // Submitted for the OLD database, queued behind a write still in flight.
    let finishFirst = (): void => {};
    const first = session.mutate(
      () =>
        new Promise<void>(resolve => {
          finishFirst = resolve;
        }),
    );
    const queued = session.mutate(async () => {
      writes.push("queued for the old database");
    });
    session.receive(ev("ready", "g:0", { cursor: "g:0", epoch: "g", instanceId: "instance-2", databaseId: OTHER_DB }));
    await settle();
    expect(session.identity.databaseId).toBe(OTHER_DB);
    // The replacement never inherits the old database's search or filters.
    expect([session.query, session.filter]).toEqual(["", { status: null, lane: null, tags: [] }]);
    expect(next.pending.length).toBe(1); // its first snapshot is delayed
    finishFirst();
    await first;
    const refusedQueued = await queued.then(
      () => null,
      (err: Error) => err.message,
    );
    await session.execute("status done");
    void session.execute("new A new task");
    await settle();
    expect(writes).toEqual([]);
    expect(refusedQueued).toMatch(/replaced/);
    // Nothing of the old database is left to act on.
    expect(session.loaded).toBe(false);
    expect(ids(session.tasks)).toEqual([]);
    expect(session.lanes).toEqual([]);
    expect(session.selectedTask()).toBeNull();
    expect(session.messages.some(m => /database was replaced.*loading/i.test(m.text))).toBe(true);
    const direct = await session
      .mutate(async () => writes.push("direct"))
      .then(
        () => null,
        (err: Error) => err.message,
      );
    expect(direct).toMatch(/replaced.*loading/i);
    const ack = await session
      .acknowledgeNotifications(
        rows => [...rows],
        async () => {
          writes.push("acknowledged");
        },
      )
      .then(
        () => null,
        (err: Error) => err.message,
      );
    expect(ack).toMatch(/replaced.*loading/i);
    // Its first snapshot fails and waits for the retry: still refused.
    next.pending[0]?.reject(new Error("socket hung up"));
    await settle();
    expect(session.resyncing).toBe(true);
    await session.execute("status done");
    expect(session.status?.level).toBe("error");
    expect(writes).toEqual([]);
    // The replacement's first snapshot applies: its own tasks, and writes work again.
    clock.flush();
    expect(next.pending.length).toBe(2);
    next.pending[1]?.resolve({
      ...snapshot("g:1", [task(1, { title: "the new database's task" })]),
      identity: REPLACED,
    });
    await settle();
    expect(session.loaded).toBe(true);
    expect(session.tasks.map(t => t.title)).toEqual(["the new database's task"]);
    await session.mutate(async () => writes.push("after its snapshot"));
    expect(writes).toEqual(["after its snapshot"]);
  });

  test("a dirty draft of the old database is kept, never written, and never becomes the new database's same-id document", async () => {
    const { next, writes, client } = replacement();
    const old = fakeClient();
    const oldWrites: string[] = [];
    const oldClient = {
      ...(old.client as unknown as Record<string, unknown>),
      taskState: async (id: number): Promise<TaskState> => ({
        task: task(id, { body: "old body" }),
        updates: [],
        versions: { entity: "e0", title: "t0", body: "b0", priority: "p0", lane: "l0", status: "s0" },
      }),
      versioned: new Proxy(
        {},
        {
          get: (_target, name) => async () => {
            oldWrites.push(String(name));
            throw new Error("the old database is gone");
          },
        },
      ),
    } as unknown as CortexClient;
    const { session } = makeSession({ client: oldClient, connect: () => client });
    session.applySnapshot(snapshot("e:3", [task(1, { body: "old body" })]));
    (await session.openDocument(1))?.draft?.set("body", "unsaved old words");
    session.receive(ev("ready", "g:0", { cursor: "g:0", epoch: "g", instanceId: "instance-2", databaseId: OTHER_DB }));
    await settle();
    next.pending[0]?.resolve({ ...snapshot("g:1", [task(1, { title: "new one" })]), identity: REPLACED });
    await settle();
    clock.flush(); // the old draft's autosave timers, had they survived
    await settle();
    expect(writes).toEqual([]);
    expect(oldWrites).toEqual([]);
    // The new database's @1 is another task: its own document, never the kept text.
    expect(session.documentOf(1)?.draft?.text("body") ?? null).toBeNull();
    expect(session.unsavedDrafts().map(d => `${d.address} ${d.field} ${d.orphaned}`)).toEqual(["@1 body true"]);
    expect(session.messages.some(m => /@1: its database was replaced.*:w @1 <path>/.test(m.text))).toBe(true);
    const fresh = await session.openDocument(1);
    expect(fresh?.draft?.text("body")).toBe("");
    expect(session.unsavedDrafts().map(d => `${d.address} ${d.field} ${d.orphaned}`)).toEqual(["@1 body true"]);
  });

  test("input typed before the baseline arrived is KEPT when the database is replaced first; the late old baseline is ignored (review F11)", async () => {
    const { next, writes, client } = replacement();
    const old = fakeClient();
    const oldWrites: string[] = [];
    let answerOld = (): void => {};
    const oldClient = {
      ...(old.client as unknown as Record<string, unknown>),
      // The old baseline is slow: it answers only after the replacement.
      taskState: (id: number) =>
        new Promise<TaskState>(resolve => {
          answerOld = () =>
            resolve({
              task: task(id, { body: "old saved body" }),
              updates: [],
              versions: { entity: "e0", title: "t0", body: "b0", priority: "p0", lane: "l0", status: "s0" },
            });
        }),
      versioned: new Proxy(
        {},
        {
          get: (_target, name) => async () => {
            oldWrites.push(String(name));
            throw new Error("the old database is gone");
          },
        },
      ),
    } as unknown as CortexClient;
    const quits: boolean[] = [];
    const { session } = makeSession({ client: oldClient, connect: () => client, onQuit: force => quits.push(force) });
    session.applySnapshot(snapshot("e:3", [task(1, { body: "old saved body" })]));
    session.select(1);
    session.setFocus("document");
    session.startInsert();
    for (const ch of "typed early") session.input(ch);
    expect(session.documentOf(1)?.draft).toBeNull(); // still waiting for its baseline
    session.receive(ev("ready", "g:0", { cursor: "g:0", epoch: "g", instanceId: "instance-2", databaseId: OTHER_DB }));
    await settle();
    next.pending[0]?.resolve({ ...snapshot("g:1", [task(1, { title: "new one" })]), identity: REPLACED });
    await settle();
    answerOld(); // the old database's baseline arrives late
    await settle();
    clock.flush();
    await settle();
    // Kept as a kept draft of its own: addressable, blocking :q, never written anywhere.
    expect(session.unsavedDrafts().map(d => `${d.address} ${d.field} ${d.orphaned} ${d.reason}`)).toEqual([
      "@1 body true database replaced",
    ]);
    expect(
      session.messages.some(m =>
        /@1: its database was replaced.*typed body input \(not merged with the saved body\).*:w @1 <path>/.test(m.text),
      ),
    ).toBe(true);
    await session.execute("q");
    expect(quits).toEqual([]);
    expect(session.status?.text).toMatch(/Not quitting: .*@1 body \(database replaced\)/);
    const file = path.join(dir, "typed.md");
    await session.execute(`w @1 ${file}`);
    expect(fs.readFileSync(file, "utf8")).toBe("typed early");
    expect(session.status?.text).toMatch(/kept draft @1's typed body input \(not merged with the saved body\)/);
    // The late old baseline never resurrected the old document, and nothing reached either database.
    expect(session.documentOf(1)?.draft?.text("body") ?? null).toBeNull();
    expect(writes).toEqual([]);
    expect(oldWrites).toEqual([]);
    await session.execute("q!");
    expect(quits).toEqual([true]);
  });
});

describe("commands (the registry in src/tui/commands.ts)", () => {
  test("the session runs the shared registry by default, or the one it is given", async () => {
    expect(makeSession().session.commands).toBe(COMMANDS);
    const ran: string[] = [];
    const custom: CommandSpec[] = [
      {
        name: "ping",
        aliases: ["p"],
        group: "Workspace",
        usage: ":ping",
        description: "test",
        run: (_s, a) => void ran.push(`ping:${a}`),
      },
    ];
    const { session } = makeSession({ commands: custom });
    await session.execute("p hello");
    expect(ran).toEqual(["ping:hello"]);
    await session.execute("q");
    expect(session.status?.text).toMatch(/Unknown command :q/);
  });

  test("an empty line does nothing; errors become messages and change nothing", async () => {
    const quits: boolean[] = [];
    const { session } = makeSession({ onQuit: force => quits.push(force) });
    session.applySnapshot(snapshot("e:1", [task(1, { title: "alpha" }), task(2, { title: "beta" })]));
    await session.execute("   ");
    await session.execute(":");
    expect(session.messages.length).toBe(0);
    session.setQuery("alpha");
    await session.execute("2");
    expect(session.selectedId).toBe(2);
    expect(session.query).toBe("alpha");
    await session.execute("nope");
    expect(session.status).toMatchObject({ level: "error" });
    expect(session.status?.text).toMatch(/Unknown command :nope.*:help/);
    await session.execute("q");
    expect(quits).toEqual([false]);
  });

  test(":commands opens the command list dialog over the workspace; / searches it; Enter runs a command or starts its command line", async () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1)]));
    // The toolkit's overlay stack, reduced to what dialogs need.
    const host: OverlayHost = {
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
    session.setOverlayHost(host);
    await session.execute("commands");
    expect(session.view).toBe("workspace");
    expect(session.dialog?.label).toBe("commands");
    session.openPrompt("/");
    session.promptInsert("messages");
    await session.submitPrompt();
    session.input("\r");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.dialog).toBeNull();
    expect(session.view).toBe("messages");
    session.closeView();
    await session.execute("commands focus");
    session.input("\r");
    expect(session.dialog).toBeNull();
    expect(session.view).toBe("workspace");
    expect(session.prompt?.kind).toBe(":");
    expect(session.prompt?.text).toBe("focus ");
    expect(session.keys.mode()).toBe("COMMAND");
  });
});

describe("prompt line", () => {
  test("typing, cursor keys and backspace edit the line; backspace on an empty line cancels back to NORMAL", () => {
    const { session } = makeSession();
    session.openPrompt(":");
    expect(session.keys.mode()).toBe("COMMAND");
    session.promptInsert("opn");
    session.promptKey("left");
    session.promptInsert("e");
    expect([session.prompt?.kind, session.prompt?.text, session.prompt?.cursor]).toEqual([":", "open", 3]);
    session.promptKey("home");
    session.promptKey("delete");
    expect([session.prompt?.text, session.prompt?.cursor]).toEqual(["pen", 0]);
    session.promptInsert("o");
    session.promptKey("end");
    session.promptKey("backspace");
    expect(session.prompt?.text).toBe("ope");
    session.promptKey("ctrl+u");
    expect(session.prompt?.text).toBe("");
    expect(session.promptKey("backspace")).toBe("cancel");
    expect(session.prompt).toBeNull();
    expect(session.keys.mode()).toBe("NORMAL");
  });

  test("Tab completes commands and fixed arguments from the registry; / completes #tags", () => {
    const { session } = makeSession();
    session.applySnapshot({
      ...snapshot("e:1", [task(1, { tags: ["bug"] })]),
      tags: [
        { name: "bug", color: null, created: 0, task_count: 1 },
        { name: "build", color: null, created: 0, task_count: 0 },
      ],
    });
    session.openPrompt(":");
    session.promptInsert("config do");
    session.promptKey("tab");
    expect(session.prompt?.text).toBe("config done");
    expect(session.describeCandidate("config done")).toBeUndefined();
    session.closePrompt();
    session.openPrompt("/");
    session.promptInsert("login #bu");
    session.promptKey("tab");
    expect(session.prompt?.text).toBe("login #bug");
    session.promptKey("tab");
    expect(session.prompt?.text).toBe("login #build");
  });

  test("each prompt kind keeps its own history across openings", async () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1)]));
    session.openPrompt(":");
    session.promptInsert("help");
    await session.submitPrompt();
    session.openPrompt("/");
    session.promptInsert("needle");
    await session.submitPrompt();
    session.openPrompt(":");
    session.promptKey("up");
    expect(session.prompt?.text).toBe("help");
    session.promptKey("down");
    expect(session.prompt?.text).toBe("");
    session.closePrompt();
    session.openPrompt("/");
    session.promptKey("up");
    expect(session.prompt?.text).toBe("needle");
  });

  test("pasted newlines never execute: they become spaces", () => {
    const { session } = makeSession();
    session.openPrompt(":");
    session.promptPaste("q\n!");
    expect(session.prompt?.text).toBe("q !");
  });

  test("submitting runs the command line or applies the search; an empty search clears the query", async () => {
    const quits: boolean[] = [];
    const { session } = makeSession({ onQuit: force => quits.push(force) });
    session.applySnapshot(snapshot("e:1", [task(1, { title: "alpha" }), task(2, { title: "beta" })]));
    session.openPrompt("/");
    session.promptInsert("beta");
    await session.submitPrompt();
    expect(session.query).toBe("beta");
    expect(session.prompt).toBeNull();
    session.openPrompt("/");
    await session.submitPrompt();
    expect(session.query).toBe("");
    session.openPrompt(":");
    session.promptInsert("q");
    await session.submitPrompt();
    expect(quits).toEqual([false]);
  });
});

describe("messages", () => {
  test("startup problems become messages and a persistent warning count; notices are shown once", () => {
    const { session } = makeSession({
      problems: [
        { level: "warn", text: "tui.toml: keys.normal.down: unknown key" },
        { level: "info", text: "this terminal shows 16 colors" },
      ],
    });
    expect(session.warnings).toBe(1);
    expect(session.messages.map(m => m.text)).toEqual([
      "tui.toml: keys.normal.down: unknown key",
      "this terminal shows 16 colors",
    ]);
    session.addProblems([{ level: "info", text: "this terminal shows 16 colors" }]);
    expect(session.messages.length).toBe(2);
    session.clearStatus();
    expect(session.status).toBeNull();
    expect(session.warnings).toBe(1);
  });
});

describe("dialogs, input routing and writes (Task 8 part B)", () => {
  test("input takes ONE route: the open prompt, then the top dialog, then the workspace's key handler", async () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1), task(2)]));
    const seen: string[] = [];
    session.setKeyHandler(event => void seen.push(`workspace:${event.type}`));
    const dialog: SessionDialog = {
      label: "fake",
      mode: () => "NORMAL",
      hints: () => "",
      handleRaw: data => {
        if (data !== "y") return false;
        seen.push("raw:y");
        return true;
      },
      handleKey: event => void seen.push(`dialog:${event.type}`),
      search: text => void seen.push(`search:${text}`),
      write: () => {
        seen.push("write");
        return true;
      },
      quit: force => void seen.push(`quit:${force}`),
      blocksCommands: () => false,
      close: () => {
        seen.push("close");
        session.removeDialog(dialog);
      },
    };
    session.input("j");
    session.pushDialog(dialog);
    expect(session.dialog).toBe(dialog);
    for (const data of ["j", "y", "/", "x", "\r", ":", "w", "\r", ":", "q", "\r"]) session.input(data);
    await settle();
    expect(seen).toEqual(["workspace:action", "dialog:action", "raw:y", "search:x", "write", "quit:false"]);
    // Any other command closes the (draft-free) dialogs first, then runs.
    for (const data of [":", "2", "\r"]) session.input(data);
    await settle();
    expect(seen.at(-1)).toBe("close");
    expect(session.dialog).toBeNull();
    expect(session.selectedId).toBe(2);
  });

  test("mutate runs one write at a time, in order; `writing` shows one in flight; a failure never blocks the next", async () => {
    const { session } = makeSession();
    const order: string[] = [];
    let release = (): void => {};
    const first = session.mutate(async () => {
      order.push("first:start");
      await new Promise<void>(resolve => {
        release = resolve;
      });
      order.push("first:end");
      return 1;
    });
    const second = session.mutate(async () => {
      order.push("second");
      return 2;
    });
    await settle();
    expect(order).toEqual(["first:start"]);
    expect(session.writing).toBe(true);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(session.writing).toBe(false);
    await expect(
      session.mutate(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await session.mutate(async () => 3)).toBe(3);
  });

  test("revealTask selects a created task at once or when the stream delivers it; explicit navigation wins; it is bounded", async () => {
    const { session } = makeSession();
    session.applySnapshot(snapshot("e:1", [task(1), task(2)]));
    expect(await session.revealTask(2)).toBe(true);
    expect(session.selectedId).toBe(2);
    const later = session.revealTask(3);
    session.receive(ev("task.added", "e:2", task(3)));
    expect(await later).toBe(true);
    expect(session.selectedId).toBe(3);
    // A reveal is a jump: :back returns to the task shown before it.
    session.back();
    expect(session.selectedId).toBe(2);
    // The user moved first: the late arrival never steals the selection.
    const dropped = session.revealTask(4);
    session.select(1);
    session.receive(ev("task.added", "e:3", task(4)));
    expect(await dropped).toBe(false);
    expect(session.selectedId).toBe(1);
    const never = session.revealTask(99, 500);
    expect(clock.pending()).toContain(500);
    clock.flush();
    expect(await never).toBe(false);
    expect(session.selectedId).toBe(1);
  });
});
