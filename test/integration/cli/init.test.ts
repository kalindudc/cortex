import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { runCli, mkTmpEnv } from "../helpers.ts";
import { Store } from "../../../src/store.ts";

// ---------- CLI integration: `cortex init` ----------
//
// `init` is the operation under test, so each test creates its OWN env via
// mkTmpEnv. Sharing a tmp dir across tests would defeat the idempotency
// assertion (we need the second-init test to control whether state already
// exists). See helpers.ts header for why the three env vars MUST be pinned.
//
// Hermetic guards: this file ALSO writes to CORTEX_PI_EXTENSION_DIR (which
// mkTmpEnv does NOT pin by default — see src/extensions.ts:extensionsRoot).
// Each test sets `env.CORTEX_PI_EXTENSION_DIR = path.join(tmpDir, "ext")`
// BEFORE invoking runCli, and a beforeAll/afterAll snapshot pair asserts
// the user's real ~/.config/cortex/cortex.db and
// ~/.pi/agent/extensions/cortex/index.ts mtimes did not move.

// Expected shipped skill names. Hardcoded (not derived from listSkills())
// so the test fails LOUD if a skill is removed without an explicit test
// update.
const EXPECTED_SKILLS = ["cortex", "cortex-planner", "cortex-implementer"] as const;

// Real user-home paths we MUST NOT touch.
const REAL_DB = path.join(os.homedir(), ".config", "cortex", "cortex.db");
const REAL_EXT = path.join(os.homedir(), ".pi", "agent", "extensions", "cortex", "index.ts");

let realDbMtimeBefore: number | null = null;
let realExtMtimeBefore: number | null = null;

function mtimeOrNull(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

beforeAll(() => {
  realDbMtimeBefore = mtimeOrNull(REAL_DB);
  realExtMtimeBefore = mtimeOrNull(REAL_EXT);
});

// Hermetic mtime checks are promoted to explicit test cases (see the
// describe block below) so they show up in the test count and a failure
// is attributable to a named test rather than a generic afterAll throw.
afterAll(() => {});

/**
 * Build a fresh hermetic env for one test, pinning CORTEX_PI_EXTENSION_DIR
 * in addition to the three vars mkTmpEnv handles. Returns the same shape
 * as mkTmpEnv plus an `extRoot` for direct path assertions.
 */
function mkInitEnv(label: string) {
  const base = mkTmpEnv(label);
  const extRoot = path.join(base.tmpDir, "ext");
  base.env.CORTEX_PI_EXTENSION_DIR = extRoot;
  return { ...base, extRoot };
}

describe("cortex init integration", () => {
  test("exits 0 and creates the db with the default 'now' lane", async () => {
    const { env, cleanup } = mkInitEnv("init-db");
    try {
      const r = await runCli({ args: ["init"], env });
      expect(r.code).toBe(0);

      const dbPath = env.CORTEX_DB ?? "";
      expect(dbPath).not.toBe("");
      expect(fs.existsSync(dbPath)).toBe(true);

      const s = Store.open(dbPath);
      const lanes = s.listLanes();
      s.close();
      const laneNames = lanes.map(l => l.name);
      expect(laneNames).toContain("now");
    } finally {
      cleanup();
    }
  });

  test("writes every shipped skill under CORTEX_SKILL_DIR", async () => {
    const { env, cleanup } = mkInitEnv("init-skills");
    try {
      const r = await runCli({ args: ["init"], env });
      expect(r.code).toBe(0);

      const skillRoot = env.CORTEX_SKILL_DIR ?? "";
      expect(skillRoot).not.toBe("");
      for (const name of EXPECTED_SKILLS) {
        const skillFile = path.join(skillRoot, name, "SKILL.md");
        expect(fs.existsSync(skillFile)).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  test("writes the pi extension to CORTEX_PI_EXTENSION_DIR/cortex/index.ts", async () => {
    const { env, extRoot, cleanup } = mkInitEnv("init-ext");
    try {
      const r = await runCli({ args: ["init"], env });
      expect(r.code).toBe(0);

      const extFile = path.join(extRoot, "cortex", "index.ts");
      expect(fs.existsSync(extFile)).toBe(true);
      const stat = fs.statSync(extFile);
      expect(stat.size).toBeGreaterThan(200);
    } finally {
      cleanup();
    }
  });

  test("is idempotent: second init preserves existing rows", async () => {
    const { env, cleanup } = mkInitEnv("init-idem");
    try {
      let r = await runCli({ args: ["init"], env });
      expect(r.code).toBe(0);

      // Insert a task between the two inits. Use the CLI so we exercise
      // the same write path a real user would.
      r = await runCli({ args: ["add", "survives-second-init"], env });
      expect(r.code).toBe(0);

      // Second init.
      r = await runCli({ args: ["init"], env });
      expect(r.code).toBe(0);

      const dbPath = env.CORTEX_DB ?? "";
      expect(dbPath).not.toBe("");
      const s = Store.open(dbPath);
      const tasks = s.listTasks();
      s.close();
      const titles = tasks.map(t => t.title);
      expect(titles).toContain("survives-second-init");
    } finally {
      cleanup();
    }
  });

  // The two tests below MUST run last in this file. Bun runs tests in
  // file order within a describe, so listing them at the end is the
  // ordering contract. They re-read the mtime of the user's real DB /
  // extension file and assert it matches the beforeAll snapshot.
  test("hermetic guard: ~/.config/cortex/cortex.db mtime did not change", () => {
    const after = mtimeOrNull(REAL_DB);
    expect(after).toBe(realDbMtimeBefore);
  });

  test("hermetic guard: ~/.pi/agent/extensions/cortex/index.ts mtime did not change", () => {
    const after = mtimeOrNull(REAL_EXT);
    expect(after).toBe(realExtMtimeBefore);
  });
});
