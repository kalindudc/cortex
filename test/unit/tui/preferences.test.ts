import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_DATABASE,
  DEFAULT_VIEW,
  openPreferences,
  readPreferences,
  savePreferences,
} from "../../../src/tui/preferences.ts";

// Plan @400 N15: app-written per-profile view state. Global view preferences
// plus per-database entries keyed by the database UUID. Saving re-reads the
// file, merges ONLY the fields this session changed and renames atomically,
// so concurrent sessions on one profile never erase each other's choices.
// Settings are read at startup and never live-broadcast; no drafts, ever.

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
    expect(DEFAULT_VIEW).toEqual({
      includeDone: false,
      taskList: true,
      lineNumbers: false,
      panel: "document",
      mode: "read",
      theme: null,
      sort: "id",
      group: "none",
      density: null,
    });
    expect(DEFAULT_DATABASE).toEqual({ lastTask: null, filter: { status: null, lane: null, tags: [] }, query: "" });
  });

  test("invalid fields keep their defaults with a problem; others still load", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        view: { includeDone: true, mode: "bogus", theme: "../x", panel: "activity", sort: "size", group: "lane" },
        databases: {
          [DB_A]: { lastTask: -3, query: "q", filter: { status: "nope", lane: null, tags: [] } },
          "not-a-uuid": { lastTask: 1 },
        },
      }),
    );
    const { preferences, problems } = readPreferences(file);
    expect(preferences.view).toEqual({ ...DEFAULT_VIEW, includeDone: true, panel: "activity", group: "lane" });
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

  test("density: an explicit :density choice or null (no choice); older files without it load null", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A file written before the density existed.
    fs.writeFileSync(file, JSON.stringify({ version: 1, view: { includeDone: true, mode: "edit" } }));
    expect(readPreferences(file)).toEqual({
      preferences: { view: { ...DEFAULT_VIEW, includeDone: true, mode: "edit", density: null }, databases: {} },
      problems: [],
    });
    for (const density of ["compact", "comfortable", null] as const) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, view: { density } }));
      expect(readPreferences(file).preferences.view.density).toBe(density);
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, view: { density: "tiny", mode: "split" } }));
    const { preferences, problems } = readPreferences(file);
    expect(preferences.view).toEqual({ ...DEFAULT_VIEW, mode: "split" });
    expect(problems.map(p => p.reason)).toEqual([expect.stringContaining("view.density")]);
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
    savePreferences(file, { view: { includeDone: true }, databases: { [DB_A]: { query: "from A" } } });
    savePreferences(file, { view: { mode: "edit" }, databases: { [DB_A]: { lastTask: 3 }, [DB_B]: { lastTask: 9 } } });
    const { preferences } = readPreferences(file);
    expect(preferences.view).toMatchObject({ includeDone: true, mode: "edit" });
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
    savePreferences(file, { view: { theme: "cortex-light" }, draft: "leak" } as never);
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toMatch(/draft|secret|body|leak/);
    expect(onDisk().view).toEqual({ ...DEFAULT_VIEW, theme: "cortex-light" });
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
    a.setView("includeDone", true);
    a.setDatabase(DB_A, "lastTask", 5);
    a.save();
    b.setView("mode", "split");
    b.setDatabase(DB_A, "query", "#bug");
    b.setDatabase(DB_B, "filter", { status: "review", lane: "now", tags: ["bug"] });
    b.save();
    const { preferences } = readPreferences(file);
    expect(preferences.view).toMatchObject({ includeDone: true, mode: "split" });
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
    a.setView("includeDone", true);
    a.save();
    expect(readPreferences(file).preferences.view).toMatchObject({ mode: "split", includeDone: true });
  });

  test("settings are read at startup and never live-broadcast into another session", () => {
    const a = openPreferences(file);
    const b = openPreferences(file);
    a.setView("taskList", false);
    a.save();
    expect(b.view().taskList).toBe(true);
    b.setView("panel", "authors");
    b.save();
    // b's own save merged a's change into the FILE, not into b's session.
    expect(b.view()).toMatchObject({ taskList: true, panel: "authors" });
    expect(readPreferences(file).preferences.view).toMatchObject({ taskList: false, panel: "authors" });
    expect(openPreferences(file).view()).toMatchObject({ taskList: false, panel: "authors" });
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

  test("a :density choice saves like the other view fields and merges with another session's", () => {
    const a = openPreferences(file);
    const b = openPreferences(file);
    a.setView("density", "compact");
    a.save();
    b.setView("mode", "edit");
    b.save();
    expect(onDisk().view).toEqual({ ...DEFAULT_VIEW, density: "compact", mode: "edit" });
    expect(openPreferences(file).view().density).toBe("compact");
    expect(() => a.setView("density", "tiny" as "compact")).toThrow(/density/);
  });

  test("save with nothing changed writes nothing; setters validate", () => {
    const a = openPreferences(file);
    a.save();
    expect(fs.existsSync(file)).toBe(false);
    expect(() => a.setView("theme", "Not Valid")).toThrow(/theme/);
    expect(() => a.setDatabase("x", "lastTask", 1)).toThrow(/database id/);
    expect(() => a.setDatabase(DB_A, "lastTask", 1.5)).toThrow(/lastTask/);
  });

  test("load problems are exposed for :messages", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "[]");
    expect(openPreferences(file).problems()).toEqual([{ file, reason: expect.any(String) }]);
  });
});
