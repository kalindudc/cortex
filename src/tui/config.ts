// tui.toml loader and writer. The file is user-authored:
// cortex writes ONLY the top-level settings the TUI changes, surgically (saveSettings).
//
// Every section validates on its own: `leader`, `[keys.normal]`,
// `[keys.leader]`, `[keys.insert]`, `[keys.visual]` (src/tui/keys.ts), and each top-level
// setting (the theme, appearance, colors, density, mouse and attention settings). An invalid section keeps its defaults and records a problem
// {file, keyPath, reason} for the `:messages` view; it never applies
// partially and never blocks the other sections. A missing file means the
// defaults, silently. On Bun 1.4.2 a `Bun.TOML.parse` error's `line` and
// `column` are the JS call site and its message has no document position, so
// syntax errors are reported without a line.
//
// saveSettings edits single top-level `key = value` lines and keeps every
// other byte (comments, blank lines, tables). Bun.TOML.stringify would drop
// every comment, so it only renders the one line; a parse-equality guard
// refuses any edit that would change anything but the requested keys.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_KEYS, DEFAULT_LEADER, parseKeys, type KeyConfig } from "./keys.ts";

export type Appearance = "system" | "dark" | "light";
export type ColorSetting = "auto" | "truecolor" | "256" | "16" | "none";
/**
 * The workspace's spacing (a terminal cannot set its font size): comfortable
 * (the default) adds blank rows under the list header and the document header
 * and above the status line, and margins at both ends of the status and hint
 * lines; compact leaves them out.
 */
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const isDensity = (value: unknown): value is Density => (DENSITIES as readonly unknown[]).includes(value);

export interface TuiConfig {
  readonly keys: KeyConfig;
  /** Mouse support (optional; never the only path to an action). */
  readonly mouse: boolean;
  /** `theme`: pins a theme for every session (an explicit choice); `:theme <name>` writes it, `:theme auto` removes it. */
  readonly theme: string | null;
  /** `theme_dark` / `theme_light`: the pair used by appearance when no theme is explicit. */
  readonly themeDark: string | null;
  readonly themeLight: string | null;
  readonly appearance: Appearance;
  readonly colors: ColorSetting;
  /** Leave the `bg` surface to the terminal; its contrast cannot be verified. */
  readonly transparentBackground: boolean;
  /**
   * `density` (`:density` writes it): `"comfortable"` adds blank rows under the headers and above the status
   * line, and margins at both ends of the status and hint lines; `"compact"` leaves them out.
   */
  readonly density: Density;
  /** `done`: start with done tasks shown in the task list (`:set done` and `;d` change it for the session only). */
  readonly done: boolean;
  /** `tasks`: start with the task list shown (`:set tasks` and `;e` change it for the session only). */
  readonly tasks: boolean;
  /** `number`: source line numbers in Read and the Split preview (`:set number`). */
  readonly number: boolean;
  /** Flash the status line when a task becomes blocked. */
  readonly flash: boolean;
  /** Also ring the terminal bell when a task becomes blocked (opt-in). */
  readonly bell: boolean;
}

export interface ConfigProblem {
  readonly file: string;
  /** Dotted tui.toml path of the rejected section or setting; "" for the whole file. */
  readonly keyPath: string;
  readonly reason: string;
}

export const DEFAULT_CONFIG: TuiConfig = {
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
};

/** Theme names are lowercase file-name-safe words: `cortex-dark`, `my_theme2`. */
export function isThemeName(name: unknown): name is string {
  return typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
}

const APPEARANCES: readonly Appearance[] = ["system", "dark", "light"];
const COLOR_SETTINGS: readonly ColorSetting[] = ["auto", "truecolor", "256", "16", "none"];
const MAX_CONFIG_BYTES = 1024 * 1024;

const quoteAll = (values: readonly string[]): string => values.map(v => JSON.stringify(v)).join(", ");

/** A tui.toml top-level setting as :help lists it: `default` is its TOML literal (null = unset). */
export interface SettingHelp {
  readonly key: string;
  readonly default: string | null;
  readonly meaning: string;
}
/** A top-level setting: its help (key, default, meaning) and its validator. */
type Setting = SettingHelp & { apply(value: unknown, out: Mutable<TuiConfig>): string | null };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const themeSetting = (key: string, field: "theme" | "themeDark" | "themeLight", meaning: string): Setting => ({
  key,
  default: null,
  meaning,
  apply(value, out) {
    if (!isThemeName(value)) return "must be a theme name: lowercase letters, digits, '-' or '_'";
    out[field] = value;
    return null;
  },
});

type BooleanField = "mouse" | "transparentBackground" | "flash" | "bell" | "done" | "tasks" | "number";
const booleanSetting = (key: string, field: BooleanField, meaning: string): Setting => ({
  key,
  default: JSON.stringify(DEFAULT_CONFIG[field]),
  meaning,
  apply(value, out) {
    if (typeof value !== "boolean") return "must be true or false";
    out[field] = value;
    return null;
  },
});

// Top-level settings besides `leader` and `keys` (validated by parseKeys).
const SETTINGS: readonly Setting[] = [
  booleanSetting(
    "mouse",
    "mouse",
    "The mouse: clicks, drags, the wheel and the view tabs (every action also has a key or command)",
  ),
  themeSetting(
    "theme",
    "theme",
    "Pin a theme (bundled or custom) for every session; :theme writes it, :theme auto removes it",
  ),
  themeSetting("theme_dark", "themeDark", "The theme for a dark terminal when no theme is pinned (unset: cortex-dark)"),
  themeSetting(
    "theme_light",
    "themeLight",
    "The theme for a light terminal when no theme is pinned (unset: cortex-light)",
  ),
  {
    key: "appearance",
    default: JSON.stringify(DEFAULT_CONFIG.appearance),
    meaning: '"system" follows the terminal\'s reported appearance (and its live changes); "dark" or "light" fixes it',
    apply(value, out) {
      if (!(APPEARANCES as readonly unknown[]).includes(value)) return `must be one of ${quoteAll(APPEARANCES)}`;
      out.appearance = value as Appearance;
      return null;
    },
  },
  {
    key: "colors",
    default: JSON.stringify(DEFAULT_CONFIG.colors),
    meaning: '"auto" detects the color depth; "truecolor", "256", "16" force one; "none" turns colors off',
    apply(value, out) {
      if (!(COLOR_SETTINGS as readonly unknown[]).includes(value)) return `must be one of ${quoteAll(COLOR_SETTINGS)}`;
      out.colors = value as ColorSetting;
      return null;
    },
  },
  booleanSetting(
    "transparent_background",
    "transparentBackground",
    "Leave the background to the terminal (its contrast cannot be checked)",
  ),
  {
    key: "density",
    default: JSON.stringify(DEFAULT_CONFIG.density),
    meaning:
      'The spacing (:density writes it): "comfortable" adds blank rows under the headers and above the status line, and margins at both ends of the status and hint lines; "compact" leaves them out',
    apply(value, out) {
      if (!isDensity(value)) return `must be one of ${quoteAll(DENSITIES)}`;
      out.density = value;
      return null;
    },
  },
  booleanSetting("flash", "flash", "Flash the status line when a task becomes blocked"),
  booleanSetting("bell", "bell", "Also ring the terminal bell when a task becomes blocked"),
  booleanSetting("done", "done", "Start with done tasks shown (:set done and ;d change it for the session only)"),
  booleanSetting("tasks", "tasks", "Start with the task list shown (:set tasks and ;e change it for the session only)"),
  booleanSetting("number", "number", "Source line numbers in Read and the Split preview (:set number writes it)"),
];
const KNOWN = new Set(["leader", "keys", ...SETTINGS.map(s => s.key)]);

/** Every top-level setting in help order: `leader` (parsed by keys.ts), then SETTINGS; `[keys.*]` are the key tables. */
export const SETTING_HELP: readonly SettingHelp[] = [
  { key: "leader", default: JSON.stringify(DEFAULT_LEADER), meaning: "The leader key for the [keys.leader] table" },
  ...SETTINGS.map(({ key, default: fallback, meaning }) => ({ key, default: fallback, meaning })),
];

function readText(file: string): { text: string } | { missing: true } | { error: string } {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { error: "cannot read it: not a regular file" };
    if (st.size > MAX_CONFIG_BYTES) return { error: `cannot read it: larger than ${MAX_CONFIG_BYTES} bytes` };
    return { text: fs.readFileSync(file, "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { missing: true };
    return { error: `cannot read it: ${code ?? (err as Error).message}` };
  }
}

/** Read and validate a tui.toml. Never writes; never throws for file content. */
export function loadConfig(file: string): { config: TuiConfig; problems: ConfigProblem[] } {
  const read = readText(file);
  if ("missing" in read) return { config: DEFAULT_CONFIG, problems: [] };
  if ("error" in read) return { config: DEFAULT_CONFIG, problems: [{ file, keyPath: "", reason: read.error }] };
  const parsed = parseToml(read.text);
  if ("error" in parsed) {
    return { config: DEFAULT_CONFIG, problems: [{ file, keyPath: "", reason: `invalid TOML: ${parsed.error}` }] };
  }
  return validateConfig(parsed.table, file);
}

/** Parse tui.toml text (a leading BOM is tolerated); the error drops Bun's "TOML Parse error:" prefix. */
function parseToml(text: string): { table: Record<string, unknown> } | { error: string } {
  try {
    return { table: (Bun.TOML.parse(text.replace(/^\ufeff/, "")) ?? {}) as Record<string, unknown> };
  } catch (err) {
    return { error: String((err as Error).message ?? err).replace(/^TOML Parse error:\s*/, "") };
  }
}

/** Validate a parsed tui.toml: every section on its own, each invalid one keeping its defaults. */
function validateConfig(
  table: Record<string, unknown>,
  file: string,
): { config: TuiConfig; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = [];
  const keys = parseKeys(table);
  for (const p of keys.problems) problems.push({ file, keyPath: p.keyPath, reason: p.reason });
  const config: Mutable<TuiConfig> = { ...DEFAULT_CONFIG, keys: keys.keys };
  for (const setting of SETTINGS) {
    if (!Object.hasOwn(table, setting.key)) continue;
    const reason = setting.apply(table[setting.key], config);
    if (reason !== null) problems.push({ file, keyPath: setting.key, reason });
  }
  for (const key of Object.keys(table)) {
    if (!KNOWN.has(key)) {
      problems.push({ file, keyPath: key, reason: `unknown setting (known: ${[...KNOWN].join(", ")})` });
    }
  }
  return { config, problems };
}

/** Write `data` to `file` atomically: a private 0600 temp file beside it (0700 dirs), fsync, rename. */
export function writeAtomically(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | null = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The settings the TUI writes back: top-level keys named like their TuiConfig fields. `done` and `tasks`
 * are deliberately absent: they are startup filters, and toggling them in a session never writes the file.
 */
export const WRITABLE_SETTINGS = ["theme", "density", "number"] as const;
export type SettingChanges = Partial<Pick<TuiConfig, (typeof WRITABLE_SETTINGS)[number]>>;

// A simple scalar value and its optional trailing comment; replacing such a value keeps the comment.
const SIMPLE_VALUE = /^[ \t]*=[ \t]*(?:"[^"\\\n]*"|'[^'\n]*'|true|false|[A-Za-z0-9_-]+)([ \t]*#.*)?$/;
const HEADER = /^[ \t]*\[/;
// A top-level key line: not a comment, and it assigns.
const isKeyLine = (line: string): boolean => /^[ \t]*[^#\s]/.test(line) && line.includes("=");

/** A symlinked tui.toml (a dotfiles repo) stays a link: its target is the file that is replaced. */
function resolveLink(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return file;
    throw new Error(`cannot resolve it: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

/**
 * Write `changes` into tui.toml surgically; a null `theme` removes its line. Re-reads the file first.
 * Returns the keys written ([]: nothing was written). Throws a user-facing reason, changing nothing, when
 * the file cannot be read, is not valid TOML, or the edit would change anything else.
 */
export function saveSettings(file: string, changes: SettingChanges, options: { onlyMissing?: boolean } = {}): string[] {
  const target = resolveLink(file);
  const read = readText(target);
  if ("error" in read) throw new Error(read.error);
  const text = "missing" in read ? "" : read.text;
  const before = parseToml(text);
  if ("error" in before) throw new Error(`not valid TOML (${before.error}), so it was not changed`);
  const has = (key: string): boolean => Object.hasOwn(before.table, key);
  const keys = WRITABLE_SETTINGS.filter(key => {
    const value = changes[key];
    if (value === undefined || (options.onlyMissing && has(key))) return false;
    return value === null ? has(key) : before.table[key] !== value;
  });
  if (keys.length === 0) return [];

  const bom = text.startsWith("\ufeff") ? "\ufeff" : "";
  // Lines keep their own "\r", so untouched lines stay byte-identical; new lines follow the file's EOL.
  const cr = text.includes("\r\n") ? "\r" : "";
  const lines = text.slice(bom.length).split("\n");
  if (lines.at(-1) === "") lines.pop();
  else if (lines.length > 0) lines[lines.length - 1] += cr;
  const render = (key: (typeof keys)[number]): string => {
    const line = Bun.TOML.stringify({ [key]: changes[key] });
    if (line === undefined) throw new Error(`${key}: cannot be written as TOML`);
    return line.trimEnd();
  };
  for (const key of keys) {
    const header = lines.findIndex(line => HEADER.test(line));
    const top = header < 0 ? lines.length : header;
    const pattern = new RegExp(`^[ \\t]*(?:${key}|"${key}"|'${key}')(?=[ \\t]*=)`);
    const at = lines.slice(0, top).findIndex(line => pattern.test(line));
    if (changes[key] === null) {
      if (at >= 0) lines.splice(at, 1); // not found on a top-level line: the guard refuses it
    } else if (at >= 0) {
      const line = lines[at];
      const ending = line.endsWith("\r") ? "\r" : "";
      const rest = line.slice(0, line.length - ending.length).replace(pattern, "");
      lines[at] = `${render(key)}${SIMPLE_VALUE.exec(rest)?.[1] ?? ""}${ending}`;
    } else {
      const last = lines.slice(0, top).findLastIndex(isKeyLine);
      if (last >= 0) lines.splice(last + 1, 0, `${render(key)}${cr}`);
      else if (header >= 0) lines.splice(header, 0, `${render(key)}${cr}`, cr);
      else lines.push(`${render(key)}${cr}`);
    }
  }
  const next = bom + lines.map(line => `${line}\n`).join("");

  // The guard: the edit must change exactly the requested keys (a key line inside a multi-line
  // string, say, would change another value), and each written value must be valid.
  const expected: Record<string, unknown> = { ...before.table };
  for (const key of keys) {
    if (changes[key] === null) delete expected[key];
    else expected[key] = changes[key];
  }
  const after = parseToml(next);
  if ("error" in after || !Bun.deepEquals(after.table, expected, true)) {
    const wanted = keys.map(key => (changes[key] === null ? `remove ${key}` : `set ${render(key)}`)).join(" and ");
    throw new Error(`could not change ${keys.join(", ")} without touching other lines; ${wanted} in ${file} by hand`);
  }
  const invalid = validateConfig(after.table, file).problems.find(p => (keys as string[]).includes(p.keyPath));
  if (invalid !== undefined) throw new Error(`${invalid.keyPath}: ${invalid.reason}`);
  writeAtomically(target, next);
  return keys;
}
