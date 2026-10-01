// Per-profile TUI view state: `configDir()/tui/<profile>.state.json`, holding
// each database's last task. Settings live in tui.toml, which the :config pane
// writes (src/tui/settings.ts); themes are read-only.
//
// - Entries are keyed by the database UUID, so another or a reset database
//   never restores a foreign task.
// - Saving re-reads the file, merges ONLY the fields this session changed
//   since its last save, and renames a private temp file over it, so
//   concurrent sessions on one profile never erase each other's choices.
//   (Two saves racing inside the same few-millisecond read-to-rename window
//   can still lose the earlier one's fields: there is no lock.)
// - Read at startup and never live-broadcast: a session's own view is its
//   startup state plus its own changes.
// - Only known fields are ever written: the file never contains drafts.
// - The settings it once held (theme, density, line numbers, the document
//   mode, the list's sort and grouping) belong to tui.toml: migrateSettings
//   moves them once, and every save carries them until it has. Everything
//   else it once held (the open panel, include-done, the task list, each
//   database's filter and search) is dropped by the next save: commands and
//   shortcuts last only for the session.

import fs from "node:fs";
import {
  DEFAULT_CONFIG,
  DOCUMENT_MODES,
  isDensity,
  isThemeName,
  saveSettings,
  TASK_GROUPS,
  TASK_SORTS,
  type TuiConfig,
  writeAtomically,
} from "./config.ts";

export interface DatabasePreferences {
  readonly lastTask: number | null;
}

export interface Preferences {
  /** Keyed by database UUID. */
  readonly databases: Readonly<Record<string, DatabasePreferences>>;
}

export interface PreferenceChanges {
  readonly databases?: Readonly<Record<string, Partial<DatabasePreferences>>>;
}

export interface PreferenceProblem {
  readonly file: string;
  readonly reason: string;
}

export const DEFAULT_DATABASE: DatabasePreferences = { lastTask: null };

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Check = (value: unknown) => string | null;

const bool: Check = v => (typeof v === "boolean" ? null : "must be true or false");
const oneOf =
  (values: readonly string[]): Check =>
  v =>
    (values as readonly unknown[]).includes(v)
      ? null
      : `must be one of ${values.map(x => JSON.stringify(x)).join(", ")}`;

/** View fields that moved to tui.toml, by tui.toml key: read only to migrate, carried until then. */
const MOVED_KEYS = {
  theme: "theme",
  density: "density",
  lineNumbers: "number",
  mode: "mode",
  sort: "sort",
  group: "group",
} as const;
type MovedField = keyof typeof MOVED_KEYS;
type Moved = Partial<Record<MovedField, unknown>>;
const MOVED_CHECKS: { readonly [K in MovedField]: Check } = {
  theme: v => (v === null || isThemeName(v) ? null : "must be a theme name or null"),
  density: v => (v === null || isDensity(v) ? null : 'must be "comfortable", "compact" or null'),
  lineNumbers: bool,
  mode: oneOf(DOCUMENT_MODES),
  sort: oneOf(TASK_SORTS),
  group: oneOf(TASK_GROUPS),
};
/** The legacy settings by their tui.toml key: what migrateSettings could not move applies to this session. */
export type MovedSettings = Partial<Pick<TuiConfig, (typeof MOVED_KEYS)[MovedField]>>;

const DATABASE_CHECKS: { readonly [K in keyof DatabasePreferences]: Check } = {
  lastTask: v =>
    v === null || (Number.isSafeInteger(v) && (v as number) > 0) ? null : "must be a positive task id or null",
};
const DATABASE_KEYS = Object.keys(DATABASE_CHECKS) as (keyof DatabasePreferences)[];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

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
    if (why === null) out[key] = value;
    else problems.push(`${at}.${String(key)}: ${why}; using the default`);
  }
  return out as T;
}

type Loaded = {
  preferences: Preferences;
  problems: PreferenceProblem[];
  unsupportedVersion: string | null;
  /** The valid legacy settings in the file's view, by view field. */
  moved: Moved;
};

function load(file: string): Loaded {
  const empty: Preferences = { databases: {} };
  const failed = (reason: string, unsupportedVersion: string | null = null): Loaded => ({
    preferences: empty,
    problems: [{ file, reason }],
    unsupportedVersion,
    moved: {},
  });
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { preferences: empty, problems: [], unsupportedVersion: null, moved: {} };
    return failed(`cannot read view state: ${code}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return failed(`not valid JSON (${(err as Error).message}); using the defaults`);
  }
  if (!isObject(raw)) return failed("not a view-state object; using the defaults");
  if (raw.version !== undefined && raw.version !== VERSION) {
    const version = JSON.stringify(raw.version);
    return failed(`unsupported view-state version ${version}; using the defaults and not saving`, version);
  }
  const reasons: string[] = [];
  // The view is read only for the settings that move to tui.toml; its other fields are dropped.
  const moved: Moved = isObject(raw.view)
    ? pick(raw.view, {} as Record<MovedField, unknown>, MOVED_CHECKS, "view", reasons)
    : {};
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
    preferences: { databases },
    problems: reasons.map(reason => ({ file, reason })),
    unsupportedVersion: null,
    moved,
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

/** The known fields of `changes`, validated (unknown fields are dropped); throws for an invalid one. */
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
    out[key] = value;
  }
  return out;
}

/**
 * Merge `changes` into the view state on disk and write it atomically:
 * re-read the file, apply only the given fields (validated; unknown fields
 * are dropped), write a 0600 temp file and rename it over the original.
 * The valid legacy settings are carried unchanged as `view` unless
 * `dropMoved` (they moved to tui.toml); with none, the file has no `view`.
 * Throws for invalid changes before writing, and never overwrites a file
 * with an unsupported (e.g. newer) version. Returns the merged state.
 */
export function savePreferences(
  file: string,
  changes: PreferenceChanges,
  options: { dropMoved?: boolean } = {},
): Preferences {
  const databaseChanges: [string, Partial<DatabasePreferences>][] = Object.entries(changes.databases ?? {}).map(
    ([id, patch]) => [databaseId(id), checked(patch, DATABASE_CHECKS, `databases.${id}`)],
  );
  const current = load(file);
  if (current.unsupportedVersion !== null) {
    throw new Error(`${file} has unsupported view-state version ${current.unsupportedVersion}; not saving`);
  }
  const databases: Record<string, DatabasePreferences> = { ...current.preferences.databases };
  for (const [id, patch] of databaseChanges) databases[id] = { ...(databases[id] ?? DEFAULT_DATABASE), ...patch };
  const moved = options.dropMoved ? {} : current.moved;
  const out = {
    version: VERSION,
    ...(Object.keys(moved).length > 0 ? { view: moved } : {}),
    databases: Object.fromEntries(
      Object.entries(databases).map(([id, entry]) => [id, Object.fromEntries(DATABASE_KEYS.map(k => [k, entry[k]]))]),
    ),
  };
  writeAtomically(file, `${JSON.stringify(out, null, 2)}\n`);
  return { databases };
}

/** One TUI session's view of a profile's state. */
export interface PreferenceSession {
  readonly file: string;
  /** Startup state plus this session's own changes (never another session's). */
  database(id: string): DatabasePreferences;
  setDatabase<K extends keyof DatabasePreferences>(id: string, key: K, value: DatabasePreferences[K]): void;
  /** Merge the fields changed since the last save into the file. No-op when nothing changed. */
  save(): void;
  /** Problems found when the state was read at startup, for `:messages`. */
  problems(): readonly PreferenceProblem[];
}

export function openPreferences(file: string): PreferenceSession {
  const loaded = readPreferences(file);
  const databases = new Map<string, DatabasePreferences>(Object.entries(loaded.preferences.databases));
  let pending = new Map<string, Partial<DatabasePreferences>>();

  return {
    file,
    database: id => databases.get(databaseId(id)) ?? DEFAULT_DATABASE,
    setDatabase(id, key, value) {
      const db = databaseId(id);
      if (!Object.hasOwn(DATABASE_CHECKS, key)) throw new TypeError(`databases.${db}.${key} is not kept`);
      const why = DATABASE_CHECKS[key](value);
      if (why !== null) throw new TypeError(`databases.${db}.${key} ${why}`);
      databases.set(db, { ...(databases.get(db) ?? DEFAULT_DATABASE), [key]: value });
      pending.set(db, { ...(pending.get(db) ?? {}), [key]: value });
    },
    save() {
      if (pending.size === 0) return;
      savePreferences(file, { databases: Object.fromEntries(pending) });
      pending = new Map();
    },
    problems: () => loaded.problems,
  };
}

/**
 * The one-time move of the legacy view settings into tui.toml, run at startup before tui.toml is read.
 * Only valid, non-null, non-default values are written, and only for keys tui.toml lacks (its keys
 * win); the fields then leave the state file. When either write fails, the state file keeps them and
 * `unmoved` holds the values for this session to apply: the next start retries.
 */
export function migrateSettings(
  stateFile: string,
  configFile: string,
): { unmoved: MovedSettings; problems: PreferenceProblem[] } {
  const { moved, unsupportedVersion } = load(stateFile);
  const fields = Object.keys(moved) as MovedField[];
  if (unsupportedVersion !== null || fields.length === 0) return { unmoved: {}, problems: [] };
  const changes: Record<string, unknown> = {};
  for (const field of fields) {
    const key = MOVED_KEYS[field];
    if (moved[field] !== null && moved[field] !== DEFAULT_CONFIG[key]) changes[key] = moved[field];
  }
  const unmoved = changes as MovedSettings;
  try {
    if (Object.keys(changes).length > 0) saveSettings(configFile, unmoved, { onlyMissing: true });
    savePreferences(stateFile, {}, { dropMoved: true });
    return { unmoved: {}, problems: [] };
  } catch (err) {
    const keys = fields.map(field => MOVED_KEYS[field]).join(", ");
    const reason = `could not move ${keys} into ${configFile}: ${(err as Error).message}; they apply to this session and move at the next start`;
    return { unmoved, problems: [{ file: stateFile, reason }] };
  }
}
