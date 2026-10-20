import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  listExtensions,
  extensionsRoot,
  extensionDir,
  extensionsStatus,
  piAgentDir,
  piDetected,
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
const AGENT_DIR_KEY = "PI_CODING_AGENT_DIR";

let tmpDir: string;
let priorEnv: string | undefined;
let priorAgentDir: string | undefined;

beforeEach(() => {
  priorEnv = process.env[ENV_KEY];
  priorAgentDir = process.env[AGENT_DIR_KEY];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ext-test-"));
});

afterEach(() => {
  if (priorEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = priorEnv;
  if (priorAgentDir === undefined) delete process.env[AGENT_DIR_KEY];
  else process.env[AGENT_DIR_KEY] = priorAgentDir;
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
    delete process.env[AGENT_DIR_KEY];
    const root = extensionsRoot();
    // String-only assertion: never touch the fs at this path.
    expect(root.endsWith(path.join(".pi", "agent", "extensions"))).toBe(true);
    expect(root.startsWith(os.homedir())).toBe(true);
  });

  test("extensionDir('pi') = <extensionsRoot>/cortex", () => {
    process.env[ENV_KEY] = tmpDir;
    expect(extensionDir("pi")).toBe(path.join(tmpDir, "cortex"));
  });

  test("extensionsRoot() follows pi's PI_CODING_AGENT_DIR when CORTEX_PI_EXTENSION_DIR is unset", () => {
    delete process.env[ENV_KEY];
    process.env[AGENT_DIR_KEY] = tmpDir;
    expect(extensionsRoot()).toBe(path.join(tmpDir, "extensions"));
  });
});

describe("piAgentDir / piDetected", () => {
  test("piAgentDir honours PI_CODING_AGENT_DIR and expands a leading ~", () => {
    expect(piAgentDir({}, "/home/u")).toBe(path.join("/home/u", ".pi", "agent"));
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "/opt/pi" }, "/home/u")).toBe("/opt/pi");
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/pi-agent" }, "/home/u")).toBe(path.join("/home/u", "pi-agent"));
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "~" }, "/home/u")).toBe("/home/u");
  });

  // Every case injects env, which and home: nothing reads the real machine.
  const none = () => null;

  test("no signal at all (empty env, no pi on PATH, empty home) \u2192 false", () => {
    expect(piDetected({ env: {}, which: none, home: tmpDir })).toBe(false);
  });

  test("an explicit CORTEX_PI_EXTENSION_DIR target \u2192 true", () => {
    expect(piDetected({ env: { [ENV_KEY]: path.join(tmpDir, "ext") }, which: none, home: tmpDir })).toBe(true);
  });

  test("`pi` on PATH \u2192 true", () => {
    expect(piDetected({ env: {}, which: cmd => (cmd === "pi" ? "/bin/pi" : null), home: tmpDir })).toBe(true);
  });

  test("a home containing .pi/agent \u2192 true", () => {
    fs.mkdirSync(path.join(tmpDir, ".pi", "agent"), { recursive: true });
    expect(piDetected({ env: {}, which: none, home: tmpDir })).toBe(true);
  });

  test("PI_CODING_AGENT_DIR naming an existing dir \u2192 true; a missing one \u2192 false", () => {
    const agentDir = path.join(tmpDir, "agent");
    expect(piDetected({ env: { [AGENT_DIR_KEY]: agentDir }, which: none, home: tmpDir })).toBe(false);
    fs.mkdirSync(agentDir);
    expect(piDetected({ env: { [AGENT_DIR_KEY]: agentDir }, which: none, home: tmpDir })).toBe(true);
  });
});

describe("writeExtension / writeAllExtensions — error + path-resolution branches", () => {
  test("writeExtension('not-real') throws /unknown extension/", async () => {
    // Cast through unknown to bypass the ExtensionName union; the runtime
    // guard inside writeExtension is what we're exercising.
    await expect(writeExtension("not-real" as unknown as "pi", tmpDir)).rejects.toThrow(/unknown extension/);
  });

  test("writeAllExtensions() with env set installs index.ts and its memory-view.ts at <env>/cortex/", async () => {
    process.env[ENV_KEY] = tmpDir;
    await writeAllExtensions();
    for (const file of ["index.ts", "memory-view.ts"]) {
      const installed = path.join(tmpDir, "cortex", file);
      expect(fs.existsSync(installed)).toBe(true);
      expect(fs.statSync(installed).size).toBeGreaterThan(200);
    }
    // index.ts imports its sibling by the installed name.
    expect(fs.readFileSync(path.join(tmpDir, "cortex", "index.ts"), "utf8")).toContain('from "./memory-view.ts"');
    expect(fs.readFileSync(path.join(tmpDir, "cortex", "memory-view.ts"), "utf8")).toContain(
      "export class MemoryPanel",
    );
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

describe("extensionsStatus", () => {
  test("missing, installed, then outdated when a file differs", async () => {
    process.env[ENV_KEY] = tmpDir;
    const dir = path.join(tmpDir, "cortex");
    expect(await extensionsStatus()).toEqual([
      { name: "pi", dir, state: "missing", differs: ["index.ts", "memory-view.ts"] },
    ]);
    await writeAllExtensions();
    expect(await extensionsStatus()).toEqual([{ name: "pi", dir, state: "installed", differs: [] }]);
    fs.writeFileSync(path.join(dir, "memory-view.ts"), "// replaced");
    expect(await extensionsStatus()).toEqual([{ name: "pi", dir, state: "outdated", differs: ["memory-view.ts"] }]);
  });
});
