import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/store.ts";
import { createBackup, dryRunRestore, exportData, restoreBackup, TABLES, type BackupDoc } from "../../src/backup.ts";

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
