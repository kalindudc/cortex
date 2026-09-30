import { defineCommand } from "citty";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { DaemonIdentity } from "../contracts.ts";
import {
  claimOrAttach,
  DAEMON_CAPABILITIES,
  DAEMON_PROTOCOL,
  DaemonError,
  ensureDaemon,
  publishDaemonMetadata,
  removeDaemonMetadata,
} from "../daemon.ts";
import { createEventPublisher } from "../events.ts";
import { canonicalDatabasePath } from "../ownership.ts";
import { daemonSocketPath, dbPath, ensureConfigDir, ensureRuntimeDir } from "../paths.ts";
import { buildApp, createRuntime, type DaemonControl } from "../server.ts";
import { Store } from "../store.ts";

type Server = ReturnType<typeof Bun.serve>;

/**
 * The daemon itself (`serve --foreground`). Owns the database for its whole
 * lifetime: claim the lease (retrying a transient owner, recovering stale
 * metadata/socket, refusing an already-published one), open the Store with it, bind the private Unix socket, and only
 * then publish its metadata and print the success line. Shutdown
 * (SIGTERM/SIGINT or the IPC shutdown route) closes the listener, removes
 * its own metadata and socket, closes the Store and releases the lease last.
 */
async function hostDaemon(): Promise<void> {
  ensureConfigDir();
  const databasePath = dbPath();
  const canonical = canonicalDatabasePath(databasePath);
  const claim = await claimOrAttach(canonical);
  if (claim.identity !== undefined) {
    throw new DaemonError(
      "already-running",
      `cortex is already serving ${canonical} (pid ${claim.identity.pid}); run \`cortex stop\` first`,
    );
  }
  const lease = claim.lease;
  ensureRuntimeDir();
  const socketPath = daemonSocketPath(canonical);

  let store: Store | null = null;
  let ipc: Server | null = null;
  let identity: DaemonIdentity | null = null;
  let stopping = false;

  const closeListener = async (): Promise<void> => {
    await Promise.allSettled([ipc?.stop(true)]);
  };
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await closeListener();
    try {
      if (identity !== null) removeDaemonMetadata(identity);
      // Bun 1.4.2 already removed the socket file on stop; ENOENT is success.
      if (fs.lstatSync(socketPath, { throwIfNoEntry: false })?.isSocket()) fs.rmSync(socketPath, { force: true });
    } finally {
      store?.close();
      lease.release(); // last: nothing touches the database or its sidecars after this
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  try {
    store = Store.open(databasePath, { owner: lease });
    const self: DaemonIdentity = {
      protocol: DAEMON_PROTOCOL,
      instanceId: randomUUID(),
      databaseId: store.databaseId(),
      databasePath: canonical,
      endpoint: { kind: "unix", socketPath },
      pid: process.pid,
      capabilities: [...DAEMON_CAPABILITIES],
    };
    identity = self;
    const control: DaemonControl = { shutdown: () => void shutdown() };
    const runtime = createRuntime({ identity: self, events: createEventPublisher(), control });
    ipc = Bun.serve({ unix: socketPath, fetch: buildApp(store, runtime).fetch });
    fs.chmodSync(socketPath, 0o600);
    publishDaemonMetadata(self);
  } catch (err) {
    // Nothing was published: undo what was opened, then give the database back.
    await closeListener();
    store?.close();
    lease.release();
    throw err;
  }

  console.log(`cortex listening on ${socketPath}`);
}

export default defineCommand({
  meta: {
    name: "serve",
    description: "run this database's cortex daemon on its private socket (the TUI starts one when needed)",
  },
  args: {
    foreground: {
      type: "boolean",
      default: false,
      description: "run in the current shell instead of detaching as a daemon",
    },
  },
  async run({ args }) {
    try {
      if (args.foreground) {
        await hostDaemon();
        return;
      }
      // Printed only once the daemon has published: it is ready, not merely spawned.
      const identity = await ensureDaemon({ databasePath: dbPath() });
      console.log(`✓ cortex serving at ${describeEndpoint(identity)} (pid ${identity.pid})`);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

function describeEndpoint(identity: DaemonIdentity): string {
  return identity.endpoint.socketPath;
}
