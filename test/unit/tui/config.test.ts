import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../../../src/tui/config.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";

// Plan @400 N15/N18/N22/N23: tui.toml is user-authored and read-only to
// cortex. Each section validates on its own; an invalid one keeps its
// defaults and records {file, keyPath, reason}. A missing file is silent.

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-config-"));
  file = path.join(dir, "tui.toml");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(text: string): void {
  fs.writeFileSync(file, text);
}

describe("loadConfig", () => {
  test("a missing file means defaults and no problems, and nothing is created", () => {
    expect(loadConfig(file)).toEqual({ config: DEFAULT_CONFIG, problems: [] });
    expect(fs.existsSync(file)).toBe(false);
    const nested = path.join(dir, "absent", "tui.toml");
    expect(loadConfig(nested)).toEqual({ config: DEFAULT_CONFIG, problems: [] });
    expect(fs.existsSync(path.join(dir, "absent"))).toBe(false);
  });

  test("defaults", () => {
    expect(DEFAULT_CONFIG).toEqual({
      keys: DEFAULT_KEYS,
      mouse: true,
      theme: null,
      themeDark: null,
      themeLight: null,
      appearance: "system",
      colors: "auto",
      transparentBackground: false,
      density: "comfortable",
      flash: true,
      bell: false,
    });
  });

  test("density: comfortable (the default) or compact; anything else keeps the default and is reported", () => {
    for (const density of ["comfortable", "compact"] as const) {
      write(`density = "${density}"\n`);
      expect(loadConfig(file)).toEqual({ config: { ...DEFAULT_CONFIG, density }, problems: [] });
    }
    for (const bad of ['"tiny"', "1", "true", '"Compact"']) {
      write(`density = ${bad}\nmouse = false\n`);
      const { config, problems } = loadConfig(file);
      expect(config.density, bad).toBe("comfortable");
      expect(config.mouse, bad).toBe(false); // the other settings still apply
      expect(problems, bad).toEqual([{ file, keyPath: "density", reason: 'must be one of "comfortable", "compact"' }]);
    }
  });

  test("blocked-transition attention: flash (default on) and bell (opt-in) are booleans", () => {
    write("bell = true\nflash = false\n");
    expect(loadConfig(file)).toMatchObject({ config: { bell: true, flash: false }, problems: [] });
    write('bell = "loud"\n');
    const { config, problems } = loadConfig(file);
    expect(config.bell).toBe(false);
    expect(problems).toEqual([{ file, keyPath: "bell", reason: "must be true or false" }]);
  });

  test("every section applies when valid", () => {
    write(`# my terminal
leader = ","
mouse = false
theme = "cortex-light"
theme_dark = "high-contrast-dark"
theme_light = "my-light_2"
appearance = "light"
colors = "256"
transparent_background = true

[keys.normal]
down = ["j", "ctrl+n"]

[keys.leader]
tags = ["g"]

[keys.insert]
save = ["alt+w"]
`);
    const { config, problems } = loadConfig(file);
    expect(problems).toEqual([]);
    expect(config.keys.leader.id).toBe(",");
    expect(config.keys.bindings.normal.down.map(k => k.id)).toEqual(["j", "ctrl+n"]);
    expect(config.keys.bindings.leader.tags.map(k => k.id)).toEqual(["g"]);
    expect(config.keys.bindings.insert.save.map(k => k.id)).toEqual(["alt+w"]);
    expect(config).toMatchObject({
      mouse: false,
      theme: "cortex-light",
      themeDark: "high-contrast-dark",
      themeLight: "my-light_2",
      appearance: "light",
      colors: "256",
      transparentBackground: true,
    });
  });

  test("each accepted value of appearance and colors", () => {
    for (const appearance of ["system", "dark", "light"]) {
      write(`appearance = "${appearance}"`);
      expect(loadConfig(file).config.appearance).toBe(appearance as "system");
    }
    for (const colors of ["auto", "truecolor", "256", "16", "none"]) {
      write(`colors = "${colors}"`);
      expect(loadConfig(file).config.colors).toBe(colors as "auto");
    }
  });

  test("an invalid section keeps its defaults, records {file, keyPath, reason}, and never blocks the others", () => {
    write(`mouse = "yes"
theme = "../../etc/passwd"
theme_dark = 7
theme_light = ""
appearance = "dim"
colors = 256
transparent_background = 1
leader = "q"

[keys.normal]
down = ["ctrl+n"]
up = ["q"]

[keys.leader]
tags = ["g"]
`);
    const { config, problems } = loadConfig(file);
    const byPath = new Map(problems.map(p => [p.keyPath, p]));
    for (const keyPath of [
      "mouse",
      "theme",
      "theme_dark",
      "theme_light",
      "appearance",
      "colors",
      "transparent_background",
      "leader",
      "keys.normal.up",
    ]) {
      expect(byPath.get(keyPath), keyPath).toMatchObject({ file, keyPath });
      expect(byPath.get(keyPath)?.reason.length).toBeGreaterThan(0);
    }
    expect(byPath.get("keys.normal.up")?.reason).toMatch(/reserved/);
    expect(byPath.get("colors")?.reason).toMatch(/"256"/);
    expect(config).toMatchObject({
      mouse: true,
      theme: null,
      themeDark: null,
      themeLight: null,
      appearance: "system",
      colors: "auto",
      transparentBackground: false,
    });
    expect(config.keys.leader.id).toBe(";");
    // [keys.normal] reverted whole: its valid remap did not apply.
    expect(config.keys.bindings.normal.down.map(k => k.id)).toEqual(["j", "down"]);
    // [keys.leader] was valid on its own.
    expect(config.keys.bindings.leader.tags.map(k => k.id)).toEqual(["g"]);
  });

  test("unknown settings are reported and ignored", () => {
    write(`colours = "none"\nmouse = false\n`);
    const { config, problems } = loadConfig(file);
    expect(problems).toEqual([{ file, keyPath: "colours", reason: expect.stringMatching(/unknown setting/) }]);
    expect(config.mouse).toBe(false);
    expect(config.colors).toBe("auto");
  });

  test("invalid TOML keeps every default; the reason carries no line or column", () => {
    write(`mouse = false\nleader = [\n`);
    const { config, problems } = loadConfig(file);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file, keyPath: "" });
    expect(problems[0].reason).toMatch(/^invalid TOML: /);
    // Bun 1.4.2's TOML errors carry the JS call site as line/column and no
    // document position (N18), so the reason must not claim one.
    expect(problems[0].reason).not.toMatch(/\bline\b|\bcolumn\b|\d+:\d+/i);
  });

  test("an unreadable path is a problem, not a crash", () => {
    fs.mkdirSync(file);
    const { config, problems } = loadConfig(file);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(problems).toEqual([{ file, keyPath: "", reason: expect.stringMatching(/cannot read/) }]);
  });

  test("the file is read-only to cortex: bytes and mtime are unchanged", () => {
    const text = `leader = ","\n[keys.normal]\nup = ["q"]\n`;
    write(text);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);
    const before = fs.statSync(file);
    loadConfig(file);
    loadConfig(file);
    const after = fs.statSync(file);
    expect(fs.readFileSync(file, "utf8")).toBe(text);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(fs.readdirSync(dir)).toEqual(["tui.toml"]);
  });

  test("a UTF-8 byte-order mark is tolerated", () => {
    write(`\ufeffmouse = false\n`);
    expect(loadConfig(file)).toMatchObject({ config: { mouse: false }, problems: [] });
  });
});
