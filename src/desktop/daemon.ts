/**
 * Connects the desktop app to its database's daemon by running the CLI
 * itself: `cortex serve` attaches to a verified daemon or starts one and
 * returns once it is published, and `cortex doctor --json` names its socket.
 * No metadata reading, lease or realpath logic lives here.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { createApi } from "../api.ts";
import { socketSender } from "./socketFetch.ts";

export interface DaemonConnection {
  socketPath: string;
  instanceId: string;
}

export interface ConnectOptions {
  cortexBin: string;
  /** The database to serve; the CLI's own default (CORTEX_DB or its config path) when omitted. */
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class DaemonConnectError extends Error {}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 1024 * 1024;

/** The CLI binary: `<resources>/cortex` when packaged, else `CORTEX_DESKTOP_CORTEX_BIN`. */
export function resolveCortexBin(o: { env: NodeJS.ProcessEnv; packagedResourcesPath?: string }): string {
  if (o.packagedResourcesPath) return path.join(o.packagedResourcesPath, "cortex");
  const bin = o.env.CORTEX_DESKTOP_CORTEX_BIN;
  if (!bin) {
    throw new DaemonConnectError(
      "CORTEX_DESKTOP_CORTEX_BIN is not set: start the app in development with `pnpm run desktop:dev`",
    );
  }
  return bin;
}

function runCortex(o: ConnectOptions, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env) };
  if (o.databasePath !== undefined) env.CORTEX_DB = o.databasePath;
  return new Promise((resolve, reject) => {
    execFile(
      o.cortexBin,
      args,
      { env, timeout: o.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const reason = stderr.trim() || (err.killed ? "timed out" : err.message);
        reject(new DaemonConnectError(`cortex ${args.join(" ")} failed: ${reason}`));
      },
    );
  });
}

function socketFromDoctor(stdout: string): string {
  let daemon: { running?: unknown; socket?: unknown } | undefined;
  try {
    daemon = (JSON.parse(stdout) as { daemon?: typeof daemon }).daemon;
  } catch {
    throw new DaemonConnectError("cortex doctor --json printed something other than JSON");
  }
  if (daemon?.running !== true || typeof daemon.socket !== "string") {
    throw new DaemonConnectError("cortex doctor --json reports no running daemon after cortex serve");
  }
  return daemon.socket;
}

/** Start or attach to the daemon and return its socket and instance id. */
export async function connectDaemon(o: ConnectOptions): Promise<DaemonConnection> {
  await runCortex(o, ["serve"]);
  const socketPath = socketFromDoctor(await runCortex(o, ["doctor", "--json"]));
  let instanceId: string | undefined;
  try {
    instanceId = (await createApi(socketSender(socketPath)).workspace()).identity?.instanceId;
  } catch (err) {
    throw new DaemonConnectError(`GET /api/workspace failed: ${(err as Error).message}`);
  }
  if (!instanceId) throw new DaemonConnectError("the daemon published no identity");
  return { socketPath, instanceId };
}
