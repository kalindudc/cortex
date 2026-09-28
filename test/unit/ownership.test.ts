import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalDatabasePath,
  nativeSyscalls,
  OwnershipError,
  type OwnershipSyscalls,
  tryAcquireOwnership,
} from "../../src/ownership.ts";
import { ownerLockPath } from "../../src/paths.ts";

// Unit tier for the ownership lease (plan @400 N2/N3). Everything except the
// "host ABI" block injects the native flock/errno boundary, so contention and
// syscall failures are deterministic. Real multi-process behavior (crash
// release, FD inheritance, cold-start races) lives in
// test/integration/ownership.test.ts.

const LOCK_EX_NB = 2 | 4;
const LOCK_UN = 8;

let dir: string;

beforeEach(() => {
  // realpath: macOS tmpdir is /var/... -> /private/var/..., and every
  // assertion below compares canonical paths.
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ownership-")));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type FlockCall = { fd: number; operation: number };

/** Native syscalls with the flock/errno (and optionally uid/cloexec) boundary replaced. */
function fakeSyscalls(
  behaviour: {
    flock?: (fd: number, operation: number) => number;
    errno?: () => number;
    uid?: () => number;
    isCloseOnExec?: (fd: number) => boolean;
  } = {},
): { sys: OwnershipSyscalls; calls: FlockCall[] } {
  const native = nativeSyscalls();
  const calls: FlockCall[] = [];
  const sys: OwnershipSyscalls = {
    ...native,
    flock: (fd, operation) => {
      calls.push({ fd, operation });
      return behaviour.flock ? behaviour.flock(fd, operation) : 0;
    },
    errno: behaviour.errno ?? (() => 0),
    uid: behaviour.uid ?? native.uid,
    isCloseOnExec: behaviour.isCloseOnExec ?? native.isCloseOnExec,
  };
  return { sys, calls };
}

function isOpen(fd: number): boolean {
  try {
    fs.fstatSync(fd);
    return true;
  } catch {
    return false;
  }
}

function caught(fn: () => unknown): OwnershipError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OwnershipError);
    return err as OwnershipError;
  }
  throw new Error("expected an OwnershipError, nothing was thrown");
}

describe("canonicalDatabasePath", () => {
  test("an existing file (absolute or relative input) resolves to its realpath", () => {
    const db = path.join(dir, "cortex.db");
    fs.writeFileSync(db, "");
    expect(canonicalDatabasePath(db)).toBe(db);
    expect(canonicalDatabasePath(path.relative(process.cwd(), db))).toBe(db);
  });

  test("a symlinked database file canonicalizes to its target", () => {
    const db = path.join(dir, "cortex.db");
    fs.writeFileSync(db, "");
    const link = path.join(dir, "link.db");
    fs.symlinkSync(db, link);
    expect(canonicalDatabasePath(link)).toBe(db);
  });

  test("a not-yet-created file resolves through its REAL parent, without creating it", () => {
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    const alias = path.join(dir, "alias");
    fs.symlinkSync(real, alias);
    expect(canonicalDatabasePath(path.join(alias, "fresh.db"))).toBe(path.join(real, "fresh.db"));
    expect(fs.existsSync(path.join(real, "fresh.db"))).toBe(false);
  });

  test("hard-linked database aliases are rejected (each link would get its own lock)", () => {
    const db = path.join(dir, "cortex.db");
    fs.writeFileSync(db, "");
    const twin = path.join(dir, "twin.db");
    fs.linkSync(db, twin);
    expect(caught(() => canonicalDatabasePath(db)).code).toBe("hard-linked-database");
    expect(caught(() => canonicalDatabasePath(twin)).code).toBe("hard-linked-database");
  });

  test("a dangling symlink is rejected instead of canonicalizing to the link itself", () => {
    const link = path.join(dir, "dangling.db");
    fs.symlinkSync(path.join(dir, "missing-target.db"), link);
    const err = caught(() => canonicalDatabasePath(link));
    expect(err.code).toBe("invalid-database-path");
    expect(err.message).toMatch(/dangling/);
  });

  test("a directory, :memory: or empty path has no database-file identity", () => {
    const sub = path.join(dir, "adir");
    fs.mkdirSync(sub);
    expect(caught(() => canonicalDatabasePath(sub)).code).toBe("invalid-database-path");
    expect(caught(() => canonicalDatabasePath(":memory:")).code).toBe("invalid-database-path");
    expect(caught(() => canonicalDatabasePath("")).code).toBe("invalid-database-path");
  });

  test("a missing parent directory is reported, not guessed", () => {
    expect(() => canonicalDatabasePath(path.join(dir, "nope", "cortex.db"))).toThrow(/ENOENT|no such file/i);
  });
});

describe("tryAcquireOwnership (injected syscalls)", () => {
  test("takes LOCK_EX|LOCK_NB on a 0600 sidecar beside the canonical DB; release unlocks, closes, never unlinks", () => {
    const db = path.join(dir, "cortex.db");
    const { sys, calls } = fakeSyscalls();
    const lease = tryAcquireOwnership(db, sys);
    if (lease === null) throw new Error("expected a lease");
    expect(lease.databasePath).toBe(db);
    expect(calls.length).toBe(1);
    const fd = calls[0].fd;
    expect(calls[0].operation).toBe(LOCK_EX_NB);
    expect(isOpen(fd)).toBe(true);

    const lock = ownerLockPath(db);
    expect(path.dirname(lock)).toBe(dir);
    const st = fs.lstatSync(lock);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    // Acquisition never creates the database itself.
    expect(fs.existsSync(db)).toBe(false);

    lease.release();
    expect(calls[1]).toEqual({ fd, operation: LOCK_UN });
    expect(isOpen(fd)).toBe(false);
    lease.release(); // idempotent
    expect(calls.length).toBe(2);
    expect(fs.lstatSync(lock).ino).toBe(st.ino);
  });

  test("the lease identity is canonical: a symlinked path locks beside the target", () => {
    const db = path.join(dir, "cortex.db");
    fs.writeFileSync(db, "");
    const link = path.join(dir, "link.db");
    fs.symlinkSync(db, link);
    const { sys } = fakeSyscalls();
    const lease = tryAcquireOwnership(link, sys);
    expect(lease?.databasePath).toBe(db);
    expect(fs.existsSync(ownerLockPath(db))).toBe(true);
    expect(fs.existsSync(ownerLockPath(link))).toBe(false);
    lease?.release();
  });

  test("contention (EWOULDBLOCK) returns null; errno is read before the descriptor closes", () => {
    const db = path.join(dir, "cortex.db");
    const native = nativeSyscalls();
    let fdOpenAtErrno: boolean | null = null;
    let lockedFd = -1;
    const { sys } = fakeSyscalls({
      flock: fd => {
        lockedFd = fd;
        return -1;
      },
      errno: () => {
        fdOpenAtErrno = isOpen(lockedFd);
        return native.ewouldblock;
      },
    });
    expect(tryAcquireOwnership(db, sys)).toBeNull();
    expect(fdOpenAtErrno === true).toBe(true);
    expect(isOpen(lockedFd)).toBe(false);
    expect(fs.existsSync(ownerLockPath(db))).toBe(true);
  });

  test("any other flock errno is thrown (never reported as contention) and the descriptor closes", () => {
    const db = path.join(dir, "cortex.db");
    for (const errno of [9, 22, 45, 95]) {
      let lockedFd = -1;
      const { sys } = fakeSyscalls({
        flock: fd => {
          lockedFd = fd;
          return -1;
        },
        errno: () => errno,
      });
      const err = caught(() => tryAcquireOwnership(db, sys));
      expect(err.code).toBe("lock-error");
      expect(err.errno).toBe(errno);
      expect(isOpen(lockedFd)).toBe(false);
    }
  });

  test("a descriptor without close-on-exec is refused before locking", () => {
    const db = path.join(dir, "cortex.db");
    const { sys, calls } = fakeSyscalls({ isCloseOnExec: () => false });
    const err = caught(() => tryAcquireOwnership(db, sys));
    expect(err.code).toBe("lock-error");
    expect(err.message).toMatch(/close-on-exec/);
    expect(calls.length).toBe(0);
  });

  test("a symlinked lock path is refused without following (or creating) its target", () => {
    const db = path.join(dir, "cortex.db");
    const victim = path.join(dir, "victim");
    fs.symlinkSync(victim, ownerLockPath(db));
    const { sys, calls } = fakeSyscalls();
    expect(caught(() => tryAcquireOwnership(db, sys)).code).toBe("unsafe-lock-file");
    expect(fs.existsSync(victim)).toBe(false);
    expect(fs.lstatSync(ownerLockPath(db)).isSymbolicLink()).toBe(true);
    expect(calls.length).toBe(0);
  });

  test("a non-regular lock path (directory, FIFO) is refused without blocking", () => {
    const dirDb = path.join(dir, "dir.db");
    fs.mkdirSync(ownerLockPath(dirDb));
    const fifoDb = path.join(dir, "fifo.db");
    expect(Bun.spawnSync(["mkfifo", ownerLockPath(fifoDb)]).exitCode).toBe(0);
    const { sys, calls } = fakeSyscalls();
    expect(caught(() => tryAcquireOwnership(dirDb, sys)).code).toBe("unsafe-lock-file");
    expect(caught(() => tryAcquireOwnership(fifoDb, sys)).code).toBe("unsafe-lock-file");
    expect(calls.length).toBe(0);
  });

  test("a lock file owned by another uid is refused and left in place", () => {
    const db = path.join(dir, "cortex.db");
    const { sys: real } = fakeSyscalls();
    tryAcquireOwnership(db, real)?.release(); // create a valid sidecar first
    const { sys, calls } = fakeSyscalls({ uid: () => real.uid() + 1 });
    const err = caught(() => tryAcquireOwnership(db, sys));
    expect(err.code).toBe("unsafe-lock-file");
    expect(err.message).toMatch(/uid/);
    expect(calls.length).toBe(0);
    expect(fs.existsSync(ownerLockPath(db))).toBe(true);
  });

  test("a lock file with group/other permissions is refused, not silently repaired", () => {
    const db = path.join(dir, "cortex.db");
    const lock = ownerLockPath(db);
    fs.writeFileSync(lock, "");
    fs.chmodSync(lock, 0o644);
    const { sys, calls } = fakeSyscalls();
    const err = caught(() => tryAcquireOwnership(db, sys));
    expect(err.code).toBe("unsafe-lock-file");
    expect(err.message).toMatch(/644/);
    expect(fs.statSync(lock).mode & 0o777).toBe(0o644);
    expect(calls.length).toBe(0);
  });

  test("an existing private lock file is reused (same inode) across acquisitions", () => {
    const db = path.join(dir, "cortex.db");
    const lock = ownerLockPath(db);
    fs.writeFileSync(lock, "", { mode: 0o600 });
    fs.chmodSync(lock, 0o600);
    const ino = fs.statSync(lock).ino;
    const { sys } = fakeSyscalls();
    for (let i = 0; i < 3; i++) {
      const lease = tryAcquireOwnership(db, sys);
      expect(lease).not.toBeNull();
      lease?.release();
    }
    expect(fs.statSync(lock).ino).toBe(ino);
  });

  test("a lock file replaced while acquiring is refused and the descriptor closes", () => {
    const db = path.join(dir, "cortex.db");
    const lock = ownerLockPath(db);
    let lockedFd = -1;
    const { sys } = fakeSyscalls({
      flock: (fd, operation) => {
        if (operation === LOCK_EX_NB) {
          lockedFd = fd;
          const replacement = `${lock}.new`;
          fs.writeFileSync(replacement, "", { mode: 0o600 });
          fs.renameSync(replacement, lock);
        }
        return 0;
      },
    });
    const err = caught(() => tryAcquireOwnership(db, sys));
    expect(err.code).toBe("unsafe-lock-file");
    expect(err.message).toMatch(/replaced/);
    expect(isOpen(lockedFd)).toBe(false);
  });
});

describe("nativeSyscalls (host ABI)", () => {
  test("platforms without a certified flock ABI fail explicitly", () => {
    for (const platform of ["win32", "freebsd", "openbsd", "sunos", "aix"] as const) {
      expect(caught(() => nativeSyscalls(platform)).code).toBe("unsupported-platform");
    }
  });

  test("EWOULDBLOCK matches the host (35 darwin, 11 linux)", () => {
    expect(nativeSyscalls().ewouldblock).toBe(process.platform === "darwin" ? 35 : 11);
  });

  test("real flock: close-on-exec descriptor, a second open file description is contended, release frees it", () => {
    const db = path.join(dir, "cortex.db");
    const native = nativeSyscalls();
    const fds: number[] = [];
    const spy: OwnershipSyscalls = {
      ...native,
      flock: (fd, operation) => {
        fds.push(fd);
        return native.flock(fd, operation);
      },
    };
    const lease = tryAcquireOwnership(db, spy);
    if (lease === null) throw new Error("expected a lease");
    expect(native.isCloseOnExec(fds[0])).toBe(true);
    // Same process, separate open(2): flock treats them independently.
    expect(tryAcquireOwnership(db)).toBeNull();
    lease.release();
    const again = tryAcquireOwnership(db);
    expect(again?.databasePath).toBe(db);
    again?.release();
  });
});
