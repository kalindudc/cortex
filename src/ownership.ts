// Database ownership: at most one cooperating cortex process owns a
// canonical database at a time.
//
// - The lease is an OS advisory `flock(2)` (LOCK_EX|LOCK_NB) on a persistent
//   sidecar beside the canonical database (`ownerLockPath`), NOT a SQLite
//   transaction; nothing here touches SQLite.
// - The sidecar is created 0600, opened without following symlinks and
//   close-on-exec, and validated (regular file, our uid, no group/other
//   bits) before locking. It is never unlinked or replaced; the OS releases
//   the lock when the holder closes it or dies, SIGKILL included.
// - Contention (EWOULDBLOCK) is the ONLY outcome reported as `null`; every
//   other failure throws.
// - bun:ffi is loaded lazily, on the first real acquisition only.
// - Advisory: this protects cooperating (upgraded) cortex binaries, not
//   arbitrary SQLite tools or older binaries.

import fs from "node:fs";
import path from "node:path";
import type { Pointer } from "bun:ffi";
import { ownerLockPath } from "./paths.ts";

export interface OwnerLease {
  /** Canonical database path this lease owns (see `canonicalDatabasePath`). */
  readonly databasePath: string;
  /** Unlock and close the sidecar. Idempotent. */
  release(): void;
}

export type OwnershipErrorCode =
  /** No certified flock ABI for this platform/libc. */
  | "unsupported-platform"
  /** The database path has no stable file identity (directory, dangling symlink, :memory:). */
  | "invalid-database-path"
  /** The database file has more than one hard link; each link would get its own lock. */
  | "hard-linked-database"
  /** The lock path is a symlink, not a regular file, foreign-owned, too permissive or was replaced. */
  | "unsafe-lock-file"
  /** flock/fcntl failed with an errno other than EWOULDBLOCK, or the descriptor is inheritable. */
  | "lock-error"
  /** `Store.open` (without a supplied lease) found the database owned elsewhere. */
  | "busy"
  /** `Store.open(..., { owner })` got a lease for a different database. */
  | "lease-mismatch";

export class OwnershipError extends Error {
  readonly code: OwnershipErrorCode;
  /** errno reported by the failing syscall, when there was one. */
  readonly errno: number | null;
  constructor(code: OwnershipErrorCode, message: string, options: { errno?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OwnershipError";
    this.code = code;
    this.errno = options.errno ?? null;
  }
}

/** The native boundary, injectable so unit tests can drive contention and errno paths. */
export interface OwnershipSyscalls {
  /** errno meaning "held by another open file description" for LOCK_NB. */
  readonly ewouldblock: number;
  /** open(2) O_CLOEXEC bit for this platform (node:fs constants do not expose it). */
  readonly cloexecFlag: number;
  /** flock(2): 0 on success, -1 with `errno()` set on failure. */
  flock(fd: number, operation: number): number;
  /** errno left by the last failing call; read it before anything else runs. */
  errno(): number;
  /** Whether FD_CLOEXEC is set, i.e. exec'd children cannot inherit `fd`. */
  isCloseOnExec(fd: number): boolean;
  uid(): number;
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const F_GETFD = 1;
const FD_CLOEXEC = 1;

// Verified ABI (tmp/tui-owner-probe.ts, source + ESM bytecode on Bun 1.4.2).
const DARWIN = { library: "/usr/lib/libSystem.B.dylib", ewouldblock: 35, cloexecFlag: 0x0100_0000 } as const;
const LINUX_GLIBC = { library: "libc.so.6", ewouldblock: 11, cloexecFlag: 0x0008_0000 } as const;

// fcntl is variadic in C; binding it as (i32, i32) is only sound for commands
// that take no third argument, which is why F_GETFD is the only one used.
const LOCK_SYMBOLS = {
  flock: { args: ["i32", "i32"], returns: "i32" },
  fcntl: { args: ["i32", "i32"], returns: "i32" },
} as const;

type Libc = {
  flock(fd: number, operation: number): number;
  fcntl(fd: number, command: number): number;
  errnoLocation(): Pointer | bigint | null;
};

let hostSyscalls: OwnershipSyscalls | null = null;

function bindLibc(ffi: typeof import("bun:ffi"), platform: "darwin" | "linux"): Libc {
  if (platform === "darwin") {
    const { symbols } = ffi.dlopen(DARWIN.library, { ...LOCK_SYMBOLS, __error: { args: [], returns: "ptr" } } as const);
    return { flock: symbols.flock, fcntl: symbols.fcntl, errnoLocation: symbols.__error };
  }
  const { symbols } = ffi.dlopen(LINUX_GLIBC.library, {
    ...LOCK_SYMBOLS,
    __errno_location: { args: [], returns: "ptr" },
  } as const);
  return { flock: symbols.flock, fcntl: symbols.fcntl, errnoLocation: symbols.__errno_location };
}

/**
 * Bind flock/fcntl/errno for `platform` (default: this host) via bun:ffi,
 * loading bun:ffi on first use. Only macOS and Linux/glibc are certified;
 * anything else fails explicitly rather than pretending a PID file is a lock.
 */
export function nativeSyscalls(platform: NodeJS.Platform = process.platform): OwnershipSyscalls {
  if (platform !== "darwin" && platform !== "linux") {
    throw new OwnershipError(
      "unsupported-platform",
      `cortex database ownership needs flock(2) on macOS or Linux (glibc); ${platform} is not supported`,
    );
  }
  if (platform === process.platform && hostSyscalls !== null) return hostSyscalls;
  const abi = platform === "darwin" ? DARWIN : LINUX_GLIBC;
  // Lazy, synchronous load: help/schema and remote-only paths never pay for FFI.
  const ffi: typeof import("bun:ffi") = require("bun:ffi");
  let libc: Libc;
  try {
    libc = bindLibc(ffi, platform);
  } catch (cause) {
    throw new OwnershipError(
      "unsupported-platform",
      `cannot load ${abi.library} for flock(2) (only macOS and Linux/glibc are supported): ${String(cause)}`,
      { cause },
    );
  }
  const errno = (): number => {
    const location = libc.errnoLocation();
    if (location === null) throw new OwnershipError("lock-error", "libc returned no errno location");
    return ffi.read.i32(location);
  };
  const syscalls: OwnershipSyscalls = {
    ewouldblock: abi.ewouldblock,
    cloexecFlag: abi.cloexecFlag,
    flock: (fd, operation) => libc.flock(fd, operation),
    errno,
    isCloseOnExec: fd => {
      const flags = libc.fcntl(fd, F_GETFD);
      if (flags === -1) {
        const code = errno();
        throw new OwnershipError("lock-error", `fcntl(F_GETFD) failed with errno ${code}`, { errno: code });
      }
      return (flags & FD_CLOEXEC) !== 0;
    },
    uid: () => {
      const uid = process.getuid?.();
      if (uid === undefined) throw new OwnershipError("unsupported-platform", "process.getuid() is unavailable");
      return uid;
    },
  };
  if (platform === process.platform) hostSyscalls = syscalls;
  return syscalls;
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * The database's filesystem identity: the realpath of an existing file, or
 * realpath(parent) + basename for a file not created yet. Throws for paths
 * without a stable identity: directories, dangling symlinks (SQLite would
 * create the target, changing the answer), `:memory:`/empty, missing parents
 * and hard-linked files.
 */
export function canonicalDatabasePath(input: string): string {
  if (input === "" || input === ":memory:") {
    throw new OwnershipError(
      "invalid-database-path",
      `database ownership needs a file path, not ${JSON.stringify(input)}`,
    );
  }
  const absolute = path.resolve(input);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(absolute);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
    if (fs.lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new OwnershipError(
        "invalid-database-path",
        `${absolute} is a dangling symbolic link; create its target or point cortex at the real file`,
      );
    }
    canonical = path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
  }
  const st = fs.statSync(canonical, { throwIfNoEntry: false });
  if (st !== undefined) {
    if (!st.isFile()) throw new OwnershipError("invalid-database-path", `${canonical} is not a regular file`);
    if (st.nlink > 1) {
      throw new OwnershipError(
        "hard-linked-database",
        `${canonical} has ${st.nlink} hard links; each link would get its own owner lock. ` +
          "Keep a single link (copy the file instead of hard-linking it)",
      );
    }
  }
  return canonical;
}

function openLockFile(lockPath: string, cloexecFlag: number): number {
  const { O_RDONLY, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  try {
    // Read-only is enough for flock. O_NONBLOCK keeps a FIFO planted at the
    // path from blocking open(); O_NOFOLLOW refuses a symlinked final component.
    return fs.openSync(lockPath, O_RDONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK | cloexecFlag, 0o600);
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ELOOP") {
      throw new OwnershipError("unsafe-lock-file", `refusing ${lockPath}: it is a symbolic link`, { cause: err });
    }
    if (code === "EISDIR") {
      throw new OwnershipError("unsafe-lock-file", `refusing ${lockPath}: not a regular file`, { cause: err });
    }
    throw err;
  }
}

function validateLockFile(lockPath: string, st: fs.Stats, uid: number): void {
  if (!st.isFile()) throw new OwnershipError("unsafe-lock-file", `refusing ${lockPath}: not a regular file`);
  if (st.uid !== uid) {
    throw new OwnershipError("unsafe-lock-file", `refusing ${lockPath}: owned by uid ${st.uid}, not ${uid}`);
  }
  if ((st.mode & 0o077) !== 0) {
    const mode = (st.mode & 0o777).toString(8);
    throw new OwnershipError(
      "unsafe-lock-file",
      `refusing ${lockPath}: mode ${mode} grants group/other access; expected 600 (chmod 600 ${lockPath})`,
    );
  }
}

class FlockLease implements OwnerLease {
  #fd: number | null;
  constructor(
    readonly databasePath: string,
    fd: number,
    private readonly syscalls: OwnershipSyscalls,
  ) {
    this.#fd = fd;
  }

  release(): void {
    const fd = this.#fd;
    if (fd === null) return;
    this.#fd = null;
    try {
      // Explicit unlock first: it frees the lease even if a descriptor for
      // this open file description somehow survived elsewhere.
      this.syscalls.flock(fd, LOCK_UN);
    } finally {
      fs.closeSync(fd);
    }
  }
}

/**
 * Try to become the owner of `databasePath` (canonicalized here). Returns
 * `null` ONLY when another open file description holds the lock
 * (EWOULDBLOCK); throws `OwnershipError` (or the underlying fs error) for
 * everything else. Never creates the database itself, only its sidecar.
 */
export function tryAcquireOwnership(
  databasePath: string,
  syscalls: OwnershipSyscalls = nativeSyscalls(),
): OwnerLease | null {
  const canonical = canonicalDatabasePath(databasePath);
  const lockPath = ownerLockPath(canonical);
  const fd = openLockFile(lockPath, syscalls.cloexecFlag);
  let lease: OwnerLease | null = null;
  try {
    const opened = fs.fstatSync(fd);
    validateLockFile(lockPath, opened, syscalls.uid());
    if (!syscalls.isCloseOnExec(fd)) {
      throw new OwnershipError(
        "lock-error",
        `refusing ${lockPath}: its descriptor is not close-on-exec, so child processes could inherit the lease`,
      );
    }
    if (syscalls.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      const errno = syscalls.errno(); // before close() can clobber it
      if (errno === syscalls.ewouldblock) return null;
      throw new OwnershipError("lock-error", `flock(${lockPath}) failed with errno ${errno}`, { errno });
    }
    const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (current === undefined || current.ino !== opened.ino || current.dev !== opened.dev) {
      throw new OwnershipError(
        "unsafe-lock-file",
        `refusing ${lockPath}: it was removed or replaced while acquiring (owner lock files must never be deleted)`,
      );
    }
    lease = new FlockLease(canonical, fd, syscalls);
    return lease;
  } finally {
    if (lease === null) fs.closeSync(fd);
  }
}
