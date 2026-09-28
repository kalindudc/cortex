// tui.toml loader (plan @400 N15/N18/N22/N23). The file is user-authored and
// read-only to cortex: it is only ever read, never created or rewritten.
//
// Every section validates on its own: `leader`, `[keys.normal]`,
// `[keys.leader]`, `[keys.insert]`, `[keys.visual]` (src/tui/keys.ts), and each top-level
// setting (the theme, appearance, colors, density, mouse and attention settings). An invalid section keeps its defaults and records a problem
// {file, keyPath, reason} for the `:messages` view; it never applies
// partially and never blocks the other sections. A missing file means the
// defaults, silently. On Bun 1.4.2 a `Bun.TOML.parse` error's `line` and
// `column` are the JS call site and its message has no document position, so
// syntax errors are reported without a line.

import fs from "node:fs";
import { DEFAULT_KEYS, parseKeys, type KeyConfig } from "./keys.ts";

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
  /** `theme`: pins a theme for every session (an explicit choice). */
  readonly theme: string | null;
  /** `theme_dark` / `theme_light`: the pair used by appearance when no theme is explicit. */
  readonly themeDark: string | null;
  readonly themeLight: string | null;
  readonly appearance: Appearance;
  readonly colors: ColorSetting;
  /** Leave the `bg` surface to the terminal; its contrast cannot be verified. */
  readonly transparentBackground: boolean;
  /**
   * `density`: the spacing when the profile has no saved `:density` choice (that choice wins): `"comfortable"`
   * adds blank rows under the headers and above the status line, and margins at both ends of the status and
   * hint lines; `"compact"` leaves them out.
   */
  readonly density: Density;
  /** Flash the status line when a task becomes blocked (the web raises a desktop alert then). */
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

type Setting = { key: string; apply(value: unknown, out: Mutable<TuiConfig>): string | null };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const themeSetting = (key: string, field: "theme" | "themeDark" | "themeLight"): Setting => ({
  key,
  apply(value, out) {
    if (!isThemeName(value)) return "must be a theme name: lowercase letters, digits, '-' or '_'";
    out[field] = value;
    return null;
  },
});

const booleanSetting = (key: string, field: "mouse" | "transparentBackground" | "flash" | "bell"): Setting => ({
  key,
  apply(value, out) {
    if (typeof value !== "boolean") return "must be true or false";
    out[field] = value;
    return null;
  },
});

// Top-level settings besides `leader` and `keys` (validated by parseKeys).
const SETTINGS: readonly Setting[] = [
  booleanSetting("mouse", "mouse"),
  themeSetting("theme", "theme"),
  themeSetting("theme_dark", "themeDark"),
  themeSetting("theme_light", "themeLight"),
  {
    key: "appearance",
    apply(value, out) {
      if (!(APPEARANCES as readonly unknown[]).includes(value)) return `must be one of ${quoteAll(APPEARANCES)}`;
      out.appearance = value as Appearance;
      return null;
    },
  },
  {
    key: "colors",
    apply(value, out) {
      if (!(COLOR_SETTINGS as readonly unknown[]).includes(value)) return `must be one of ${quoteAll(COLOR_SETTINGS)}`;
      out.colors = value as ColorSetting;
      return null;
    },
  },
  booleanSetting("transparent_background", "transparentBackground"),
  {
    key: "density",
    apply(value, out) {
      if (!isDensity(value)) return `must be one of ${quoteAll(DENSITIES)}`;
      out.density = value;
      return null;
    },
  },
  booleanSetting("flash", "flash"),
  booleanSetting("bell", "bell"),
];
const KNOWN = new Set(["leader", "keys", ...SETTINGS.map(s => s.key)]);

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
  let root: unknown;
  try {
    root = Bun.TOML.parse(read.text.replace(/^\ufeff/, ""));
  } catch (err) {
    const message = String((err as Error).message ?? err).replace(/^TOML Parse error:\s*/, "");
    return { config: DEFAULT_CONFIG, problems: [{ file, keyPath: "", reason: `invalid TOML: ${message}` }] };
  }
  const problems: ConfigProblem[] = [];
  const table = (root ?? {}) as Record<string, unknown>;
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
