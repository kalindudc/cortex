import { defineCommand } from "citty";
import readline from "node:readline";
import fs from "node:fs";
import type { DaemonIdentity } from "../contracts.ts";
import { assertNoLegacyDaemon, claimOrAttach, DaemonError, discoverDaemon, stopDaemon } from "../daemon.ts";
import { canonicalDatabasePath } from "../ownership.ts";
import { Store } from "../store.ts";
import { dbPath, ensureConfigDir, ownerLockPath } from "../paths.ts";
import { writeAllSkills, skillDir, skillsRoot, listSkills } from "../skills.ts";
import { writeAllExtensions, extensionDir, extensionsRoot, listExtensions } from "../extensions.ts";

const CONFIRM = "RESET";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

function fail(err: unknown): never {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}

/**
 * `cortex reset` — wipe THIS database and re-initialize it (plan @400 N5/N6).
 *
 * Nothing is held while the user types the confirmation. Afterwards the
 * verified daemon serving this database (found again, instance-bound) is
 * asked to shut down and awaited; then reset takes the ownership lease and
 * holds it through the wipe AND the re-initialization, so no other cortex
 * process can open the database half-way. It deletes the SQLite files (the
 * canonical database and its WAL sidecars), never the persistent owner lock
 * file (a new inode would admit a second owner); stale daemon metadata and
 * sockets are recovered only by the lease holder. Daemons of other
 * databases, and a daemon of an older cortex (which cannot be verified, so
 * it is refused rather than signalled), are never touched.
 */
export default defineCommand({
  meta: {
    name: "reset",
    description: "wipe the cortex database and re-initialize (requires typing RESET to confirm)",
  },
  async run() {
    ensureConfigDir();
    const db = dbPath();
    let canonical: string;
    let daemon: DaemonIdentity | null;
    try {
      canonical = canonicalDatabasePath(db);
      daemon = await discoverDaemon(db);
      await assertNoLegacyDaemon();
    } catch (err) {
      fail(err);
    }

    console.log(`This will:`);
    if (daemon !== null) {
      console.log(`  • stop the cortex daemon serving this database (pid ${daemon.pid})`);
    }
    console.log(`  • delete ${db}`);
    console.log(`  • delete ${db}-wal, ${db}-shm (SQLite WAL sidecars, if present)`);
    console.log(
      `  • remove stale daemon metadata/socket for this database, if present (keeping ${ownerLockPath(canonical)})`,
    );
    console.log(`  • wipe and regenerate ${listSkills().length} skill dir(s) under ${skillsRoot()}`);
    console.log(`  • wipe and regenerate ${listExtensions().length} pi extension(s) under ${extensionsRoot()}`);
    console.log(`  • re-initialize an empty database with the default 'now' lane`);
    const answer = await prompt(`Type ${CONFIRM} to confirm: `);
    if (answer.trim() !== CONFIRM) {
      console.log("aborted (input did not match RESET)");
      process.exit(1);
    }

    try {
      // 1. Stop this database's daemon, found again after the prompt: exactly
      // that instance, over its socket, then wait for it to release the lease.
      const live = await discoverDaemon(db);
      if (live !== null) {
        await stopDaemon(live);
        console.log("✓ stopped daemon");
      }

      // 2. Own the database from the wipe through the re-initialization
      // (claimOrAttach also recovers the stopped daemon's leftovers, if any).
      const claim = await claimOrAttach(canonical);
      if (claim.identity !== undefined) {
        throw new DaemonError(
          "already-running",
          `a cortex daemon (pid ${claim.identity.pid}) started serving ${canonical} during the reset; ` +
            "run `cortex stop`, then retry",
        );
      }
      const lease = claim.lease;
      try {
        for (const p of [canonical, `${canonical}-wal`, `${canonical}-shm`]) {
          fs.rmSync(p, { force: true });
        }
        console.log("✓ wiped database files");

        // 3. Re-init: a fresh database (new identity, no receipts), migrated, 'now' seeded.
        Store.open(canonical, { owner: lease }).close();
        console.log(`✓ re-initialized ${db}`);
      } finally {
        lease.release();
      }
    } catch (err) {
      fail(err);
    }

    // 4. Wipe + regenerate every skill dir. We rmSync first (rather than
    // just overwriting via writeAllSkills) so files removed in a binary
    // upgrade are dropped, not stranded. Hand-edits are LOST — documented
    // in cli/reset.md.
    for (const name of listSkills()) {
      fs.rmSync(skillDir(name), { recursive: true, force: true });
    }
    await writeAllSkills();
    console.log(`✓ regenerated ${listSkills().length} skill(s)`);

    for (const name of listExtensions()) {
      fs.rmSync(extensionDir(name), { recursive: true, force: true });
    }
    await writeAllExtensions();
    console.log(`✓ regenerated ${listExtensions().length} extension(s)`);

    console.log("✓ reset complete");
  },
});
