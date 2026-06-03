import { defineCommand } from "citty";
import fs from "node:fs";
import { backupNotificationInput, createBackup, defaultBackupPath } from "../backup.ts";
import { Client, daemonUrl } from "../client.ts";
import { dbPath, ensureBackupsDir, isAlive, readPid } from "../paths.ts";
import { Store } from "../store.ts";

function parseRotate(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? "0"), 10);
  if (!Number.isInteger(n) || n < 0) {
    console.error("error: --rotate must be an integer >= 0");
    process.exit(1);
  }
  return n;
}

type BackupResponse = { outPath: string; bytes: number; stats: { tasks: number; updates: number } };

function printBackup(result: BackupResponse): void {
  console.log(
    `✓ backup written to ${result.outPath} (${result.bytes} bytes; ${result.stats.tasks} tasks, ${result.stats.updates} updates)`,
  );
}

export default defineCommand({
  meta: { name: "backup", description: "write a data-only cortex backup zip" },
  args: {
    out: {
      type: "string",
      alias: "o",
      valueHint: "path",
      description: "backup .zip path (default: ~/.config/cortex/backups/cortex-<host>-<ISO>.zip)",
    },
    rotate: {
      type: "string",
      default: "0",
      valueHint: "N",
      description: "keep only the newest N cortex-*.zip files in the output directory (0 disables)",
    },
  },
  async run({ args }) {
    const rotate = parseRotate(args.rotate);
    const outPath = args.out || defaultBackupPath();
    ensureBackupsDir();
    const pid = readPid();
    if (pid !== null && isAlive(pid)) {
      console.error("⚠ cortex daemon is running; backup is consistent (read-only deferred snapshot)");
    }
    try {
      const url = daemonUrl();
      if (url) {
        const result = (await Client.backup(url, { outPath, rotate })) as BackupResponse;
        printBackup(result);
        return;
      }

      const { doc } = await createBackup({ liveDbPath: dbPath(), outPath, rotate });
      const bytes = fs.statSync(outPath).size;
      const store = Store.open();
      try {
        store.addNotification(backupNotificationInput({ outPath, bytes, stats: doc.stats }));
      } finally {
        store.close();
      }
      printBackup({ outPath, bytes, stats: doc.stats });
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
  },
});
