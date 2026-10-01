import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_DATABASE,
  DEFAULT_VIEW,
  migrateSettings,
  openPreferences,
  readPreferences,
  savePreferences,
} from "../../../src/tui/preferences.ts";

// App-written per-profile view state: global view preferences plus
// per-database entries keyed by the database UUID. Saving re-reads the file,
// merges ONLY the fields this session changed and renames atomically, so
// concurrent sessions on one profile never erase each other's choices. View
// state is read at startup and never live-broadcast; no drafts, ever. The
// settings it once held (theme, density, number) live in tui.toml:
// migrateSettings moves them there once. Its old include-done and task-list
// fields are dropped: tui.toml's done and tasks set them at startup, and a
// session's changes to them are never saved.

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

describe("readPreferences", () => {
  test("a missing file gives defaults and no problems, creating nothing", () => {
    expect(readPreferences(file)).toEqual({ preferences: { view: DEFAULT_VIEW, databases: {} }, problems: [] });
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  test("defaults", () => {
    expect(DEFAULT_VIEW).toEqual({ panel: "document", mode: "read", sort: "id", group: "none" });
    expect(DEFAULT_DATABASE).toEqual({ lastTask: null, filter: { status: null, lane: null, tags: [] }, query: "" });
  });

  test("invalid fields keep their defaults with a problem; others still load", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        view: { mode: "bogus", theme: "../x", panel: "activity", sort: "size", group: "lane" },
        databases: {
          [DB_A]: { lastTask: -3, query: "q", filter: { status: "nope", lane: null, tags: [] } },
          "not-a-uuid": { lastTask: 1 },
        },
      }),
    );
    const { preferences, problems } = readPreferences(file);
    expect(preferences.view).toEqual({ ...DEFAULT_VIEW, panel: "activity", group: "lane" });
    expect(preferences.databases).toEqual({ [DB_A]: { ...DEFAULT_DATABASE, query: "q" } });
    const reasons = problems.map(p => p.reason).join("\n");
    for (const field of [
      "view.mode",
      "view.theme",
      "view.sort",
      `databases.${DB_A}.lastTask`,
      `databases.${DB_A}.filter`,
      "not-a-uuid",
    ]) {
      expect(reasons).toContain(field);
    }
    for (const p of problems) expect(p.file).toBe(file);
  });

  test("legacy settings never appear in view(), survive every save unchanged, and dropMoved removes them", () => {
    const legacy = { theme: "ansi", density: "compact", lineNumbers: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The old include-done and task-list fields are not carried: the first save drops them.
    const dropped = { includeDone: true, taskList: false };
    fs.writeFileSync(file, JSON.stringify({ version: 1, view: { ...legacy, ...dropped, mode: "edit" } }));
    const view = { ...DEFAULT_VIEW, mode: "edit" as const };
    expect(readPreferences(file)).toEqual({ preferences: { view, databases: {} }, problems: [] });
    expect(openPreferences(file).view()).toEqual(view);
    savePreferences(file, { view: { sort: "title" } });
    expect(onDisk().view).toEqual({ ...legacy, ...view, sort: "title" });
    savePreferences(file, {}, { dropMoved: true });
    expect(onDisk().view).toEqual({ ...view, sort: "title" });
  });

  test("invalid legacy settings are reported and not carried", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, view: { theme: "../x", density: "tiny", includeDone: true } }));
    const reasons = readPreferences(file).problems.map(p => p.reason);
    expect(reasons).toEqual([expect.stringContaining("view.theme"), expect.stringContaining("view.density")]);
    savePreferences(file, { view: { mode: "split" } });
    expect(onDisk().view).toEqual({ ...DEFAULT_VIEW, mode: "split" });
  });

  test("an unreadable or corrupt file gives defaults with a problem", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    const r = readPreferences(file);
    expect(r.preferences).toEqual({ view: DEFAULT_VIEW, databases: {} });
    expect(r.problems).toEqual([{ file, reason: expect.stringMatching(/JSON/) }]);
  });
});

describe("savePreferences: re-read, merge only the changed fields, atomic rename", () => {
  test("writes a versioned file with only known fields, 0600 in a 0700 directory, and leaves no temp files", () => {
    const merged = savePreferences(file, { view: { mode: "split" }, databases: { [DB_A]: { lastTask: 7 } } });
    expect(merged.view.mode).toBe("split");
    expect(onDisk()).toEqual({
      version: 1,
      view: { ...DEFAULT_VIEW, mode: "split" },
      databases: { [DB_A]: { ...DEFAULT_DATABASE, lastTask: 7 } },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["default.state.json"]);
  });

  test("fields changed elsewhere since the last read survive", () => {
    savePreferences(file, { view: { group: "lane" }, databases: { [DB_A]: { query: "from A" } } });
    savePreferences(file, { view: { mode: "edit" }, databases: { [DB_A]: { lastTask: 3 }, [DB_B]: { lastTask: 9 } } });
    const { preferences } = readPreferences(file);
    expect(preferences.view).toMatchObject({ group: "lane", mode: "edit" });
    expect(preferences.databases[DB_A]).toMatchObject({ query: "from A", lastTask: 3 });
    expect(preferences.databases[DB_B]).toMatchObject({ lastTask: 9, query: "" });
  });

  test("the file never contains drafts or other unknown fields, even if the old file had them", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        view: { draft: "secret" },
        drafts: { 1: "body" },
        databases: { [DB_A]: { body: "x" } },
      }),
    );
    savePreferences(file, { view: { sort: "title" }, draft: "leak" } as never);
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toMatch(/draft|secret|body|leak/);
    expect(onDisk().view).toEqual({ ...DEFAULT_VIEW, sort: "title" });
  });

  test("a file written by a newer version is never overwritten", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const newer = JSON.stringify({ version: 2, view: { future: true } });
    fs.writeFileSync(file, newer);
    expect(readPreferences(file).problems).toEqual([{ file, reason: expect.stringMatching(/version 2/) }]);
    expect(() => savePreferences(file, { view: { mode: "edit" } })).toThrow(/version 2/);
    expect(fs.readFileSync(file, "utf8")).toBe(newer);
  });

  test("invalid changes are refused before anything is written", () => {
    expect(() => savePreferences(file, { view: { mode: "bogus" as "read" } })).toThrow(/mode/);
    expect(() => savePreferences(file, { databases: { "not-a-uuid": { lastTask: 1 } } })).toThrow(/database id/);
    expect(() => savePreferences(file, { databases: { [DB_A]: { query: "x".repeat(5000) } } })).toThrow(/query/);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("openPreferences: two concurrent sessions on one profile", () => {
  test("each session saves only what it changed; neither erases the other's choices", () => {
    const a = openPreferences(file);
    const b = openPreferences(file);
    a.setView("group", "status");
    a.setDatabase(DB_A, "lastTask", 5);
    a.save();
    b.setView("mode", "split");
    b.setDatabase(DB_A, "query", "#bug");
    b.setDatabase(DB_B, "filter", { status: "review", lane: "now", tags: ["bug"] });
    b.save();
    const { preferences } = readPreferences(file);
    expect(preferences.view).toMatchObject({ group: "status", mode: "split" });
    expect(preferences.databases[DB_A]).toMatchObject({ lastTask: 5, query: "#bug" });
    expect(preferences.databases[DB_B].filter).toEqual({ status: "review", lane: "now", tags: ["bug"] });
  });

  test("a later save does not re-assert a field this session already saved and another session changed since", () => {
    const a = openPreferences(file);
    const b = openPreferences(file);
    a.setView("mode", "edit");
    a.save();
    b.setView("mode", "split");
    b.save();
    a.setView("sort", "-id");
    a.save();
    expect(readPreferences(file).preferences.view).toMatchObject({ mode: "split", sort: "-id" });
  });

  test("settings are read at startup and never live-broadcast into another session", () => {
    const a = openPreferences(file);
    const b = openPreferences(file);
    a.setView("group", "lane");
    a.save();
    expect(b.view().group).toBe("none");
    b.setView("panel", "authors");
    b.save();
    // b's own save merged a's change into the FILE, not into b's session.
    expect(b.view()).toMatchObject({ group: "none", panel: "authors" });
    expect(readPreferences(file).preferences.view).toMatchObject({ group: "lane", panel: "authors" });
    expect(openPreferences(file).view()).toMatchObject({ group: "lane", panel: "authors" });
  });

  test("an unknown or reset database never restores another database's task or filter", () => {
    const a = openPreferences(file);
    a.setDatabase(DB_A, "lastTask", 42);
    a.setDatabase(DB_A, "filter", { status: "blocked", lane: null, tags: [] });
    a.save();
    const later = openPreferences(file);
    expect(later.database(DB_A).lastTask).toBe(42);
    expect(later.database(DB_B)).toEqual(DEFAULT_DATABASE);
  });

  test("save with nothing changed writes nothing; setters validate", () => {
    const a = openPreferences(file);
    a.save();
    expect(fs.existsSync(file)).toBe(false);
    expect(() => a.setView("mode", "bogus" as "read")).toThrow(/mode/);
    expect(() => a.setDatabase("x", "lastTask", 1)).toThrow(/database id/);
    expect(() => a.setDatabase(DB_A, "lastTask", 1.5)).toThrow(/lastTask/);
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version, view }));
  };
  const age = (target: string): number => {
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(target, past, past);
    return fs.statSync(target).mtimeMs;
  };

  test("non-default values move into tui.toml and leave the state file; include-done and the task list never move", () => {
    writeState({
      theme: "ansi",
      density: "compact",
      includeDone: true,
      taskList: false,
      lineNumbers: true,
      mode: "edit",
    });
    expect(migrateSettings(file, toml)).toEqual({ unmoved: {}, problems: [] });
    expect(fs.readFileSync(toml, "utf8")).toBe('theme = "ansi"\ndensity = "compact"\nnumber = true\n');
    expect(onDisk().view).toEqual({ ...DEFAULT_VIEW, mode: "edit" });
  });

  test("tui.toml keys win; the state value is still dropped", () => {
    fs.writeFileSync(toml, 'theme = "cortex-light"\n');
    writeState({ theme: "ansi", lineNumbers: true });
    expect(migrateSettings(file, toml)).toEqual({ unmoved: {}, problems: [] });
    expect(fs.readFileSync(toml, "utf8")).toBe('theme = "cortex-light"\nnumber = true\n');
    expect(onDisk().view).toEqual(DEFAULT_VIEW);
  });

  test("defaults and nulls create no tui.toml, and the fields are dropped", () => {
    writeState({ includeDone: false, taskList: true, density: "comfortable", theme: null, lineNumbers: false });
    expect(migrateSettings(file, toml)).toEqual({ unmoved: {}, problems: [] });
    expect(fs.existsSync(toml)).toBe(false);
    expect(onDisk().view).toEqual(DEFAULT_VIEW);
  });

  test("an invalid tui.toml: neither file changes, and the values apply to this session with one problem", () => {
    fs.writeFileSync(toml, "not = [toml");
    writeState({ theme: "ansi", lineNumbers: true });
    const state = fs.readFileSync(file, "utf8");
    const result = migrateSettings(file, toml);
    expect(result.unmoved).toEqual({ theme: "ansi", number: true });
    expect(result.problems).toEqual([{ file, reason: expect.stringContaining(`into ${toml}`) }]);
    expect(result.problems[0].reason).toMatch(/theme, number/);
    expect(fs.readFileSync(toml, "utf8")).toBe("not = [toml");
    expect(fs.readFileSync(file, "utf8")).toBe(state);
  });

  test("no legacy fields, a missing file or a newer-version file: nothing is written and no problems", () => {
    expect(migrateSettings(file, toml)).toEqual({ unmoved: {}, problems: [] });
    expect(fs.existsSync(file)).toBe(false);
    for (const [view, version] of [
      [{ mode: "edit" }, 1],
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
