// Playwright fixture that spawns a freshly-isolated cortex daemon per test.
//
// === DB ISOLATION CONTRACT ===
// Every cortex env path is redirected into a fresh per-test tmpdir. The
// daemon CANNOT see, read, or write the developer's real ~/.config/cortex
// data because:
//
//   - XDG_CONFIG_HOME is set to <tmpDir>, so paths.ts's configDir() returns
//     <tmpDir>/cortex/ instead of ~/.config/cortex/ (backups land there, and
//     no older binary's cortex.pid/cortex.url can be found).
//   - CORTEX_DB is set to <tmpDir>/cortex.db, so paths.ts's dbPath()
//     short-circuits before consulting configDir(). The daemon's owner lock
//     and published metadata sit beside it.
//   - CORTEX_SKILL_DIR is set to <tmpDir>/skill, so init/reset never
//     touches ~/.agents/skills/.
//   - CORTEX_PI_EXTENSION_DIR is set to <tmpDir>/ext, so init/reset never
//     touches ~/.pi/agent/extensions/.
//   - XDG_RUNTIME_DIR is set to a separate, SHORT, fresh 0700 dir, so
//     daemon sockets (src/paths.ts runtimeDir()) stay private and under
//     the ~104-byte AF_UNIX path limit.
//
// All five inherited variables are EXPLICITLY DELETED from the spawned
// env before being re-set, so an empty-string `XDG_CONFIG_HOME=""` from
// the parent shell can't sneak past paths.ts's `?? path.join(homedir(),
// ".config")` (an empty string is truthy and would route writes to the
// real ~/.config/cortex). This mirrors test/integration/helpers.ts:mkTmpEnv,
// the pattern that already protects the bun:test backend suite.
//
// Each test also gets a randomized free port so a developer with a real
// `cortex serve` already running on the default 7777 still passes the
// e2e suite. Teardown SIGTERMs the daemon, waits for it to exit cleanly
// (or SIGKILLs after a deadline), and removes the tmpdir recursively.
//
// `cli(args)` runs the compiled binary with the SAME hermetic env, so it
// attaches to this test's daemon (its published metadata and private socket)
// and never to a real one. It only ever spawns short-lived commands; the
// daemon lifecycle stays owned by the fixture.

import { test as base } from "@playwright/test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The outcome of one `cortex` command run against this test's daemon. */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CortexDaemon {
  url: string;
  env: Record<string, string>;
}

interface CortexFixture {
  cortexDaemon: CortexDaemon;
  url: string;
  cli: (args: string[]) => Promise<CliResult>;
}

/** Ask the OS for a free TCP port on 127.0.0.1, then immediately release it.
 *  Brief TOCTOU window between close and the daemon's bind — acceptable for
 *  a single-worker suite. */
function freePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", rejectP);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        rejectP(new Error("could not obtain a free port"));
        return;
      }
      const port = addr.port;
      srv.close(err => (err ? rejectP(err) : resolveP(port)));
    });
  });
}

/** Poll GET /api/health every 100ms up to 10s. Returns when 200 OK arrives;
 *  throws otherwise so the test fails fast instead of hanging on its first
 *  page.goto. */
async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return;
      lastErr = new Error(`/api/health returned ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`cortex daemon at ${url} did not become healthy within 10s: ${String(lastErr)}`);
}

/** Wait for the child process to exit on its own (up to 2s) or hard-kill it.
 *  Avoids leaking zombies on macOS when SIGTERM is silently ignored. */
async function killAndWait(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const exited = await new Promise<boolean>(resolveP => {
    const t = setTimeout(() => resolveP(false), 2000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolveP(true);
    });
  });
  if (!exited) proc.kill("SIGKILL");
}

const BIN = resolve(import.meta.dirname ?? __dirname, "..", "..", "..", "bin", "cortex");

/** Run the compiled binary once with `env` (never a shell), collecting its output. */
function runCli(env: Record<string, string>, args: string[]): Promise<CliResult> {
  return new Promise(resolveP => {
    execFile(BIN, args, { env, encoding: "utf8", timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
      resolveP({ code, stdout, stderr });
    });
  });
}

export const test = base.extend<CortexFixture>({
  // Playwright fixture signature: ({ dep1, dep2, ... }, use) => { ... }.
  // The empty `{}` is REQUIRED by Playwright ("First argument must use the
  // object destructuring pattern") to declare that this fixture has no
  // upstream dependencies.
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture protocol requires the literal `{}` here.
  cortexDaemon: async ({}, use) => {
    const port = await freePort();
    // mkdtemp gives us a unique <os-tmp>/cortex-e2e-XXXXXX/ root, plus a
    // separate short private runtime dir for daemon sockets.
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-e2e-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "cxr-"));
    chmodSync(runtimeDir, 0o700);
    const removeTmp = (): void => {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    };

    // Build the hermetic env. DELETE all five keys before re-setting them
    // so inherited "" / wrong path values cannot leak through.
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const key of [
      "XDG_CONFIG_HOME",
      "XDG_RUNTIME_DIR",
      "CORTEX_DB",
      "CORTEX_SKILL_DIR",
      "CORTEX_PI_EXTENSION_DIR",
    ]) {
      delete env[key];
    }
    env.XDG_CONFIG_HOME = tmpDir;
    env.XDG_RUNTIME_DIR = runtimeDir;
    env.CORTEX_DB = join(tmpDir, "cortex.db");
    env.CORTEX_SKILL_DIR = join(tmpDir, "skill");
    env.CORTEX_PI_EXTENSION_DIR = join(tmpDir, "ext");
    env.NO_COLOR = "1";

    const proc = spawn(BIN, ["serve", "--port", String(port), "--foreground", "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams;

    // Surface stderr on failure for fast debugging when health-check times out.
    const stderrBuf: Buffer[] = [];
    proc.stderr.on("data", (b: Buffer) => stderrBuf.push(b));

    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(url);
    } catch (e) {
      await killAndWait(proc);
      removeTmp();
      const stderr = Buffer.concat(stderrBuf).toString("utf8");
      throw new Error(`${String(e)}\n--- daemon stderr ---\n${stderr}`);
    }

    try {
      await use({ url, env });
    } finally {
      await killAndWait(proc);
      removeTmp();
    }
  },
  url: async ({ cortexDaemon }, use) => {
    await use(cortexDaemon.url);
  },
  cli: async ({ cortexDaemon }, use) => {
    await use(args => runCli(cortexDaemon.env, args));
  },
});

export { expect } from "@playwright/test";
