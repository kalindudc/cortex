// Database-scoped daemon lifecycle: find the ONE daemon serving a canonical
// database, start it, stop exactly that instance, and the withClient
// boundary normal CLI operations go through.
//
// Discovery reads `<db>.daemon.json` beside the canonical database and
// asks the endpoint it names who it is (`GET /api/health` carries the
// daemon's identity):
//   - a healthy instance matching the metadata            -> attach
//   - a peer for another database or another protocol     -> fail (DaemonError)
//   - metadata whose endpoint does not answer, or that is unreadable -> stale;
//     recovered (unlink, then bind or run offline) ONLY by the lease holder,
//     because Bun 1.4.2 refuses to bind over an existing socket path
//   - another instance answering before it has published  -> retry
// A busy owner that publishes nothing (a daemon still starting, or an offline
// command, which never publishes) is retried for a bounded time.
//
// Nothing here signals a pid taken from metadata. Stop is the IPC-only
// shutdown route bound to the verified instance, then a wait for the lease.
//
// Store and the Hono app load lazily, only on the owned offline path, so
// verified remote requests never evaluate SQLite or the server.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import pkg from "../package.json" with { type: "json" };
import {
  CONTROL_PATHS,
  createApi,
  HttpError,
  INSTANCE_HEADER,
  parseHttpError,
  type RequestSender,
  TransportError,
} from "./api.ts";
import { createClient, endpointSender } from "./client.ts";
import type { CortexClient, DaemonIdentity, Endpoint } from "./contracts.ts";
import { canonicalDatabasePath, type OwnerLease, tryAcquireOwnership } from "./ownership.ts";
import {
  daemonLogPath,
  daemonMetadataPath,
  daemonSocketName,
  dbPath,
  ensureConfigDir,
  ensureRuntimeDir,
  runtimeDir,
} from "./paths.ts";

/** The wire/metadata protocol this cortex speaks. */
export const DAEMON_PROTOCOL = 1 as const;
/** Optional protocol-1 features every daemon of this version offers (published in its identity). */
export const DAEMON_CAPABILITIES: readonly string[] = ["control.shutdown"];

/** How long one identity probe may take before its endpoint counts as not answering. */
const PROBE_TIMEOUT_MS = 2_000;
/** How long to keep retrying while another process owns the database without publishing a daemon. */
const BUSY_TIMEOUT_MS = 10_000;
/** How long a started daemon has to publish its metadata. */
const START_TIMEOUT_MS = 15_000;
/** How long a stopping daemon has to release the database. */
const STOP_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 10_000;

export type DaemonErrorCode =
  /** The daemon behind the metadata serves (or claims) another database. */
  | "wrong-database"
  /** Something answers at the daemon endpoint but not as a protocol-1 cortex daemon. */
  | "protocol-mismatch"
  /** Another process owned the database and published no daemon within the deadline. */
  | "busy"
  /** `serve --foreground` found this database already served. */
  | "already-running"
  /** A started daemon exited or did not become ready in time. */
  | "start-failed"
  /** A daemon accepted shutdown but kept the database past the deadline. */
  | "stop-failed";

export class DaemonError extends Error {
  readonly code: DaemonErrorCode;
  constructor(code: DaemonErrorCode, message: string) {
    super(message);
    this.name = "DaemonError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function unlinkIfPresent(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
  }
}

function describeEndpoint(endpoint: Endpoint): string {
  return endpoint.socketPath;
}

// ---------- identity and metadata ----------

function parseEndpoint(value: unknown): Endpoint | null {
  if (!isRecord(value)) return null;
  if (value.kind === "unix" && typeof value.socketPath === "string" && value.socketPath !== "") {
    return { kind: "unix", socketPath: value.socketPath };
  }
  return null;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/** A complete protocol-1 identity, copied field by field; null for anything else. */
function parseIdentity(value: unknown): DaemonIdentity | null {
  if (!isRecord(value) || value.protocol !== DAEMON_PROTOCOL) return null;
  const endpoint = parseEndpoint(value.endpoint);
  // Fields are copied one by one: members an older daemon published that this version no longer reads are ignored.
  const { instanceId, databaseId, databasePath, pid, capabilities } = value;
  if (endpoint === null || !nonEmpty(instanceId) || !nonEmpty(databaseId) || !nonEmpty(databasePath)) return null;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (capabilities !== undefined && !(Array.isArray(capabilities) && capabilities.every(c => typeof c === "string"))) {
    return null;
  }
  const identity: DaemonIdentity = { protocol: DAEMON_PROTOCOL, instanceId, databaseId, databasePath, endpoint, pid };
  if (capabilities !== undefined) identity.capabilities = [...capabilities];
  return identity;
}

type MetadataRead =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  /** `identity` is null when the file is another protocol's (or incomplete); `endpoint` is still probed. */
  | { kind: "present"; endpoint: Endpoint; identity: DaemonIdentity | null };

function readDaemonMetadata(canonical: string): MetadataRead {
  let text: string;
  try {
    text = fs.readFileSync(daemonMetadataPath(canonical), "utf8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return { kind: "absent" };
    throw err;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "not JSON" };
  }
  const endpoint = isRecord(value) ? parseEndpoint(value.endpoint) : null;
  if (endpoint === null) return { kind: "invalid", reason: "no endpoint" };
  return { kind: "present", endpoint, identity: parseIdentity(value) };
}

/**
 * Publish `identity` as `<db>.daemon.json`: written to a private (0600) temp
 * file beside it, then renamed over it, so a reader never sees a partial
 * file. Call only while owning the database, after the listeners are bound
 * and ready.
 */
export function publishDaemonMetadata(identity: DaemonIdentity): void {
  const target = daemonMetadataPath(identity.databasePath);
  const temp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temp, target);
  } catch (err) {
    unlinkIfPresent(temp);
    throw err;
  }
}

/** Remove `<db>.daemon.json` only if it names `identity`'s instance: never another owner's metadata. */
export function removeDaemonMetadata(identity: DaemonIdentity): boolean {
  const read = readDaemonMetadata(identity.databasePath);
  if (read.kind !== "present" || read.identity?.instanceId !== identity.instanceId) return false;
  unlinkIfPresent(daemonMetadataPath(identity.databasePath));
  return true;
}

function removeSocketIfPresent(socketPath: string): void {
  const st = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (st?.isSocket()) unlinkIfPresent(socketPath);
}

/**
 * While holding `lease`, remove what a dead daemon left behind: its metadata
 * and its socket (in this runtime dir, and where the metadata says, if it has
 * this database's socket name). Only sockets are unlinked, never other files.
 * Safe because every cooperating daemon owns the lease for as long as it
 * serves, so a lease holder knows no daemon is alive for this database.
 */
export function recoverStaleDaemonState(lease: OwnerLease): void {
  const canonical = lease.databasePath;
  const read = readDaemonMetadata(canonical);
  const name = daemonSocketName(canonical);
  if (read.kind === "present" && read.endpoint.kind === "unix" && path.basename(read.endpoint.socketPath) === name) {
    removeSocketIfPresent(read.endpoint.socketPath);
  }
  removeSocketIfPresent(path.join(runtimeDir(), name));
  if (read.kind !== "absent") unlinkIfPresent(daemonMetadataPath(canonical));
}

// ---------- probing ----------

type Probe = { reachable: false; reason: string } | { reachable: true; health: unknown };

/** GET /api/health at `endpoint`. Unreachable means nothing answered (refused, missing, timed out). */
async function probeHealth(endpoint: Endpoint, timeoutMs: number): Promise<Probe> {
  try {
    return { reachable: true, health: await createApi(endpointSender(endpoint), { timeoutMs }).health() };
  } catch (err) {
    if (err instanceof TransportError && err.kind !== "protocol") return { reachable: false, reason: err.message };
    // It answered, just not with a cortex health document.
    if (err instanceof TransportError || err instanceof HttpError) return { reachable: true, health: null };
    throw err;
  }
}

type Inspection =
  | { kind: "attach"; identity: DaemonIdentity }
  | { kind: "none" }
  | { kind: "stale"; reason: string }
  | { kind: "unpublished"; reason: string };

/** One discovery classification of the metadata beside `canonical`; throws for a wrong database or protocol. */
async function inspect(canonical: string, probeTimeoutMs: number): Promise<Inspection> {
  const read = readDaemonMetadata(canonical);
  if (read.kind === "absent") return { kind: "none" };
  const metadataFile = daemonMetadataPath(canonical);
  if (read.kind === "invalid")
    return { kind: "stale", reason: `unreadable daemon metadata ${metadataFile} (${read.reason})` };
  const where = describeEndpoint(read.endpoint);
  const probe = await probeHealth(read.endpoint, probeTimeoutMs);
  if (!probe.reachable)
    return { kind: "stale", reason: `the daemon endpoint ${where} does not answer (${probe.reason})` };

  const answered = isRecord(probe.health) ? probe.health.identity : undefined;
  if (!isRecord(answered)) {
    throw new DaemonError(
      "protocol-mismatch",
      `${where} answers, but not as a protocol-${DAEMON_PROTOCOL} cortex daemon; stop whatever listens there, then retry`,
    );
  }
  if (answered.protocol !== DAEMON_PROTOCOL) {
    throw new DaemonError(
      "protocol-mismatch",
      `the cortex daemon at ${where} speaks protocol ${String(answered.protocol)}, but this cortex speaks ` +
        `${DAEMON_PROTOCOL}; stop it with the cortex that started it, then retry`,
    );
  }
  const live = parseIdentity(answered);
  if (live === null) {
    throw new DaemonError("protocol-mismatch", `the cortex daemon at ${where} answered with a malformed identity`);
  }
  if (live.databasePath !== canonical) {
    throw new DaemonError(
      "wrong-database",
      `${metadataFile} points at a cortex daemon serving ${live.databasePath}, not ${canonical}; ` +
        `stop that daemon or remove the metadata file, then retry`,
    );
  }
  const published = read.identity;
  if (published === null || published.instanceId !== live.instanceId) {
    return { kind: "unpublished", reason: `instance ${live.instanceId} answers at ${where} but has not published yet` };
  }
  if (published.databaseId !== live.databaseId || published.pid !== live.pid || published.databasePath !== canonical) {
    throw new DaemonError(
      "wrong-database",
      `${metadataFile} does not match the daemon answering at ${where} (instance ${live.instanceId}); stop it, then retry`,
    );
  }
  const version = isRecord(probe.health) ? probe.health.version : undefined;
  if (typeof version === "string") live.version = version;
  return { kind: "attach", identity: live };
}

/**
 * One line for stderr when the daemon serving this database runs another cortex version (a daemon keeps
 * running across an upgrade); null when the versions match or the daemon's is unknown.
 */
export function daemonVersionWarning(cliVersion: string, daemonVersion: string | undefined): string | null {
  if (daemonVersion === undefined || daemonVersion === cliVersion) return null;
  return (
    `cortex: this is cortex ${cliVersion}, but the daemon serving this database runs cortex ${daemonVersion}; ` +
    "run `cortex stop` to restart it, and keep the desktop app at the same version (it starts the daemon)"
  );
}

/**
 * The verified daemon serving `databasePath` (any alias of it), or null when
 * none is published and healthy. Read-only: never takes the lease, recovers
 * nothing and creates no files. Throws DaemonError for a daemon of another
 * database or protocol.
 */
export async function discoverDaemon(
  databasePath: string,
  options: { probeTimeoutMs?: number } = {},
): Promise<DaemonIdentity | null> {
  // A database whose directory does not exist has no identity yet, hence no daemon.
  if (!fs.existsSync(path.dirname(path.resolve(databasePath)))) return null;
  const found = await inspect(canonicalDatabasePath(databasePath), options.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
  return found.kind === "attach" ? found.identity : null;
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
}

// ---------- claiming a database ----------

export type Claim = { identity: DaemonIdentity; lease?: never } | { lease: OwnerLease; identity?: never };

export interface ClaimOptions {
  /** How long to keep retrying while another process owns the database without publishing a daemon. */
  busyTimeoutMs?: number;
  probeTimeoutMs?: number;
}

/**
 * The startup decision for a canonical database: `{ identity }` for its
 * verified daemon, or `{ lease }` once this process owns the database, with
 * stale metadata/socket already recovered.
 * Retries (discovery AND lease acquisition, with backoff) while an owner
 * publishes nothing; throws wrong-database/protocol-mismatch at
 * once and `busy` at the deadline.
 */
export async function claimOrAttach(canonical: string, options: ClaimOptions = {}): Promise<Claim> {
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const budget = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  let backoff = 10;
  for (;;) {
    const found = await inspect(canonical, probeTimeoutMs);
    if (found.kind === "attach") return { identity: found.identity };
    // An unpublished instance already holds the lease; wait for it to publish.
    if (found.kind !== "unpublished") {
      const lease = tryAcquireOwnership(canonical);
      if (lease !== null) {
        try {
          recoverStaleDaemonState(lease);
        } catch (err) {
          lease.release();
          throw err;
        }
        return { lease };
      }
    }
    if (Date.now() >= deadline) {
      const detail = found.kind === "none" ? "" : ` (${found.reason})`;
      throw new DaemonError(
        "busy",
        `${canonical} is owned by another cortex process that published no daemon within ${budget}ms${detail}: ` +
          "a command still running or a daemon still starting. Retry once it finishes",
      );
    }
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 200);
  }
}

// ---------- withClient ----------

export interface WithClientOptions extends ClaimOptions {
  /** Database to operate on (default: `dbPath()`). */
  databasePath?: string;
}

/** Which path withClient took: the verified daemon serving the requests, or null for the owned offline path. */
export interface ClientTarget {
  daemon: DaemonIdentity | null;
}

/**
 * Run `run` against the database's verified daemon over its socket (bound to
 * that instance), or, when none is published, own the database for the
 * operation and serve `run` in-process through the SAME Hono handlers and
 * the same typed client; `target` says which. Once `run` has been handed a
 * remote client there is no offline fallback: a dispatched request may
 * already have committed. The offline lease is released when `run` settles,
 * so callers must not prompt or launch other programs inside it (call
 * withClient again afterwards, which rediscovers and revalidates).
 */
export async function withClient<T>(
  run: (client: CortexClient, target: ClientTarget) => Promise<T>,
  options: WithClientOptions = {},
): Promise<T> {
  const databasePath = options.databasePath ?? dbPath();
  ensureConfigDir(); // Store.open's precondition for the default database's directory.
  const claim = await claimOrAttach(canonicalDatabasePath(databasePath), options);
  if (claim.identity !== undefined) {
    const warning = daemonVersionWarning(pkg.version, claim.identity.version);
    if (warning !== null) console.warn(warning);
    const client = createClient(claim.identity.endpoint, { instanceId: claim.identity.instanceId });
    return run(client, { daemon: claim.identity });
  }
  const lease = claim.lease;
  try {
    const [{ Store }, { buildApp, createRuntime }] = await Promise.all([import("./store.ts"), import("./server.ts")]);
    const store = Store.open(databasePath, { owner: lease });
    try {
      const app = buildApp(store, createRuntime());
      const send: RequestSender = async (requestPath, init) =>
        app.fetch(new Request(`http://cortex${requestPath}`, init));
      return await run(createApi(send), { daemon: null });
    } finally {
      store.close();
    }
  } finally {
    lease.release();
  }
}

// ---------- control ----------

async function control(identity: DaemonIdentity, route: string, body: unknown): Promise<unknown> {
  const headers: Record<string, string> = { [INSTANCE_HEADER]: identity.instanceId };
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const send = endpointSender(identity.endpoint);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new TransportError("timeout", "POST", route, `POST ${route} timed out after ${CONTROL_TIMEOUT_MS}ms`)),
      CONTROL_TIMEOUT_MS,
    );
  });
  let outcome: { res: Response; text: string };
  try {
    outcome = await Promise.race([send(route, init).then(async res => ({ res, text: await res.text() })), deadline]);
  } catch (err) {
    if (err instanceof TransportError) throw err;
    throw new TransportError("network", "POST", route, `POST ${route} failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!outcome.res.ok) throw parseHttpError(outcome.res.status, outcome.text);
  if (outcome.text === "") return undefined;
  try {
    return JSON.parse(outcome.text) as unknown;
  } catch {
    throw new TransportError("protocol", "POST", route, `POST ${route}: response is not JSON`);
  }
}

/** Existence probe (signal 0 delivers nothing) for a pid a verified daemon reported about itself. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === "EPERM";
  }
}

/**
 * Stop exactly this verified instance through its IPC-only shutdown route
 * (another instance answers 421 and keeps running), then wait until it has
 * released the database (or its process is gone). Sends no signals.
 */
export async function stopDaemon(identity: DaemonIdentity, options: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await control(identity, CONTROL_PATHS.shutdown, undefined);
  } catch (err) {
    // A daemon may drop the connection as it closes; the lease below is the evidence either way.
    if (!(err instanceof TransportError && err.kind === "network")) throw err;
  }
  const timeoutMs = options.timeoutMs ?? STOP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lease = tryAcquireOwnership(identity.databasePath);
    if (lease !== null) {
      lease.release();
      return;
    }
    // Gone, even if a new owner took the lease right after it.
    if (!processExists(identity.pid)) return;
    if (Date.now() >= deadline) {
      throw new DaemonError(
        "stop-failed",
        `the cortex daemon for ${identity.databasePath} (pid ${identity.pid}) still owns the database ` +
          `${timeoutMs}ms after it was asked to stop`,
      );
    }
    await Bun.sleep(25);
  }
}

// ---------- ensureDaemon ----------

export interface EnsureDaemonOptions extends ClaimOptions {
  databasePath: string;
  /** Overall deadline for a busy database plus the started daemon's readiness. */
  timeoutMs?: number;
  /** argv that runs this cortex CLI (default: this binary, or bun + this entry script from source). */
  command?: string[];
}

/** argv re-running this CLI. In a compiled binary argv[1] is the embedded `/$bunfs/` entry: drop it. */
export function selfCommand(): string[] {
  const entry = process.argv[1];
  return entry === undefined || entry.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, entry];
}

function logTail(canonical: string): string {
  const text = readIfPresent(daemonLogPath(canonical));
  return text === null ? "" : text.trim().split("\n").slice(-20).join("\n");
}

function hasExited(child: Subprocess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function spawnDaemon(canonical: string, options: EnsureDaemonOptions): Subprocess {
  ensureRuntimeDir();
  const args = ["serve", "--foreground"];
  const log = fs.openSync(daemonLogPath(canonical), "w", 0o600);
  try {
    const child = Bun.spawn([...(options.command ?? selfCommand()), ...args], {
      // Serve exactly the canonical database this caller resolved.
      env: { ...process.env, CORTEX_DB: canonical },
      stdio: ["ignore", log, log],
      detached: true,
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(log);
  }
}

/**
 * The verified daemon for `databasePath`, started in the background
 * (detached, its output in the runtime dir's log) when none runs. Resolves
 * only once the daemon has published its metadata.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonIdentity> {
  ensureConfigDir();
  const canonical = canonicalDatabasePath(options.databasePath);
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const claim = await claimOrAttach(canonical, { probeTimeoutMs, busyTimeoutMs: options.busyTimeoutMs ?? timeoutMs });
  if (claim.identity !== undefined) return claim.identity;
  // Owned and recovered: hand the database to the daemon we start (it claims it again itself).
  claim.lease.release();
  const child = spawnDaemon(canonical, options);
  for (;;) {
    const found = await inspect(canonical, probeTimeoutMs);
    if (found.kind === "attach") return found.identity;
    if (hasExited(child)) {
      // It may have lost a start race to another daemon, which is just as good.
      const again = await inspect(canonical, probeTimeoutMs);
      if (again.kind === "attach") return again.identity;
      const tail = logTail(canonical);
      throw new DaemonError(
        "start-failed",
        `the cortex daemon for ${canonical} exited (${child.signalCode ?? `code ${child.exitCode}`}) before it was ` +
          `ready${tail ? `:\n${tail}` : ""}`,
      );
    }
    if (Date.now() >= deadline) {
      child.kill("SIGTERM"); // our own child, which never published
      const tail = logTail(canonical);
      throw new DaemonError(
        "start-failed",
        `the cortex daemon for ${canonical} was not ready within ${timeoutMs}ms${tail ? `:\n${tail}` : ""}`,
      );
    }
    await Bun.sleep(25);
  }
}
