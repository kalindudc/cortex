import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";

type Server = ReturnType<typeof Bun.serve>;
import {
  DAEMON_CAPABILITIES,
  DaemonError,
  discoverDaemon,
  ensureDaemon,
  publishDaemonMetadata,
  recoverStaleDaemonState,
  removeDaemonMetadata,
  stopDaemon,
  withClient,
} from "../../src/daemon.ts";
import { INSTANCE_HEADER } from "../../src/api.ts";
import type { DaemonIdentity } from "../../src/contracts.ts";
import { canonicalDatabasePath, type OwnerLease, tryAcquireOwnership } from "../../src/ownership.ts";
import { daemonMetadataPath, daemonSocketPath, ownerLockPath } from "../../src/paths.ts";
import { buildApp, createRuntime, type DaemonControl } from "../../src/server.ts";
import { Store } from "../../src/store.ts";

// Database-scoped daemon discovery, startup and the withClient boundary
// (plan @400 N4-N6). Every N4 branch is driven with fakes in this process:
// a "daemon" is a real Hono app on a real Unix socket plus the real lease,
// wrong-database/protocol peers are hand-rolled health endpoints, and a stale
// socket is left behind by a SIGKILLed child. The only processes ever
// signalled are ones this file spawned.

const ENV_KEYS = ["XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "CORTEX_DB"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;
let runtimeRoot: string;
let db: string;
const cleanups: (() => unknown)[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  // realpath: macOS tmpdir is /var/... -> /private/var/..., and identities carry canonical paths.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cortex-daemon-")));
  // Short and private, so socket paths stay under the AF_UNIX limit.
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cxd-"));
  fs.chmodSync(runtimeRoot, 0o700);
  process.env.XDG_CONFIG_HOME = root;
  process.env.XDG_RUNTIME_DIR = runtimeRoot;
  db = path.join(root, "cortex.db");
  process.env.CORTEX_DB = db;
  fs.mkdirSync(path.join(root, "cortex"), { recursive: true });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      /* best effort: the test already reported its own failure */
    }
  }
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

// ---------- fixtures ----------

/** A harmless long-lived process whose pid can appear in (stale or legacy) metadata. */
function spawnDummy(): Subprocess {
  const proc = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => {
    proc.kill("SIGKILL");
    await proc.exited;
  });
  return proc;
}

function stillRunning(proc: Subprocess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

type FakeDaemon = {
  identity: DaemonIdentity;
  store: Store;
  lease: OwnerLease;
  /** Every request the daemon answered: `METHOD /path instance-header`. */
  seen: string[];
  controlCalls: string[];
  stopped: boolean;
  stop(): Promise<void>;
};

/**
 * A daemon for `databasePath` in this process: owns the lease (or reuses
 * `lease`), serves the real app on the database's socket, and publishes its
 * metadata unless `publish: false`. `shutdown` really stops it unless
 * `ignoreShutdown`. The pid it reports is `pid` (a dummy), so a bug that
 * signalled it could never hit this test runner.
 */
async function startFakeDaemon(
  databasePath: string,
  options: { lease?: OwnerLease; publish?: boolean; pid: number; ignoreShutdown?: boolean },
): Promise<FakeDaemon> {
  const canonical = canonicalDatabasePath(databasePath);
  const lease = options.lease ?? tryAcquireOwnership(canonical);
  if (lease === null) throw new Error("fake daemon could not own the database");
  const store = Store.open(canonical, { owner: lease, warnMigrations: false });
  const socketPath = daemonSocketPath(canonical);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const identity: DaemonIdentity = {
    protocol: 1,
    instanceId: randomUUID(),
    databaseId: store.databaseId(),
    databasePath: canonical,
    endpoint: { kind: "unix", socketPath },
    pid: options.pid,
    capabilities: [...DAEMON_CAPABILITIES],
  };
  let server: Server | null = null;
  const fake: FakeDaemon = {
    identity,
    store,
    lease,
    seen: [],
    controlCalls: [],
    stopped: false,
    async stop() {
      if (fake.stopped) return;
      fake.stopped = true;
      await server?.stop(true);
      removeDaemonMetadata(identity);
      store.close();
      lease.release();
    },
  };
  const control: DaemonControl = {
    shutdown: () => {
      fake.controlCalls.push("shutdown");
      if (!options.ignoreShutdown) void fake.stop();
    },
  };
  const app = buildApp(store, createRuntime({ identity, control }));
  server = Bun.serve({
    unix: socketPath,
    fetch: req => {
      fake.seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get(INSTANCE_HEADER) ?? "-"}`);
      return app.fetch(req);
    },
  });
  if (options.publish !== false) publishDaemonMetadata(identity);
  cleanups.push(() => fake.stop());
  return fake;
}

/** A Unix-socket peer answering /api/health with `health` (for wrong-database/protocol peers). */
function startHealthPeer(socketPath: string, health: unknown): Server {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = Bun.serve({
    unix: socketPath,
    fetch: req =>
      new URL(req.url).pathname === "/api/health" ? Response.json(health) : new Response("no", { status: 404 }),
  });
  cleanups.push(() => server.stop(true));
  return server;
}

/** Leave a stale socket file at `socketPath`: a child binds it and is SIGKILLed before it can clean up. */
async function leaveStaleSocket(socketPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const code = `Bun.serve({ unix: ${JSON.stringify(socketPath)}, fetch: () => new Response("x") }); console.log("up");`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  child.kill("SIGKILL");
  await child.exited;
  expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
}

function writeMetadata(databasePath: string, value: unknown): string {
  const file = daemonMetadataPath(canonicalDatabasePath(databasePath));
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

function identityFor(databasePath: string, overrides: Partial<DaemonIdentity> = {}): DaemonIdentity {
  const canonical = canonicalDatabasePath(databasePath);
  return {
    protocol: 1,
    instanceId: randomUUID(),
    databaseId: randomUUID(),
    databasePath: canonical,
    endpoint: { kind: "unix", socketPath: daemonSocketPath(canonical) },
    // Not a valid pid on macOS or Linux, so a stray signal could never land anywhere.
    pid: 999_999_999,
    capabilities: [...DAEMON_CAPABILITIES],
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    value => {
      throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
    },
    (err: unknown) => err,
  );
}

function leaseIsFree(databasePath: string): boolean {
  const lease = tryAcquireOwnership(databasePath);
  lease?.release();
  return lease !== null;
}

function taskCount(databasePath: string): number {
  return Store.readSnapshot(databasePath, s => s.listTasks({}).length);
}

// ---------- discovery ----------

describe("discoverDaemon (N4)", () => {
  test("no metadata: null, and discovery never takes the lease or creates files", async () => {
    expect(await discoverDaemon(db)).toBeNull();
    expect(fs.existsSync(ownerLockPath(db))).toBe(false);
    expect(fs.existsSync(daemonMetadataPath(db))).toBe(false);
    expect(fs.existsSync(db)).toBe(false);
  });

  test("a database whose directory does not exist has no daemon", async () => {
    expect(await discoverDaemon(path.join(root, "missing", "cortex.db"))).toBeNull();
  });

  test("a matching healthy instance is attached, through symlinked file and directory paths too", async () => {
    const dummy = spawnDummy();
    const fake = await startFakeDaemon(db, { pid: dummy.pid });
    const fileLink = path.join(root, "link.db");
    fs.symlinkSync(db, fileLink);
    const dirLink = path.join(os.tmpdir(), `cortex-daemon-link-${randomUUID().slice(0, 8)}`);
    fs.symlinkSync(root, dirLink);
    cleanups.push(() => fs.rmSync(dirLink, { force: true }));
    for (const alias of [db, fileLink, path.join(dirLink, "cortex.db")]) {
      expect(await discoverDaemon(alias)).toEqual(fake.identity);
    }
  });

  test("the wrong database behind the metadata fails, leaving every file alone", async () => {
    const socketPath = daemonSocketPath(db);
    const other = identityFor(path.join(root, "other.db"), { endpoint: { kind: "unix", socketPath } });
    startHealthPeer(socketPath, { ok: true, version: "x", identity: other });
    const meta = writeMetadata(db, identityFor(db, { instanceId: other.instanceId, databaseId: other.databaseId }));
    const err = await rejection(discoverDaemon(db));
    expect(err).toBeInstanceOf(DaemonError);
    expect(err).toMatchObject({ code: "wrong-database" });
    expect((err as Error).message).toContain(other.databasePath);
    expect(fs.existsSync(meta)).toBe(true);
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    // withClient and ensureDaemon fail the same way instead of writing.
    expect(await rejection(withClient(async () => "ran", { databasePath: db }))).toMatchObject({
      code: "wrong-database",
    });
    expect(fs.existsSync(db)).toBe(false);
  });

  test("a peer speaking another protocol (or no identity at all) fails", async () => {
    const socketPath = daemonSocketPath(db);
    const identity = identityFor(db);
    startHealthPeer(socketPath, { ok: true, version: "9", identity: { ...identity, protocol: 2 } });
    writeMetadata(db, { ...identity, protocol: 2 });
    expect(await rejection(discoverDaemon(db))).toMatchObject({ code: "protocol-mismatch" });
    expect(await rejection(withClient(async () => "ran", { databasePath: db }))).toMatchObject({
      code: "protocol-mismatch",
    });
  });

  test("a peer that answers health without an identity is not a protocol-1 daemon", async () => {
    const socketPath = daemonSocketPath(db);
    startHealthPeer(socketPath, { ok: true, version: "0.1.0" });
    writeMetadata(db, identityFor(db));
    expect(await rejection(discoverDaemon(db))).toMatchObject({ code: "protocol-mismatch" });
  });

  test("stale metadata and socket: discovery reports nothing and removes nothing", async () => {
    const socketPath = daemonSocketPath(db);
    await leaveStaleSocket(socketPath);
    const meta = writeMetadata(db, identityFor(db));
    expect(await discoverDaemon(db)).toBeNull();
    expect(fs.existsSync(meta)).toBe(true);
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
  });

  test("unreadable metadata is not a daemon", async () => {
    writeMetadata(db, "{ not json");
    expect(await discoverDaemon(db)).toBeNull();
  });
});

// ---------- stale recovery and busy owners ----------

describe("withClient ownership and recovery (N4/N6)", () => {
  test("stale metadata and socket are recovered ONLY by the lease holder; the pid they name is never signalled", async () => {
    const dummy = spawnDummy();
    const socketPath = daemonSocketPath(db);
    await leaveStaleSocket(socketPath);
    const meta = writeMetadata(db, identityFor(db, { pid: dummy.pid }));
    const kill = spyOn(process, "kill");
    try {
      // Someone else (an offline CLI operation) owns the database: hands off.
      const holder = tryAcquireOwnership(db);
      expect(holder).not.toBeNull();
      const busy = await rejection(withClient(async () => "ran", { databasePath: db, busyTimeoutMs: 200 }));
      expect(busy).toBeInstanceOf(DaemonError);
      expect(busy).toMatchObject({ code: "busy" });
      expect(fs.existsSync(meta)).toBe(true);
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      holder?.release();

      // Owning it now: recover (unlink both), then run offline.
      expect(await withClient(async client => (await client.tasks()).length, { databasePath: db })).toBe(0);
      expect(fs.existsSync(meta)).toBe(false);
      expect(fs.existsSync(socketPath)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
    expect(stillRunning(dummy)).toBe(true);
  });

  test("recoverStaleDaemonState needs the lease and removes only sockets", () => {
    const lease = tryAcquireOwnership(db);
    if (lease === null) throw new Error("expected to own the database");
    try {
      const socketPath = daemonSocketPath(db);
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      fs.writeFileSync(socketPath, "not a socket");
      const meta = writeMetadata(db, identityFor(db));
      recoverStaleDaemonState(lease);
      expect(fs.existsSync(meta)).toBe(false);
      expect(fs.readFileSync(socketPath, "utf8")).toBe("not a socket");
    } finally {
      lease.release();
    }
  });

  test("a transient offline owner: withClient retries the lease, then runs offline", async () => {
    const holder = tryAcquireOwnership(db);
    setTimeout(() => holder?.release(), 150);
    const started = Date.now();
    const task = await withClient(client => client.addTask({ title: "after the wait" }), { databasePath: db });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(task.title).toBe("after the wait");
    expect(taskCount(db)).toBe(1);
  });

  test("concurrent offline operations each wait for ownership and all land", async () => {
    const writes = Array.from({ length: 4 }, (_, i) =>
      withClient(client => client.addTask({ title: `t${i}` }), { databasePath: db }),
    );
    const tasks = await Promise.all(writes);
    expect(new Set(tasks.map(t => t.id)).size).toBe(4);
    expect(taskCount(db)).toBe(4);
    expect(leaseIsFree(db)).toBe(true);
  });

  test("a starting (unpublished) daemon holds the lease: withClient waits and attaches once it publishes", async () => {
    const dummy = spawnDummy();
    const lease = tryAcquireOwnership(db);
    if (lease === null) throw new Error("expected to own the database");
    let fake: FakeDaemon | null = null;
    setTimeout(async () => {
      fake = await startFakeDaemon(db, { lease, pid: dummy.pid });
      fake.store.addTask({ title: "served" });
    }, 150);
    const titles = await withClient(async client => (await client.tasks()).map(t => t.title), { databasePath: db });
    expect(titles).toEqual(["served"]);
    const daemon = fake as FakeDaemon | null;
    expect(daemon?.seen).toContain(`GET /api/tasks ${daemon?.identity.instanceId}`);
  });

  test("a new instance answering before it publishes is never mistaken for the old metadata's daemon", async () => {
    const dummy = spawnDummy();
    const lease = tryAcquireOwnership(db);
    if (lease === null) throw new Error("expected to own the database");
    // The new daemon is bound (answers) but the metadata still names a dead predecessor.
    const fake = await startFakeDaemon(db, { lease, pid: dummy.pid, publish: false });
    const oldMeta = identityFor(db, { databaseId: fake.identity.databaseId });
    writeMetadata(db, oldMeta);
    expect(await discoverDaemon(db)).toBeNull();
    setTimeout(() => publishDaemonMetadata(fake.identity), 150);
    const instance = await withClient(async client => (await client.workspace()).identity?.instanceId, {
      databasePath: db,
    });
    expect(instance).toBe(fake.identity.instanceId);
  });
});

// ---------- the two withClient paths ----------

describe("withClient paths (N6)", () => {
  test("offline: owns the database for the operation only, uses the real handlers, and never publishes", async () => {
    const result = await withClient(
      async client => {
        expect(leaseIsFree(db)).toBe(false);
        const created = await client.addTask({ title: "offline", tags: ["x"], author: "agent-1" });
        const post = await client.postUpd(created.id, { author: "agent-1", summary: "hi", status: "review" });
        return { created, post, state: await client.taskState(created.id) };
      },
      { databasePath: db },
    );
    expect(result.created).toMatchObject({ title: "offline", tags: ["x"] });
    expect(result.post.summary).toBe("hi");
    expect(result.state.task.status).toBe("review");
    expect(leaseIsFree(db)).toBe(true);
    expect(fs.existsSync(daemonMetadataPath(db))).toBe(false);
    expect(taskCount(db)).toBe(1);
  });

  test("run learns which path it got: no daemon offline, the verified identity when attached", async () => {
    const offline = await withClient(async (_client, target) => target.daemon, { databasePath: db });
    expect(offline).toBeNull();
    const dummy = spawnDummy();
    const fake = await startFakeDaemon(db, { pid: dummy.pid });
    const attached = await withClient(async (_client, target) => target.daemon, { databasePath: db });
    expect(attached).toEqual(fake.identity);
  });

  test("offline: handler errors surface as HttpError and still release the lease", async () => {
    const err = await rejection(withClient(client => client.taskState(999), { databasePath: db }));
    expect(err).toMatchObject({ name: "HttpError", status: 404 });
    expect(leaseIsFree(db)).toBe(true);
  });

  test("verified daemon: requests go over its socket, bound to its instance", async () => {
    const dummy = spawnDummy();
    const fake = await startFakeDaemon(db, { pid: dummy.pid });
    const task = await withClient(client => client.addTask({ title: "remote" }), { databasePath: db });
    expect(fake.store.getTask(task.id)?.title).toBe("remote");
    expect(fake.seen).toContain(`POST /api/tasks ${fake.identity.instanceId}`);
  });

  test("no fallback after a dispatched remote failure", async () => {
    const dummy = spawnDummy();
    const fake = await startFakeDaemon(db, { pid: dummy.pid });
    let calls = 0;
    const err = await rejection(
      withClient(
        async client => {
          calls += 1;
          // The daemon goes away between discovery and the request; an offline
          // fallback would now succeed, so it must not be attempted.
          await fake.stop();
          expect(leaseIsFree(db)).toBe(true);
          return client.addTask({ title: "must not land offline" });
        },
        { databasePath: db },
      ),
    );
    expect(err).toMatchObject({ name: "TransportError", uncertain: true });
    expect(calls).toBe(1);
    expect(taskCount(db)).toBe(0);
  });
});

// ---------- ensure / stop ----------

describe("ensureDaemon and stopDaemon", () => {
  test("ensureDaemon attaches to a verified daemon: nothing is started and no control request is sent", async () => {
    const dummy = spawnDummy();
    const fake = await startFakeDaemon(db, { pid: dummy.pid });
    const marker = path.join(root, "spawned");
    const command = [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`];
    expect(await ensureDaemon({ databasePath: db, command })).toEqual(fake.identity);
    expect(await ensureDaemon({ databasePath: db, command })).toEqual(fake.identity);
    expect(fake.controlCalls).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("ensureDaemon never starts a daemon while another process owns the database", async () => {
    const holder = tryAcquireOwnership(db);
    cleanups.push(() => holder?.release());
    const marker = path.join(root, "spawned");
    const command = [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`];
    const err = await rejection(ensureDaemon({ databasePath: db, command, timeoutMs: 200 }));
    expect(err).toMatchObject({ code: "busy" });
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("ensureDaemon reports a daemon that exits before it is ready, with its output", async () => {
    const command = [process.execPath, "-e", "console.error('boom: address in use'); process.exit(3)"];
    const err = await rejection(ensureDaemon({ databasePath: db, command, timeoutMs: 5000 }));
    expect(err).toBeInstanceOf(DaemonError);
    expect(err).toMatchObject({ code: "start-failed" });
    expect((err as Error).message).toContain("boom: address in use");
    expect(leaseIsFree(db)).toBe(true);
  });

  test("stopDaemon shuts down exactly the verified instance and waits for the lease", async () => {
    const dummy = spawnDummy();
    const fake = await startFakeDaemon(db, { pid: dummy.pid });
    const kill = spyOn(process, "kill");
    try {
      await stopDaemon(fake.identity);
      expect(kill.mock.calls.every(call => call[1] === 0)).toBe(true);
    } finally {
      kill.mockRestore();
    }
    expect(fake.controlCalls).toEqual(["shutdown"]);
    expect(fake.seen).toContain(`POST /api/control/shutdown ${fake.identity.instanceId}`);
    expect(leaseIsFree(db)).toBe(true);
    expect(fs.existsSync(daemonMetadataPath(db))).toBe(false);
    expect(await discoverDaemon(db)).toBeNull();
    expect(stillRunning(dummy)).toBe(true);
  });

  test("stopDaemon for another instance is refused and leaves the running daemon alone", async () => {
    const dummy = spawnDummy();
    const fake = await startFakeDaemon(db, { pid: dummy.pid });
    const err = await rejection(stopDaemon({ ...fake.identity, instanceId: randomUUID() }));
    expect(err).toMatchObject({ status: 421 });
    expect(fake.controlCalls).toEqual([]);
    expect(await discoverDaemon(db)).toEqual(fake.identity);
    expect(leaseIsFree(db)).toBe(false);
  });

  test("stopDaemon gives up (without signalling anything) when the daemon keeps its lease", async () => {
    const dummy = spawnDummy();
    const fake = await startFakeDaemon(db, { pid: dummy.pid, ignoreShutdown: true });
    const kill = spyOn(process, "kill");
    try {
      const err = await rejection(stopDaemon(fake.identity, { timeoutMs: 200 }));
      expect(err).toMatchObject({ code: "stop-failed" });
      expect(kill.mock.calls.every(call => call[1] === 0)).toBe(true);
    } finally {
      kill.mockRestore();
    }
    expect(stillRunning(dummy)).toBe(true);
    expect(leaseIsFree(db)).toBe(false);
  });
});

// ---------- metadata ----------

describe("daemon metadata", () => {
  test("publish writes the complete identity atomically (0600); removal only removes its own instance", () => {
    const identity = identityFor(db);
    publishDaemonMetadata(identity);
    const file = daemonMetadataPath(db);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(identity);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root).filter(name => name.endsWith(".tmp"))).toEqual([]);
    expect(removeDaemonMetadata({ ...identity, instanceId: randomUUID() })).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(removeDaemonMetadata(identity)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(removeDaemonMetadata(identity)).toBe(false);
  });

  test("an older daemon's extra `webUrl` is ignored, not rejected: it is still discovered and attached (plan @417 N6)", async () => {
    const dummy = spawnDummy();
    const fake = await startFakeDaemon(db, { pid: dummy.pid });
    const current = { ...fake.identity };
    // An older binary published (and answers with) an extra URL member.
    Object.assign(fake.identity, { webUrl: "http://cortex.localhost:7777" });
    publishDaemonMetadata(fake.identity);
    expect(JSON.parse(fs.readFileSync(daemonMetadataPath(db), "utf8")).webUrl).toBe("http://cortex.localhost:7777");
    const found = await discoverDaemon(db);
    expect(found).toEqual(current);
    expect(found).not.toHaveProperty("webUrl");
    const attached = await withClient(async (_client, target) => target.daemon, { databasePath: db });
    expect(attached?.instanceId).toBe(fake.identity.instanceId);
  });
});
