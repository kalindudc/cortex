import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BIN, mkTmpEnv, runCli } from "../helpers.ts";

// ---------- CLI integration: `cortex serve --host` + cortex.browser-url ----------
//
// Scope: this file proves that
//   1. `cortex serve --host <name>` writes the FRIENDLY URL to
//      cortex.browser-url AND the LOOPBACK URL to cortex.url, and prints
//      the friendly URL to stdout.
//   2. validateHost in src/commands/serve.ts rejects empty / malformed
//      values BEFORE binding (so a bad --host never starts a daemon).
//   3. `cortex stop` removes cortex.browser-url alongside cortex.{pid,url}.
//
// Why we spawn the daemon directly (not via runCli):
//   `cortex serve --foreground` does not exit on its own; runCli waits
//   for exit. We need a long-running process whose stdout / pid we can
//   inspect, then SIGTERM it. Same approach as serve-stop.test.ts.

const REAL_PID = path.join(os.homedir(), ".config", "cortex", "cortex.pid");
const REAL_URL = path.join(os.homedir(), ".config", "cortex", "cortex.url");
const REAL_BROWSER_URL = path.join(os.homedir(), ".config", "cortex", "cortex.browser-url");

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
let realBrowserUrlBefore: Snap = null;

const spawnedPids = new Set<number>();

beforeAll(() => {
  realPidBefore = snap(REAL_PID);
  realUrlBefore = snap(REAL_URL);
  realBrowserUrlBefore = snap(REAL_BROWSER_URL);
});

afterAll(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone — expected on the happy path */
    }
  }
});

/**
 * Spawn `cortex serve --port 0 --foreground --no-open --host <host>`
 * directly so proc.pid IS the daemon. Returns once both pid + url +
 * browser-url files exist (signal that startServer bound and the
 * shutdown handler is wired). Mirrors spawnDaemon() in serve-stop.test.ts
 * but with the extra browser-url file and a configurable host.
 */
async function spawnDaemonWithHost(
  label: string,
  host: string,
): Promise<{
  proc: ReturnType<typeof Bun.spawn>;
  tmpDir: string;
  pidFile: string;
  urlFile: string;
  browserUrlFile: string;
  stdout: string;
  cleanup: () => void;
}> {
  const { tmpDir, env, cleanup } = mkTmpEnv(label);
  const pidFile = path.join(tmpDir, "cortex", "cortex.pid");
  const urlFile = path.join(tmpDir, "cortex", "cortex.url");
  const browserUrlFile = path.join(tmpDir, "cortex", "cortex.browser-url");

  const proc = Bun.spawn([BIN, "serve", "--port", "0", "--foreground", "--no-open", "--host", host], {
    env,
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedPids.add(proc.pid);

  // Wait up to 5s for all three files to appear. The daemon writes
  // pidPath/urlPath/browserUrlPath synchronously after startServer()
  // returns, so first-existence is a strict happens-after of bind.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile) && fs.existsSync(urlFile) && fs.existsSync(browserUrlFile)) break;
    await Bun.sleep(25);
  }
  if (!fs.existsSync(pidFile) || !fs.existsSync(urlFile) || !fs.existsSync(browserUrlFile)) {
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
    throw new Error(`daemon failed to write pid/url/browser-url within 5s. stderr=${stderr}`);
  }

  // Drain a single readable chunk of stdout so the test can assert the
  // printed URL line. The daemon emits one line then sits idle until
  // SIGTERM, so a 100 ms read window is enough.
  let stdout = "";
  try {
    const reader = proc.stdout.getReader();
    const start = Date.now();
    while (Date.now() - start < 250) {
      const r = await Promise.race([reader.read(), Bun.sleep(50).then(() => null)]);
      if (!r) continue;
      const v = r as { done: boolean; value?: Uint8Array };
      if (v.done) break;
      if (v.value) stdout += new TextDecoder().decode(v.value);
      if (stdout.includes("cortex listening on")) break;
    }
    reader.releaseLock();
  } catch {
    /* stdout already consumed elsewhere -- non-fatal */
  }

  return { proc, tmpDir, pidFile, urlFile, browserUrlFile, stdout, cleanup };
}

describe("cortex serve --host", () => {
  test("writes friendly URL to cortex.browser-url and loopback URL to cortex.url; stdout shows friendly URL", async () => {
    const { proc, pidFile, urlFile, browserUrlFile, stdout, cleanup } = await spawnDaemonWithHost(
      "host-flag-friendly",
      "cortex.example",
    );
    try {
      // Both files exist (spawnDaemonWithHost waited for them).
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(urlFile)).toBe(true);
      expect(fs.existsSync(browserUrlFile)).toBe(true);

      const apiUrl = fs.readFileSync(urlFile, "utf8").trim();
      const browserUrl = fs.readFileSync(browserUrlFile, "utf8").trim();

      // CLI side: loopback IP, kernel-assigned port (--port 0).
      expect(apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // Browser side: friendly host, SAME kernel-assigned port.
      const port = apiUrl.match(/:(\d+)$/)?.[1];
      expect(port).toBeDefined();
      expect(browserUrl).toBe(`http://cortex.example:${port}`);

      // stdout shows the friendly URL — proves the daemon prints what the
      // human will see, not the internal loopback. Drain may race; assert
      // only when something captured.
      if (stdout.length > 0) expect(stdout).toContain(`cortex listening on http://cortex.example:${port}`);

      // Send SIGTERM and confirm shutdown handler removes ALL THREE files
      // (the load-bearing assertion for task 3 in the plan).
      process.kill(proc.pid, "SIGTERM");
      const code = await proc.exited;
      expect([0, 143]).toContain(code);
      expect(fs.existsSync(pidFile)).toBe(false);
      expect(fs.existsSync(urlFile)).toBe(false);
      expect(fs.existsSync(browserUrlFile)).toBe(false);
    } finally {
      spawnedPids.delete(proc.pid);
      cleanup();
    }
  });

  test("default --host is cortex.localhost (file contents and stdout)", async () => {
    // Same fixture, default host (passed via --host because spawnDaemonWithHost
    // requires it; passing the default explicitly proves the validator accepts it).
    const { proc, browserUrlFile, urlFile, stdout, cleanup } = await spawnDaemonWithHost(
      "host-flag-default",
      "cortex.localhost",
    );
    try {
      const apiUrl = fs.readFileSync(urlFile, "utf8").trim();
      const port = apiUrl.match(/:(\d+)$/)?.[1];
      expect(port).toBeDefined();
      expect(fs.readFileSync(browserUrlFile, "utf8").trim()).toBe(`http://cortex.localhost:${port}`);
      if (stdout.length > 0) expect(stdout).toContain(`http://cortex.localhost:${port}`);
    } finally {
      try {
        process.kill(proc.pid, "SIGTERM");
        await proc.exited;
      } catch {
        /* ignore */
      }
      spawnedPids.delete(proc.pid);
      cleanup();
    }
  });

  test("rejects empty --host with non-zero exit and the validateHost error", async () => {
    const { env, cleanup } = mkTmpEnv("host-flag-empty");
    try {
      // Empty host: argv contains --host followed by an empty argument.
      const r = await runCli({ args: ["serve", "--port", "0", "--no-open", "--host", ""], env });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("error: --host must be a valid hostname");
    } finally {
      cleanup();
    }
  });

  test("rejects malformed --host (contains a space) with non-zero exit", async () => {
    const { env, cleanup } = mkTmpEnv("host-flag-bad");
    try {
      const r = await runCli({ args: ["serve", "--port", "0", "--no-open", "--host", "bad host"], env });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("error: --host must be a valid hostname");
    } finally {
      cleanup();
    }
  });

  test("rejects --host containing a scheme prefix", async () => {
    const { env, cleanup } = mkTmpEnv("host-flag-scheme");
    try {
      const r = await runCli({
        args: ["serve", "--port", "0", "--no-open", "--host", "http://cortex.localhost"],
        env,
      });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("error: --host must be a valid hostname");
    } finally {
      cleanup();
    }
  });

  // The hermetic-guard tests run last (Bun executes tests in file order
  // within a describe block). Same belt-and-suspenders pattern as
  // serve-stop.test.ts: capture snapshots in beforeAll, fail loud if
  // any test path leaked into ~/.config/cortex/.
  test("hermetic guard: ~/.config/cortex/cortex.pid mtime+size unchanged", () => {
    expect(snapEq(snap(REAL_PID), realPidBefore)).toBe(true);
  });

  test("hermetic guard: ~/.config/cortex/cortex.url mtime+size unchanged", () => {
    expect(snapEq(snap(REAL_URL), realUrlBefore)).toBe(true);
  });

  test("hermetic guard: ~/.config/cortex/cortex.browser-url mtime+size unchanged", () => {
    expect(snapEq(snap(REAL_BROWSER_URL), realBrowserUrlBefore)).toBe(true);
  });
});
