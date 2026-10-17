// The :config pane: the ONLY writer of tui.toml in the TUI. Every other
// command and shortcut (filters, the search, sort, Read/Edit/Split, ;d, ;e)
// lasts for the session; this pane is how a default changes.
//
// - A large list of every writable setting (src/tui/config.ts
//   WRITABLE_SETTINGS) by section. Each row shows tui.toml's value, read
//   when the pane opens and after each change (another TUI may have written
//   it), marked `· default` when it equals the default and `· next start`
//   when the Shell reads it only while it sets up the terminal.
// - Enter or Space: a boolean toggles; a choice opens a choice list; `scroll`
//   a one-field form; `theme` the live-preview theme picker. `x` removes the
//   setting's line, so its default applies.
// - A change is written first (session.saveSetting, one surgical line);
//   only then does a live setting apply to this session, so the session never
//   shows what the file refused. A refused write changes nothing and is shown.
// - Agent integrations install (overwrite, add anything new) or reset (y/n,
//   then wipe and reinstall) through `cortex agents install|reset`'s
//   installAll, which writes only the skill, extension and bb plugin dirs
//   (and registers the bb plugin with bb when bb runs).
// - `:config <setting> [value]` is the typed form: a bare boolean toggles,
//   another bare setting opens its picker, `default` (and `theme auto`)
//   removes the line.

import { bbPluginDir, findBbCli } from "../bbPlugin.ts";
import { type AgentsResult, installAll } from "../commands/agents.ts";
import { extensionDir, listExtensions, piDetected } from "../extensions.ts";
import { listSkills, skillDir } from "../skills.ts";
import { CommandError } from "./commands.ts";
import {
  APPEARANCES,
  COLOR_SETTINGS,
  DEFAULT_CONFIG,
  DENSITIES,
  DOCUMENT_MODES,
  type DocumentMode,
  type Density,
  loadConfig,
  MAX_SCROLL,
  SETTING_HELP,
  TASK_GROUPS,
  TASK_SORTS,
  type TaskGroup,
  type TaskSort,
  type TuiConfig,
  type WritableSetting,
} from "./config.ts";
import { type Dialog, type DialogRow, showDialog } from "./dialogs.ts";
import type { ThemeControl, TuiSession } from "./session.ts";
import { BUNDLED_THEME_NAMES, type ResolvedTheme, type ThemeSource } from "./theme.ts";

type SettingField = Exclude<keyof TuiConfig, "keys">;
type SettingValue = string | number | boolean | null;

/** One row of the pane: a tui.toml key, where it is shown, and how this session follows a change. */
export interface ConfigEntry {
  readonly key: WritableSetting;
  readonly section: string;
  /** Its TuiConfig field (the value shown, and the default). */
  readonly field: SettingField;
  /** A choice setting's values (Enter lists them). */
  choices?(session: TuiSession): readonly string[];
  /**
   * Apply a saved value (a removed line's default) to this session; absent, it applies at the next
   * start. A returned text replaces the status line's generic notice.
   */
  live?(session: TuiSession, value: SettingValue): string | undefined;
}

const APPEARANCE = "Appearance";
const TASK_LIST = "Task list";
const MOUSE = "Mouse and scrolling";
const ALERTS = "Alerts for blocked tasks";
const AGENTS = "Agent integrations";
const INSTALL_KEY = "agents:install";
const RESET_KEY = "agents:reset";

/** Every writable setting exactly once, in the pane's order (each section's rows together). */
export const CONFIG_ENTRIES: readonly ConfigEntry[] = [
  {
    key: "theme",
    section: APPEARANCE,
    field: "theme",
    choices: session => ["auto", ...themeNames(session)],
    live: (session, value) => {
      const control = session.themeControl;
      return control === null ? undefined : themeSourceText(control.apply(value as string | null));
    },
  },
  { key: "theme_dark", section: APPEARANCE, field: "themeDark", choices: themeNames },
  { key: "theme_light", section: APPEARANCE, field: "themeLight", choices: themeNames },
  { key: "appearance", section: APPEARANCE, field: "appearance", choices: () => APPEARANCES },
  { key: "colors", section: APPEARANCE, field: "colors", choices: () => COLOR_SETTINGS },
  { key: "transparent_background", section: APPEARANCE, field: "transparentBackground" },
  {
    key: "density",
    section: APPEARANCE,
    field: "density",
    choices: () => DENSITIES,
    live: (session, value) => void session.setDensity(value as Density),
  },
  {
    key: "number",
    section: APPEARANCE,
    field: "number",
    live: (session, value) => void session.setLineNumbers(value as boolean),
  },
  {
    key: "mode",
    section: APPEARANCE,
    field: "mode",
    choices: () => DOCUMENT_MODES,
    live: (session, value) => void session.setDocumentMode(value as DocumentMode),
  },
  {
    key: "tasks",
    section: TASK_LIST,
    field: "tasks",
    live: (session, value) => void session.setTaskListVisible(value as boolean),
  },
  {
    key: "done",
    section: TASK_LIST,
    field: "done",
    live: (session, value) => void session.setIncludeDone(value as boolean),
  },
  {
    key: "sort",
    section: TASK_LIST,
    field: "sort",
    choices: () => TASK_SORTS,
    live: (session, value) => void session.setSort(value as TaskSort),
  },
  {
    key: "group",
    section: TASK_LIST,
    field: "group",
    choices: () => TASK_GROUPS,
    live: (session, value) => void session.setGroup(value as TaskGroup),
  },
  { key: "mouse", section: MOUSE, field: "mouse" },
  {
    key: "scroll",
    section: MOUSE,
    field: "scroll",
    live: (session, value) => void session.setScrollRows(value as number),
  },
  {
    key: "flash",
    section: ALERTS,
    field: "flash",
    live: (session, value) => void session.notificationFeed?.configure({ flash: value as boolean }),
  },
  {
    key: "bell",
    section: ALERTS,
    field: "bell",
    live: (session, value) => void session.notificationFeed?.configure({ bell: value as boolean }),
  },
];

const MEANINGS: ReadonlyMap<string, string> = new Map(SETTING_HELP.map(s => [s.key, s.meaning]));
const isBoolean = (entry: ConfigEntry): boolean => typeof DEFAULT_CONFIG[entry.field] === "boolean";
const entryOf = (key: string): ConfigEntry | undefined => CONFIG_ENTRIES.find(e => e.key === key);

/** tui.toml's settings now (the defaults without a tui.toml). */
function readConfig(session: TuiSession): TuiConfig {
  const file = session.configFile;
  return file === undefined ? DEFAULT_CONFIG : loadConfig(file).config;
}

const shown = (entry: ConfigEntry, value: SettingValue): string =>
  value === null ? (entry.key === "theme" ? "auto" : "unset") : String(value);

/**
 * Write one setting, then apply it to this session when it is live (null: the line is removed and the
 * default applies). A refused write throws (a CommandError) before anything is applied.
 */
function change(session: TuiSession, entry: ConfigEntry, value: SettingValue): void {
  session.saveSetting(entry.key, value);
  const applied = value === null ? DEFAULT_CONFIG[entry.field] : value;
  const said = entry.live?.(session, applied as SettingValue);
  const later = entry.live === undefined ? " (applies at the next start)" : "";
  const text =
    value === null
      ? `Removed ${entry.key} from tui.toml: its default applies${later}`
      : `Saved ${entry.key} = ${JSON.stringify(value)} to tui.toml${later}`;
  session.notify("info", said ?? text);
}

/** Enter on a setting: a boolean toggles; theme opens the theme picker, scroll its form, a choice its list. */
function edit(session: TuiSession, entry: ConfigEntry, done: () => void): void {
  const current = readConfig(session)[entry.field] as SettingValue;
  if (isBoolean(entry)) {
    change(session, entry, !current);
    done();
  } else if (entry.key === "theme") openThemePicker(session, requireThemes(session), done);
  else if (entry.key === "scroll") openScrollForm(session, entry, current as number, done);
  else openChoices(session, entry, current, done);
}

function openChoices(session: TuiSession, entry: ConfigEntry, current: SettingValue, done: () => void): void {
  const fallback = DEFAULT_CONFIG[entry.field];
  showDialog(session, {
    kind: "list",
    title: `CONFIG \u00b7 ${entry.key}`,
    label: entry.key,
    pickLabel: "saves it",
    ...(current === null ? {} : { initial: String(current) }),
    rows: () =>
      (entry.choices?.(session) ?? []).map(value => ({
        key: value,
        label: value,
        mark: value === current ? "(\u2022)" : "( )",
        ...(value === fallback ? { detail: "default" } : {}),
      })),
    pick: (row, dialog) => {
      change(session, entry, row.key);
      dialog.finish();
      done();
    },
  });
}

function openScrollForm(session: TuiSession, entry: ConfigEntry, current: number, done: () => void): void {
  showDialog(session, {
    kind: "form",
    title: "CONFIG \u00b7 scroll",
    label: "scroll",
    fields: [{ name: "scroll", label: "Rows a notch", value: String(current), hint: `1 to ${MAX_SCROLL}` }],
    guarded: false,
    submitLabel: "saves it",
    submit: values => {
      const text = (values.scroll ?? "").trim();
      if (!/^\d+$/.test(text)) throw new CommandError(`Type a whole number from 1 to ${MAX_SCROLL}`);
      change(session, entry, Number(text));
      done();
      return true;
    },
  });
}

// ---------- agent integrations ----------

/** One status line for an agents install or reset; a failed bb plugin is an error. */
export function installReport(result: AgentsResult): { level: "info" | "error"; text: string } {
  const skills = `${result.skills.length} skill${result.skills.length === 1 ? "" : "s"}`;
  const pi = result.skipped.find(s => s.name === "pi");
  const base =
    pi === undefined ? `Installed ${skills} and the pi extension` : `Installed ${skills}; skipped pi: ${pi.reason}`;
  const { bb } = result;
  if (bb.status === "failed") return { level: "error", text: `${base}; the bb plugin failed: ${bb.reason}` };
  if (bb.status === "skipped") return { level: "info", text: `${base}; skipped the bb plugin: ${bb.reason}` };
  const state = bb.plugin && bb.plugin.status !== "running" ? ` but it is ${bb.plugin.status}` : "";
  const verb = { installed: "installed", reloaded: "reloaded", unchanged: "up to date" }[bb.status];
  return { level: "info", text: `${base}; bb plugin ${verb}${state}` };
}

async function install(session: TuiSession): Promise<void> {
  const report = installReport(await installAll(false));
  session.notify(report.level, report.text);
}

function confirmReset(session: TuiSession): void {
  const bb = findBbCli().cli !== null;
  const dirs = [
    ...listSkills().map(name => skillDir(name)),
    ...(piDetected() ? listExtensions().map(name => extensionDir(name)) : []),
    ...(bb ? [bbPluginDir()] : []),
  ];
  showDialog(session, {
    kind: "confirm",
    title: "RESET AGENT INTEGRATIONS",
    label: "reset agents",
    message: [
      "Wipe, then reinstall:",
      ...dirs.map(dir => `  \u2022 ${dir}`),
      "Hand-edits in these dirs are lost.",
      ...(bb ? ["The bb plugin is removed and installed again, which resets its settings."] : []),
    ],
    yes: "wipes and reinstalls",
    confirm: async () => {
      const report = installReport(await installAll(true));
      session.notify(report.level, report.text);
    },
  });
}

const AGENT_ROWS: readonly (DialogRow & { readonly meaning: string })[] = [
  {
    key: INSTALL_KEY,
    section: AGENTS,
    label: "install or update",
    mark: "   ",
    detail: "the skills, plus the pi extension and bb plugin when present",
    meaning:
      "Write every skill cortex ships, plus the pi extension when pi is present and the bb plugin when bb is (overwrites; adds anything new)",
  },
  {
    key: RESET_KEY,
    section: AGENTS,
    label: "reset",
    mark: "   ",
    detail: "wipe their dirs, then install (asks first)",
    meaning:
      "Wipe the skill, extension and bb plugin dirs (hand-edits are lost; the bb plugin's settings reset), then install them again",
  },
];

// ---------- the pane ----------

function settingRow(entry: ConfigEntry, config: TuiConfig): DialogRow {
  const value = config[entry.field] as SettingValue;
  const notes = [shown(entry, value)];
  if (value === DEFAULT_CONFIG[entry.field]) notes.push("default");
  if (entry.live === undefined) notes.push("next start");
  return {
    key: entry.key,
    section: entry.section,
    label: entry.key,
    detail: notes.join(" \u00b7 "),
    search: `${entry.key} ${MEANINGS.get(entry.key) ?? ""}`,
    ...(isBoolean(entry) ? { mark: value === true ? "[x]" : "[ ]", toggle: true } : { mark: "   " }),
  };
}

/** `:config`: every writable setting by section, then the agent integrations (a large pane). */
export function openConfig(session: TuiSession): void {
  let config = readConfig(session);
  const reread = (): void => {
    config = readConfig(session);
  };
  let dialog: Dialog | null = null;
  const overlay = showDialog(
    session,
    {
      kind: "list",
      title: "CONFIG",
      label: "config",
      noun: "settings",
      pickLabel: "changes it",
      summary: () => {
        const key = dialog?.highlighted()?.key ?? "";
        return MEANINGS.get(key) ?? AGENT_ROWS.find(r => r.key === key)?.meaning ?? "Settings, saved to tui.toml";
      },
      rows: () => [...CONFIG_ENTRIES.map(entry => settingRow(entry, config)), ...AGENT_ROWS],
      pick: row => {
        if (row.key === INSTALL_KEY) return install(session);
        if (row.key === RESET_KEY) return confirmReset(session);
        const entry = entryOf(row.key);
        if (entry !== undefined) edit(session, entry, reread);
      },
      keys: [
        {
          key: "x",
          label: "restores the default",
          row: true,
          run: row => {
            const entry = row === null ? undefined : entryOf(row.key);
            if (entry === undefined) {
              session.notify("info", "x restores a setting's default; the agent integrations have none");
              return;
            }
            change(session, entry, null);
            reread();
          },
        },
      ],
    },
    "large",
  );
  dialog = overlay.dialog;
}

// ---------- :config <setting> [value] ----------

function parseValue(session: TuiSession, entry: ConfigEntry, text: string): SettingValue {
  if (text === "default" || (entry.key === "theme" && text === "auto")) return null;
  if (isBoolean(entry)) {
    if (text === "true" || text === "false") return text === "true";
    throw new CommandError(`${entry.key} takes true, false or default`);
  }
  if (entry.key === "scroll") {
    if (/^\d+$/.test(text)) return Number(text);
    throw new CommandError(`scroll takes a whole number from 1 to ${MAX_SCROLL}, or default`);
  }
  const choices = entry.choices?.(session) ?? [];
  if (choices.includes(text)) return text;
  throw new CommandError(`Unknown ${entry.key} "${text}": ${[...choices, "default"].join(", ")}`);
}

/** `:config` opens the pane; `:config <setting>` toggles or picks; `:config <setting> <value|default>` sets it. */
export function runConfig(session: TuiSession, argument: string): void {
  if (argument === "") {
    openConfig(session);
    return;
  }
  const [key = "", ...rest] = argument.split(/\s+/);
  const entry = entryOf(key);
  if (entry === undefined) {
    throw new CommandError(`Unknown setting "${key}": ${CONFIG_ENTRIES.map(e => e.key).join(", ")}`);
  }
  const text = rest.join(" ");
  if (text === "") edit(session, entry, () => {});
  else change(session, entry, parseValue(session, entry, text));
}

/** Tab after `:config`: the settings, then the typed setting's values. */
export function completeConfig(prefix: string, session: TuiSession): string[] {
  const typed = /^(\S+)\s+(\S*)$/.exec(prefix);
  if (typed === null) {
    return CONFIG_ENTRIES.map(e => e.key)
      .filter(key => key.startsWith(prefix.trim()))
      .sort();
  }
  const [, key = "", value = ""] = typed;
  const entry = entryOf(key);
  if (entry === undefined) return [];
  const values = isBoolean(entry) ? ["true", "false"] : (entry.choices?.(session) ?? []);
  return [...values, "default"].filter(v => v.startsWith(value)).map(v => `${key} ${v}`);
}

// ---------- the theme picker ----------

const THEME_SOURCE: Readonly<Record<ThemeSource, (theme: ResolvedTheme) => string>> = {
  session: () => "your :config theme choice (saved)",
  cli: () => "--theme (this session only)",
  config: () => "tui.toml theme pins it (:config theme replaces it; :config theme auto removes it)",
  appearance: t => `tui.toml theme_${t.appearance} for a ${t.appearance} terminal`,
  default: t => `auto (a ${t.appearance} terminal)`,
  colors: () => "auto (a 16-color terminal)",
};

/** Which precedence level chose the active theme, for the status line. */
export function themeSourceText(theme: ResolvedTheme): string {
  return `Theme ${theme.name} \u00b7 ${THEME_SOURCE[theme.source](theme)}`;
}

function themeNames(session: TuiSession): string[] {
  return session.themeControl?.choices().map(c => c.name) ?? [...BUNDLED_THEME_NAMES];
}

function requireThemes(session: TuiSession): ThemeControl {
  const control = session.themeControl;
  if (control === null) throw new CommandError("Themes need the terminal workspace");
  return control;
}

/** Moving previews a theme, Esc restores; Enter saves it to tui.toml first, then applies it (auto removes it). */
function openThemePicker(session: TuiSession, control: ThemeControl, done: () => void): void {
  const current = session.theme;
  const inUse = current?.explicit ? current.name : "auto";
  const choices = control.choices();
  const rows: DialogRow[] = [
    {
      key: "auto",
      label: "auto",
      detail: `follow the terminal (light or dark)${inUse === "auto" ? " \u00b7 in use" : ""}`,
    },
    ...choices.map(c => ({
      key: c.name,
      label: c.name,
      detail: `${c.source}${inUse === c.name ? " \u00b7 in use" : ""}`,
    })),
  ];
  showDialog(session, {
    kind: "list",
    title: current === null ? "THEME" : `THEME \u00b7 ${current.name}: ${THEME_SOURCE[current.source](current)}`,
    label: "theme",
    pickLabel: "saves and applies",
    initial: inUse,
    rows: () => rows,
    highlight: row => {
      if (row !== null) control.preview(row.key === "auto" ? null : row.key);
    },
    dismiss: () => control.restore(),
    pick: (row, dialog) => {
      const name = row.key === "auto" ? null : row.key;
      try {
        session.saveSetting("theme", name);
      } catch (err) {
        control.restore();
        throw err;
      }
      const theme = control.apply(name);
      dialog.finish();
      session.notify("info", themeSourceText(theme));
      done();
    },
  });
}
