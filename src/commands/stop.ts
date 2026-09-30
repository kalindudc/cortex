import { defineCommand } from "citty";
import { discoverDaemon, stopDaemon } from "../daemon.ts";
import { dbPath } from "../paths.ts";

/**
 * `cortex stop` — stop the daemon serving THIS database (`CORTEX_DB`, else
 * the config dir's cortex.db) and nothing else.
 *
 * The daemon is found through the metadata it published beside the
 * canonical database and verified over its private socket; the shutdown
 * request is bound to that instance (a different instance answers 421 and
 * keeps running), and stop then waits until the daemon has released the
 * database. There is no process-table scan and no signal to any pid:
 * daemons of other databases and
 * unrelated processes whose argv merely contains "cortex serve" all survive.
 */
export default defineCommand({
  meta: {
    name: "stop",
    description: "stop the cortex daemon serving this database (daemons of other databases keep running)",
  },
  async run() {
    try {
      const identity = await discoverDaemon(dbPath());
      if (identity === null) {
        console.log("not running");
        return;
      }
      await stopDaemon(identity);
      console.log(`✓ stopped 1 process (pid: ${identity.pid})`);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
  },
});
