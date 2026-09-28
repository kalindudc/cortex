import { test, expect, describe, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMANDS, commandHelp } from "../../../src/tui/commands.ts";
import { DEFAULT_CONFIG, loadConfig } from "../../../src/tui/config.ts";
import {
  DEFAULT_KEYS,
  DEFAULT_LEADER,
  INSERT_ACTIONS,
  INSERT_KEY_ACTIONS,
  KEY_ACTIONS,
  NORMAL_ACTIONS,
  VISUAL_ACTIONS,
  VISUAL_KEY_ACTIONS,
} from "../../../src/tui/keys.ts";
import { BUNDLED_THEME_NAMES, THEME_TOKENS } from "../../../src/tui/theme.ts";

// Plan @400 N24/Task 12: the command registry, the default key table and the
// theme token list are the single sources for help. README.md carries
// hand-written reference tables (no generator script); these tests parse them
// and fail when they drift from those sources.

const README_PATH = path.resolve(import.meta.dir, "..", "..", "..", "README.md");
const README = fs.readFileSync(README_PATH, "utf8");

/** The body rows of the README table whose header line is exactly `header`, as raw cell strings. */
function tableRows(header: string): string[][] {
  const lines = README.split("\n");
  const at = lines.findIndex(line => line.trim() === header);
  expect(at, `README.md has no table with the header line: ${header}`).toBeGreaterThan(-1);
  const columns = cells(header).length;
  expect(
    cells(lines[at + 1] ?? "").every(c => /^:?-{3,}:?$/.test(c)),
    `${header}: missing separator row`,
  ).toBe(true);
  const rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.trim().startsWith("|")) break;
    const row = cells(line);
    expect(row.length, `README row has ${row.length} cells, expected ${columns}: ${line}`).toBe(columns);
    rows.push(row);
  }
  return rows;
}

/** A table line's cells: split on unescaped pipes (GFM), trimmed. */
function cells(line: string): string[] {
  const inner = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map(c => c.trim());
}

/** A cell made only of code spans: their text in order (`\|` is a literal pipe in a GFM table cell). */
function spans(cell: string): string[] {
  const rest = cell.replace(/`[^`]*`/g, "").trim();
  expect(rest, `expected only code spans in the cell: ${cell}`).toBe("");
  return [...cell.matchAll(/`([^`]*)`/g)].map(m => (m[1] ?? "").replace(/\\\|/g, "|"));
}

/** A prose cell's text with CommonMark backslash escapes undone (`\<id>` renders as `<id>`). */
function prose(cell: string): string {
  return cell.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

describe("README: the terminal command table matches the registry", () => {
  test("one row per registry entry, in registry order: usage, other names and description", () => {
    const readme = tableRows("| Command | Also | Description |").map(([usage = "", also = "", description = ""]) => ({
      usage: spans(usage).join(" "),
      names: spans(also),
      description: prose(description),
    }));
    const registry = commandHelp(COMMANDS).map(h => ({
      usage: h.usage,
      names: [...h.names],
      description: h.description,
    }));
    const documented = new Set(readme.map(r => r.usage));
    const registered = new Set(registry.map(r => r.usage));
    expect(
      registry.filter(r => !documented.has(r.usage)).map(r => r.usage),
      "registry commands missing from the README table",
    ).toEqual([]);
    expect(
      readme.filter(r => !registered.has(r.usage)).map(r => r.usage),
      "README rows that are not registry commands",
    ).toEqual([]);
    expect(readme).toEqual(registry);
  });
});

describe("README: the default key tables match keys.ts", () => {
  test("NORMAL and leader keys: one row per action, in order, with the default keys and the help text", () => {
    const readme = tableRows("| Action | NORMAL keys | Leader keys | Description |").map(
      ([action = "", normal = "", leader = "", description = ""]) => ({
        action: spans(action).join(" "),
        normal: spans(normal),
        leader: spans(leader),
        description: prose(description),
      }),
    );
    const table = NORMAL_ACTIONS.map(action => ({
      action,
      normal: DEFAULT_KEYS.bindings.normal[action].map(k => k.name),
      leader: DEFAULT_KEYS.bindings.leader[action].map(k => `${DEFAULT_LEADER}${k.name}`),
      description: KEY_ACTIONS[action].description,
    }));
    expect(readme.map(r => r.action)).toEqual([...NORMAL_ACTIONS]);
    expect(readme).toEqual(table);
  });

  test("INSERT shortcuts: one row per action with the default keys and the help text", () => {
    const readme = tableRows("| INSERT action | Keys | Description |").map(
      ([action = "", keys = "", description = ""]) => ({
        action: spans(action).join(" "),
        keys: spans(keys),
        description: prose(description),
      }),
    );
    const table = INSERT_ACTIONS.map(action => ({
      action,
      keys: DEFAULT_KEYS.bindings.insert[action].map(k => k.name),
      description: INSERT_KEY_ACTIONS[action].description,
    }));
    expect(readme).toEqual(table);
  });

  test("VISUAL operators: one row per action, in order, with the default keys and the help text", () => {
    const readme = tableRows("| VISUAL action | Keys | Description |").map(
      ([action = "", keys = "", description = ""]) => ({
        action: spans(action).join(" "),
        keys: spans(keys),
        description: prose(description),
      }),
    );
    const table = VISUAL_ACTIONS.map(action => ({
      action,
      keys: DEFAULT_KEYS.bindings.visual[action].map(k => k.name),
      description: VISUAL_KEY_ACTIONS[action].description,
    }));
    expect(readme).toEqual(table);
  });
});

describe("README: the theme reference matches theme.ts", () => {
  test("the token table lists every theme token once, in order", () => {
    const tokens = tableRows("| Token | Used for |").map(([token = ""]) => spans(token).join(" "));
    expect(tokens).toEqual([...THEME_TOKENS]);
  });

  test("the bundled themes are the bundled theme names", () => {
    const bundled = tableRows("| Bundled theme | Appearance |").map(([name = ""]) => spans(name).join(" "));
    expect(bundled).toEqual([...BUNDLED_THEME_NAMES]);
  });
});

describe("README: the tui.toml settings table matches config.ts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-docs-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "tui.toml");
  const load = (toml: string) => {
    fs.writeFileSync(file, toml);
    return loadConfig(file);
  };
  const rows = () =>
    tableRows("| Setting | Default | Meaning |").map(([setting = "", fallback = ""]) => ({
      setting: spans(setting).join(" "),
      fallback: fallback.startsWith("`") ? spans(fallback).join(" ") : null,
    }));

  test("every setting config.ts knows is documented, and nothing else", () => {
    // The loader names every known top-level setting when it rejects an unknown one.
    const unknown = load("not_a_setting = 1\n").problems.find(p => p.keyPath === "not_a_setting");
    const known = /\(known: ([^)]*)\)/.exec(unknown?.reason ?? "")?.[1]?.split(", ") ?? [];
    expect(known.length).toBeGreaterThan(0);
    const settings = known.filter(k => k !== "keys"); // [keys.*] have their own tables
    expect(
      rows()
        .map(r => r.setting)
        .sort(),
    ).toEqual(settings.sort());
  });

  test("each documented default loads without a problem and IS the default", () => {
    for (const { setting, fallback } of rows()) {
      if (fallback === null) continue; // unset by default
      const loaded = load(`${setting} = ${fallback}\n`);
      expect(loaded.problems, `${setting} = ${fallback}`).toEqual([]);
      expect(loaded.config, `${setting} = ${fallback} is not the default`).toEqual(DEFAULT_CONFIG);
    }
  });
});
