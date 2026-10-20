import { defineCommand } from "citty";
import pkg from "../../package.json" with { type: "json" };
import { DatabaseNotFoundError, Store } from "../store.ts";
import { dbPath } from "../paths.ts";
import { discoverDaemon } from "../daemon.ts";
import { resolveAuthor } from "../lib/userAuthor.ts";
import { printJson } from "../output.ts";

/** What doctor knows about the daemon for this database, from discovery alone. */
type DaemonReport = {
  /** A verified daemon serves this database. */
  running: boolean;
  pid?: number;
  /** Its private socket. */
  socket?: string;
  /** Discovery failed: the metadata names another database or protocol. */
  error?: string;
};

async function daemonReport(databasePath: string): Promise<DaemonReport> {
  try {
    const identity = await discoverDaemon(databasePath);
    if (identity !== null) {
      return { running: true, pid: identity.pid, socket: identity.endpoint.socketPath };
    }
    return { running: false };
  } catch (err) {
    return { running: false, error: (err as Error).message };
  }
}

function describeDaemon(daemon: DaemonReport): string {
  if (daemon.error !== undefined) return `unknown (${daemon.error})`;
  if (!daemon.running) return "not running";
  return `running (pid ${daemon.pid}, ${daemon.socket ?? "private socket"})`;
}

/**
 * `cortex doctor` — one-call orientation for an agent (or human) landing in a
 * fresh shell. Reports the binary version, database path, whether a daemon
 * serves it, any pending migrations, coarse row counts, and the user's author
 * name (what the desktop app and `cortex update --as-me` credit).
 *
 * Strictly read-only: the daemon state comes from discovery (the published
 * metadata, verified over its socket), and the database is read through
 * `Store.readSnapshot`, a readonly connection with no migration and no
 * ownership lease, so doctor works the same with or without a running
 * daemon, never starts one, never creates or migrates the database, and
 * never waits for another command's lease.
 */
export default defineCommand({
  meta: {
    name: "doctor",
    description: "report cortex health/orientation (version, db, daemon, migrations, counts); read-only",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "emit the report as JSON instead of the human summary",
    },
  },
  async run({ args }) {
    const databasePath = dbPath();
    const daemon = await daemonReport(databasePath);
    let initialized = true;
    let snapshot: { pending: string[]; counts: { tasks: number; lanes: number; tags: number } };
    try {
      snapshot = Store.readSnapshot(databasePath, s => ({ pending: s.pendingMigrations(), counts: s.counts() }));
    } catch (err) {
      if (!(err instanceof DatabaseNotFoundError)) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
      initialized = false;
      snapshot = { pending: [], counts: { tasks: 0, lanes: 0, tags: 0 } };
    }
    const report = {
      version: pkg.version,
      dbPath: databasePath,
      initialized,
      daemon,
      pendingMigrations: snapshot.pending,
      counts: snapshot.counts,
      author: resolveAuthor(),
    };
    if (args.json) {
      printJson(report);
      return;
    }
    console.log(`cortex ${report.version}`);
    console.log(`  db:         ${report.dbPath}${initialized ? "" : " (not initialized; run `cortex init`)"}`);
    console.log(`  daemon:     ${describeDaemon(daemon)}`);
    console.log(
      `  migrations: ${
        report.pendingMigrations.length === 0 ? "up to date" : `pending: ${report.pendingMigrations.join(", ")}`
      }`,
    );
    console.log(`  tasks:      ${report.counts.tasks}`);
    console.log(`  lanes:      ${report.counts.lanes}`);
    console.log(`  tags:       ${report.counts.tags}`);
    console.log(`  author:     ${report.author} (your changes in the desktop app and with --as-me)`);
  },
});
