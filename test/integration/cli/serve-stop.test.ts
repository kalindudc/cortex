import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { mkTmpEnv, ROOT } from "../helpers.ts";
import {
  isRunning,
  leaseIsFree,
  metadataFileFor,
  readIdentity,
  reap,
  runBounded,
  socketHealth,
  spawnForeignCortexServe,
  startForeground,
  trackBackground,
  waitFor,
} from "../fixtures/daemon.ts";
import { canonicalDatabasePath } from "../../../src/ownership.ts";

// ---------- CLI integration: database-scoped `cortex serve` / `cortex stop` ----------
//
// Plan @400 Task 6 (N4/N5, gate G1). The daemon owns ONE canonical database:
// it holds the ownership lease for its lifetime, listens on a private Unix
// socket (plus the loopback dashboard), publishes `<db>.daemon.json` only
// once it is ready, and removes its own metadata/socket before releasing the
// lease. `cortex stop` is instance-bound: it discovers THIS database's daemon
// through that metadata and asks it to shut down over its socket. There is no
// process-table scan and no signal, so the old "skip if any `cortex serve`
// runs on the host" guard is gone: a foreign `cortex serve` (for example a
// developer's live `~/bin/cortex serve`) provably survives every stop here.
//
// SAFETY: every signal in this file goes to a process the file spawned
// (the fixture tracks them); background daemons are stopped through their
// instance-bound route. Each test works in its own mkTmpEnv() sandbox.

const REAL_PID = path.join(os.homedir(), ".config", "cortex", "cortex.pid");
const REAL_URL = path.join(os.homedir(), ".config", "cortex", "cortex.url");
const REAL_BROWSER_URL = path.join(os.homedir(), ".config", "cortex", "cortex.browser-url");
const REAL_METADATA = path.join(os.homedir(), ".config", "cortex", "cortex.db.daemon.json");

type Snap = { mtimeMs: number; size: number } | null;
function snap(p: string): Snap {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}
function snapEq(a: Snap, b: Snap): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

const realBefore = new Map<string, Snap>();
const sandboxes: (() => void)[] = [];

beforeAll(() => {
  for (const p of [REAL_PID, REAL_URL, REAL_BROWSER_URL, REAL_METADATA]) realBefore.set(p, snap(p));
});

afterEach(async () => {
  await reap();
});

afterAll(async () => {
  await reap();
  for (const cleanup of sandboxes.splice(0)) cleanup();
});

function sandbox(label: string): ReturnType<typeof mkTmpEnv> {
  const env = mkTmpEnv(label);
  sandboxes.push(env.cleanup);
  return env;
}

function legacyFiles(tmpDir: string): string[] {
  return ["cortex.pid", "cortex.url", "cortex.browser-url"].filter(f => fs.existsSync(path.join(tmpDir, "cortex", f)));
}

describe("cortex serve / stop are scoped to one database", () => {
  test("serve publishes complete metadata once ready; SIGTERM removes it and its socket, then releases the lease", async () => {
    const { tmpDir, runtimeDir, env } = sandbox("serve-sigterm");
    const db = canonicalDatabasePath(env.CORTEX_DB ?? "");
    const daemon = await startForeground(env);
    const { identity } = daemon;

    expect(identity).toMatchObject({ protocol: 1, databasePath: db, pid: daemon.proc.pid });
    expect(identity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.databaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.capabilities).toEqual(["control.shutdown", "control.web", "control.preview"]);
    expect(identity.endpoint.kind).toBe("unix");
    const socketPath = identity.endpoint.kind === "unix" ? identity.endpoint.socketPath : "";
    expect(path.dirname(socketPath)).toBe(runtimeDir);
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    expect(fs.statSync(daemon.metadataFile).mode & 0o777).toBe(0o600);
    expect(daemon.metadataFile).toBe(`${db}.daemon.json`);

    // Both listeners answer as this instance; the metadata's dashboard is the printed host.
    const port = new URL(identity.webUrl ?? "http://x").port;
    expect(identity.webUrl).toBe(`http://cortex.localhost:${port}`);
    expect(daemon.stdout()).toContain(`cortex listening on http://cortex.localhost:${port}`);
    expect((await socketHealth(identity)).identity).toEqual(identity);
    const loopback = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { identity: unknown };
    expect(loopback.identity).toEqual(identity);
    expect(leaseIsFree(db)).toBe(false);
    // Old-style daemon files are no longer written.
    expect(legacyFiles(tmpDir)).toEqual([]);

    daemon.proc.kill("SIGTERM");
    expect([0, 143]).toContain(await daemon.proc.exited);
    expect(fs.existsSync(daemon.metadataFile)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(leaseIsFree(db)).toBe(true);
  }, 30_000);

  test("`cortex stop` stops only this database's daemon; a foreign `cortex serve` process survives", async () => {
    const { env } = sandbox("serve-stop-foreign");
    const db = canonicalDatabasePath(env.CORTEX_DB ?? "");
    const foreign = spawnForeignCortexServe();
    // The dummy is exactly what the old host-wide `pgrep -f 'cortex serve'` stop targeted
    // (only read here; nothing is signalled). Skipped where pgrep is not installed.
    if (Bun.which("pgrep") !== null) {
      const pgrep = Bun.spawnSync(["pgrep", "-f", "cortex serve"]);
      expect(pgrep.stdout.toString().split(/\s+/)).toContain(String(foreign.proc.pid));
    }
    const daemon = await startForeground(env);

    const stopped = await runBounded(["stop"], env);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout.trim()).toBe(`✓ stopped 1 process (pid: ${daemon.proc.pid})`);
    expect([0, 143]).toContain(await daemon.proc.exited);
    expect(fs.existsSync(daemon.metadataFile)).toBe(false);
    expect(leaseIsFree(db)).toBe(true);
    expect(isRunning(foreign)).toBe(true);

    const again = await runBounded(["stop"], env);
    expect(again.code).toBe(0);
    expect(again.stdout.trim()).toBe("not running");
    expect(isRunning(foreign)).toBe(true);
  }, 30_000);

  test("two databases under one config dir run independent daemons, and stop is scoped by CORTEX_DB", async () => {
    const { tmpDir, env } = sandbox("serve-two-dbs");
    const envB = { ...env, CORTEX_DB: path.join(tmpDir, "b.db") };
    const a = await startForeground(env);
    const b = await startForeground(envB);
    expect(a.identity.instanceId).not.toBe(b.identity.instanceId);
    expect(a.identity.databaseId).not.toBe(b.identity.databaseId);
    expect(a.identity.endpoint).not.toEqual(b.identity.endpoint);
    expect(a.metadataFile).not.toBe(b.metadataFile);

    const stopB = await runBounded(["stop"], envB);
    expect(stopB.stdout.trim()).toBe(`✓ stopped 1 process (pid: ${b.proc.pid})`);
    await b.proc.exited;
    expect(isRunning(a)).toBe(true);
    expect((await socketHealth(a.identity)).identity?.instanceId).toBe(a.identity.instanceId);

    const stopA = await runBounded(["stop"], env);
    expect(stopA.stdout.trim()).toBe(`✓ stopped 1 process (pid: ${a.proc.pid})`);
    await a.proc.exited;
  }, 30_000);

  test("the same database through a symlinked directory resolves to the one daemon", async () => {
    const { tmpDir, env } = sandbox("serve-symlink");
    const link = path.join(os.tmpdir(), `cortex-link-${path.basename(tmpDir)}`);
    fs.symlinkSync(tmpDir, link);
    sandboxes.push(() => fs.rmSync(link, { force: true }));
    const viaLink = { ...env, CORTEX_DB: path.join(link, "cortex.db") };
    const daemon = await startForeground(env);

    const second = await runBounded(["serve", "--foreground", "--no-open", "--port", "0"], viaLink);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(`already serving ${canonicalDatabasePath(env.CORTEX_DB ?? "")}`);
    expect(second.stderr).toContain(`pid ${daemon.proc.pid}`);

    // Background serve attaches to it instead of starting another.
    const attach = await runBounded(["serve", "--port", "0"], viaLink);
    expect(attach.code).toBe(0);
    expect(attach.stdout).toContain(`(pid ${daemon.proc.pid})`);

    const stopped = await runBounded(["stop"], viaLink);
    expect(stopped.stdout.trim()).toBe(`✓ stopped 1 process (pid: ${daemon.proc.pid})`);
    expect([0, 143]).toContain(await daemon.proc.exited);
  }, 30_000);

  test("a crashed daemon's stale metadata and socket are recovered by the next owner; the pid they name is never signalled", async () => {
    const { env } = sandbox("serve-stale");
    const first = await startForeground(env);
    const socketPath = first.identity.endpoint.kind === "unix" ? first.identity.endpoint.socketPath : "";
    first.proc.kill("SIGKILL");
    await first.proc.exited;
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    // The dead daemon's pid now "belongs" to an unrelated process.
    const foreign = spawnForeignCortexServe();
    const stale = { ...first.identity, pid: foreign.proc.pid };
    fs.writeFileSync(first.metadataFile, JSON.stringify(stale));

    const stop = await runBounded(["stop"], env);
    expect(stop.code).toBe(0);
    expect(stop.stdout.trim()).toBe("not running");
    expect(isRunning(foreign)).toBe(true);

    const next = await startForeground(env);
    expect(next.identity.instanceId).not.toBe(first.identity.instanceId);
    expect(next.identity.pid).toBe(next.proc.pid);
    expect((await socketHealth(next.identity)).identity?.instanceId).toBe(next.identity.instanceId);
    expect(isRunning(foreign)).toBe(true);

    next.proc.kill("SIGTERM");
    await next.proc.exited;
    expect(isRunning(foreign)).toBe(true);
  }, 30_000);

  test("a healthy legacy daemon blocks serve even though the new lock is free, and stop only reports it", async () => {
    const { tmpDir, env } = sandbox("serve-legacy");
    const db = env.CORTEX_DB ?? "";
    const foreign = spawnForeignCortexServe();
    const legacy = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ ok: true, version: "0.1.0" }),
    });
    try {
      fs.mkdirSync(path.join(tmpDir, "cortex"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "cortex", "cortex.pid"), String(foreign.proc.pid));
      fs.writeFileSync(path.join(tmpDir, "cortex", "cortex.url"), `http://127.0.0.1:${legacy.port}`);
      expect(leaseIsFree(db)).toBe(true);

      for (const args of [
        ["serve", "--foreground", "--no-open", "--port", "0"],
        ["serve", "--port", "0"],
      ]) {
        const r = await runBounded(args, env);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("older cortex binary");
        expect(r.stderr).toContain(`pid ${foreign.proc.pid}`);
        expect(r.stderr).toMatch(/stop it first/);
      }
      expect(fs.existsSync(db)).toBe(false);
      expect(fs.existsSync(metadataFileFor(db))).toBe(false);
      expect(leaseIsFree(db)).toBe(true);

      const stop = await runBounded(["stop"], env);
      expect(stop.code).toBe(0);
      expect(stop.stdout.trim()).toBe("not running");
      expect(stop.stderr).toContain("cortex stop cannot stop it");
      expect(isRunning(foreign)).toBe(true);
    } finally {
      await legacy.stop(true);
    }
  }, 30_000);

  test("background serve prints its success line only once the daemon is ready, and attaches on a second run", async () => {
    const { env } = sandbox("serve-background");
    const metadataFile = metadataFileFor(env.CORTEX_DB ?? "");
    const started = await runBounded(["serve", "--port", "0"], env);
    // The metadata already existed when the parent printed and exited.
    const identity = readIdentity(metadataFile);
    if (identity === null) throw new Error(`no daemon metadata after serve: ${started.stderr}`);
    trackBackground(identity);
    expect(started.code).toBe(0);
    const m = started.stdout.match(/✓ cortex serving at http:\/\/cortex\.localhost:(\d+) \(pid (\d+)\)/);
    expect(m).not.toBeNull();
    expect(identity.pid).toBe(Number(m?.[2]));
    expect(identity.webUrl).toBe(`http://cortex.localhost:${m?.[1]}`);
    expect((await socketHealth(identity)).identity?.instanceId).toBe(identity.instanceId);

    const again = await runBounded(["serve", "--port", "0"], env);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`(pid ${identity.pid})`);

    const stop = await runBounded(["stop"], env);
    expect(stop.stdout.trim()).toBe(`✓ stopped 1 process (pid: ${identity.pid})`);
    await waitFor("the metadata to go away", () => (fs.existsSync(metadataFile) ? null : true));
  }, 30_000);

  test("serve retries the lease while a transient owner (an offline command) holds it", async () => {
    const { env } = sandbox("serve-transient");
    const db = env.CORTEX_DB ?? "";
    const holder = Bun.spawn(
      [process.execPath, path.join(ROOT, "test", "integration", "fixtures", "ownership-holder.ts"), "hold", db],
      { env, cwd: ROOT, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(first.value)).toContain("OWNED");
      setTimeout(() => holder.stdin.end(), 600);
      const startedAt = Date.now();
      const daemon = await startForeground(env);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
      expect(await holder.exited).toBe(0);
      daemon.proc.kill("SIGTERM");
      await daemon.proc.exited;
    } finally {
      if (holder.exitCode === null) holder.kill("SIGKILL");
      await holder.exited;
    }
  }, 30_000);

  // The hermetic-guard test runs last (Bun executes tests in file order
  // within a describe block). It MUST execute even if earlier tests failed:
  // the snapshots are captured in beforeAll, so a mismatch is the single
  // best signal that isolation broke and the developer's real daemon files
  // were touched.
  test("hermetic guard: the real ~/.config/cortex daemon files are unchanged (mtime+size)", () => {
    for (const [p, before] of realBefore) expect(snapEq(snap(p), before), p).toBe(true);
  });
});
