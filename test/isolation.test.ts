import { test, expect, describe, afterAll } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runCli, mkTmpEnv } from "./helpers.ts";

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

describe("CLI isolation guard", () => {
  // Snapshot the parent env values up-front so we can restore after the
  // env-scrubbing test pokes them.
  const originalParentEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    CORTEX_DB: process.env.CORTEX_DB,
    CORTEX_SKILL_DIR: process.env.CORTEX_SKILL_DIR,
  };

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
      const tmpDb = env.CORTEX_DB!;
      expect(tmpDb.startsWith(tmpDir)).toBe(true);
      expect(fs.existsSync(tmpDb)).toBe(true);
      expect(fs.statSync(tmpDb).size).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("helper env scrubs inherited XDG_CONFIG_HOME / CORTEX_DB / CORTEX_SKILL_DIR", () => {
    // Poison the parent env BEFORE calling mkTmpEnv. If the helper merely
    // spread + overwrote, an inherited XDG_CONFIG_HOME might persist into
    // the child env (or `??` semantics would let "" win and route to
    // ~/.config/cortex). We assert defense-in-depth.
    process.env.XDG_CONFIG_HOME = "/tmp/poison-xdg";
    process.env.CORTEX_DB = "/tmp/poison-db";
    process.env.CORTEX_SKILL_DIR = "/tmp/poison-skill";

    const { tmpDir, env, cleanup } = mkTmpEnv("scrub");
    try {
      // Each pinned key starts with the freshly-created tmpDir, NOT the
      // poisoned parent values.
      expect(env.XDG_CONFIG_HOME!.startsWith(tmpDir)).toBe(true);
      expect(env.CORTEX_DB!.startsWith(tmpDir)).toBe(true);
      expect(env.CORTEX_SKILL_DIR!.startsWith(tmpDir)).toBe(true);

      // None of the pinned values leak the poisoned values.
      expect(env.XDG_CONFIG_HOME).not.toBe("/tmp/poison-xdg");
      expect(env.CORTEX_DB).not.toBe("/tmp/poison-db");
      expect(env.CORTEX_SKILL_DIR).not.toBe("/tmp/poison-skill");

      // NO_COLOR pinned (matches every other test's expectation).
      expect(env.NO_COLOR).toBe("1");
    } finally {
      cleanup();
    }
  });
});
