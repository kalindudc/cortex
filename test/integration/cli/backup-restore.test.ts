import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { mkTmpEnv, runCli } from "../helpers.ts";
import { Store, type Task } from "../../../src/store.ts";

async function mustRun(env: Record<string, string>, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const res = await runCli({ args, env });
  expect(res.code, `${args.join(" ")} stderr=${res.stderr}`).toBe(0);
  return { stdout: res.stdout, stderr: res.stderr };
}

function listTasks(stdout: string): Task[] {
  return JSON.parse(stdout) as Task[];
}

function readNotifications(env: Record<string, string>) {
  const store = Store.open(env.CORTEX_DB, { warnMigrations: false });
  try {
    return store.listNotifications();
  } finally {
    store.close();
  }
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
      fs.writeFileSync(path.join(tmpDir, "cortex", "cortex.pid"), String(process.pid));
      const outPath = path.join(backupDir, "cortex-custom.zip");

      const res = await runCli({ args: ["backup", "--out", outPath, "--rotate", "2"], env });

      expect(res.code).toBe(0);
      expect(res.stderr).toContain("daemon is running; backup is consistent");
      expect(fs.existsSync(outPath)).toBe(true);
      const remaining = fs.readdirSync(backupDir).filter(n => n.startsWith("cortex-") && n.endsWith(".zip"));
      expect(remaining.sort()).toEqual(["cortex-custom.zip", "cortex-old-2.zip"].sort());
    } finally {
      cleanup();
    }
  });
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

  test("restore bumps colliding task ids, dry-run is a no-op, and daemon pid refuses writes", async () => {
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
      const before = listTasks((await mustRun(dest.env, ["ls", "--json"])).stdout).length;
      const dry = await mustRun(dest.env, ["restore", backupPath, "--dry-run"]);
      const afterDry = listTasks((await mustRun(dest.env, ["ls", "--json"])).stdout).length;
      expect(dry.stdout).toContain("dry run");
      expect(afterDry).toBe(before);
      expect(readNotifications(dest.env)).toHaveLength(0);

      fs.writeFileSync(path.join(dest.tmpDir, "cortex", "cortex.pid"), String(process.pid));
      const refused = await runCli({ args: ["restore", backupPath], env: dest.env });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("daemon is running");
      expect(readNotifications(dest.env)).toHaveLength(0);
      fs.rmSync(path.join(dest.tmpDir, "cortex", "cortex.pid"), { force: true });

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
      source.cleanup();
      dest.cleanup();
    }
  });
});
