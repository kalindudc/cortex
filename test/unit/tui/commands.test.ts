import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { HttpError, TransportError } from "../../../src/api.ts";
import type {
  CortexClient,
  DaemonIdentity,
  TagWithCount,
  VersionConflict,
  Versions,
  WorkspaceSnapshot,
} from "../../../src/contracts.ts";
import type { Lane, Task, TaskStatus } from "../../../src/store.ts";
import { nextStatusFor, STATUS } from "../../../src/lib/constants.ts";
import { UNTAGGED } from "../../../src/lib/taskView.ts";
import {
  COMMANDS,
  CommandError,
  commandHelp,
  completeCommandLine,
  describeCandidate,
  openFilterPicker,
  findCommand,
  parseCommand,
  reportPendingMigrations,
  searchCommands,
  themeSourceText,
} from "../../../src/tui/commands.ts";
import { DEFAULT_CONFIG, loadConfig } from "../../../src/tui/config.ts";
import type { Dialog } from "../../../src/tui/dialogs.ts";
import {
  DEFAULT_KEYS,
  INSERT_ACTIONS,
  type InsertAction,
  NORMAL_ACTIONS,
  type NormalAction,
  VISUAL_ACTIONS,
  type VisualAction,
} from "../../../src/tui/keys.ts";
import { openPreferences, type PreferenceSession, readPreferences, TASK_SORTS } from "../../../src/tui/preferences.ts";
import { type OverlayHost, type SessionOptions, type ThemeControl, TuiSession } from "../../../src/tui/session.ts";
import { resolveTheme, type ResolvedTheme } from "../../../src/tui/theme.ts";

// Plan @400 N17/P9 (Task 8, part A): ONE registry (name, aliases, usage,
// description, completer, handler) drives execution, completion, `?`/:help
// and the searchable :commands reference.

// FIXED list, deliberately NOT derived from the registry, so removing a
// command fails a test. Input lines, the command and argument each must
// resolve to, and a prefix whose completion must offer the name.
const COMMAND_CASES: readonly { input: string; name: string; argument: string; prefix?: string }[] = [
  { input: "open 2", name: "open", argument: "2", prefix: "op" },
  { input: "2", name: "open", argument: "2" },
  { input: "@2", name: "open", argument: "@2" },
  { input: "filter status review", name: "filter", argument: "status review", prefix: "fil" },
  { input: "clear", name: "clear", argument: "", prefix: "cl" },
  { input: "sort -updated", name: "sort", argument: "-updated", prefix: "sor" },
  { input: "sort", name: "sort", argument: "" },
  { input: "group lane", name: "group", argument: "lane", prefix: "gr" },
  { input: "set done!", name: "set", argument: "done!", prefix: "se" },
  { input: "focus document", name: "focus", argument: "document", prefix: "fo" },
  { input: "back", name: "back", argument: "", prefix: "ba" },
  { input: "forward", name: "forward", argument: "", prefix: "forw" },
  { input: "suspend", name: "suspend", argument: "", prefix: "su" },
  { input: "q", name: "quit", argument: "", prefix: "qu" },
  { input: "quit", name: "quit", argument: "" },
  { input: "q!", name: "quit!", argument: "", prefix: "quit" },
  { input: "messages", name: "messages", argument: "", prefix: "me" },
  { input: "help", name: "help", argument: "", prefix: "he" },
  { input: "h", name: "help", argument: "" },
  { input: "commands", name: "commands", argument: "", prefix: "comm" },
  { input: "new", name: "new", argument: "", prefix: "ne" },
  { input: "new Fix the thing", name: "new", argument: "Fix the thing" },
  { input: "title Better title", name: "title", argument: "Better title", prefix: "ti" },
  { input: "title", name: "title", argument: "" },
  { input: "status review", name: "status", argument: "review", prefix: "sta" },
  { input: "status", name: "status", argument: "" },
  { input: "next", name: "next", argument: "", prefix: "nex" },
  { input: "priority 2", name: "priority", argument: "2", prefix: "pr" },
  { input: "priority none", name: "priority", argument: "none" },
  { input: "lane later", name: "lane", argument: "later", prefix: "lan" },
  { input: "tag +bug -old", name: "tag", argument: "+bug -old", prefix: "ta" },
  { input: "delete", name: "delete", argument: "", prefix: "de" },
  { input: "lanes", name: "lanes", argument: "", prefix: "lanes" },
  { input: "tags", name: "tags", argument: "", prefix: "tags" },
  { input: "theme", name: "theme", argument: "", prefix: "th" },
  { input: "theme auto", name: "theme", argument: "auto" },
  // The spacing, saved like the theme (a terminal cannot set its font size)
  { input: "density", name: "density", argument: "", prefix: "den" },
  { input: "density compact", name: "density", argument: "compact" },
  { input: "w", name: "write", argument: "", prefix: "wr" },
  { input: "write", name: "write", argument: "" },
  { input: "wq", name: "wq", argument: "", prefix: "wq" },
  { input: "x", name: "wq", argument: "" },
  { input: "read", name: "read", argument: "", prefix: "rea" },
  { input: "r", name: "read", argument: "" },
  { input: "edit", name: "edit", argument: "", prefix: "ed" },
  { input: "e", name: "edit", argument: "" },
  { input: "split", name: "split", argument: "", prefix: "spl" },
  { input: "sp", name: "split", argument: "" },
  { input: "w ~/draft.md", name: "write", argument: "~/draft.md" },
  { input: "w @3 ~/draft.md", name: "write", argument: "@3 ~/draft.md" },
  { input: "w! ~/draft.md", name: "write!", argument: "~/draft.md", prefix: "write!" },
  { input: "apply", name: "apply", argument: "", prefix: "ap" },
  { input: "apply body", name: "apply", argument: "body" },
  { input: "keep", name: "keep", argument: "", prefix: "ke" },
  { input: "keep title", name: "keep", argument: "title" },
  { input: "activity", name: "activity", argument: "", prefix: "act" },
  { input: "related", name: "related", argument: "", prefix: "rel" },
  { input: "authors", name: "authors", argument: "", prefix: "au" },
  { input: "post", name: "post", argument: "", prefix: "po" },
  { input: "post Shipped the fix", name: "post", argument: "Shipped the fix" },
  { input: "backup", name: "backup", argument: "", prefix: "bac" },
  { input: "resume", name: "resume", argument: "", prefix: "res" },
  { input: "heading", name: "heading", argument: "", prefix: "hea" },
  { input: "heading plan-2", name: "heading", argument: "plan-2" },
  { input: "links", name: "links", argument: "", prefix: "li" },
  { input: "copy 2", name: "copy", argument: "2", prefix: "cop" },
  { input: "source", name: "source", argument: "", prefix: "so" },
  { input: "notifications", name: "notifications", argument: "", prefix: "no" },
];

// FIXED, deliberately NOT derived from keys.ts: what every key-table action
// does. `{ command }` means the key is a shortcut for that registry command;
// "handled" means the shell acts on it directly. Either way every NORMAL
// action must have its own case in the shell's action switch and be listed
// there as available (never "(later)" in help); every VISUAL operator must
// be handled by the shell's VISUAL operator method.
const KEY_ACTION_TARGETS: Readonly<
  Record<NormalAction | InsertAction | VisualAction, { command: string } | "handled">
> = {
  down: "handled",
  up: "handled",
  left: "handled",
  right: "handled",
  half_down: "handled",
  half_up: "handled",
  top: "handled",
  bottom: "handled",
  word_forward: "handled",
  word_backward: "handled",
  word_end: "handled",
  line_end: "handled",
  next_pane: "handled",
  previous_pane: "handled",
  next_panel: "handled",
  previous_panel: "handled",
  next_heading: "handled",
  previous_heading: "handled",
  next_match: "handled",
  previous_match: "handled",
  insert: "handled",
  post: { command: "post" },
  undo: "handled",
  redo: "handled",
  visual: "handled",
  visual_line: "handled",
  paste_after: "handled",
  paste_before: "handled",
  help: { command: "help" },
  commands: { command: "commands" },
  back: { command: "back" },
  forward: { command: "forward" },
  suspend: { command: "suspend" },
  focus_tasks: { command: "focus" },
  focus_document: { command: "focus" },
  toggle_tasks: { command: "set" },
  toggle_done: { command: "set" },
  read: { command: "read" },
  edit: { command: "edit" },
  split: { command: "split" },
  tags: { command: "tag" },
  status: { command: "status" },
  sort: { command: "sort" },
  filters: { command: "filter" },
  clear_filters: { command: "clear" },
  save: { command: "write" },
  yank: "handled",
  delete: "handled",
  change: "handled",
  indent: "handled",
  outdent: "handled",
  other_end: "handled",
};

const APP_SOURCE = fs.readFileSync(path.resolve(import.meta.dir, "..", "..", "..", "src", "tui", "app.ts"), "utf8");

/** The action names with a `case` in the shell's `#onAction` switch (src/tui/app.ts). */
function shellActionCases(): Set<string> {
  const start = APP_SOURCE.indexOf("#onAction(action: NormalAction");
  expect(start, "src/tui/app.ts: the shell's #onAction(action: NormalAction, ...) switch").toBeGreaterThan(-1);
  const end = APP_SOURCE.indexOf("\n  #", start + 1);
  const body = APP_SOURCE.slice(start, end < 0 ? undefined : end);
  return new Set([...body.matchAll(/case "([a-z_]+)":/g)].map(m => m[1] ?? ""));
}

/** The NORMAL actions the shell lists as available (the rest show "(later)" in help). */
function shellAvailableActions(): Set<string> {
  const m = /const AVAILABLE_ACTIONS\b[^=]*=\s*new Set<NormalAction>\(\[([\s\S]*?)\]\)/.exec(APP_SOURCE);
  expect(m, "src/tui/app.ts: the AVAILABLE_ACTIONS set").not.toBeNull();
  return new Set([...(m?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map(x => x[1] ?? ""));
}

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

const LANES: Lane[] = [
  { name: "now", color: null, sort: 0 },
  { name: "later", color: null, sort: 1 },
  { name: "big ideas", color: null, sort: 2 },
];
const TAGS: TagWithCount[] = [
  { name: "bug", color: null, created: 0, task_count: 2 },
  { name: "ui", color: null, created: 0, task_count: 1 },
  { name: "docs", color: null, created: 0, task_count: 1 },
];
const TASKS: Task[] = [
  task(1, { title: "Fix the login flow", tags: ["bug"] }),
  task(2, { title: "Write the docs", tags: ["docs"] }),
  task(3, { lane: "later", title: "Polish the UI", tags: ["ui", "bug"], status: "review" }),
  task(12, { title: "Shipped already", status: "done" }),
  task(13, { lane: "big ideas", title: "Dream big" }),
];

let dir: string;
let prefs: PreferenceSession;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-commands-"));
  prefs = openPreferences(path.join(dir, "tui", "default.state.json"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeSession(over: Partial<SessionOptions> = {}): TuiSession {
  const snapshot: WorkspaceSnapshot = {
    identity: IDENTITY,
    cursor: "e:1",
    tasks: TASKS,
    lanes: LANES,
    tags: TAGS,
    notifications: [],
  };
  const session = new TuiSession({
    client: { workspace: async () => snapshot } as unknown as CortexClient,
    identity: IDENTITY,
    keys: DEFAULT_KEYS,
    preferences: prefs,
    configFile: path.join(dir, "tui.toml"),
    schedule: () => () => {},
    ...over,
  });
  session.applySnapshot(snapshot);
  return session;
}

describe("command parsing, completion and help", () => {
  const session = () => makeSession();

  for (const r of COMMAND_CASES) {
    test(`:${r.input} parses, completes and has help`, () => {
      const parsed = parseCommand(r.input, COMMANDS);
      expect(parsed.spec.name).toBe(r.name);
      expect(parsed.argument).toBe(r.argument);
      // Leading ":" and surrounding blanks are accepted.
      expect(parseCommand(` :${r.input} `, COMMANDS).spec.name).toBe(r.name);
      if (r.prefix !== undefined) expect(completeCommandLine(r.prefix, COMMANDS, session())).toContain(r.name);
      const help = commandHelp(COMMANDS).find(h => h.name === r.name);
      expect(help?.usage.startsWith(":")).toBe(true);
      expect((help?.description.length ?? 0) > 0).toBe(true);
      expect(searchCommands(COMMANDS, r.name).map(s => s.name)).toContain(r.name);
    });
  }

  test("every registry entry has a usage, a description and unique names", () => {
    const names = COMMANDS.flatMap(c => [c.name, ...c.aliases]);
    expect(new Set(names).size).toBe(names.length);
    for (const c of COMMANDS) {
      expect(c.usage.startsWith(":")).toBe(true);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});

describe("every key-table action maps to a handled action or a command", () => {
  test("the fixed map covers exactly the key-table actions", () => {
    expect(Object.keys(KEY_ACTION_TARGETS).sort()).toEqual(
      [...NORMAL_ACTIONS, ...INSERT_ACTIONS, ...VISUAL_ACTIONS].sort(),
    );
  });

  test("each command target is a registry command with help", () => {
    for (const [action, target] of Object.entries(KEY_ACTION_TARGETS)) {
      if (target === "handled") continue;
      const spec = findCommand(target.command, COMMANDS);
      expect(spec?.name, `${action} is a shortcut for :${target.command}`).toBe(target.command);
      expect(commandHelp(COMMANDS).find(h => h.name === target.command)?.description.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("the shell has a case for every NORMAL action and lists it as available", () => {
    const cases = shellActionCases();
    const available = shellAvailableActions();
    expect(
      NORMAL_ACTIONS.filter(a => !cases.has(a)),
      "actions without a case in #onAction",
    ).toEqual([]);
    expect(
      NORMAL_ACTIONS.filter(a => !available.has(a)),
      "actions help lists as (later)",
    ).toEqual([]);
    expect(
      [...cases].filter(c => !(NORMAL_ACTIONS as readonly string[]).includes(c)),
      "stale cases",
    ).toEqual([]);
  });

  test("the shell's VISUAL operator method handles every [keys.visual] action", () => {
    const start = APP_SOURCE.indexOf("#onVisualAction(action: VisualAction");
    expect(start, "src/tui/app.ts: the shell's #onVisualAction(action: VisualAction, ...) method").toBeGreaterThan(-1);
    const end = APP_SOURCE.indexOf("\n  #", start + 1);
    const body = APP_SOURCE.slice(start, end < 0 ? undefined : end);
    expect(VISUAL_ACTIONS.filter(a => !body.includes(`"${a}"`))).toEqual([]);
  });
});

describe("parseCommand", () => {
  test("empty and unknown commands explain themselves", () => {
    expect(() => parseCommand("   ", COMMANDS)).toThrow(CommandError);
    expect(() => parseCommand("frobnicate now", COMMANDS)).toThrow(/Unknown command :frobnicate.*:help/);
  });

  test("the argument keeps inner spacing but not surrounding blanks", () => {
    expect(parseCommand("filter lane  big ideas ", COMMANDS).argument).toBe("lane  big ideas");
  });
});

describe("completion (commands and fixed arguments)", () => {
  test("command names from the typed prefix, alphabetically", () => {
    const s = makeSession();
    expect(completeCommandLine("f", COMMANDS, s)).toEqual(["filter", "focus", "forward"]);
    expect(completeCommandLine("q", COMMANDS, s)).toEqual(["quit", "quit!"]);
    expect(completeCommandLine("", COMMANDS, s).length).toBe(COMMANDS.length);
    expect(completeCommandLine("zzz", COMMANDS, s)).toEqual([]);
  });

  test(":open and :<id> complete task ids by id prefix or by title search", () => {
    const s = makeSession();
    expect(completeCommandLine("open 1", COMMANDS, s)).toEqual(["open 1", "open 12", "open 13"]);
    expect(completeCommandLine("1", COMMANDS, s)).toEqual(["1", "12", "13"]);
    expect(completeCommandLine("open docs", COMMANDS, s)).toEqual(["open 2"]);
    expect(describeCandidate("open 12", COMMANDS, s)).toBe("Shipped already");
    expect(describeCandidate("13", COMMANDS, s)).toBe("Dream big");
    expect(describeCandidate("clear", COMMANDS, s)).toMatch(/filter/i);
  });

  test(":filter completes slots, then statuses, lanes and tags", () => {
    const s = makeSession();
    expect(completeCommandLine("filter ", COMMANDS, s)).toEqual(["filter lane", "filter status", "filter tags"]);
    expect(completeCommandLine("filter status r", COMMANDS, s)).toEqual(["filter status review"]);
    expect(completeCommandLine("filter lane ", COMMANDS, s)).toEqual([
      "filter lane now",
      "filter lane later",
      "filter lane big ideas",
    ]);
    expect(completeCommandLine("filter lane b", COMMANDS, s)).toEqual(["filter lane big ideas"]);
    expect(completeCommandLine("filter tags bug u", COMMANDS, s)).toEqual([
      "filter tags bug ui",
      "filter tags bug untagged",
    ]);
    expect(completeCommandLine("filter tags +d", COMMANDS, s)).toEqual(["filter tags +docs"]);
  });

  test(":set and :focus complete their fixed arguments; aliases keep the typed name", () => {
    const s = makeSession();
    expect(completeCommandLine("set d", COMMANDS, s)).toEqual(["set done", "set done!"]);
    expect(completeCommandLine("set no", COMMANDS, s)).toEqual(["set nodone", "set nonumber", "set notasks"]);
    expect(completeCommandLine("set nu", COMMANDS, s)).toEqual(["set number", "set number!"]);
    expect(completeCommandLine("focus ", COMMANDS, s)).toEqual(["focus document", "focus list"]);
    expect(completeCommandLine("help x", COMMANDS, s)).toEqual([]);
  });
});

describe("running the navigation commands", () => {
  test(":open <id> and :<id> jump globally and KEEP the filters; misses explain themselves", async () => {
    const s = makeSession();
    s.setQuery("login");
    s.setFilter({ status: "open", lane: "now", tags: ["bug"] });
    await s.execute("open 3");
    expect(s.selectedId).toBe(3);
    expect(s.query).toBe("login");
    expect(s.filter).toEqual({ status: "open", lane: "now", tags: ["bug"] });
    expect(s.isVisible(3)).toBe(false);
    await s.execute("@2");
    expect(s.selectedId).toBe(2);
    await s.execute("open 99");
    expect(s.selectedId).toBe(2);
    expect(s.status).toMatchObject({ level: "error" });
    expect(s.status?.text).toContain("@99");
    await s.execute("open");
    expect(s.status?.text).toMatch(/:open <id\|query>/);
  });

  test(":open <query> jumps to the best match of the WHOLE pool, done and filtered tasks included", async () => {
    const s = makeSession();
    s.setFilter({ status: null, lane: "later", tags: [] });
    await s.execute("open docs");
    expect(s.selectedId).toBe(2);
    await s.execute("open shipped");
    expect(s.selectedId).toBe(12);
    await s.execute("open zzzz");
    expect(s.selectedId).toBe(12);
    expect(s.status?.text).toMatch(/No task matches/);
  });

  test(":filter sets each slot; a bare slot clears it; +tag/-tag adjust; bad input explains", async () => {
    const s = makeSession();
    await s.execute("filter status review");
    await s.execute("filter lane big ideas");
    await s.execute("filter tags bug untagged");
    expect(s.filter).toEqual({ status: "review", lane: "big ideas", tags: ["bug", UNTAGGED] });
    await s.execute("filter tags +ui -bug");
    expect(s.filter.tags).toEqual([UNTAGGED, "ui"]);
    await s.execute("filter tags #docs");
    expect(s.filter.tags).toEqual(["docs"]);
    await s.execute("filter tags +ui -docs");
    expect(s.filter.tags).toEqual(["ui"]);
    await s.execute("filter lane");
    await s.execute("filter status");
    expect(s.filter).toEqual({ status: null, lane: null, tags: ["ui"] });
    for (const [line, message] of [
      ["filter status nope", /Unknown status "nope"/],
      ["filter lane nowhere", /No lane "nowhere"/],
      ["filter tags nope", /No tag "nope"/],
      ["filter colour red", /Unknown filter "colour"/],
    ] as const) {
      await s.execute(line);
      expect(s.status?.level).toBe("error");
      expect(s.status?.text).toMatch(message);
    }
    expect(s.filter).toEqual({ status: null, lane: null, tags: ["ui"] });
  });

  test(":clear clears the search and the slots but keeps include-done", async () => {
    const s = makeSession();
    s.setQuery("x");
    s.setFilter({ status: "open", lane: "now", tags: ["bug"] });
    s.setIncludeDone(true);
    await s.execute("clear");
    expect(s.query).toBe("");
    expect(s.filter).toEqual({ status: null, lane: null, tags: [] });
    expect(s.includeDone).toBe(true);
    await s.execute("clear now");
    expect(s.status?.text).toMatch(/takes no argument/);
  });

  test(":set toggles, sets, clears and reports options; unknown options explain", async () => {
    const s = makeSession();
    expect(s.includeDone).toBe(false);
    await s.execute("set done!");
    expect(s.includeDone).toBe(true);
    expect(s.isVisible(12)).toBe(true);
    await s.execute("set nodone");
    expect(s.includeDone).toBe(false);
    await s.execute("set invdone");
    expect(s.includeDone).toBe(true);
    await s.execute("set done?");
    expect(s.status?.text).toBe("done (show done tasks): on");
    await s.execute("set tasks!");
    expect(s.taskListVisible).toBe(false);
    await s.execute("set tasks nodone");
    expect(s.taskListVisible).toBe(true);
    expect(s.includeDone).toBe(false);
    expect(s.lineNumbers).toBe(false);
    await s.execute("set number");
    expect(s.lineNumbers).toBe(true);
    await s.execute("set number!");
    expect(s.lineNumbers).toBe(false);
    await s.execute("set invnumber");
    await s.execute("set number?");
    expect(s.status?.text).toBe("number (source line numbers in Read and the Split preview): on");
    await s.execute("set nonumber");
    expect(s.lineNumbers).toBe(false);
    await s.execute("set");
    expect(s.status?.text).toContain("nodone");
    expect(s.status?.text).toContain("nonumber");
    await s.execute("set frob!");
    expect(s.status?.level).toBe("error");
    expect(s.status?.text).toMatch(/Unknown option "frob".*done.*tasks.*number/);
    // number is saved to tui.toml (by the debounced save; here, the explicit flush); done and tasks never are.
    await s.execute("set done! tasks! number");
    expect(s.savePreferences()).toBe(true);
    expect(fs.readFileSync(path.join(dir, "tui.toml"), "utf8")).toBe("number = true\n");
    expect([s.includeDone, s.taskListVisible]).toEqual([true, false]);
  });

  test(":focus list|document moves focus explicitly; anything else explains", async () => {
    const s = makeSession();
    await s.execute("focus document");
    expect(s.focus).toBe("document");
    await s.execute("focus list");
    expect(s.focus).toBe("tasks");
    await s.execute("focus tasks");
    expect(s.focus).toBe("tasks");
    await s.execute("focus sideways");
    expect(s.status?.text).toMatch(/:focus <list\|document>/);
  });

  test(":back and :forward walk the task history of jumps; the edges explain", async () => {
    const s = makeSession();
    expect(s.selectedTask()?.id).toBe(1);
    await s.execute("back");
    expect(s.status?.text).toMatch(/No earlier task/);
    await s.execute("open 2");
    await s.execute("open 3");
    await s.execute("back");
    expect(s.selectedId).toBe(2);
    await s.execute("back");
    expect(s.selectedId).toBe(1);
    await s.execute("forward");
    expect(s.selectedId).toBe(2);
    await s.execute("forward");
    expect(s.selectedId).toBe(3);
    await s.execute("forward");
    expect(s.status?.text).toMatch(/No later task/);
    // A new jump drops the forward history.
    await s.execute("back");
    await s.execute("open 13");
    await s.execute("forward");
    expect(s.selectedId).toBe(13);
  });

  test(":suspend asks the host to suspend; :q, :quit and :q! ask the app to quit; views open", async () => {
    const quits: boolean[] = [];
    let suspends = 0;
    const s = makeSession({ onQuit: force => quits.push(force) });
    s.setSuspendHandler(() => suspends++);
    await s.execute("suspend");
    expect(suspends).toBe(1);
    await s.execute("q");
    await s.execute("quit");
    await s.execute("q!");
    await s.execute("q now");
    expect(quits).toEqual([false, false, true]);
    expect(s.status?.text).toMatch(/takes no argument/);
    await s.execute("help");
    expect(s.view).toBe("help");
    await s.execute("messages");
    expect(s.view).toBe("messages");
    await s.execute("commands focus");
    expect(s.view).toBe("commands");
    expect(s.commandList().map(c => c.name)).toEqual(["focus"]);
  });
});

describe("the :commands reference", () => {
  test("searches names, aliases, usage and descriptions with AND keywords, uncapped", () => {
    expect(searchCommands(COMMANDS, "").length).toBe(COMMANDS.length);
    expect(searchCommands(COMMANDS, "q!").map(c => c.name)).toEqual(["quit!"]);
    expect(searchCommands(COMMANDS, "task history").map(c => c.name)).toEqual(["back", "forward"]);
  });
});

// ---------- metadata and management commands (P3/P4, Task 8 part B) ----------
//
// Every write goes through the shared guarded API (versioned, with a guard:
// the expected field/entity tokens read in ONE atomic state read, plus a
// mutation id). A 412 is a conflict shown with context and nothing is applied
// locally: the session never patches its own copy from a write result, the
// live stream does. Human status changes carry no author (N9).

type Call = { name: string; args: unknown[] };

const versionsOf = (id: number): Versions => ({
  entity: `entity-${id}`,
  title: `title-${id}`,
  body: `body-${id}`,
  priority: `priority-${id}`,
  lane: `lane-${id}`,
  status: `status-${id}`,
});
const catalogVersions = (name: string): Versions => ({ entity: `entity-${name}`, definition: `definition-${name}` });

const conflict = (kind: VersionConflict["kind"], key: number | string, scope: "status" | "title" | "entity") =>
  new HttpError(412, `version conflict on ${kind} ${key}`, "version_conflict", undefined, {
    kind,
    key,
    mismatches: [{ scope, expected: "old", current: "new" }],
    current: {},
  });

/**
 * A daemon stand-in: a server-side copy of tasks and catalogs, one record per
 * call, optional failures, and the live stream (every accepted write is
 * published to the attached session before the write answers, as the daemon
 * publishes after commit and before responding).
 */
function fakeDaemon(tasks: Task[] = TASKS) {
  const server = new Map<number, Task>(tasks.map(t => [t.id, structuredClone(t)]));
  const lanes = new Map<string, Lane>(LANES.map(l => [l.name, { ...l }]));
  const tags = new Map<string, TagWithCount>(TAGS.map(t => [t.name, { ...t }]));
  const calls: Call[] = [];
  const failures: { skip: number; error: Error }[] = [];
  let holdNext = false;
  let held: (() => void) | null = null;
  let session: TuiSession | null = null;
  let seq = 1;
  const publish = (kind: "task.added" | "task.updated" | "task.removed", payload: unknown) =>
    session?.receive({ kind, cursor: `e:${++seq}`, payload });
  const mustTask = (id: number): Task => {
    const t = server.get(id);
    if (!t) throw new HttpError(404, `task ${id} not found`);
    return t;
  };
  const write = async <T>(name: string, args: unknown[], apply: () => T): Promise<T> => {
    calls.push({ name, args });
    if (holdNext) {
      holdNext = false;
      await new Promise<void>(resolve => {
        held = resolve;
      });
    }
    const failure = failures[0];
    if (failure !== undefined) {
      if (failure.skip === 0) {
        failures.shift();
        throw failure.error;
      }
      failure.skip--;
    }
    return apply();
  };
  const taskWrite = (t: Task, kind: "task.added" | "task.updated" = "task.updated") => {
    server.set(t.id, t);
    publish(kind, structuredClone(t));
    return { task: structuredClone(t), versions: versionsOf(t.id), replayed: false };
  };
  const laneRow = (name: string) => {
    const lane = lanes.get(name);
    if (!lane) throw new HttpError(404, "not found");
    return lane;
  };
  const tagRow = (name: string) => {
    const tag = tags.get(name);
    if (!tag) throw new HttpError(404, "not found");
    return tag;
  };
  const client = {
    workspace: async () => ({
      identity: IDENTITY,
      cursor: `e:${seq}`,
      tasks: [...server.values()],
      lanes: [...lanes.values()],
      tags: [...tags.values()],
      notifications: [],
    }),
    taskState: async (id: number) => {
      calls.push({ name: "taskState", args: [id] });
      return { task: structuredClone(mustTask(id)), updates: [], versions: versionsOf(id), cursor: `e:${seq}` };
    },
    laneState: async (name: string) => {
      calls.push({ name: "laneState", args: [name] });
      const lane = laneRow(name);
      const count = [...server.values()].filter(t => t.lane === name).length;
      return { lane: { ...lane, task_count: count }, versions: catalogVersions(name), cursor: `e:${seq}` };
    },
    tagState: async (name: string) => {
      calls.push({ name: "tagState", args: [name] });
      return { tag: { ...tagRow(name) }, versions: catalogVersions(name), cursor: `e:${seq}` };
    },
    versioned: {
      addTask: (request: { title?: string; untitled?: boolean; lane?: string }, guard: unknown) =>
        write("addTask", [request, guard], () => {
          const id = Math.max(0, ...server.keys()) + 1;
          const title = request.untitled ? `untitled-${id}` : (request.title ?? "");
          return taskWrite(task(id, { title, lane: request.lane ?? "now" }), "task.added");
        }),
      editTask: (id: number, request: Partial<Task>, guard: unknown) =>
        write("editTask", [id, request, guard], () => taskWrite({ ...mustTask(id), ...request })),
      setStatus: (id: number, request: { status: TaskStatus }, guard: unknown) =>
        write("setStatus", [id, request, guard], () => taskWrite({ ...mustTask(id), status: request.status })),
      moveTask: (id: number, lane: string, guard: unknown) =>
        write("moveTask", [id, lane, guard], () => taskWrite({ ...mustTask(id), lane })),
      changeTags: (id: number, change: { add?: string[]; remove?: string[]; set?: string[] }, guard: unknown) =>
        write("changeTags", [id, change, guard], () => {
          const t = mustTask(id);
          const next = new Set(t.tags);
          for (const n of change.add ?? []) next.add(n);
          for (const n of change.remove ?? []) next.delete(n);
          return taskWrite({ ...t, tags: [...next].sort() });
        }),
      removeTask: (id: number, guard: unknown) =>
        write("removeTask", [id, guard], () => {
          mustTask(id);
          server.delete(id);
          publish("task.removed", { id });
          return { ok: true, replayed: false };
        }),
      addLane: (request: Lane, guard: unknown) =>
        write("addLane", [request, guard], () => {
          const lane = { name: request.name, color: request.color ?? null, sort: request.sort ?? 0 };
          lanes.set(lane.name, lane);
          return { lane, versions: catalogVersions(lane.name), replayed: false };
        }),
      editLane: (name: string, request: Record<string, unknown>, guard: unknown) =>
        write("editLane", [name, request, guard], () => {
          const lane = { ...laneRow(name), ...request };
          return { lane, versions: catalogVersions(name), replayed: false };
        }),
      removeLane: (name: string, guard: unknown) =>
        write("removeLane", [name, guard], () => {
          lanes.delete(name);
          return { ok: true, replayed: false };
        }),
      addTag: (request: { name: string; color?: string | null }, guard: unknown) =>
        write("addTag", [request, guard], () => {
          const tag = { name: request.name, color: request.color ?? null, created: 0 };
          return { tag, versions: catalogVersions(tag.name), replayed: false };
        }),
      editTag: (name: string, request: Record<string, unknown>, guard: unknown) =>
        write("editTag", [name, request, guard], () => ({
          tag: { ...tagRow(name), ...request },
          versions: catalogVersions(name),
          replayed: false,
        })),
      removeTag: (name: string, options: unknown, guard: unknown) =>
        write("removeTag", [name, options, guard], () => {
          tags.delete(name);
          return { ok: true, replayed: false };
        }),
    },
  };
  return {
    client: client as unknown as CortexClient,
    calls,
    server,
    lanes,
    tags,
    /** The write after `skip` more writes rejects with `error` (then writes succeed again). */
    fail: (error: Error, skip = 0) => void failures.push({ skip, error }),
    /** The next write is recorded but applied (and answered) only on release(). */
    holdNext: () => {
      holdNext = true;
    },
    release: () => {
      const resume = held;
      held = null;
      resume?.();
    },
    /** Another writer deleted the task (committed and published at once). */
    removeElsewhere: (id: number) => {
      server.delete(id);
      publish("task.removed", { id });
    },
    /** The session its live stream publishes to (null: its stream is gone). */
    attach: (s: TuiSession | null) => {
      session = s;
    },
    writes: () => calls.filter(c => c.name !== "taskState" && c.name !== "laneState" && c.name !== "tagState"),
  };
}

/** The toolkit's overlay stack, reduced to what dialogs need. */
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

function withDaemon(tasks: Task[] = TASKS, over: Partial<SessionOptions> = {}) {
  const daemon = fakeDaemon(tasks);
  const s = makeSession({ client: daemon.client, ...over });
  s.applySnapshot({ identity: IDENTITY, cursor: "e:1", tasks, lanes: LANES, tags: TAGS, notifications: [] });
  daemon.attach(s);
  s.setOverlayHost(fakeHost());
  s.setTheme(resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" } }));
  const type = (...inputs: string[]) => {
    for (const input of inputs) s.input(input);
  };
  return { s, daemon, type };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const flush = async () => {
  for (let i = 0; i < 10; i++) await settle();
};
const plainText = (lines: string[]): string => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
const topDialog = (s: TuiSession): Dialog => s.dialog as unknown as Dialog;

/** Nothing local changed: the same tasks, selection, filters and no preference file written. */
function snapshotOf(s: TuiSession) {
  return {
    tasks: structuredClone([...s.tasks]),
    selected: s.selectedTask()?.id ?? null,
    filter: s.filter,
    query: s.query,
    focus: s.focus,
    prefs: fs.existsSync(path.join(dir, "tui", "default.state.json")),
  };
}

describe(":sort and :group (the terminal's list order; ;o opens the picker)", () => {
  test("complete, set and persist; the list reorders; an unknown value explains and changes nothing", async () => {
    const { s } = withDaemon();
    expect(completeCommandLine("sort ", COMMANDS, s)).toEqual(TASK_SORTS.map(v => `sort ${v}`));
    expect(completeCommandLine("sort -", COMMANDS, s)).toEqual(["sort -id", "sort -title", "sort -updated"]);
    expect(completeCommandLine("group s", COMMANDS, s)).toEqual(["group status"]);
    expect(s.visibleTasks().map(t => t.id)).toEqual([1, 2, 3, 13]);
    await s.execute("sort -id");
    expect(s.sort).toBe("-id");
    expect(s.visibleTasks().map(t => t.id)).toEqual([13, 3, 2, 1]);
    await s.execute("group lane");
    expect(s.group).toBe("lane");
    expect(s.visibleTasks().map(t => t.id)).toEqual([2, 1, 3, 13]);
    await s.execute("sort size");
    expect(s.status?.text).toMatch(/Unknown order "size": id, -id, title/);
    await s.execute("group owner");
    expect(s.status?.text).toMatch(/Unknown grouping "owner": none, lane or status/);
    expect([s.sort, s.group]).toEqual(["-id", "lane"]);
    // While a search ranks the list, the chosen order waits (and says so).
    s.setQuery("the");
    await s.execute("sort title");
    expect(s.status?.text).toMatch(/relevance/);
    expect(s.sort).toBe("title");
  });

  test("bare :sort opens the picker: Space tries an order, Enter picks and closes; bare :group starts at the grouping", async () => {
    const { s, type } = withDaemon();
    await s.execute("sort");
    const picker = topDialog(s);
    expect(picker.label).toBe("sort");
    const text = plainText(picker.render(80));
    expect(text).toMatch(/Sort[\s\S]*\(•\) id[\s\S]*Group[\s\S]*\(•\) none/);
    type("j", " ");
    expect(s.sort).toBe("-id");
    expect(s.dialog).toBe(picker);
    type("G", "\r");
    expect(s.group).toBe("status");
    expect(s.dialog).toBeNull();
    await s.execute("group");
    expect(topDialog(s).highlighted()?.key).toBe("group:status");
    type("\x1b");
    expect(s.dialog).toBeNull();
    expect([s.sort, s.group]).toEqual(["-id", "status"]);
  });
});

describe("the filter picker (f): one-key toggles, live counts, type-to-search, F clears", () => {
  const keysOf = (d: Dialog) => d.visibleRows().map(r => r.key);

  test("a bare :filter opens the same picker; its summary names the active filters; Enter closes it and keeps them", async () => {
    const { s, type } = withDaemon();
    s.setFilter({ status: null, lane: null, tags: ["bug"] });
    await s.execute("filter");
    expect(topDialog(s).label).toBe("filters");
    expect(plainText(topDialog(s).render(96))).toContain("shown \u00b7 #bug");
    type("\r");
    expect(s.dialog).toBeNull();
    expect(s.filter.tags).toEqual(["bug"]);
  });

  test("letters toggle a status (again clears it; statuses are one slot), untagged and include-done; the list follows", () => {
    const { s, type } = withDaemon();
    openFilterPicker(s);
    const picker = topDialog(s);
    expect(picker.label).toBe("filters");
    type("r");
    expect(s.filter.status).toBe("review");
    expect(s.visibleTasks().map(t => t.id)).toEqual([3]);
    type("o");
    expect(s.filter.status).toBe("open");
    type("o");
    expect(s.filter.status).toBeNull();
    type("u");
    expect(s.filter.tags).toEqual([UNTAGGED]);
    expect(s.visibleTasks().map(t => t.id)).toEqual([13]);
    type("a");
    expect(s.includeDone).toBe(true);
    expect(s.visibleTasks().map(t => t.id)).toEqual([12, 13]);
    type("x");
    expect(s.filter.status).toBe("done");
    // F clears the search and every slot, like :clear: include-done stays.
    s.setQuery("ship");
    type("F");
    expect([s.query, s.filter]).toEqual(["", { status: null, lane: null, tags: [] }]);
    expect(s.includeDone).toBe(true);
    expect(s.dialog).toBe(picker);
  });

  test("Status, Lane and Tags sections with live counts; Space toggles the highlighted row; Enter and Esc close and keep the filters", () => {
    const { s, type } = withDaemon();
    openFilterPicker(s);
    const picker = topDialog(s);
    let text = plainText(picker.render(96));
    expect(text).toContain("4 tasks shown · no filters");
    expect(text).toMatch(/Status[\s\S]*Lane[\s\S]*Tags/);
    expect(text).toMatch(/\( \) ● open +3 · o/);
    expect(text).toMatch(/\( \) now +2/);
    expect(text).toMatch(/\[ \] untagged +1 · u/);
    expect(text).toMatch(/\[ \] #bug +2/);
    expect(keysOf(picker).slice(0, 7)).toEqual([
      "status:draft",
      "status:open",
      "status:review",
      "status:blocked",
      "status:done",
      "done",
      "lane:now",
    ]);
    // j to the first lane, Space picks it (lanes are one slot); the counts follow at once.
    type("j", "j", "j", "j", "j", "j", " ");
    expect(s.filter.lane).toBe("now");
    expect(s.visibleTasks().map(t => t.id)).toEqual([1, 2]);
    text = plainText(picker.render(96));
    expect(text).toContain("2 tasks shown · lane:now");
    expect(text).toMatch(/\(\u2022\) now +2/);
    expect(text).toMatch(/\( \) ● open +2 · o/);
    type("\r");
    expect(s.dialog).toBeNull();
    expect(s.filter.lane).toBe("now");
    openFilterPicker(s);
    type("\x1b");
    expect(s.dialog).toBeNull();
    expect(s.filter.lane).toBe("now");
  });

  test("/ searches the lanes and tags as you type (uncapped); statuses stay; Esc in the prompt restores the last search", () => {
    const { s, type } = withDaemon();
    openFilterPicker(s);
    const picker = topDialog(s);
    const fixed = ["status:draft", "status:open", "status:review", "status:blocked", "status:done", "done"];
    type("/", "d", "o");
    expect(s.prompt?.text).toBe("do");
    expect(keysOf(picker)).toEqual([...fixed, "tag:\u0000untagged", "tag:docs"]);
    type("\x1b");
    expect(s.prompt).toBeNull();
    expect(keysOf(picker)).toContain("lane:big ideas");
    type("/", "u", "i", "\r");
    expect(picker.filter).toBe("ui");
    expect(picker.highlighted()?.key).toBe("tag:ui");
    type(" ");
    expect(s.filter.tags).toEqual(["ui"]);
    expect(s.visibleTasks().map(t => t.id)).toEqual([3]);
    // Every lane and tag is listed: the search is never capped.
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `t${i}`, color: null, created: 0, task_count: 0 }));
    s.applySnapshot({ identity: IDENTITY, cursor: "e:9", tasks: TASKS, lanes: LANES, tags: many, notifications: [] });
    picker.search("");
    expect(keysOf(picker).filter(k => k.startsWith("tag:t")).length).toBe(300);
  });
});

describe(":new (atomic create)", () => {
  test("without a title: ONE untitled create in the filtered lane (else now), deduplicated, then the new task is selected", async () => {
    const { s, daemon } = withDaemon();
    await s.execute("new");
    expect(daemon.writes()).toEqual([{ name: "addTask", args: [{ untitled: true, lane: "now" }, undefined] }]);
    expect(s.selectedTask()?.title).toBe("untitled-14");
    expect(s.status?.text).toMatch(/Created @14 untitled-14.*:title/);
    s.setFilter({ status: null, lane: "later", tags: [] });
    await s.execute("new Plan the launch");
    expect(daemon.writes()[1]).toEqual({
      name: "addTask",
      args: [{ title: "Plan the launch", lane: "later" }, undefined],
    });
    expect(s.selectedTask()?.title).toBe("Plan the launch");
    // Creating never touched the view choices.
    expect(s.filter).toEqual({ status: null, lane: "later", tags: [] });
  });

  test("a failed create keeps its context and changes nothing", async () => {
    const { s, daemon } = withDaemon();
    const before = snapshotOf(s);
    daemon.fail(new HttpError(400, "invalid status"));
    await s.execute("new Something");
    expect(s.status?.level).toBe("error");
    expect(s.status?.text).toMatch(/Could not create.*invalid status/);
    expect(snapshotOf(s)).toEqual(before);
  });
});

describe(":status and :next (smart transition)", () => {
  test(":status sends a guarded, deduplicated status write WITHOUT an author (a human change, not an agent's)", async () => {
    const { s, daemon } = withDaemon();
    await s.execute("status review");
    expect(daemon.writes()).toEqual([
      { name: "setStatus", args: [1, { status: "review" }, { expected: { status: "status-1" } }] },
    ]);
    const request = daemon.writes()[0]?.args[1] as Record<string, unknown>;
    expect(Object.keys(request)).toEqual(["status"]);
    expect(s.selectedTask()?.status).toBe("review");
    expect(s.status?.text).toMatch(/@1.*In review/);
    // Metadata is not filtering: no filter or view choice changed.
    expect(s.filter).toEqual({ status: null, lane: null, tags: [] });
  });

  test(":status validates its argument and skips a no-op", async () => {
    const { s, daemon } = withDaemon();
    await s.execute("status nope");
    expect(s.status?.text).toMatch(/Unknown status "nope"/);
    await s.execute("status open");
    expect(s.status?.text).toMatch(/already Open/);
    expect(daemon.writes()).toEqual([]);
  });

  test(":next is nextStatusFor: draft→open, open→review, review→done, blocked→open, done→open", async () => {
    const expected: Record<TaskStatus, TaskStatus> = {
      draft: "open",
      open: "review",
      review: "done",
      blocked: "open",
      done: "open",
    };
    for (const from of STATUS) {
      expect(nextStatusFor(from)).toBe(expected[from]);
      const { s, daemon } = withDaemon([task(1, { status: from })]);
      s.select(1); // explicit: a done task is never the fallback
      await s.execute("next");
      expect(daemon.writes()).toEqual([
        {
          name: "setStatus",
          args: [1, { status: expected[from] }, { expected: { status: "status-1" } }],
        },
      ]);
    }
  });

  test("a 412 is a conflict with context, and nothing changes locally", async () => {
    const { s, daemon } = withDaemon();
    const before = snapshotOf(s);
    daemon.fail(conflict("task", 1, "status"));
    await s.execute("status review");
    expect(s.status?.level).toBe("error");
    expect(s.status?.text).toMatch(/Conflict: @1's status changed.*:status review.*Nothing was changed/);
    expect(snapshotOf(s)).toEqual(before);
  });

  test("a stale view is a conflict before any write: :next never computes from a status the daemon no longer has", async () => {
    const { s, daemon } = withDaemon();
    (daemon.server.get(1) as Task).status = "blocked";
    const before = snapshotOf(s);
    await s.execute("next");
    expect(daemon.writes()).toEqual([]);
    expect(s.status?.text).toMatch(/Conflict: @1's status changed \(now Blocked\)/);
    expect(snapshotOf(s)).toEqual(before);
  });

  test("an uncertain transport failure says the write may have applied and is never retried", async () => {
    const { s, daemon } = withDaemon();
    daemon.fail(new TransportError("timeout", "PATCH", "/api/tasks/1/status", "timed out"));
    await s.execute("status done");
    expect(daemon.writes().length).toBe(1);
    expect(s.status?.text).toMatch(/may or may not have applied/);
  });
});

describe("the status picker (bare :status; ;m): every status in one list", () => {
  const keysOf = (d: Dialog) => d.visibleRows().map(r => r.key);
  const guarded = (id: number, status: TaskStatus) => ({
    name: "setStatus",
    args: [id, { status }, { expected: { status: `status-${id}` } }],
  });

  test("every status as a radio row (the current one marked, with its letter); the next step is highlighted; Enter sets it and closes", async () => {
    const { s, daemon, type } = withDaemon();
    await s.execute("status");
    const picker = topDialog(s);
    expect(picker.label).toBe("status");
    expect(keysOf(picker)).toEqual([...STATUS]);
    const text = plainText(picker.render(96));
    expect(text).toContain("STATUS OF @1");
    expect(text).toContain("@1 Fix the login flow · Open");
    expect(text).toMatch(/\( \) ○ draft +d/);
    expect(text).toMatch(/\(\u2022\) ● open +o · current/);
    expect(text).toMatch(/◐ review +r · next step/);
    expect(text).toMatch(/✓ done +x/);
    expect(picker.highlighted()?.key).toBe("review"); // Enter takes the next step, as :next does
    expect(picker.hints()).toMatch(/Enter sets it.*d o r b x set one/);
    type("\r");
    await flush();
    expect(s.dialog).toBeNull();
    expect(daemon.writes()).toEqual([guarded(1, "review")]);
    const request = daemon.writes()[0]?.args[1] as Record<string, unknown>;
    expect(Object.keys(request)).toEqual(["status"]); // no author: a human change
    expect(s.selectedTask()?.status).toBe("review");
    expect(s.status?.text).toMatch(/@1: Open → In review/);
  });

  test("one letter sets a status at once (d o r b x, as in the filter picker); j/k and Space pick too; the current status writes nothing", async () => {
    const { s, daemon, type } = withDaemon();
    s.select(1); // explicit: a done task is never the fallback
    await s.execute("status");
    type("x");
    await flush();
    expect(s.dialog).toBeNull();
    expect(daemon.writes()).toEqual([guarded(1, "done")]);
    expect(s.status?.text).toMatch(/@1: Open → Done/);
    // The done task stays selected (an explicit selection), so the picker opens for it again.
    await s.execute("status");
    expect(topDialog(s).highlighted()?.key).toBe("open"); // done → open is the next step
    type("k", "k", " ");
    await flush();
    expect(daemon.writes().at(-1)).toEqual(guarded(1, "draft"));
    await s.execute("status");
    type("d");
    await flush();
    expect(daemon.writes().length).toBe(2);
    expect(s.status?.text).toMatch(/already Draft/);
  });

  test("Esc and q close it without a write; the filters and the selection never change", async () => {
    const { s, daemon, type } = withDaemon();
    const before = snapshotOf(s);
    await s.execute("status");
    type("\x1b");
    expect(s.dialog).toBeNull();
    await s.execute("status");
    type("q");
    expect(s.dialog).toBeNull();
    expect(daemon.writes()).toEqual([]);
    expect(snapshotOf(s)).toEqual(before);
  });

  test("it writes the task it was opened for: deleted meanwhile, nothing is written and the status line says so", async () => {
    const { s, daemon, type } = withDaemon();
    await s.execute("status");
    daemon.removeElsewhere(1);
    await flush();
    type("b");
    await flush();
    expect(daemon.writes()).toEqual([]);
    expect(s.status?.level).toBe("error");
    expect(s.status?.text).toMatch(/@1 no longer exists; :status blocked did nothing/);
  });

  test("a conflict or failure reaches the status line after the picker closed", async () => {
    const { s, daemon, type } = withDaemon();
    daemon.fail(conflict("task", 1, "status"));
    await s.execute("status");
    type("r");
    await flush();
    expect(s.dialog).toBeNull();
    expect(s.status?.level).toBe("error");
    expect(s.status?.text).toMatch(/Conflict: @1's status changed.*:status review.*Nothing was changed/);
  });

  test("without a task there is nothing to pick for", async () => {
    const { s } = withDaemon([]);
    await s.execute("status");
    expect(s.dialog).toBeNull();
    expect(s.status?.text).toMatch(/No task selected/);
  });
});

describe("queued writes keep the task they were submitted for (review F5)", () => {
  test(":status, :next, :priority, :lane and :tag +/- queued behind a write in flight still target it after navigation", async () => {
    const { s, daemon } = withDaemon();
    expect(s.selectedTask()?.id).toBe(1);
    daemon.holdNext();
    const first = s.execute("status review");
    await flush();
    expect(daemon.writes().map(w => w.name)).toEqual(["setStatus"]); // in flight
    const queued = [s.execute("next"), s.execute("priority 2"), s.execute("lane later"), s.execute("tag +ui -bug")];
    s.select(2); // navigation while the earlier write is in flight
    daemon.release();
    await Promise.all([first, ...queued]);
    expect(daemon.writes().map(w => `${w.name}:${String(w.args[0])}`)).toEqual([
      "setStatus:1",
      "setStatus:1",
      "editTask:1",
      "moveTask:1",
      "changeTags:1",
      "changeTags:1",
    ]);
    expect(daemon.server.get(1)).toMatchObject({ status: "done", priority: 2, lane: "later", tags: ["ui"] });
    expect(daemon.server.get(2)).toEqual(TASKS[1] as Task);
    expect(s.selectedTask()?.id).toBe(2);
  });

  test("a queued write whose task was deleted meanwhile does nothing and says so (never the new selection)", async () => {
    const { s, daemon } = withDaemon();
    daemon.holdNext();
    const first = s.execute("status review");
    await flush();
    const queued = s.execute("priority 2");
    s.select(2);
    daemon.removeElsewhere(1);
    daemon.release();
    await Promise.all([first, queued]);
    expect(daemon.writes().map(w => `${w.name}:${String(w.args[0])}`)).toEqual(["setStatus:1"]);
    expect(s.status?.level).toBe("error");
    expect(s.status?.text).toMatch(/@1 no longer exists; :priority 2 did nothing/);
    expect(daemon.server.get(2)).toEqual(TASKS[1] as Task);
  });
});

describe("an operation begun for a replaced database never reaches its replacement (review F10)", () => {
  const OTHER_DB = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
  const REPLACED: DaemonIdentity = { ...IDENTITY, instanceId: "instance-2", databaseId: OTHER_DB, pid: 5151 };
  /** The replacement daemon: another database with the SAME task ids; every request but its own snapshots is recorded. */
  function replacementClient() {
    const requests: string[] = [];
    const snapshot: WorkspaceSnapshot = {
      identity: REPLACED,
      cursor: "g:1",
      tasks: TASKS,
      lanes: LANES,
      tags: TAGS,
      notifications: [],
    };
    const record =
      (name: string) =>
      async (...args: unknown[]) => {
        requests.push(`${name}:${JSON.stringify(args[0])}`);
        return { task: TASKS[0], versions: versionsOf(1), replayed: false };
      };
    const client = new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => {
        if (typeof key !== "string" || key === "then") return undefined;
        if (key === "health") return async () => ({ ok: true, version: "test", identity: REPLACED });
        if (key === "workspace") return async () => snapshot;
        if (key === "versioned") {
          return new Proxy({}, { get: (_v, name) => record(`versioned.${String(name)}`) });
        }
        return record(key);
      },
    }) as unknown as CortexClient;
    return { client, requests };
  }
  /** The daemon restarts on a replaced database (another identity); its first snapshot applies at once. */
  const replace = async (s: TuiSession) => {
    s.receive({
      kind: "ready",
      cursor: "g:0",
      payload: { cursor: "g:0", epoch: "g", instanceId: "instance-2", databaseId: OTHER_DB },
    });
    await flush();
    expect(s.identity.databaseId).toBe(OTHER_DB);
    expect(s.loaded).toBe(true); // writes are allowed in the replacement again
  };

  test(":tag +a -b with the database replaced between the add and the remove sends NOTHING to the new one and reports the add", async () => {
    const next = replacementClient();
    const { s, daemon } = withDaemon(TASKS, { connect: () => next.client });
    daemon.holdNext(); // the add is in flight when the database is replaced
    const running = s.execute("tag +docs -bug");
    await flush();
    expect(daemon.writes().map(w => w.args[1])).toEqual([{ add: ["docs"] }]);
    await replace(s);
    daemon.attach(null); // the old database's stream is gone
    daemon.release();
    await running;
    expect(next.requests).toEqual([]);
    expect(daemon.writes().map(w => w.args[1])).toEqual([{ add: ["docs"] }]);
    expect(s.status?.level).toBe("error");
    expect(s.status?.text).toMatch(/^Tagged @1 #docs, but the database was replaced while this ran: .*not sent/);
  });

  test(":delete whose state read answers after a replacement deletes nothing there: the command keeps the database it was submitted against", async () => {
    const next = replacementClient();
    const { s, daemon, type } = withDaemon(TASKS, { connect: () => next.client });
    const reads = daemon.client as unknown as { taskState: CortexClient["taskState"] };
    const original = reads.taskState;
    let answer = (): void => {};
    reads.taskState = id =>
      new Promise(resolve => {
        answer = () => resolve(original(id));
      });
    const running = s.execute("delete"); // reads @1 of the OLD database for its confirmation
    await flush();
    await replace(s);
    answer();
    await running;
    if (s.dialog !== null) type("y"); // whatever it shows, y must not delete the new database's @1
    await flush();
    expect(next.requests).toEqual([]);
    expect(daemon.writes()).toEqual([]);
    expect(s.messages.some(m => /database was replaced before this could run: nothing was changed/.test(m.text))).toBe(
      true,
    );
  });
});

describe(":title, :priority and :lane", () => {
  test(":title <text> goes through the task's draft: ONE write guarded by the title token (no autosave receipt)", async () => {
    const { s, daemon } = withDaemon();
    await s.execute("title A better title");
    expect(daemon.writes()).toEqual([
      { name: "editTask", args: [1, { title: "A better title" }, { expected: { title: "title-1" } }] },
    ]);
    expect(s.selectedTask()?.title).toBe("A better title");
    expect(s.status?.text).toMatch(/Renamed @1/);
    expect(s.unsavedDrafts()).toEqual([]);
  });

  test(":title without text edits the title IN PLACE (INSERT, no dialog); Enter saves and returns to NORMAL", async () => {
    const { s, daemon, type } = withDaemon();
    await s.execute("title");
    await flush();
    expect(s.dialog).toBeNull();
    expect(s.keys.mode()).toBe("INSERT");
    expect(s.titleEdit?.taskId).toBe(1);
    expect(s.titleEdit?.line.text).toBe("Fix the login flow");
    // In INSERT, q and : are text.
    type(..." now: q");
    expect(s.titleEdit?.line.text).toBe("Fix the login flow now: q");
    type("\r");
    await flush();
    expect(s.keys.mode()).toBe("NORMAL");
    expect(s.titleEdit).toBeNull();
    expect(daemon.writes()).toEqual([
      { name: "editTask", args: [1, { title: "Fix the login flow now: q" }, { expected: { title: "title-1" } }] },
    ]);
    // Title editing never touches the Read/Edit/Split preference.
    expect(s.preferredMode).toBe("read");
    expect(s.documentMode()).toBe("read");
  });

  test("Esc also saves the in-place title; pasted newlines become spaces", async () => {
    const { s, daemon, type } = withDaemon();
    await s.execute("title");
    await flush();
    type("\x15", "\x1b[200~first\nsecond\r\nthird\x1b[201~");
    expect(s.titleEdit?.line.text).toBe("first second third");
    type("\x1b");
    await flush();
    expect(s.keys.mode()).toBe("NORMAL");
    expect(daemon.writes()[0]?.args[1]).toEqual({ title: "first second third" });
  });

  test(":priority takes any nonnegative safe integer or none, guarded by the priority token", async () => {
    const { s, daemon } = withDaemon();
    await s.execute("priority 7");
    await s.execute(`priority ${Number.MAX_SAFE_INTEGER}`);
    await s.execute("priority none");
    expect(daemon.writes().map(c => c.args)).toEqual([
      [1, { priority: 7 }, { expected: { priority: "priority-1" } }],
      [1, { priority: Number.MAX_SAFE_INTEGER }, { expected: { priority: "priority-1" } }],
      [1, { priority: null }, { expected: { priority: "priority-1" } }],
    ]);
    for (const bad of ["-1", "1.5", "9007199254740992", "high", ""]) {
      await s.execute(`priority ${bad}`);
      expect(s.status?.level).toBe("error");
    }
    expect(daemon.writes().length).toBe(3);
  });

  test(":lane moves the current task to an existing lane, guarded by the lane token; unknown lanes explain", async () => {
    const { s, daemon } = withDaemon();
    await s.execute("lane big ideas");
    expect(daemon.writes()).toEqual([{ name: "moveTask", args: [1, "big ideas", { expected: { lane: "lane-1" } }] }]);
    await s.execute("lane nowhere");
    expect(s.status?.text).toMatch(/No lane "nowhere".*:lanes/);
    await s.execute("lane big ideas");
    expect(s.status?.text).toMatch(/already in big ideas/);
    expect(daemon.writes().length).toBe(1);
    expect(completeCommandLine("lane b", COMMANDS, s)).toEqual(["lane big ideas"]);
  });
});

describe(":tag membership deltas (P4)", () => {
  test("+a -b are atomic add/remove deltas, never a whole-list replace, and never delete a tag definition", async () => {
    const { s, daemon } = withDaemon();
    await s.execute("tag +docs +#ui -bug");
    expect(daemon.writes()).toEqual([
      { name: "changeTags", args: [1, { add: ["docs", "ui"] }, undefined] },
      { name: "changeTags", args: [1, { remove: ["bug"] }, undefined] },
    ]);
    expect(daemon.calls.some(c => c.name === "removeTag")).toBe(false);
    expect(s.selectedTask()?.tags).toEqual(["docs", "ui"]);
    expect(s.tags.map(t => t.name)).toEqual(["bug", "ui", "docs"]);
  });

  test("bad names, a tag both added and removed, and no-op deltas explain themselves without writing", async () => {
    const { s, daemon } = withDaemon();
    await s.execute("tag +Bad!");
    expect(s.status?.text).toMatch(/Invalid tag name "Bad!"/);
    await s.execute("tag +x -x");
    expect(s.status?.text).toMatch(/both added and removed/);
    await s.execute("tag +bug -docs");
    expect(s.status?.text).toMatch(/already tagged #bug.*not tagged #docs/);
    expect(daemon.writes()).toEqual([]);
    expect(completeCommandLine("tag +d", COMMANDS, s)).toEqual(["tag +docs"]);
  });

  test("a failed remove after a successful add reports both halves", async () => {
    const { s, daemon } = withDaemon();
    await s.execute("tag +ui");
    daemon.fail(new HttpError(404, "task 1 not found"), 1);
    await s.execute("tag +docs -bug");
    expect(s.status?.text).toMatch(/Tagged @1 #docs.*could not untag #bug.*task 1 not found/);
  });

  test("bare :tag (and the ;t leader key) opens this task's tag picker: Enter toggles, / filters, a new name can be created", async () => {
    const { s, daemon, type } = withDaemon();
    await s.execute("tag");
    const picker = topDialog(s);
    expect(plainText(picker.render(70))).toMatch(/\[x\] #bug/);
    expect(picker.highlighted()?.key).toBe("bug");
    type("\r");
    await flush();
    expect(daemon.writes()[0]).toEqual({ name: "changeTags", args: [1, { remove: ["bug"] }, undefined] });
    expect(plainText(picker.render(70))).toMatch(/\[ \] #bug/);
    type("/", ..."launch", "\r");
    expect(plainText(picker.render(70))).toMatch(/\+ Create #launch/);
    type("\r");
    await flush();
    expect(daemon.writes()[1]).toEqual({ name: "changeTags", args: [1, { add: ["launch"] }, undefined] });
    type("q");
    expect(s.dialog).toBeNull();
  });
});

describe(":delete (y/n confirmation)", () => {
  test("n keeps the task; y deletes it guarded by the entity token read for the confirmation", async () => {
    const { s, daemon, type } = withDaemon();
    await s.execute("delete");
    expect(plainText(topDialog(s).render(70))).toMatch(/Delete @1/);
    expect(plainText(topDialog(s).render(70))).toContain("Fix the login flow");
    type("n");
    await flush();
    expect(s.dialog).toBeNull();
    expect(daemon.writes()).toEqual([]);
    await s.execute("delete");
    type("y");
    await flush();
    expect(daemon.writes()).toEqual([{ name: "removeTask", args: [1, { expected: { entity: "entity-1" } }] }]);
    expect(s.tasks.some(t => t.id === 1)).toBe(false);
    expect(s.status?.text).toMatch(/Deleted @1/);
  });

  test("a task that changed after the confirmation is not deleted (412 with context)", async () => {
    const { s, daemon, type } = withDaemon();
    await s.execute("delete");
    daemon.fail(conflict("task", 1, "entity"));
    const before = snapshotOf(s);
    type("y");
    await flush();
    expect(s.status?.text).toMatch(/Conflict: @1 changed.*nothing was deleted/i);
    expect(snapshotOf(s)).toEqual(before);
  });
});

describe(":lanes (lane name/color/sort CRUD, P4)", () => {
  test("lists every lane with its task count; a creates, Enter edits (guarded), d deletes only empty non-now lanes", async () => {
    const { s, daemon, type } = withDaemon();
    await s.execute("lanes");
    const lanes = topDialog(s);
    const text = plainText(lanes.render(80));
    expect(text).toMatch(/now\s.*3 tasks/);
    expect(text).toMatch(/big ideas\s.*1 task\b/);
    expect(text).toContain("protected");
    // d on `now`: protected.
    type("d");
    await flush();
    expect(s.status?.text).toMatch(/now lane cannot be deleted/);
    // d on a lane with tasks: refused with the count.
    type("j", "d");
    await flush();
    expect(s.status?.text).toMatch(/later has 1 task/);
    // a: the create form (INSERT), sorted after the last lane by default.
    type("a");
    const form = topDialog(s);
    expect(form.values()).toEqual({ name: "", color: "", sort: "3" });
    type(..."someday", "\t", ..."#2563eb", "\r");
    await flush();
    expect(daemon.writes()[0]).toEqual({
      name: "addLane",
      args: [{ name: "someday", color: "#2563eb", sort: 3 }, undefined],
    });
    expect(s.dialog).toBe(lanes);
    // Enter edits: prefilled from the lane's state read; the guard carries its definition token.
    type("g", "j", "\r");
    await flush();
    const edit = topDialog(s);
    expect(edit.values()).toEqual({ name: "later", color: "", sort: "1" });
    type("\x1b", "j", "j", "i", "\x15", ..."5", "\r");
    await flush();
    expect(daemon.writes()[1]).toEqual({
      name: "editLane",
      args: ["later", { sort: 5 }, { expected: { definition: "definition-later" } }],
    });
    expect(s.dialog).toBe(lanes);
  });

  test("renaming a lane also guards its entity and the lane filter follows the rename (web parity)", async () => {
    const { s, daemon, type } = withDaemon();
    s.setFilter({ status: null, lane: "later", tags: [] });
    await s.execute("lanes");
    type("j", "\r");
    await flush();
    type("\x15", ..."soon", "\r");
    await flush();
    expect(daemon.writes()[0]).toEqual({
      name: "editLane",
      args: ["later", { rename: "soon" }, { expected: { definition: "definition-later", entity: "entity-later" } }],
    });
    expect(s.filter.lane).toBe("soon");
  });

  test("the now lane cannot be renamed; an empty lane is deleted after y, guarded by its entity token", async () => {
    const { s, daemon, type } = withDaemon([task(1)]);
    await s.execute("lanes");
    type("\r");
    await flush();
    expect(plainText(topDialog(s).render(80))).toContain("the now lane cannot be renamed");
    type("\x1b", "\x1b");
    type("j", "d");
    await flush();
    expect(plainText(topDialog(s).render(80))).toMatch(/Delete lane later/);
    type("y");
    await flush();
    expect(daemon.writes()).toEqual([
      { name: "removeLane", args: ["later", { expected: { entity: "entity-later" } }] },
    ]);
  });

  test("a new lane needs a name; a create form with input refuses :q", async () => {
    const { s, daemon, type } = withDaemon();
    await s.execute("lanes");
    type("a", "\r");
    await flush();
    expect(s.status?.text).toMatch(/needs a name/);
    type(..."x", "\x1b", "q");
    expect(s.status?.text).toMatch(/unsaved input/);
    type(":", "q", "!", "\r");
    await flush();
    expect(daemon.writes()).toEqual([]);
    expect(s.dialog?.label).toBe("lanes");
  });
});

describe(":tags (tag definitions, P4)", () => {
  test("lists definitions with their task counts; d deletes after showing the impact count, guarded by the entity token", async () => {
    const { s, daemon, type } = withDaemon();
    await s.execute("tags");
    const list = topDialog(s);
    expect(plainText(list.render(80))).toMatch(/#bug\s.*2 tasks/);
    type("d");
    await flush();
    expect(plainText(topDialog(s).render(80))).toMatch(/removed from 2 tasks/);
    type("y");
    await flush();
    expect(daemon.writes()).toEqual([
      { name: "removeTag", args: ["bug", { force: true }, { expected: { entity: "entity-bug" } }] },
    ]);
  });

  test("a stale impact count (412) deletes nothing and says so", async () => {
    const { s, daemon, type } = withDaemon();
    await s.execute("tags");
    type("d");
    await flush();
    daemon.fail(conflict("tag", "bug", "entity"));
    type("y");
    await flush();
    expect(s.status?.text).toMatch(/Conflict: #bug changed.*nothing was deleted/);
    expect(daemon.tags.has("bug")).toBe(true);
  });

  test("Enter renames or recolors (definition, plus entity for a rename); the tag filter follows a rename", async () => {
    const { s, daemon, type } = withDaemon();
    s.setFilter({ status: null, lane: null, tags: ["bug", UNTAGGED] });
    await s.execute("tags");
    type("\r");
    await flush();
    expect(topDialog(s).values()).toEqual({ name: "bug", color: "" });
    type("\x15", ..."defect", "\t", ..."#dc2626", "\r");
    await flush();
    expect(daemon.writes()[0]).toEqual({
      name: "editTag",
      args: [
        "bug",
        { rename: "defect", color: "#dc2626" },
        { expected: { definition: "definition-bug", entity: "entity-bug" } },
      ],
    });
    expect(s.filter.tags).toEqual(["defect", UNTAGGED]);
    type("a", ..."Not Valid", "\r");
    await flush();
    expect(s.status?.text).toMatch(/Tag names are 1-32/);
  });
});

describe(":theme (P9)", () => {
  function fakeThemes() {
    const calls: string[] = [];
    let current: ResolvedTheme = resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" } });
    const control: ThemeControl = {
      choices: () => [
        { name: "cortex-dark", source: "bundled" },
        { name: "cortex-light", source: "bundled" },
        { name: "mine", source: "custom" },
      ],
      preview: name => void calls.push(`preview:${name}`),
      restore: () => void calls.push("restore"),
      apply: name => {
        calls.push(`apply:${name}`);
        current = resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" }, session: name });
        return current;
      },
    };
    return { control, calls };
  }

  test(":theme <name> applies and saves; :theme auto clears; unknown names explain; names complete", async () => {
    const { s } = withDaemon();
    const themes = fakeThemes();
    s.setThemeControl(themes.control);
    await s.execute("theme cortex-light");
    await s.execute("theme auto");
    await s.execute("theme nope");
    expect(themes.calls).toEqual(["apply:cortex-light", "apply:null"]);
    expect(s.status?.text).toMatch(/No theme "nope".*cortex-dark/);
    expect(completeCommandLine("theme c", COMMANDS, s)).toEqual(["theme cortex-dark", "theme cortex-light"]);
    expect(completeCommandLine("theme ", COMMANDS, s)[0]).toBe("theme auto");
  });

  test("bare :theme opens a picker: moving previews, Esc restores, Enter applies (and saves)", async () => {
    const { s, type } = withDaemon();
    const themes = fakeThemes();
    s.setThemeControl(themes.control);
    await s.execute("theme");
    type("j", "j", "\x1b");
    expect(themes.calls).toEqual(["preview:cortex-dark", "preview:cortex-light", "restore"]);
    await s.execute("theme");
    type("j", "j", "\r");
    expect(themes.calls.slice(3)).toEqual(["preview:cortex-dark", "preview:cortex-light", "apply:cortex-light"]);
    expect(s.dialog).toBeNull();
    expect(s.status?.text).toMatch(/cortex-light/);
  });

  test("the status line names where the active theme comes from", () => {
    const env = { NO_COLOR: "1" };
    expect(themeSourceText(resolveTheme({ config: DEFAULT_CONFIG, env, session: "cortex-light" }))).toMatch(
      /cortex-light.*:theme.*saved/,
    );
    expect(themeSourceText(resolveTheme({ config: DEFAULT_CONFIG, env, cli: "cortex-light" }))).toMatch(/--theme/);
    expect(themeSourceText(resolveTheme({ config: { ...DEFAULT_CONFIG, theme: "cortex-light" }, env }))).toMatch(
      /tui\.toml.*pins.*:theme auto removes/,
    );
    expect(themeSourceText(resolveTheme({ config: DEFAULT_CONFIG, env, detected: "light" }))).toMatch(
      /auto.*light terminal/,
    );
  });
});

describe(":density (the spacing; saved to tui.toml like :theme)", () => {
  const tomlPath = () => path.join(dir, "tui.toml");
  const saved = () => loadConfig(tomlPath()).config.density;

  test(":density <value> sets and saves it; bare toggles; either way it redraws at once and says so", async () => {
    let changes = 0;
    const { s } = withDaemon(TASKS, { onChange: () => changes++ });
    expect(s.density).toBe("comfortable");
    await s.execute("density compact");
    expect(s.density).toBe("compact");
    expect(saved()).toBe("compact");
    expect(s.status).toMatchObject({ level: "info", text: "Density: compact (saved)" });
    expect(changes).toBeGreaterThan(0);
    const before = changes;
    await s.execute("density");
    expect(s.density).toBe("comfortable");
    expect(saved()).toBe("comfortable");
    expect(s.status?.text).toBe("Density: comfortable (saved)");
    expect(changes).toBeGreaterThan(before);
    await s.execute("density");
    expect(s.density).toBe("compact");
    // Setting the value in use again is still an explicit, saved choice.
    await s.execute("density compact");
    expect(s.status?.text).toBe("Density: compact (saved)");
  });

  test("an invalid value explains with the usage and changes nothing; the two values complete", async () => {
    const { s } = withDaemon();
    for (const line of ["density tiny", "density compact please", "density Compact"]) {
      await s.execute(line);
      expect(s.status?.level, line).toBe("error");
      expect(s.status?.text, line).toContain("Usage: :density [compact|comfortable]");
    }
    expect(s.density).toBe("comfortable");
    expect(fs.existsSync(tomlPath())).toBe(false);
    expect(completeCommandLine("density ", COMMANDS, s)).toEqual(["density comfortable", "density compact"]);
    expect(completeCommandLine("density comp", COMMANDS, s)).toEqual(["density compact"]);
    expect(completeCommandLine("dens", COMMANDS, s)).toEqual(["density"]);
    expect(describeCandidate("density compact", COMMANDS, s)).toMatch(/.+/);
    expect(describeCandidate("density comfortable", COMMANDS, s)).toMatch(/default/);
  });

  test("a saved choice survives the session; an unsavable tui.toml keeps it for this session and says so", async () => {
    const { s } = withDaemon();
    await s.execute("density compact");
    expect(saved()).toBe("compact");
    fs.writeFileSync(tomlPath(), "not = [toml");
    await s.execute("density comfortable");
    expect(s.density).toBe("comfortable");
    expect(s.status?.level).toBe("warn");
    expect(s.status?.text).toMatch(/^Density: comfortable \(this session only/);
  });
});

describe("view choices never write tasks", () => {
  test("filters, searches, include-done, the task list, focus and navigation send no write", async () => {
    const { s, daemon } = withDaemon();
    for (const line of [
      "density compact",
      "density",
      "filter status review",
      "filter lane now",
      "filter tags bug",
      "clear",
      "set done!",
      "set tasks!",
      "set tasks!",
      "focus document",
      "open 3",
      "back",
      "forward",
    ]) {
      await s.execute(line);
    }
    s.setQuery("login");
    expect(daemon.writes()).toEqual([]);
  });
});

describe("document modes (P5, Task 9)", () => {
  const statePath = () => path.join(dir, "tui", "default.state.json");

  test(":read, :edit and :split change the SAVED preferred mode (their aliases too); nothing else does", async () => {
    const { s, daemon } = withDaemon();
    expect(s.preferredMode).toBe("read");
    await s.execute("edit");
    expect(s.preferredMode).toBe("edit");
    expect(s.documentMode()).toBe("edit");
    s.savePreferences();
    expect(readPreferences(statePath()).preferences.view.mode).toBe("edit");
    await s.execute("sp");
    expect(s.documentMode()).toBe("split");
    await s.execute("r");
    expect(s.documentMode()).toBe("read");
    await s.execute("e");
    s.savePreferences();
    expect(readPreferences(statePath()).preferences.view.mode).toBe("edit");
    await s.execute("read now");
    expect(s.status?.text).toMatch(/takes no argument/);
    // Choosing a view never writes a task.
    expect(daemon.writes()).toEqual([]);
  });

  test("i in the body from Read shows Edit for THAT task only, until task navigation or an explicit mode command", async () => {
    const { s, type } = withDaemon();
    s.setFocus("document");
    s.startInsert();
    await flush();
    expect(s.keys.mode()).toBe("INSERT");
    expect(s.documentMode()).toBe("edit");
    expect(s.preferredMode).toBe("read");
    type(...":q");
    expect(s.documentOf(1)?.draft?.text("body")).toBe(":q");
    type("\x1b");
    expect(s.keys.mode()).toBe("NORMAL");
    // Leaving INSERT never saves separately: the draft is still pending until autosave or :w.
    expect(s.documentOf(1)?.draft?.state("body")).toBe("pending");
    expect(s.documentMode()).toBe("edit");
    s.jump(2);
    expect(s.documentMode()).toBe("read");
    s.jump(1);
    expect(s.documentMode()).toBe("read");
    s.startInsert();
    type("\x1b");
    expect(s.documentMode()).toBe("edit");
    await s.execute("read");
    expect(s.documentMode()).toBe("read");
    s.savePreferences();
    expect(fs.existsSync(statePath()) ? readPreferences(statePath()).preferences.view.mode : "read").toBe("read");
  });

  test("the editor and its undo history survive mode changes and task switches (stable identity)", async () => {
    const { s, type } = withDaemon();
    await s.execute("edit");
    s.setFocus("document");
    s.startInsert();
    await flush();
    const editor = s.documentOf(1)?.editor;
    expect(editor).toBeDefined();
    type(..."abc", "\x1b");
    await s.execute("read");
    await s.execute("split");
    s.jump(2);
    s.jump(1);
    await s.execute("edit");
    expect(s.documentOf(1)?.editor).toBe(editor);
    expect(editor?.undo()).toBe(true);
    expect(s.documentOf(1)?.draft?.text("body")).toBe("");
  });
});

// ---------- maintenance (P10, Task 11) ----------

describe(":backup and pending migrations (P10)", () => {
  const RESULT = {
    outPath: "/tmp/backups/cortex-backup.json",
    bytes: 2048,
    stats: { lanes: 3, tags: 3, tasks: 5, updates: 9, task_tags: 4, notifications: 0 },
    notification: { id: 1 },
  };

  test(":backup asks the daemon for ONE backup and reports its path and counts; failures are reported, never retried", async () => {
    const calls: unknown[] = [];
    let fail: Error | null = null;
    const client = {
      backup: async (request: unknown) => {
        calls.push(request);
        if (fail !== null) throw fail;
        return RESULT;
      },
    };
    const session = makeSession({ client: client as unknown as CortexClient });
    await session.execute("backup");
    expect(calls).toEqual([{}]);
    expect(session.status?.level).toBe("info");
    expect(session.status?.text).toContain("Backup written to /tmp/backups/cortex-backup.json");
    expect(session.status?.text).toContain("5 tasks, 9 updates");
    fail = new TransportError("timeout", "POST", "/api/backup", "request timed out");
    await session.execute("backup");
    expect(calls.length).toBe(2);
    expect(session.status?.level).toBe("error");
    expect(session.status?.text).toContain("may have been written");
    fail = new HttpError(500, "disk full");
    await session.execute("backup");
    expect(calls.length).toBe(3);
    expect(session.status?.text).toContain("Backup failed: disk full");
    await session.execute("backup now");
    expect(calls.length).toBe(3);
    expect(session.status?.text).toContain(":backup takes no argument");
  });

  test("a second :backup while one is being written is refused", async () => {
    let release = (): void => {};
    const client = {
      backup: () =>
        new Promise(resolve => {
          release = () => resolve(RESULT);
        }),
    };
    const session = makeSession({ client: client as unknown as CortexClient });
    const first = session.execute("backup");
    await session.execute("backup");
    expect(session.status?.text).toContain("already being written");
    release();
    await first;
    expect(session.status?.text).toContain("Backup written to");
  });

  test("pending database migrations become a persistent warning in :messages; none pending says nothing", async () => {
    let pending: string[] = ["updates-summary-4096"];
    let fail = false;
    const client = {
      migrations: async () => {
        if (fail) throw new Error("socket closed");
        return { pending };
      },
    };
    const session = makeSession({ client: client as unknown as CortexClient });
    const before = session.messages.length;
    await reportPendingMigrations(session);
    expect(session.warnings).toBe(1);
    const text = session.messages.at(-1)?.text ?? "";
    expect(text).toContain("Database migrations pending (updates-summary-4096)");
    expect(text).toContain("cortex init");
    pending = [];
    const quiet = makeSession({ client: client as unknown as CortexClient });
    await reportPendingMigrations(quiet);
    expect(quiet.warnings).toBe(0);
    expect(quiet.messages.length).toBe(0);
    fail = true;
    await reportPendingMigrations(quiet);
    expect(quiet.messages.at(-1)?.level).toBe("warn");
    expect(quiet.messages.at(-1)?.text).toContain("Could not check for pending database migrations: socket closed");
    expect(before).toBe(0);
  });
});
