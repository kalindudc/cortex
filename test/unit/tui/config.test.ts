import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig, SETTING_HELP, saveSettings } from "../../../src/tui/config.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";

// tui.toml is user-authored: loading never writes it, and cortex writes only
// top-level settings, surgically (saveSettings, for :config). Each
// section validates on its own; an invalid one keeps its defaults and records
// {file, keyPath, reason}. A missing file is silent.

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
      done: false,
      tasks: true,
      number: false,
      flash: true,
      bell: false,
      scroll: 3,
      sort: "id",
      group: "none",
      mode: "read",
    });
  });

  test("scroll, sort, group and mode load from tui.toml", () => {
    write('scroll = 5\nsort = "-updated"\ngroup = "lane"\nmode = "split"\n');
    expect(loadConfig(file)).toEqual({
      config: { ...DEFAULT_CONFIG, scroll: 5, sort: "-updated", group: "lane", mode: "split" },
      problems: [],
    });
    for (const scroll of [1, 20]) {
      write(`scroll = ${scroll}\n`);
      expect(loadConfig(file)).toEqual({ config: { ...DEFAULT_CONFIG, scroll }, problems: [] });
    }
  });

  test("an invalid scroll, sort, group or mode keeps the default and is reported at its key", () => {
    for (const bad of ["0", "21", "2.5", '"3"']) {
      write(`scroll = ${bad}\nmouse = false\n`);
      const { config, problems } = loadConfig(file);
      expect(config.scroll, bad).toBe(3);
      expect(config.mouse, bad).toBe(false); // the other settings still apply
      expect(problems, bad).toEqual([{ file, keyPath: "scroll", reason: "must be a whole number from 1 to 20" }]);
    }
    write('sort = "size"\ngroup = "tag"\nmode = "view"\n');
    const { config, problems } = loadConfig(file);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(problems.map(p => p.keyPath)).toEqual(["sort", "group", "mode"]);
    for (const p of problems) expect(p.reason).toMatch(/^must be one of /);
    expect(problems[0]?.reason).toMatch(/"-updated"/);
    expect(problems[2]?.reason).toBe('must be one of "read", "edit", "split"');
  });

  test("done, tasks and number are booleans; anything else keeps the default and is reported", () => {
    write("done = true\ntasks = false\nnumber = true\n");
    expect(loadConfig(file)).toEqual({
      config: { ...DEFAULT_CONFIG, done: true, tasks: false, number: true },
      problems: [],
    });
    write('done = "yes"\ntasks = 0\nnumber = [true]\n');
    const { config, problems } = loadConfig(file);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(problems).toEqual(
      ["done", "tasks", "number"].map(keyPath => ({ file, keyPath, reason: "must be true or false" })),
    );
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

  test("loadConfig never writes: bytes and mtime are unchanged", () => {
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

describe("SETTING_HELP: the tui.toml settings :help lists", () => {
  test("it lists exactly the loader's known top-level settings, leader first, each once", () => {
    // The loader names every known top-level setting when it rejects an unknown one.
    write("not_a_setting = 1\n");
    const unknown = loadConfig(file).problems.find(p => p.keyPath === "not_a_setting");
    const known = /\(known: ([^)]*)\)/.exec(unknown?.reason ?? "")?.[1]?.split(", ") ?? [];
    expect(known.length).toBeGreaterThan(0);
    const keys = SETTING_HELP.map(s => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("leader");
    expect([...keys].sort()).toEqual(known.filter(k => k !== "keys").sort()); // [keys.*] are the key tables
  });

  test("every meaning is non-empty and only the theme settings are unset by default", () => {
    for (const s of SETTING_HELP) expect(s.meaning.trim().length, s.key).toBeGreaterThan(0);
    expect(SETTING_HELP.filter(s => s.default === null).map(s => s.key)).toEqual([
      "theme",
      "theme_dark",
      "theme_light",
    ]);
  });

  test("each listed default loads without a problem and IS the default", () => {
    for (const { key, default: fallback } of SETTING_HELP) {
      if (fallback === null) continue; // unset by default
      write(`${key} = ${fallback}\n`);
      const loaded = loadConfig(file);
      expect(loaded.problems, `${key} = ${fallback}`).toEqual([]);
      expect(loaded.config, `${key} = ${fallback} is not the default`).toEqual(DEFAULT_CONFIG);
    }
  });
});

describe("saveSettings: surgical top-level edits", () => {
  const read = (): string => fs.readFileSync(file, "utf8");
  const age = (): number => {
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);
    return fs.statSync(file).mtimeMs;
  };
  const valid = (target = file): void => expect(loadConfig(target).problems).toEqual([]);

  test("a missing file: a change creates exactly its line (0600 in a new 0700 dir); no change creates nothing", () => {
    const nested = path.join(dir, "new", "tui.toml");
    expect(saveSettings(nested, { theme: null })).toEqual([]);
    expect(saveSettings(nested, {}, { onlyMissing: true })).toEqual([]);
    expect(fs.existsSync(path.join(dir, "new"))).toBe(false);
    expect(saveSettings(nested, { theme: "ansi" })).toEqual(["theme"]);
    expect(fs.readFileSync(nested, "utf8")).toBe('theme = "ansi"\n');
    expect(fs.statSync(nested).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "new")).mode & 0o777).toBe(0o700);
    valid(nested);
  });

  test("replace: only the top-level line changes, keeping its trailing comment", () => {
    const text = (theme: string): string =>
      `# my settings\n\nleader = ","\ntheme = "${theme}"  # pinned\n\n# keys\n[keys.normal]\ntheme = "quit"\n`;
    write(text("cortex-dark"));
    // The [keys.normal] `theme` line is not an action: its problem exists before and after, untouched.
    const problems = loadConfig(file).problems;
    expect(problems.map(p => p.keyPath)).toEqual(["keys.normal.theme"]);
    expect(saveSettings(file, { theme: "ansi" })).toEqual(["theme"]);
    expect(read()).toBe(text("ansi"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadConfig(file).problems).toEqual(problems);
  });

  test("insert after the last top-level key, before the first header without one, or appended", () => {
    write('# head\nleader = ","\nmouse = false\n\n# keys\n[keys.normal]\ndown = ["j", "down"]\n');
    expect(saveSettings(file, { number: true })).toEqual(["number"]);
    expect(read()).toBe(
      '# head\nleader = ","\nmouse = false\nnumber = true\n\n# keys\n[keys.normal]\ndown = ["j", "down"]\n',
    );
    valid();

    write('# head\n\n[keys.normal]\ndown = ["j", "down"]\n');
    expect(saveSettings(file, { density: "compact" })).toEqual(["density"]);
    expect(read()).toBe('# head\n\ndensity = "compact"\n\n[keys.normal]\ndown = ["j", "down"]\n');
    valid();

    write("# only a comment");
    expect(saveSettings(file, { number: true })).toEqual(["number"]);
    expect(read()).toBe("# only a comment\nnumber = true\n");
    valid();
  });

  test("remove deletes only that line; an absent key or an unchanged value writes nothing", () => {
    write('# c\ntheme = "ansi"\nmouse = false\n');
    expect(saveSettings(file, { theme: null })).toEqual(["theme"]);
    expect(read()).toBe("# c\nmouse = false\n");
    valid();
    let mtime = age();
    expect(saveSettings(file, { theme: null })).toEqual([]);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    write("# c\nnumber = true\n");
    mtime = age();
    expect(saveSettings(file, { number: true })).toEqual([]);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(read()).toBe("# c\nnumber = true\n");
  });

  test("onlyMissing skips present keys byte-for-byte and returns exactly the keys written", () => {
    write('theme = "cortex-light"   # mine\n');
    expect(saveSettings(file, { theme: "ansi", density: "compact", number: true }, { onlyMissing: true })).toEqual([
      "density",
      "number",
    ]);
    expect(read()).toBe('theme = "cortex-light"   # mine\ndensity = "compact"\nnumber = true\n');
    valid();
  });

  test("refusals change no byte: invalid TOML, an edit that would touch another line, an invalid value", () => {
    const cases: [string, Parameters<typeof saveSettings>[1], RegExp][] = [
      ["mouse = [\n", { number: true }, /not valid TOML/],
      ['leader = ","\nnote = """\ntheme = "inside"\n"""\n', { theme: "ansi" }, /by hand/],
      ["mouse = false\n", { theme: "Not Valid" }, /theme/],
    ];
    for (const [text, changes, reason] of cases) {
      write(text);
      const mtime = age();
      expect(() => saveSettings(file, changes), text).toThrow(reason);
      expect(read(), text).toBe(text);
      expect(fs.statSync(file).mtimeMs, text).toBe(mtime);
      expect(fs.readdirSync(dir), text).toEqual(["tui.toml"]);
    }
  });

  test("CRLF line endings and a leading BOM are preserved", () => {
    write('\ufeff# c\r\nmouse = false\r\ntheme = "ansi"\r\n');
    expect(saveSettings(file, { theme: "cortex-light", number: true })).toEqual(["theme", "number"]);
    expect(read()).toBe('\ufeff# c\r\nmouse = false\r\ntheme = "cortex-light"\r\nnumber = true\r\n');
    valid();
  });

  test("a symlinked tui.toml stays a link; its target holds the change", () => {
    const target = path.join(dir, "dotfiles", "tui.toml");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, "mouse = false\n");
    fs.symlinkSync(target, file);
    expect(saveSettings(file, { number: true })).toEqual(["number"]);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("mouse = false\nnumber = true\n");
    valid();
  });

  test("two writers of different keys keep both, and no temp file remains", () => {
    expect(saveSettings(file, { density: "compact" })).toEqual(["density"]);
    expect(saveSettings(file, { number: true })).toEqual(["number"]);
    expect(loadConfig(file)).toEqual({
      config: { ...DEFAULT_CONFIG, density: "compact", number: true },
      problems: [],
    });
    expect(fs.readdirSync(dir)).toEqual(["tui.toml"]);
  });

  test("every top-level setting but leader is writable: numbers, choices, booleans, theme pairs", () => {
    write('# mine\nleader = ","  # comma\nscroll = 3  # rows a notch\n\n[keys.normal]\ndown = ["j", "down"]\n');
    expect(
      saveSettings(file, { scroll: 5, sort: "-updated", theme_dark: "ansi", transparent_background: true }),
    ).toEqual(["theme_dark", "transparent_background", "scroll", "sort"]);
    expect(read()).toBe(
      '# mine\nleader = ","  # comma\nscroll = 5  # rows a notch\ntheme_dark = "ansi"\ntransparent_background = true\nsort = "-updated"\n\n[keys.normal]\ndown = ["j", "down"]\n',
    );
    valid();
    expect(loadConfig(file).config).toMatchObject({
      scroll: 5,
      sort: "-updated",
      themeDark: "ansi",
      transparentBackground: true,
    });
    expect(saveSettings(file, { done: true, tasks: false })).toEqual(["done", "tasks"]);
    expect(loadConfig(file).config).toMatchObject({ done: true, tasks: false });
    expect(saveSettings(file, { leader: "x" } as never)).toEqual([]); // the key tables stay hand-edited
  });

  test("null removes any key's line; an invalid number is refused and changes no byte", () => {
    write("# c\nbell = true\nmouse = false\n");
    expect(saveSettings(file, { bell: null })).toEqual(["bell"]);
    expect(read()).toBe("# c\nmouse = false\n");
    write("scroll = 4\n");
    const mtime = age();
    for (const scroll of [0, 21, 2.5]) {
      expect(() => saveSettings(file, { scroll }), String(scroll)).toThrow(/scroll/);
      expect(read()).toBe("scroll = 4\n");
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
    }
    expect(fs.readdirSync(dir)).toEqual(["tui.toml"]);
  });
});
