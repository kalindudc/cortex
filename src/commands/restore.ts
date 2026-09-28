import { defineCommand } from "citty";
import {
  type DryRunResult,
  projectRestore,
  readBackup,
  restoreBackup,
  restoreNotificationInput,
  type RestoreCounts,
} from "../backup.ts";
import { claimOrAttach } from "../daemon.ts";
import { canonicalDatabasePath } from "../ownership.ts";
import { dbPath, ensureConfigDir } from "../paths.ts";
import { DatabaseNotFoundError, Store } from "../store.ts";

function skippedLine(counts: RestoreCounts): string | null {
  const skipped = counts.skipped;
  if (skipped.updates === 0 && skipped.taskTags === 0 && skipped.notifications === 0) return null;
  return `  skipped: ${skipped.updates} orphaned updates, ${skipped.taskTags} orphaned task_tags, ${skipped.notifications} orphaned notifications`;
}

function printCounts(counts: RestoreCounts): void {
  console.log(`  lanes: ${counts.lanes.new} new, ${counts.lanes.existing} existing`);
  console.log(`  tags: ${counts.tags.new} new, ${counts.tags.existing} existing`);
  console.log(`  tasks: ${counts.tasks.preserved} with original id, ${counts.tasks.bumped} with new id`);
  console.log(`  updates: ${counts.updates}`);
  console.log(`  task_tags: ${counts.taskTags}`);
  console.log(`  notifications: ${counts.notifications}`);
  const skipped = skippedLine(counts);
  if (skipped) console.log(skipped);
}

/**
 * The dry run (plan @400 N6): project the archive onto a readonly snapshot
 * of the database (no migration, no ownership lease, so it works beside a
 * live daemon and leaves legacy schemas untouched). A database that does not
 * exist yet is projected as the fresh one a real restore would create, and
 * is never created here; corrupt or unsupported databases are errors.
 */
function dryRun(backupPath: string, databasePath: string): DryRunResult {
  const doc = readBackup(backupPath);
  try {
    return Store.readSnapshot(databasePath, store => projectRestore(doc, store));
  } catch (err) {
    if (err instanceof DatabaseNotFoundError) return projectRestore(doc, null);
    throw err;
  }
}

export default defineCommand({
  meta: { name: "restore", description: "merge a cortex data-only backup into the live database" },
  args: {
    file: {
      type: "positional",
      required: true,
      description: "backup .zip file created by `cortex backup`",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "parse and report what would be inserted without writing",
    },
  },
  async run({ args }) {
    const databasePath = dbPath();
    try {
      if (args["dry-run"]) {
        const result = dryRun(args.file, databasePath);
        console.log(`dry run: ${args.file}`);
        console.log(
          `  source: ${result.doc.source_host} · cortex ${result.doc.cortex_version} · format ${result.doc.format_version}`,
        );
        printCounts(result.would);
        return;
      }

      // A real restore is maintenance: it owns the database for the whole
      // merge (lease BEFORE the writable open) and refuses a live daemon.
      ensureConfigDir();
      const claim = await claimOrAttach(canonicalDatabasePath(databasePath));
      if (claim.identity !== undefined) {
        console.error(`error: cortex daemon is running (pid ${claim.identity.pid}); run 'cortex stop' first`);
        process.exit(1);
      }
      const lease = claim.lease;
      let counts: RestoreCounts;
      try {
        const store = Store.open(databasePath, { owner: lease });
        try {
          const result = await restoreBackup({ backupPath: args.file, liveStore: store });
          store.addNotification(restoreNotificationInput({ backupPath: args.file, counts: result.counts }));
          counts = result.counts;
        } finally {
          store.close();
        }
      } finally {
        lease.release();
      }
      console.log(`✓ restored ${args.file}:`);
      printCounts(counts);
      if (counts.tasks.bumped > 0) {
        console.log(`ⓘ ${counts.tasks.bumped} task id(s) were re-allocated due to collision with existing rows.`);
      }
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
  },
});
