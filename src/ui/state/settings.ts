// state/settings.ts — The desktop settings: the list density, the task-list
// sort and grouping, the blocked alert and how many backups to keep
// (persisted here), and the registry the settings panel renders and the
// palette reads. Every setting lives in this window's localStorage on
// cortex://app; nothing here reads or writes `tui.toml` or `themes/*.toml`.
//
// The other settings bind signals that their own modules seed and persist:
// appearance (state/theme.ts), show done tasks (state/showAllTasks.ts) and
// the default document mode (state/workspace.ts).

import { effect, signal } from "@preact/signals";
import {
  GROUP_HELP,
  isDescending,
  isTaskGroup,
  isTaskSort,
  SORT_FIELDS,
  SORT_HELP,
  type SortField,
  sortField,
  sortOf,
  TASK_GROUPS,
  type TaskGroup,
  type TaskSort,
} from "../../lib/taskOrder.ts";
import { type ReaderMode, preferredReaderMode, showAllTasks } from "./signals.ts";
import { APPEARANCES, type Appearance, appearance, setAppearance } from "./theme.ts";

export const SORT_KEY = "cortex-sort-v1";
export const GROUP_KEY = "cortex-group-v1";
export const BACKUP_KEEP_KEY = "cortex-backup-keep-v1";
export const DENSITY_KEY = "cortex-density-v1";
export const BLOCKED_ALERT_KEY = "cortex-blocked-alert-v1";
export const COLLAPSED_GROUPS_KEY = "cortex-collapsed-groups-v1";

/** The task-list groups the user folded, by grouping: lane names or statuses. */
export interface CollapsedGroups {
  readonly lane: readonly string[];
  readonly status: readonly string[];
}
const NO_COLLAPSED: CollapsedGroups = { lane: [], status: [] };
const MAX_COLLAPSED_BYTES = 64 * 1024;

/** The stored folds, or null for anything but `{ lane: string[], status: string[] }`. */
export function parseCollapsedGroups(raw: string | null): CollapsedGroups | null {
  if (raw == null || raw.length > MAX_COLLAPSED_BYTES) return null;
  try {
    const v = JSON.parse(raw) as { lane?: unknown; status?: unknown };
    const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(s => typeof s === "string");
    return strings(v?.lane) && strings(v?.status) ? { lane: v.lane, status: v.status } : null;
  } catch {
    return null;
  }
}

export type Density = "comfortable" | "compact";
const isDensity = (v: unknown): v is Density => v === "comfortable" || v === "compact";
export type OnOff = "on" | "off";
const isOnOff = (v: unknown): v is OnOff => v === "on" || v === "off";

const BACKUP_KEEPS = ["0", "5", "10", "20"] as const;
type BackupKeep = (typeof BACKUP_KEEPS)[number];
const isBackupKeep = (v: unknown): v is BackupKeep => BACKUP_KEEPS.includes(v as BackupKeep);

function readStored<T extends string>(key: string, valid: (v: unknown) => v is T): T | null {
  try {
    const v = localStorage.getItem(key);
    return valid(v) ? v : null;
  } catch {
    return null; // storage unavailable: the default stands
  }
}

export const taskSort = signal<TaskSort>("id");
export const taskGroup = signal<TaskGroup>("none");
// How many backups the folder keeps after each backup; 0 keeps them all.
export const backupKeep = signal<number>(0);
// Compact shows one line per task in the list; :root[data-density] carries it.
export const density = signal<Density>("comfortable");
// Off silences the system notification for a move into blocked.
export const blockedAlert = signal<OnOff>("on");
export const collapsedGroups = signal<CollapsedGroups>(NO_COLLAPSED);

/** The folded group keys of `group` (none without grouping). */
export function collapsedKeys(group: TaskGroup, folds: CollapsedGroups = collapsedGroups.value): readonly string[] {
  return group === "none" ? [] : folds[group];
}

/** Fold or unfold one group of the list: a lane name under lane grouping, a status under status grouping. */
export function toggleGroupCollapsed(group: "lane" | "status", key: string): void {
  const current = collapsedGroups.value[group];
  const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
  collapsedGroups.value = { ...collapsedGroups.value, [group]: next };
}

/** Fold every group in `keys` (the groups the list shows), keeping the folds already made. */
export function collapseGroups(group: "lane" | "status", keys: readonly string[]): void {
  const current = collapsedGroups.value[group];
  collapsedGroups.value = { ...collapsedGroups.value, [group]: [...new Set([...current, ...keys])] };
}

/** Unfold every group of one grouping, shown or not. */
export function expandAllGroups(group: "lane" | "status"): void {
  collapsedGroups.value = { ...collapsedGroups.value, [group]: [] };
}

// Seed BEFORE registering the effects so their first run never overwrites
// storage with the defaults (the showAllTasks.ts pattern).
taskSort.value = readStored(SORT_KEY, isTaskSort) ?? "id";
taskGroup.value = readStored(GROUP_KEY, isTaskGroup) ?? "none";
backupKeep.value = Number(readStored(BACKUP_KEEP_KEY, isBackupKeep) ?? "0");
density.value = readStored(DENSITY_KEY, isDensity) ?? "comfortable";
blockedAlert.value = readStored(BLOCKED_ALERT_KEY, isOnOff) ?? "on";
try {
  collapsedGroups.value = parseCollapsedGroups(localStorage.getItem(COLLAPSED_GROUPS_KEY)) ?? NO_COLLAPSED;
} catch {
  /* storage unavailable: nothing is folded */
}

effect(() => {
  const v = taskSort.value;
  try {
    localStorage.setItem(SORT_KEY, v);
  } catch {
    /* private mode: keep the in-memory choice */
  }
});
effect(() => {
  const v = taskGroup.value;
  try {
    localStorage.setItem(GROUP_KEY, v);
  } catch {
    /* private mode: keep the in-memory choice */
  }
});
effect(() => {
  const v = String(backupKeep.value);
  try {
    localStorage.setItem(BACKUP_KEEP_KEY, v);
  } catch {
    /* private mode: keep the in-memory choice */
  }
});
effect(() => {
  const v = density.value;
  if (typeof document !== "undefined") document.documentElement.dataset.density = v;
  try {
    localStorage.setItem(DENSITY_KEY, v);
  } catch {
    /* private mode: keep the in-memory choice */
  }
});
effect(() => {
  const v = blockedAlert.value;
  try {
    localStorage.setItem(BLOCKED_ALERT_KEY, v);
  } catch {
    /* private mode: keep the in-memory choice */
  }
});
effect(() => {
  const v = JSON.stringify(collapsedGroups.value);
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, v);
  } catch {
    /* private mode: keep the in-memory folds */
  }
});

export interface SettingChoice {
  readonly value: string;
  readonly label: string;
  readonly help: string;
}

export interface SettingSpec {
  readonly key: "appearance" | "density" | "sort" | "direction" | "group" | "done" | "mode" | "alert" | "backup";
  readonly section: "Appearance" | "Task list" | "Documents" | "Notifications" | "Backup";
  /** "switch": choices[0] is off and choices[1] is on. */
  readonly control: "select" | "segmented" | "switch" | "cards";
  readonly label: string;
  readonly meaning: string;
  readonly defaultValue: string;
  readonly choices: readonly SettingChoice[];
  current(): string;
  /** Throws on a value outside `choices`. */
  set(value: string): void;
}

function setting(spec: Omit<SettingSpec, "set"> & { apply(value: string): void }): SettingSpec {
  const { apply, ...rest } = spec;
  return {
    ...rest,
    set(value: string): void {
      if (!rest.choices.some(c => c.value === value)) throw new Error(`${rest.label}: unknown choice "${value}"`);
      apply(value);
    },
  };
}

const APPEARANCE_HELP: Readonly<Record<Appearance, string>> = {
  system: "follow the operating system's light or dark setting",
  light: "light surfaces",
  dark: "dark surfaces",
  "high-contrast": "dark, with text at 7:1 contrast or more",
};
const APPEARANCE_LABEL: Readonly<Record<Appearance, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
  "high-contrast": "High contrast",
};

const MODES: readonly SettingChoice[] = [
  { value: "read", label: "Read", help: "the rendered document" },
  { value: "edit", label: "Edit", help: "the Markdown editor" },
  { value: "split", label: "Split", help: "the editor beside the rendered document" },
];

export const SETTINGS: readonly SettingSpec[] = [
  setting({
    key: "appearance",
    section: "Appearance",
    control: "cards",
    label: "Appearance",
    meaning: "the colours of the window",
    defaultValue: "system",
    choices: APPEARANCES.map(v => ({ value: v, label: APPEARANCE_LABEL[v], help: APPEARANCE_HELP[v] })),
    current: () => appearance.value,
    apply: v => setAppearance(v as Appearance),
  }),
  setting({
    key: "density",
    section: "Appearance",
    control: "segmented",
    label: "Density",
    meaning: "how much of each task the list shows",
    defaultValue: "comfortable",
    choices: [
      { value: "comfortable", label: "Comfortable", help: "two lines: id, tags and age under the title" },
      { value: "compact", label: "Compact", help: "one line per task" },
    ],
    current: () => density.value,
    apply: v => {
      density.value = v as Density;
    },
  }),
  setting({
    key: "sort",
    section: "Task list",
    control: "select",
    label: "Sort",
    meaning: "the task list's order without a search",
    defaultValue: "id",
    choices: SORT_FIELDS.map(v => ({ value: v, label: v, help: SORT_HELP[v] })),
    current: () => sortField(taskSort.value),
    apply: v => {
      taskSort.value = sortOf(v as SortField, isDescending(taskSort.value));
    },
  }),
  // The sort's direction, kept with the field in the one stored sort ("-id").
  setting({
    key: "direction",
    section: "Task list",
    control: "segmented",
    label: "Direction",
    meaning: "which end of the sort comes first",
    defaultValue: "asc",
    choices: [
      { value: "asc", label: "Ascending", help: "lowest first: the oldest task, A to Z, draft before done, P0 first" },
      {
        value: "desc",
        label: "Descending",
        help: "highest first: the newest task, Z to A, done before draft, P3 first",
      },
    ],
    current: () => (isDescending(taskSort.value) ? "desc" : "asc"),
    apply: v => {
      taskSort.value = sortOf(sortField(taskSort.value), v === "desc");
    },
  }),
  setting({
    key: "group",
    section: "Task list",
    control: "select",
    label: "Group",
    meaning: "headers in the task list without a search",
    defaultValue: "none",
    choices: TASK_GROUPS.map(v => ({ value: v, label: v, help: GROUP_HELP[v] })),
    current: () => taskGroup.value,
    apply: v => {
      taskGroup.value = v as TaskGroup;
    },
  }),
  setting({
    key: "done",
    section: "Task list",
    control: "switch",
    label: "Done tasks",
    meaning: "whether done tasks show in the list",
    defaultValue: "hide",
    choices: [
      { value: "hide", label: "Hide", help: "done tasks show only in the Done view" },
      { value: "show", label: "Show", help: "done tasks show in every view" },
    ],
    current: () => (showAllTasks.value ? "show" : "hide"),
    apply: v => {
      showAllTasks.value = v === "show";
    },
  }),
  setting({
    key: "mode",
    section: "Documents",
    control: "segmented",
    label: "Document mode",
    meaning: "the mode a task's document opens in",
    defaultValue: "read",
    choices: MODES,
    current: () => preferredReaderMode.value,
    apply: v => {
      preferredReaderMode.value = v as ReaderMode;
    },
  }),
  setting({
    key: "alert",
    section: "Notifications",
    control: "switch",
    label: "Alert when a task is blocked",
    meaning: "a system notification when a task moves into blocked",
    defaultValue: "on",
    choices: [
      { value: "off", label: "Off", help: "no system notification" },
      { value: "on", label: "On", help: "the one interruption cortex makes" },
    ],
    current: () => blockedAlert.value,
    apply: v => {
      blockedAlert.value = v as OnOff;
    },
  }),
  setting({
    key: "backup",
    section: "Backup",
    control: "select",
    label: "Keep backups",
    meaning: "how many backups the folder keeps",
    defaultValue: "0",
    choices: [
      { value: "0", label: "All", help: "every backup stays in the folder" },
      { value: "5", label: "Last 5", help: "the 5 newest; older ones are removed after each backup" },
      { value: "10", label: "Last 10", help: "the 10 newest; older ones are removed after each backup" },
      { value: "20", label: "Last 20", help: "the 20 newest; older ones are removed after each backup" },
    ],
    current: () => String(backupKeep.value),
    apply: v => {
      backupKeep.value = Number(v);
    },
  }),
];
