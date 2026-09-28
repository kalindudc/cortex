import { defineCommand } from "citty";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { DaemonIdentity, EnableWebRequest } from "../contracts.ts";
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
import { createPreviewStore } from "../preview.ts";
import { openInBrowser } from "../open-browser.ts";
import { canonicalDatabasePath } from "../ownership.ts";
import { daemonSocketPath, dbPath, ensureConfigDir, ensureRuntimeDir } from "../paths.ts";
import { buildApp, createRuntime, type DaemonControl, type DaemonRuntime, isValidHostname } from "../server.ts";
import { Store } from "../store.ts";

/** The documented dashboard port (also enable-web's first choice when no port is given). */
const DEFAULT_WEB_PORT = 7777;
const DEFAULT_HOST = "cortex.localhost";

/**
 * Validate a user-supplied hostname for the printed/opened dashboard URL
 * (RFC 1123 label-or-FQDN, see isValidHostname). Casing is preserved: DNS is
 * case-insensitive, but the printed URL should reflect the user's intent.
 * On rejection, prints a single-line error to stderr and exits 1, like --port.
 */
function validateHost(raw: unknown): string {
  if (!isValidHostname(raw)) {
    console.error("error: --host must be a valid hostname (RFC 1123 form, no port, no scheme)");
    process.exit(1);
  }
  return raw;
}

function parsePort(raw: unknown): number {
  const port = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    console.error("error: --port must be a number 0-65535");
    process.exit(1);
  }
  return port;
}

type Server = ReturnType<typeof Bun.serve>;

/**
 * Bind the loopback dashboard listener: exactly `request.port`, or 7777 and
 * then a free port when no port was asked for (enable-web from `cortex open`).
 */
function listenLoopback(runtime: DaemonRuntime, store: Store, request: EnableWebRequest): Server {
  const app = buildApp(store, runtime);
  const ports = request.port !== undefined ? [request.port] : [DEFAULT_WEB_PORT, 0];
  for (const [i, port] of ports.entries()) {
    try {
      return Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
    } catch (err) {
      const inUse = (err as { code?: string }).code === "EADDRINUSE";
      if (inUse && i < ports.length - 1) continue;
      throw new Error(
        inUse
          ? `cannot serve the dashboard: 127.0.0.1:${port} is in use (pick another with --port, or 0 for any)`
          : `cannot serve the dashboard on 127.0.0.1:${port}: ${(err as Error).message}`,
      );
    }
  }
  throw new Error("unreachable: no dashboard port to try");
}

/**
 * The daemon itself (`serve --foreground`). Owns the database for its whole
 * lifetime: claim the lease (retrying a transient owner, recovering stale
 * metadata/socket, refusing next to a legacy daemon or an already-published
 * one), open the Store with it, bind the private Unix socket (and the
 * loopback dashboard when `web`), and only then publish its metadata and
 * print the success line. Shutdown (SIGTERM/SIGINT or the IPC shutdown
 * route) closes the listeners, removes its own metadata and socket, closes
 * the Store and releases the lease last.
 */
async function hostDaemon(options: { web: EnableWebRequest | null; open: boolean }): Promise<void> {
  ensureConfigDir();
  const databasePath = dbPath();
  const canonical = canonicalDatabasePath(databasePath);
  const claim = await claimOrAttach(canonical);
  if (claim.identity !== undefined) {
    const where = claim.identity.webUrl ? `, ${claim.identity.webUrl}` : "";
    throw new DaemonError(
      "already-running",
      `cortex is already serving ${canonical} (pid ${claim.identity.pid}${where}); run \`cortex stop\` first`,
    );
  }
  const lease = claim.lease;
  ensureRuntimeDir();
  const socketPath = daemonSocketPath(canonical);

  let store: Store | null = null;
  let ipc: Server | null = null;
  let loopback: Server | null = null;
  let identity: DaemonIdentity | null = null;
  let published = false;
  let stopping = false;

  const closeListeners = async (): Promise<void> => {
    await Promise.allSettled([ipc?.stop(true), loopback?.stop(true)]);
  };
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await closeListeners();
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
    const openStore = store;
    // ONE event publisher, ONE preview store (created over IPC, read on
    // loopback) and ONE identity object shared by both listeners' apps.
    const events = createEventPublisher();
    const previews = createPreviewStore();
    const webRuntime = createRuntime({ identity: self, events, previews, listener: "loopback" });
    const enableWeb = async (request: EnableWebRequest): Promise<DaemonIdentity> => {
      if (loopback === null) {
        loopback = listenLoopback(webRuntime, openStore, request);
        self.webUrl = `http://${request.host ?? DEFAULT_HOST}:${loopback.port}`;
        if (published) publishDaemonMetadata(self);
      }
      return self;
    };
    const control: DaemonControl = { shutdown: () => void shutdown(), enableWeb };
    const ipcRuntime = createRuntime({ identity: self, events, previews, listener: "ipc", control });
    ipc = Bun.serve({ unix: socketPath, fetch: buildApp(store, ipcRuntime).fetch });
    fs.chmodSync(socketPath, 0o600);
    if (options.web !== null) await enableWeb(options.web);
    publishDaemonMetadata(self);
    published = true;
  } catch (err) {
    // Nothing was published: undo what was opened, then give the database back.
    await closeListeners();
    store?.close();
    lease.release();
    throw err;
  }

  console.log(`cortex listening on ${identity.webUrl ?? socketPath}`);
  if (options.open) {
    if (identity.webUrl !== undefined) openInBrowser(identity.webUrl);
    else console.error("warn: --open needs the dashboard; --no-web serves the private socket only");
  }
}

export default defineCommand({
  meta: {
    name: "serve",
    description:
      "run the cortex daemon for this database: a private socket for the CLI plus the dashboard on 127.0.0.1 (headless unless --open)",
  },
  args: {
    port: {
      type: "string",
      alias: "p",
      default: String(DEFAULT_WEB_PORT),
      valueHint: "port",
      description: "dashboard TCP port on 127.0.0.1 (0 = pick a free port)",
    },
    foreground: {
      type: "boolean",
      default: false,
      description: "run in the current shell instead of detaching as a daemon",
    },
    open: {
      type: "boolean",
      default: false,
      description: "open the dashboard in a browser once it is serving (default: headless)",
    },
    "no-open": {
      type: "boolean",
      default: false,
      description: "stay headless (the default; kept for compatibility)",
    },
    web: {
      type: "boolean",
      default: true,
      description: "serve only the private socket, without the dashboard (`cortex open` can enable it later)",
    },
    host: {
      type: "string",
      default: DEFAULT_HOST,
      valueHint: "name",
      description: "user-facing hostname for the printed URL (server still binds 127.0.0.1)",
    },
  },
  async run({ args }) {
    const port = parsePort(args.port);
    const host = validateHost(args.host);
    // citty/mri parse `--no-open` as `open: false`; the explicit flag is honoured too.
    const open = args.open === true && args["no-open"] !== true;
    const web: EnableWebRequest | null = args.web === false ? null : { port, host };
    try {
      if (args.foreground) {
        await hostDaemon({ web, open });
        return;
      }
      // Printed only once the daemon has published: it is ready, not merely spawned.
      const identity = await ensureDaemon({ databasePath: dbPath(), web: web !== null, port, host });
      console.log(`✓ cortex serving at ${identity.webUrl ?? describeEndpoint(identity)} (pid ${identity.pid})`);
      if (open) {
        if (identity.webUrl !== undefined) openInBrowser(identity.webUrl);
        else console.error("warn: --open needs the dashboard; --no-web serves the private socket only");
      }
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

function describeEndpoint(identity: DaemonIdentity): string {
  return identity.endpoint.kind === "unix" ? identity.endpoint.socketPath : identity.endpoint.url;
}
