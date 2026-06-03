import { defineCommand } from "citty";
import { dryRunRestore, restoreBackup, restoreNotificationInput, type RestoreCounts } from "../backup.ts";
import { isAlive, readPid } from "../paths.ts";
import { Store } from "../store.ts";

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
    const store = Store.open();
    try {
      if (args["dry-run"]) {
        const result = await dryRunRestore(args.file, store);
        console.log(`dry run: ${args.file}`);
        console.log(
          `  source: ${result.doc.source_host} · cortex ${result.doc.cortex_version} · format ${result.doc.format_version}`,
        );
        printCounts(result.would);
        return;
      }

      const pid = readPid();
      if (pid !== null && isAlive(pid)) {
        console.error(`error: cortex daemon is running (pid ${pid}); run 'cortex stop' first`);
        process.exit(1);
      }

      const result = await restoreBackup({ backupPath: args.file, liveStore: store });
      store.addNotification(restoreNotificationInput({ backupPath: args.file, counts: result.counts }));
      console.log(`✓ restored ${args.file}:`);
      printCounts(result.counts);
      if (result.counts.tasks.bumped > 0) {
        console.log(
          `ⓘ ${result.counts.tasks.bumped} task id(s) were re-allocated due to collision with existing rows.`,
        );
      }
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      store.close();
    }
  },
});
