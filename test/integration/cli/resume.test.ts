/**
 * cortex resume <task-id> — input validation + dispatch arms.
 *
 * Tests use a fake PATH (an empty tmp dir) so neither `pi` nor `fzf` are
 * present. This deliberately exercises:
 *   - the auto-resume path (1-candidate arm) via the `spawn("pi", ...)`
 *     ENOENT handler — asserts exit 1 + "pi not found in PATH" stderr
 *   - the readline picker path (N-candidate arm) — assert candidate rows
 *     are printed, then cancel via empty-line stdin
 *
 * We never assert on actual pi behavior (no real pi binary is invoked).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runCli, mkTmpEnv } from "../helpers.ts";

const PI_AUTHOR_A = "pi-01923f3a-9201-7c0e-b1c8-abcdef012345";
const PI_AUTHOR_B = "pi-01abcdef-1234-7567-89ab-cdef01234567";
// harness=pi but uuid suffix fails UUIDV7_RE (not a v7 — version digit "4"
// instead of "7", and variant nibble "c" outside [89ab]).
const PI_AUTHOR_BAD_UUID = "pi-01abcdef-1234-4567-cdef-cdef01234567";
const LEGACY_AUTHOR_1 = "planner-7f3a9201";
const LEGACY_AUTHOR_2 = "me";

function mkResumeEnv(label: string): {
  tmpDir: string;
  env: Record<string, string>;
  cleanup: () => void;
} {
  const base = mkTmpEnv(label);
  // Replace PATH with an empty tmp dir so neither pi nor fzf are
  // discoverable. The CLI binary itself is invoked by absolute path
  // (helpers.ts BIN), so removing PATH does not break runCli.
  const fakePathDir = fs.mkdtempSync(path.join(os.tmpdir(), `cortex-resume-fakepath-`));
  base.env.PATH = fakePathDir;
  const origCleanup = base.cleanup;
  return {
    tmpDir: base.tmpDir,
    env: base.env,
    cleanup: () => {
      origCleanup();
      fs.rmSync(fakePathDir, { recursive: true, force: true });
    },
  };
}

/**
 * Initialise cortex in a tmp env, add a task in the default 'now' lane,
 * and seed the supplied updates against it. Returns the task id.
 *
 * `seeds` are posted via `cortex update <id> --as <author> -m <summary>`
 * so the test controls the author tag exactly.
 */
async function seedTask(
  env: Record<string, string>,
  seeds: Array<{ author: string; summary: string }>,
): Promise<string> {
  let r = await runCli({ args: ["init"], env });
  expect(r.code).toBe(0);

  r = await runCli({ args: ["add", "test task", "-l", "now"], env });
  expect(r.code).toBe(0);
  const m = r.stdout.match(/^\[(\d+)\]/);
  if (!m?.[1]) throw new Error(`could not parse task id: ${r.stdout}`);
  const id = m[1];

  for (const seed of seeds) {
    r = await runCli({
      args: ["update", id, "--as", seed.author, "-m", seed.summary],
      env,
    });
    expect(r.code).toBe(0);
  }
  return id;
}

describe("cortex resume — input validation", () => {
  let env: Record<string, string>;
  let cleanup: () => void;

  beforeAll(() => {
    const e = mkResumeEnv("resume-validation");
    env = e.env;
    cleanup = e.cleanup;
  });
  afterAll(() => cleanup());

  test("(a) `cortex resume notanint` rejects non-integer input", async () => {
    await runCli({ args: ["init"], env });
    const r = await runCli({ args: ["resume", "notanint"], env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("id must be a positive integer");
  });

  test("(b) `cortex resume 999999` (task missing) reports 404", async () => {
    await runCli({ args: ["init"], env });
    const r = await runCli({ args: ["resume", "999999"], env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("task 999999 not found");
  });

  test("`cortex resume 0` rejects non-positive integer", async () => {
    await runCli({ args: ["init"], env });
    const r = await runCli({ args: ["resume", "0"], env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("id must be a positive integer");
  });
});

describe("cortex resume — dispatch arms", () => {
  test("(c) task with NO updates → no resumable harness sessions", async () => {
    const e = mkResumeEnv("resume-empty");
    try {
      const id = await seedTask(e.env, []);
      const r = await runCli({ args: ["resume", id], env: e.env });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("no resumable harness sessions");
    } finally {
      e.cleanup();
    }
  });

  test("(d) task with only legacy authors → filtered out", async () => {
    const e = mkResumeEnv("resume-legacy");
    try {
      const id = await seedTask(e.env, [
        { author: LEGACY_AUTHOR_1, summary: "planner update" },
        { author: LEGACY_AUTHOR_2, summary: "human note" },
      ]);
      const r = await runCli({ args: ["resume", id], env: e.env });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("no resumable harness sessions");
    } finally {
      e.cleanup();
    }
  });

  test("(e) one valid pi-<uuidv7> author → auto-resume; pi missing → ENOENT exit 1", async () => {
    const e = mkResumeEnv("resume-single");
    try {
      const id = await seedTask(e.env, [{ author: PI_AUTHOR_A, summary: "task 1" }]);
      const r = await runCli({ args: ["resume", id], env: e.env });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`→ resuming ${PI_AUTHOR_A}`);
      expect(r.stderr).toContain("pi not found in PATH");
    } finally {
      e.cleanup();
    }
  });

  test("(f) two distinct pi-<uuidv7> authors, cancel via empty stdin → exit 0 + candidate rows", async () => {
    const e = mkResumeEnv("resume-multi");
    try {
      const id = await seedTask(e.env, [
        { author: PI_AUTHOR_A, summary: "first session update" },
        { author: PI_AUTHOR_B, summary: "second session update" },
      ]);
      const r = await runCli({
        args: ["resume", id],
        env: e.env,
        stdin: "\n",
      });
      expect(r.code).toBe(0);
      // Both candidate rows printed (numbered [1] and [2]).
      expect(r.stderr).toContain("[1]");
      expect(r.stderr).toContain("[2]");
      expect(r.stderr).toContain(PI_AUTHOR_A);
      expect(r.stderr).toContain(PI_AUTHOR_B);
    } finally {
      e.cleanup();
    }
  });

  test("(g) author `pi-not-a-uuid` filtered by UUIDV7_RE → no resumable sessions", async () => {
    const e = mkResumeEnv("resume-bad-uuid");
    try {
      const id = await seedTask(e.env, [{ author: PI_AUTHOR_BAD_UUID, summary: "looks pi-shaped but not v7" }]);
      const r = await runCli({ args: ["resume", id], env: e.env });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("no resumable harness sessions");
    } finally {
      e.cleanup();
    }
  });
});
