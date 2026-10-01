// Terminal themes: data over semantic tokens.
//
// - Components never embed colors: they call `style(theme, pair, text)` with a
//   pair declared in CONTRAST_PAIRS, on text already escaped by
//   src/tui/safety.ts, and never emit raw SGR.
// - Values are `#rrggbb`, `ansi:0`..`ansi:15` (the terminal's palette) or
//   `default` (the terminal's own foreground/background, SGR 39/49).
// - Bundled: cortex-dark/cortex-light (cortex's own palette, adjusted where a
//   contrast gate fails; see test/unit/tui/theme.test.ts),
//   high-contrast-dark/-light and ansi. Every bundled hex theme passes every
//   pair in truecolor AND after 256-color mapping.
// - Custom `themesDir()/<name>.toml` themes must resolve every token and may
//   `extends` ONE bundled theme; bundled names win; syntax or completeness
//   errors reject the theme; low contrast only warns.
// - State is never tint-only: without color (`none`, or `default` surfaces)
//   style() adds inverse/underline/bold/dim so every state stays visible.
// - The unfocused pane is painted through inactiveTheme(): every foreground
//   becomes the `inactive` grey (an indicator-class token, >= 3:1), nothing
//   is bold, and where there is no color to grey (`none`, `default` values)
//   every run is SGR dim. Custom themes without `inactive` derive it from `dim`.

import fs from "node:fs";
import path from "node:path";
import { themesDir } from "../paths.ts";
import { isThemeName, type ColorSetting, type TuiConfig } from "./config.ts";
import { displayWidth, fitWidth } from "./safety.ts";

export const THEME_TOKENS = [
  "bg",
  "panel",
  "raised",
  "border",
  "text",
  "muted",
  "dim",
  "inactive",
  "accent",
  "info",
  "warn",
  "danger",
  "selection",
  "search",
  "status.draft",
  "status.open",
  "status.review",
  "status.blocked",
  "status.done",
  "mode.normal",
  "mode.insert",
  "mode.command",
  "mode.search",
  "md.heading",
  "md.link",
  "md.code",
  "md.quote",
  "md.bullet",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export type ColorMode = "truecolor" | "256" | "16" | "none";
export type ThemeColors = Readonly<Record<ThemeToken, string>>;

export interface ThemeDefinition {
  readonly name: string;
  /** `terminal`: follows the terminal's own palette (the ansi theme). */
  readonly appearance: "dark" | "light" | "terminal";
  /** Text pairs need 7:1 instead of 4.5:1. */
  readonly highContrast: boolean;
  readonly colors: ThemeColors;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const ANSI = /^ansi:(?:[0-9]|1[0-5])$/;

/** `#rrggbb`, `ansi:0`..`ansi:15` or `default`. */
export function isThemeColor(value: unknown): value is string {
  return typeof value === "string" && (HEX.test(value) || ANSI.test(value) || value === "default");
}

// ---------- contrast pairs ----------

export type ContrastKind = "text" | "indicator" | "decorative";
const MINIMUM: Readonly<Record<ContrastKind, number>> = { text: 4.5, indicator: 3, decorative: 1 };
/** WCAG 1.4.6 (AAA) text contrast, required of high-contrast themes. */
export const HIGH_CONTRAST_TEXT_MIN = 7;

export interface ContrastSpec {
  readonly fg: ThemeToken;
  readonly surface: ThemeToken;
  /** The minimum for ordinary themes (see `requiredContrast` for high-contrast ones). */
  readonly min: number;
  readonly kind: ContrastKind;
}

/** `<fg>@<surface>` specs for one foreground on each surface; the key type follows the arguments. */
function on<const F extends ThemeToken, const S extends readonly ThemeToken[]>(
  fg: F,
  surfaces: S,
  kind: ContrastKind = "text",
): { readonly [K in S[number] as `${F}@${K}`]: ContrastSpec } {
  const entries = surfaces.map(surface => [`${fg}@${surface}`, { fg, surface, min: MINIMUM[kind], kind }]);
  return Object.fromEntries(entries) as unknown as { readonly [K in S[number] as `${F}@${K}`]: ContrastSpec };
}

const ROLE_SURFACES = ["bg", "panel", "raised", "selection"] as const;

// Every rendered foreground/surface combination. Colored text (roles,
// statuses, modes, links) is declared on every surface it appears on;
// `accent@selection` is the selected-row marker (a non-text indicator);
// borders are decorative and exempt.
const PAIR_TABLE = {
  ...on("text", ["bg", "panel", "raised", "selection", "search"]),
  ...on("muted", ROLE_SURFACES),
  ...on("dim", ["bg", "panel", "raised"]),
  // The unfocused pane's grey (inactiveTheme): readable, but an indicator, not body text.
  ...on("inactive", ["bg", "panel", "raised", "selection"], "indicator"),
  ...on("accent", ["bg", "panel", "raised"]),
  ...on("accent", ["selection"], "indicator"),
  ...on("info", ROLE_SURFACES),
  ...on("warn", ROLE_SURFACES),
  ...on("danger", ROLE_SURFACES),
  ...on("status.draft", ROLE_SURFACES),
  ...on("status.open", ROLE_SURFACES),
  ...on("status.review", ROLE_SURFACES),
  ...on("status.blocked", ROLE_SURFACES),
  ...on("status.done", ROLE_SURFACES),
  ...on("mode.normal", ["panel"]),
  ...on("mode.insert", ["panel"]),
  ...on("mode.command", ["panel"]),
  ...on("mode.search", ["panel"]),
  ...on("md.heading", ["bg"]),
  ...on("md.link", ["bg", "selection"]),
  ...on("md.code", ["bg", "raised"]),
  ...on("md.quote", ["bg"]),
  ...on("md.bullet", ["bg"]),
  ...on("border", ["bg", "panel", "raised"], "decorative"),
};

/** Declared pairs, named `<fg token>@<surface token>`. */
export type ContrastPair = keyof typeof PAIR_TABLE;

export const CONTRAST_PAIRS: Readonly<Record<ContrastPair, ContrastSpec>> = PAIR_TABLE;

/** The contrast a theme must reach for a pair: text 4.5:1 (7:1 in high-contrast themes), indicators 3:1. */
export function requiredContrast(theme: { readonly highContrast: boolean }, pair: ContrastPair): number {
  const spec = CONTRAST_PAIRS[pair];
  return spec.kind === "text" && theme.highContrast ? HIGH_CONTRAST_TEXT_MIN : spec.min;
}

// ---------- bundled themes ----------

// Status and role colors: draft=info, open=text-3, review=warn, blocked=err,
// done=ok. Values that failed a gate are adjusted;
// test/unit/tui/theme.test.ts records each adjustment.
const CORTEX_DARK: ThemeColors = {
  bg: "#1d1f24",
  panel: "#24262b",
  raised: "#2c2e34",
  border: "#43454c",
  text: "#dadbe0",
  muted: "#989aa0",
  dim: "#98949f",
  inactive: "#8a8c93",
  accent: "#f5a47e",
  info: "#7e9cb6",
  warn: "#d8a558",
  danger: "#e08580",
  selection: "#242f4a",
  search: "#4d3f14",
  "status.draft": "#7e9cb6",
  "status.open": "#95979f",
  "status.review": "#d8a558",
  "status.blocked": "#e08580",
  "status.done": "#7eaa6c",
  "mode.normal": "#f5a47e",
  "mode.insert": "#7eaa6c",
  "mode.command": "#7e9cb6",
  "mode.search": "#d8a558",
  // Headings stand apart from body text (a terminal can only color them, not size them).
  "md.heading": "#94b8e0",
  "md.link": "#f5a47e",
  "md.code": "#f5a47e",
  "md.quote": "#989aa0",
  "md.bullet": "#f5a47e",
};

const CORTEX_LIGHT: ThemeColors = {
  bg: "#f6f2ec",
  panel: "#efe9dd",
  raised: "#e7e0d0",
  border: "#bdb19a",
  text: "#2c2820",
  muted: "#56503f",
  dim: "#696352",
  inactive: "#736d5f",
  accent: "#a82e1b",
  info: "#2f637e",
  warn: "#725a01",
  danger: "#992f2d",
  selection: "#cfd9e8",
  search: "#f1d98f",
  "status.draft": "#2f637e",
  "status.open": "#665d4c",
  "status.review": "#725a01",
  "status.blocked": "#992f2d",
  "status.done": "#2e691e",
  "mode.normal": "#a82e1b",
  "mode.insert": "#2e691e",
  "mode.command": "#2f637e",
  "mode.search": "#725a01",
  "md.heading": "#1f4e79",
  "md.link": "#7e2e06",
  "md.code": "#7e2e06",
  "md.quote": "#56503f",
  "md.bullet": "#7e2e06",
};

const HIGH_CONTRAST_DARK: ThemeColors = {
  bg: "#000000",
  panel: "#0c0c0c",
  raised: "#161616",
  border: "#8a8a8a",
  text: "#ffffff",
  muted: "#e0e0e0",
  dim: "#c8c8c8",
  inactive: "#a6a6a6",
  accent: "#ffb27a",
  info: "#9fcfff",
  warn: "#ffd66b",
  danger: "#ff9e9e",
  selection: "#15294a",
  search: "#443706",
  "status.draft": "#9fcfff",
  "status.open": "#e0e0e0",
  "status.review": "#ffd66b",
  "status.blocked": "#ff9e9e",
  "status.done": "#9fe38a",
  "mode.normal": "#ffb27a",
  "mode.insert": "#9fe38a",
  "mode.command": "#9fcfff",
  "mode.search": "#ffd66b",
  "md.heading": "#ffffff",
  "md.link": "#ffb27a",
  "md.code": "#ffd66b",
  "md.quote": "#e0e0e0",
  "md.bullet": "#ffb27a",
};

const HIGH_CONTRAST_LIGHT: ThemeColors = {
  bg: "#ffffff",
  panel: "#f4f4f4",
  raised: "#eaeaea",
  border: "#5c5c5c",
  text: "#000000",
  muted: "#262626",
  dim: "#383838",
  inactive: "#5a5a5a",
  accent: "#7a2600",
  info: "#0b2f8c",
  warn: "#592f00",
  danger: "#8a0000",
  selection: "#d2e3ff",
  search: "#ffe98a",
  "status.draft": "#0b2f8c",
  "status.open": "#262626",
  "status.review": "#592f00",
  "status.blocked": "#8a0000",
  "status.done": "#254d12",
  "mode.normal": "#7a2600",
  "mode.insert": "#254d12",
  "mode.command": "#0b2f8c",
  "mode.search": "#592f00",
  "md.heading": "#000000",
  "md.link": "#7a2600",
  "md.code": "#592f00",
  "md.quote": "#262626",
  "md.bullet": "#7a2600",
};

// The terminal's own colors: surfaces and body text are `default`
// (muted/dim/border render with SGR dim, selection/search with inverse);
// the palette is used only for roles and statuses.
const ANSI_THEME: ThemeColors = {
  bg: "default",
  panel: "default",
  raised: "default",
  border: "default",
  text: "default",
  muted: "default",
  dim: "default",
  inactive: "default",
  accent: "ansi:5",
  info: "ansi:4",
  warn: "ansi:3",
  danger: "ansi:1",
  selection: "default",
  search: "default",
  "status.draft": "ansi:4",
  "status.open": "default",
  "status.review": "ansi:3",
  "status.blocked": "ansi:1",
  "status.done": "ansi:2",
  "mode.normal": "ansi:4",
  "mode.insert": "ansi:2",
  "mode.command": "ansi:5",
  "mode.search": "ansi:3",
  "md.heading": "default",
  "md.link": "ansi:4",
  "md.code": "ansi:6",
  "md.quote": "default",
  "md.bullet": "ansi:5",
};

export const BUNDLED_THEME_NAMES = [
  "cortex-dark",
  "cortex-light",
  "high-contrast-dark",
  "high-contrast-light",
  "ansi",
] as const;
export type BundledThemeName = (typeof BUNDLED_THEME_NAMES)[number];

export const BUNDLED_THEMES: Readonly<Record<BundledThemeName, ThemeDefinition>> = {
  "cortex-dark": { name: "cortex-dark", appearance: "dark", highContrast: false, colors: CORTEX_DARK },
  "cortex-light": { name: "cortex-light", appearance: "light", highContrast: false, colors: CORTEX_LIGHT },
  "high-contrast-dark": {
    name: "high-contrast-dark",
    appearance: "dark",
    highContrast: true,
    colors: HIGH_CONTRAST_DARK,
  },
  "high-contrast-light": {
    name: "high-contrast-light",
    appearance: "light",
    highContrast: true,
    colors: HIGH_CONTRAST_LIGHT,
  },
  ansi: { name: "ansi", appearance: "terminal", highContrast: false, colors: ANSI_THEME },
};

const isBundled = (name: string): name is BundledThemeName => (BUNDLED_THEME_NAMES as readonly string[]).includes(name);

// ---------- color math ----------

type Rgb = readonly [number, number, number];

function parseHex(color: string): Rgb {
  if (!HEX.test(color)) throw new TypeError(`not a #rrggbb color: ${JSON.stringify(color)}`);
  return [1, 3, 5].map(i => Number.parseInt(color.slice(i, i + 2), 16)) as unknown as Rgb;
}

const toHex = (rgb: Rgb): string => `#${rgb.map(c => c.toString(16).padStart(2, "0")).join("")}`;

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio of two `#rrggbb` colors (1 to 21). Throws for palette/default values. */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(parseHex(foreground));
  const b = luminance(parseHex(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const CUBE = [0, 95, 135, 175, 215, 255] as const;
const distance2 = (a: Rgb, b: Rgb): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** The xterm-256 color (16-255; never the user-defined 0-15) nearest to a `#rrggbb` color. */
export function to256(color: string): number {
  const rgb = parseHex(color);
  const level = (c: number): number => {
    let best = 0;
    for (let i = 1; i < CUBE.length; i++) if (Math.abs(CUBE[i] - c) < Math.abs(CUBE[best] - c)) best = i;
    return best;
  };
  const [r, g, b] = rgb.map(level);
  const cube = 16 + 36 * r + 6 * g + b;
  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const gray = 232 + Math.max(0, Math.min(23, Math.round((mean - 8) / 10)));
  return distance2(rgb, parseHex(xterm256Hex(gray))) < distance2(rgb, parseHex(xterm256Hex(cube))) ? gray : cube;
}

/** `#rrggbb` of an xterm-256 color index 16-255. */
export function xterm256Hex(index: number): string {
  if (!Number.isInteger(index) || index < 16 || index > 255)
    throw new RangeError(`xterm-256 index out of range: ${index}`);
  if (index >= 232) {
    const v = 8 + 10 * (index - 232);
    return toHex([v, v, v]);
  }
  const i = index - 16;
  return toHex([CUBE[Math.floor(i / 36)], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]]);
}

// xterm's default 16 colors, the reference for nearest-color mapping.
const XTERM_16: readonly Rgb[] = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
].map(parseHex);

/** The standard 16-color index (0-15) nearest to a `#rrggbb` color. */
export function to16(color: string): number {
  const rgb = parseHex(color);
  let best = 0;
  for (let i = 1; i < XTERM_16.length; i++) if (distance2(rgb, XTERM_16[i]) < distance2(rgb, XTERM_16[best])) best = i;
  return best;
}

// ---------- color mode ----------

export interface ColorEnvironment {
  readonly NO_COLOR?: string;
  readonly COLORTERM?: string;
  readonly TERM?: string;
}

/**
 * The color mode for a `colors` setting: an explicit value wins (it overrides
 * NO_COLOR, as no-color.org allows); `auto` gives none for a non-empty
 * NO_COLOR, truecolor for COLORTERM truecolor/24bit or a 24-bit TERM
 * (xterm-kitty, xterm-ghostty, ncurses *-direct: COLORTERM rarely crosses
 * SSH), 256 for any other *256color TERM, else 16. `dumb` reports TERM=dumb
 * so the command can refuse the TUI.
 */
export function detectColorMode(setting: ColorSetting, env: ColorEnvironment): { mode: ColorMode; dumb: boolean } {
  const term = env.TERM ?? "";
  const dumb = term === "dumb";
  if (setting !== "auto") return { mode: setting, dumb };
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return { mode: "none", dumb };
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return { mode: "truecolor", dumb };
  if (term === "xterm-kitty" || term === "xterm-ghostty" || term.endsWith("-direct"))
    return { mode: "truecolor", dumb };
  if (term.includes("256color")) return { mode: "256", dumb };
  return { mode: "16", dumb };
}

// ---------- custom themes ----------

export interface ThemeProblem {
  /** The theme file, when the problem is in one. */
  readonly file: string | null;
  readonly theme: string;
  /** Dotted token path in the theme file ("" for the whole theme). */
  readonly keyPath: string;
  readonly reason: string;
  /** error: the theme is rejected; warning: used anyway; notice: informational. */
  readonly severity: "error" | "warning" | "notice";
}

const MAX_THEME_BYTES = 256 * 1024;
/** Tokens added after custom themes existed: a theme that omits one gets it from another token. */
const DERIVED_TOKENS: Partial<Record<ThemeToken, ThemeToken>> = { inactive: "dim" };
const THEME_META = new Set(["extends", "appearance", "high_contrast"]);

const isTable = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function tokenValue(root: Record<string, unknown>, token: ThemeToken): unknown {
  const dot = token.indexOf(".");
  if (dot < 0) return root[token];
  const table = root[token.slice(0, dot)];
  return isTable(table) ? table[token.slice(dot + 1)] : undefined;
}

function unknownKeys(root: Record<string, unknown>): string[] {
  const out: string[] = [];
  const tokens = new Set<string>(THEME_TOKENS);
  const tables = new Set(THEME_TOKENS.filter(t => t.includes(".")).map(t => t.slice(0, t.indexOf("."))));
  for (const [key, value] of Object.entries(root)) {
    if (THEME_META.has(key) || tokens.has(key)) continue;
    if (tables.has(key) && isTable(value)) {
      for (const sub of Object.keys(value)) if (!tokens.has(`${key}.${sub}`)) out.push(`${key}.${sub}`);
    } else out.push(key);
  }
  return out;
}

/** Contrast warnings for a custom theme: hex pairs below their minimum. Palette/default pairs are exempt. */
function contrastWarnings(theme: ThemeDefinition, file: string | null): ThemeProblem[] {
  const out: ThemeProblem[] = [];
  for (const pair of Object.keys(CONTRAST_PAIRS) as ContrastPair[]) {
    const { fg, surface, kind } = CONTRAST_PAIRS[pair];
    if (kind === "decorative") continue;
    const a = theme.colors[fg];
    const b = theme.colors[surface];
    if (!HEX.test(a) || !HEX.test(b)) continue;
    const ratio = contrastRatio(a, b);
    const min = requiredContrast(theme, pair);
    if (ratio < min) {
      out.push({
        file,
        theme: theme.name,
        keyPath: fg,
        reason: `${pair} contrast is ${ratio.toFixed(2)}:1, below ${min}:1`,
        severity: "warning",
      });
    }
  }
  return out;
}

/** Load `<dir>/<name>.toml`. `theme` is null when the file is absent or rejected (see problems). */
export function loadCustomTheme(
  name: string,
  dir: string,
): { theme: ThemeDefinition | null; problems: ThemeProblem[] } {
  const file = path.join(dir, `${name}.toml`);
  const problem = (keyPath: string, reason: string, severity: ThemeProblem["severity"] = "error"): ThemeProblem => ({
    file,
    theme: name,
    keyPath,
    reason,
    severity,
  });
  let text: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { theme: null, problems: [problem("", "cannot read the theme: not a regular file")] };
    if (st.size > MAX_THEME_BYTES)
      return { theme: null, problems: [problem("", `the theme is larger than ${MAX_THEME_BYTES} bytes`)] };
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { theme: null, problems: [] };
    return { theme: null, problems: [problem("", `cannot read the theme: ${code ?? (err as Error).message}`)] };
  }
  let root: unknown;
  try {
    root = Bun.TOML.parse(text.replace(/^\ufeff/, ""));
  } catch (err) {
    // Bun 1.4.2 reports no document position (line/column are the JS call site).
    const message = String((err as Error).message ?? err).replace(/^TOML Parse error:\s*/, "");
    return { theme: null, problems: [problem("", `invalid TOML: ${message}`)] };
  }
  const table = isTable(root) ? root : {};
  const errors: ThemeProblem[] = [];
  let base: ThemeDefinition | null = null;
  if (table.extends !== undefined) {
    if (typeof table.extends === "string" && isBundled(table.extends)) base = BUNDLED_THEMES[table.extends];
    else {
      errors.push(
        problem(
          "extends",
          `extends must name one bundled theme (${BUNDLED_THEME_NAMES.join(", ")}); themes cannot extend custom themes`,
        ),
      );
    }
  }
  let appearance: ThemeDefinition["appearance"] | undefined;
  if (table.appearance !== undefined) {
    if (table.appearance === "dark" || table.appearance === "light") appearance = table.appearance;
    else errors.push(problem("appearance", 'appearance must be "dark" or "light"'));
  }
  let highContrast: boolean | undefined;
  if (table.high_contrast !== undefined) {
    if (typeof table.high_contrast === "boolean") highContrast = table.high_contrast;
    else errors.push(problem("high_contrast", "high_contrast must be true or false"));
  }
  const colors: Partial<Record<ThemeToken, string>> = { ...(base?.colors ?? {}) };
  const missing: ThemeToken[] = [];
  for (const token of THEME_TOKENS) {
    const value = tokenValue(table, token);
    if (value === undefined) {
      if (colors[token] === undefined && DERIVED_TOKENS[token] === undefined) missing.push(token);
    } else if (isThemeColor(value)) colors[token] = value.toLowerCase();
    else errors.push(problem(token, `${token} must be "#rrggbb", "ansi:0" to "ansi:15" or "default"`));
  }
  for (const [token, from] of Object.entries(DERIVED_TOKENS) as [ThemeToken, ThemeToken][]) {
    if (colors[token] === undefined && colors[from] !== undefined) colors[token] = colors[from];
  }
  if (missing.length > 0 && base === null) {
    errors.push(problem("", `missing tokens (define them or extend a bundled theme): ${missing.join(", ")}`));
  }
  const warnings = unknownKeys(table).map(key => problem(key, `unknown theme key "${key}" is ignored`, "warning"));
  if (errors.length > 0) return { theme: null, problems: [...errors, ...warnings] };
  const theme: ThemeDefinition = {
    name,
    appearance: appearance ?? base?.appearance ?? "dark",
    highContrast: highContrast ?? base?.highContrast ?? false,
    colors: colors as ThemeColors,
  };
  return { theme, problems: [...warnings, ...contrastWarnings(theme, file)] };
}

/** Bundled themes, then custom `<name>.toml` themes (sorted); shadowed or invalid file names are reported. */
export function listThemes(dir: string = themesDir()): {
  themes: { name: string; source: "bundled" | "custom" }[];
  problems: ThemeProblem[];
} {
  const themes: { name: string; source: "bundled" | "custom" }[] = BUNDLED_THEME_NAMES.map(name => ({
    name,
    source: "bundled" as const,
  }));
  const problems: ThemeProblem[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      problems.push({ file: dir, theme: "", keyPath: "", reason: `cannot list themes: ${code}`, severity: "warning" });
    }
  }
  for (const entry of entries) {
    if (!entry.endsWith(".toml")) continue;
    const name = entry.slice(0, -".toml".length);
    const file = path.join(dir, entry);
    if (!isThemeName(name)) {
      problems.push({
        file,
        theme: name,
        keyPath: "",
        reason: "ignored: theme file names are lowercase letters, digits, '-' or '_'",
        severity: "warning",
      });
    } else if (isBundled(name)) {
      problems.push({
        file,
        theme: name,
        keyPath: "",
        reason: `ignored: the bundled ${name} theme takes precedence`,
        severity: "warning",
      });
    } else themes.push({ name, source: "custom" });
  }
  return { themes, problems };
}

// ---------- resolution (theme precedence) ----------

export type ThemeSource = "session" | "cli" | "config" | "appearance" | "default" | "colors";

export interface ThemeInput {
  /** In-session `:theme <name>` (the caller also writes it to tui.toml). */
  readonly session?: string | null;
  /** `--theme` (this session only). */
  readonly cli?: string | null;
  readonly config: Pick<
    TuiConfig,
    "theme" | "themeDark" | "themeLight" | "appearance" | "colors" | "transparentBackground"
  >;
  /** The terminal's reported appearance (DSR 996 / OSC 11); unanswered (null) means dark. */
  readonly detected?: "dark" | "light" | null;
  readonly env: ColorEnvironment;
  /** Custom theme directory (default `themesDir()`). */
  readonly themesDir?: string;
}

export interface ResolvedTheme {
  readonly name: string;
  /** Which precedence level chose the theme, for the status line. */
  readonly source: ThemeSource;
  /** session, cli or tui.toml `theme`: appearance changes never replace it. */
  readonly explicit: boolean;
  readonly appearance: "dark" | "light";
  readonly highContrast: boolean;
  readonly colors: ThemeColors;
  readonly mode: ColorMode;
  readonly transparentBackground: boolean;
  /** Fallbacks, custom-theme errors/warnings and notices, for `:messages`. */
  readonly problems: readonly ThemeProblem[];
  /** Painted as an unfocused pane (see inactiveTheme). */
  readonly inactive?: boolean;
}

/** Tokens the unfocused pane keeps: the surfaces (the selected row stays highlighted) and the borders. */
const INACTIVE_KEEPS = new Set<ThemeToken>(["bg", "panel", "raised", "selection", "search", "border"]);
const inactiveThemes = new WeakMap<ResolvedTheme, ResolvedTheme>();

/**
 * The unfocused pane's variant of `theme` (memoized): every foreground is
 * the `inactive` grey, search matches sit on `raised` (they keep their
 * underline), style() drops bold and, without color to grey (`none`, or a
 * `default` value), dims every run. Surfaces and borders are unchanged.
 */
export function inactiveTheme(theme: ResolvedTheme): ResolvedTheme {
  if (theme.inactive === true) return theme;
  const known = inactiveThemes.get(theme);
  if (known !== undefined) return known;
  const colors = Object.fromEntries(
    THEME_TOKENS.map(token => [token, INACTIVE_KEEPS.has(token) ? theme.colors[token] : theme.colors.inactive]),
  ) as Record<ThemeToken, string>;
  colors.search = theme.colors.raised;
  const variant: ResolvedTheme = { ...theme, colors, inactive: true };
  inactiveThemes.set(theme, variant);
  return variant;
}

/**
 * Resolve the session theme: in-session `:theme` > `--theme` > tui.toml
 * `theme` > `theme_dark`/`theme_light` by appearance >
 * cortex-dark/cortex-light. The first three are explicit; an unknown or
 * rejected name falls through to the next level with a problem. In auto,
 * 16-color terminals get `ansi`; an explicit hex theme there is mapped to the
 * nearest standard colors with a notice. `:theme auto` is the caller passing
 * no session/cli choice and a config without `theme`.
 */
export function resolveTheme(input: ThemeInput): ResolvedTheme {
  const problems: ThemeProblem[] = [];
  const dir = input.themesDir ?? themesDir();
  const { mode } = detectColorMode(input.config.colors, input.env);
  const appearance = input.config.appearance === "system" ? (input.detected ?? "dark") : input.config.appearance;

  const lookup = (name: string, source: ThemeSource): ThemeDefinition | null => {
    if (!isThemeName(name)) {
      problems.push({
        file: null,
        theme: name,
        keyPath: "",
        reason: `invalid theme name ${JSON.stringify(name)} (${source})`,
        severity: "error",
      });
      return null;
    }
    if (isBundled(name)) return BUNDLED_THEMES[name];
    const loaded = loadCustomTheme(name, dir);
    problems.push(...loaded.problems);
    if (loaded.theme === null && loaded.problems.length === 0) {
      problems.push({
        file: null,
        theme: name,
        keyPath: "",
        reason: `theme ${JSON.stringify(name)} (${source}) not found: not bundled and no ${path.join(dir, `${name}.toml`)}`,
        severity: "error",
      });
    }
    return loaded.theme;
  };

  const finish = (theme: ThemeDefinition, source: ThemeSource): ResolvedTheme => {
    const explicit = source === "session" || source === "cli" || source === "config";
    if (mode === "16" && THEME_TOKENS.some(t => HEX.test(theme.colors[t]))) {
      problems.push({
        file: null,
        theme: theme.name,
        keyPath: "",
        reason: `this terminal shows 16 colors: ${theme.name} is mapped to the nearest standard colors`,
        severity: "notice",
      });
    }
    let colors = theme.colors;
    if (input.config.transparentBackground) {
      colors = { ...colors, bg: "default" };
      problems.push({
        file: null,
        theme: theme.name,
        keyPath: "bg",
        reason: "transparent_background: text contrast against the terminal's own background cannot be verified",
        severity: "notice",
      });
    }
    return {
      name: theme.name,
      source,
      explicit,
      appearance: theme.appearance === "terminal" ? appearance : theme.appearance,
      highContrast: theme.highContrast,
      colors,
      mode,
      transparentBackground: input.config.transparentBackground,
      problems,
    };
  };

  const explicitLevels: [ThemeSource, string | null | undefined][] = [
    ["session", input.session],
    ["cli", input.cli],
    ["config", input.config.theme],
  ];
  for (const [source, name] of explicitLevels) {
    if (name === null || name === undefined) continue;
    const theme = lookup(name, source);
    if (theme !== null) return finish(theme, source);
  }
  if (mode === "16") return finish(BUNDLED_THEMES.ansi, "colors");
  const pairName = appearance === "dark" ? input.config.themeDark : input.config.themeLight;
  if (pairName !== null) {
    const theme = lookup(pairName, "appearance");
    if (theme !== null) return finish(theme, "appearance");
  }
  return finish(BUNDLED_THEMES[appearance === "dark" ? "cortex-dark" : "cortex-light"], "default");
}

// ---------- styling ----------

export interface StyleAttributes {
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
  /** GFM ~~strikethrough~~ (SGR 9). */
  readonly strikethrough?: boolean;
}

// C0, DEL and C1 controls: style() only wraps text that src/tui/safety.ts escaped.
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f]/;
const SUBDUED = new Set<ThemeToken>(["muted", "dim", "border"]);
const EMPHASIS = new Set<ThemeToken>([
  "accent",
  "danger",
  "md.heading",
  "mode.normal",
  "mode.insert",
  "mode.command",
  "mode.search",
]);

function colorCode(value: string, mode: ColorMode, layer: "fg" | "bg"): string {
  const [base, bright, ext] = layer === "fg" ? [30, 90, 38] : [40, 100, 48];
  if (value === "default") return String(base + 9);
  if (value.startsWith("ansi:")) {
    const n = Number(value.slice(5));
    return String(n < 8 ? base + n : bright + n - 8);
  }
  if (mode === "truecolor") return `${ext};2;${parseHex(value).join(";")}`;
  if (mode === "256") return `${ext};5;${to256(value)}`;
  const n = to16(value);
  return String(n < 8 ? base + n : bright + n - 8);
}

/**
 * Wrap already-escaped text in the SGR for a declared pair (foreground on
 * its surface) plus attributes, ending with a reset. Throws for an
 * undeclared pair or for text that still holds control characters. Without
 * color (`none`, or a `default` selection/search surface) the state is kept
 * visible: selection → inverse, search → inverse + underline, subdued text →
 * dim, and in `none` emphasis → bold and links → underline. Through an
 * inactiveTheme() variant nothing is bold and uncolored runs are all dim.
 */
export function style(theme: ResolvedTheme, pair: ContrastPair, text: string, attrs: StyleAttributes = {}): string {
  const spec = CONTRAST_PAIRS[pair];
  if (spec === undefined) throw new Error(`undeclared contrast pair ${JSON.stringify(pair)}`);
  if (UNSAFE_TEXT.test(text)) throw new Error("style() needs text escaped by src/tui/safety.ts first");
  if (text === "") return "";
  const { fg, surface } = spec;
  const noColor = theme.mode === "none";
  const fgValue = theme.colors[fg];
  const bgValue = theme.colors[surface];
  const inverseSurface = (surface === "selection" || surface === "search") && (noColor || bgValue === "default");
  const inactive = theme.inactive === true;
  const a = {
    bold: !inactive && (attrs.bold || (noColor && EMPHASIS.has(fg))),
    dim: attrs.dim || ((inactive || SUBDUED.has(fg)) && (noColor || fgValue === "default")),
    italic: attrs.italic,
    underline: attrs.underline || (inverseSurface && surface === "search") || (noColor && fg === "md.link"),
    inverse: attrs.inverse || inverseSurface,
  };
  const codes: string[] = [];
  if (!noColor) {
    codes.push(inverseSurface ? "39" : colorCode(fgValue, theme.mode, "fg"));
    codes.push(inverseSurface ? "49" : colorCode(bgValue, theme.mode, "bg"));
  }
  if (a.bold) codes.push("1");
  if (a.dim) codes.push("2");
  if (a.italic) codes.push("3");
  if (a.underline) codes.push("4");
  if (a.inverse) codes.push("7");
  if (attrs.strikethrough) codes.push("9");
  return codes.length === 0 ? text : `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}

// ---------- rows ----------

/** One run of already-escaped text in a declared pair. */
export interface Seg {
  readonly pair: ContrastPair;
  readonly text: string;
  readonly attrs?: StyleAttributes;
}

export const seg = (pair: ContrastPair, text: string, attrs?: StyleAttributes): Seg => ({ pair, text, attrs });

/**
 * One terminal row: escaped segments in their declared pairs, cut to `width`
 * cells (the last visible segment ends in an ellipsis when cut) and padded
 * with the `fill` surface.
 */
export function paint(theme: ResolvedTheme, segs: readonly Seg[], width: number, fill: ContrastPair): string {
  let out = "";
  let used = 0;
  for (const s of segs) {
    const room = width - used;
    if (room <= 0) break;
    const text = fitWidth(s.text, room);
    if (text === "") continue;
    out += style(theme, s.pair, text, s.attrs);
    used += displayWidth(text);
  }
  return used < width ? out + style(theme, fill, " ".repeat(width - used)) : out;
}
