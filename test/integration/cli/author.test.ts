import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { Store } from "../../../src/store.ts";
import { runCli, mkTmpEnv } from "../helpers.ts";

// ---------- CLI integration: --as is REQUIRED ----------
//
// citty's `required: true` rejects missing values at parse time. The CLI
// must exit non-zero with an error mentioning the flag (so agents can grep
// their own stderr to discover the requirement).

let testEnv: Record<string, string>;
let dbPath: string;
let cleanup: () => void;

beforeAll(() => {
  const e = mkTmpEnv("author");
  testEnv = e.env;
  if (!e.env.CORTEX_DB) throw new Error("CORTEX_DB env var unset");
  dbPath = e.env.CORTEX_DB;
  cleanup = e.cleanup;
});

afterAll(() => cleanup());

const run = (...args: string[]) => runCli({ args, env: testEnv });

describe("cortex update --as integration", () => {
  test("missing --as exits non-zero with an error mentioning the flag", async () => {
    let r = await run("init");
    expect(r.code).toBe(0);
    r = await run("add", "test task");
    expect(r.code).toBe(0);

    // Forget --as on purpose. citty should reject.
    r = await run("update", "1", "-m", "x");
    expect(r.code).not.toBe(0);
    // Either citty's own message or our explicit error: must mention `as`
    // or `author` (so agents can grep their stderr to discover the flag).
    const combined = (r.stderr + r.stdout).toLowerCase();
    expect(combined).toMatch(/as|author/);
  });

  test("--as <id> stores the row attributed to that id", async () => {
    // Fresh DB for this assertion.
    fs.rmSync(dbPath, { force: true });
    let r = await run("init");
    expect(r.code).toBe(0);
    r = await run("add", "attribution task");
    expect(r.code).toBe(0);

    r = await run("update", "1", "-m", "hello", "--as", "planner-abc");
    expect(r.code).toBe(0);

    // Read back via Store directly (no daemon).
    const s = Store.open(dbPath);
    const rows = s.listUpdates(1);
    s.close();
    // Exactly one row (no status change → no audit-trail row).
    expect(rows.length).toBe(1);
    expect(rows[0]?.author).toBe("planner-abc");
    expect(rows[0]?.summary).toBe("hello");
  });
});
