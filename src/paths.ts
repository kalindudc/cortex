import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * XDG-compliant config directory: $XDG_CONFIG_HOME/cortex,
 * falling back to ~/.config/cortex.
 */
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "cortex");
}

/**
 * Path to the SQLite database file.
 * `CORTEX_DB` env var overrides for test isolation.
 */
export function dbPath(): string {
  return process.env.CORTEX_DB ?? path.join(configDir(), "cortex.db");
}

/**
 * Path to the daemon PID file.
 */
export function pidPath(): string {
  return path.join(configDir(), "cortex.pid");
}

/**
 * Path to the daemon URL file. Written by `serve` so the CLI knows where to
 * send mutations when a daemon is running.
 */
export function urlPath(): string {
  return path.join(configDir(), "cortex.url");
}

/**
 * Path to the daemon BROWSER URL file. Written by `serve` so `cortex open`
 * (and humans inspecting the config dir) know the user-facing URL for the
 * dashboard. Distinct from `urlPath()` because the browser URL uses the
 * friendly hostname (e.g. `cortex.localhost`) which the CLI client cannot
 * reliably resolve via Bun's fetch / curl / glibc getaddrinfo.
 */
export function browserUrlPath(): string {
  return path.join(configDir(), "cortex.browser-url");
}

/**
 * Ensure the config directory exists. Idempotent.
 */
export function ensureConfigDir(): void {
  fs.mkdirSync(configDir(), { recursive: true });
}

/** Directory for on-demand cortex data-only backup archives. */
export function backupsDir(): string {
  return path.join(configDir(), "backups");
}

/** Ensure the backup directory exists. Idempotent. */
export function ensureBackupsDir(): void {
  fs.mkdirSync(backupsDir(), { recursive: true });
}

export function readPid(): number | null {
  if (!fs.existsSync(pidPath())) return null;
  const pid = Number.parseInt(fs.readFileSync(pidPath(), "utf8").trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the daemon if running. Idempotent: returns true on a successful stop,
 * false if no live daemon was found. Always cleans up the pid/url files.
 */
export async function stopDaemonIfRunning(): Promise<boolean> {
  const pid = readPid();
  let stopped = false;
  if (pid !== null && isAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
      // Give the daemon's SIGTERM handler ~1s to exit cleanly and remove its
      // own pid/url files. If it doesn't, we'll force-remove below.
      for (let i = 0; i < 20; i++) {
        if (!isAlive(pid)) break;
        await Bun.sleep(50);
      }
    } catch {
      /* ignore — we'll wipe the files regardless */
    }
  }
  // Force-cleanup any lingering daemon state files.
  for (const p of [pidPath(), urlPath(), browserUrlPath()]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
  return stopped;
}
