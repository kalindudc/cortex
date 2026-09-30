import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createHash } from "node:crypto";

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
 * Ensure the config directory exists. Idempotent.
 */
export function ensureConfigDir(): void {
  fs.mkdirSync(configDir(), { recursive: true });
}

// ---------- ownership + daemon runtime locations ----------
//
// The owner lock and daemon metadata live BESIDE the canonical database (see
// `canonicalDatabasePath` in ownership.ts), so every process that resolves
// the same database file finds the same sidecars whatever config root it
// uses. Only the socket lives elsewhere: in a private runtime directory,
// under a short hashed name, because AF_UNIX caps socket paths near 104
// bytes. These helpers take an ALREADY-canonical database path and never
// move `dbPath()`.

/**
 * Persistent sidecar that `tryAcquireOwnership` flocks. Never unlink or
 * replace it (reset included): a new inode would admit a second owner.
 */
export function ownerLockPath(canonicalDatabasePath: string): string {
  return `${canonicalDatabasePath}.owner.lock`;
}

/** Complete daemon metadata, published beside the canonical database. */
export function daemonMetadataPath(canonicalDatabasePath: string): string {
  return `${canonicalDatabasePath}.daemon.json`;
}

/** Longest socket path we produce: macOS `sun_path` is 104 bytes including the NUL (Linux: 108). */
export const MAX_SOCKET_PATH_BYTES = 103;

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("cortex runtime directories need a POSIX user id (macOS or Linux)");
  return uid;
}

/** A real (non-symlink) directory owned by `uid` with mode exactly 0700. */
function isPrivateDirectory(dir: string, uid: number): boolean {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && st.uid === uid && (st.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

/**
 * Private per-user directory for daemon sockets: `XDG_RUNTIME_DIR` when it
 * is an absolute, existing 0700 directory owned by this user (XDG Base
 * Directory rules), otherwise the explicit fallback `<os.tmpdir()>/cortex-<uid>`.
 * A pure lookup; `ensureRuntimeDir()` creates and validates the fallback.
 */
export function runtimeDir(): string {
  const uid = currentUid();
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && path.isAbsolute(xdg) && isPrivateDirectory(xdg, uid)) return xdg;
  return path.join(os.tmpdir(), `cortex-${uid}`);
}

/**
 * `runtimeDir()`, created (0700) when missing. Throws rather than using a
 * directory that another user could own, read or replace.
 */
export function ensureRuntimeDir(): string {
  const dir = runtimeDir();
  const uid = currentUid();
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  if (!isPrivateDirectory(dir, uid)) {
    throw new Error(
      `unsafe cortex runtime directory ${dir}: it must be a real directory owned by uid ${uid} with mode 0700; ` +
        "remove it or point XDG_RUNTIME_DIR at a private directory",
    );
  }
  return dir;
}

/** The daemon socket's file name for a canonical database: `cortex-<16 hex of sha256>.sock`. */
export function daemonSocketName(canonicalDatabasePath: string): string {
  const digest = createHash("sha256").update(canonicalDatabasePath).digest("hex").slice(0, 16);
  return `cortex-${digest}.sock`;
}

/**
 * Daemon socket for a canonical database: `cortex-<16 hex of sha256>.sock`
 * in `runtimeDir()`, so its length never depends on the database path.
 * Callers that bind or connect call `ensureRuntimeDir()` first.
 */
export function daemonSocketPath(canonicalDatabasePath: string): string {
  const socket = path.join(runtimeDir(), daemonSocketName(canonicalDatabasePath));
  const bytes = Buffer.byteLength(socket);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `cortex daemon socket path ${socket} is ${bytes} bytes; AF_UNIX allows at most ${MAX_SOCKET_PATH_BYTES}. ` +
        "Point XDG_RUNTIME_DIR at a shorter private (0700) directory",
    );
  }
  return socket;
}

/**
 * Output of a daemon started in the background (`cortex serve`, TUI
 * autostart) for a canonical database: the socket's name with `.log`, in the
 * same private runtime directory. Truncated at every background start, so a
 * daemon that dies before it is ready can be explained to the caller.
 */
export function daemonLogPath(canonicalDatabasePath: string): string {
  return daemonSocketPath(canonicalDatabasePath).replace(/\.sock$/, ".log");
}

// ---------- terminal UI configuration ----------
//
// `tui.toml` and `themes/*.toml` are USER-authored and read-only to cortex;
// every profile shares them. Only `tui/<profile>.state.json` is app-written
// (view preferences, merged on save by src/tui/preferences.ts). Everything
// stays under configDir() so the XDG_CONFIG_HOME test pin isolates it.

/** The user's terminal UI configuration file (leader, keys, mouse, theme, appearance, colors). */
export function tuiConfigPath(): string {
  return path.join(configDir(), "tui.toml");
}

/** Directory of the user's custom terminal themes, `<name>.toml` each. */
export function themesDir(): string {
  return path.join(configDir(), "themes");
}

/** A profile name: ASCII letters/digits first, then letters, digits, `-` or `_`, at most 64 characters. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * App-written view state of one TUI profile: `configDir()/tui/<profile>.state.json`.
 * Throws for a profile name that could leave or alias the state directory
 * (separators, dots, leading `-`, control or non-ASCII characters). A pure lookup.
 */
export function tuiStatePath(profile: string): string {
  if (!PROFILE_NAME.test(profile)) {
    throw new Error(
      `invalid profile name ${JSON.stringify(profile)}: use 1-64 ASCII letters, digits, '-' or '_', starting with a letter or digit`,
    );
  }
  return path.join(configDir(), "tui", `${profile}.state.json`);
}

/** Directory for on-demand cortex data-only backup archives. */
export function backupsDir(): string {
  return path.join(configDir(), "backups");
}

/** Ensure the backup directory exists. Idempotent. */
export function ensureBackupsDir(): void {
  fs.mkdirSync(backupsDir(), { recursive: true });
}
