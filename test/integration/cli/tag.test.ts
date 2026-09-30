import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { runCli, mkTmpEnv } from "../helpers.ts";

// Hermetic CLI integration coverage for `cortex tag {add, ls, edit}`.
// The sibling test/integration/cli.test.ts already covers `tag rm` (in-use
// refusal + -f override), so this file deliberately omits rm to avoid
// duplicate coverage. Tag names are unique per test so a single shared
// tmp DB can host every case without inter-test ordering hazards.

let testEnv: Record<string, string>;
let cleanup: () => void;

beforeAll(async () => {
  const e = mkTmpEnv("tag");
  testEnv = e.env;
  cleanup = e.cleanup;
  const r = await runCli({ args: ["init"], env: testEnv });
  expect(r.code).toBe(0);
});

afterAll(() => cleanup());

const run = (...args: string[]) => runCli({ args, env: testEnv });

describe("tag add", () => {
  test("creates a tag with no color", async () => {
    const r = await run("tag", "add", "plain");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("plain");

    const ls = await run("tag", "ls", "--json");
    expect(ls.code).toBe(0);
    const tags = JSON.parse(ls.stdout) as Array<{ name: string; color: string | null }>;
    const hit = tags.find(t => t.name === "plain");
    if (!hit) throw new Error("expected tag 'plain' to be present after add");
    expect(hit.color).toBeNull();
  });

  test("creates a tag with -c #hex", async () => {
    const r = await run("tag", "add", "colored", "-c", "#abc123");
    expect(r.code).toBe(0);

    const ls = await run("tag", "ls", "--json");
    const tags = JSON.parse(ls.stdout) as Array<{ name: string; color: string | null }>;
    const hit = tags.find(t => t.name === "colored");
    if (!hit) throw new Error("expected tag 'colored' to be present after add");
    expect(hit.color).toBe("#abc123");
  });

  test("duplicate name fails (UNIQUE constraint surfaces non-zero exit)", async () => {
    let r = await run("tag", "add", "dupe");
    expect(r.code).toBe(0);
    r = await run("tag", "add", "dupe");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/error/i);
  });

  test("rejects invalid characters via validateTagName", async () => {
    const r = await run("tag", "add", "BAD!");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid tag name/);
  });

  test("rejects empty name", async () => {
    const r = await run("tag", "add", "");
    // citty may treat empty positional as missing-required (its own non-zero
    // exit + usage text on stderr) or pass it through to validateTagName,
    // which throws and exits 1. Either path is a real failure -- we only
    // require non-zero.
    expect(r.code).not.toBe(0);
  });
});

describe("tag ls", () => {
  test("--json returns an array of objects with at least {name, color}", async () => {
    await run("tag", "add", "ls-json-a");
    await run("tag", "add", "ls-json-b", "-c", "#ffffff");

    const r = await run("tag", "ls", "--json");
    expect(r.code).toBe(0);
    const tags = JSON.parse(r.stdout) as Array<{ name: string; color: string | null }>;
    expect(Array.isArray(tags)).toBe(true);
    for (const t of tags) {
      expect(typeof t.name).toBe("string");
      // color is nullable but the key MUST exist for clients rendering it.
      expect(t).toHaveProperty("color");
    }
    const names = tags.map(t => t.name);
    expect(names).toContain("ls-json-a");
    expect(names).toContain("ls-json-b");
  });

  test("default (no --json) prints all tag names to stdout", async () => {
    await run("tag", "add", "ls-default-x");
    await run("tag", "add", "ls-default-y");

    const r = await run("tag", "ls");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ls-default-x");
    expect(r.stdout).toContain("ls-default-y");
  });
});

describe("tag edit", () => {
  test("--rename succeeds and cascades to existing tasks via FK", async () => {
    await run("tag", "add", "old-name");
    const add = await run("add", "task-with-tag", "-t", "old-name");
    expect(add.code).toBe(0);
    const id = Number(add.stdout.match(/^\[(\d+)\]/)?.[1]);
    expect(id).toBeGreaterThan(0);

    const rn = await run("tag", "edit", "old-name", "--rename", "new-name");
    expect(rn.code).toBe(0);

    const show = await run("show", String(id), "--json");
    expect(show.code).toBe(0);
    const parsed = JSON.parse(show.stdout) as { task: { tags: string[] } };
    expect(parsed.task.tags).toContain("new-name");
    expect(parsed.task.tags).not.toContain("old-name");
  });

  test("-c updates color", async () => {
    await run("tag", "add", "recolor", "-c", "#000000");
    const r = await run("tag", "edit", "recolor", "-c", "#ffffff");
    expect(r.code).toBe(0);

    const ls = await run("tag", "ls", "--json");
    const tags = JSON.parse(ls.stdout) as Array<{ name: string; color: string | null }>;
    const hit = tags.find(t => t.name === "recolor");
    if (!hit) throw new Error("expected tag 'recolor' to be present after edit");
    expect(hit.color).toBe("#ffffff");
  });

  test("rejects edit with neither --color nor --rename", async () => {
    await run("tag", "add", "noflags");
    const r = await run("tag", "edit", "noflags");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/at least one/);
  });
});
