import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { runCli, mkTmpEnv } from "../helpers.ts";

// ---------- CLI integration: `cortex rm` ----------
//
// Covers the y/N confirmation prompt (commands/rm.ts:6-14, :42-48) and
// the --force bypass. Each test gets a freshly added task whose id is
// captured from `add`'s stdout (`[<id>] <title>` per add.ts:103).
//
// Hermetic via mkTmpEnv (helpers.ts) so XDG_CONFIG_HOME / CORTEX_DB /
// CORTEX_SKILL_DIR all point at a tmp dir -- the daemon-routing escape
// hatch in client.ts:21 is closed and mutations land in the tmp DB only.

let testEnv: Record<string, string>;
let cleanup: () => void;

beforeAll(async () => {
  const e = mkTmpEnv("rm");
  testEnv = e.env;
  cleanup = e.cleanup;
  const r = await runCli({ args: ["init"], env: testEnv });
  expect(r.code).toBe(0);
});

afterAll(() => cleanup());

let currentId: number;

beforeEach(async () => {
  const r = await runCli({ args: ["add", "task to delete"], env: testEnv });
  expect(r.code).toBe(0);
  const m = r.stdout.match(/^\[(\d+)\]/);
  if (!m?.[1]) throw new Error(`could not parse task id from add stdout: ${JSON.stringify(r.stdout)}`);
  currentId = Number.parseInt(m[1], 10);
});

describe("cortex rm", () => {
  test("empty answer (newline only) → aborted, task survives", async () => {
    const r = await runCli({ args: ["rm", String(currentId)], env: testEnv, stdin: "\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/aborted/);

    // Task must still exist.
    const s = await runCli({ args: ["show", String(currentId), "--json"], env: testEnv });
    expect(s.code).toBe(0);
  });

  test("'n\\n' → aborted, task survives", async () => {
    const r = await runCli({ args: ["rm", String(currentId)], env: testEnv, stdin: "n\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/aborted/);

    const s = await runCli({ args: ["show", String(currentId), "--json"], env: testEnv });
    expect(s.code).toBe(0);
  });

  test("'y\\n' → task removed", async () => {
    const r = await runCli({ args: ["rm", String(currentId)], env: testEnv, stdin: "y\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/removed task/);

    // Task should now be gone.
    const s = await runCli({ args: ["show", String(currentId), "--json"], env: testEnv });
    expect(s.code).not.toBe(0);
  });

  test("' Y \\n' → trim + toLowerCase still matches → task removed", async () => {
    const r = await runCli({ args: ["rm", String(currentId)], env: testEnv, stdin: " Y \n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/removed task/);

    const s = await runCli({ args: ["show", String(currentId), "--json"], env: testEnv });
    expect(s.code).not.toBe(0);
  });

  test("--force skips the prompt and removes", async () => {
    // No stdin supplied at all -- if the prompt fired, the process would
    // hang or read from inherited stdin. Force MUST short-circuit it.
    const r = await runCli({ args: ["rm", String(currentId), "--force"], env: testEnv });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/removed task/);

    const s = await runCli({ args: ["show", String(currentId), "--json"], env: testEnv });
    expect(s.code).not.toBe(0);
  });

  test("non-numeric id → exit 1 with 'must be a number'", async () => {
    const r = await runCli({ args: ["rm", "notanint", "-f"], env: testEnv });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/must be a number/);
  });

  test("unknown id → exit 1 with not-found error", async () => {
    const r = await runCli({ args: ["rm", "9999", "-f"], env: testEnv });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not found/);
  });
});
