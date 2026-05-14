import { defineCommand } from "citty";
import fs from "node:fs";
import { pidPath, urlPath } from "./../paths.ts";

function cleanupFiles(): void {
  fs.rmSync(pidPath(), { force: true });
  fs.rmSync(urlPath(), { force: true });
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 = liveness probe; doesn't deliver a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover any cortex daemons NOT tracked by the pid file. The pid file
 * goes stale when:
 *   - a second `cortex serve` invocation overwrites it with its own (about
 *     to die) child PID, then crashes on port-bind, leaving the file
 *     pointing to a dead PID while the original daemon keeps running;
 *   - a previous `cortex stop` cleaned up a stale pid file but a
 *     concurrently running daemon kept its port;
 *   - a deployed binary (`~/bin/cortex serve`) was launched out of band
 *     while a dev daemon owned the pid file.
 *
 * Discovery uses `pgrep -f 'cortex serve'` which matches by argv. This is
 * deliberately narrow:
 *   - matches the daemon argv (`/path/to/cortex serve [--foreground]`)
 *   - DOES NOT match `cortex add`, `cortex ls`, `cortex update`, `cortex
 *     stop`, etc. — their argv contains `cortex <subcmd>` where <subcmd>
 *     is not `serve`
 *   - DOES NOT match a parallel agent's `cortex` CLI invocations
 *   - excludes `process.pid` so a wrapper script that happens to embed
 *     "cortex serve" in its own argv doesn't suicide
 *
 * Caveat: source-mode dev daemons (`bun index.ts serve`, no "cortex" in
 * argv) are NOT matched. Stop those with Ctrl-C.
 */
function discoverDaemons(): number[] {
  try {
    const r = Bun.spawnSync(["pgrep", "-f", "cortex serve"]);
    // pgrep exits 1 when there are no matches — that's normal, not an error.
    if (r.exitCode !== 0 && r.exitCode !== 1) return [];
    const out = new TextDecoder().decode(r.stdout).trim();
    if (!out) return [];
    return out
      .split(/\s+/)
      .map(s => Number.parseInt(s, 10))
      .filter(n => Number.isFinite(n) && n !== process.pid && isAlive(n));
  } catch {
    // pgrep not on PATH (Windows, stripped images). Best-effort fallback —
    // we'll still operate on the pid file alone.
    return [];
  }
}

function trySigterm(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch (err) {
    // ESRCH (errno 3) = process already gone. Race-safe: treat as success.
    const errno = (err as NodeJS.ErrnoException).errno;
    if (errno === 3) return true;
    console.error(`warn: could not signal pid ${pid}: ${(err as Error).message}`);
    return false;
  }
}

export default defineCommand({
  meta: {
    name: "stop",
    description: "stop all running cortex daemons (tracked or not)",
  },
  run() {
    // Collect target PIDs from BOTH the pid file (tracked-daemon case) AND
    // a process scan (catches orphans from stale files / out-of-band launches).
    // Set so we dedupe when both sources agree.
    const targets = new Set<number>();

    const path = pidPath();
    if (fs.existsSync(path)) {
      const raw = fs.readFileSync(path, "utf8").trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && isAlive(pid)) targets.add(pid);
      // If the pid file is corrupt or stale, fall through — we'll clean
      // the file at the end regardless.
    }

    for (const pid of discoverDaemons()) targets.add(pid);

    if (targets.size === 0) {
      // Nothing tracked, nothing discovered. Clear any stale pid/url files
      // so a future `serve` starts from a clean slate.
      cleanupFiles();
      console.log("not running");
      return;
    }

    const sorted = Array.from(targets).sort((a, b) => a - b);
    const killed: number[] = [];
    const failed: number[] = [];
    for (const pid of sorted) {
      if (trySigterm(pid)) killed.push(pid);
      else failed.push(pid);
    }

    // Clean the pid/url files even on partial failure; their contents are
    // already known-bad and a stale entry would just confuse the next run.
    cleanupFiles();

    const noun = killed.length === 1 ? "process" : "processes";
    const pidLabel = killed.length === 1 ? "pid" : "pids";
    console.log(`✓ stopped ${killed.length} ${noun} (${pidLabel}: ${killed.join(", ")})`);
    if (failed.length > 0) {
      console.error(`warn: failed to signal ${failed.length} (pids: ${failed.join(", ")})`);
    }
  },
});
