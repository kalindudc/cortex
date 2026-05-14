import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BIN, mkTmpEnv, runCli } from "../helpers.ts";

// ---------- CLI integration: `cortex serve` shutdown ----------
//
// Scope: this file proves the daemon's OWN shutdown handler
// (src/commands/serve.ts:73-86 -- the SIGTERM/SIGINT listener) does the
// right thing: closes the store, removes pidPath()/urlPath(), exits cleanly.
//
// Why we do NOT invoke `cortex stop` here as the primary path:
//   `cortex stop` (src/commands/stop.ts) does host-wide discovery via
//   `pgrep -f 'cortex serve'`, which on a developer machine running a real
//   daemon (`~/bin/cortex serve --foreground`) would race and SIGTERM the
//   developer's live daemon. The hermetic env (XDG_CONFIG_HOME=<tmp>)
//   protects pidPath()/urlPath() but does NOT protect pgrep -- pgrep walks
//   the host process table irrespective of env. So the primary test
//   spawns the daemon directly (`cortex serve --port 0 --foreground
//   --no-open`) and signals proc.pid by hand.
//
// A second test exercises `cortex stop` end-to-end, but ONLY if no
// `cortex serve` is detected on the host (clean CI). On a dev box we
// log + skip, preserving safety while still keeping CI coverage.

// Real user-home pid/url files we MUST NOT touch. The daemon under test
// has XDG_CONFIG_HOME=<tmpDir> in its env so it writes into
// <tmpDir>/cortex/cortex.{pid,url} instead of ~/.config/cortex/, but we
// snapshot the real files anyway to fail loud if that pin ever regresses.
const REAL_PID = path.join(os.homedir(), ".config", "cortex", "cortex.pid");
const REAL_URL = path.join(os.homedir(), ".config", "cortex", "cortex.url");

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

let realPidBefore: Snap = null;
let realUrlBefore: Snap = null;

// Track every PID we spawn so afterAll can SIGKILL them no matter what.
const spawnedPids = new Set<number>();

beforeAll(() => {
  realPidBefore = snap(REAL_PID);
  realUrlBefore = snap(REAL_URL);
});

afterAll(() => {
  // Belt-and-suspenders: even if a test threw mid-flight and the daemon
  // we spawned is still alive, kill it so it can't outlive the test run
  // and confuse the developer's next `cortex stop`. SIGKILL bypasses the
  // shutdown handler -- that's fine here, this is purely a safety net.
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone -- expected on the happy path */
    }
  }
});

/**
 * Spawn `cortex serve --port 0 --foreground --no-open` directly so proc.pid
 * IS the daemon (not a wrapper). Returns once the pid file exists, which
 * is our signal that startServer() bound and the SIGTERM handler is wired.
 *
 * `--port 0` lets the kernel pick a free port -- avoids flaky CI when
 * 7777 is in use. `--foreground` keeps the daemon attached to this
 * process so we can `await proc.exited`. `--no-open` suppresses the
 * macOS dashboard auto-open (it would still try in foreground mode if
 * we omit it; serve.ts only gates the open behind --no-open in the
 * non-foreground branch BUT belt-and-suspenders).
 */
async function spawnDaemon(label: string): Promise<{
  proc: ReturnType<typeof Bun.spawn>;
  tmpDir: string;
  pidFile: string;
  urlFile: string;
  cleanup: () => void;
}> {
  const { tmpDir, env, cleanup } = mkTmpEnv(label);
  const pidFile = path.join(tmpDir, "cortex", "cortex.pid");
  const urlFile = path.join(tmpDir, "cortex", "cortex.url");

  const proc = Bun.spawn([BIN, "serve", "--port", "0", "--foreground", "--no-open"], {
    env,
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedPids.add(proc.pid);

  // Wait up to 5s for the pid file to appear -- proxy for "server bound +
  // shutdown handler installed". Polling is the right primitive here:
  // serve.ts writes pidPath() synchronously after startServer() returns,
  // so first-existence is a strict happens-after of the listener install.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile) && fs.existsSync(urlFile)) break;
    await Bun.sleep(25);
  }
  if (!fs.existsSync(pidFile) || !fs.existsSync(urlFile)) {
    // Daemon never came up. Capture stderr for a useful failure message
    // and tear everything down before throwing.
    let stderr = "";
    try {
      stderr = await new Response(proc.stderr).text();
    } catch {
      /* ignore */
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    cleanup();
    throw new Error(`daemon failed to write pid/url within 5s. stderr=${stderr}`);
  }

  return { proc, tmpDir, pidFile, urlFile, cleanup };
}

describe("cortex serve shutdown integration", () => {
  test("SIGTERM to the daemon removes pid/url files and exits cleanly", async () => {
    const { proc, pidFile, urlFile, cleanup } = await spawnDaemon("serve-sigterm");
    try {
      // Sanity: the daemon wrote into our tmp dir, not ~/.config/cortex.
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(urlFile)).toBe(true);
      const recordedPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      expect(recordedPid).toBe(proc.pid);

      // Send SIGTERM to the daemon directly. This exercises the listener
      // installed at src/commands/serve.ts:84 (process.on("SIGTERM",
      // shutdown)). shutdown() awaits handle.stop(), closes the store,
      // rmSync's pidPath()/urlPath(), then process.exit(0).
      process.kill(proc.pid, "SIGTERM");

      // Bun's spawn `exited` is the wait-status. The daemon calls
      // process.exit(0) inside its handler, so on the happy path we
      // see 0. If the runtime ever short-circuits and reports the
      // signal-terminated status before process.exit lands, that's
      // 128+15=143 on POSIX. Accept either; the FILE check below is
      // the load-bearing assertion (a true uncaught SIGTERM would
      // leave the files on disk, which is what we actually care about).
      const code = await proc.exited;
      expect([0, 143]).toContain(code);

      // shutdown() should have removed both files. This is the assertion
      // that proves the handler ran to completion (vs. the kernel
      // delivering SIGTERM and the runtime tearing down the process
      // before the listener fired).
      expect(fs.existsSync(pidFile)).toBe(false);
      expect(fs.existsSync(urlFile)).toBe(false);
    } finally {
      // Always remove from the kill-set; the process is already gone.
      spawnedPids.delete(proc.pid);
      cleanup();
    }
  });

  test("`cortex stop` end-to-end (skipped if any cortex serve is on the host)", async () => {
    // Why the skip: stop.ts uses `pgrep -f 'cortex serve'` for orphan
    // discovery (see commands/stop.ts:discoverDaemons). pgrep is
    // host-wide -- it will see the developer's real daemon and stop.ts
    // will SIGTERM it. Skip in that case.
    const r = Bun.spawnSync(["pgrep", "-f", "cortex serve"]);
    if (r.exitCode === 0) {
      // eslint-disable-next-line no-console
      console.log(
        "[serve-stop] skipping `cortex stop` e2e: a `cortex serve` is running on the host (pgrep rc=0). " +
          "Run this on a clean CI machine to exercise the full stop path.",
      );
      return;
    }

    const { proc, pidFile, urlFile, tmpDir, cleanup } = await spawnDaemon("serve-stop-e2e");
    try {
      // Build the stop env from the SAME tmpDir/XDG_CONFIG_HOME so
      // stop.ts resolves the same pidPath()/urlPath() the daemon wrote.
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      delete env.XDG_CONFIG_HOME;
      env.XDG_CONFIG_HOME = tmpDir;
      env.NO_COLOR = "1";

      const stopRes = await runCli({ args: ["stop"], env });
      expect(stopRes.code).toBe(0);
      expect(stopRes.stdout).toMatch(/stopped \d+ process/);

      // The daemon should have terminated and shutdown() should have
      // wiped the pid/url files (stop.ts ALSO calls cleanupFiles, but
      // either path satisfies this assertion).
      const code = await proc.exited;
      expect([0, 143]).toContain(code);
      expect(fs.existsSync(pidFile)).toBe(false);
      expect(fs.existsSync(urlFile)).toBe(false);
    } finally {
      spawnedPids.delete(proc.pid);
      cleanup();
    }
  });

  // The hermetic-guard tests run last (Bun executes tests in file order
  // within a describe block). They MUST execute even if earlier tests
  // failed -- the snapshots are captured in beforeAll, so a missed
  // assertion here is the single best signal that the test isolation
  // broke and the developer's real daemon files were touched.
  test("hermetic guard: ~/.config/cortex/cortex.pid mtime+size unchanged", () => {
    const after = snap(REAL_PID);
    expect(snapEq(after, realPidBefore)).toBe(true);
  });

  test("hermetic guard: ~/.config/cortex/cortex.url mtime+size unchanged", () => {
    const after = snap(REAL_URL);
    expect(snapEq(after, realUrlBefore)).toBe(true);
  });
});
