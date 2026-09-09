import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { runCli, mkTmpEnv } from "../helpers.ts";

// Hermetic coverage for the scriptable side of `cortex search` (--json).
// The interactive fzf picker needs a TTY, so it is exercised manually; the
// ranking, prefix grammar, and empty-query behavior are all reachable via
// --json and pinned here against the compiled binary.

let testEnv: Record<string, string>;
let cleanup: () => void;
let alphaId: number; // "alpha" in the TITLE, worst priority
let betaId: number; // "alpha" only in the BODY, carries tag `infra`
let gammaId: number; // no "alpha" anywhere, best priority

const run = (...args: string[]) => runCli({ args, env: testEnv });

async function seed(title: string, ...extra: string[]): Promise<number> {
  const r = await run("add", title, ...extra);
  expect(r.code).toBe(0);
  const id = Number(r.stdout.match(/^\[(\d+)\]/)?.[1]);
  expect(id).toBeGreaterThan(0);
  return id;
}

beforeAll(async () => {
  const e = mkTmpEnv("search");
  testEnv = e.env;
  cleanup = e.cleanup;
  expect((await runCli({ args: ["init"], env: testEnv })).code).toBe(0);
  // Priorities are deliberately inverted vs ids so "sorted by id" results
  // cannot be an accident of Store.listTasks' priority ORDER BY.
  alphaId = await seed("alpha api gateway", "-p", "2", "-b", "first task body");
  betaId = await seed("beta worker", "-p", "1", "-b", "mentions alpha in the body", "-t", "infra");
  gammaId = await seed("gamma cleanup", "-p", "0");
});

afterAll(() => cleanup());

async function searchIds(...args: string[]): Promise<number[]> {
  const r = await run("search", ...args, "--json");
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout) as Array<{ id: number }>).map(t => t.id);
}

describe("cortex search --json", () => {
  test("ranks title matches above body matches and omits non-matches", async () => {
    expect(await searchIds("alpha")).toEqual([alphaId, betaId]);
  });

  test("@<id> jumps to the exact task", async () => {
    expect(await searchIds(`@${betaId}`)).toEqual([betaId]);
  });

  test("#tag returns only tasks carrying the tag", async () => {
    expect(await searchIds("#infra")).toEqual([betaId]);
  });

  test("bare search lists every task sorted by id", async () => {
    expect(await searchIds()).toEqual([alphaId, betaId, gammaId]);
  });

  test("no matches emits an empty JSON array", async () => {
    expect(await searchIds("zzz-no-such-task")).toEqual([]);
  });
});
