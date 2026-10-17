import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { runCli, mkTmpEnv } from "../helpers.ts";

// Inside a bb thread a valid BB_THREAD_ID is the default author for add and
// update; an explicit --as wins; outside bb (unset or malformed id) add stays
// anonymous and update fails naming --as. Every case sets BB_THREAD_ID itself.

const THREAD = "thr_2qj8qzdqqr";
const BB_AUTHOR = `bb-${THREAD}`;

let baseEnv: Record<string, string>;
let cleanup: () => void;

beforeAll(async () => {
  const e = mkTmpEnv("bb-author");
  baseEnv = e.env;
  cleanup = e.cleanup;
  const r = await runCli({ args: ["init"], env: baseEnv });
  expect(r.code).toBe(0);
});

afterAll(() => cleanup());

function envWith(threadId: string | undefined): Record<string, string> {
  const env = { ...baseEnv };
  if (threadId !== undefined) env.BB_THREAD_ID = threadId;
  return env;
}

async function addTask(env: Record<string, string>, ...extra: string[]): Promise<number> {
  const r = await runCli({ args: ["add", "bb author task", "--json", ...extra], env });
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout) as { id: number }).id;
}

async function authorsOf(id: number): Promise<Array<{ author: string; summary: string }>> {
  const r = await runCli({ args: ["show", String(id), "--json"], env: baseEnv });
  expect(r.code).toBe(0);
  const shown = JSON.parse(r.stdout) as { updates: Array<{ author: string; summary: string }> };
  return shown.updates.map(u => ({ author: u.author, summary: u.summary }));
}

describe("bb thread authors", () => {
  test("mkTmpEnv drops an inherited BB_THREAD_ID and BB_CLI", () => {
    const saved = { id: process.env.BB_THREAD_ID, cli: process.env.BB_CLI };
    process.env.BB_THREAD_ID = THREAD;
    process.env.BB_CLI = "/nonexistent/bb";
    try {
      const e = mkTmpEnv("bb-scrub");
      e.cleanup();
      expect(e.env.BB_THREAD_ID).toBeUndefined();
      expect(e.env.BB_CLI).toBeUndefined();
    } finally {
      if (saved.id === undefined) delete process.env.BB_THREAD_ID;
      else process.env.BB_THREAD_ID = saved.id;
      if (saved.cli === undefined) delete process.env.BB_CLI;
      else process.env.BB_CLI = saved.cli;
    }
  });

  test("a valid thread attributes add's created update and a bare update to bb-<thread id>", async () => {
    const env = envWith(THREAD);
    const id = await addTask(env);
    const r = await runCli({ args: ["update", String(id), "-m", "from bb"], env });
    expect(r.code).toBe(0);
    expect(await authorsOf(id)).toEqual([
      { author: BB_AUTHOR, summary: "created" },
      { author: BB_AUTHOR, summary: "from bb" },
    ]);
  });

  test("an explicit --as wins over the thread on add and update", async () => {
    const env = envWith(THREAD);
    const id = await addTask(env, "--as", "planner-7f3a9201");
    const r = await runCli({ args: ["update", String(id), "-m", "explicit", "--as", "reviewer-1c0ed4a8"], env });
    expect(r.code).toBe(0);
    expect(await authorsOf(id)).toEqual([
      { author: "planner-7f3a9201", summary: "created" },
      { author: "reviewer-1c0ed4a8", summary: "explicit" },
    ]);
  });

  for (const [label, threadId] of [
    ["a malformed thread id", "thr_BAD"],
    ["no thread id", undefined],
  ] as const) {
    test(`${label}: add is anonymous and update fails naming --as`, async () => {
      const env = envWith(threadId);
      const id = await addTask(env);
      expect(await authorsOf(id)).toEqual([]);

      const r = await runCli({ args: ["update", String(id), "-m", "no author"], env });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("error: --as is required outside a bb thread");
      expect(await authorsOf(id)).toEqual([]);
    });
  }

  test("update --json outside bb prints the error envelope naming --as", async () => {
    const env = envWith(undefined);
    const id = await addTask(env);
    const r = await runCli({ args: ["update", String(id), "-m", "no author", "--json"], env });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    expect(out.error.code).toBe("error");
    expect(out.error.message).toBe("--as is required outside a bb thread");
  });
});
