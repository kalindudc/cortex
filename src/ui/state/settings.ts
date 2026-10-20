// state/settings.ts — The desktop settings: the task-list sort and grouping
// (persisted here), and the registry the settings pane renders and the
// palette reads. Every setting lives in this window's localStorage on
// cortex://app; nothing here reads or writes `tui.toml` or `themes/*.toml`.
//
// The other settings bind signals that their own modules seed and persist:
// appearance (state/theme.ts), show done tasks (state/showAllTasks.ts) and
// the default document mode (state/workspace.ts).

import { effect, signal } from "@preact/signals";
import {
  GROUP_HELP,
  isTaskGroup,
  isTaskSort,
  SORT_HELP,
  TASK_GROUPS,
  TASK_SORTS,
  type TaskGroup,
  type TaskSort,
} from "../../lib/taskOrder.ts";
import { type ReaderMode, preferredReaderMode, showAllTasks } from "./signals.ts";
import { APPEARANCES, type Appearance, appearance, setAppearance } from "./theme.ts";

export const SORT_KEY = "cortex-sort-v1";
export const GROUP_KEY = "cortex-group-v1";

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

// Seed BEFORE registering the effects so their first run never overwrites
// storage with the defaults (the showAllTasks.ts pattern).
taskSort.value = readStored(SORT_KEY, isTaskSort) ?? "id";
taskGroup.value = readStored(GROUP_KEY, isTaskGroup) ?? "none";

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

export interface SettingChoice {
  readonly value: string;
  readonly label: string;
  readonly help: string;
}

export interface SettingSpec {
  readonly key: "appearance" | "sort" | "group" | "done" | "mode";
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
    label: "Appearance",
    meaning: "the colours of the window",
    defaultValue: "system",
    choices: APPEARANCES.map(v => ({ value: v, label: APPEARANCE_LABEL[v], help: APPEARANCE_HELP[v] })),
    current: () => appearance.value,
    apply: v => setAppearance(v as Appearance),
  }),
  setting({
    key: "sort",
    label: "Sort",
    meaning: "the task list's order without a search",
    defaultValue: "id",
    choices: TASK_SORTS.map(v => ({ value: v, label: v, help: SORT_HELP[v] })),
    current: () => taskSort.value,
    apply: v => {
      taskSort.value = v as TaskSort;
    },
  }),
  setting({
    key: "group",
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
    label: "Document mode",
    meaning: "the mode a task's document opens in",
    defaultValue: "read",
    choices: MODES,
    current: () => preferredReaderMode.value,
    apply: v => {
      preferredReaderMode.value = v as ReaderMode;
    },
  }),
];
