import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURSOR_MARKER, getKeybindings, type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import type { CortexClient, DaemonIdentity, WorkspaceSnapshot } from "../../../src/contracts.ts";
import type { Lane, Task, Update } from "../../../src/store.ts";
import {
  APPEARANCE_BUDGET_MS,
  detectAppearance,
  MIN_COLUMNS,
  MIN_ROWS,
  Shell,
  TERMINAL_RESET,
  type ShellOptions,
} from "../../../src/tui/app.ts";
import { withExternalProgram } from "../../../src/tui/bridge.ts";
import { DEFAULT_CONFIG, loadConfig, SETTING_HELP, type TuiConfig } from "../../../src/tui/config.ts";
import { Dialog } from "../../../src/tui/dialogs.ts";
import { parseKeys } from "../../../src/tui/keys.ts";
import { MOUSE_OFF, MOUSE_ON, WHEEL_NOTCH_MS } from "../../../src/tui/mouse.ts";
import { openPreferences, readPreferences } from "../../../src/tui/preferences.ts";
import { TuiSession } from "../../../src/tui/session.ts";
import { BUNDLED_THEME_NAMES, THEME_TOKENS } from "../../../src/tui/theme.ts";

// Plan @400 Tasks 7-8 (N13, N17-N20, N22-N23, P1/P2/P9): the terminal shell.
// A status line (mode, focus, save/connection state, messages), a hint line
// from the configured keys, the task list (one flat list in the shared order,
// status markers), and the document pane (Task 10: Read and the Split
// preview are the reader, src/tui/reader.ts). The `:` line completes from the
// one command registry. The theme resolves before the first content frame;
// every exit path restores the terminal.

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
  created: 1,
  updated: 1,
  tags: [],
  ...over,
});
const LANES: Lane[] = [
  { name: "now", color: null, sort: 0 },
  { name: "later", color: null, sort: 1 },
];
const TASKS: Task[] = [
  task(1, { title: "Fix the login flow", body: "# Plan\n\nStep one\nStep two" }),
  task(2, { title: "Hold: blocked on review", status: "blocked" }),
  task(3, { lane: "later", title: "Draft the docs", status: "draft", tags: ["docs"] }),
  task(4, { lane: "later", title: "Wait for review", status: "review", priority: 2 }),
];

/** A pi-tui Terminal that records output and lets the test type. */
class FakeTerminal implements Terminal {
  columns = 120;
  rows = 40;
  kittyProtocolActive = false;
  writes: string[] = [];
  starts = 0;
  stops = 0;
  #input: ((data: string) => void) | undefined;
  start(onInput: (data: string) => void): void {
    this.#input = onInput;
    this.starts++;
  }
  stop(): void {
    this.stops++;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  /** Bytes from the "terminal" (replies) through the toolkit's input path. */
  reply(data: string): void {
    this.#input?.(data);
  }
  output(): string {
    return this.writes.join("");
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let dir: string;
const shells: Shell[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-app-"));
});

afterEach(() => {
  for (const shell of shells.splice(0)) shell.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Harness = {
  shell: Shell;
  session: TuiSession;
  terminal: FakeTerminal;
  quits: boolean[];
  signals: string[];
  writes: { id: number; request: Record<string, unknown> }[];
  posts: { id: number; request: Record<string, unknown> }[];
};

/** The harness session's tui.toml (it writes the settings there). */
const tomlPath = () => path.join(dir, "tui.toml");

function harness(
  options: {
    initialTask?: number;
    heading?: string;
    tasks?: Task[];
    config?: TuiConfig;
    env?: ShellOptions["env"];
    cliTheme?: string | null;
    columns?: number;
    rows?: number;
    budgetMs?: number;
    /** Each task's updates (GET /api/tasks/:id/updates). */
    updates?: Record<number, Update[]>;
    /** Wraps each TaskState read (a slow or failing baseline); `read` gives the answer. */
    taskState?: (id: number, read: () => unknown) => Promise<unknown>;
    /** The session's clock (default Date.now); the wheel's notches follow it. */
    now?: () => number;
  } = {},
): Harness {
  const terminal = new FakeTerminal();
  terminal.columns = options.columns ?? 120;
  terminal.rows = options.rows ?? 40;
  const quits: boolean[] = [];
  const signals: string[] = [];
  const snapshot: WorkspaceSnapshot = {
    identity: IDENTITY,
    cursor: "e:1",
    tasks: options.tasks ?? TASKS,
    lanes: LANES,
    tags: [],
    notifications: [],
  };
  const writes: Harness["writes"] = [];
  const posts: Harness["posts"] = [];
  const versions = { entity: "e", title: "t", body: "b", priority: "p", lane: "l", status: "s" };
  const stateOf = (id: number) => {
    const found = snapshot.tasks.find(t => t.id === id);
    if (found === undefined) throw new Error(`no task ${id}`);
    return { task: found, updates: [], versions, cursor: "e:1" };
  };
  const client = {
    workspace: async () => snapshot,
    taskState: async (id: number) => (options.taskState ? options.taskState(id, () => stateOf(id)) : stateOf(id)),
    updates: async (id: number) => options.updates?.[id] ?? [],
    related: async () => ({ referencedBy: [], references: [], shared: [] }),
    me: async () => ({ author: "tester" }),
    versioned: {
      editTask: async (id: number, request: Record<string, unknown>) => {
        writes.push({ id, request });
        return { ...stateOf(id), replayed: false };
      },
      setStatus: async (id: number, request: Record<string, unknown>) => {
        writes.push({ id, request });
        return { ...stateOf(id), replayed: false };
      },
      postUpdate: async (id: number, request: { author: string; summary: string }) => {
        posts.push({ id, request });
        const update: Update = {
          id: 900 + posts.length,
          task_id: id,
          author: request.author,
          summary: request.summary,
          body: null,
          severity: "progress",
          created: Date.now(),
        };
        return { update, audit: null, task: stateOf(id).task, versions, replayed: false };
      },
    },
  } as unknown as CortexClient;
  const config = options.config ?? DEFAULT_CONFIG;
  const session = new TuiSession({
    client,
    identity: IDENTITY,
    keys: config.keys,
    preferences: openPreferences(path.join(dir, "tui", "default.state.json")),
    settings: config,
    configFile: tomlPath(),
    initialTask: options.initialTask ?? null,
    heading: options.heading ?? null,
    now: options.now,
    onQuit: force => quits.push(force),
  });
  session.applySnapshot(snapshot);
  const shell = new Shell({
    terminal,
    session,
    config,
    cliTheme: options.cliTheme ?? null,
    env: options.env ?? { NO_COLOR: "1", TERM: "xterm-256color" },
    themesDir: path.join(dir, "themes"),
    appearanceBudgetMs: options.budgetMs ?? 20,
    kill: (_pid, signal) => {
      signals.push(`${signal}:stops=${terminal.stops}:restored=${terminal.output().includes(TERMINAL_RESET)}`);
    },
    setRawMode: () => {},
  });
  shells.push(shell);
  return { shell, session, terminal, quits, signals, writes, posts };
}

async function started(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = harness(options);
  await h.shell.start();
  return h;
}

/** The current frame as plain text (SGR removed) for content assertions. */
const plain = (lines: string[]): string[] =>
  lines.map(l =>
    l
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split(CURSOR_MARKER)
      .join(""),
  );
const screen = (h: Harness): string => plain(h.shell.frame()).join("\n");
const type = (h: Harness, ...inputs: string[]) => {
  for (const input of inputs) h.shell.handleInput(input);
};

describe("layout (N19)", () => {
  test("every frame fills the terminal exactly and never exceeds its width", async () => {
    const h = await started();
    for (const [columns, rows] of [
      [160, 50],
      [120, 40],
      [100, 30],
      [80, 24],
      [79, 24],
      [80, 23],
      [40, 10],
    ] as const) {
      h.terminal.columns = columns;
      h.terminal.rows = rows;
      for (const focus of ["tasks", "document"] as const) {
        h.session.setFocus(focus);
        const lines = h.shell.frame();
        expect(lines.length).toBe(rows);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("wide terminals show the list beside the document; one flat list in ascending id order with lanes", async () => {
    const h = await started();
    const text = screen(h);
    expect(text).toContain("TASKS");
    expect(text).toContain("4 shown");
    expect(text).toContain("sort id");
    expect(text).toContain("no filters");
    // The list pane is the left 39 columns at 120 wide (the document repeats the selected title).
    const list = plain(h.shell.frame())
      .map(l => l.slice(0, 39))
      .join("\n");
    const order = ["Fix the login flow", "Hold: blocked on review", "Draft the docs", "Wait for review"];
    const at = order.map(title => list.indexOf(title));
    expect(at.every((n, i) => n >= 0 && (i === 0 || n > (at[i - 1] ?? 0)))).toBe(true);
    expect(text).toMatch(/Draft the docs\s+later/);
    expect(text).toContain("Fix the login flow");
    expect(text).toContain("Draft the docs");
    // The document pane shows the selected task's metadata and its rendered Markdown (the Task 10 reader):
    // the heading without its `#`, the paragraph's soft line break as a space.
    expect(text).toContain("@1");
    expect(text).toContain("READ");
    expect(text).not.toContain("# Plan");
    expect(text).toMatch(/│ Plan /);
    expect(text).toContain("Step one Step two");
  });

  test("80x24 collapses to the focused pane; smaller terminals get a recoverable resize screen", async () => {
    const h = await started({ columns: MIN_COLUMNS, rows: MIN_ROWS });
    let text = screen(h);
    expect(text).toContain("Fix the login flow");
    expect(text).not.toContain("Step two");
    type(h, "\t");
    text = screen(h);
    expect(text).toContain("Step two");
    expect(text).not.toContain("TASKS");
    h.terminal.columns = MIN_COLUMNS - 1;
    text = screen(h);
    expect(text).toContain(`${MIN_COLUMNS}x${MIN_ROWS}`);
    expect(text).toContain(":q");
    h.terminal.columns = MIN_COLUMNS;
    expect(screen(h)).toContain("Step two");
  });

  test("a very long title is clamped to four lines ending in one ellipsis", async () => {
    const h = await started({ tasks: [task(1, { title: "word ".repeat(400).trim() })], columns: 80, rows: 24 });
    h.session.setFocus("document"); // 80 columns: the document pane alone
    const lines = plain(h.shell.frame());
    const title = lines.filter(l => l.includes("word word"));
    expect(title.length).toBe(4);
    expect(lines.join("\n")).not.toContain("……");
    expect(title.at(-1)?.trimEnd().endsWith("…")).toBe(true);
  });

  test("status markers are glyphs and labels, never tint alone (colors none)", async () => {
    const h = await started();
    const text = screen(h);
    expect(text).toMatch(/■ @2 {2}Hold: blocked on review/);
    expect(text).toMatch(/○ @3 {2}Draft the docs/);
    expect(text).toMatch(/◐ @4 {2}Wait for review/);
    type(h, "j");
    expect(screen(h)).toContain("Blocked");
  });

  test("the status line shows mode, focus, the save state and the connection", async () => {
    const h = await started();
    const lines = plain(h.shell.frame());
    const status = lines[lines.length - 2] ?? "";
    expect(status).toContain("NORMAL");
    expect(status).toContain("tasks");
    expect(status).toContain("✓ saved");
    expect(status).toContain("connecting");
    h.session.setConnection("live");
    expect(plain(h.shell.frame()).at(-2)).toContain("live");
    h.session.setConnection("stale");
    expect(plain(h.shell.frame()).at(-2)).toContain("reconnecting");
  });

  test("the status line counts unread notifications with a glyph and a word; blocked attention flashes, the bell is opt-in", async () => {
    const row = {
      id: 7,
      task_id: 4,
      author: "pi-agent",
      status: "review",
      title: "[4] Wait for review",
      message: "open → review",
      read: false,
      created: 5,
    };
    const transition = { task: { ...TASKS[2], status: "blocked" }, previous: "draft", author: "pi-agent" };
    const quiet = await started();
    expect(plain(quiet.shell.frame()).at(-2)).not.toContain("unread");
    quiet.session.receive({ kind: "notification.added", cursor: "e:2", payload: row });
    expect(plain(quiet.shell.frame()).at(-2)).toContain("✉ 1 unread");
    quiet.session.receive({ kind: "task.blocked", cursor: "e:3", payload: transition });
    expect(plain(quiet.shell.frame()).at(-2)).toContain("@3 is blocked");
    expect(quiet.terminal.writes).not.toContain("\x07");
    const loud = await started({ config: { ...DEFAULT_CONFIG, bell: true } });
    loud.session.receive({ kind: "task.blocked", cursor: "e:2", payload: transition });
    expect(loud.terminal.writes.filter(w => w === "\x07").length).toBe(1);
  });
});

describe("density: the spacing around the document header and the footer (comfortable by default)", () => {
  /** 120 columns: the list is Math.max(28, Math.min(56, Math.floor(120 * 0.33))) = 39 wide, then its divider. */
  const LIST = 39;
  const split = (lines: string[], y: number) => ({
    list: (lines[y] ?? "").slice(0, LIST),
    doc: (lines[y] ?? "").slice(LIST + 1),
  });

  test("R6: the side-by-side list is a third of the width, 28 to 56 columns", async () => {
    const h = await started();
    for (const [columns, width] of [
      [100, 33],
      [120, 39],
      [160, 52],
      [170, 56],
      [240, 56],
    ] as const) {
      h.terminal.columns = columns;
      const lines = plain(h.shell.frame());
      expect(lines[10]?.indexOf("\u2502"), `${columns} columns`).toBe(width);
      expect(lines[4]?.slice(0, width), `${columns} columns`).toContain("@1  Fix the login flow");
    }
  });

  test("S2: comfortable puts one blank row between the document header and its divider; compact none", async () => {
    const h = await started();
    let lines = plain(h.shell.frame());
    expect(split(lines, 0).doc).toContain("@1 \u00b7 now");
    expect(split(lines, 1).doc).toContain("Fix the login flow");
    expect(split(lines, 2).doc.trim()).toBe("");
    expect(split(lines, 3).doc).toMatch(/^\u2500\u2500 READ /);
    // The list's first task row sits beside S5's blank row under the divider; the body follows it.
    expect(split(lines, 4).list).toContain("@1  Fix the login flow");
    expect(split(lines, 4).doc.trim()).toBe("");
    expect(split(lines, 5).doc).toMatch(/^ *Plan/);
    h.session.setDensity("compact");
    lines = plain(h.shell.frame());
    expect(split(lines, 2).doc).toMatch(/^\u2500\u2500 READ /);
    expect(split(lines, 3).list).toContain("@1  Fix the login flow");
    expect(split(lines, 3).doc).toMatch(/^ *Plan/);
  });

  test("S2: the spacer comes after every notice under the title and before every divider (panels, Edit)", async () => {
    const h = await started();
    h.session.select(1);
    h.session.setQuery("review"); // @1 stays selected, outside the filters
    let lines = plain(h.shell.frame());
    expect(split(lines, 2).doc).toContain("Outside the current list filters");
    expect(split(lines, 3).doc.trim()).toBe("");
    expect(split(lines, 4).doc).toMatch(/^\u2500\u2500 READ /);
    h.session.setQuery("");
    type(h, "]");
    await settle();
    lines = plain(h.shell.frame());
    expect(split(lines, 2).doc.trim()).toBe("");
    expect(split(lines, 3).doc).toMatch(/^\u2500\u2500 ACTIVITY/);
    type(h, "[", ";", "i");
    await settle();
    lines = plain(h.shell.frame());
    expect(split(lines, 2).doc.trim()).toBe("");
    expect(split(lines, 3).doc).toMatch(/^\u2500\u2500 EDIT /);
    h.session.setDensity("compact");
    expect(split(plain(h.shell.frame()), 2).doc).toMatch(/^\u2500\u2500 EDIT /);
  });

  test("S5: comfortable leaves one blank row under every document divider (Read, Edit, Split, panels); compact none", async () => {
    const h = await started();
    /** The document part of each row at the current width (the list is a third of it, then its divider). */
    const docRows = (): string[] => {
      const list = Math.max(28, Math.min(56, Math.floor(h.terminal.columns * 0.33)));
      return plain(h.shell.frame()).map(l => l.slice(list + 1));
    };
    /** The row of the divider matching `label`, the blank row under it, and the first content row. */
    const underDivider = (label: RegExp, blank = (s: string) => s.trim() === "") => {
      const rows = docRows();
      const y = rows.findIndex(r => label.test(r));
      expect(y).toBeGreaterThan(0);
      expect(blank(rows[y + 1] ?? "x")).toBe(true);
      expect((rows[y + 2] ?? "").trim()).not.toBe("");
      return y;
    };
    expect(underDivider(/^\u2500\u2500 READ /)).toBe(3);
    expect(docRows()[5]).toMatch(/^ *Plan/);
    h.session.setFocus("document");
    h.session.setDocumentMode("edit");
    await settle();
    underDivider(/^\u2500\u2500 EDIT /);
    // The editor's rows start under the spacer: a click on "Step one" puts the cursor there (offset 8).
    const lines = plain(h.shell.frame());
    const y = lines.findIndex(l => l.includes("Step one"));
    const x = (lines[y] ?? "").indexOf("Step one");
    h.terminal.reply(`\x1b[<0;${x + 1};${y + 1}M`);
    h.terminal.reply(`\x1b[<0;${x + 1};${y + 1}m`);
    expect(h.session.documentOf(1)?.editor?.cursor()).toBe(8);
    // Wide Split (120 columns): the halves' rule runs through the spacer row.
    h.session.setDocumentMode("split");
    await settle();
    underDivider(
      /^\u2500\u2500 EDIT .*\u252c.*PREVIEW/,
      s => s.replace("\u2502", "").trim() === "" && s.includes("\u2502"),
    );
    // Narrow Split: only the focused half, the same spacer.
    h.terminal.columns = 110;
    underDivider(/^\u2500\u2500 SPLIT /);
    h.terminal.columns = 120;
    h.session.setDocumentMode("read");
    type(h, "]");
    await settle();
    underDivider(/^\u2500\u2500 ACTIVITY/);
    type(h, "[");
    h.session.setDensity("compact");
    const compact = docRows();
    expect(compact[2]).toMatch(/^\u2500\u2500 READ /);
    expect(compact[3]).toMatch(/^ *Plan/);
  });

  test("S3: comfortable puts one blank bg row right above the status line in every view; compact none", async () => {
    const h = await started({ env: { COLORTERM: "truecolor", TERM: "xterm-256color" }, cliTheme: "cortex-dark" });
    for (let i = 0; i < 60; i++) h.session.notify("info", `note ${i}`);
    const bg = `48;2;${rgbOf(h.session.theme?.colors.bg ?? "#000000")}`;
    const views = [
      ["workspace", () => h.session.closeView()],
      [
        "help",
        () => {
          h.session.openView("help");
          type(h, "G");
        },
      ],
      [
        "messages",
        () => {
          h.session.openView("messages");
          type(h, "G");
        },
      ],
      ["commands", () => h.session.openView("commands")],
    ] as const;
    for (const density of ["comfortable", "compact"] as const) {
      h.session.setDensity(density);
      for (const [view, open] of views) {
        open();
        const raw = h.shell.frame();
        const lines = plain(raw);
        const label = `${density} ${view}`;
        expect(lines.length, label).toBe(40);
        expect(lines.at(-2), label).toContain(" NORMAL ");
        if (density === "comfortable") {
          expect(lines.at(-3), label).toBe(" ".repeat(120));
          expect(raw.at(-3), label).toContain(bg);
          expect(lines.at(-4)?.trim(), label).not.toBe("");
        } else expect(lines.at(-3)?.trim(), label).not.toBe("");
      }
      h.session.closeView();
    }
    // The completion rows and the prompt keep their places below the status line.
    h.session.setDensity("comfortable");
    type(h, ":", "f", "\t");
    const lines = plain(h.shell.frame());
    const status = lines.findIndex(l => l.includes(" COMMAND "));
    expect(lines[status - 1]).toBe(" ".repeat(120));
    expect(lines.slice(status + 1, -1).join("\n")).toMatch(/:filter[\s\S]*:focus[\s\S]*:forward/);
    expect(lines.at(-1)).toMatch(/^:filter/);
  });

  test("S4: comfortable keeps a 1-cell margin at both ends of the status and hint lines; compact is flush", async () => {
    const h = await started();
    h.session.notify("error", "something failed"); // a local unread notification: the right-hand badge
    h.session.addProblems([{ level: "warn", text: "a tui.toml problem" }]);
    let lines = plain(h.shell.frame());
    expect(lines.at(-2)).toMatch(/^ {2}NORMAL {2}\u2502 tasks/);
    expect(lines.at(-2)).toMatch(/ \u2709 1 unread {2}! 1 problem \u00b7 :messages {2}$/);
    expect(lines.at(-1)).toMatch(/^ {2}: commands {2}\u00b7/);
    expect(lines.at(-1)?.at(-1)).toBe(" ");
    h.session.setDensity("compact");
    lines = plain(h.shell.frame());
    expect(lines.at(-2)).toMatch(/^ NORMAL {2}\u2502 tasks/);
    expect(lines.at(-2)).toMatch(/ \u2709 1 unread {2}! 1 problem \u00b7 :messages $/);
    expect(lines.at(-1)).toMatch(/^ : commands {2}\u00b7/);
  });

  test("S4: the status line's click targets stay exact with and without the margins", async () => {
    for (const density of ["comfortable", "compact"] as const) {
      const h = await started();
      h.session.setDensity(density);
      h.session.notify("error", "something failed");
      h.session.addProblems([{ level: "warn", text: "a tui.toml problem" }]);
      const lines = plain(h.shell.frame());
      const y = lines.length - 2;
      const unread = " \u2709 1 unread ";
      const problems = " ! 1 problem \u00b7 :messages ";
      const at = (lines[y] ?? "").indexOf(unread);
      const end = at + unread.length + problems.length; // one past the last badge cell
      expect(end, density).toBe(density === "comfortable" ? 119 : 120);
      const click = (x: number, row = y) =>
        h.shell.handleMouse({
          type: "click",
          button: "left",
          x,
          y: row,
          screenX: x,
          screenY: row,
          width: 120,
          height: 40,
          shift: false,
          alt: false,
          ctrl: false,
        } as never);
      click(at - 1); // just left of the badges
      click(end); // the margin (comfortable), past the edge (compact)
      click(at + 2, y - 1); // the right column, the row above (the spacer, or the list's last row)
      expect([h.session.dialog, h.session.view], density).toEqual([null, "workspace"]);
      click(end - 1); // the last cell of the problems badge
      expect(h.session.view, density).toBe("messages");
      h.session.closeView();
      click(at); // the first cell of the unread badge
      await settle();
      expect(h.session.dialog?.label, density).toBe("notifications");
    }
  });

  test("R7: the hint line shows only the hints that fit whole (dropped from the end), dialogs too", async () => {
    const workspace = [": commands", "/ search", "f filters", ";o sort", "? help", ":q quit", "j/k move"];
    for (const [columns, rows, shown] of [
      [120, 40, [...workspace, "i edits", "Tab focus"]],
      [80, 24, workspace.slice(0, 6)],
    ] as const) {
      const h = await started({ columns, rows });
      for (const density of ["comfortable", "compact"] as const) {
        h.session.setDensity(density);
        const hint = plain(h.shell.frame()).at(-1) ?? "";
        const lead = density === "comfortable" ? "  " : " ";
        expect(hint, `${columns} ${density}`).toBe(`${lead}${shown.join("  \u00b7  ")}`.padEnd(columns));
        expect(hint).not.toContain("\u2026");
      }
      // A dialog's hints: whole parts too, in their own separators.
      h.session.setDensity("comfortable");
      type(h, "f");
      const hint = plain(h.shell.frame()).at(-1) ?? "";
      const all =
        "j/k move \u00b7 Space toggles \u00b7 Enter/Esc close (the filters stay) \u00b7 d o r b x u a toggle \u00b7 F clears \u00b7 / searches";
      expect(hint).not.toContain("\u2026");
      expect(hint.trim()).toBe(
        columns === 120 ? all : "j/k move \u00b7 Space toggles \u00b7 Enter/Esc close (the filters stay)",
      );
      type(h, "\x1b");
    }
  });
});

/** The SGR parameters immediately before the first `text` in the frame ("" when the text is unstyled). */
function sgrBefore(lines: string[], text: string): string {
  const joined = lines.join("\n");
  const at = joined.indexOf(text);
  expect(at, `the frame shows ${text}`).toBeGreaterThan(-1);
  const m = /\x1b\[([0-9;]*)m$/.exec(joined.slice(0, at));
  return m?.[1] ?? "";
}
const hasDim = (codes: string) => codes.split(";").includes("2");
const rgbOf = (hex: string) => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)).join(";");

describe("the focused pane (N23): the other pane is greyed out, never by color alone", () => {
  const truecolor = { COLORTERM: "truecolor", TERM: "xterm-256color" };

  test("truecolor: the unfocused pane is painted in the inactive grey; Tab moves it", async () => {
    const h = await started({ env: truecolor, cliTheme: "cortex-dark" });
    const c = h.session.theme?.colors;
    if (c === undefined) throw new Error("no theme");
    const grey = `38;2;${rgbOf(c.inactive)}`;
    const text = `38;2;${rgbOf(c.text)}`;
    // The list has the focus: its rows keep full contrast, the document is greyed.
    let frame = h.shell.frame();
    expect(sgrBefore(frame, "Hold: blocked on review").startsWith(text)).toBe(true);
    expect(sgrBefore(frame, "Step one Step two").startsWith(grey)).toBe(true);
    type(h, "\t");
    frame = h.shell.frame();
    expect(sgrBefore(frame, "Hold: blocked on review").startsWith(grey)).toBe(true);
    expect(sgrBefore(frame, "Step one Step two").startsWith(text)).toBe(true);
  });

  test("NO_COLOR: the unfocused pane is SGR dim and the focused pane's label is inverse", async () => {
    const h = await started();
    let frame = h.shell.frame();
    expect(sgrBefore(frame, " TASKS ")).toBe("1;7");
    expect(hasDim(sgrBefore(frame, "Hold: blocked on review"))).toBe(false);
    expect(hasDim(sgrBefore(frame, "Step one Step two"))).toBe(true);
    expect(hasDim(sgrBefore(frame, " READ "))).toBe(true);
    type(h, "\t");
    frame = h.shell.frame();
    expect(hasDim(sgrBefore(frame, " TASKS "))).toBe(true);
    expect(hasDim(sgrBefore(frame, "Hold: blocked on review"))).toBe(true);
    expect(hasDim(sgrBefore(frame, "Step one Step two"))).toBe(false);
    expect(sgrBefore(frame, " READ ")).toBe("1;7");
  });

  test("the list alone (80 columns) is never greyed: it is the focused pane", async () => {
    const h = await started({ columns: MIN_COLUMNS, rows: MIN_ROWS });
    const frame = h.shell.frame();
    expect(sgrBefore(frame, " TASKS ")).toBe("1;7");
    expect(hasDim(sgrBefore(frame, "Hold: blocked on review"))).toBe(false);
  });

  test("wide Split: the unfocused half is greyed; the focused half and the pane chrome keep full contrast", async () => {
    const h = await started({ columns: 160, rows: 40 });
    type(h, ";", "s");
    await settle();
    type(h, "\t");
    expect(h.session.splitHalf).toBe("editor");
    let frame = h.shell.frame();
    expect(sgrBefore(frame, " EDIT ")).toBe("1;7");
    expect(hasDim(sgrBefore(frame, " PREVIEW "))).toBe(true);
    expect(hasDim(sgrBefore(frame, "Step one Step two"))).toBe(true); // the preview half
    expect(hasDim(sgrBefore(frame, "Fix the login flow"))).toBe(false); // the document title (chrome)
    type(h, "\t");
    expect(h.session.splitHalf).toBe("preview");
    frame = h.shell.frame();
    expect(sgrBefore(frame, " PREVIEW ")).toBe("1;7");
    expect(hasDim(sgrBefore(frame, " EDIT "))).toBe(true);
    expect(hasDim(sgrBefore(frame, "Step one Step two"))).toBe(false);
    // The list, beside both halves, is greyed while the document has the focus.
    expect(hasDim(sgrBefore(frame, "Hold: blocked on review"))).toBe(true);
  });
});

describe("safe output (N20)", () => {
  test("untrusted titles, bodies and lanes are escaped before they reach the terminal", async () => {
    const hostile = "\x1b]52;c;SGVsbG8=\x07\x1b[2J\x9b31m";
    const h = await started({
      tasks: [task(1, { title: `evil${hostile}`, body: `line${hostile}\ttab`, lane: `now${hostile}` })],
    });
    const lines = h.shell.frame();
    const joined = lines.join("\n");
    // Only SGR remains once the renderer's own styling is removed.
    expect(joined.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(joined).toContain("evil^[]52;c;SGVsbG8=^G^[[2J<U+009B>31m");
  });
});

describe("keys (N17/N18)", () => {
  test("j/k move the selection in display order with counts; g/G jump to the ends", async () => {
    const h = await started();
    // Display order (ascending id): 1 Fix, 2 Hold, 3 Draft, 4 Wait; the fallback is the first task in server order.
    expect(h.session.selectedTask()?.id).toBe(1);
    type(h, "j");
    expect(h.session.selectedId).toBe(2);
    type(h, "2", "j");
    expect(h.session.selectedId).toBe(4);
    type(h, "g");
    expect(h.session.selectedId).toBe(1);
    type(h, "G");
    expect(h.session.selectedId).toBe(4);
    type(h, "k");
    expect(h.session.selectedId).toBe(3);
  });

  test("focus moves with Tab/Shift-Tab, h/l and ;h/;l; j/k then scroll the document", async () => {
    const h = await started();
    type(h, "\t");
    expect(h.session.focus).toBe("document");
    type(h, "\x1b[Z");
    expect(h.session.focus).toBe("tasks");
    type(h, "l");
    expect(h.session.focus).toBe("document");
    type(h, "h");
    expect(h.session.focus).toBe("tasks");
    type(h, ";", "l");
    expect(h.session.focus).toBe("document");
    type(h, "j");
    expect(h.session.selectedTask()?.id).toBe(1);
    expect(h.session.docScroll(1)).toBe(1);
    type(h, ";", "h");
    expect(h.session.focus).toBe("tasks");
  });

  test("a bare q reminds about :q; Ctrl-C cancels pending input and never quits; function keys are inert", async () => {
    const h = await started();
    type(h, "q");
    expect(h.session.status?.text).toMatch(/:q/);
    type(h, "3", "\x03", "j");
    expect(h.session.selectedId).toBe(2);
    type(h, "\x03");
    expect(h.session.status?.text).toMatch(/:q/);
    type(h, "\x1bOP", "\x1b[15~", "\x1b[57376u");
    expect(h.quits).toEqual([]);
    expect(h.session.selectedId).toBe(2);
  });

  test("`:` opens the command line; :q, :quit and :q! quit; Esc cancels; :<id> opens a task", async () => {
    const h = await started();
    type(h, ":", "4", "\r");
    expect(h.session.selectedId).toBe(4);
    type(h, ":", "q");
    expect(plain(h.shell.frame()).at(-1)).toContain(":q");
    type(h, "\x1b");
    expect(h.session.prompt).toBeNull();
    expect(h.quits).toEqual([]);
    type(h, ":", "q", "\r");
    await settle();
    type(h, ":", "q", "u", "i", "t", "\r");
    await settle();
    type(h, ":", "q", "!", "\r");
    await settle();
    expect(h.quits).toEqual([false, false, true]);
  });

  test("the command line never executes a pasted newline", async () => {
    const h = await started();
    type(h, ":", "\x1b[200~q\r\n\x1b[201~");
    expect(h.quits).toEqual([]);
    expect(h.session.prompt?.text).toBe("q ");
  });

  test("/ filters the task list; an empty search clears it", async () => {
    const h = await started();
    type(h, "/", ..."docs", "\r");
    expect(h.session.query).toBe("docs");
    expect(screen(h)).not.toContain("Fix the login flow");
    type(h, "/", "\r");
    expect(h.session.query).toBe("");
  });

  test("? and :help show the commands and the configured keys; q or Esc close the view", async () => {
    const config: TuiConfig = { ...DEFAULT_CONFIG, keys: parseKeys({ keys: { normal: { down: ["ctrl+n"] } } }).keys };
    const h = await started({ config });
    const hint = plain(h.shell.frame()).at(-1) ?? "";
    expect(hint).toContain("Ctrl-n");
    type(h, "?");
    expect(h.session.view).toBe("help");
    h.terminal.rows = 200; // the whole (scrollable) help on one screen
    const help = screen(h);
    for (const text of [
      ":q  :quit",
      ":q!  :quit!",
      ":open <id|query>",
      ":filter [status|lane|tags] <value>",
      ":back",
      ":commands [search]",
      ":help  :h",
      ":messages",
      "Ctrl-n",
      "Tab",
      ";h",
      "Ctrl-z",
    ]) {
      expect(help).toContain(text);
    }
    expect(help).not.toMatch(/\bF(?:[1-9]|1[0-9]|2[0-9]|3[0-5])\b/);
    h.terminal.rows = 40;
    type(h, "G");
    expect(h.session.viewScroll).toBeGreaterThan(0);
    expect(screen(h)).toContain("theme tokens"); // the last help section: the tui.toml settings
    type(h, "q");
    expect(h.session.view).toBe("workspace");
    type(h, ":", ..."help", "\r", "\x1b");
    expect(h.session.view).toBe("workspace");
  });

  test("/ in the help searches the help, never the task list: the first match is shown and marked; n/N step and wrap; the help stays open", async () => {
    const h = await started();
    type(h, "?");
    expect(plain(h.shell.frame()).at(-1)).toContain("/ searches");
    type(h, "/");
    expect(screen(h)).toContain("Enter searches the help");
    type(h, ..."picker", "\r");
    expect(h.session.view).toBe("help");
    expect(h.session.query).toBe(""); // the task list's search is untouched
    const first = /^\/picker: match 1 of (\d+)$/.exec(h.session.status?.text ?? "");
    expect(first).not.toBeNull();
    const count = Number(first?.[1]);
    expect(count).toBeGreaterThan(2);
    const marked = () => plain(h.shell.frame()).filter(row => row.startsWith("\u25b8"));
    expect(marked().length).toBe(1); // the current match's row, in the margin
    expect(marked()[0]).toContain("picker");
    // Every match is underlined in the search pair (inverse without color); the current one is also bold.
    expect(h.shell.frame().join("\n")).toContain("\x1b[1;4;7mpicker\x1b[0m");
    expect(plain(h.shell.frame()).at(-1)).toContain("n/N matches");
    type(h, "n");
    expect(h.session.status?.text).toBe(`/picker: match 2 of ${count}`);
    expect(h.session.view).toBe("help");
    type(h, "N", "N");
    expect(h.session.status?.text).toBe(`/picker: match ${count} of ${count} (wrapped to the last)`);
    expect(h.session.viewScroll).toBeGreaterThan(0); // scrolled to the last match
    expect(marked().length).toBe(1);
    type(h, "n");
    expect(h.session.status?.text).toBe(`/picker: match 1 of ${count} (wrapped to the first)`);
    expect(marked().length).toBe(1);
    // Case-insensitive and literal; no match and an empty search say so.
    type(h, "/", ..."KEYS \u00b7 LEADER", "\r");
    expect(h.session.status?.text).toBe("/KEYS \u00b7 LEADER: match 1 of 1");
    type(h, "/", ..."(zz", "\r");
    expect(h.session.status?.text).toBe("No match for /(zz in the help");
    expect(marked()).toEqual([]);
    type(h, "/", ..."picker", "\r", "/", "\r");
    expect(h.session.status?.text).toBe("Help search cleared");
    expect(marked()).toEqual([]);
    expect(h.shell.frame().join("\n")).not.toContain("\x1b[4;7m");
    expect(h.session.query).toBe("");
  });

  test("closing the help forgets its search; n/N in the help without one explain themselves", async () => {
    const h = await started();
    type(h, "?", "/", ..."picker", "\r");
    expect(h.session.status?.text).toMatch(/^\/picker: match 1 of/);
    type(h, "\x1b");
    expect(h.session.view).toBe("workspace");
    type(h, "?");
    expect(plain(h.shell.frame()).some(row => row.startsWith("\u25b8"))).toBe(false);
    expect(h.shell.frame().join("\n")).not.toContain("\x1b[4;7m");
    type(h, "n");
    expect(h.session.view).toBe("help");
    expect(h.session.status?.text).toBe("No search in the help: / searches it, then n and N step through the matches");
    // Outside the help, n/N are the task list's again.
    type(h, "q", "n");
    expect(h.session.status?.text).toMatch(/No search: \/ searches the task list/);
  });

  test("the help wraps a long description under its column instead of cutting it", async () => {
    const h = await started({ columns: 80 });
    type(h, "?");
    h.terminal.rows = 600; // the whole help on one screen
    const rows = plain(h.shell.frame());
    const at = rows.findIndex(row => row.includes(":set <option>"));
    expect(rows[at]).toContain("Options: done");
    // The rest of it continues on the next rows, indented to the description column (the margin, then 27 cells).
    const rest = rows.slice(at + 1, at + 6);
    expect(rest.join(" ")).toContain("name? shows");
    expect(rest[0]?.startsWith(" ".repeat(28))).toBe(true);
    expect(rest[0]?.[28]).not.toBe(" ");
    // No row is cut short any more.
    expect(rows.slice(0, -2).some(row => row.includes("\u2026"))).toBe(false);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(80);
  });

  test("the help lists every tui.toml setting with its default and meaning, the custom theme format and the tokens", async () => {
    const h = await started();
    type(h, "?");
    h.terminal.rows = 600; // the whole help on one screen
    const rows = plain(h.shell.frame());
    expect(rows.some(row => row.includes("SETTINGS \u00b7 tui.toml"))).toBe(true);
    for (const s of SETTING_HELP) {
      const row = rows.find(r => new RegExp(`^\\s+${s.key}\\s`).test(r));
      expect(row, s.key).toBeDefined();
      expect(row, s.key).toContain(`default ${s.default ?? "unset"}`);
    }
    const all = rows.join(" ");
    for (const name of BUNDLED_THEME_NAMES) expect(all, name).toContain(name);
    for (const token of THEME_TOKENS) expect(all, token).toContain(token);
    expect(rows.slice(0, -2).some(row => row.includes("\u2026"))).toBe(false);
  });

  test("no view ever hints a function key", async () => {
    const h = await started();
    for (const view of ["workspace", "help", "messages", "commands"] as const) {
      h.session.openView(view);
      expect(screen(h)).not.toMatch(/\bF(?:[1-9]|1[0-9]|2[0-9]|3[0-5])\b/);
    }
    h.session.closeView();
    type(h, ":");
    type(h, "\t");
    expect(screen(h)).not.toMatch(/\bF(?:[1-9]|1[0-9]|2[0-9]|3[0-5])\b/);
  });

  test("Tab completion shows the candidates above the `:` line, each with what it names", async () => {
    const h = await started();
    type(h, ":", "f", "\t");
    let lines = plain(h.shell.frame());
    expect(lines.length).toBe(40);
    expect(lines.at(-1)).toContain(":filter");
    const shown = lines.join("\n");
    expect(shown).toMatch(/:filter\s+Narrow the task list/);
    expect(shown).toMatch(/:focus\s+Move the keyboard focus/);
    expect(shown).toMatch(/:forward\s+Go forward/);
    type(h, "\t");
    expect(plain(h.shell.frame()).at(-1)).toContain(":focus");
    type(h, "\x1b[Z", "\x1b[Z");
    expect(plain(h.shell.frame()).at(-1)).toContain(":forward");
    // Task ids complete with their titles.
    type(h, "\x15", ..."open ", "\t");
    lines = plain(h.shell.frame());
    expect(lines.join("\n")).toMatch(/:open 1\s+Fix the login flow/);
    type(h, "\x1b");
    expect(h.session.prompt).toBeNull();
    expect(plain(h.shell.frame()).join("\n")).not.toContain(":open 2");
  });

  test("the `:` line recalls its history with Up/Down, restoring the unfinished line", async () => {
    const h = await started();
    type(h, ":", ..."4", "\r");
    type(h, ":", ..."mes", "\r", "q");
    type(h, ":", ..."4x", "\x1b[A");
    expect(h.session.prompt?.text).toBe("4x");
    type(h, "\x7f", "\x7f", "\x1b[A");
    expect(h.session.prompt?.text).toBe("mes");
    type(h, "\x1b[A");
    expect(h.session.prompt?.text).toBe("4");
    type(h, "\x1b[B", "\x1b[B");
    expect(h.session.prompt?.text).toBe("");
  });

  test("unknown commands and arguments are explained on the status line", async () => {
    const h = await started();
    type(h, ":", ..."frobnicate", "\r");
    await settle();
    expect(plain(h.shell.frame()).at(-2)).toContain("error: Unknown command :frobnicate");
    type(h, ":", ..."set bogus", "\r");
    await settle();
    expect(plain(h.shell.frame()).at(-2)).toContain('Unknown option "bogus"');
  });

  test("n/N step the search results; :open keeps the filters; Ctrl-o goes back", async () => {
    const h = await started();
    type(h, "/", ..."review", "\r");
    // Two title matches score alike and keep the server order.
    expect(h.session.visibleTasks().map(t => t.id)).toEqual([2, 4]);
    // Without a selection the fallback is the top of the filtered view (task 2).
    expect(h.session.selectedTask()?.id).toBe(2);
    type(h, "n");
    expect(h.session.selectedId).toBe(4);
    type(h, "n");
    expect(h.session.selectedId).toBe(2);
    expect(h.session.status?.text).toMatch(/wrapped/);
    type(h, "N");
    expect(h.session.selectedId).toBe(4);
    type(h, ":", ..."open 1", "\r");
    await settle();
    expect(h.session.selectedId).toBe(1);
    expect(h.session.query).toBe("review");
    h.session.setFocus("document");
    expect(screen(h)).toContain("Outside the current list filters");
    type(h, "\x0f");
    expect(h.session.selectedId).toBe(4);
    // While the rendered document has the focus, n/N and the hint are about searching it (Task 10) ...
    expect(plain(h.shell.frame()).at(-1)).toContain("/ searches the document");
    // ... and with the list focused, about the list's search results.
    h.session.setFocus("tasks");
    const hint = plain(h.shell.frame()).at(-1) ?? "";
    expect(hint).toContain("n/N results");
  });

  test(":commands and Ctrl-p open the searchable reference; / narrows it; Enter picks", async () => {
    const h = await started();
    type(h, "\x10");
    expect(h.session.view).toBe("commands");
    expect(screen(h)).toContain(`COMMANDS · ${h.session.commands.length} of ${h.session.commands.length}`);
    type(h, "/", ..."task history", "\r");
    const text = screen(h);
    expect(text).toContain("2 of");
    expect(text).toMatch(/▌:back\s+Go back/);
    h.session.openCommands("quit");
    expect(screen(h)).toMatch(/:q {2}:quit\s+Quit this terminal workspace/);
    type(h, "\x1b", "\x10", "/", ..."task history", "\r");
    type(h, "j", "\r");
    await settle();
    expect(h.session.view).toBe("workspace");
    expect(h.session.status?.text).toMatch(/No later task/);
    type(h, ":", ..."commands open", "\r");
    await settle();
    type(h, "\r");
    expect(h.session.prompt?.text).toBe("open ");
    expect(h.session.keys.mode()).toBe("COMMAND");
  });

  test(":suspend suspends like Ctrl-z", async () => {
    const h = await started();
    type(h, ":", ..."suspend", "\r");
    await settle();
    expect(h.signals).toEqual(["SIGTSTP:stops=1:restored=true"]);
  });

  test("the toolkit's fullscreen viewport keys are bound to nothing", async () => {
    await started();
    for (const id of [
      "tui.altScreen.pageUp",
      "tui.altScreen.pageDown",
      "tui.altScreen.top",
      "tui.altScreen.bottom",
      "tui.altScreen.previousPrompt",
      "tui.altScreen.nextPrompt",
      "tui.altScreen.search",
    ] as const) {
      expect(getKeybindings().getKeys(id)).toEqual([]);
    }
  });
});

describe("themes before the first frame (N22/N23)", () => {
  const truecolor = { TERM: "xterm-256color", COLORTERM: "truecolor" };

  test("nothing themed renders until appearance detection finishes; a DSR light answer selects cortex-light", async () => {
    const h = harness({ env: truecolor, budgetMs: 1000 });
    const starting = h.shell.start();
    await settle();
    // Both queries went out together, before any content frame.
    expect(h.terminal.output()).toContain("\x1b[?996n");
    expect(h.terminal.output()).toContain("\x1b]11;?\x07");
    expect(h.shell.frame().join("")).not.toMatch(/\x1b\[/);
    type(h, "j"); // typed while the theme resolves: queued, not lost
    expect(h.session.selectedTask()?.id).toBe(1);
    h.terminal.reply("\x1b[?997;2n");
    await starting;
    expect(h.session.selectedId).toBe(2);
    expect(h.shell.theme?.name).toBe("cortex-light");
    expect(h.shell.frame().join("")).toContain("48;2;246;242;236");
    // Auto follows palette notifications (mode 2031) afterwards.
    expect(h.terminal.output()).toContain("\x1b[?2031h");
    h.terminal.reply("\x1b[?997;1n");
    expect(h.shell.theme?.name).toBe("cortex-dark");
  });

  test("an unanswered terminal means dark", async () => {
    const h = await started({ env: truecolor, budgetMs: 10 });
    expect(h.shell.theme?.name).toBe("cortex-dark");
  });

  test("an explicit --theme skips detection and ignores later appearance reports", async () => {
    const h = await started({ env: truecolor, cliTheme: "high-contrast-light" });
    expect(h.terminal.output()).not.toContain("\x1b[?996n");
    expect(h.shell.theme?.name).toBe("high-contrast-light");
    h.terminal.reply("\x1b[?997;1n");
    expect(h.shell.theme?.name).toBe("high-contrast-light");
  });

  test("the 16-color notice shows on the first frame and is recorded once in :messages", async () => {
    const h = await started({ env: { TERM: "xterm" }, cliTheme: "cortex-dark" });
    expect(plain(h.shell.frame()).at(-2)).toContain("16 colors");
    const notices = h.session.messages.filter(m => m.text.includes("16 colors"));
    expect(notices.length).toBe(1);
    type(h, "j");
    expect(plain(h.shell.frame()).at(-2)).not.toContain("16 colors");
    expect(h.session.messages.filter(m => m.text.includes("16 colors")).length).toBe(1);
  });

  test("tui.toml problems give a persistent status warning that points to :messages", async () => {
    const h = harness();
    h.session.addProblems([{ level: "warn", text: "tui.toml: keys.normal.down: bad" }]);
    await h.shell.start();
    type(h, "j");
    const status = plain(h.shell.frame()).at(-2) ?? "";
    expect(status).toContain("1 problem");
    expect(status).toContain(":messages");
    type(h, ":", ..."messages", "\r");
    expect(screen(h)).toContain("tui.toml: keys.normal.down: bad");
  });
});

describe("detectAppearance", () => {
  function fakeQueries(scheme: Promise<"dark" | "light" | undefined>, background: Promise<unknown>) {
    const calls: string[] = [];
    return {
      calls,
      tui: {
        queryTerminalColorScheme: ({ timeoutMs }: { timeoutMs: number }) => {
          calls.push(`dsr:${timeoutMs}`);
          return scheme;
        },
        queryTerminalBackgroundColor: ({ timeoutMs }: { timeoutMs: number }) => {
          calls.push(`osc11:${timeoutMs}`);
          return background as Promise<{ r: number; g: number; b: number } | undefined>;
        },
      },
    };
  }

  test("sends DSR 996 and OSC 11 together under one budget; the DSR answer wins", async () => {
    const q = fakeQueries(Promise.resolve("light"), new Promise(() => {}));
    const result = detectAppearance(q.tui);
    expect(q.calls).toEqual([`dsr:${APPEARANCE_BUDGET_MS}`, `osc11:${APPEARANCE_BUDGET_MS}`]);
    expect(await result).toBe("light");
    expect(APPEARANCE_BUDGET_MS).toBe(150);
  });

  test("without a DSR answer the OSC 11 background decides by luminance; nothing means null (dark)", async () => {
    const light = fakeQueries(Promise.resolve(undefined), Promise.resolve({ r: 246, g: 242, b: 236 }));
    expect(await detectAppearance(light.tui, 5)).toBe("light");
    const dark = fakeQueries(Promise.resolve(undefined), Promise.resolve({ r: 29, g: 31, b: 36 }));
    expect(await detectAppearance(dark.tui, 5)).toBe("dark");
    const silent = fakeQueries(Promise.resolve(undefined), Promise.resolve(undefined));
    expect(await detectAppearance(silent.tui, 5)).toBeNull();
  });
});

describe("terminal restoration (N20)", () => {
  test("stop leaves the alternate screen without dumping the document and writes every reset", async () => {
    const h = await started();
    h.terminal.writes = [];
    h.shell.stop();
    const out = h.terminal.output();
    expect(out).toContain("\x1b[?1049l");
    expect(out).not.toContain("Fix the login flow");
    expect(out.endsWith(TERMINAL_RESET)).toBe(true);
    for (const reset of [
      "\x1b[?2004l",
      "\x1b[?1000l",
      "\x1b[?1006l",
      "\x1b[?2031l",
      "\x1b[>4m",
      "\x1b[?25h",
      "\x1b[0m",
    ]) {
      expect(TERMINAL_RESET).toContain(reset);
    }
    expect(h.terminal.stops).toBe(1);
    h.shell.stop();
    expect(h.terminal.stops).toBe(1);
  });

  test("Ctrl-z restores the terminal BEFORE SIGTSTP and re-enters it after SIGCONT", async () => {
    const h = await started();
    type(h, "\x1a");
    expect(h.signals).toEqual(["SIGTSTP:stops=1:restored=true"]);
    expect(h.terminal.starts).toBe(2);
    expect(h.terminal.output().lastIndexOf("\x1b[?1049h")).toBeGreaterThan(h.terminal.output().indexOf("\x1b[?1049l"));
    type(h, "j");
    expect(h.session.selectedId).toBe(2);
  });

  test("an external program gets the terminal as Ctrl-z does; the TUI takes it back and redraws", async () => {
    const h = await started();
    const seen: string[] = [];
    const code = await withExternalProgram(h.session, ["prog", "an arg"], {
      run: async argv => {
        const restored = h.terminal.output().includes(TERMINAL_RESET);
        seen.push(
          `${JSON.stringify(argv)}:stops=${h.terminal.stops}:restored=${restored}:handingOff=${h.shell.handingOff}`,
        );
        return 7;
      },
    });
    expect(code).toBe(7);
    expect(seen).toEqual([`["prog","an arg"]:stops=1:restored=true:handingOff=true`]);
    expect(h.terminal.starts).toBe(2);
    expect(h.terminal.output().lastIndexOf("\x1b[?1049h")).toBeGreaterThan(h.terminal.output().indexOf("\x1b[?1049l"));
    expect(h.shell.handingOff).toBe(false);
    type(h, "j");
    expect(h.session.selectedId).toBe(2);
  });

  test("a program that cannot start still gives the terminal back", async () => {
    const h = await started();
    const failed = withExternalProgram(h.session, ["nope"], {
      run: async () => {
        throw new Error("Executable not found in $PATH");
      },
    });
    await expect(failed).rejects.toThrow("Could not run nope: Executable not found in $PATH");
    expect(h.terminal.starts).toBe(2);
    expect(h.shell.handingOff).toBe(false);
  });

  const count = (text: string, needle: string) => text.split(needle).length - 1;

  test("the mouse: 1002 + 1006 once the terminal is taken (never any-motion 1003), off again BEFORE the alternate screen closes", async () => {
    const h = await started();
    const out = h.terminal.output();
    expect(count(out, MOUSE_ON)).toBe(1);
    expect(out.indexOf(MOUSE_ON)).toBeGreaterThan(out.indexOf("\x1b[?1049h"));
    for (const never of ["\x1b[?1003h", "\x1b[?1000h", "\x1b[?1004h"]) expect(out).not.toContain(never);
    h.terminal.writes = [];
    h.shell.stop();
    const after = h.terminal.output();
    expect(after.indexOf(MOUSE_OFF)).toBeGreaterThanOrEqual(0);
    expect(after.indexOf(MOUSE_OFF)).toBeLessThan(after.indexOf("\x1b[?1049l"));
    expect(TERMINAL_RESET).toContain(MOUSE_OFF); // repeated by the always-safe resets
  });

  test("Ctrl-z and a handed-off program turn the mouse off first and on again after", async () => {
    const h = await started();
    h.terminal.writes = [];
    type(h, "\x1a");
    const suspended = h.terminal.output();
    expect(suspended.indexOf(MOUSE_OFF)).toBeLessThan(suspended.indexOf("\x1b[?1049l"));
    expect(suspended.lastIndexOf(MOUSE_ON)).toBeGreaterThan(suspended.lastIndexOf("\x1b[?1049h"));
    h.terminal.writes = [];
    const seen: boolean[] = [];
    await withExternalProgram(h.session, ["prog"], {
      run: async () => {
        const now = h.terminal.output();
        seen.push(now.includes(MOUSE_OFF) && !now.includes(MOUSE_ON));
        return 0;
      },
    });
    expect(seen).toEqual([true]);
    expect(count(h.terminal.output(), MOUSE_ON)).toBe(1);
  });

  test("mouse = false never enables mouse reporting (and the resets still run)", async () => {
    const h = await started({ config: { ...DEFAULT_CONFIG, mouse: false } });
    expect(h.terminal.output()).not.toContain("\x1b[?1002h");
    expect(h.terminal.output()).not.toContain("\x1b[?1006h");
    h.shell.stop();
    expect(h.terminal.output().endsWith(TERMINAL_RESET)).toBe(true);
  });
});

describe("--heading, the reader keys and the mouse", () => {
  const body = [
    "# Plan",
    "",
    "```sh",
    "# not a heading",
    "```",
    "",
    ...Array.from({ length: 60 }, (_, i) => `Paragraph ${i}.\n`),
    "Risks",
    "-----",
    "",
    "the first risks",
    "",
    "## Risks",
    "",
    "the end",
  ].join("\n");
  /** The document pane's body rows (below its divider). */
  const readerRows = (h: Harness): string[] => {
    const lines = plain(h.shell.frame());
    const divider = lines.findIndex(l => l.includes("READ"));
    // S5: comfortable leaves one blank row under the divider.
    const gap = h.session.density === "comfortable" ? 1 : 0;
    return lines.slice(divider + 1 + gap).map(l => l.slice(l.indexOf("│") + 1));
  };
  /**
   * The frame and the document pane's first and last body rows: the row under
   * the divider named `label` (+1 under comfortable) to the row above the
   * comfortable spacer, the status and the hint.
   */
  const bodySpan = (h: Harness, label: string) => {
    const lines = plain(h.shell.frame());
    const gap = h.session.density === "comfortable" ? 1 : 0;
    const first = lines.findIndex(l => l.includes(label)) + 1 + gap;
    const last = lines.length - 4;
    const thumb = lines.flatMap((l, i) => (l.endsWith("┃") ? [i] : []));
    return { lines, first, last, thumb };
  };

  test("Read shows a ┃ thumb in the document's right-most column while more is above or below; none when it fits", async () => {
    const h = await started({
      tasks: [task(7, { title: "long doc", body }), task(8, { title: "short", body: "one line" })],
      initialTask: 7,
    });
    type(h, "\t");
    let span = bodySpan(h, "READ");
    expect(span.thumb.length).toBeGreaterThan(0);
    expect(span.thumb[0]).toBe(span.first);
    expect(span.thumb.every((y, i) => i === 0 || y === (span.thumb[i - 1] ?? 0) + 1)).toBe(true);
    expect(span.thumb).not.toContain(span.last);
    type(h, "G");
    span = bodySpan(h, "READ");
    expect(span.thumb).toContain(span.last);
    expect(span.thumb).not.toContain(span.first);
    h.session.select(8);
    expect(bodySpan(h, "READ").thumb).toEqual([]);
  });

  test("Edit and both wide Split halves show the same scrollbar", async () => {
    const h = await started({ tasks: [task(7, { title: "long doc", body })], initialTask: 7 });
    h.session.setFocus("document");
    h.session.setDocumentMode("edit");
    await settle();
    let span = bodySpan(h, "EDIT");
    expect(span.lines[span.first]?.endsWith("┃")).toBe(true);
    h.session.documentOf(7)?.editor?.move("doc-end");
    span = bodySpan(h, "EDIT");
    expect(span.lines[span.last]?.endsWith("┃")).toBe(true);
    expect(span.lines[span.first]?.endsWith("┃")).toBe(false);
    // 120 columns: a wide Split; the editor half's bar sits left of the halves' rule, the preview's at the edge.
    h.session.setDocumentMode("split");
    span = bodySpan(h, "PREVIEW");
    const last = span.lines[span.last] ?? "";
    const rule = last.indexOf("│", 39 + 1);
    expect(rule).toBeGreaterThan(40);
    expect(last[rule - 1]).toBe("┃");
    expect(last.endsWith("┃")).toBe(true);
  });

  test("the requested heading (the shared slugger: setext headings and repeats count) opens at the top, once", async () => {
    const h = await started({
      tasks: [task(7, { title: "long doc", body })],
      initialTask: 7,
      heading: "task-7-risks-2",
    });
    expect(h.session.focus).toBe("document");
    expect(readerRows(h)[0]).toContain("Risks");
    expect(readerRows(h).join("\n")).toContain("the end");
    expect(readerRows(h).join("\n")).not.toContain("the first risks");
    expect(screen(h)).toMatch(/§ Risks 3\/3/);
    expect(h.session.pendingHeading()).toBeNull();
    const missing = await started({ tasks: [task(7, { title: "long doc", body })], initialTask: 7, heading: "nope" });
    missing.shell.frame();
    expect(missing.session.status?.text).toContain("No heading #nope in @7");
  });

  test("} and { step through the headings (help lists them as available); the editor keeps them", async () => {
    const h = await started({ tasks: [task(7, { title: "long doc", body })], initialTask: 7 });
    type(h, "\t");
    expect(readerRows(h)[0]).toContain("Plan");
    type(h, "}");
    expect(readerRows(h)[0]).toContain("Risks");
    expect(screen(h)).toMatch(/§ Risks 2\/3/);
    type(h, "2", "}");
    expect(screen(h)).toMatch(/§ Risks 3\/3/);
    type(h, "{");
    expect(screen(h)).toMatch(/§ Risks 2\/3/);
    // Ctrl-o returns to where each jump started.
    type(h, "\x0f");
    expect(screen(h)).toMatch(/§ Risks 3\/3/);
    type(h, "\x0f", "\x0f");
    expect(readerRows(h)[0]).toContain("Plan");
    type(h, "?");
    h.terminal.rows = 200;
    const help = screen(h).split("\n");
    expect(help.find(l => /^\s+}\s/.test(l))).not.toContain("(later)");
    expect(help.find(l => /^\s+{\s/.test(l))).not.toContain("(later)");
    h.terminal.rows = 40;
    type(h, "q", ";", "i");
    await settle();
    type(h, "}");
    expect(h.session.status?.text).toMatch(/\{ and \} step through the headings/);
  });

  test("with the document focused, / searches it and the hint and prompt say so; Enter lists its links", async () => {
    const h = await started({
      tasks: [task(1, { title: "one", body: "see @2 about the needle" }), task(2, { title: "two", body: "needle" })],
      initialTask: 1,
    });
    type(h, "\t");
    expect(plain(h.shell.frame()).at(-1)).toContain("/ searches the document");
    type(h, "/");
    expect(plain(h.shell.frame()).at(-2)).toContain("Enter searches the document");
    type(h, ..."needle", "\r");
    await settle();
    expect(h.session.query).toBe("");
    expect(screen(h)).toMatch(/\/needle 1\/1/);
    type(h, "\r");
    await settle();
    expect(h.session.dialog?.label).toBe("links");
    type(h, "\r");
    await settle();
    expect(h.session.selectedId).toBe(2);
  });

  test("a click on a reference in the reader follows it; elsewhere it focuses the document", async () => {
    const h = await started({
      tasks: [task(1, { title: "one", body: "go to @2 now" }), task(2, { title: "two" })],
      initialTask: 1,
    });
    const lines = plain(h.shell.frame());
    const y = lines.findIndex(l => l.includes("go to @2"));
    const x = (lines[y] ?? "").lastIndexOf("@2"); // the document's, right of the list
    const click = (cx: number, cy: number) =>
      ({
        type: "click",
        button: "left",
        x: cx,
        y: cy,
        screenX: cx,
        screenY: cy,
        width: 120,
        height: 40,
        shift: false,
        alt: false,
        ctrl: false,
      }) as never;
    expect(h.shell.handleMouse(click(x + 2, y + 5))).toEqual({ handled: true });
    expect(h.session.selectedId).toBe(1);
    expect(h.session.focus).toBe("document");
    expect(h.shell.handleMouse(click(x, y))).toEqual({ handled: true });
    expect(h.session.selectedId).toBe(2);
  });

  test("the wheel scrolls the pane under the pointer and a click selects a task row", async () => {
    const h = await started();
    h.shell.frame();
    const event = (over: Record<string, unknown>) =>
      ({
        button: "none",
        screenX: 0,
        screenY: 0,
        width: 120,
        height: 40,
        shift: false,
        alt: false,
        ctrl: false,
        ...over,
      }) as never;
    // Row 0 is the list header, row 1 the order, row 2 the filter line, row 3 the (comfortable) spacer,
    // then 1 Fix, 2 Hold, 3 Draft, 4 Wait (each title fits on its row).
    expect(h.shell.handleMouse(event({ type: "wheel", x: 5, y: 4, wheelDelta: 1 }))).toEqual({ handled: true });
    expect(h.session.selectedId).toBe(2);
    h.shell.handleMouse(event({ type: "click", button: "left", x: 5, y: 6 }));
    expect(h.session.selectedId).toBe(3);
    expect(h.session.focus).toBe("tasks");
    h.shell.handleMouse(event({ type: "click", button: "left", x: 80, y: 6 }));
    expect(h.session.focus).toBe("document");
  });

  test("a click on a header tag label appends it to the tag filter (keyboard: :filter tags +name)", async () => {
    const h = await started({ tasks: [task(1, { title: "tagged", tags: ["docs", "ui"] })] });
    const lines = plain(h.shell.frame());
    const row = lines.findIndex(l => l.includes("#docs"));
    const x = (lines[row] ?? "").indexOf("#ui");
    const event = (over: Record<string, unknown>) =>
      ({
        button: "left",
        screenX: 0,
        screenY: 0,
        width: 120,
        height: 40,
        shift: false,
        alt: false,
        ctrl: false,
        ...over,
      }) as never;
    h.shell.handleMouse(event({ type: "click", x, y: row }));
    expect(h.session.filter.tags).toEqual(["ui"]);
    h.shell.handleMouse(event({ type: "click", x: (lines[row] ?? "").indexOf("#docs") + 2, y: row }));
    expect(h.session.filter.tags).toEqual(["ui", "docs"]);
    expect(screen(h)).toContain("#ui #docs");
  });
});

describe("dialogs in the shell (Task 8 part B: N17/N19)", () => {
  const statePath = () => path.join(dir, "tui", "default.state.json");

  test("a dialog is a toolkit overlay that owns the keyboard and hands it back when it closes", async () => {
    const h = await started();
    h.session.setFocus("document");
    type(h, ":", ..."lanes", "\r");
    await settle();
    const dialog = h.session.dialog;
    expect(dialog).toBeInstanceOf(Dialog);
    expect(h.shell.tui.getFocusedComponent()).toBe(dialog as unknown as Dialog);
    // The status line names it; the hint line shows its keys (never a function key).
    expect(plain(h.shell.frame()).at(-2)).toContain("│ lanes │");
    expect(plain(h.shell.frame()).at(-1)).toMatch(/Enter edit/);
    expect(plain(h.shell.frame()).at(-1)).not.toMatch(/\bF(?:[1-9]|1[0-9]|2[0-9]|3[0-5])\b/);
    // Keys arrive through the toolkit's focus routing: the dialog gets them, the list does not move.
    h.terminal.reply("j");
    expect(h.session.selectedTask()?.id).toBe(1);
    h.terminal.reply("q");
    expect(h.session.dialog).toBeNull();
    expect(h.shell.tui.getFocusedComponent()).not.toBeInstanceOf(Dialog);
    expect(h.shell.tui.getFocusedComponent()).not.toBeNull();
    expect(h.session.focus).toBe("document");
    h.terminal.reply("\x1b[Z");
    expect(h.session.focus).toBe("tasks");
  });

  test("the mouse never reaches the workspace under an open dialog", async () => {
    const h = await started();
    h.shell.frame();
    type(h, ":", ..."tags", "\r");
    await settle();
    const click = {
      type: "click",
      button: "left",
      x: 5,
      y: 2,
      screenX: 5,
      screenY: 2,
      width: 120,
      height: 40,
      shift: false,
      alt: false,
      ctrl: false,
    } as never;
    expect(h.shell.handleMouse(click)).toEqual({ handled: true });
    expect(h.session.selectedTask()?.id).toBe(1);
  });

  test(";t (the leader tags key) opens the current task's tag picker; help lists it as available", async () => {
    const h = await started();
    type(h, ";", "t");
    expect(h.session.dialog?.label).toBe("task tags");
    type(h, "q");
    type(h, "?");
    h.terminal.rows = 200;
    const help = screen(h);
    const line = help.split("\n").find(l => l.includes(";t")) ?? "";
    expect(line).toContain("Edit this task's tags");
    expect(line).not.toContain("(later)");
  });

  test(";d (the leader done key) shows or hides the done tasks, says which, and the list header shows +done", async () => {
    const h = await started({ tasks: [...TASKS, task(5, { title: "Shipped last week", status: "done" })] });
    expect(screen(h)).not.toContain("Shipped last week");
    type(h, ";", "d");
    expect(h.session.includeDone).toBe(true);
    // For this session only: tui.toml's `done` sets how a workspace starts, and ;d never writes it.
    h.session.savePreferences();
    expect(fs.existsSync(tomlPath())).toBe(false);
    let text = screen(h);
    expect(text).toContain("Shipped last week");
    expect(text).toContain("+done");
    expect(h.session.status?.text).toBe("Showing done tasks (;d hides them)");
    type(h, ";", "d");
    expect(h.session.includeDone).toBe(false);
    text = screen(h);
    expect(text).not.toContain("Shipped last week");
    expect(text).not.toContain("+done");
    expect(h.session.status?.text).toBe("Hiding done tasks (;d shows them)");
    // A done status filter shows them whatever include-done says: the message says so.
    h.session.setFilter({ status: "done", lane: null, tags: [] });
    type(h, ";", "d", ";", "d");
    expect(h.session.status?.text).toBe("Hiding done tasks (;d shows them); the done status filter still lists them");
    type(h, "?");
    h.terminal.rows = 400;
    const line =
      screen(h)
        .split("\n")
        .find(l => l.includes(";d ")) ?? "";
    expect(line).toContain("Show or hide the done tasks");
    expect(line).not.toContain("(later)");
  });

  test(";m (the leader status key) opens the status picker for the selected task; a letter sets it and closes it", async () => {
    const h = await started();
    h.session.select(2);
    type(h, ";", "m");
    expect(h.session.dialog?.label).toBe("status");
    expect(plain((h.session.dialog as unknown as Dialog).render(80)).join("\n")).toContain("STATUS OF @2");
    type(h, "o");
    for (let i = 0; i < 5; i++) await settle();
    expect(h.session.dialog).toBeNull();
    expect(h.writes).toEqual([{ id: 2, request: { status: "open" } }]);
    expect(h.session.status?.text).toBe("@2: Blocked \u2192 Open");
    type(h, "?");
    h.terminal.rows = 400;
    const line =
      screen(h)
        .split("\n")
        .find(l => l.includes(";m ")) ?? "";
    expect(line).toContain("Set this task's status in a picker");
    expect(line).not.toContain("(later)");
  });

  test(";o (the leader sort key) opens the sort and group picker; help lists it as available", async () => {
    const h = await started();
    type(h, ";", "o");
    expect(h.session.dialog?.label).toBe("sort");
    expect(plain((h.session.dialog as unknown as Dialog).render(80)).join("\n")).toContain("SORT AND GROUP");
    type(h, "j", "\r");
    expect(h.session.sort).toBe("-id");
    expect(h.session.dialog).toBeNull();
    expect(screen(h)).toContain("sort -id");
    type(h, "?");
    h.terminal.rows = 200;
    const line =
      screen(h)
        .split("\n")
        .find(l => l.includes(";o")) ?? "";
    expect(line).toContain("Sort and group the task list");
    expect(line).not.toContain("(later)");
  });

  test("f opens the filter picker (the list follows each toggle), F clears every filter; the hints and help name them", async () => {
    const h = await started();
    expect(screen(h)).toContain("no filters · f picks · / search");
    expect(plain(h.shell.frame()).at(-1)).toContain("f filters");
    type(h, "f");
    expect(h.session.dialog?.label).toBe("filters");
    expect(plain(h.shell.frame()).at(-1)).toMatch(/Space toggles.*Enter\/Esc close \(the filters stay\)/);
    type(h, "b");
    expect(h.session.filter.status).toBe("blocked");
    expect(screen(h)).toContain("1 shown");
    expect(screen(h)).toContain("status:blocked");
    type(h, "\r");
    expect(h.session.dialog).toBeNull();
    expect(screen(h)).toContain("status:blocked");
    type(h, "F");
    expect(h.session.filter.status).toBeNull();
    expect(screen(h)).toContain("4 shown");
    type(h, "?");
    h.terminal.rows = 200;
    const help = screen(h).split("\n");
    const f = help.find(l => /^\s*f\s/.test(l)) ?? "";
    expect(f).toContain("Pick filters");
    expect(help.find(l => /^\s*F\s/.test(l)) ?? "").toContain("Clear the search and every filter");
  });

  test("the status line shows a write in flight", async () => {
    const h = await started();
    let release = (): void => {};
    const write = h.session.mutate(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );
    await settle();
    expect(plain(h.shell.frame()).at(-2)).toContain("saving");
    release();
    await write;
    expect(plain(h.shell.frame()).at(-2)).toContain("✓ saved");
  });

  test(":theme previews live, Esc restores, Enter applies and SAVES to tui.toml; :theme auto removes it and every override", async () => {
    const h = await started({ env: { TERM: "xterm-256color", COLORTERM: "truecolor" }, budgetMs: 10 });
    expect(h.shell.theme?.name).toBe("cortex-dark");
    type(h, ":", ..."theme", "\r");
    await settle();
    expect(h.session.dialog?.label).toBe("theme");
    type(h, "j", "j"); // auto -> cortex-dark -> cortex-light
    expect(h.shell.theme?.name).toBe("cortex-light");
    expect(h.session.theme?.name).toBe("cortex-light");
    expect(h.shell.frame().join("")).toContain("48;2;246;242;236");
    type(h, "\x1b");
    expect(h.shell.theme?.name).toBe("cortex-dark");
    expect(h.shell.theme?.source).toBe("default");
    expect(fs.existsSync(tomlPath())).toBe(false);
    expect(fs.existsSync(statePath())).toBe(false);
    type(h, ":", ..."theme", "\r");
    await settle();
    type(h, "j", "j", "\r");
    expect(h.session.dialog).toBeNull();
    expect(h.shell.theme).toMatchObject({ name: "cortex-light", source: "session", explicit: true });
    expect(loadConfig(tomlPath()).config.theme).toBe("cortex-light");
    if (fs.existsSync(statePath()))
      expect(JSON.parse(fs.readFileSync(statePath(), "utf8")).view).not.toHaveProperty("theme");
    expect(h.session.status?.text).toMatch(/cortex-light.*:theme.*saved/);
    type(h, ":", ..."theme auto", "\r");
    await settle();
    expect(h.shell.theme).toMatchObject({ name: "cortex-dark", source: "default", explicit: false });
    expect(fs.readFileSync(tomlPath(), "utf8")).not.toMatch(/theme/);
  });

  test(":theme auto drops --theme too (for this session) and removes a tui.toml pin", async () => {
    const h = await started({
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      cliTheme: "high-contrast-light",
    });
    expect(h.shell.theme?.source).toBe("cli");
    type(h, ":", ..."theme auto", "\r");
    await settle();
    expect(h.shell.theme?.source).toBe("default");
    fs.writeFileSync(tomlPath(), '# mine\ntheme = "high-contrast-dark"\n');
    const pinned = await started({
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      config: loadConfig(tomlPath()).config,
    });
    expect(pinned.shell.theme).toMatchObject({ name: "high-contrast-dark", source: "config" });
    type(pinned, ":", ..."theme auto", "\r");
    await settle();
    expect(pinned.shell.theme).toMatchObject({ source: "default", explicit: false });
    expect(fs.readFileSync(tomlPath(), "utf8")).toBe("# mine\n");
  });
});

describe("the document editor in the shell (Task 9: N14/N17-N19)", () => {
  const statePath = () => path.join(dir, "tui", "default.state.json");
  const markers = (lines: string[]) => lines.join("\n").split(CURSOR_MARKER).length - 1;

  test(";i ;s ;r switch Edit/Split/Read and save the preference; i from Read shows Edit without changing it", async () => {
    const h = await started();
    type(h, ";", "i");
    await settle();
    expect(h.session.preferredMode).toBe("edit");
    expect(screen(h)).toContain("EDIT");
    expect(screen(h)).toMatch(/1 # Plan/);
    type(h, ";", "s");
    await settle();
    expect(h.session.preferredMode).toBe("split");
    expect(screen(h)).toContain("PREVIEW");
    type(h, ";", "r");
    await settle();
    expect(h.session.preferredMode).toBe("read");
    expect(screen(h)).toContain("READ");
    h.session.savePreferences();
    expect(readPreferences(statePath()).preferences.view.mode).toBe("read");
    type(h, "\t", "i");
    await settle();
    expect(h.session.keys.mode()).toBe("INSERT");
    expect(h.session.documentMode()).toBe("edit");
    expect(h.session.preferredMode).toBe("read");
    expect(plain(h.shell.frame()).at(-2)).toContain("INSERT");
  });

  test("INSERT edits the draft (the status line says unsaved); Esc returns to NORMAL without a write", async () => {
    const h = await started();
    type(h, ";", "i", "\t", "i");
    await settle();
    type(h, ..."Hi ");
    expect(h.session.documentOf(1)?.draft?.text("body")).toBe("Hi # Plan\n\nStep one\nStep two");
    expect(screen(h)).toContain("Hi # Plan");
    expect(plain(h.shell.frame()).at(-2)).toContain("● unsaved");
    type(h, "\x1b");
    expect(h.session.keys.mode()).toBe("NORMAL");
    expect(h.writes).toEqual([]);
    type(h, ":", "w", "\r");
    await settle();
    await settle();
    expect(h.writes).toEqual([{ id: 1, request: { body: "Hi # Plan\n\nStep one\nStep two" } }]);
  });

  test("the status line never says saved over keys typed before the document loaded: unsaved while it loads, not loaded after a failure (C4)", async () => {
    const baseline: { release: () => void; failure: Error | null } = { release: () => {}, failure: null };
    const h = await started({
      taskState: async (_id, read) => {
        await new Promise<void>(resolve => {
          baseline.release = resolve;
        });
        if (baseline.failure !== null) throw baseline.failure;
        return read();
      },
    });
    const status = () => plain(h.shell.frame()).at(-2) ?? "";
    type(h, "\t", "i", ..."ab"); // from Read, i types before the baseline arrived
    expect(h.session.documentOf(1)?.draft).toBeNull();
    expect(status()).toContain("● unsaved");
    expect(status()).not.toContain("✓ saved");
    baseline.failure = new Error("disk I/O error");
    baseline.release();
    await settle();
    expect(h.session.documentOf(1)?.error).toBe("disk I/O error");
    expect(status()).toContain("✗ not loaded · :w retries");
    expect(status()).not.toContain("save failed"); // nothing was saved or sent: the load failed
    expect(status()).not.toContain("\u2713 saved");
    // :w loads it again, applies the kept keys and saves them.
    baseline.failure = null;
    type(h, ":", "w", "\r");
    expect(status()).toContain("● unsaved");
    baseline.release();
    for (let i = 0; i < 4; i++) await settle();
    expect(h.writes).toEqual([{ id: 1, request: { body: "ab# Plan\n\nStep one\nStep two" } }]);
    expect(status()).toContain("✓ saved");
  });

  test("u and Ctrl-r act on the focused, visible editor only; elsewhere they explain", async () => {
    const h = await started();
    type(h, "u");
    expect(h.session.status?.text).toMatch(/only in a visible editor/);
    type(h, ";", "i", "\t", "i", ..."xy", "\x1b");
    await settle();
    type(h, "u");
    expect(h.session.documentOf(1)?.draft?.text("body")).toBe("# Plan\n\nStep one\nStep two");
    type(h, "\x12");
    expect(h.session.documentOf(1)?.draft?.text("body")).toBe("xy# Plan\n\nStep one\nStep two");
    type(h, "\x1b[Z", "u");
    expect(h.session.status?.text).toMatch(/only in a visible editor/);
  });

  test("at 80x24 Split shows the focused half; Tab switches halves; the saved preference stays Split", async () => {
    const h = await started({ columns: MIN_COLUMNS, rows: MIN_ROWS });
    type(h, ":", ..."split", "\r");
    await settle();
    type(h, "\t");
    let text = screen(h);
    expect(text).toContain("SPLIT · editor");
    expect(text).toMatch(/1 # Plan/);
    expect(text).not.toContain("PREVIEW");
    type(h, "\t");
    text = screen(h);
    expect(text).toContain("SPLIT · preview");
    expect(text).not.toMatch(/1 # Plan/);
    expect(text).toContain("Step two");
    type(h, "\t");
    expect(h.session.focus).toBe("tasks");
    expect(h.session.preferredMode).toBe("split");
    h.terminal.columns = 120;
    h.terminal.rows = 40;
    expect(screen(h)).toContain("PREVIEW");
  });

  test("Split's preview follows the editor's cursor; scrolling the preview detaches it until the cursor moves", async () => {
    // The preview renders `**Para n** end` as `Para n end`; the editor shows the asterisks.
    const paras = Array.from({ length: 60 }, (_, i) => `**Para ${i + 1}** end`);
    const body = [...paras.slice(0, 40), "## Tail", ...paras.slice(40)].join("\n\n");
    const h = await started({ columns: 160, rows: 40, tasks: [task(1, { title: "Long", body })], initialTask: 1 });
    type(h, ";", "s");
    await settle();
    type(h, "\t");
    expect(h.session.splitHalf).toBe("editor");
    expect(screen(h)).toContain("Para 1 end");
    expect(screen(h)).not.toContain("Para 60 end");
    type(h, "G"); // the editor's cursor to the end: the preview shows the end beside it
    const after = screen(h);
    expect(after).toContain("Para 60 end");
    expect(after).not.toContain("Para 1 end");
    // The PREVIEW divider names the section it shows in this same frame.
    expect(after.split("\n").find(l => l.includes(" PREVIEW "))).toContain("§ Tail 1/1");
    // Beside the cursor row: the preview row of the cursor's paragraph is the editor's cursor row.
    const lines = h.shell.frame();
    const cursorRow = lines.findIndex(l => l.includes(CURSOR_MARKER));
    expect(plain([lines[cursorRow] ?? ""])[0]).toMatch(/\*\*Para 60\*\* end.*Para 60 end/);
    type(h, "g", "g");
    expect(screen(h)).toContain("Para 1 end");
    // Scrolling the preview (focused) detaches it: it stays put while the cursor does not move.
    type(h, "\t");
    expect(h.session.splitHalf).toBe("preview");
    for (let i = 0; i < 30; i++) type(h, "j");
    expect(screen(h)).not.toContain("Para 1 end");
    type(h, "\x1b[Z"); // Shift-Tab: back to the editor, whose cursor has not moved
    expect(h.session.splitHalf).toBe("editor");
    expect(screen(h)).not.toContain("Para 1 end");
    type(h, "j"); // the cursor moves: following again
    expect(screen(h)).toContain("Para 1 end");
  });

  test("exactly one cursor marker per frame: the editor cursor while it has focus, the `:` line while it is open", async () => {
    const h = await started();
    type(h, ";", "i");
    await settle();
    expect(markers(h.shell.frame())).toBe(0); // the list has focus
    type(h, "\t");
    const lines = h.shell.frame();
    expect(markers(lines)).toBe(1);
    const row = lines.findIndex(l => l.includes(CURSOR_MARKER));
    expect(plain([lines[row] ?? ""])[0]).toMatch(/1 # Plan/);
    type(h, ":");
    const withPrompt = h.shell.frame();
    expect(markers(withPrompt)).toBe(1);
    expect(withPrompt.at(-1)).toContain(CURSOR_MARKER);
  });

  test("k at the top of the body moves the document cursor to the title (shown in full); i edits it in place, Enter saves", async () => {
    const h = await started();
    type(h, "\t", "k");
    expect(h.session.documentTarget).toBe("title");
    expect(screen(h)).toMatch(/▌Fix the login flow/);
    type(h, "i");
    await settle();
    expect(h.session.titleEdit?.line.text).toBe("Fix the login flow");
    expect(markers(h.shell.frame())).toBe(1);
    type(h, ..." now", "\r");
    await settle();
    await settle();
    expect(h.session.keys.mode()).toBe("NORMAL");
    expect(h.writes).toEqual([{ id: 1, request: { title: "Fix the login flow now" } }]);
    expect(h.session.preferredMode).toBe("read");
    type(h, "j");
    expect(h.session.documentTarget).toBe("body");
  });

  test("Home/End/PageUp/PageDown act on the focused pane: the editor cursor, otherwise the list", async () => {
    const h = await started();
    type(h, "\x1b[F");
    expect(h.session.selectedId).toBe(4);
    type(h, "\x1b[H");
    expect(h.session.selectedId).toBe(1);
    type(h, ";", "i");
    await settle();
    h.session.select(1);
    await settle();
    type(h, "\t");
    h.shell.frame();
    const editor = h.session.documentOf(1)?.editor;
    type(h, "\x1b[F");
    expect(editor?.getState().selection.main.head).toBe(6); // end of "# Plan"
    type(h, "\x1b[H");
    expect(editor?.getState().selection.main.head).toBe(0);
    type(h, "\x1b[6~");
    expect(editor?.getState().doc.lineAt(editor.getState().selection.main.head).number).toBe(4);
    expect(h.session.selectedId).toBe(1);
  });
});

describe("the task panels and the update composer in the shell (Task 11: P7, N17, N19)", () => {
  const note = (
    id: number,
    taskId: number,
    summary: string,
    minutesAgo: number,
    over: Partial<Update> = {},
  ): Update => ({
    id,
    task_id: taskId,
    author: "agent-7",
    summary,
    body: null,
    severity: "progress",
    created: Date.now() - minutesAgo * 60_000,
    ...over,
  });

  test("] and [ step Document, Activity, Related and Authors in the document pane; the Read/Edit/Split preference stays", async () => {
    const h = await started({ updates: { 1: [note(1, 1, "older note", 10), note(2, 1, "newer note", 2)] } });
    type(h, "]");
    await settle();
    let text = screen(h);
    expect(h.session.panel).toBe("activity");
    expect(text).toContain("ACTIVITY · 2 · newest first");
    expect(text.indexOf("newer note")).toBeGreaterThan(0);
    expect(text.indexOf("newer note")).toBeLessThan(text.indexOf("older note"));
    expect(text).not.toContain(" READ ");
    type(h, "]");
    await settle();
    expect(screen(h)).toContain("REFERENCED BY · 0");
    type(h, "]");
    await settle();
    text = screen(h);
    expect(text).toContain("AUTHORS · 1");
    expect(text).toMatch(/agent-7\s+2m ago\s+2/);
    type(h, "]");
    expect(h.session.panel).toBe("document");
    expect(screen(h)).toContain(" READ ");
    type(h, "[");
    expect(h.session.panel).toBe("authors");
    expect(h.session.preferredMode).toBe("read");
  });

  test("with the document focused, j/k move the cards and Enter expands one; u and / never act on a hidden document", async () => {
    const h = await started({
      updates: { 1: [note(1, 1, "first", 10, { body: "## Heading\n\ntext body" }), note(2, 1, "second", 2)] },
    });
    type(h, "\t", "]");
    await settle();
    type(h, "j", "\r");
    expect(screen(h)).toContain("text body");
    expect(h.session.selectedTask()?.id).toBe(1);
    type(h, "u");
    expect(h.session.status?.text).toContain("Undo and redo act only in a visible editor");
    type(h, "/", ..."Wait", "\r");
    expect(h.session.query).toBe("Wait");
  });

  test("after :title and Esc (saved, NORMAL), Enter in Activity expands the update instead of reopening the title editor", async () => {
    const h = await started({
      updates: { 1: [note(1, 1, "older note", 10), note(2, 1, "newest note", 2, { body: "the update body" })] },
    });
    type(h, ":", ..."title", "\r");
    await settle();
    expect(h.session.titleEdit?.taskId).toBe(1);
    type(h, ..." now", "\x1b");
    await settle();
    await settle();
    expect(h.session.keys.mode()).toBe("NORMAL");
    expect(h.session.titleEdit).toBeNull();
    expect(h.writes).toEqual([{ id: 1, request: { title: "Fix the login flow now" } }]);
    type(h, "]");
    await settle();
    expect(h.session.panel).toBe("activity");
    expect(screen(h)).not.toContain("the update body");
    type(h, "\r");
    await settle();
    expect(h.session.keys.mode()).toBe("NORMAL");
    expect(h.session.titleEdit).toBeNull();
    expect(screen(h)).toContain("the update body");
    expect(h.writes.length).toBe(1);
    expect(h.session.preferredMode).toBe("read");
  });

  test("a panel's Enter is always the panel's: neither the title cursor (k) nor :title from the panel captures it", async () => {
    const h = await started({
      updates: { 1: [note(1, 1, "older note", 10), note(2, 1, "newest note", 2, { body: "the update body" })] },
    });
    // The document cursor on the title (k at the top of the body), then a panel: the panel owns the cursor.
    type(h, "\t", "k");
    expect(h.session.documentTarget).toBe("title");
    type(h, ":", ..."activity", "\r");
    await settle();
    expect(h.session.panel).toBe("activity");
    type(h, "\r");
    await settle();
    expect(h.session.keys.mode()).toBe("NORMAL");
    expect(h.session.titleEdit).toBeNull();
    expect(h.session.documentTarget).toBe("body");
    expect(screen(h)).toContain("the update body");
    expect(screen(h)).not.toMatch(/▌Fix the login flow/);
    // :title from the panel edits the title in place; after Esc, Enter is the panel's again (it collapses the card).
    type(h, ":", ..."title", "\r");
    await settle();
    expect(h.session.titleEdit?.taskId).toBe(1);
    expect(h.session.panel).toBe("activity");
    type(h, "\x1b");
    await settle();
    expect(h.session.keys.mode()).toBe("NORMAL");
    type(h, "\r");
    await settle();
    expect(h.session.keys.mode()).toBe("NORMAL");
    expect(h.session.titleEdit).toBeNull();
    expect(screen(h)).not.toContain("the update body");
    expect(h.session.preferredMode).toBe("read");
  });

  test("c opens the composer; :q keeps the draft, marked in the document header and on the status line; ;c and Ctrl-s post it", async () => {
    const h = await started();
    type(h, "c");
    expect(h.session.dialog?.label).toBe("post update");
    expect(h.session.keys.mode()).toBe("INSERT");
    type(h, ..."shell note", "\x1b", ":", "q", "\r");
    await settle();
    expect(h.session.dialog).toBeNull();
    let text = screen(h);
    expect(text).toContain("✎ Unsent update (10/4096)");
    expect(text).toContain("✎ 1 unsent");
    type(h, ";", "c");
    expect(h.session.dialog?.label).toBe("post update");
    type(h, "\x13");
    await settle();
    await settle();
    expect(h.posts).toEqual([{ id: 1, request: { author: "tester", summary: "shell note" } }]);
    text = screen(h);
    expect(text).not.toContain("Unsent update");
    expect(text).not.toContain("unsent");
    expect(h.session.panel).toBe("activity");
  });

  test("at 80x24 ] shows the panel in the focused document pane and every frame fits", async () => {
    const h = await started({ columns: 80, rows: 24, updates: { 1: [note(1, 1, "narrow note", 3)] } });
    type(h, "]");
    await settle();
    expect(h.session.focus).toBe("document");
    const lines = h.shell.frame();
    expect(lines.length).toBe(24);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    expect(screen(h)).toContain("narrow note");
  });

  test("i from a panel returns to the document to type; help lists ], [ and c as available", async () => {
    const h = await started();
    type(h, "\t", "]");
    type(h, "i");
    await settle();
    expect(h.session.panel).toBe("document");
    expect(h.session.keys.mode()).toBe("INSERT");
    type(h, "\x1b");
    await settle();
    type(h, "?");
    h.terminal.rows = 200;
    const help = screen(h);
    expect(help).toContain("Next task panel");
    expect(help).toContain("Post an update");
    expect(help).not.toContain("(later)");
  });
});

describe("VISUAL and VISUAL LINE in the shell (vi v / V)", () => {
  const osc52 = (h: Harness, from: number) => h.terminal.writes.slice(from).filter(w => w.startsWith("\x1b]52;"));
  const encoded = (text: string) => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x1b\\`;
  const body = (h: Harness, id = 1) => h.session.documentOf(id)?.draft?.text("body");
  /** Edit mode with the editor focused, its cursor at the start. */
  const editing = async (options: Parameters<typeof harness>[0] = {}) => {
    const h = await started(options);
    type(h, ";", "i");
    await settle();
    type(h, "\t");
    h.shell.frame();
    return h;
  };

  test("in the editor, V j y yanks two lines with ONE OSC 52 write (unconfirmed) and the register; p pastes; u undoes", async () => {
    const h = await editing();
    type(h, "j", "j", "V");
    expect(h.session.keys.mode()).toBe("VISUAL LINE");
    expect(plain(h.shell.frame()).at(-2)).toContain(" VISUAL LINE ");
    expect(plain(h.shell.frame()).at(-1)).toMatch(/y yanks.*d deletes.*c changes.*>\/< indent.*Esc ends/);
    type(h, "j");
    const mark = h.terminal.writes.length;
    type(h, "y");
    expect(osc52(h, mark)).toEqual([encoded("Step one\nStep two\n")]);
    expect(h.session.keys.mode()).toBe("NORMAL");
    expect(h.session.status?.text).toMatch(/^Copied 2 lines \(18 bytes\) with OSC 52; unconfirmed/);
    type(h, "p");
    expect(body(h)).toBe("# Plan\n\nStep one\nStep one\nStep two\nStep two");
    type(h, "u");
    expect(body(h)).toBe("# Plan\n\nStep one\nStep two");
    expect(h.writes).toEqual([]); // nothing saved yet: drafts autosave as usual
  });

  test("v with motions and d deletes as one undo step; c deletes and starts INSERT; Esc and v end VISUAL", async () => {
    const h = await editing();
    type(h, "v", "e");
    expect(h.session.keys.mode()).toBe("VISUAL");
    expect(plain(h.shell.frame()).at(-2)).toContain(" VISUAL ");
    type(h, "d");
    expect(body(h)).toBe("\n\nStep one\nStep two");
    expect(h.session.keys.mode()).toBe("NORMAL");
    type(h, "u");
    expect(body(h)).toBe("# Plan\n\nStep one\nStep two");
    type(h, "v", "\x1b");
    expect(h.session.keys.mode()).toBe("NORMAL");
    expect(h.session.documentOf(1)?.editor?.visual()).toBeNull();
    type(h, "V", "V");
    expect(h.session.keys.mode()).toBe("NORMAL");
    type(h, "j", "j", "v", "e", "c"); // (as in vi, v then w would include the next word's first letter)
    expect(h.session.keys.mode()).toBe("INSERT");
    type(h, ..."Go");
    expect(body(h)).toBe("# Plan\n\nGo one\nStep two");
  });

  test("a prompt or another task ends VISUAL; outside a document v says where it works", async () => {
    const h = await editing();
    type(h, "v", "l", ":");
    expect(h.session.keys.mode()).toBe("COMMAND");
    type(h, "\x1b");
    h.shell.frame();
    expect(h.session.keys.mode()).toBe("NORMAL");
    expect(h.session.documentOf(1)?.editor?.visual()).toBeNull();
    type(h, "V");
    h.session.select(2);
    h.shell.frame();
    expect(h.session.keys.mode()).toBe("NORMAL");
    type(h, "\x1b[Z"); // Shift-Tab: the task list
    type(h, "v");
    expect(h.session.keys.mode()).toBe("NORMAL");
    expect(h.session.status?.text).toMatch(/VISUAL selects in the document/);
    type(h, "p");
    expect(h.session.status?.text).toMatch(/Paste acts in a visible editor/);
  });

  test("in Read, V j y copies the rendered rows as plain text; the reader never edits", async () => {
    const h = await started({ tasks: [task(1, { body: "- alpha\n- **beta** \x1b[31m\n- gamma" })] });
    type(h, "\t");
    h.shell.frame();
    type(h, "V");
    expect(h.session.keys.mode()).toBe("VISUAL LINE");
    expect(plain(h.shell.frame()).at(-1)).toMatch(/VISUAL LINE · rendered rows.*y copies/);
    type(h, "j", "d");
    expect(h.session.status?.text).toMatch(/Reading never edits/);
    const mark = h.terminal.writes.length;
    type(h, "y");
    expect(osc52(h, mark)).toEqual([encoded("• alpha\n• beta ^[[31m\n")]);
    expect(h.session.status?.text).toMatch(/^Copied 2 rendered rows .*unconfirmed/);
    expect(h.session.keys.mode()).toBe("NORMAL");
    expect(h.session.tasks[0]?.body).toBe("- alpha\n- **beta** \x1b[31m\n- gamma");
  });

  test("too large for a terminal clipboard write: said plainly, nothing is sent, and the register still pastes it", async () => {
    const big = "x".repeat(80_000);
    const h = await editing({ tasks: [task(1, { body: big })] });
    type(h, "V");
    const mark = h.terminal.writes.length;
    type(h, "y");
    expect(osc52(h, mark)).toEqual([]);
    expect(h.session.status?.level).toBe("error");
    expect(h.session.status?.text).toMatch(/too large.*80001 > 75000 bytes.*paste register/);
    type(h, "P");
    expect(body(h)).toBe(`${big}\n${big}`);
  });

  test("help lists both modes and the VISUAL keys as configured; none is (later)", async () => {
    const config: TuiConfig = { ...DEFAULT_CONFIG, keys: parseKeys({ keys: { visual: { yank: ["Y"] } } }).keys };
    const h = await started({ config });
    type(h, "?");
    h.terminal.rows = 300;
    const help = screen(h);
    for (const text of ["v  VISUAL", "V  VISUAL LINE", "KEYS · VISUAL", "0 (no count)", "Y ", "d x", ">", "<"]) {
      expect(help).toContain(text);
    }
    expect(help).toContain("Copy the selection: the terminal clipboard (OSC 52) and the paste register (p)");
    expect(help).toContain("Paste the last yank or delete after the cursor");
    expect(help).not.toContain("(later)");
  });
});

describe("the mouse, top level (N19: on by default, never the only path to an action)", () => {
  /** One SGR report through the toolkit's input path (the mouse filter, then its dispatch); cells are zero-based. */
  const report = (h: Harness, code: number, x: number, y: number, final: "M" | "m" = "M") =>
    h.terminal.reply(`\x1b[<${code};${x + 1};${y + 1}${final}`);
  const click = (h: Harness, [x, y]: readonly [number, number]) => {
    report(h, 0, x, y);
    report(h, 0, x, y, "m");
  };
  const drag = (h: Harness, from: readonly [number, number], to: readonly [number, number]) => {
    report(h, 0, from[0], from[1]);
    report(h, 32, to[0], to[1]);
    report(h, 0, to[0], to[1], "m");
  };
  const wheel = (h: Harness, [x, y]: readonly [number, number], direction: 1 | -1 = 1) =>
    report(h, direction === 1 ? 65 : 64, x, y);
  /** The `nth` place of `needle` on the current frame (rows top to bottom, then left to right), at or right of `minX`. */
  const find = (h: Harness, needle: string, nth = 0, minX = 0): [number, number] => {
    const lines = plain(h.shell.frame());
    let seen = 0;
    for (let y = 0; y < lines.length; y++) {
      let x = (lines[y] ?? "").indexOf(needle, minX);
      while (x >= 0) {
        if (seen++ === nth) return [x, y];
        x = (lines[y] ?? "").indexOf(needle, x + 1);
      }
    }
    throw new Error(`${JSON.stringify(needle)} is not on screen:\n${lines.join("\n")}`);
  };
  const osc52 = (h: Harness, from: number) => h.terminal.writes.slice(from).filter(w => w.startsWith("\x1b]52;"));
  const encoded = (text: string) => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x1b\\`;
  /** The toolkit renders now: its dispatch (and a dialog's bounds) follow the last frame it drew. */
  const rendered = async (h: Harness) => {
    h.shell.requestRender(true);
    await settle();
  };
  /** Started, rendered once by the toolkit (its dispatch needs a layout), the frame current. */
  const ready = async (options: Parameters<typeof harness>[0] = {}) => {
    const h = await started(options);
    await settle();
    h.shell.frame();
    return h;
  };
  const DOC = [task(1, { title: "Mouse doc", body: "# Plan\n\nalpha beta gamma\ndelta epsilon" }), task(2), task(3)];

  test("a click focuses the pane under it: the list, the document, Split's editor or preview half, a panel", async () => {
    const h = await ready({ tasks: DOC });
    click(h, find(h, "alpha"));
    expect(h.session.focus).toBe("document");
    click(h, [3, 20]); // the list, below its rows
    expect(h.session.focus).toBe("tasks");
    expect(h.session.selectedTask()?.id).toBe(1);
    type(h, ";", "s");
    await settle();
    const editorHalf = find(h, "alpha");
    const previewHalf = find(h, "alpha", 1);
    expect(previewHalf[0]).toBeGreaterThan(editorHalf[0]);
    click(h, previewHalf);
    expect([h.session.focus, h.session.splitHalf]).toEqual(["document", "preview"]);
    click(h, [editorHalf[0], editorHalf[1] + 3]);
    expect([h.session.focus, h.session.splitHalf]).toEqual(["document", "editor"]);
    type(h, ":", ..."activity", "\r");
    await settle();
    click(h, [3, 20]);
    expect(h.session.focus).toBe("tasks");
    click(h, [80, 12]); // inside the Activity panel
    expect(h.session.focus).toBe("document");
    expect(h.session.panel).toBe("activity");
  });

  test("the header's view tabs switch like :read/:edit/:split/:activity/:related/:authors; only Read/Edit/Split save the preference", async () => {
    const h = await ready({ tasks: DOC });
    const header = plain(h.shell.frame())[0] ?? "";
    expect(header).toMatch(/Read ;r {2}Edit ;i {2}Split ;s {2}│ {2}Activity {2}Related {2}Authors/);
    // The active tab is bold and inverse (never color alone).
    expect(h.shell.frame()[0]).toMatch(/\x1b\[[0-9;]*7[0-9;]*m Read ;r /);
    click(h, find(h, "Edit ;i"));
    await settle();
    expect([h.session.documentMode(), h.session.preferredMode]).toEqual(["edit", "edit"]);
    expect(h.shell.frame()[0]).toMatch(/\x1b\[[0-9;]*7[0-9;]*m Edit ;i /);
    for (const [label, panel] of [
      ["Activity", "activity"],
      ["Related", "related"],
      ["Authors", "authors"],
    ] as const) {
      click(h, find(h, label));
      await settle();
      expect(h.session.panel).toBe(panel);
      expect(h.session.preferredMode).toBe("edit"); // a panel never changes the saved mode
    }
    click(h, find(h, "Split ;s"));
    await settle();
    expect([h.session.panel, h.session.documentMode(), h.session.preferredMode]).toEqual([
      "document",
      "split",
      "split",
    ]);
    click(h, find(h, "Read ;r"));
    await settle();
    expect([h.session.documentMode(), h.session.preferredMode]).toEqual(["read", "read"]);
  });

  test("the tab bar shares the header row with the metadata and abbreviates to fit at 80 columns", async () => {
    const tagged = [task(1, { title: "Tagged", body: "text", tags: ["docs", "frontend", "backlog"], priority: 1 })];
    const h = await ready({ tasks: tagged, columns: 80, rows: 24 });
    type(h, "\t");
    const header = plain(h.shell.frame())[0] ?? "";
    expect(header).toContain("@1");
    expect(header).toContain("#docs #frontend #backlog");
    expect(header).toMatch(/Rd {2}Ed {2}Sp {2}│ {2}Act {2}Rel {2}Au/);
    expect(visibleWidth(h.shell.frame()[0] ?? "")).toBeLessThanOrEqual(80);
    click(h, find(h, "Act"));
    await settle();
    expect(h.session.panel).toBe("activity");
    click(h, find(h, "Ed"));
    await settle();
    expect(h.session.preferredMode).toBe("edit");
  });

  test("a list row click selects it; a click on the selected row (or a double click) opens its document", async () => {
    const h = await ready();
    click(h, find(h, "@3"));
    expect([h.session.selectedId, h.session.focus]).toEqual([3, "tasks"]);
    click(h, find(h, "@3"));
    expect([h.session.selectedId, h.session.focus]).toEqual([3, "document"]);
    click(h, find(h, "@2 "));
    expect([h.session.selectedId, h.session.focus]).toEqual([2, "tasks"]);
    // A double click on another row: the first click selects it, the second opens it.
    const four = find(h, "@4");
    click(h, four);
    click(h, four);
    expect([h.session.selectedId, h.session.focus]).toEqual([4, "document"]);
  });

  test("a click on any line of the expanded selected row opens its document; the spacer rows only focus", async () => {
    const long = "Handover: fix PR-review round 2 (F9\u2013F19) on the TUI-first branch (plan @400)";
    const h = await ready({ tasks: [task(1, { title: long }), task(2, { title: "second" })] });
    // 39 columns: 7 for the marker, glyph and id column, 1 of padding: the title wraps at 31 cells, in 3 lines.
    const lines = plain(h.shell.frame());
    expect(lines.slice(4, 8).map(l => l.slice(0, 39).trimEnd())).toEqual([
      "\u258c\u25cf @1  Handover: fix PR-review round 2",
      "\u258c      (F9\u2013F19) on the TUI-first",
      `\u258c      branch (plan @400)${" ".repeat(31 - 18 - 3)}now`,
      ` \u25cf @2  second${" ".repeat(31 - 6 - 3)}now`, // the lane ends at the padding cell
    ]);
    for (const y of [4, 5, 6]) {
      h.session.setFocus("tasks");
      click(h, [20, y]);
      expect([h.session.selectedTask()?.id, h.session.focus], `row ${y}`).toEqual([1, "document"]);
    }
    click(h, [20, 3]); // the list's spacer row: the list gets the focus, the selection stays
    expect([h.session.selectedTask()?.id, h.session.focus]).toEqual([1, "tasks"]);
    click(h, [20, 7]); // the row below the block
    expect([h.session.selectedId, h.session.focus]).toEqual([2, "tasks"]);
    click(h, [60, 2]); // the document's spacer row (above its divider): the document, like its header
    expect(h.session.focus).toBe("document");
  });

  test("the list header's chips open the f picker and its sort label the ;o picker; the unread count opens :notifications", async () => {
    const h = await ready();
    click(h, find(h, "no filters"));
    await settle();
    expect(h.session.dialog?.label).toBe("filters");
    type(h, "\x1b");
    expect(h.session.dialog).toBeNull();
    click(h, find(h, "sort id"));
    await settle();
    expect(h.session.dialog?.label).toBe("sort");
    type(h, "\x1b");
    h.session.notify("error", "something failed"); // a local, unread notification
    h.shell.frame();
    click(h, find(h, "1 unread"));
    await settle();
    expect(h.session.dialog?.label).toBe("notifications");
  });

  test("the wheel scrolls the pane under the pointer, never the focused one", async () => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n\n");
    const h = await ready({ tasks: [task(1, { title: "long", body: long }), task(2), task(3), task(4)] });
    h.session.setFocus("tasks");
    wheel(h, find(h, "line 0"));
    expect(h.session.selectedTask()?.id).toBe(1); // the list did not move
    expect(h.session.docScroll(1)).toBeGreaterThan(0);
    h.session.setFocus("document");
    wheel(h, find(h, "@3"));
    expect(h.session.selectedTask()?.id).toBe(2); // the list under the pointer moved; the document had the focus
    expect(h.session.focus).toBe("document");
  });

  test("one wheel notch moves one row (the task list, :commands, a dialog), however many reports the terminal sends for it", async () => {
    // Ghostty reports one notch as mouse-scroll-multiplier (3 by default) wheel reports, more while macOS
    // speeds a fast scroll up, and a multiplexer (Herdr) forwards each one: they arrive together.
    let now = 1_000;
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n\n");
    const h = await ready({
      tasks: [task(1, { title: "long", body: long }), task(2), task(3), task(4)],
      now: () => now,
    });
    const notch = (at: readonly [number, number], direction: 1 | -1 = 1) => {
      for (let i = 0; i < 3; i++) wheel(h, at, direction);
    };
    // Scrolled text still takes every report (three rows each): the terminal chose the lines a notch.
    notch(find(h, "line 0"));
    expect(h.session.docScroll(1)).toBe(9);
    const list = find(h, "@3");
    now += WHEEL_NOTCH_MS;
    notch(list);
    expect(h.session.selectedTask()?.id).toBe(2);
    now += WHEEL_NOTCH_MS;
    notch(list);
    expect(h.session.selectedTask()?.id).toBe(3);
    notch(list, -1); // the other way is a new notch at once
    expect(h.session.selectedTask()?.id).toBe(2);
    h.session.openView("commands");
    await rendered(h);
    expect(h.session.commandsSelected).toBe(0);
    now += WHEEL_NOTCH_MS;
    notch([10, 5]);
    expect(h.session.commandsSelected).toBe(1);
    h.session.closeView();
    type(h, "f");
    await rendered(h);
    const dialog = h.session.dialog as unknown as Dialog;
    expect(dialog.label).toBe("filters");
    const keys = dialog.visibleRows().map(r => r.key);
    const before = keys.indexOf(dialog.highlighted()?.key ?? "");
    now += WHEEL_NOTCH_MS;
    notch(dialog.rowOnScreen("status:open") as [number, number]);
    expect(keys.indexOf(dialog.highlighted()?.key ?? "")).toBe(before + 1);
  });

  test("the wheel over the editor scrolls its view; the cursor stays while it is shown (review F15)", async () => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const h = await ready({ tasks: [task(1, { title: "long", body: long }), task(2)] });
    type(h, ";", "i", "\t");
    await settle();
    type(h, "5", "j"); // the cursor on "line 5", mid-screen
    const editor = h.session.documentOf(1)?.editor;
    const cursor = editor?.cursor();
    expect(cursor).toBe("line 0\nline 1\nline 2\nline 3\nline 4\n".length);
    expect(screen(h)).toContain("line 0");
    wheel(h, find(h, "line 5"));
    expect(editor?.cursor()).toBe(cursor);
    const text = screen(h);
    expect(text).not.toContain("line 0");
    expect(text).toContain("line 3");
  });

  test("in the editor: a drag makes a VISUAL selection (y yanks exactly it), and a click places the cursor in NORMAL", async () => {
    const h = await ready({ tasks: DOC });
    type(h, ";", "i");
    await settle();
    const [ax, ay] = find(h, "alpha");
    drag(h, [ax, ay], [ax + "alpha bet".length, ay]);
    expect(h.session.keys.mode()).toBe("VISUAL");
    expect([h.session.focus, h.session.documentTarget]).toEqual(["document", "body"]);
    let mark = h.terminal.writes.length;
    type(h, "y");
    expect(osc52(h, mark)).toEqual([encoded("alpha beta")]);
    expect(h.session.keys.mode()).toBe("NORMAL");
    // A click (no drag) moves the cursor there and leaves VISUAL.
    drag(h, [ax, ay], [ax + 3, ay]);
    expect(h.session.keys.mode()).toBe("VISUAL");
    const [dx, dy] = find(h, "epsilon");
    click(h, [dx, dy]);
    expect(h.session.keys.mode()).toBe("NORMAL");
    const editor = h.session.documentOf(1)?.editor;
    expect(editor?.visual()).toBeNull();
    expect(editor?.cursor()).toBe("# Plan\n\nalpha beta gamma\ndelta ".length);
    // Upward: from the press to the drag point, whichever comes first.
    mark = h.terminal.writes.length;
    drag(h, [dx + 2, dy], [ax + "alpha beta ".length, ay]);
    type(h, "y");
    expect(osc52(h, mark)).toEqual([encoded("gamma\ndelta eps")]);
  });

  test("in the editor: a double click selects a word, a triple click the line (VISUAL LINE); d and c act on it", async () => {
    const h = await ready({ tasks: DOC });
    type(h, ";", "i");
    await settle();
    const beta = find(h, "beta");
    click(h, beta);
    click(h, [beta[0] + 1, beta[1]]); // a double click needs the same cell: this is a second single click
    expect(h.session.keys.mode()).toBe("NORMAL");
    click(h, beta);
    click(h, beta);
    expect(h.session.keys.mode()).toBe("VISUAL");
    let mark = h.terminal.writes.length;
    type(h, "y");
    expect(osc52(h, mark)).toEqual([encoded("beta")]);
    const delta = find(h, "delta");
    click(h, delta);
    click(h, delta);
    click(h, delta);
    expect(h.session.keys.mode()).toBe("VISUAL LINE");
    mark = h.terminal.writes.length;
    type(h, "y");
    expect(osc52(h, mark)).toEqual([encoded("delta epsilon\n")]);
    click(h, find(h, "gamma"));
    click(h, find(h, "gamma"));
    type(h, "d");
    expect(h.session.documentOf(1)?.draft?.text("body")).toBe("# Plan\n\nalpha beta \ndelta epsilon");
  });

  test("in INSERT a click keeps typing at the new place; a drag leaves INSERT for VISUAL", async () => {
    const h = await ready({ tasks: DOC });
    type(h, ";", "i", "\t", "i");
    await settle();
    expect(h.session.keys.mode()).toBe("INSERT");
    click(h, find(h, "gamma"));
    expect(h.session.keys.mode()).toBe("INSERT");
    type(h, "X");
    expect(h.session.documentOf(1)?.draft?.text("body")).toBe("# Plan\n\nalpha beta Xgamma\ndelta epsilon");
    const [x, y] = find(h, "delta");
    drag(h, [x, y], [x + 4, y]);
    expect(h.session.keys.mode()).toBe("VISUAL");
    const mark = h.terminal.writes.length;
    type(h, "y");
    expect(osc52(h, mark)).toEqual([encoded("delta")]);
  });

  test("in INSERT a click that takes the editor away ends INSERT first: the Read tab, the problems badge, the preview half, the list (review F14)", async () => {
    const h = await ready({ tasks: DOC });
    const original = "# Plan\n\nalpha beta gamma\ndelta epsilon";
    const body = () => h.session.documentOf(1)?.draft?.text("body");
    const typing = () => {
      type(h, "i");
      expect(h.session.keys.mode()).toBe("INSERT");
    };
    type(h, ";", "i", "\t");
    await settle();
    typing();
    click(h, find(h, "Read ;r"));
    await settle();
    expect([h.session.documentMode(), h.session.keys.mode(), h.session.insertTarget]).toEqual(["read", "NORMAL", null]);
    type(h, "j"); // NORMAL: never typed into the hidden body
    expect(body()).toBe(original);
    // The status line's problems badge opens :messages over the editor.
    h.session.addProblems([{ level: "warn", text: "a tui.toml problem" }]);
    click(h, find(h, "Edit ;i"));
    await settle();
    typing();
    click(h, find(h, "1 problem"));
    expect([h.session.view, h.session.keys.mode(), h.session.insertTarget]).toEqual(["messages", "NORMAL", null]);
    type(h, "j");
    expect(body()).toBe(original);
    // Split's preview half, then the list below its rows.
    h.session.closeView();
    click(h, find(h, "Split ;s"));
    await settle();
    typing();
    click(h, find(h, "alpha", 1));
    expect([h.session.splitHalf, h.session.keys.mode(), h.session.insertTarget]).toEqual(["preview", "NORMAL", null]);
    type(h, "j");
    expect(body()).toBe(original);
    click(h, find(h, "alpha"));
    typing();
    click(h, [3, 20]);
    expect([h.session.focus, h.session.keys.mode(), h.session.insertTarget]).toEqual(["tasks", "NORMAL", null]);
    type(h, "j"); // the list's j: the next task
    expect(h.session.selectedTask()?.id).toBe(2);
    expect(body()).toBe(original);
    expect(h.writes).toEqual([]);
  });

  test("while reading, a drag selects the rendered text (VISUAL over its rows) and y copies what is shown", async () => {
    const h = await ready({ tasks: DOC });
    const [x, y] = find(h, "beta");
    drag(h, [x, y], [x + "beta gamm".length, y]);
    expect(h.session.keys.mode()).toBe("VISUAL");
    let mark = h.terminal.writes.length;
    type(h, "y");
    expect(osc52(h, mark)).toEqual([encoded("beta gamma")]);
    // A double click selects a word of it, a triple click its row.
    const epsilon = find(h, "epsilon");
    click(h, epsilon);
    click(h, epsilon);
    expect(h.session.keys.mode()).toBe("VISUAL");
    mark = h.terminal.writes.length;
    type(h, "y");
    expect(osc52(h, mark)).toEqual([encoded("epsilon")]);
    click(h, find(h, "Plan", 0, 40));
    expect(h.session.keys.mode()).toBe("NORMAL");
  });

  test("dialogs: a click selects a row, a toggle row toggles on each click, the wheel moves the list, a click outside does nothing", async () => {
    const h = await ready();
    type(h, "f");
    await rendered(h);
    const dialog = h.session.dialog as unknown as Dialog;
    expect(dialog.label).toBe("filters");
    const review = dialog.rowOnScreen("status:review");
    expect(review).not.toBeNull();
    click(h, review as [number, number]);
    expect(h.session.filter.status).toBe("review");
    expect(h.session.dialog).toBe(dialog); // the picker stays open
    click(h, dialog.rowOnScreen("done") as [number, number]);
    expect(h.session.includeDone).toBe(true);
    await settle();
    click(h, dialog.rowOnScreen("done") as [number, number]); // again (a double click): toggles back
    expect(h.session.includeDone).toBe(false);
    const before = dialog.highlighted()?.key;
    wheel(h, dialog.rowOnScreen("status:open") as [number, number]);
    expect(dialog.highlighted()?.key).not.toBe(before);
    click(h, [1, 1]); // outside: the list under it is untouched, the dialog stays
    expect(h.session.dialog).toBe(dialog);
    expect(h.session.focus).toBe("tasks");
    type(h, "\x1b");
    // A list whose rows are not toggles (:theme): a click highlights (its live preview), a double click picks.
    type(h, ":", ..."theme", "\r");
    await rendered(h);
    const themes = h.session.dialog as unknown as Dialog;
    const light = themes.rowOnScreen("cortex-light") as [number, number];
    click(h, light);
    expect(themes.highlighted()?.key).toBe("cortex-light");
    expect(h.session.dialog).toBe(themes);
    click(h, light);
    await settle();
    expect(h.session.dialog).toBeNull();
    expect(h.shell.theme?.name).toBe("cortex-light");
  });

  test("help and the hint for a mouse selection name the mouse and the terminal's own selection (Shift-drag)", async () => {
    const h = await ready();
    type(h, "?");
    h.terminal.rows = 300;
    const help = screen(h);
    expect(help).toContain("MOUSE");
    expect(help).toMatch(/Shift-drag.*native selection/);
  });
});
