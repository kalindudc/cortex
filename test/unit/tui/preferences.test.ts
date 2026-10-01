import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_DATABASE,
  migrateSettings,
  openPreferences,
  readPreferences,
  savePreferences,
} from "../../../src/tui/preferences.ts";

// App-written per-profile view state: each database's last task, keyed by
// the database UUID. Saving re-reads the file, merges ONLY the fields this
// session changed and renames atomically, so concurrent sessions on one
// profile never erase each other's choices. View state is read at startup and
// never live-broadcast; no drafts, ever. The settings it once held (theme,
// density, number, the document mode, the list's sort and grouping) live in
// tui.toml: migrateSettings moves them there once. Everything else it once
// held (the panel, include-done, the task list, each database's filter and
// search) is dropped: commands and shortcuts last only for the session.

const DB_A = "0b6a2f4e-0c1d-4e5f-8a9b-1c2d3e4f5a6b";
const DB_B = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-prefs-"));
  file = path.join(dir, "tui", "default.state.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const onDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf8"));
const writeRaw = (value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

describe("readPreferences", () => {
  test("a missing file gives defaults and no problems, creating nothing", () => {
    expect(readPreferences(file)).toEqual({ preferences: { databases: {} }, problems: [] });
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  test("defaults: a database keeps only its last task", () => {
    expect(DEFAULT_DATABASE).toEqual({ lastTask: null });
  });

  test("invalid fields keep their defaults with a problem; the old filter and search are not read", () => {
    writeRaw({
      version: 1,
      view: { mode: "bogus", theme: "../x", panel: "nowhere", sort: "size", group: "lane" },
      databases: {
        [DB_A]: { lastTask: -3, query: "q", filter: { status: "nope", lane: null, tags: [] } },
        [DB_B]: { lastTask: 4, query: "kept?", filter: { status: "review", lane: null, tags: [] } },
        "not-a-uuid": { lastTask: 1 },
      },
    });
    const { preferences, problems } = readPreferences(file);
    expect(preferences.databases).toEqual({ [DB_A]: DEFAULT_DATABASE, [DB_B]: { lastTask: 4 } });
    const reasons = problems.map(p => p.reason).join("\n");
    for (const field of ["view.mode", "view.theme", "view.sort", `databases.${DB_A}.lastTask`, "not-a-uuid"]) {
      expect(reasons).toContain(field);
    }
    expect(reasons).not.toMatch(/panel|filter|query|view\.group/);
    for (const p of problems) expect(p.file).toBe(file);
  });

  test("legacy settings survive every save unchanged until dropMoved; the rest of the old view is dropped", () => {
    const legacy = { theme: "ansi", density: "compact", lineNumbers: true, mode: "edit", sort: "title", group: "lane" };
    // Session-only now: the first save drops them.
    const dropped = { includeDone: true, taskList: false, panel: "activity" };
    writeRaw({ version: 1, view: { ...legacy, ...dropped } });
    expect(readPreferences(file)).toEqual({ preferences: { databases: {} }, problems: [] });
    savePreferences(file, { databases: { [DB_A]: { lastTask: 2 } } });
    expect(onDisk()).toEqual({ version: 1, view: legacy, databases: { [DB_A]: { lastTask: 2 } } });
    savePreferences(file, {}, { dropMoved: true });
    expect(onDisk()).toEqual({ version: 1, databases: { [DB_A]: { lastTask: 2 } } });
  });

  test("invalid legacy settings are reported and not carried", () => {
    writeRaw({ version: 1, view: { theme: "../x", density: "tiny", mode: "view", includeDone: true } });
    const reasons = readPreferences(file).problems.map(p => p.reason);
    expect(reasons).toEqual([
      expect.stringContaining("view.theme"),
      expect.stringContaining("view.density"),
      expect.stringContaining("view.mode"),
    ]);
    savePreferences(file, { databases: { [DB_A]: { lastTask: 1 } } });
    expect(onDisk()).toEqual({ version: 1, databases: { [DB_A]: { lastTask: 1 } } });
  });

  test("an unreadable or corrupt file gives defaults with a problem", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    const r = readPreferences(file);
    expect(r.preferences).toEqual({ databases: {} });
    expect(r.problems).toEqual([{ file, reason: expect.stringMatching(/JSON/) }]);
  });
});

describe("savePreferences: re-read, merge only the changed fields, atomic rename", () => {
  test("writes { version, databases: { <uuid>: { lastTask } } }, 0600 in a 0700 directory, no temp files", () => {
    const merged = savePreferences(file, { databases: { [DB_A]: { lastTask: 7 } } });
    expect(merged.databases[DB_A]).toEqual({ lastTask: 7 });
    expect(onDisk()).toEqual({ version: 1, databases: { [DB_A]: { lastTask: 7 } } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["default.state.json"]);
  });

  test("fields changed elsewhere since the last read survive", () => {
    savePreferences(file, { databases: { [DB_A]: { lastTask: 3 } } });
    savePreferences(file, { databases: { [DB_B]: { lastTask: 9 } } });
    expect(readPreferences(file).preferences.databases).toEqual({
      [DB_A]: { lastTask: 3 },
      [DB_B]: { lastTask: 9 },
    });
  });

  test("the file never contains drafts or other unknown fields, even if the old file had them", () => {
    writeRaw({
      version: 1,
      view: { draft: "secret" },
      drafts: { 1: "body" },
      databases: { [DB_A]: { body: "x", query: "q", filter: { status: null, lane: null, tags: [] } } },
    });
    savePreferences(file, { databases: { [DB_A]: { lastTask: 1, query: "leak" } }, draft: "leak" } as never);
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toMatch(/draft|secret|body|leak|query|filter|view/);
    expect(onDisk()).toEqual({ version: 1, databases: { [DB_A]: { lastTask: 1 } } });
  });

  test("a file written by a newer version is never overwritten", () => {
    const newer = JSON.stringify({ version: 2, view: { future: true } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, newer);
    expect(readPreferences(file).problems).toEqual([{ file, reason: expect.stringMatching(/version 2/) }]);
    expect(() => savePreferences(file, { databases: { [DB_A]: { lastTask: 1 } } })).toThrow(/version 2/);
    expect(fs.readFileSync(file, "utf8")).toBe(newer);
  });

  test("invalid changes are refused before anything is written", () => {
    expect(() => savePreferences(file, { databases: { "not-a-uuid": { lastTask: 1 } } })).toThrow(/database id/);
    expect(() => savePreferences(file, { databases: { [DB_A]: { lastTask: 1.5 } } })).toThrow(/lastTask/);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("openPreferences: two concurrent sessions on one profile", () => {
  test("each session saves only what it changed; neither erases the other's choices", () => {
    const a = openPreferences(file);
    const b = openPreferences(file);
    a.setDatabase(DB_A, "lastTask", 5);
    a.save();
    b.setDatabase(DB_B, "lastTask", 9);
    b.save();
    expect(readPreferences(file).preferences.databases).toEqual({
      [DB_A]: { lastTask: 5 },
      [DB_B]: { lastTask: 9 },
    });
  });

  test("a later save does not re-assert a field this session already saved and another session changed since", () => {
    const a = openPreferences(file);
    const b = openPreferences(file);
    a.setDatabase(DB_A, "lastTask", 1);
    a.save();
    b.setDatabase(DB_A, "lastTask", 2);
    b.save();
    a.setDatabase(DB_B, "lastTask", 3);
    a.save();
    expect(readPreferences(file).preferences.databases).toEqual({
      [DB_A]: { lastTask: 2 },
      [DB_B]: { lastTask: 3 },
    });
  });

  test("the state is read at startup and never live-broadcast into another session", () => {
    const a = openPreferences(file);
    const b = openPreferences(file);
    a.setDatabase(DB_A, "lastTask", 4);
    a.save();
    expect(b.database(DB_A).lastTask).toBeNull();
    b.setDatabase(DB_B, "lastTask", 5);
    b.save();
    // b's own save merged a's change into the FILE, not into b's session.
    expect(b.database(DB_A).lastTask).toBeNull();
    expect(openPreferences(file).database(DB_A).lastTask).toBe(4);
  });

  test("an unknown or reset database never restores another database's task", () => {
    const a = openPreferences(file);
    a.setDatabase(DB_A, "lastTask", 42);
    a.save();
    const later = openPreferences(file);
    expect(later.database(DB_A).lastTask).toBe(42);
    expect(later.database(DB_B)).toEqual(DEFAULT_DATABASE);
  });

  test("save with nothing changed writes nothing; setDatabase validates and keeps only lastTask", () => {
    const a = openPreferences(file);
    a.save();
    expect(fs.existsSync(file)).toBe(false);
    expect(() => a.setDatabase("x", "lastTask", 1)).toThrow(/database id/);
    expect(() => a.setDatabase(DB_A, "lastTask", 1.5)).toThrow(/lastTask/);
    expect(() => a.setDatabase(DB_A, "filter" as never, { status: null, lane: null, tags: [] } as never)).toThrow(
      /filter/,
    );
    expect(() => a.setDatabase(DB_A, "query" as never, "q" as never)).toThrow(/query/);
    a.save();
    expect(fs.existsSync(file)).toBe(false);
  });

  test("load problems are exposed for :messages", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "[]");
    expect(openPreferences(file).problems()).toEqual([{ file, reason: expect.any(String) }]);
  });
});

describe("migrateSettings: the legacy view settings move into tui.toml once", () => {
  let toml: string;
  beforeEach(() => {
    toml = path.join(dir, "tui.toml");
  });
  const writeState = (view: Record<string, unknown>, version: unknown = 1): void => {
    writeRaw({ version, view });
  };
  const age = (target: string): number => {
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(target, past, past);
    return fs.statSync(target).mtimeMs;
  };

  test("non-default values move into tui.toml and the view leaves the state file; the rest never moves", () => {
    writeState({
      theme: "ansi",
      density: "compact",
      includeDone: true,
      taskList: false,
      lineNumbers: true,
      mode: "split",
      sort: "title",
      group: "lane",
      panel: "activity",
    });
    expect(migrateSettings(file, toml)).toEqual({ unmoved: {}, problems: [] });
    expect(fs.readFileSync(toml, "utf8")).toBe(
      'theme = "ansi"\ndensity = "compact"\nnumber = true\nsort = "title"\ngroup = "lane"\nmode = "split"\n',
    );
    expect(onDisk()).toEqual({ version: 1, databases: {} });
  });

  test("tui.toml keys win; the state value is still dropped", () => {
    fs.writeFileSync(toml, 'theme = "cortex-light"\nsort = "-id"\n');
    writeState({ theme: "ansi", lineNumbers: true, sort: "title" });
    expect(migrateSettings(file, toml)).toEqual({ unmoved: {}, problems: [] });
    expect(fs.readFileSync(toml, "utf8")).toBe('theme = "cortex-light"\nsort = "-id"\nnumber = true\n');
    expect(onDisk()).toEqual({ version: 1, databases: {} });
  });

  test("defaults and nulls create no tui.toml, and the fields are dropped", () => {
    writeState({
      includeDone: false,
      taskList: true,
      density: "comfortable",
      theme: null,
      lineNumbers: false,
      mode: "read",
      sort: "id",
      group: "none",
    });
    expect(migrateSettings(file, toml)).toEqual({ unmoved: {}, problems: [] });
    expect(fs.existsSync(toml)).toBe(false);
    expect(onDisk()).toEqual({ version: 1, databases: {} });
  });

  test("an invalid tui.toml: neither file changes, and the values apply to this session with one problem", () => {
    fs.writeFileSync(toml, "not = [toml");
    writeState({ theme: "ansi", lineNumbers: true, sort: "title" });
    const state = fs.readFileSync(file, "utf8");
    const result = migrateSettings(file, toml);
    expect(result.unmoved).toEqual({ theme: "ansi", number: true, sort: "title" });
    expect(result.problems).toEqual([{ file, reason: expect.stringContaining(`into ${toml}`) }]);
    expect(result.problems[0].reason).toMatch(/theme, number, sort/);
    expect(fs.readFileSync(toml, "utf8")).toBe("not = [toml");
    expect(fs.readFileSync(file, "utf8")).toBe(state);
  });

  test("no legacy fields, a missing file or a newer-version file: nothing is written and no problems", () => {
    expect(migrateSettings(file, toml)).toEqual({ unmoved: {}, problems: [] });
    expect(fs.existsSync(file)).toBe(false);
    for (const [view, version] of [
      [{ panel: "activity" }, 1],
      [{ includeDone: true, taskList: false }, 1],
      [{ theme: "ansi" }, 2],
    ] as const) {
      writeState(view, version);
      const mtime = age(file);
      expect(migrateSettings(file, toml)).toEqual({ unmoved: {}, problems: [] });
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
      expect(fs.existsSync(toml)).toBe(false);
    }
  });
});
