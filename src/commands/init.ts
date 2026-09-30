import { defineCommand } from "citty";
import { createClient } from "../client.ts";
import { claimOrAttach } from "../daemon.ts";
import { canonicalDatabasePath } from "../ownership.ts";
import { Store } from "../store.ts";
import { dbPath, ensureConfigDir } from "../paths.ts";

/**
 * Create (or migrate) the database as its owner: acquire the ownership
 * lease before the writable open, apply pending migrations, and release it.
 * When a verified daemon already serves the database it is already created
 * and additively migrated; pending table rebuilds need the database to
 * themselves, so they refuse until the daemon is stopped.
 * Returns the migrations applied.
 */
async function initDatabase(databasePath: string): Promise<string[]> {
  const claim = await claimOrAttach(canonicalDatabasePath(databasePath));
  if (claim.identity !== undefined) {
    const daemon = claim.identity;
    const { pending } = await createClient(daemon.endpoint, { instanceId: daemon.instanceId }).migrations();
    if (pending.length > 0) {
      throw new Error(
        `migrations pending (${pending.join(", ")}) while the cortex daemon (pid ${daemon.pid}) serves ` +
          `${daemon.databasePath}; run \`cortex stop\`, then \`cortex init\``,
      );
    }
    return [];
  }
  const lease = claim.lease;
  try {
    const store = Store.open(databasePath, { owner: lease, warnMigrations: false });
    try {
      return store.applyMigrations();
    } finally {
      store.close();
    }
  } finally {
    lease.release();
  }
}

export default defineCommand({
  meta: { name: "init", description: "initialize the cortex database" },
  async run() {
    ensureConfigDir();
    let applied: string[];
    try {
      applied = await initDatabase(dbPath());
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
    for (const name of applied) {
      console.log(`✓ migration applied: ${name}`);
    }
    console.log(`✓ initialized ${dbPath()}`);
    console.log("→ agent skills and the pi extension: run `cortex agents install`");
  },
});
