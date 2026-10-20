import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkTmpEnv, runCli } from "../helpers.ts";

// `cortex memory streams --author=<tag>`: the tasks one author posted updates
// to (a bb thread's tasks), newest activity first, bodiless, 20 by default.

const THREAD = "thr_2qj8qzdqqr";
const BB = `bb-${THREAD}`;

let env: Record<string, string>;
let bbEnv: Record<string, string>;
let cleanup: () => void;

type Row = Record<string, unknown> & { id: number; lane: string };

const cli = (args: string[], over: Record<string, string> = env) => runCli({ args, env: over });

async function streams(...flags: string[]): Promise<Row[]> {
  const r = await cli(["memory", "streams", "--json", ...flags]);
  if (r.code !== 0) throw new Error(`memory streams exited ${r.code}: ${r.stderr}${r.stdout}`);
  return JSON.parse(r.stdout) as Row[];
}

async function add(title: string, lane: string, over: Record<string, string>, ...extra: string[]): Promise<number> {
  const r = await cli(["add", title, "-l", lane, "-b", "SECRET BODY", "--json", ...extra], over);
  if (r.code !== 0) throw new Error(`add exited ${r.code}: ${r.stderr}${r.stdout}`);
  return (JSON.parse(r.stdout) as { id: number }).id;
}

beforeAll(async () => {
  const tmp = mkTmpEnv("memory-streams");
  env = tmp.env;
  cleanup = tmp.cleanup;
  bbEnv = { ...env, BB_THREAD_ID: THREAD };
  expect((await cli(["init"])).code).toBe(0);
});

afterAll(() => cleanup());

describe("cortex memory streams", () => {
  let first = 0;
  let second = 0;
  let third = 0;

  test("lists exactly the author's tasks across lanes, newest activity first, without bodies", async () => {
    // add's created update is enough to count as touched.
    first = await add("first", "alpha", bbEnv);
    second = await add("second", "beta", bbEnv);
    third = await add("third", "alpha", env, "--as", "planner-7f3a9201");
    await add("near miss", "alpha", env, "--as", `${BB}x`);
    expect((await cli(["update", String(third), "-m", "touched by bb"], bbEnv)).code).toBe(0);
    expect((await cli(["update", String(first), "-m", "latest"], bbEnv)).code).toBe(0);

    const rows = await streams(`--author=${BB}`);
    expect(rows.map(r => r.id)).toEqual([first, third, second]);
    expect(rows.map(r => r.lane)).toEqual(["alpha", "alpha", "beta"]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "activity",
        "id",
        "lane",
        "memory_excluded",
        "status",
        "synced",
        "tags",
        "title",
        "updated",
      ]);
    }
    expect((await streams("--author=planner-7f3a9201")).map(r => r.id)).toEqual([third]);
  });

  test("human output: one line per stream, or an empty state", async () => {
    const r = await cli(["memory", "streams", `--author=${BB}`]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      new RegExp(`^\\[${first}\\] open \u00b7 alpha \u00b7 active \\d{4}-\\d{2}-\\d{2} \u00b7 first$`),
    );
    expect(r.stdout).not.toContain("SECRET BODY");

    const none = await cli(["memory", "streams", "--author=nobody-00000000"]);
    expect(none.code).toBe(0);
    expect(none.stdout.trim()).toBe("(no streams with updates by nobody-00000000)");
  });

  test("defaults to 20 rows, not the primer's 7; --limit=2 caps it", async () => {
    for (let i = 0; i < 20; i++) await add(`bulk ${i}`, "gamma", bbEnv);
    expect(await streams(`--author=${BB}`)).toHaveLength(20);
    expect(await streams(`--author=${BB}`, "--limit=2")).toHaveLength(2);
    expect(await streams(`--author=${BB}`, "--limit=50")).toHaveLength(23);
  });

  test("a missing or blank author and a bad limit exit 1", async () => {
    const missing = await cli(["memory", "streams"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr + missing.stdout).toContain("--author");

    for (const blank of ["--author=", "--author=   "]) {
      const r = await cli(["memory", "streams", blank, "--json"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout).error.message).toBe("--author must not be blank");
    }

    for (const bad of ["--limit=0", "--limit=-3", "--limit=1.5", "--limit=abc"]) {
      const r = await cli(["memory", "streams", `--author=${BB}`, bad, "--json"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout).error.message).toBe("limit must be a positive integer");
    }
  });
});
