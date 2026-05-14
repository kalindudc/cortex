import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  listExtensions,
  extensionsRoot,
  extensionDir,
  writeExtension,
  writeAllExtensions,
} from "../../src/extensions.ts";

// HERMETIC: every test that triggers a filesystem write or asserts on
// `extensionsRoot()` / `extensionDir()` paths under the user's HOME MUST
// first redirect via CORTEX_PI_EXTENSION_DIR to an mkdtempSync() path,
// then restore the prior env value in finally. This guarantees the
// developer's real `~/.pi/agent/extensions/cortex/` is never touched by
// this suite — a regression in that invariant would silently overwrite
// hand-edits during local `bun test`.

const ENV_KEY = "CORTEX_PI_EXTENSION_DIR";

let tmpDir: string;
let priorEnv: string | undefined;

beforeEach(() => {
  priorEnv = process.env[ENV_KEY];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ext-test-"));
});

afterEach(() => {
  if (priorEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = priorEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("extensions registry — pure API", () => {
  test("listExtensions() returns exactly ['pi']", () => {
    expect(listExtensions()).toEqual(["pi"]);
  });

  test("extensionsRoot() honors CORTEX_PI_EXTENSION_DIR override", () => {
    process.env[ENV_KEY] = tmpDir;
    expect(extensionsRoot()).toBe(tmpDir);
  });

  test("extensionsRoot() falls back to <home>/.pi/agent/extensions when env unset", () => {
    delete process.env[ENV_KEY];
    const root = extensionsRoot();
    // String-only assertion: never touch the fs at this path.
    expect(root.endsWith(path.join(".pi", "agent", "extensions"))).toBe(true);
    expect(root.startsWith(os.homedir())).toBe(true);
  });

  test("extensionDir('pi') = <extensionsRoot>/cortex", () => {
    process.env[ENV_KEY] = tmpDir;
    expect(extensionDir("pi")).toBe(path.join(tmpDir, "cortex"));
  });
});

describe("writeExtension / writeAllExtensions — error + path-resolution branches", () => {
  test("writeExtension('not-real') throws /unknown extension/", async () => {
    // Cast through unknown to bypass the ExtensionName union; the runtime
    // guard inside writeExtension is what we're exercising.
    await expect(writeExtension("not-real" as unknown as "pi", tmpDir)).rejects.toThrow(/unknown extension/);
  });

  test("writeAllExtensions() with env set installs files at <env>/cortex/index.ts", async () => {
    process.env[ENV_KEY] = tmpDir;
    await writeAllExtensions();
    const indexTs = path.join(tmpDir, "cortex", "index.ts");
    expect(fs.existsSync(indexTs)).toBe(true);
    expect(fs.statSync(indexTs).size).toBeGreaterThan(200);
  });

  test("writeExtension('pi') with explicit targetDir overrides env (writes only to explicit dir)", async () => {
    // Set env to a SEPARATE tmp dir; pass an explicit target. The explicit
    // target must win, and the env path must remain empty.
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ext-env-"));
    const explicitDir = path.join(tmpDir, "explicit");
    try {
      process.env[ENV_KEY] = envDir;
      await writeExtension("pi", explicitDir);
      // Explicit dir got the file.
      expect(fs.existsSync(path.join(explicitDir, "index.ts"))).toBe(true);
      // Env dir was NOT touched (no `cortex/` subdir created under it).
      expect(fs.existsSync(path.join(envDir, "cortex"))).toBe(false);
    } finally {
      fs.rmSync(envDir, { recursive: true, force: true });
    }
  });
});
