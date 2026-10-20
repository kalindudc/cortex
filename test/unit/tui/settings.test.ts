import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { bbPluginDir } from "../../../src/bbPlugin.ts";
import type { CortexClient, DaemonIdentity, WorkspaceSnapshot } from "../../../src/contracts.ts";
import { listSkills, skillDir } from "../../../src/skills.ts";
import type { Task } from "../../../src/store.ts";
import { COMMANDS, CommandError, completeCommandLine } from "../../../src/tui/commands.ts";
import { DEFAULT_CONFIG, loadConfig, WRITABLE_SETTINGS } from "../../../src/tui/config.ts";
import type { Dialog } from "../../../src/tui/dialogs.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";
import { openPreferences } from "../../../src/tui/preferences.ts";
import { type OverlayHost, type SessionOptions, type ThemeControl, TuiSession } from "../../../src/tui/session.ts";
import { CONFIG_ENTRIES, installReport, openConfig, runConfig, themeSourceText } from "../../../src/tui/settings.ts";
import { type ResolvedTheme, resolveTheme } from "../../../src/tui/theme.ts";

// The :config pane is the ONLY writer of tui.toml in the TUI: each change
// writes one line at once (saveSettings), and only a successful write
// applies a live setting to this session. Every other command and shortcut
// is session-only. Agent integrations install or reset through installAll.

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
  updated: id,
  tags: [],
  memory_excluded: false,
  ...over,
});
const TASKS: Task[] = [task(1, { title: "b" }), task(2, { title: "a" }), task(3, { title: "c", status: "done" })];

const ENV = ["XDG_CONFIG_HOME", "CORTEX_SKILL_DIR", "CORTEX_PI_EXTENSION_DIR", "CORTEX_BB_CLI"] as const;
let saved: Partial<Record<(typeof ENV)[number], string>>;
let dir: string;
let toml: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-settings-"));
  saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
  process.env.CORTEX_SKILL_DIR = path.join(dir, "skills");
  process.env.CORTEX_PI_EXTENSION_DIR = path.join(dir, "pi-extensions");
  // installAll runs in this process: bb stays off, so the real bb and npm never run.
  process.env.CORTEX_BB_CLI = "";
  toml = path.join(dir, "tui.toml");
});

afterEach(() => {
  for (const key of ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeHost(): OverlayHost {
  return {
    columns: () => 120,
    rows: () => 40,
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

function makeSession(over: Partial<SessionOptions> = {}) {
  const snapshot: WorkspaceSnapshot = {
    identity: IDENTITY,
    cursor: "e:1",
    tasks: TASKS,
    lanes: [{ name: "now", color: null, sort: 0 }],
    tags: [],
    notifications: [],
  };
  const s = new TuiSession({
    client: { workspace: async () => snapshot } as unknown as CortexClient,
    identity: IDENTITY,
    keys: DEFAULT_KEYS,
    preferences: openPreferences(path.join(dir, "tui", "default.state.json")),
    configFile: toml,
    schedule: () => () => {},
    ...over,
  });
  s.applySnapshot(snapshot);
  s.setOverlayHost(fakeHost());
  s.setTheme(resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" } }));
  const type = (...inputs: string[]) => {
    for (const input of inputs) s.input(input);
  };
  return { s, type };
}

const read = (): string => (fs.existsSync(toml) ? fs.readFileSync(toml, "utf8") : "");
const top = (s: TuiSession): Dialog => s.dialog as unknown as Dialog;
const shownIds = (s: TuiSession): number[] => s.workspace().rows.map(t => t.id);
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0));
};
/** Wait for the status line to match (the agent installs write files asynchronously). */
async function statusMatches(s: TuiSession, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!pattern.test(s.status?.text ?? "") && Date.now() < deadline) await Bun.sleep(5);
  expect(s.status?.text ?? "").toMatch(pattern);
}
/** Highlight one row of the open pane by searching for it (its key, or the words a user would type). */
function highlight(s: TuiSession, key: string, words = key): void {
  const dialog = top(s);
  dialog.search(words);
  expect(dialog.highlighted()?.key).toBe(key);
}

describe("CONFIG_ENTRIES", () => {
  test("every writable tui.toml setting exactly once, by section, each section's rows together", () => {
    const keys = CONFIG_ENTRIES.map(e => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...WRITABLE_SETTINGS].sort());
    const sections = CONFIG_ENTRIES.map(e => e.section).filter((s, i, all) => s !== all[i - 1]);
    expect(sections).toEqual(["Appearance", "Task list", "Mouse and scrolling", "Alerts for blocked tasks"]);
  });

  test("exactly the settings the Shell reads once at start apply at the next start", () => {
    expect(
      CONFIG_ENTRIES.filter(e => e.live === undefined)
        .map(e => e.key)
        .sort(),
    ).toEqual(["appearance", "colors", "mouse", "theme_dark", "theme_light", "transparent_background"]);
  });
});

describe("the :config pane", () => {
  test("a large CONFIG list: the value, · default and · next start; the agent integrations last", async () => {
    fs.writeFileSync(toml, "scroll = 5\n");
    const { s } = makeSession();
    await s.execute("config");
    const dialog = top(s);
    expect(dialog.size).toBe("large");
    expect(dialog.spec).toMatchObject({ kind: "list", title: "CONFIG", label: "config" });
    const rows = dialog.visibleRows();
    const row = (key: string) => rows.find(r => r.key === key);
    expect(row("scroll")).toMatchObject({ section: "Mouse and scrolling", detail: "5" });
    expect(row("mouse")).toMatchObject({ mark: "[x]", toggle: true, detail: "true · default · next start" });
    expect(row("done")).toMatchObject({ mark: "[ ]", detail: "false · default" });
    expect(row("theme")?.detail).toBe("auto · default");
    expect(row("theme_dark")?.detail).toBe("unset · default · next start");
    expect(rows.slice(-2).map(r => [r.key, r.section])).toEqual([
      ["agents:install", "Agent integrations"],
      ["agents:reset", "Agent integrations"],
    ]);
  });

  test("Space on done writes done = true and shows the done tasks now; x removes the line again", async () => {
    fs.writeFileSync(toml, "# mine\nscroll = 4\n");
    const { s, type } = makeSession();
    expect(shownIds(s)).not.toContain(3);
    openConfig(s);
    highlight(s, "done");
    type(" ");
    expect(read()).toBe("# mine\nscroll = 4\ndone = true\n");
    expect(s.includeDone).toBe(true);
    expect(shownIds(s)).toContain(3);
    expect(top(s).highlighted()).toMatchObject({ key: "done", mark: "[x]", detail: "true" });
    type("x");
    expect(read()).toBe("# mine\nscroll = 4\n");
    expect(s.includeDone).toBe(false);
    expect(top(s).highlighted()).toMatchObject({ key: "done", mark: "[ ]", detail: "false · default" });
  });

  test("Enter on a choice opens its list with the current value marked; Enter saves, applies and closes", async () => {
    const { s, type } = makeSession();
    openConfig(s);
    highlight(s, "sort");
    type("\r");
    const list = top(s);
    expect(list.spec).toMatchObject({ kind: "list", title: "CONFIG · sort" });
    expect(list.highlighted()).toMatchObject({ key: "id", mark: "(•)", detail: "default" });
    list.search("title");
    type("\r");
    expect(read()).toBe('sort = "title"\n');
    expect(s.sort).toBe("title");
    expect(top(s).spec).toMatchObject({ title: "CONFIG" });
    expect(top(s).highlighted()?.detail).toBe("title");
  });

  test("Enter on scroll opens a one-field form; its submit saves and applies; a bad number keeps it open", async () => {
    const { s, type } = makeSession();
    openConfig(s);
    highlight(s, "scroll");
    type("\r");
    expect(top(s).spec).toMatchObject({ kind: "form", fields: [{ label: "Rows a notch", hint: "1 to 20" }] });
    type("\x7f", "x", "\r");
    await flush();
    expect(top(s).spec.kind).toBe("form");
    expect(read()).toBe("");
    type("\x7f", "7", "\r");
    await flush();
    expect(read()).toBe("scroll = 7\n");
    expect(s.scrollRows).toBe(7);
    expect(top(s).spec).toMatchObject({ title: "CONFIG" });
  });
});

describe(":config <setting> [value]", () => {
  test("typed values write the line at once and apply the live ones", async () => {
    const { s } = makeSession();
    await s.execute("config scroll 5");
    expect(read()).toBe("scroll = 5\n");
    expect(s.scrollRows).toBe(5);
    await s.execute("config sort -updated");
    expect(s.sort).toBe("-updated");
    expect(shownIds(s)).toEqual([2, 1]);
    await s.execute("config density compact");
    expect(s.density).toBe("compact");
    await s.execute("config density default");
    expect(s.density).toBe("comfortable");
    expect(read()).toBe('scroll = 5\nsort = "-updated"\n');
    await s.execute("config done");
    expect(s.includeDone).toBe(true);
    expect(loadConfig(toml).config.done).toBe(true);
    await s.execute("config done");
    expect(loadConfig(toml).config.done).toBe(false);
    expect(s.includeDone).toBe(false);
  });

  test("a next-start setting is written and says so", async () => {
    const { s } = makeSession();
    await s.execute("config mouse false");
    expect(read()).toBe("mouse = false\n");
    expect(s.status).toMatchObject({ level: "info", text: expect.stringContaining("next start") });
  });

  test("a refused value changes neither the file nor the session; unknown names and values explain", async () => {
    fs.writeFileSync(toml, "scroll = 4\n");
    const { s } = makeSession({ settings: { scroll: 4 } });
    expect(() => runConfig(s, "scroll 0")).toThrow(CommandError);
    expect(() => runConfig(s, "scroll 21")).toThrow(/scroll: must be a whole number from 1 to 20/);
    expect(read()).toBe("scroll = 4\n");
    expect(s.scrollRows).toBe(4);
    for (const [line, reason] of [
      ["config nope 1", /Unknown setting "nope": theme, theme_dark/],
      ["config sort size", /Unknown sort "size": id, -id/],
      ["config done yes", /done takes true, false or default/],
      ["config scroll many", /scroll takes a whole number/],
    ] as const) {
      await s.execute(line);
      expect(s.status, line).toMatchObject({ level: "error", text: expect.stringMatching(reason) });
    }
    expect(read()).toBe("scroll = 4\n");
  });

  test("without a tui.toml every change is refused and nothing applies", async () => {
    const { s, type } = makeSession({ configFile: undefined });
    for (const line of ["config done true", "config scroll 5", "config sort title", "config done"]) {
      await s.execute(line);
      expect(s.status, line).toMatchObject({
        level: "error",
        text: "Settings are not saved in this session: it has no tui.toml",
      });
    }
    expect([s.includeDone, s.scrollRows, s.sort]).toEqual([false, 3, "id"]);
    openConfig(s);
    expect(
      top(s)
        .visibleRows()
        .find(r => r.key === "scroll")?.detail,
    ).toBe("3 · default");
    highlight(s, "done");
    type(" ");
    await flush();
    expect(s.includeDone).toBe(false);
    expect(s.status?.text).toMatch(/no tui\.toml/);
  });

  test("Tab completes the settings, then the typed setting's values", () => {
    const { s } = makeSession();
    expect(completeCommandLine("config do", COMMANDS, s)).toEqual(["config done"]);
    expect(completeCommandLine("config t", COMMANDS, s)).toEqual([
      "config tasks",
      "config theme",
      "config theme_dark",
      "config theme_light",
      "config transparent_background",
    ]);
    expect(completeCommandLine("config done ", COMMANDS, s)).toEqual([
      "config done true",
      "config done false",
      "config done default",
    ]);
    expect(completeCommandLine("config sort -", COMMANDS, s)).toEqual([
      "config sort -id",
      "config sort -title",
      "config sort -updated",
    ]);
    expect(completeCommandLine("config theme a", COMMANDS, s)).toEqual(["config theme auto", "config theme ansi"]);
    expect(completeCommandLine("config nope ", COMMANDS, s)).toEqual([]);
  });
});

describe("the theme", () => {
  function fakeThemes(s: TuiSession) {
    const calls: string[] = [];
    const control: ThemeControl = {
      choices: () => [
        { name: "cortex-dark", source: "bundled" },
        { name: "cortex-light", source: "bundled" },
        { name: "mine", source: "custom" },
      ],
      preview: name => void calls.push(`preview:${name}`),
      restore: () => void calls.push("restore"),
      apply: name => {
        // What tui.toml holds when the theme is applied: the pane saves first.
        calls.push(`apply:${name} with ${JSON.stringify(read())}`);
        const theme: ResolvedTheme = resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" }, session: name });
        s.setTheme(theme);
        return theme;
      },
    };
    s.setThemeControl(control);
    return calls;
  }

  test("the picker previews; Enter writes theme = <name>, then applies it; :config theme auto removes the line", async () => {
    const { s, type } = makeSession();
    const calls = fakeThemes(s);
    await s.execute("config theme");
    type("j", "j", "\x1b");
    expect(calls).toEqual(["preview:cortex-dark", "preview:cortex-light", "restore"]);
    expect(read()).toBe("");
    await s.execute("config theme");
    type("j", "j", "\r");
    expect(calls.slice(3)).toEqual([
      "preview:cortex-dark",
      "preview:cortex-light",
      'apply:cortex-light with "theme = \\"cortex-light\\"\\n"',
    ]);
    expect(s.dialog).toBeNull();
    expect(s.status?.text).toMatch(/cortex-light.*:config theme choice \(saved\)/);
    await s.execute("config theme auto");
    expect(read()).toBe("");
    expect(calls.at(-1)).toBe('apply:null with ""');
    await s.execute("config theme mine");
    expect(read()).toBe('theme = "mine"\n');
    await s.execute("config theme nope");
    expect(s.status?.text).toMatch(/Unknown theme "nope": auto, cortex-dark, cortex-light, mine, default/);
  });

  test("a refused save restores the preview, shows the error and applies nothing", async () => {
    const { s, type } = makeSession({ configFile: undefined });
    const calls = fakeThemes(s);
    await s.execute("config theme");
    type("j", "\r");
    await flush();
    expect(calls).toEqual(["preview:cortex-dark", "restore"]);
    expect(top(s).spec).toMatchObject({ label: "theme" });
    expect(s.status?.text).toMatch(/no tui\.toml/);
  });

  test("the status line names where the active theme comes from", () => {
    const env = { NO_COLOR: "1" };
    expect(themeSourceText(resolveTheme({ config: DEFAULT_CONFIG, env, session: "cortex-light" }))).toMatch(
      /cortex-light.*:config theme.*saved/,
    );
    expect(themeSourceText(resolveTheme({ config: DEFAULT_CONFIG, env, cli: "cortex-light" }))).toMatch(/--theme/);
    expect(themeSourceText(resolveTheme({ config: { ...DEFAULT_CONFIG, theme: "cortex-light" }, env }))).toMatch(
      /tui\.toml.*pins.*:config theme auto removes/,
    );
    expect(themeSourceText(resolveTheme({ config: DEFAULT_CONFIG, env, detected: "light" }))).toMatch(
      /auto.*light terminal/,
    );
  });
});

describe("agent integrations", () => {
  const skillFile = (name: string) => path.join(skillDir(name as never), "SKILL.md");

  test("install or update writes every skill and the pi extension into the pinned dirs, and reports it", async () => {
    const { s, type } = makeSession();
    openConfig(s);
    highlight(s, "agents:install", "install or update");
    type("\r");
    await statusMatches(s, /^Installed/);
    for (const name of listSkills()) expect(fs.existsSync(skillFile(name)), name).toBe(true);
    expect(fs.existsSync(path.join(dir, "pi-extensions", "cortex", "index.ts"))).toBe(true);
    expect(s.status?.text).toBe(
      `Installed ${listSkills().length} skills and the pi extension; skipped the bb plugin: bb is turned off (CORTEX_BB_CLI is empty)`,
    );
  });

  test("reset asks first (naming the dirs); n keeps everything, y wipes and reinstalls", async () => {
    const { s, type } = makeSession();
    openConfig(s);
    highlight(s, "agents:install", "install or update");
    type("\r");
    await statusMatches(s, /^Installed/);
    const stray = path.join(skillDir("cortex"), "stray.md");
    fs.writeFileSync(stray, "hand-edit");
    highlight(s, "agents:reset", "reset");
    type("\r");
    const confirm = top(s);
    expect(confirm.spec.kind).toBe("confirm");
    const message = confirm.spec.kind === "confirm" ? confirm.spec.message.join("\n") : "";
    expect(message).toContain(skillDir("cortex"));
    expect(message).toContain(path.join(dir, "pi-extensions", "cortex"));
    type("n");
    await flush();
    expect(fs.existsSync(stray)).toBe(true);
    highlight(s, "agents:reset", "reset");
    s.notify("info", "waiting");
    type("\r", "y");
    await statusMatches(s, /^Installed \d+ skills and the pi extension; skipped the bb plugin/);
    expect(fs.existsSync(stray)).toBe(false);
    for (const name of listSkills()) expect(fs.existsSync(skillFile(name)), name).toBe(true);
  });

  test("with bb present, reset names the plugin dir and says its settings reset (n runs nothing)", async () => {
    // A stand-in that would only leave a mark: answering n never runs it.
    const fakeBb = path.join(dir, "bb");
    fs.writeFileSync(fakeBb, `#!/bin/sh\ntouch "${dir}/bb-was-run"\n`, { mode: 0o755 });
    process.env.CORTEX_BB_CLI = fakeBb;
    const { s, type } = makeSession();
    openConfig(s);
    highlight(s, "agents:reset", "reset");
    type("\r");
    const confirm = top(s);
    const message = confirm.spec.kind === "confirm" ? confirm.spec.message.join("\n") : "";
    expect(message).toContain(bbPluginDir());
    expect(message).toContain("which resets its settings");
    type("n");
    await flush();
    expect(fs.existsSync(path.join(dir, "bb-was-run"))).toBe(false);
  });

  test("the status line reports the bb plugin: installed, not running, skipped, failed (as an error)", () => {
    const base = { skills: [{ name: "cortex", dir: "/s" }], extensions: [{ name: "pi", dir: "/e" }], skipped: [] };
    expect(installReport({ ...base, bb: { status: "installed", dir: "/d", plugin: { status: "running" } } })).toEqual({
      level: "info",
      text: "Installed 1 skill and the pi extension; bb plugin installed",
    });
    expect(
      installReport({ ...base, bb: { status: "reloaded", dir: "/d", plugin: { status: "needs-configuration" } } }).text,
    ).toBe("Installed 1 skill and the pi extension; bb plugin reloaded but it is needs-configuration");
    expect(installReport({ ...base, bb: { status: "skipped", reason: "bb not found" } }).text).toBe(
      "Installed 1 skill and the pi extension; skipped the bb plugin: bb not found",
    );
    expect(installReport({ ...base, bb: { status: "failed", dir: "/d", reason: "npm ci failed (exit 1)" } })).toEqual({
      level: "error",
      text: "Installed 1 skill and the pi extension; the bb plugin failed: npm ci failed (exit 1)",
    });
  });
});
