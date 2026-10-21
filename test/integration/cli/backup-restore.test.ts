import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mkTmpEnv, runCli } from "../helpers.ts";
import { isRunning, leaseIsFree, reap, startForeground } from "../fixtures/daemon.ts";
import { Store, type Task } from "../../../src/store.ts";
import type { Versions } from "../../../src/contracts.ts";

// Plan @400 Task 6: a "live daemon" is a real `cortex serve --foreground`
// for the sandboxed database (the fixture tracks and reaps it), not a
// cortex.pid file: pid files no longer mean anything to this cortex.
afterEach(async () => {
  await reap();
});

async function mustRun(env: Record<string, string>, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const res = await runCli({ args, env });
  expect(res.code, `${args.join(" ")} stderr=${res.stderr}`).toBe(0);
  return { stdout: res.stdout, stderr: res.stderr };
}

function listTasks(stdout: string): Task[] {
  return JSON.parse(stdout) as Task[];
}

function readNotifications(env: Record<string, string>) {
  return withStore(env, store => store.listNotifications());
}

/** Read-only, lease-free snapshot of the sandboxed database (safe beside a live daemon). */
function withStore<T>(env: Record<string, string>, read: (store: Store) => T): T {
  return Store.readSnapshot(env.CORTEX_DB ?? "", read);
}

const sha256 = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function schemaOf(env: Record<string, string>): string[] {
  return withStore(env, s =>
    s.runInTransaction(db =>
      db
        .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master ORDER BY name;")
        .all()
        .map(r => r.sql ?? ""),
    ),
  );
}

function tokenValues(versions: Versions | undefined): string[] {
  return Object.values(versions ?? {}).filter((value): value is string => typeof value === "string");
}

function unzipDoc(zipPath: string): Record<string, unknown> {
  const r = Bun.spawnSync(["unzip", "-p", zipPath, "cortex-backup.json"]);
  expect(r.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(r.stdout)) as Record<string, unknown>;
}

describe("cortex backup CLI", () => {
  test("backup writes a default zip under the hermetic backups dir", async () => {
    const { tmpDir, env, cleanup } = mkTmpEnv("backup-default");
    try {
      await mustRun(env, ["init"]);
      await mustRun(env, ["add", "alpha"]);
      await mustRun(env, ["add", "beta"]);

      const res = await mustRun(env, ["backup"]);

      expect(res.stdout).toContain("backup written to");
      expect(res.stdout).toContain("2 tasks");
      const backupDir = path.join(tmpDir, "cortex", "backups");
      const files = fs.readdirSync(backupDir).filter(n => n.endsWith(".zip"));
      expect(files).toHaveLength(1);
      const listed = Bun.spawnSync(["unzip", "-l", path.join(backupDir, files[0])]);
      expect(listed.exitCode).toBe(0);
      expect(new TextDecoder().decode(listed.stdout)).toContain("cortex-backup.json");
      const [notification] = readNotifications(env);
      expect(notification?.title).toBe("Backup created");
      expect(notification?.task_id).toBeNull();
      expect(notification?.status).toBe("done");
      expect(notification?.message).toContain("2 tasks, 0 updates");
    } finally {
      cleanup();
    }
  });

  test("backup supports --out, --rotate, and a live-daemon warning", async () => {
    const { tmpDir, env, cleanup } = mkTmpEnv("backup-rotate");
    try {
      await mustRun(env, ["init"]);
      await mustRun(env, ["add", "alpha"]);
      const backupDir = path.join(tmpDir, "cortex", "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      for (let i = 0; i < 3; i++) {
        const p = path.join(backupDir, `cortex-old-${i}.zip`);
        fs.writeFileSync(p, "fake");
        fs.utimesSync(p, new Date(1_000 + i), new Date(1_000 + i));
      }
      const daemon = await startForeground(env);
      const outPath = path.join(backupDir, "cortex-custom.zip");

      const res = await runCli({ args: ["backup", "--out", outPath, "--rotate", "2"], env });

      expect(res.code, res.stderr).toBe(0);
      expect(res.stderr).toContain("daemon is running; backup is consistent");
      expect(fs.existsSync(outPath)).toBe(true);
      const remaining = fs.readdirSync(backupDir).filter(n => n.startsWith("cortex-") && n.endsWith(".zip"));
      expect(remaining.sort()).toEqual(["cortex-custom.zip", "cortex-old-2.zip"].sort());
      // The daemon wrote it (and its notification) while it kept the database.
      expect(readNotifications(env)[0]?.title).toBe("Backup created");
      expect(isRunning(daemon)).toBe(true);
      expect(leaseIsFree(env.CORTEX_DB ?? "")).toBe(false);
    } finally {
      await reap();
      cleanup();
    }
  }, 30_000);

  // F16: offline, withClient would create (and migrate) an empty database
  // first, and --rotate would then keep that empty archive over the last
  // valid one. A missing source is refused before anything is created.
  test("backup refuses a missing database: nothing created, no archive, no rotation", async () => {
    const source = mkTmpEnv("backup-valid-source");
    const { tmpDir, env, cleanup } = mkTmpEnv("backup-missing-db");
    try {
      await mustRun(source.env, ["init"]);
      await mustRun(source.env, ["add", "alpha"]);
      const backupDir = path.join(tmpDir, "cortex", "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const valid = path.join(backupDir, "cortex-valid.zip");
      await mustRun(source.env, ["backup", "--out", valid]);
      fs.utimesSync(valid, new Date(1_000), new Date(1_000));
      const before = sha256(valid);
      const db = env.CORTEX_DB ?? "";
      expect(fs.existsSync(db)).toBe(false);

      const res = await runCli({ args: ["backup", "--rotate", "1"], env });

      expect(res.code, res.stderr).toBe(1);
      expect(res.stderr).toContain("error:");
      expect(res.stderr).toContain(db);
      expect(res.stdout).not.toContain("backup written");
      expect(fs.existsSync(db)).toBe(false);
      // No sidecar either (-wal, -shm, .owner.lock, .daemon.json): refused before the lease.
      expect(fs.readdirSync(tmpDir).filter(name => name.startsWith("cortex.db"))).toEqual([]);
      expect(fs.readdirSync(backupDir)).toEqual(["cortex-valid.zip"]);
      expect(sha256(valid)).toBe(before);
      expect(unzipDoc(valid).stats).toMatchObject({ tasks: 1 });
    } finally {
      source.cleanup();
      cleanup();
    }
  }, 30_000);
});

describe("cortex restore CLI", () => {
  test("restore round-trips tasks with original ids and remapped updates", async () => {
    const source = mkTmpEnv("restore-source");
    const dest = mkTmpEnv("restore-dest");
    try {
      await mustRun(source.env, ["init"]);
      await mustRun(source.env, ["add", "alpha"]);
      await mustRun(source.env, ["add", "beta"]);
      await mustRun(source.env, ["update", "1", "--as", "integration", "-m", "source update"]);
      const backupPath = path.join(source.tmpDir, "roundtrip.zip");
      await mustRun(source.env, ["backup", "--out", backupPath]);

      await mustRun(dest.env, ["init"]);
      const restored = await mustRun(dest.env, ["restore", backupPath]);
      const listed = await mustRun(dest.env, ["ls", "--json"]);
      const tasks = listTasks(listed.stdout);
      const shown = await mustRun(dest.env, ["show", "1", "--json"]);
      const payload = JSON.parse(shown.stdout) as { updates: { summary: string }[] };

      expect(restored.stdout).toContain("2 with original id, 0 with new id");
      expect(tasks.map(t => t.id)).toEqual([1, 2]);
      expect(tasks.map(t => t.title)).toEqual(["alpha", "beta"]);
      expect(payload.updates.map(u => u.summary)).toContain("source update");
      const [notification] = readNotifications(dest.env);
      expect(notification?.title).toBe("Restore completed");
      expect(notification?.task_id).toBeNull();
      expect(notification?.status).toBe("done");
      expect(notification?.message).toContain("2 tasks preserved, 0 tasks bumped, 1 updates");
    } finally {
      source.cleanup();
      dest.cleanup();
    }
  });

  test("restore bumps colliding task ids, dry-run is a no-op, and a live daemon refuses writes", async () => {
    const source = mkTmpEnv("restore-collide-source");
    const dest = mkTmpEnv("restore-collide-dest");
    try {
      await mustRun(source.env, ["init"]);
      await mustRun(source.env, ["add", "one"]);
      await mustRun(source.env, ["add", "two"]);
      const backupPath = path.join(source.tmpDir, "collide.zip");
      await mustRun(source.env, ["backup", "--out", backupPath]);

      await mustRun(dest.env, ["init"]);
      await mustRun(dest.env, ["add", "existing one"]);
      await mustRun(dest.env, ["add", "existing two"]);
      // Creating a task persists its bell-drawer `created` notification (the
      // daemon's create handler, now shared by offline commands): count them
      // instead of assuming none.
      const notificationsBefore = readNotifications(dest.env).length;
      const before = listTasks((await mustRun(dest.env, ["ls", "--json"])).stdout).length;
      const dry = await mustRun(dest.env, ["restore", backupPath, "--dry-run"]);
      const afterDry = listTasks((await mustRun(dest.env, ["ls", "--json"])).stdout).length;
      expect(dry.stdout).toContain("dry run");
      expect(afterDry).toBe(before);
      expect(readNotifications(dest.env)).toHaveLength(notificationsBefore);

      const daemon = await startForeground(dest.env);
      const refused = await runCli({ args: ["restore", backupPath], env: dest.env });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("daemon is running");
      expect(refused.stderr).toContain(`pid ${daemon.proc.pid}`);
      expect(readNotifications(dest.env)).toHaveLength(notificationsBefore);
      expect(isRunning(daemon)).toBe(true);
      daemon.proc.kill("SIGTERM");
      await daemon.proc.exited;

      const restored = await mustRun(dest.env, ["restore", backupPath]);
      const tasks = listTasks((await mustRun(dest.env, ["ls", "--json"])).stdout);
      const notifications = readNotifications(dest.env);

      expect(restored.stdout).toMatch(/[1-9]\d* with new id/);
      expect(tasks).toHaveLength(4);
      expect(new Set(tasks.map(t => t.id)).size).toBe(4);
      expect(tasks.map(t => t.title).sort()).toEqual(["existing one", "existing two", "one", "two"].sort());
      expect(notifications[0]?.title).toBe("Restore completed");
      expect(notifications[0]?.message).toContain("0 tasks preserved");
    } finally {
      await reap();
      source.cleanup();
      dest.cleanup();
    }
  }, 30_000);

  test("dry-run beside a live daemon reads a snapshot: data, schema and notifications stay untouched", async () => {
    const source = mkTmpEnv("dry-live-source");
    const dest = mkTmpEnv("dry-live-dest");
    try {
      await mustRun(source.env, ["init"]);
      await mustRun(source.env, ["add", "from the archive", "-t", "archived"]);
      const backupPath = path.join(source.tmpDir, "live.zip");
      await mustRun(source.env, ["backup", "--out", backupPath]);

      await mustRun(dest.env, ["init"]);
      await mustRun(dest.env, ["add", "served"]);
      const daemon = await startForeground(dest.env);
      const schema = schemaOf(dest.env);
      const titles = withStore(dest.env, s => s.listTasks({}).map(t => t.title));
      const notifications = readNotifications(dest.env).length;

      const dry = await runCli({ args: ["restore", backupPath, "--dry-run"], env: dest.env });
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stdout).toContain(`dry run: ${backupPath}`);
      expect(dry.stdout).toContain("tasks: 0 with original id, 1 with new id");
      expect(dry.stdout).toContain("tags: 1 new, 0 existing");

      expect(schemaOf(dest.env)).toEqual(schema);
      expect(withStore(dest.env, s => s.listTasks({}).map(t => t.title))).toEqual(titles);
      expect(readNotifications(dest.env)).toHaveLength(notifications);
      expect(isRunning(daemon)).toBe(true);
      expect(leaseIsFree(dest.env.CORTEX_DB ?? "")).toBe(false);
    } finally {
      await reap();
      source.cleanup();
      dest.cleanup();
    }
  }, 30_000);

  test("dry-run into a missing database projects a fresh one without creating it", async () => {
    const source = mkTmpEnv("dry-absent-source");
    const dest = mkTmpEnv("dry-absent-dest");
    try {
      await mustRun(source.env, ["init"]);
      await mustRun(source.env, ["add", "alpha", "-t", "x"]);
      await mustRun(source.env, ["add", "beta"]);
      const backupPath = path.join(source.tmpDir, "absent.zip");
      await mustRun(source.env, ["backup", "--out", backupPath]);
      const db = dest.env.CORTEX_DB ?? "";

      const dry = await runCli({ args: ["restore", backupPath, "--dry-run"], env: dest.env });
      expect(dry.code, dry.stderr).toBe(0);
      // The default `now` lane is what a fresh database already has.
      expect(dry.stdout).toContain("lanes: 0 new, 1 existing");
      expect(dry.stdout).toContain("tags: 1 new, 0 existing");
      expect(dry.stdout).toContain("tasks: 2 with original id, 0 with new id");
      expect(fs.existsSync(db)).toBe(false);
      expect(fs.existsSync(`${db}.owner.lock`)).toBe(false);

      // A real restore creates it and reports exactly what the projection said.
      const real = await mustRun(dest.env, ["restore", backupPath]);
      for (const line of dry.stdout.split("\n").slice(2).filter(Boolean)) expect(real.stdout).toContain(line);
    } finally {
      source.cleanup();
      dest.cleanup();
    }
  }, 30_000);

  test("dry-run into a legacy-schema database leaves the file byte-identical", async () => {
    const source = mkTmpEnv("dry-legacy-source");
    const dest = mkTmpEnv("dry-legacy-dest");
    try {
      await mustRun(source.env, ["init"]);
      await mustRun(source.env, ["add", "alpha", "-t", "x"]);
      const backupPath = path.join(source.tmpDir, "legacy.zip");
      await mustRun(source.env, ["backup", "--out", backupPath]);
      const db = dest.env.CORTEX_DB ?? "";
      // A pre-tags database: what a cortex that predates tags, notifications
      // and the private metadata tables left on disk.
      fs.mkdirSync(path.dirname(db), { recursive: true });
      const s = Store.open(db, { warnMigrations: false });
      s.addTask({ title: "legacy row" });
      s.runInTransaction(raw => {
        for (const table of [
          "task_tags",
          "tags",
          "notifications",
          "_resource_revisions",
          "_mutation_receipts",
          "_database_identity",
        ]) {
          raw.run(`DROP TABLE ${table};`);
        }
      });
      s.close();
      // The database file and its WAL (which holds whatever was not yet
      // checkpointed), byte for byte: a readonly snapshot writes neither.
      // Reading a WAL database may create an empty WAL (Linux SQLite does);
      // it holds nothing, so it counts the same as no WAL.
      const fingerprint = (): string[] =>
        [db, `${db}-wal`].map(f => (fs.existsSync(f) && fs.statSync(f).size > 0 ? sha256(f) : "no data"));
      const before = fingerprint();

      const dry = await runCli({ args: ["restore", backupPath, "--dry-run"], env: dest.env });
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stdout).toContain("tags: 1 new, 0 existing");
      expect(dry.stdout).toContain("tasks: 0 with original id, 1 with new id");
      expect(fingerprint()).toEqual(before);
      // Still the legacy schema: the dry run migrated nothing.
      expect(schemaOf(dest.env).some(sql => sql.includes("CREATE TABLE tags"))).toBe(false);
    } finally {
      source.cleanup();
      dest.cleanup();
    }
  }, 30_000);
});

describe("backup/restore and private concurrency metadata (plan @400 N10)", () => {
  test("archives stay v1 data-only; restore keeps destination identity and stamps fresh revisions", async () => {
    const source = mkTmpEnv("meta-source");
    const dest = mkTmpEnv("meta-dest");
    try {
      await mustRun(source.env, ["init"]);
      await mustRun(source.env, ["add", "alpha", "-t", "restored", "--as", "agent-1"]);
      await mustRun(source.env, ["update", "1", "--as", "agent-1", "-m", "blocked on review", "-s", "blocked"]);
      const backupPath = path.join(source.tmpDir, "meta.zip");
      await mustRun(source.env, ["backup", "--out", backupPath]);

      const doc = unzipDoc(backupPath);
      expect(Object.keys(doc).sort()).toEqual([
        "cortex_version",
        "created_at",
        "format",
        "format_version",
        "lanes",
        "memory_exclusions",
        "notifications",
        "source_host",
        "source_user",
        "stats",
        "tables",
        "tags",
        "task_tags",
        "tasks",
        "updates",
      ]);
      expect(Object.keys(doc.tables as Record<string, unknown>).sort()).toEqual(
        ["lanes", "memory_exclusions", "notifications", "tags", "task_tags", "tasks", "updates"].sort(),
      );
      const sourceMeta = withStore(source.env, s => ({ id: s.databaseId(), versions: s.taskState(1)?.versions }));
      const text = JSON.stringify(doc);
      expect(text).not.toContain(sourceMeta.id);
      for (const value of tokenValues(sourceMeta.versions)) expect(text).not.toContain(value);
      expect(text).not.toMatch(/_database_identity|_resource_revisions|_mutation_receipts/);

      await mustRun(dest.env, ["init"]);
      await mustRun(dest.env, ["add", "doomed"]);
      const doomed = withStore(dest.env, s => tokenValues(s.taskState(1)?.versions));
      expect(doomed.length).toBe(6);
      await mustRun(dest.env, ["rm", "1", "--force"]);
      const destId = withStore(dest.env, s => s.databaseId());

      const restored = await mustRun(dest.env, ["restore", backupPath]);
      expect(restored.stdout).toContain("1 with original id, 0 with new id");
      const after = withStore(dest.env, s => ({
        id: s.databaseId(),
        task: s.getTask(1),
        versions: s.taskState(1)?.versions,
      }));
      expect(after.id).toBe(destId);
      expect(after.task).toMatchObject({ title: "alpha", status: "blocked", tags: ["restored"] });
      const fresh = tokenValues(after.versions);
      expect(fresh.length).toBe(6);
      for (const value of fresh) {
        expect(doomed).not.toContain(value);
        expect(tokenValues(sourceMeta.versions)).not.toContain(value);
      }
    } finally {
      source.cleanup();
      dest.cleanup();
    }
  });
});
