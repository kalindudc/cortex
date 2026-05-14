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
