import { defineCommand } from "citty";
import fs from "node:fs";
import path from "node:path";
import { defaultBackupPath } from "../backup.ts";
import type { BackupResult } from "../contracts.ts";
import { withClient } from "../daemon.ts";
import { dbPath, ensureBackupsDir } from "../paths.ts";

function parseRotate(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? "0"), 10);
  if (!Number.isInteger(n) || n < 0) {
    console.error("error: --rotate must be an integer >= 0");
    process.exit(1);
  }
  return n;
}

type BackupResponse = Pick<BackupResult, "outPath" | "bytes" | "stats">;

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
    // Refuse a missing source before anything else: offline, withClient would
    // create and migrate an EMPTY database, whose archive --rotate would then
    // keep over the last valid one.
    const source = path.resolve(dbPath());
    if (!fs.existsSync(source)) {
      console.error(`error: no cortex database at ${source}: nothing to back up`);
      process.exit(1);
    }
    // Absolute, because a running daemon writes it from its own working directory.
    const outPath = args.out ? path.resolve(args.out) : defaultBackupPath();
    ensureBackupsDir();
    let result: BackupResponse;
    try {
      // The verified daemon writes the archive (its readonly snapshot beside
      // the database it owns); without one, the same handler runs in-process
      // while this command owns the database.
      result = await withClient(async (client, target) => {
        if (target.daemon !== null) {
          console.error("⚠ cortex daemon is running; backup is consistent (read-only deferred snapshot)");
        }
        return client.backup({ outPath, rotate });
      });
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
    // Echo the path as given (relative stays relative), like before.
    printBackup({ ...result, outPath: args.out || result.outPath });
  },
});
