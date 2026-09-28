import { test, expect, describe, afterAll } from "bun:test";
import { ConflictError, Store, type Task } from "../../../src/store.ts";
import { runCli, mkTmpEnv } from "../helpers.ts";

// The `updates.summary` CHECK cap was raised 1024 -> 4096. A DB created by
// an earlier release still carries the old constraint in its DDL, so the
// `updates-summary-4096` migration must rebuild the table (reported by
// `cortex doctor`, applied by `cortex init`). Earlier cap bumps shipped with
// boundary tests only; this file covers the legacy-DB path end to end.
//
// Fixture strategy: legacy DBs are fabricated with the `sqlite3` CLI. The
// repo rule is that `bun:sqlite` is opened ONLY in src/store.ts, and the
// current binary cannot create an old schema, so the fixture is built out
// of process. Skipped (not failed) when sqlite3 is not on PATH.

const SQLITE3 = Bun.which("sqlite3");

const LANES_DDL = `
CREATE TABLE lanes (
  name  TEXT PRIMARY KEY,
  color TEXT,
  sort  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO lanes (name, color, sort) VALUES ('now', '#fe8019', 0);
`;

const SEED_ROWS = `
INSERT INTO tasks (id, lane, title, body, status, priority, created, updated)
  VALUES (1, 'now', 'legacy task', NULL, 'open', 1, 1000, 1000);
INSERT INTO updates (id, task_id, author, summary, body, severity, created)
  VALUES (7, 1, 'legacy-1', 'kept across the rebuild', 'and my body too', 'progress', 2000);
`;

// Exactly the schema the 1024-era release created (tasks already had the
// draft status + nullable priority), with `_migrations` seeded the way
// that release left it.
const LEGACY_1024_DB = `
${LANES_DDL}
CREATE TABLE tasks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  lane     TEXT    NOT NULL DEFAULT 'now',
  title    TEXT    NOT NULL,
  body     TEXT,
  status   TEXT    NOT NULL DEFAULT 'open'
           CHECK(status IN ('draft','open','review','blocked','done')),
  priority INTEGER,
  created  INTEGER NOT NULL,
  updated  INTEGER NOT NULL,
  FOREIGN KEY(lane) REFERENCES lanes(name) ON UPDATE CASCADE
);
CREATE TABLE updates (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author   TEXT    NOT NULL,
  summary  TEXT    NOT NULL CHECK(length(summary) <= 1024),
  body     TEXT,
  severity TEXT    NOT NULL
           CHECK(severity IN ('progress','review','blocked')),
  created  INTEGER NOT NULL
);
CREATE TABLE _migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
INSERT INTO _migrations (name, applied_at) VALUES
  ('tasks-status-draft', 1), ('tasks-priority-nullable', 1), ('updates-summary-1024', 1);
${SEED_ROWS}
`;

// A 200-era DB: pre-`_migrations`, old status CHECK, NOT NULL priority,
// 200-char summary. Column set matches what the existing `tasks-*`
// migrations assume (`INSERT INTO tasks_new SELECT * FROM tasks`).
const LEGACY_200_DB = `
${LANES_DDL}
CREATE TABLE tasks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  lane     TEXT    NOT NULL DEFAULT 'now',
  title    TEXT    NOT NULL,
  body     TEXT,
  status   TEXT    NOT NULL DEFAULT 'open'
           CHECK(status IN ('open','review','blocked','done')),
  priority INTEGER NOT NULL DEFAULT 1,
  created  INTEGER NOT NULL,
  updated  INTEGER NOT NULL,
  FOREIGN KEY(lane) REFERENCES lanes(name) ON UPDATE CASCADE
);
CREATE TABLE updates (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author   TEXT    NOT NULL,
  summary  TEXT    NOT NULL CHECK(length(summary) <= 200),
  body     TEXT,
  severity TEXT    NOT NULL
           CHECK(severity IN ('progress','review','blocked')),
  created  INTEGER NOT NULL
);
${SEED_ROWS}
`;

const TASK_SCOPES = ["body", "entity", "lane", "priority", "status", "title"];

/**
 * Plan @400 N7/N10: an upgraded legacy DB gains the private identity/revision/
 * receipt tables additively. Its legacy rows (never stamped) still get one
 * token per scope, a guarded write works against them, and a stale guard is
 * refused without writing.
 */
function expectRevisionsAfterUpgrade(dbPath: string, taskId: number): void {
  const s = Store.open(dbPath, { warnMigrations: false });
  try {
    expect(s.databaseId()).toMatch(/^[0-9a-f-]{36}$/);
    const legacy = s.taskState(taskId);
    expect(Object.keys(legacy?.versions ?? {}).sort()).toEqual(TASK_SCOPES);
    const seen = legacy?.versions.title;
    s.editTask(taskId, { title: "renamed after upgrade" }, { expected: { title: seen } });
    expect(() => s.editTask(taskId, { title: "stale" }, { expected: { title: seen } })).toThrow(ConflictError);
    expect(s.getTask(taskId)?.title).toBe("renamed after upgrade");
  } finally {
    s.close();
  }
}

function tokensOf(dbPath: string, id: number): string[] {
  const s = Store.open(dbPath, { warnMigrations: false });
  try {
    return Object.values(s.taskState(id)?.versions ?? {}).filter((v): v is string => typeof v === "string");
  } finally {
    s.close();
  }
}

function fabricateLegacyDb(dbPath: string, sql: string): void {
  if (!SQLITE3) throw new Error("sqlite3 CLI missing");
  const proc = Bun.spawnSync([SQLITE3, dbPath, sql], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`sqlite3 fixture failed: ${proc.stderr.toString()}`);
  }
}

type Env = ReturnType<typeof mkTmpEnv>;
const envs: Env[] = [];
afterAll(() => {
  for (const e of envs) e.cleanup();
});

function legacyEnv(label: string, sql: string): Env {
  const e = mkTmpEnv(label);
  envs.push(e);
  fabricateLegacyDb(e.env.CORTEX_DB as string, sql);
  return e;
}

describe.skipIf(!SQLITE3)("updates-summary-4096 migration", () => {
  test("1024-era DB: doctor reports it pending, init applies it, data and ids survive, new cap enforced", async () => {
    const e = legacyEnv("migrate-1024", LEGACY_1024_DB);
    const run = (...args: string[]) => runCli({ args, env: e.env });

    // Detection: only the new migration is pending on a 1024-era DB.
    let r = await run("doctor", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).pendingMigrations).toEqual(["updates-summary-4096"]);

    // Any ordinary command nudges the user toward `cortex init`.
    r = await run("ls");
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/migrations pending \(updates-summary-4096\)/);

    // Apply through the shipped path.
    r = await run("init");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ migration applied: updates-summary-4096");

    r = await run("doctor", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).pendingMigrations).toEqual([]);

    // Second init is a no-op: nothing pending, nothing re-applied.
    r = await run("init");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("migration applied");

    // Legacy row survived the rebuild verbatim.
    const s = Store.open(e.env.CORTEX_DB, { warnMigrations: false });
    const rows = s.listUpdates(1);
    s.close();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      id: 7,
      task_id: 1,
      author: "legacy-1",
      summary: "kept across the rebuild",
      body: "and my body too",
      created: 2000,
    });

    // New cap holds at the CLI boundary, and AUTOINCREMENT continues from
    // the old sequence instead of restarting at 1.
    r = await run("update", "1", "-m", "y".repeat(4096), "--as", "a-1");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ update [8] posted on task 1");

    r = await run("update", "1", "-m", "y".repeat(4097), "--as", "a-1");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/summary too long/);

    expectRevisionsAfterUpgrade(e.env.CORTEX_DB as string, 1);
  });

  test("200-era DB: the whole chain applies in one init, ending at the 4096 cap", async () => {
    const e = legacyEnv("migrate-200", LEGACY_200_DB);
    const run = (...args: string[]) => runCli({ args, env: e.env });

    let r = await run("doctor", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).pendingMigrations).toEqual([
      "tasks-status-draft",
      "tasks-priority-nullable",
      "updates-summary-1024",
      "updates-summary-4096",
    ]);

    r = await run("init");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ migration applied: updates-summary-1024");
    expect(r.stdout).toContain("✓ migration applied: updates-summary-4096");

    r = await run("doctor", "--json");
    expect(JSON.parse(r.stdout).pendingMigrations).toEqual([]);

    r = await run("update", "1", "-m", "y".repeat(4096), "--as", "a-1");
    expect(r.code).toBe(0);
    r = await run("update", "1", "-m", "y".repeat(4097), "--as", "a-1");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/summary too long/);

    const s = Store.open(e.env.CORTEX_DB, { warnMigrations: false });
    expect(s.listUpdates(1).map(u => u.summary)).toEqual(["kept across the rebuild", "y".repeat(4096)]);
    s.close();

    expectRevisionsAfterUpgrade(e.env.CORTEX_DB as string, 1);
  });

  // The legacy tasks-table rebuilds reset sqlite_sequence to MAX(id), so a task
  // id deleted before `cortex init` can be issued again afterwards (see the
  // todo below). Whatever id the next task gets, its revision tokens must be
  // fresh: tombstones and random tokens keep stale guards from matching (ABA).
  test("200-era DB: a task created after the tasks rebuild never inherits a deleted task's tokens", async () => {
    const e = legacyEnv("migrate-200-aba", LEGACY_200_DB);
    const db = e.env.CORTEX_DB as string;
    const run = (...args: string[]) => runCli({ args, env: e.env });

    // Pre-init, the 200-era tasks table still has `priority NOT NULL`.
    let r = await run("add", "doomed", "-p", "1", "--json");
    expect(r.code).toBe(0);
    const doomed = JSON.parse(r.stdout) as Task;
    const before = tokensOf(db, doomed.id);
    expect(before.length).toBe(6);
    r = await run("rm", String(doomed.id), "--force");
    expect(r.code).toBe(0);

    r = await run("init");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ migration applied: tasks-priority-nullable");

    r = await run("add", "after the rebuild", "--json");
    expect(r.code).toBe(0);
    const next = JSON.parse(r.stdout) as Task;
    const after = tokensOf(db, next.id);
    expect(after.length).toBe(6);
    for (const value of after) expect(before).not.toContain(value);
  });

  // Pre-existing defect, reported with plan @400 Task 4 and NOT fixed here (N10
  // forbids opportunistic rewrites of legacy migrations): _runMigration's DROP
  // TABLE discards the old high-water mark and its `INSERT OR REPLACE INTO
  // sqlite_sequence ... MAX(id)` appends a duplicate row, so ids deleted before
  // the rebuild are issued again.
  test.todo("200-era DB: the tasks rebuild keeps the AUTOINCREMENT high-water mark", async () => {
    const e = legacyEnv("migrate-200-seq", LEGACY_200_DB);
    const run = (...args: string[]) => runCli({ args, env: e.env });
    let r = await run("add", "doomed", "-p", "1", "--json");
    const doomed = JSON.parse(r.stdout) as Task;
    await run("rm", String(doomed.id), "--force");
    await run("init");
    r = await run("add", "after the rebuild", "--json");
    expect((JSON.parse(r.stdout) as Task).id).toBeGreaterThan(doomed.id);
  });
});
