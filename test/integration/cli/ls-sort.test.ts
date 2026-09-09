import { test, expect, beforeAll, afterAll } from "bun:test";
import { runCli, mkTmpEnv } from "../helpers.ts";

// `cortex ls` sorts by task id (ascending) by default. Seed priorities are
// inverted vs creation order so the old priority-first ordering would fail
// these assertions — the id sort must be deliberate, not incidental.

let testEnv: Record<string, string>;
let cleanup: () => void;
const ids: number[] = [];

const run = (...args: string[]) => runCli({ args, env: testEnv });

beforeAll(async () => {
  const e = mkTmpEnv("ls-sort");
  testEnv = e.env;
  cleanup = e.cleanup;
  expect((await runCli({ args: ["init"], env: testEnv })).code).toBe(0);
  const seeds: string[][] = [
    ["first task", "-p", "2"],
    ["second task", "-p", "1"],
    ["third task", "-p", "0"],
    ["later-lane task", "-p", "0", "-l", "later"],
  ];
  for (const args of seeds) {
    const r = await run("add", ...args);
    expect(r.code).toBe(0);
    const id = Number(r.stdout.match(/^\[(\d+)\]/)?.[1]);
    expect(id).toBeGreaterThan(0);
    ids.push(id);
  }
});

afterAll(() => cleanup());

test("ls --json emits tasks sorted by id ascending", async () => {
  const r = await run("ls", "--json");
  expect(r.code).toBe(0);
  const got = (JSON.parse(r.stdout) as Array<{ id: number }>).map(t => t.id);
  expect(got).toEqual([...ids].sort((a, b) => a - b));
});

test("ls text view lists ids ascending within each lane group", async () => {
  const r = await run("ls");
  expect(r.code).toBe(0);
  // NO_COLOR is pinned by mkTmpEnv, so rows are plain `  [id] ○ title`.
  const seen = [...r.stdout.matchAll(/^ {2}\[(\d+)\]/gm)].map(m => Number(m[1]));
  expect(seen).toEqual([...ids].sort((a, b) => a - b));
  // Lane grouping is preserved: both lane headers still render.
  expect(r.stdout).toContain("\nnow");
  expect(r.stdout).toContain("\nlater");
});

test("ls --status filter still id-sorts the filtered rows", async () => {
  const r = await run("ls", "--status", "open", "--json");
  expect(r.code).toBe(0);
  const got = (JSON.parse(r.stdout) as Array<{ id: number }>).map(t => t.id);
  expect(got).toEqual([...ids].sort((a, b) => a - b));
});
