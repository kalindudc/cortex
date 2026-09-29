import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, mutationDigest, type Task } from "../../src/store.ts";
import type { ResourceScope, Versions } from "../../src/contracts.ts";
import {
  createBackup,
  dryRunRestore,
  exportData,
  projectRestore,
  readBackup,
  restoreBackup,
  TABLES,
  type BackupDoc,
} from "../../src/backup.ts";

const tmpRoots: string[] = [];

function tmpDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cortex-${label}-`));
  tmpRoots.push(dir);
  return dir;
}

function openTmpStore(label: string): { dir: string; dbPath: string; store: Store } {
  const dir = tmpDir(label);
  const dbPath = path.join(dir, "cortex.db");
  return { dir, dbPath, store: Store.open(dbPath, { warnMigrations: false }) };
}

function unzipJson(outPath: string): BackupDoc {
  const r = Bun.spawnSync(["unzip", "-p", outPath, "cortex-backup.json"]);
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
  return JSON.parse(new TextDecoder().decode(r.stdout)) as BackupDoc;
}

function writeBackupDoc(doc: Record<string, unknown>): string {
  const dir = tmpDir("backup-doc");
  const jsonPath = path.join(dir, "cortex-backup.json");
  const outPath = path.join(dir, "legacy.zip");
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2));
  const r = Bun.spawnSync(["zip", "-j", "-X", outPath, jsonPath]);
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
  return outPath;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("backup data export", () => {
  test("exportData returns a data-only document with flat rows and stats", async () => {
    const { dbPath, store } = openTmpStore("export");
    try {
      store.addLane({ name: "later", color: "#888888", sort: 1 });
      const task = store.addTask({ title: "ship backup", lane: "later", body: "body", priority: 0 });
      store.addUpdate({ task_id: task.id, author: "unit", summary: "first update" });
      store.setTaskTags(task.id, ["backup"]);
      store.addNotification({ task_id: task.id, author: "unit", status: "open", title: "created", message: "created" });

      const doc = await exportData(dbPath);
      expect(doc.format).toBe("cortex-backup");
      expect(doc.format_version).toBe(1);
      expect(doc.stats.tasks).toBe(1);
      expect(doc.stats.updates).toBe(1);
      expect(doc.stats.task_tags).toBe(1);
      expect(doc.stats.notifications).toBe(1);
      const taskColumns = TABLES.find(t => t.name === "tasks")?.columns ?? [];
      expect(Object.keys(doc.tasks[0]).sort()).toEqual([...taskColumns].sort());
    } finally {
      store.close();
    }
  });

  test("createBackup writes one JSON document and rotate keeps newest cortex zips only", async () => {
    const { dbPath, dir, store } = openTmpStore("create");
    try {
      store.addTask({ title: "one" });
      const backupDir = path.join(dir, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      for (let i = 0; i < 3; i++) {
        const p = path.join(backupDir, `cortex-old-${i}.zip`);
        fs.writeFileSync(p, "fake");
        fs.utimesSync(p, new Date(1_000 + i), new Date(1_000 + i));
      }
      const ignored = path.join(backupDir, "notes.zip");
      fs.writeFileSync(ignored, "keep me");
      const outPath = path.join(backupDir, "cortex-new.zip");

      await createBackup({ liveDbPath: dbPath, outPath, rotate: 2 });

      expect(fs.existsSync(outPath)).toBe(true);
      const listed = Bun.spawnSync(["unzip", "-l", outPath]);
      expect(listed.exitCode).toBe(0);
      expect(new TextDecoder().decode(listed.stdout)).toContain("cortex-backup.json");
      expect(unzipJson(outPath).stats.tasks).toBe(1);
      const remaining = fs.readdirSync(backupDir).filter(n => n.startsWith("cortex-") && n.endsWith(".zip"));
      expect(remaining.sort()).toEqual(["cortex-new.zip", "cortex-old-2.zip"].sort());
      expect(fs.existsSync(ignored)).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("restore merge semantics", () => {
  test("restoreBackup preserves ids into a clean store and dry-run is a no-op", async () => {
    const source = openTmpStore("source-clean");
    const dest = openTmpStore("dest-clean");
    try {
      for (const title of ["a", "b", "c"]) source.store.addTask({ title });
      const outPath = path.join(source.dir, "backup.zip");
      await createBackup({ liveDbPath: source.dbPath, outPath });

      const before = dest.store.listTasks().length;
      const dry = await dryRunRestore(outPath, dest.store);
      expect(dry.would.tasks.preserved).toBe(3);
      expect(dest.store.listTasks().length).toBe(before);

      const result = await restoreBackup({ backupPath: outPath, liveStore: dest.store });
      expect(result.counts.tasks).toEqual({ preserved: 3, bumped: 0 });
      expect(dest.store.listTasks().map(t => t.id)).toEqual([1, 2, 3]);
      expect(dest.store.listTasks().map(t => t.title)).toEqual(["a", "b", "c"]);
    } finally {
      source.store.close();
      dest.store.close();
    }
  });

  test("restoreBackup bumps colliding task ids and remaps updates and task tags", async () => {
    const source = openTmpStore("source-collision");
    const dest = openTmpStore("dest-collision");
    try {
      const original = source.store.addTask({ title: "from backup", lane: "later" });
      source.store.addUpdate({ task_id: original.id, author: "unit", summary: "source update" });
      source.store.setTaskTags(original.id, ["restored"]);
      dest.store.addTask({ title: "existing id 1" });
      const outPath = path.join(source.dir, "backup.zip");
      await createBackup({ liveDbPath: source.dbPath, outPath });

      const result = await restoreBackup({ backupPath: outPath, liveStore: dest.store });
      const remapped = result.idMap.get(original.id);

      expect(result.counts.tasks).toEqual({ preserved: 0, bumped: 1 });
      expect(remapped).toBeNumber();
      expect(remapped).not.toBe(original.id);
      expect(dest.store.getTask(remapped as number)?.title).toBe("from backup");
      expect(dest.store.getTask(remapped as number)?.tags).toEqual(["restored"]);
      expect(dest.store.listUpdates(remapped as number).map(u => u.summary)).toEqual(["source update"]);
    } finally {
      source.store.close();
      dest.store.close();
    }
  });

  test("restoreBackup keeps existing lane/tag rows and skips orphaned child rows", async () => {
    const dest = openTmpStore("dest-existing");
    try {
      dest.store.addLane({ name: "later", color: "#111111", sort: 9 });
      dest.store.addTag({ name: "keep", color: "#222222" });
      const backupPath = writeBackupDoc({
        format: "cortex-backup",
        format_version: 1,
        cortex_version: "0.0.0",
        created_at: Date.now(),
        source_host: "old-host",
        source_user: "old-user",
        stats: { lanes: 1, tags: 1, tasks: 0, updates: 1, task_tags: 1, notifications: 0 },
        lanes: [{ name: "later", color: "#ffffff", sort: 1 }],
        tags: [{ name: "keep", color: "#ffffff", created: 1 }],
        tasks: [],
        updates: [{ id: 99, task_id: 12345, author: "ghost", summary: "orphan", severity: "progress", created: 1 }],
        task_tags: [{ task_id: 12345, tag_name: "keep" }],
      });

      const result = await restoreBackup({ backupPath, liveStore: dest.store });

      expect(result.counts.lanes).toEqual({ new: 0, existing: 1 });
      expect(result.counts.tags).toEqual({ new: 0, existing: 1 });
      expect(dest.store.listLanes().find(l => l.name === "later")?.color).toBe("#111111");
      expect(dest.store.listTags().find(t => t.name === "keep")?.color).toBe("#222222");
      expect(result.counts.skipped).toMatchObject({ updates: 1, taskTags: 1 });
    } finally {
      dest.store.close();
    }
  });
});

describe("backwards-compatible data-only restore", () => {
  test("restoreBackup accepts older v1 docs with missing optional tables/columns and ignores unknown columns", async () => {
    const dest = openTmpStore("dest-compat");
    try {
      const backupPath = writeBackupDoc({
        format: "cortex-backup",
        format_version: 1,
        cortex_version: "0.1.0",
        created_at: 1,
        source_host: "old-host",
        source_user: "old-user",
        stats: { lanes: 1, tags: 0, tasks: 1, updates: 0, task_tags: 0 },
        lanes: [{ name: "legacy", color: null, sort: 0, old_lane_column: "ignored" }],
        tags: [],
        tasks: [
          {
            id: 42,
            lane: "legacy",
            title: "legacy task",
            body: null,
            status: "open",
            created: 1,
            updated: 1,
            removed_priority_column_was_missing: true,
          },
        ],
        updates: [],
        task_tags: [],
      });

      const result = await restoreBackup({ backupPath, liveStore: dest.store });

      expect(result.counts.tasks).toEqual({ preserved: 1, bumped: 0 });
      expect(dest.store.getTask(42)?.title).toBe("legacy task");
      expect(dest.store.getTask(42)?.priority).toBeNull();
    } finally {
      dest.store.close();
    }
  });

  test("restoreBackup rejects unsupported future format versions clearly", async () => {
    const dest = openTmpStore("dest-bad-version");
    try {
      const backupPath = writeBackupDoc({
        format: "cortex-backup",
        format_version: 999,
        cortex_version: "future",
        created_at: 1,
        source_host: "future-host",
        source_user: "future-user",
        stats: { lanes: 0, tags: 0, tasks: 0, updates: 0, task_tags: 0 },
        lanes: [],
        tags: [],
        tasks: [],
        updates: [],
        task_tags: [],
      });

      await expect(restoreBackup({ backupPath, liveStore: dest.store })).rejects.toThrow(/format_version/);
    } finally {
      dest.store.close();
    }
  });
});

// ---------- private concurrency metadata vs the v1 data-only format (plan @400 N10) ----------

const V1_KEYS = [
  "cortex_version",
  "created_at",
  "format",
  "format_version",
  "lanes",
  "notifications",
  "source_host",
  "source_user",
  "stats",
  "tables",
  "tags",
  "task_tags",
  "tasks",
  "updates",
];
const TASK_SCOPES: ResourceScope[] = ["body", "entity", "lane", "priority", "status", "title"];

function versionsOf(store: Store, id: number): Versions {
  const state = store.taskState(id);
  if (!state) throw new Error(`task ${id} has no state`);
  return state.versions;
}

function tokenValues(versions: Versions | null): string[] {
  return Object.values(versions ?? {}).filter((value): value is string => typeof value === "string");
}

describe("backup excludes private metadata", () => {
  test("TABLES and the v1 payload are unchanged: no identity, revision or receipt data is exported", async () => {
    const { dbPath, dir, store } = openTmpStore("export-private");
    try {
      const task = store.addTask({ title: "t", tags: ["x"], author: "agent-1" });
      store.editTask(task.id, { body: "b" });
      const post = {
        task_id: task.id,
        author: "agent-1",
        summary: "blocked",
        status: "blocked" as const,
        notify: true,
      };
      store.runIdempotent("m-export-receipt", mutationDigest("update.post", post), () => store.postUpdate(post));

      expect(TABLES.map(t => [t.name, [...t.columns], t.idColumn])).toEqual([
        ["lanes", ["name", "color", "sort"], null],
        ["tags", ["name", "color", "created"], null],
        ["tasks", ["id", "lane", "title", "body", "status", "priority", "created", "updated"], "id"],
        ["updates", ["id", "task_id", "author", "summary", "body", "severity", "created"], "id"],
        ["task_tags", ["task_id", "tag_name"], null],
        ["notifications", ["id", "task_id", "author", "status", "title", "message", "read", "created"], "id"],
      ]);

      const outPath = path.join(dir, "private.zip");
      await createBackup({ liveDbPath: dbPath, outPath });
      for (const doc of [await exportData(dbPath), unzipJson(outPath)]) {
        expect(Object.keys(doc).sort()).toEqual(V1_KEYS);
        expect(Object.keys(doc.tables).sort()).toEqual(TABLES.map(t => t.name).sort());
        const text = JSON.stringify(doc);
        expect(text).not.toContain(store.databaseId());
        for (const value of tokenValues(versionsOf(store, task.id))) expect(text).not.toContain(value);
        expect(text).not.toContain("m-export-receipt");
        expect(text).not.toMatch(/_database_identity|_resource_revisions|_mutation_receipts|database_id|mutation_id/);
      }
    } finally {
      store.close();
    }
  });
});

describe("restore stamps destination revisions", () => {
  test("imported ids and affected catalogs get fresh tokens; identity, receipts and untouched catalogs are kept", async () => {
    const source = openTmpStore("source-stamp");
    const dest = openTmpStore("dest-stamp");
    try {
      source.store.addLane({ name: "later" });
      source.store.addTask({ title: "s1", lane: "later", tags: ["restored"] }); // id 1
      source.store.addTask({ title: "s2" }); // id 2
      source.store.runIdempotent("m-source", "digest-source", () =>
        source.store.addUpdate({ task_id: 1, author: "agent-1", summary: "from the source" }),
      );
      const outPath = path.join(source.dir, "stamp.zip");
      await createBackup({ liveDbPath: source.dbPath, outPath });

      dest.store.addLane({ name: "later" });
      dest.store.addLane({ name: "idle" });
      const doomed = dest.store.addTask({ title: "deleted before the restore" }); // id 1
      const doomedTokens = tokenValues(versionsOf(dest.store, doomed.id));
      dest.store.removeTask(doomed.id);
      const kept = dest.store.runIdempotent("m-dest", "digest-dest", () => dest.store.addTask({ title: "kept" })); // id 2
      const databaseId = dest.store.databaseId();
      const laterBefore = dest.store.versions("lane", "later");
      const idleBefore = dest.store.versions("lane", "idle");

      const dry = await dryRunRestore(outPath, dest.store);
      expect(dry.would.tasks).toEqual({ preserved: 1, bumped: 1 });
      expect(dest.store.versions("lane", "later")).toEqual(laterBefore);

      const result = await restoreBackup({ backupPath: outPath, liveStore: dest.store });
      expect(result.counts.tasks).toEqual({ preserved: 1, bumped: 1 });
      expect(result.idMap.get(1)).toBe(doomed.id); // a destination-deleted id comes back
      const restoredTokens = tokenValues(versionsOf(dest.store, doomed.id));
      expect(restoredTokens.length).toBe(TASK_SCOPES.length);
      for (const value of restoredTokens) expect(doomedTokens).not.toContain(value);
      const bumped = result.idMap.get(2) as number;
      expect(Object.keys(versionsOf(dest.store, bumped)).sort()).toEqual(TASK_SCOPES);

      // Catalogs: "later" gained a member (entity) but kept the destination definition;
      // "restored" is new; "idle" was not involved.
      const laterAfter = dest.store.versions("lane", "later");
      expect(laterAfter?.entity).not.toBe(laterBefore?.entity);
      expect(laterAfter?.definition).toBe(laterBefore?.definition);
      expect(dest.store.versions("lane", "idle")).toEqual(idleBefore);
      expect(dest.store.versions("tag", "restored")).not.toBeNull();

      // Destination identity and receipts survive; source receipts never travel.
      expect(dest.store.databaseId()).toBe(databaseId);
      const refuse = (): Task => {
        throw new Error("a replay must not run the write");
      };
      expect(dest.store.runIdempotent("m-dest", "digest-dest", refuse)).toEqual({ value: kept.value, replayed: true });
      expect(dest.store.runIdempotent("m-source", "digest-source", () => "fresh")).toEqual({
        value: "fresh",
        replayed: false,
      });

      // Sequence high-water: new ids continue above every restored or bumped id.
      const next = dest.store.addTask({ title: "after the restore" });
      expect(next.id).toBeGreaterThan(Math.max(...result.idMap.values()));
    } finally {
      source.store.close();
      dest.store.close();
    }
  });
});

describe("restore and agent memory (plan @414, review @418 F1)", () => {
  test("a reissued id falls back to its archived created time, never a deleted task's body sync", async () => {
    const source = openTmpStore("source-sync");
    const dest = openTmpStore("dest-sync");
    try {
      setSystemTime(new Date(4_000));
      const archived = source.store.addTask({ title: "archived", body: "as archived" }); // id 1, created 4000
      setSystemTime();
      const outPath = path.join(source.dir, "sync.zip");
      await createBackup({ liveDbPath: source.dbPath, outPath });

      setSystemTime(new Date(1_000));
      const doomed = dest.store.addTask({ title: "doomed" }); // id 1
      setSystemTime(new Date(9_000));
      dest.store.editTask(doomed.id, { body: "synced late" });
      // An older cortex binary deletes the task without knowing `_body_edits`.
      dest.store.runInTransaction(raw => raw.run("DELETE FROM tasks WHERE id = ?;", [doomed.id]));
      setSystemTime();

      const result = await restoreBackup({ backupPath: outPath, liveStore: dest.store });
      expect(result.idMap.get(archived.id)).toBe(doomed.id);
      expect(dest.store.memoryStream(doomed.id)?.synced).toBe(4_000);
    } finally {
      setSystemTime();
      source.store.close();
      dest.store.close();
    }
  });
});

// ---------- dry-run projections (plan @400 N6) ----------
//
// A dry-run never writes: it projects the archive onto what the destination
// holds, read through Store.readSnapshot (no migrate, no lease), onto legacy
// schemas as they are, and onto a MISSING destination as the fresh database a
// real restore would create (only the default `now` lane), never creating it.

const sha256 = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("restore projections never write", () => {
  test("a missing destination projects onto a fresh database: exactly what a real restore into one reports", async () => {
    const source = openTmpStore("proj-source");
    const fresh = openTmpStore("proj-fresh");
    try {
      source.store.addLane({ name: "later" });
      source.store.addTask({ title: "a", tags: ["x"] });
      source.store.addTask({ title: "b", lane: "later" });
      const outPath = path.join(source.dir, "backup.zip");
      await createBackup({ liveDbPath: source.dbPath, outPath });

      const dry = await dryRunRestore(outPath, null);
      expect(dry.would.lanes).toEqual({ new: 1, existing: 1 });
      expect(dry.would.tags).toEqual({ new: 1, existing: 0 });
      expect(dry.would.tasks).toEqual({ preserved: 2, bumped: 0 });
      const real = await restoreBackup({ backupPath: outPath, liveStore: fresh.store });
      expect(dry.would).toEqual(real.counts);
    } finally {
      source.store.close();
      fresh.store.close();
    }
  });

  test("inside Store.readSnapshot it projects onto a legacy schema without tag tables; the file stays byte-identical", async () => {
    const source = openTmpStore("proj-legacy-source");
    const dest = openTmpStore("proj-legacy-dest");
    let destOpen = true;
    try {
      source.store.addTask({ title: "a", tags: ["x"] });
      const outPath = path.join(source.dir, "backup.zip");
      await createBackup({ liveDbPath: source.dbPath, outPath });
      dest.store.addTask({ title: "legacy" });
      dest.store.runInTransaction(raw => {
        for (const table of ["task_tags", "tags", "notifications", "_resource_revisions", "_mutation_receipts"]) {
          raw.run(`DROP TABLE ${table};`);
        }
      });
      dest.store.close();
      destOpen = false;
      const before = sha256(dest.dbPath);

      const doc = readBackup(outPath);
      expect(doc.stats.tasks).toBe(1);
      const dry = Store.readSnapshot(dest.dbPath, s => projectRestore(doc, s));
      expect(dry.would.tags).toEqual({ new: 1, existing: 0 });
      expect(dry.would.tasks).toEqual({ preserved: 0, bumped: 1 });
      expect(dry.would.taskTags).toBe(1);
      expect(sha256(dest.dbPath)).toBe(before);
    } finally {
      source.store.close();
      if (destOpen) dest.store.close();
    }
  });

  test("a destination without the core cortex tables is unsupported: the projection errors", async () => {
    const source = openTmpStore("proj-unsupported-source");
    const dest = openTmpStore("proj-unsupported-dest");
    try {
      source.store.addTask({ title: "a" });
      const outPath = path.join(source.dir, "backup.zip");
      await createBackup({ liveDbPath: source.dbPath, outPath });
      dest.store.runInTransaction(raw => {
        for (const table of ["task_tags", "notifications", "updates", "tasks"]) raw.run(`DROP TABLE ${table};`);
      });
      const doc = readBackup(outPath);
      expect(() => projectRestore(doc, dest.store)).toThrow(/missing required cortex tables/);
    } finally {
      source.store.close();
      dest.store.close();
    }
  });
});
