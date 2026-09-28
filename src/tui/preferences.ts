// Per-profile TUI view state (plan @400 N15): `configDir()/tui/<profile>.state.json`,
// the only terminal-UI file cortex writes (tui.toml and themes are read-only).
//
// - Global view preferences (include-done, task-list and panel disclosure,
//   Read's line numbers, the preferred Read/Edit/Split mode, an explicit `:theme` choice, the
//   task list's `:sort` order and `:group` grouping, an explicit `:density` choice) plus
//   per-database entries keyed by the N7 database UUID (last task,
//   filter/query), so another or a reset database never restores foreign
//   tasks or filters.
// - Saving re-reads the file, merges ONLY the fields this session changed
//   since its last save, and renames a private temp file over it, so
//   concurrent sessions on one profile never erase each other's choices.
//   (Two saves racing inside the same few-millisecond read-to-rename window
//   can still lose the earlier one's fields: there is no lock.)
// - Settings are read at startup and never live-broadcast: a session's own
//   view is its startup state plus its own changes.
// - Only known fields are ever written: the file never contains drafts.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { TaskStatus } from "../store.ts";
import { type Density, isDensity, isThemeName } from "./config.ts";

export type DocumentMode = "read" | "edit" | "split";
export type TaskPanel = "document" | "activity" | "related" | "authors";

/** The task list's orders (`:sort`): a leading `-` reverses one; ties always break by ascending id. */
export const TASK_SORTS = [
  "id",
  "-id",
  "title",
  "-title",
  "lane",
  "status",
  "priority",
  "updated",
  "-updated",
] as const;
export type TaskSort = (typeof TASK_SORTS)[number];
/** The task list's groupings (`:group`): a header row per lane or status. */
export const TASK_GROUPS = ["none", "lane", "status"] as const;
export type TaskGroup = (typeof TASK_GROUPS)[number];

export interface ViewPreferences {
  /** Show done tasks in the task list. */
  readonly includeDone: boolean;
  /** The task list is shown (disclosure). */
  readonly taskList: boolean;
  /** `:set number`: Read and the Split preview show source line numbers. */
  readonly lineNumbers: boolean;
  /** The open task panel. */
  readonly panel: TaskPanel;
  /** The preferred document mode; temporary Edit views never change it. */
  readonly mode: DocumentMode;
  /** An explicit `:theme` choice; null means auto. */
  readonly theme: string | null;
  /** The task list's order without a search (a search ranks by relevance). */
  readonly sort: TaskSort;
  /** The task list's grouping without a search. */
  readonly group: TaskGroup;
  /** An explicit `:density` choice (it wins over tui.toml's `density`); null means none. */
  readonly density: Density | null;
}

export interface TaskFilter {
  readonly status: TaskStatus | null;
  readonly lane: string | null;
  /** OR-composed tag names (the web's untagged sentinel is just a string). */
  readonly tags: readonly string[];
}

export interface DatabasePreferences {
  readonly lastTask: number | null;
  readonly filter: TaskFilter;
  readonly query: string;
}

export interface Preferences {
  readonly view: ViewPreferences;
  /** Keyed by database UUID. */
  readonly databases: Readonly<Record<string, DatabasePreferences>>;
}

export interface PreferenceChanges {
  readonly view?: Partial<ViewPreferences>;
  readonly databases?: Readonly<Record<string, Partial<DatabasePreferences>>>;
}

export interface PreferenceProblem {
  readonly file: string;
  readonly reason: string;
}

export const DEFAULT_VIEW: ViewPreferences = {
  includeDone: false,
  taskList: true,
  lineNumbers: false,
  panel: "document",
  mode: "read",
  theme: null,
  sort: "id",
  group: "none",
  density: null,
};

export const DEFAULT_DATABASE: DatabasePreferences = {
  lastTask: null,
  filter: { status: null, lane: null, tags: [] },
  query: "",
};

const VERSION = 1;
const STATUSES: readonly TaskStatus[] = ["draft", "open", "review", "blocked", "done"];
const PANELS: readonly TaskPanel[] = ["document", "activity", "related", "authors"];
const MODES: readonly DocumentMode[] = ["read", "edit", "split"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches the web's cap on a restored query (src/ui/state/workspace.ts).
const MAX_QUERY = 4096;
const MAX_NAME = 256;
const MAX_TAGS = 1000;

type Check = (value: unknown) => string | null;

const bool: Check = v => (typeof v === "boolean" ? null : "must be true or false");
const oneOf =
  (values: readonly string[]): Check =>
  v =>
    (values as readonly unknown[]).includes(v)
      ? null
      : `must be one of ${values.map(x => JSON.stringify(x)).join(", ")}`;
const shortString = (v: unknown): boolean => typeof v === "string" && v.length <= MAX_NAME;

const VIEW_CHECKS: { readonly [K in keyof ViewPreferences]: Check } = {
  includeDone: bool,
  taskList: bool,
  lineNumbers: bool,
  panel: oneOf(PANELS),
  mode: oneOf(MODES),
  theme: v => (v === null || isThemeName(v) ? null : "must be a theme name or null"),
  sort: oneOf(TASK_SORTS),
  group: oneOf(TASK_GROUPS),
  density: v => (v === null || isDensity(v) ? null : 'must be "comfortable", "compact" or null'),
};

const DATABASE_CHECKS: { readonly [K in keyof DatabasePreferences]: Check } = {
  lastTask: v =>
    v === null || (Number.isSafeInteger(v) && (v as number) > 0) ? null : "must be a positive task id or null",
  filter: v => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return "must be {status, lane, tags}";
    const f = v as Record<string, unknown>;
    if (f.status !== null && !(STATUSES as readonly unknown[]).includes(f.status)) return "has an invalid status";
    if (f.lane !== null && !shortString(f.lane)) return "has an invalid lane";
    if (!Array.isArray(f.tags) || f.tags.length > MAX_TAGS || !f.tags.every(shortString)) return "has invalid tags";
    return null;
  },
  query: v =>
    typeof v === "string" && v.length <= MAX_QUERY ? null : `must be a string of at most ${MAX_QUERY} characters`,
};

const VIEW_KEYS = Object.keys(VIEW_CHECKS) as (keyof ViewPreferences)[];
const DATABASE_KEYS = Object.keys(DATABASE_CHECKS) as (keyof DatabasePreferences)[];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function copyFilter(f: TaskFilter): TaskFilter {
  return { status: f.status, lane: f.lane, tags: [...f.tags] };
}

/** Known, valid fields of `raw` over `defaults`; each invalid field keeps its default with a problem. */
function pick<T extends object>(
  raw: unknown,
  defaults: T,
  checks: { readonly [K in keyof T]: Check },
  at: string,
  problems: string[],
): T {
  const out = { ...defaults } as Record<keyof T, unknown>;
  if (raw === undefined) return out as T;
  if (!isObject(raw)) {
    problems.push(`${at}: must be an object; using the defaults`);
    return out as T;
  }
  for (const key of Object.keys(checks) as (keyof T)[]) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key as string];
    const why = checks[key](value);
    if (why === null) out[key] = key === "filter" ? copyFilter(value as TaskFilter) : value;
    else problems.push(`${at}.${String(key)}: ${why}; using the default`);
  }
  return out as T;
}

type Loaded = { preferences: Preferences; problems: PreferenceProblem[]; unsupportedVersion: string | null };

function load(file: string): Loaded {
  const empty: Preferences = { view: DEFAULT_VIEW, databases: {} };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { preferences: empty, problems: [], unsupportedVersion: null };
    return {
      preferences: empty,
      problems: [{ file, reason: `cannot read view state: ${code}` }],
      unsupportedVersion: null,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      preferences: empty,
      problems: [{ file, reason: `not valid JSON (${(err as Error).message}); using the defaults` }],
      unsupportedVersion: null,
    };
  }
  if (!isObject(raw)) {
    return {
      preferences: empty,
      problems: [{ file, reason: "not a view-state object; using the defaults" }],
      unsupportedVersion: null,
    };
  }
  if (raw.version !== undefined && raw.version !== VERSION) {
    const version = JSON.stringify(raw.version);
    return {
      preferences: empty,
      problems: [{ file, reason: `unsupported view-state version ${version}; using the defaults and not saving` }],
      unsupportedVersion: version,
    };
  }
  const reasons: string[] = [];
  const view = pick(raw.view, DEFAULT_VIEW, VIEW_CHECKS, "view", reasons);
  const databases: Record<string, DatabasePreferences> = {};
  if (raw.databases !== undefined) {
    if (!isObject(raw.databases)) reasons.push("databases: must be an object; using none");
    else {
      for (const [id, entry] of Object.entries(raw.databases)) {
        if (!UUID.test(id)) reasons.push(`databases.${id}: not a database id; ignored`);
        else databases[id.toLowerCase()] = pick(entry, DEFAULT_DATABASE, DATABASE_CHECKS, `databases.${id}`, reasons);
      }
    }
  }
  return {
    preferences: { view, databases },
    problems: reasons.map(reason => ({ file, reason })),
    unsupportedVersion: null,
  };
}

/** Read the view state. A missing file is the defaults; invalid fields keep their defaults with problems. */
export function readPreferences(file: string): { preferences: Preferences; problems: PreferenceProblem[] } {
  const { preferences, problems } = load(file);
  return { preferences, problems };
}

function databaseId(id: string): string {
  if (!UUID.test(id)) throw new TypeError(`invalid database id ${JSON.stringify(id)}: expected the database UUID`);
  return id.toLowerCase();
}

function checked<T extends object>(
  changes: Partial<T> | undefined,
  checks: { readonly [K in keyof T]: Check },
  at: string,
): Partial<T> {
  const out: Partial<T> = {};
  if (changes === undefined) return out;
  for (const key of Object.keys(checks) as (keyof T)[]) {
    if (!Object.hasOwn(changes, key)) continue;
    const value = changes[key];
    const why = checks[key](value);
    if (why !== null) throw new TypeError(`${at}.${String(key)} ${why}`);
    out[key] = (key === "filter" ? copyFilter(value as TaskFilter) : value) as T[keyof T];
  }
  return out;
}

function writeAtomically(file: string, data: string): void {
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
 * Merge `changes` into the view state on disk and write it atomically:
 * re-read the file, apply only the given fields (validated; unknown fields
 * are dropped), write a 0600 temp file and rename it over the original.
 * Throws for invalid changes before writing, and never overwrites a file
 * with an unsupported (e.g. newer) version. Returns the merged state.
 */
export function savePreferences(file: string, changes: PreferenceChanges): Preferences {
  const view = checked(changes.view, VIEW_CHECKS, "view");
  const databaseChanges: [string, Partial<DatabasePreferences>][] = Object.entries(changes.databases ?? {}).map(
    ([id, patch]) => [databaseId(id), checked(patch, DATABASE_CHECKS, `databases.${id}`)],
  );
  const current = load(file);
  if (current.unsupportedVersion !== null) {
    throw new Error(`${file} has unsupported view-state version ${current.unsupportedVersion}; not saving`);
  }
  const databases: Record<string, DatabasePreferences> = { ...current.preferences.databases };
  for (const [id, patch] of databaseChanges) databases[id] = { ...(databases[id] ?? DEFAULT_DATABASE), ...patch };
  const merged: Preferences = { view: { ...current.preferences.view, ...view }, databases };
  const out = {
    version: VERSION,
    view: Object.fromEntries(VIEW_KEYS.map(k => [k, merged.view[k]])),
    databases: Object.fromEntries(
      Object.entries(merged.databases).map(([id, entry]) => [
        id,
        Object.fromEntries(DATABASE_KEYS.map(k => [k, entry[k]])),
      ]),
    ),
  };
  writeAtomically(file, `${JSON.stringify(out, null, 2)}\n`);
  return merged;
}

/** One TUI session's view of a profile's state. */
export interface PreferenceSession {
  readonly file: string;
  /** Startup state plus this session's own changes (never another session's). */
  view(): ViewPreferences;
  database(id: string): DatabasePreferences;
  setView<K extends keyof ViewPreferences>(key: K, value: ViewPreferences[K]): void;
  setDatabase<K extends keyof DatabasePreferences>(id: string, key: K, value: DatabasePreferences[K]): void;
  /** Merge the fields changed since the last save into the file. No-op when nothing changed. */
  save(): void;
  /** Problems found when the state was read at startup, for `:messages`. */
  problems(): readonly PreferenceProblem[];
}

export function openPreferences(file: string): PreferenceSession {
  const loaded = readPreferences(file);
  let view: ViewPreferences = loaded.preferences.view;
  const databases = new Map<string, DatabasePreferences>(Object.entries(loaded.preferences.databases));
  let pendingView: Partial<Record<keyof ViewPreferences, unknown>> = {};
  let pendingDatabases = new Map<string, Partial<Record<keyof DatabasePreferences, unknown>>>();

  return {
    file,
    view: () => view,
    database: id => databases.get(databaseId(id)) ?? DEFAULT_DATABASE,
    setView(key, value) {
      const why = VIEW_CHECKS[key](value);
      if (why !== null) throw new TypeError(`view.${key} ${why}`);
      view = { ...view, [key]: value };
      pendingView[key] = value;
    },
    setDatabase(id, key, value) {
      const db = databaseId(id);
      const why = DATABASE_CHECKS[key](value);
      if (why !== null) throw new TypeError(`databases.${db}.${key} ${why}`);
      const stored = key === "filter" ? copyFilter(value as TaskFilter) : value;
      databases.set(db, { ...(databases.get(db) ?? DEFAULT_DATABASE), [key]: stored });
      pendingDatabases.set(db, { ...(pendingDatabases.get(db) ?? {}), [key]: stored });
    },
    save() {
      if (Object.keys(pendingView).length === 0 && pendingDatabases.size === 0) return;
      savePreferences(file, {
        view: pendingView as Partial<ViewPreferences>,
        databases: Object.fromEntries(pendingDatabases) as Record<string, Partial<DatabasePreferences>>,
      });
      pendingView = {};
      pendingDatabases = new Map();
    },
    problems: () => loaded.problems,
  };
}
