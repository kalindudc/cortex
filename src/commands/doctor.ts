import { defineCommand } from "citty";
import pkg from "../../package.json" with { type: "json" };
import { Store } from "../store.ts";
import { dbPath } from "../paths.ts";
import { daemonUrl } from "../client.ts";
import { printJson } from "../output.ts";

/**
 * `cortex doctor` — one-call orientation for an agent (or human) landing in a
 * fresh shell. Reports the binary version, database path, whether a daemon is
 * running, any pending migrations, and coarse row counts. Works WITH or
 * WITHOUT a running daemon: it opens the SQLite file read-only (WAL allows
 * concurrent readers) rather than requiring the HTTP surface, so it never
 * crashes just because the daemon is down.
 */
export default defineCommand({
  meta: {
    name: "doctor",
    description: "report cortex health/orientation (version, db, daemon, migrations, counts)",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "emit the report as JSON instead of the human summary",
    },
  },
  run({ args }) {
    const url = daemonUrl();
    const store = Store.open(dbPath(), { warnMigrations: false });
    let report: {
      version: string;
      dbPath: string;
      daemon: { running: boolean; url: string | null };
      pendingMigrations: string[];
      counts: { tasks: number; lanes: number; tags: number };
    };
    try {
      report = {
        version: pkg.version,
        dbPath: store.databasePath(),
        daemon: { running: url !== null, url },
        pendingMigrations: store.pendingMigrations(),
        counts: {
          tasks: store.listTasks({}).length,
          lanes: store.listLanes().length,
          tags: store.listTags().length,
        },
      };
    } finally {
      store.close();
    }
    if (args.json) {
      printJson(report);
      return;
    }
    console.log(`cortex ${report.version}`);
    console.log(`  db:         ${report.dbPath}`);
    console.log(`  daemon:     ${report.daemon.running ? `running (${report.daemon.url})` : "not running"}`);
    console.log(
      `  migrations: ${
        report.pendingMigrations.length === 0 ? "up to date" : `pending: ${report.pendingMigrations.join(", ")}`
      }`,
    );
    console.log(`  tasks:      ${report.counts.tasks}`);
    console.log(`  lanes:      ${report.counts.lanes}`);
    console.log(`  tags:       ${report.counts.tags}`);
  },
});
