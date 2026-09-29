import { test, expect, describe, afterAll } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runCli, mkTmpEnv } from "./helpers.ts";
import { daemonSocketPath, runtimeDir } from "../../src/paths.ts";

// Plan 15 isolation guard.
//
// The single contract that, if broken, has caught the regression where
// CLI integration tests silently mutate the user's real cortex DB:
// a helper-driven `cortex add` (or any write command) MUST NOT touch
// ~/.config/cortex/cortex.db. Snapshot mtime + size before, run the
// command via the helper, assert unchanged after.

// Mirror paths.ts:9-12 without importing it: paths.ts reads
// process.env.XDG_CONFIG_HOME, but here we want the REAL on-disk path
// the user's daemon would use, regardless of whether tests have already
// poisoned env. So compute it from $HOME directly.
const REAL_CONFIG_DIR = path.join(os.homedir(), ".config", "cortex");
const REAL_DB = path.join(REAL_CONFIG_DIR, "cortex.db");

// The five paths every spawned cortex MUST see pinned (plan @400 N24).
// Hardcoded, NOT imported from helpers.ts: dropping a key from the helper
// must fail this guard rather than silently shrink it.
const PINNED_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "CORTEX_DB",
  "CORTEX_SKILL_DIR",
  "CORTEX_PI_EXTENSION_DIR",
] as const;
const POISON: Record<(typeof PINNED_KEYS)[number], string> = {
  XDG_CONFIG_HOME: "/tmp/poison-xdg",
  XDG_RUNTIME_DIR: "/tmp/poison-runtime",
  CORTEX_DB: "/tmp/poison-db",
  CORTEX_SKILL_DIR: "/tmp/poison-skill",
  CORTEX_PI_EXTENSION_DIR: "/tmp/poison-ext",
};

describe("CLI isolation guard", () => {
  // Snapshot the parent env values up-front so we can restore after the
  // env-scrubbing test pokes them.
  const originalParentEnv = Object.fromEntries(PINNED_KEYS.map(k => [k, process.env[k]]));

  afterAll(() => {
    for (const [k, v] of Object.entries(originalParentEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("spawning cortex add via the helper does not touch ~/.config/cortex/cortex.db", async () => {
    // Pre-snapshot. If the user has never run the daemon on this machine,
    // there's no file to mutate -- still a passing scenario, just log it.
    let beforeMtime: number | null = null;
    let beforeSize: number | null = null;
    if (fs.existsSync(REAL_DB)) {
      const st = fs.statSync(REAL_DB);
      beforeMtime = st.mtimeMs;
      beforeSize = st.size;
    } else {
      console.log(`[isolation guard] no real DB at ${REAL_DB} -- clean state, snapshot skipped`);
    }

    const { tmpDir, env, cleanup } = mkTmpEnv("isolation-guard");
    try {
      let r = await runCli({ args: ["init"], env });
      expect(r.code).toBe(0);
      r = await runCli({ args: ["agents", "install"], env });
      expect(r.code).toBe(0);
      r = await runCli({ args: ["add", "guard-task"], env });
      expect(r.code).toBe(0);

      // Real DB unchanged (or still absent if it was absent before).
      if (beforeMtime !== null && beforeSize !== null) {
        expect(fs.existsSync(REAL_DB)).toBe(true);
        const after = fs.statSync(REAL_DB);
        expect(after.mtimeMs).toBe(beforeMtime);
        expect(after.size).toBe(beforeSize);
      } else {
        expect(fs.existsSync(REAL_DB)).toBe(false);
      }

      // tmpDir's DB exists and is non-empty (the writes landed where we asked).
      if (!env.CORTEX_DB) throw new Error("CORTEX_DB env var unset");
      const tmpDb = env.CORTEX_DB;
      expect(tmpDb.startsWith(tmpDir)).toBe(true);
      expect(fs.existsSync(tmpDb)).toBe(true);
      expect(fs.statSync(tmpDb).size).toBeGreaterThan(0);

      // `agents install` landed in the pinned dirs too: the pi extension
      // (unpinned before Task 3 of plan @400) and the skills.
      const extRoot = env.CORTEX_PI_EXTENSION_DIR ?? "";
      const skillRoot = env.CORTEX_SKILL_DIR ?? "";
      expect(extRoot.startsWith(tmpDir)).toBe(true);
      expect(skillRoot.startsWith(tmpDir)).toBe(true);
      expect(fs.existsSync(path.join(extRoot, "cortex", "index.ts"))).toBe(true);
      expect(fs.existsSync(path.join(skillRoot, "cortex", "SKILL.md"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("helper env scrubs and re-pins all five isolation paths", () => {
    // Poison the parent env BEFORE calling mkTmpEnv. If the helper merely
    // spread + overwrote, an inherited value might persist into the child
    // env (or `??` semantics would let "" win and route to the real
    // config/runtime/skill/extension dirs). We assert defense-in-depth.
    for (const key of PINNED_KEYS) process.env[key] = POISON[key];

    const { tmpDir, runtimeDir: runtime, env, cleanup } = mkTmpEnv("scrub");
    try {
      for (const key of PINNED_KEYS) {
        expect(env[key], `${key} must be pinned`).toBeTruthy();
        expect(env[key], `${key} leaked the inherited value`).not.toBe(POISON[key]);
      }
      // Config/DB/skill/extension paths live under the fresh tmpDir ...
      for (const key of ["XDG_CONFIG_HOME", "CORTEX_DB", "CORTEX_SKILL_DIR", "CORTEX_PI_EXTENSION_DIR"] as const) {
        expect(env[key]?.startsWith(tmpDir), `${key} is not under ${tmpDir}`).toBe(true);
      }
      // ... and the runtime dir is its own fresh, private, SHORT directory.
      expect(env.XDG_RUNTIME_DIR).toBe(runtime);
      const st = fs.lstatSync(runtime);
      expect(st.isDirectory()).toBe(true);
      expect(st.uid).toBe(process.getuid?.() ?? -1);
      expect(st.mode & 0o777).toBe(0o700);

      // src/paths.ts accepts it as XDG_RUNTIME_DIR (no fallback) and a
      // daemon socket inside it fits the AF_UNIX limit.
      const previous = process.env.XDG_RUNTIME_DIR;
      process.env.XDG_RUNTIME_DIR = runtime;
      try {
        expect(runtimeDir()).toBe(runtime);
        expect(path.dirname(daemonSocketPath(path.join(tmpDir, "cortex.db")))).toBe(runtime);
      } finally {
        process.env.XDG_RUNTIME_DIR = previous;
      }

      // NO_COLOR pinned (matches every other test's expectation).
      expect(env.NO_COLOR).toBe("1");
    } finally {
      cleanup();
    }
    expect(fs.existsSync(tmpDir)).toBe(false);
    expect(fs.existsSync(runtime)).toBe(false);
  });
});
