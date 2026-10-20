import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as paths from "../../src/paths.ts";
import {
  configDir,
  dbPath,
  ensureConfigDir,
  runtimeDir,
  ensureRuntimeDir,
  daemonSocketPath,
  daemonMetadataPath,
  ownerLockPath,
  MAX_SOCKET_PATH_BYTES,
} from "../../src/paths.ts";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Snapshot env keys we may mutate so we can restore after each test.
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_CORTEX_DB = process.env.CORTEX_DB;

describe("paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    // Always start each test with a fresh tmp dir pinned as XDG_CONFIG_HOME
    // so nothing in the test suite can ever touch the developer's real
    // ~/.config/cortex.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-paths-test-"));
    process.env.XDG_CONFIG_HOME = tmpDir;
    delete process.env.CORTEX_DB;
  });

  afterEach(() => {
    // Restore env first.
    if (ORIGINAL_XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_XDG_CONFIG_HOME;
    }
    if (ORIGINAL_CORTEX_DB === undefined) {
      delete process.env.CORTEX_DB;
    } else {
      process.env.CORTEX_DB = ORIGINAL_CORTEX_DB;
    }
    // Clean up tmp dir.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("configDir() honors XDG_CONFIG_HOME", () => {
    expect(configDir()).toBe(path.join(tmpDir, "cortex"));
  });

  test("configDir() falls back to ~/.config when XDG_CONFIG_HOME is unset (string-only assertion, no fs op)", () => {
    // IMPORTANT: do NOT call ensureConfigDir() here -- that would create the
    // developer's real ~/.config/cortex directory. We only inspect the
    // returned string.
    const previousXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const result = configDir();
      expect(result.endsWith(path.join(".config", "cortex"))).toBe(true);
      expect(result).toBe(path.join(os.homedir(), ".config", "cortex"));
    } finally {
      // Restore so subsequent assertions in this test (if any) and afterEach
      // both see a consistent state. afterEach also handles full restore.
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
    }
  });

  test("dbPath() honors CORTEX_DB override", () => {
    const override = path.join(tmpDir, "custom-location", "my.db");
    process.env.CORTEX_DB = override;
    expect(dbPath()).toBe(override);
  });

  test("dbPath() defaults to <configDir>/cortex.db when CORTEX_DB is unset", () => {
    expect(process.env.CORTEX_DB).toBeUndefined();
    expect(dbPath()).toBe(path.join(tmpDir, "cortex", "cortex.db"));
  });

  test("dbPath() prefers CORTEX_DB even when XDG_CONFIG_HOME is also set", () => {
    const override = path.join(tmpDir, "explicit.db");
    process.env.CORTEX_DB = override;
    expect(dbPath()).toBe(override);
    expect(dbPath()).not.toBe(path.join(configDir(), "cortex.db"));
  });

  test("the pid-file daemon helpers are gone: nothing reads a pid to signal or route (plan @400 N4-N6)", () => {
    for (const name of ["readPid", "isAlive", "stopDaemonIfRunning"]) expect(name in paths).toBe(false);
  });

  test("ensureConfigDir() creates the directory (XDG pinned to tmp)", () => {
    const expected = path.join(tmpDir, "cortex");
    expect(fs.existsSync(expected)).toBe(false);
    ensureConfigDir();
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.statSync(expected).isDirectory()).toBe(true);
  });

  test("ensureConfigDir() is idempotent (calling twice does not throw)", () => {
    const expected = path.join(tmpDir, "cortex");
    ensureConfigDir();
    expect(() => ensureConfigDir()).not.toThrow();
    expect(fs.existsSync(expected)).toBe(true);
  });

  test("ensureConfigDir() creates nested XDG paths recursively", () => {
    const nested = path.join(tmpDir, "deeply", "nested", "xdg");
    process.env.XDG_CONFIG_HOME = nested;
    const expected = path.join(nested, "cortex");
    expect(fs.existsSync(expected)).toBe(false);
    ensureConfigDir();
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.statSync(expected).isDirectory()).toBe(true);
  });
});

// Owned runtime/socket/metadata/lock locations (plan @400 N4). The runtime dir
// is XDG_RUNTIME_DIR only when it is a real 0700 directory owned by this user;
// otherwise it is a private per-user directory under os.tmpdir(). TMPDIR is
// pinned to a fresh tmp dir so the fallback never lands in the real tmpdir.
describe("paths: runtime dir, daemon socket, metadata and owner lock", () => {
  const saved = {
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    TMPDIR: process.env.TMPDIR,
    CORTEX_DB: process.env.CORTEX_DB,
  };
  const uid = process.getuid?.() ?? -1;
  let root: string;
  let fallback: string;

  const privateDir = (name: string): string => {
    const p = path.join(root, name);
    fs.mkdirSync(p);
    fs.chmodSync(p, 0o700);
    return p;
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cxp-")));
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(tmp);
    process.env.TMPDIR = tmp;
    delete process.env.XDG_RUNTIME_DIR;
    fallback = path.join(tmp, `cortex-${uid}`);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("runtimeDir() uses XDG_RUNTIME_DIR when it is a 0700 directory owned by the user", () => {
    const xdg = privateDir("xdg");
    process.env.XDG_RUNTIME_DIR = xdg;
    expect(runtimeDir()).toBe(xdg);
    expect(ensureRuntimeDir()).toBe(xdg);
    expect(fs.existsSync(fallback)).toBe(false);
  });

  test("runtimeDir() falls back to <tmpdir>/cortex-<uid> for an unset, relative, missing, non-private, symlinked or non-directory XDG_RUNTIME_DIR", () => {
    const open = path.join(root, "open");
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o755);
    const link = path.join(root, "link");
    fs.symlinkSync(privateDir("target"), link);
    const file = path.join(root, "file");
    fs.writeFileSync(file, "");
    fs.chmodSync(file, 0o700);
    const candidates: (string | undefined)[] = [
      undefined,
      "",
      "relative/run",
      path.join(root, "missing"),
      open,
      link,
      file,
      path.join(file, "child"),
    ];
    for (const value of candidates) {
      if (value === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = value;
      expect(runtimeDir()).toBe(fallback);
    }
    // A pure lookup: nothing is created until ensureRuntimeDir().
    expect(fs.existsSync(fallback)).toBe(false);
  });

  test("ensureRuntimeDir() creates the fallback as a private 0700 directory and is idempotent", () => {
    expect(ensureRuntimeDir()).toBe(fallback);
    const st = fs.lstatSync(fallback);
    expect(st.isDirectory()).toBe(true);
    expect(st.uid).toBe(uid);
    expect(st.mode & 0o777).toBe(0o700);
    expect(ensureRuntimeDir()).toBe(fallback);
  });

  test("ensureRuntimeDir() refuses a pre-existing fallback that is not private (mode, symlink)", () => {
    fs.mkdirSync(fallback);
    fs.chmodSync(fallback, 0o755);
    expect(() => ensureRuntimeDir()).toThrow(/unsafe cortex runtime directory/);
    expect(fs.statSync(fallback).mode & 0o777).toBe(0o755);
    fs.rmdirSync(fallback);
    fs.symlinkSync(privateDir("elsewhere"), fallback);
    expect(() => ensureRuntimeDir()).toThrow(/unsafe cortex runtime directory/);
  });

  test("daemonSocketPath() is a short hashed name in the runtime dir, stable per database and distinct across databases", () => {
    const xdg = privateDir("run");
    process.env.XDG_RUNTIME_DIR = xdg;
    const a = daemonSocketPath("/data/a/cortex.db");
    const b = daemonSocketPath("/data/b/cortex.db");
    expect(path.dirname(a)).toBe(xdg);
    expect(path.basename(a)).toMatch(/^cortex-[0-9a-f]{16}\.sock$/);
    expect(a).not.toBe(b);
    expect(daemonSocketPath("/data/a/cortex.db")).toBe(a);
    // Independent of the database path length.
    const deep = daemonSocketPath(`/${"d".repeat(400)}/cortex.db`);
    expect(Buffer.byteLength(deep)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    expect(path.basename(deep).length).toBe(path.basename(a).length);
  });

  test("daemonSocketPath() refuses a runtime dir that would overflow the AF_UNIX path limit", () => {
    const xdg = privateDir("r".repeat(110));
    process.env.XDG_RUNTIME_DIR = xdg;
    expect(runtimeDir()).toBe(xdg);
    expect(() => daemonSocketPath("/data/cortex.db")).toThrow(/AF_UNIX/);
  });

  test("owner lock and daemon metadata sit beside the canonical DB, distinct from the SQLite files", () => {
    const db = "/data/cortex.db";
    const lock = ownerLockPath(db);
    const meta = daemonMetadataPath(db);
    expect(path.dirname(lock)).toBe("/data");
    expect(path.dirname(meta)).toBe("/data");
    const others = [db, `${db}-wal`, `${db}-shm`, `${db}-journal`];
    for (const p of [lock, meta]) expect(others).not.toContain(p);
    expect(lock).not.toBe(meta);
  });

  test("the runtime helpers do not move the existing database path", () => {
    process.env.XDG_RUNTIME_DIR = privateDir("xdg");
    delete process.env.CORTEX_DB;
    expect(dbPath()).toBe(path.join(configDir(), "cortex.db"));
  });
});
