import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { configDir, dbPath, pidPath, urlPath, browserUrlPath, ensureConfigDir } from "../../src/paths.ts";
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

  test("pidPath() resolves under configDir()", () => {
    expect(pidPath()).toBe(path.join(tmpDir, "cortex", "cortex.pid"));
    expect(pidPath()).toBe(path.join(configDir(), "cortex.pid"));
  });

  test("urlPath() resolves under configDir()", () => {
    expect(urlPath()).toBe(path.join(tmpDir, "cortex", "cortex.url"));
    expect(urlPath()).toBe(path.join(configDir(), "cortex.url"));
  });

  test("browserUrlPath() resolves under configDir() and is distinct from urlPath()", () => {
    expect(browserUrlPath()).toBe(path.join(tmpDir, "cortex", "cortex.browser-url"));
    expect(browserUrlPath()).toBe(path.join(configDir(), "cortex.browser-url"));
    // Distinct file: CLI uses urlPath() (loopback), browser/`cortex open` uses
    // browserUrlPath() (friendly host). Conflating them would route mutations
    // through DNS that Bun fetch / glibc getaddrinfo cannot resolve.
    expect(browserUrlPath()).not.toBe(urlPath());
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
