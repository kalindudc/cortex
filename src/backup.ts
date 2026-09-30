import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddNotificationInput, Store } from "./store.ts";
import { backupsDir } from "./paths.ts";
import pkg from "../package.json" with { type: "json" };

export type BackupStats = {
  lanes: number;
  tags: number;
  tasks: number;
  updates: number;
  task_tags: number;
  notifications: number;
};

export type BackupDoc = {
  format: "cortex-backup";
  format_version: 1;
  cortex_version: string;
  created_at: number;
  source_host: string;
  source_user: string;
  stats: BackupStats;
  /** Column names observed at export time. Data-only metadata, not schema DDL. */
  tables: Record<string, string[]>;
  lanes: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  task_tags: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
};

export type CreateBackupOpts = { liveDbPath: string; outPath: string; rotate?: number };
export type RestoreOpts = { backupPath: string; liveStore: Store };
export type RestoreCounts = {
  lanes: { new: number; existing: number };
  tags: { new: number; existing: number };
  tasks: { preserved: number; bumped: number };
  updates: number;
  taskTags: number;
  notifications: number;
  skipped: { updates: number; taskTags: number; notifications: number };
};
export type DryRunResult = {
  doc: Pick<BackupDoc, "format_version" | "cortex_version" | "created_at" | "source_host" | "stats">;
  would: RestoreCounts;
};

type TableSpec = {
  name: keyof Pick<BackupDoc, "lanes" | "tags" | "tasks" | "updates" | "task_tags" | "notifications">;
  columns: readonly string[];
  idColumn: string | null;
  optional?: boolean;
};

export const TABLES: ReadonlyArray<TableSpec> = [
  { name: "lanes", columns: ["name", "color", "sort"], idColumn: null },
  { name: "tags", columns: ["name", "color", "created"], idColumn: null },
  {
    name: "tasks",
    columns: ["id", "lane", "title", "body", "status", "priority", "created", "updated"],
    idColumn: "id",
  },
  { name: "updates", columns: ["id", "task_id", "author", "summary", "body", "severity", "created"], idColumn: "id" },
  { name: "task_tags", columns: ["task_id", "tag_name"], idColumn: null },
  {
    name: "notifications",
    columns: ["id", "task_id", "author", "status", "title", "message", "read", "created"],
    idColumn: "id",
    optional: true,
  },
] as const;

const FORMAT_VERSION = 1;
const JSON_ENTRY = "cortex-backup.json";

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function commandAvailable(name: string): boolean {
  try {
    return Bun.spawnSync(["which", name]).exitCode === 0;
  } catch {
    return false;
  }
}

function requireCommand(name: "zip" | "unzip"): void {
  if (commandAvailable(name)) return;
  const install = name === "zip" ? "install zip (Info-ZIP)" : "install unzip (Info-ZIP)";
  throw new Error(`'${name}' not found on PATH; ${install} to use cortex backups`);
}

function qIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

function readTransaction<T>(db: Database, fn: () => T): T {
  db.run("BEGIN DEFERRED TRANSACTION;");
  try {
    const value = fn();
    db.run("COMMIT;");
    return value;
  } catch (err) {
    try {
      db.run("ROLLBACK;");
    } catch {
      /* ignore rollback failure; preserve original error */
    }
    throw err;
  }
}

function sourceUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

function sourceHost(): string {
  try {
    return os.hostname();
  } catch {
    return "unknown";
  }
}

function emptyStats(): BackupStats {
  return { lanes: 0, tags: 0, tasks: 0, updates: 0, task_tags: 0, notifications: 0 };
}

function emptyCounts(): RestoreCounts {
  return {
    lanes: { new: 0, existing: 0 },
    tags: { new: 0, existing: 0 },
    tasks: { preserved: 0, bumped: 0 },
    updates: 0,
    taskTags: 0,
    notifications: 0,
    skipped: { updates: 0, taskTags: 0, notifications: 0 },
  };
}

function rowArray(doc: Record<string, unknown>, name: TableSpec["name"]): Record<string, unknown>[] {
  const value = doc[name];
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function normalisedStats(doc: Record<string, unknown>): BackupStats {
  const stats = typeof doc.stats === "object" && doc.stats !== null ? (doc.stats as Record<string, unknown>) : {};
  return {
    lanes: Number(stats.lanes ?? rowArray(doc, "lanes").length),
    tags: Number(stats.tags ?? rowArray(doc, "tags").length),
    tasks: Number(stats.tasks ?? rowArray(doc, "tasks").length),
    updates: Number(stats.updates ?? rowArray(doc, "updates").length),
    task_tags: Number(stats.task_tags ?? rowArray(doc, "task_tags").length),
    notifications: Number(stats.notifications ?? rowArray(doc, "notifications").length),
  };
}

function validateDoc(raw: unknown): BackupDoc {
  if (typeof raw !== "object" || raw === null) throw new Error("invalid backup: expected JSON object");
  const doc = raw as Record<string, unknown>;
  if (doc.format !== "cortex-backup") throw new Error("invalid backup: format must be 'cortex-backup'");
  if (typeof doc.format_version !== "number") throw new Error("invalid backup: missing format_version");
  if (doc.format_version > FORMAT_VERSION) {
    throw new Error(`unsupported backup format_version ${doc.format_version}; this cortex supports ${FORMAT_VERSION}`);
  }
  if (doc.format_version < 1) throw new Error(`unsupported backup format_version ${doc.format_version}`);

  return {
    format: "cortex-backup",
    format_version: 1,
    cortex_version: typeof doc.cortex_version === "string" ? doc.cortex_version : "unknown",
    created_at: typeof doc.created_at === "number" ? doc.created_at : 0,
    source_host: typeof doc.source_host === "string" ? doc.source_host : "unknown",
    source_user: typeof doc.source_user === "string" ? doc.source_user : "unknown",
    stats: normalisedStats(doc),
    tables: typeof doc.tables === "object" && doc.tables !== null ? (doc.tables as Record<string, string[]>) : {},
    lanes: rowArray(doc, "lanes"),
    tags: rowArray(doc, "tags"),
    tasks: rowArray(doc, "tasks"),
    updates: rowArray(doc, "updates"),
    task_tags: rowArray(doc, "task_tags"),
    notifications: rowArray(doc, "notifications"),
  };
}

function currentColumns(db: Database, table: string): Set<string> {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${qIdent(table)});`).all();
  return new Set(rows.map(r => r.name));
}

function tableHasRows(db: Database, table: string): boolean {
  return currentColumns(db, table).size > 0;
}

function bindValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

function insertDynamic<T extends Record<string, unknown>>(opts: {
  db: Database;
  table: string;
  data: Record<string, unknown>;
  columns: Set<string>;
  orIgnore?: boolean;
  returningId?: boolean;
}): T | null {
  const entries = Object.entries(opts.data).filter(([name, value]) => opts.columns.has(name) && value !== undefined);
  if (entries.length === 0) throw new Error(`cannot insert ${opts.table}: no compatible columns in backup row`);
  const cols = entries.map(([name]) => qIdent(name)).join(", ");
  const placeholders = entries.map(() => "?").join(", ");
  const prefix = opts.orIgnore ? "INSERT OR IGNORE" : "INSERT";
  const returning = opts.returningId ? " RETURNING id" : "";
  const sql = `${prefix} INTO ${qIdent(opts.table)} (${cols}) VALUES (${placeholders})${returning};`;
  const values = entries.map(([, value]) => bindValue(value));
  if (opts.returningId) return opts.db.query<T, (string | number | null)[]>(sql).get(...values) ?? null;
  opts.db.run(sql, values);
  return null;
}

function existsByKey(db: Database, table: "lanes" | "tags", key: string): boolean {
  const row = db.query<{ one: number }, [string]>(`SELECT 1 AS one FROM ${qIdent(table)} WHERE name = ?;`).get(key);
  return row !== null;
}

function asString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function asInt(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** Returns whether the lane was created. */
function ensureLane(db: Database, name: string): boolean {
  return db.run(`INSERT OR IGNORE INTO lanes (name, color, sort) VALUES (?, NULL, 0);`, [name]).changes > 0;
}

/** Returns whether the tag was created. */
function ensureTag(db: Database, name: string): boolean {
  return (
    db.run(`INSERT OR IGNORE INTO tags (name, color, created) VALUES (?, NULL, ?);`, [name, Date.now()]).changes > 0
  );
}

/**
 * Catalog rows a merge created or changed the membership of, so their
 * revision tokens can be stamped inside the merge's transaction.
 */
type Touched = {
  newLanes: Set<string>;
  memberLanes: Set<string>;
  newTags: Set<string>;
  memberTags: Set<string>;
};

function emptyTouched(): Touched {
  return { newLanes: new Set(), memberLanes: new Set(), newTags: new Set(), memberTags: new Set() };
}

/**
 * Imported task ids (preserved OR bumped) get fresh tokens for every scope,
 * so an id the destination had deleted can never satisfy a guard read before
 * that deletion; created lanes/tags start fresh, and existing ones
 * that gained members advance `entity` only (their definition was kept).
 * Destination identity and receipts are never touched, and the v1 archive
 * carries no source receipts to import.
 */
function stampRestored(store: Store, idMap: Map<number, number>, touched: Touched): void {
  store.stampRevisions("task", idMap.values());
  // Body-sync records (agent memory) are never backed up: a reissued id must
  // not inherit a deleted task's record, so restored tasks fall back to their
  // archived `created`.
  store.forgetBodySync(idMap.values());
  store.stampRevisions("lane", touched.newLanes);
  store.stampRevisions(
    "lane",
    [...touched.memberLanes].filter(name => !touched.newLanes.has(name)),
    ["entity"],
  );
  store.stampRevisions("tag", touched.newTags);
  store.stampRevisions(
    "tag",
    [...touched.memberTags].filter(name => !touched.newTags.has(name)),
    ["entity"],
  );
}

function isTaskIdCollision(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || (e?.message ?? "").includes("UNIQUE constraint failed: tasks.id")
  );
}

function backupRows(db: Database, spec: TableSpec): Record<string, unknown>[] {
  try {
    return db.query<Record<string, unknown>, []>(`SELECT * FROM ${qIdent(spec.name)};`).all();
  } catch (err) {
    if (spec.optional && (err as Error).message.includes("no such table")) return [];
    throw err;
  }
}

export function defaultBackupPath(now: Date = new Date()): string {
  const host =
    sourceHost()
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "host";
  const stamp = now.toISOString().replace(/:/g, "-");
  return path.join(backupsDir(), `cortex-${host}-${stamp}.zip`);
}

export function backupNotificationInput(opts: {
  outPath: string;
  bytes: number;
  stats: Pick<BackupStats, "tasks" | "updates">;
  author?: string | null;
}): AddNotificationInput {
  return {
    task_id: null,
    author: opts.author ?? null,
    status: "done",
    title: "Backup created",
    message: `${opts.outPath} (${opts.bytes} bytes; ${opts.stats.tasks} tasks, ${opts.stats.updates} updates)`,
  };
}

export function restoreNotificationInput(opts: { backupPath: string; counts: RestoreCounts }): AddNotificationInput {
  return {
    task_id: null,
    author: null,
    status: "done",
    title: "Restore completed",
    message:
      `${opts.backupPath} (` +
      `${opts.counts.tasks.preserved} tasks preserved, ${opts.counts.tasks.bumped} tasks bumped, ` +
      `${opts.counts.updates} updates)`,
  };
}

export async function exportData(liveDbPath: string): Promise<BackupDoc> {
  const db = new Database(liveDbPath, { readonly: true, strict: true });
  try {
    return readTransaction(db, () => {
      const rows: Record<TableSpec["name"], Record<string, unknown>[]> = {
        lanes: [],
        tags: [],
        tasks: [],
        updates: [],
        task_tags: [],
        notifications: [],
      };
      const tables: Record<string, string[]> = {};
      const stats = emptyStats();
      for (const spec of TABLES) {
        const data = backupRows(db, spec);
        rows[spec.name] = data;
        tables[spec.name] = data.length > 0 ? Object.keys(data[0]) : [...spec.columns];
        stats[spec.name] = data.length;
      }
      return {
        format: "cortex-backup",
        format_version: FORMAT_VERSION,
        cortex_version: pkg.version,
        created_at: Date.now(),
        source_host: sourceHost(),
        source_user: sourceUser(),
        stats,
        tables,
        ...rows,
      } satisfies BackupDoc;
    });
  } finally {
    db.close();
  }
}

function rotateBackups(dir: string, keep: number): void {
  if (keep <= 0 || !fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter(name => /^cortex-.*\.zip$/.test(name))
    .map(name => {
      const full = path.join(dir, name);
      return { full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files.slice(keep)) fs.rmSync(file.full, { force: true });
}

export async function createBackup(opts: CreateBackupOpts): Promise<{ outPath: string; doc: BackupDoc }> {
  requireCommand("zip");
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-backup-"));
  const tmpOut = `${opts.outPath}.tmp`;
  try {
    const doc = await exportData(opts.liveDbPath);
    const jsonPath = path.join(tmpDir, JSON_ENTRY);
    fs.writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`);
    fs.rmSync(tmpOut, { force: true });
    const zipped = Bun.spawnSync(["zip", "-j", "-X", tmpOut, jsonPath]);
    if (zipped.exitCode !== 0) throw new Error(`zip failed: ${decode(zipped.stderr).trim()}`);
    fs.renameSync(tmpOut, opts.outPath);
    rotateBackups(path.dirname(opts.outPath), opts.rotate ?? 0);
    return { outPath: opts.outPath, doc };
  } finally {
    fs.rmSync(tmpOut, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function extractBackup(backupPath: string): { doc: BackupDoc; cleanup: () => void } {
  requireCommand("unzip");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-restore-"));
  const cleanup = () => fs.rmSync(tmpDir, { recursive: true, force: true });
  const unzipped = Bun.spawnSync(["unzip", "-o", "-d", tmpDir, backupPath]);
  if (unzipped.exitCode !== 0) {
    cleanup();
    throw new Error(`unzip failed: ${decode(unzipped.stderr).trim()}`);
  }
  const jsonPath = path.join(tmpDir, JSON_ENTRY);
  if (!fs.existsSync(jsonPath)) {
    cleanup();
    throw new Error(`invalid backup: missing ${JSON_ENTRY}`);
  }
  try {
    return { doc: validateDoc(JSON.parse(fs.readFileSync(jsonPath, "utf8"))), cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function insertLanes(
  db: Database,
  doc: BackupDoc,
  counts: RestoreCounts,
  columns: Set<string>,
  touched: Touched,
): void {
  for (const row of doc.lanes) {
    const name = asString(row, "name");
    if (!name) throw new Error("invalid backup: lane row missing name");
    const existed = existsByKey(db, "lanes", name);
    insertDynamic({ db, table: "lanes", data: row, columns, orIgnore: true });
    if (existed) counts.lanes.existing++;
    else {
      counts.lanes.new++;
      touched.newLanes.add(name);
    }
  }
}

function insertTags(db: Database, doc: BackupDoc, counts: RestoreCounts, columns: Set<string>, touched: Touched): void {
  for (const row of doc.tags) {
    const name = asString(row, "name");
    if (!name) throw new Error("invalid backup: tag row missing name");
    const existed = existsByKey(db, "tags", name);
    const data = { ...row, created: row.created ?? Date.now() };
    insertDynamic({ db, table: "tags", data, columns, orIgnore: true });
    if (existed) counts.tags.existing++;
    else {
      counts.tags.new++;
      touched.newTags.add(name);
    }
  }
}

function insertTasks(
  db: Database,
  doc: BackupDoc,
  counts: RestoreCounts,
  columns: Set<string>,
  touched: Touched,
): Map<number, number> {
  const idMap = new Map<number, number>();
  for (const row of doc.tasks) {
    const oldId = asInt(row, "id");
    if (oldId === null) throw new Error("invalid backup: task row missing numeric id");
    const lane = asString(row, "lane");
    if (lane && ensureLane(db, lane)) touched.newLanes.add(lane);
    touched.memberLanes.add(lane ?? "now");
    const data: Record<string, unknown> = {
      ...row,
      lane: row.lane ?? "now",
      status: row.status ?? "open",
      created: row.created ?? Date.now(),
      updated: row.updated ?? row.created ?? Date.now(),
    };
    try {
      const inserted = insertDynamic<{ id: number }>({ db, table: "tasks", data, columns, returningId: true });
      if (!inserted) throw new Error("failed to insert task");
      idMap.set(oldId, inserted.id);
      counts.tasks.preserved++;
    } catch (err) {
      if (!isTaskIdCollision(err)) throw err;
      const { id: _id, ...bumpedData } = data;
      const inserted = insertDynamic<{ id: number }>({
        db,
        table: "tasks",
        data: bumpedData,
        columns,
        returningId: true,
      });
      if (!inserted) throw new Error("failed to insert bumped task");
      idMap.set(oldId, inserted.id);
      counts.tasks.bumped++;
    }
  }
  return idMap;
}

function insertUpdates(
  db: Database,
  doc: BackupDoc,
  counts: RestoreCounts,
  columns: Set<string>,
  idMap: Map<number, number>,
): void {
  for (const row of doc.updates) {
    const sourceTaskId = asInt(row, "task_id");
    const taskId = sourceTaskId === null ? null : idMap.get(sourceTaskId);
    if (!taskId) {
      counts.skipped.updates++;
      continue;
    }
    const { id: _id, ...rest } = row;
    const data = {
      ...rest,
      task_id: taskId,
      author: rest.author ?? "unknown",
      summary: rest.summary ?? "restored update",
      severity: rest.severity ?? "progress",
      created: rest.created ?? Date.now(),
    };
    insertDynamic({ db, table: "updates", data, columns });
    counts.updates++;
  }
}

function insertTaskTags(
  db: Database,
  doc: BackupDoc,
  counts: RestoreCounts,
  columns: Set<string>,
  idMap: Map<number, number>,
  touched: Touched,
): void {
  for (const row of doc.task_tags) {
    const sourceTaskId = asInt(row, "task_id");
    const taskId = sourceTaskId === null ? null : idMap.get(sourceTaskId);
    const tagName = asString(row, "tag_name");
    if (!taskId || !tagName) {
      counts.skipped.taskTags++;
      continue;
    }
    if (ensureTag(db, tagName)) touched.newTags.add(tagName);
    touched.memberTags.add(tagName);
    insertDynamic({ db, table: "task_tags", data: { ...row, task_id: taskId }, columns, orIgnore: true });
    counts.taskTags++;
  }
}

function insertNotifications(
  db: Database,
  doc: BackupDoc,
  counts: RestoreCounts,
  columns: Set<string>,
  idMap: Map<number, number>,
): void {
  if (columns.size === 0) return;
  for (const row of doc.notifications) {
    const sourceTaskId = row.task_id === null ? null : asInt(row, "task_id");
    const taskId = sourceTaskId === null ? null : idMap.get(sourceTaskId);
    if (sourceTaskId !== null && !taskId) {
      counts.skipped.notifications++;
      continue;
    }
    const { id: _id, ...rest } = row;
    const data = {
      ...rest,
      task_id: taskId,
      status: rest.status ?? "open",
      title: rest.title ?? "restored notification",
      message: rest.message ?? "restored",
      read: rest.read ?? 0,
      created: rest.created ?? Date.now(),
    };
    insertDynamic({ db, table: "notifications", data, columns });
    counts.notifications++;
  }
}

export async function restoreBackup(opts: RestoreOpts): Promise<{ idMap: Map<number, number>; counts: RestoreCounts }> {
  const extracted = extractBackup(opts.backupPath);
  try {
    return opts.liveStore.runInTransaction(db => {
      const counts = emptyCounts();
      const laneColumns = currentColumns(db, "lanes");
      const tagColumns = currentColumns(db, "tags");
      const taskColumns = currentColumns(db, "tasks");
      const updateColumns = currentColumns(db, "updates");
      const taskTagColumns = currentColumns(db, "task_tags");
      const notificationColumns = currentColumns(db, "notifications");
      if (!tableHasRows(db, "lanes") || !tableHasRows(db, "tasks") || !tableHasRows(db, "updates")) {
        throw new Error("destination database is missing required cortex tables");
      }
      const touched = emptyTouched();
      insertLanes(db, extracted.doc, counts, laneColumns, touched);
      insertTags(db, extracted.doc, counts, tagColumns, touched);
      const idMap = insertTasks(db, extracted.doc, counts, taskColumns, touched);
      insertUpdates(db, extracted.doc, counts, updateColumns, idMap);
      insertTaskTags(db, extracted.doc, counts, taskTagColumns, idMap, touched);
      insertNotifications(db, extracted.doc, counts, notificationColumns, idMap);
      stampRestored(opts.liveStore, idMap, touched);
      return { idMap, counts };
    });
  } finally {
    extracted.cleanup();
  }
}

/** Parse and validate a backup archive (extracted to a temp dir that is removed before returning). */
export function readBackup(backupPath: string): BackupDoc {
  const extracted = extractBackup(backupPath);
  try {
    return extracted.doc;
  } finally {
    extracted.cleanup();
  }
}

/** What a destination already holds, as far as a restore projection needs to know. */
type RestoreDestination = { lanes: Set<string>; tags: Set<string>; taskIds: Set<number> };

/**
 * A missing destination: the fresh database a real restore would create
 * first, i.e. `cortex init`'s empty database with only the default `now`
 * lane. Projected, never created.
 */
function freshDestination(): RestoreDestination {
  return { lanes: new Set(["now"]), tags: new Set(), taskIds: new Set() };
}

/**
 * Read the destination with plain SELECTs, so it works on a readonly
 * snapshot and on legacy schemas as they are (no migrate): a database from
 * before tags simply has none. Without the core tables it is not a cortex
 * database this cortex can restore into, which is an error.
 */
function readDestination(store: Store): RestoreDestination {
  return store.runInTransaction(db => {
    if (!tableHasRows(db, "lanes") || !tableHasRows(db, "tasks") || !tableHasRows(db, "updates")) {
      throw new Error("destination database is missing required cortex tables");
    }
    const names = (table: "lanes" | "tags"): Set<string> =>
      new Set(
        db
          .query<{ name: string }, []>(`SELECT name FROM ${qIdent(table)};`)
          .all()
          .map(r => r.name),
      );
    const taskIds = new Set(
      db
        .query<{ id: number }, []>("SELECT id FROM tasks;")
        .all()
        .map(r => r.id),
    );
    return { lanes: names("lanes"), tags: tableHasRows(db, "tags") ? names("tags") : new Set(), taskIds };
  });
}

/**
 * What restoring `doc` into `destination` would insert, without writing.
 * `destination` null means the database does not exist yet (projected as a
 * fresh one). Synchronous and read-only, so it runs inside Store.readSnapshot
 * (no migration, no ownership lease), even beside a live daemon.
 */
export function projectRestore(doc: BackupDoc, destination: Store | null): DryRunResult {
  const dest = destination === null ? freshDestination() : readDestination(destination);
  const counts = emptyCounts();
  for (const row of doc.lanes) {
    const name = asString(row, "name");
    if (!name) continue;
    if (dest.lanes.has(name)) counts.lanes.existing++;
    else counts.lanes.new++;
  }
  for (const row of doc.tags) {
    const name = asString(row, "name");
    if (!name) continue;
    if (dest.tags.has(name)) counts.tags.existing++;
    else counts.tags.new++;
  }
  const docTaskIds = new Set<number>();
  for (const row of doc.tasks) {
    const id = asInt(row, "id");
    if (id === null) continue;
    docTaskIds.add(id);
    if (dest.taskIds.has(id)) counts.tasks.bumped++;
    else counts.tasks.preserved++;
  }
  for (const row of doc.updates) {
    const taskId = asInt(row, "task_id");
    if (taskId !== null && docTaskIds.has(taskId)) counts.updates++;
    else counts.skipped.updates++;
  }
  for (const row of doc.task_tags) {
    const taskId = asInt(row, "task_id");
    if (taskId !== null && docTaskIds.has(taskId)) counts.taskTags++;
    else counts.skipped.taskTags++;
  }
  for (const row of doc.notifications) {
    if (row.task_id === null) {
      counts.notifications++;
      continue;
    }
    const taskId = asInt(row, "task_id");
    if (taskId !== null && docTaskIds.has(taskId)) counts.notifications++;
    else counts.skipped.notifications++;
  }
  return {
    doc: {
      format_version: doc.format_version,
      cortex_version: doc.cortex_version,
      created_at: doc.created_at,
      source_host: doc.source_host,
      stats: doc.stats,
    },
    would: counts,
  };
}

/** projectRestore for an archive on disk; `destination` null projects a missing database. */
export async function dryRunRestore(backupPath: string, destination: Store | null): Promise<DryRunResult> {
  return projectRestore(readBackup(backupPath), destination);
}
