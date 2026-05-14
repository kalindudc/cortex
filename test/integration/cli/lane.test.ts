import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { runCli, mkTmpEnv } from "../helpers.ts";

// Integration coverage for `cortex lane {add,ls,edit,rm}`.
//
// One shared tmp env / DB across the whole file. Tests are sequential and
// each uses a unique lane name to avoid collisions with previously created
// rows. The default 'now' lane is seeded by Store.open() (store.ts:251),
// so it exists from the first call.

let testEnv: Record<string, string>;
let cleanup: () => void;

beforeAll(async () => {
  const e = mkTmpEnv("lane");
  testEnv = e.env;
  cleanup = e.cleanup;
  const r = await runCli({ args: ["init"], env: testEnv });
  expect(r.code).toBe(0);
});

afterAll(() => cleanup());

const run = (...args: string[]) => runCli({ args, env: testEnv });

type LaneRow = { name: string; color: string | null; sort: number };

const listLanes = async (): Promise<LaneRow[]> => {
  const r = await run("lane", "ls", "--json");
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as LaneRow[];
};

describe("lane add", () => {
  test("creates a lane with no color (exit 0)", async () => {
    const r = await run("lane", "add", "add-plain");
    expect(r.code).toBe(0);
    const lanes = await listLanes();
    const found = lanes.find(l => l.name === "add-plain");
    expect(found).toBeDefined();
    expect(found?.color).toBeNull();
  });

  test("creates a lane with -c #fe8019 and persists the color", async () => {
    const r = await run("lane", "add", "add-colored", "-c", "#fe8019");
    expect(r.code).toBe(0);
    const lanes = await listLanes();
    const found = lanes.find(l => l.name === "add-colored");
    expect(found?.color).toBe("#fe8019");
  });

  test("duplicate name exits 1 (UNIQUE constraint)", async () => {
    let r = await run("lane", "add", "add-dup");
    expect(r.code).toBe(0);
    r = await run("lane", "add", "add-dup");
    expect(r.code).toBe(1);
    expect(r.stderr.toLowerCase()).toMatch(/unique|exists|constraint/);
  });
});

describe("lane ls", () => {
  test("--json returns array of {name,color,sort}", async () => {
    await run("lane", "add", "ls-json-target");
    const lanes = await listLanes();
    expect(Array.isArray(lanes)).toBe(true);
    expect(lanes.length).toBeGreaterThan(0);
    for (const l of lanes) {
      expect(typeof l.name).toBe("string");
      expect(typeof l.sort).toBe("number");
      expect(l.color === null || typeof l.color === "string").toBe(true);
    }
    expect(lanes.some(l => l.name === "ls-json-target")).toBe(true);
  });

  test("default text output prints every lane name to stdout", async () => {
    await run("lane", "add", "ls-text-zeta");
    const lanes = await listLanes();
    const r = await run("lane", "ls");
    expect(r.code).toBe(0);
    for (const l of lanes) {
      expect(r.stdout).toContain(l.name);
    }
  });
});

describe("lane edit", () => {
  test("--rename cascades to tasks (FK ON UPDATE CASCADE)", async () => {
    let r = await run("lane", "add", "edit-rename-src");
    expect(r.code).toBe(0);
    r = await run("add", "task-on-rename-lane", "-l", "edit-rename-src");
    expect(r.code).toBe(0);
    // Capture id from add stdout: "✓ task <id> created" -- but to stay
    // robust just read back the most-recent task by listing tasks on the
    // source lane via show on each candidate. Simpler: parse digits from
    // the add output.
    const idMatch = r.stdout.match(/(\d+)/);
    if (!idMatch?.[1]) throw new Error(`could not parse task id from add stdout: ${JSON.stringify(r.stdout)}`);
    const id = idMatch[1];

    r = await run("lane", "edit", "edit-rename-src", "--rename", "edit-rename-dst");
    expect(r.code).toBe(0);

    r = await run("show", id, "--json");
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { task: { lane: string } };
    expect(parsed.task.lane).toBe("edit-rename-dst");
  });

  test("-c updates the color", async () => {
    let r = await run("lane", "add", "edit-color-target");
    expect(r.code).toBe(0);
    r = await run("lane", "edit", "edit-color-target", "-c", "#abcdef");
    expect(r.code).toBe(0);
    const lanes = await listLanes();
    const found = lanes.find(l => l.name === "edit-color-target");
    expect(found?.color).toBe("#abcdef");
  });

  test("with no flags exits 1 and stderr asks for at least one", async () => {
    await run("lane", "add", "edit-noflag-target");
    const r = await run("lane", "edit", "edit-noflag-target");
    expect(r.code).toBe(1);
    expect(r.stderr.toLowerCase()).toContain("at least one");
  });
});

describe("lane rm", () => {
  test("removes an empty lane (exit 0, no longer in ls)", async () => {
    let r = await run("lane", "add", "rm-empty");
    expect(r.code).toBe(0);
    r = await run("lane", "rm", "rm-empty");
    expect(r.code).toBe(0);
    const lanes = await listLanes();
    expect(lanes.some(l => l.name === "rm-empty")).toBe(false);
  });

  test("refuses to remove 'now'", async () => {
    const r = await run("lane", "rm", "now");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("now");
  });

  test("refuses to remove a lane that tasks reference", async () => {
    let r = await run("lane", "add", "rm-with-tasks");
    expect(r.code).toBe(0);
    r = await run("add", "blocker-task", "-l", "rm-with-tasks");
    expect(r.code).toBe(0);
    r = await run("lane", "rm", "rm-with-tasks");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("reference it");
  });
});
