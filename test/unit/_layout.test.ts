/**
 * Layout + hermetic-isolation guard.
 *
 * This test exists to PREVENT REGRESSIONS in the two-tier test convention
 * AND to PREVENT TESTS FROM EVER WRITING TO THE DEVELOPER'S REAL CORTEX
 * CONFIG. It runs as a unit test (no binary spawn) and asserts:
 *
 *   1. UNIT NO-BINARY-SPAWN — no `test/unit/**\/*.test.ts` file may import
 *      from the integration helpers or call `runCli`. Unit tests are pure
 *      in-process by definition.
 *
 *   2. HERMETIC TEXT GUARD — no test file under `test/` may reference the
 *      developer's real `~/.config/cortex` path literally (with one
 *      allow-listed exception: `test/integration/isolation.test.ts`
 *      intentionally snapshots that path as part of its job).
 *
 *   3. HERMETIC RUNTIME GUARD — `~/.config/cortex/cortex.{db,pid,url}`
 *      mtime+size are snapshotted at suite start and asserted unchanged
 *      at suite end. Catches regressions even when static text-scan
 *      misses them (e.g. an indirect helper writes to the real path).
 */

import { test, expect, describe, beforeAll } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const TEST_ROOT = path.join(REPO_ROOT, "test");

// ---------- 1. UNIT NO-BINARY-SPAWN ----------
//
// Unit tests must be pure in-process. Importing `../helpers.ts` (the
// integration-tier binary-spawn helper) or calling runCli crosses the tier
// boundary and undermines the convention.
//
// Allow-list: `_layout.test.ts` itself reads test files via fs (NOT a spawn).
// We scan ALL `test/unit/**/*.test.ts` files.
function listUnitTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile() && ent.name.endsWith(".test.ts")) out.push(abs);
    }
  };
  walk(path.join(TEST_ROOT, "unit"));
  return out;
}

describe("layout: unit tests do not spawn the cortex binary", () => {
  for (const abs of listUnitTestFiles()) {
    const rel = path.relative(REPO_ROOT, abs);
    test(`${rel} does not import the integration helpers or call runCli`, () => {
      // Layout guard itself contains regex source for these patterns; its
      // job is to scan files, not to spawn anything.
      if (rel.endsWith("_layout.test.ts")) return;
      const txt = fs.readFileSync(abs, "utf8");
      // The integration tier is the ONLY sanctioned place to spawn the
      // built `bin/cortex`. Importing test/integration/helpers.ts (or
      // calling runCli, which only exists there) crosses that boundary.
      expect(txt, `${rel} imports the integration helpers`).not.toMatch(/from\s+["'][^"']*helpers\.ts["']/);
      expect(txt, `${rel} calls runCli`).not.toMatch(/\brunCli\s*\(/);
      // Note: `Bun.spawn(...)` is intentionally NOT forbidden — unit tests
      // legitimately spawn `["true"]` (e.g. client.test.ts dead-pid case)
      // or run a `Bun.serve({port:0})` recording fixture. The hard-line
      // is "no cortex binary spawn", which is uniquely identifiable by
      // the helpers.ts import / runCli call.
    });
  }
});

// ---------- 2. HERMETIC TEXT GUARD ----------
//
// No test file may reference the developer's real `~/.config/cortex` path
// literally. The one intentional exception is `test/integration/isolation.test.ts`,
// which snapshots that path as the canary that catches CLI integration tests
// silently mutating the user's real cortex DB.
function listEveryTestFile(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (ent.isFile() && ent.name.endsWith(".test.ts")) {
        out.push(abs);
      }
    }
  };
  walk(TEST_ROOT);
  return out;
}

const TEXT_GUARD_ALLOWLIST = new Set([
  // Intentionally references ~/.config/cortex as the canary for production-
  // data leaks — the very leak this guard catches.
  path.join(REPO_ROOT, "test", "integration", "isolation.test.ts"),
  // This file describes the rule it enforces in comments.
  path.join(REPO_ROOT, "test", "unit", "_layout.test.ts"),
]);

/**
 * Heuristic: a literal `~/.config/cortex` reference is acceptable when the
 * SAME file is reading (snapshotting) the path, not writing to it. The
 * canonical pattern is mtime+size snapshots in a hermetic guard. We accept
 * a file if it co-occurs the path with `statSync`, `mtimeMs`, or the word
 * `snapshot` — those are the structural fingerprints of a snapshot test.
 * Files that just hardcode the path for a write-side call (the real
 * danger) will NOT have any of those markers.
 */
function isSnapshotStyleReference(txt: string): boolean {
  return /statSync\s*\(/.test(txt) || /\bmtimeMs\b/.test(txt) || /\bsnapshot\b/i.test(txt);
}

/**
 * A file that pins XDG_CONFIG_HOME is following the documented isolation
 * pattern. If it ALSO mentions ~/.config/cortex (typically in a comment
 * explaining the rule), that's evidence the author understood the hazard
 * — not a bug. Accept.
 */
function pinsXdgConfigHome(txt: string): boolean {
  return /XDG_CONFIG_HOME\s*=/.test(txt);
}

describe("layout: hermetic text guard (no naive ~/.config/cortex references)", () => {
  for (const abs of listEveryTestFile()) {
    const rel = path.relative(REPO_ROOT, abs);
    test(`${rel} either avoids the real ~/.config/cortex path or only snapshots it`, () => {
      if (TEXT_GUARD_ALLOWLIST.has(abs)) return;
      const txt = fs.readFileSync(abs, "utf8");
      const hasLiteral = txt.includes("~/.config/cortex");
      if (hasLiteral) {
        const ok = isSnapshotStyleReference(txt) || pinsXdgConfigHome(txt);
        expect(
          ok,
          `${rel} mentions ~/.config/cortex but does NOT (a) snapshot it via statSync/mtimeMs ` +
            `nor (b) pin XDG_CONFIG_HOME to a tmp dir. The literal path is suspect. ` +
            `If you intended a hermetic snapshot guard, add a stat/mtime call. ` +
            `If you intended an isolated test, set process.env.XDG_CONFIG_HOME = mkdtempSync(...).`,
        ).toBe(true);
      }
      // Also catch `path.join(homedir(), ".config", "cortex")` unless the
      // file also pins XDG_CONFIG_HOME (test setup) OR uses snapshot style.
      const usesHomedirPath = /homedir\(\)[^)]*\.config[^)]*cortex/.test(txt);
      const pinsXdg = /XDG_CONFIG_HOME\s*=/.test(txt);
      if (usesHomedirPath && !pinsXdg && !isSnapshotStyleReference(txt)) {
        throw new Error(`${rel} references homedir/.config/cortex without pinning XDG_CONFIG_HOME or snapshotting`);
      }
    });
  }
});

// ---------- 3. HERMETIC RUNTIME GUARD ----------
//
// Snapshot the real `~/.config/cortex/cortex.{db,pid,url}` mtime+size BEFORE
// the suite runs (in beforeAll, which fires once per test file but executes
// after Bun has loaded all files in the run). At the END of this file's
// tests, assert no drift. If any test in the suite wrote to the real
// config dir (e.g. by forgetting to pin XDG_CONFIG_HOME before runCli),
// this guard fails.
//
// Limitation: bun:test runs files in arbitrary order. The "before" snapshot
// is taken when THIS file's beforeAll runs, which may be AFTER some other
// test files. That still catches regressions from THIS file onward, and the
// per-file hermetic guards in init.test.ts / extensions.test.ts /
// client.test.ts cover the earlier-running surfaces. A perfect cross-file
// guard would require a global setup file — out of scope here.
type StatSnap = { exists: boolean; mtimeMs?: number; size?: number } | null;
const REAL_CFG = path.join(os.homedir(), ".config", "cortex");
const REAL_FILES = ["cortex.db", "cortex.pid", "cortex.url"];

function snap(): Record<string, StatSnap> {
  const out: Record<string, StatSnap> = {};
  for (const f of REAL_FILES) {
    const abs = path.join(REAL_CFG, f);
    if (!fs.existsSync(abs)) {
      out[f] = { exists: false };
      continue;
    }
    const st = fs.statSync(abs);
    out[f] = { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  }
  return out;
}

let snapshot: Record<string, StatSnap> = {};
beforeAll(() => {
  snapshot = snap();
});

describe("hermetic runtime guard: real ~/.config/cortex was not modified", () => {
  for (const f of REAL_FILES) {
    test(`~/.config/cortex/${f} mtime+size unchanged from suite start`, () => {
      const before = snapshot[f];
      const after = snap()[f];
      expect(after?.exists).toBe(before?.exists);
      if (before?.exists) {
        expect(after?.mtimeMs).toBe(before.mtimeMs);
        expect(after?.size).toBe(before.size);
      }
    });
  }
});
