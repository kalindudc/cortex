import { test, expect, beforeAll, afterAll } from "bun:test";
import { runCli, mkTmpEnv } from "./helpers.ts";

let testEnv: Record<string, string>;
let cleanup: () => void;

beforeAll(() => {
  const e = mkTmpEnv("cli");
  testEnv = e.env;
  cleanup = e.cleanup;
});

afterAll(() => cleanup());

const run = (...args: string[]) => runCli({ args, env: testEnv });
const runWithInput = (input: string, ...args: string[]) => runCli({ args, env: testEnv, stdin: input });

test("reset wipes and re-inits when RESET is typed; aborts otherwise", async () => {
  // Seed some state.
  let r = await run("init");
  expect(r.code).toBe(0);
  r = await run("add", "keepable");
  expect(r.code).toBe(0);
  r = await run("ls", "--json");
  expect(JSON.parse(r.stdout).length).toBe(1);

  // Wrong input aborts and leaves state intact.
  r = await runWithInput("no\n", "reset");
  expect(r.code).toBe(1);
  expect(r.stdout).toContain("aborted");
  r = await run("ls", "--json");
  expect(JSON.parse(r.stdout).length).toBe(1);

  // Correct input wipes + re-inits.
  r = await runWithInput("RESET\n", "reset");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("reset complete");
  r = await run("ls", "--json");
  expect(JSON.parse(r.stdout)).toEqual([]);
  // 'now' lane is seeded fresh.
  r = await run("lane", "ls", "--json");
  const lanes = JSON.parse(r.stdout);
  expect(lanes.map((l: { name: string }) => l.name)).toEqual(["now"]);
});

test("CLI round-trip: init → add → ls → update → edit → mv → rm", async () => {
  // init
  let r = await run("init");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("initialized");

  // add two tasks
  r = await run("add", "task one", "-p", "0");
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/^\[1\] task one/);

  r = await run("add", "task two", "-l", "now");
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/^\[2\] task two/);

  // ls --json shows 2 tasks
  r = await run("ls", "--json");
  expect(r.code).toBe(0);
  const list1 = JSON.parse(r.stdout);
  expect(Array.isArray(list1)).toBe(true);
  expect(list1.length).toBe(2);

  // update with status change.
  // Plan 3: --as is REQUIRED on `cortex update` (single source of truth
  // for author attribution; the server-side author cascade does not apply to CLI).
  r = await run("update", "1", "-m", "in review now", "-s", "review", "--as", "cli-roundtrip");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("update");
  expect(r.stdout).toContain("status");

  // status filter shows only the open one
  r = await run("ls", "--status", "open", "--json");
  expect(r.code).toBe(0);
  const openList = JSON.parse(r.stdout);
  expect(openList.length).toBe(1);
  expect(openList[0].id).toBe(2);

  // edit task 1
  r = await run("edit", "1", "-t", "task one renamed", "-p", "5");
  expect(r.code).toBe(0);

  // add a new lane and mv
  r = await run("lane", "add", "later", "-c", "#666");
  expect(r.code).toBe(0);
  r = await run("mv", "2", "later");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("later");

  // show task 1 as JSON.
  // Plan 3: setStatus writes an audit-trail row alongside the message row,
  // so the prior `update -m "..." -s review` produces 2 rows on this task
  // (message row + `status → review` audit row), not 1.
  r = await run("show", "1", "--json");
  expect(r.code).toBe(0);
  const show = JSON.parse(r.stdout);
  expect(show.task.title).toBe("task one renamed");
  expect(show.task.status).toBe("review");
  expect(show.updates.length).toBe(2);
  expect(show.updates.some((u: { summary: string }) => u.summary === "in review now")).toBe(true);
  expect(show.updates.some((u: { summary: string }) => u.summary === "status \u2192 review")).toBe(true);

  // rm both with -f
  r = await run("rm", "1", "-f");
  expect(r.code).toBe(0);
  r = await run("rm", "2", "-f");
  expect(r.code).toBe(0);

  // final ls is empty
  r = await run("ls", "--json");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual([]);
});

test("cortex tags via CLI: -t flag, edit add/rm/set, ls -t filter, tag rm safety", async () => {
  // Runs after the round-trip test, which leaves the DB empty (both tasks
  // rm'd at the end). The lane 'later' is still around from the round-trip,
  // which is fine — we don't filter by lane.
  let r = await run("add", "tagged", "-t", "a,b");
  expect(r.code).toBe(0);
  const id = Number(r.stdout.match(/^\[(\d+)\]/)?.[1]);
  expect(id).toBeGreaterThan(0);

  // show tags = [a, b]
  r = await run("show", String(id), "--json");
  expect(JSON.parse(r.stdout).task.tags).toEqual(["a", "b"]);

  // --add-tag c -> [a, b, c]
  r = await run("edit", String(id), "--add-tag", "c");
  expect(r.code).toBe(0);
  r = await run("show", String(id), "--json");
  expect(JSON.parse(r.stdout).task.tags).toEqual(["a", "b", "c"]);

  // --rm-tag a -> [b, c]
  r = await run("edit", String(id), "--rm-tag", "a");
  expect(r.code).toBe(0);
  r = await run("show", String(id), "--json");
  expect(JSON.parse(r.stdout).task.tags).toEqual(["b", "c"]);

  // --set-tags d -> [d]
  r = await run("edit", String(id), "--set-tags", "d");
  expect(r.code).toBe(0);
  r = await run("show", String(id), "--json");
  expect(JSON.parse(r.stdout).task.tags).toEqual(["d"]);

  // mutually exclusive flags exit 1
  r = await run("edit", String(id), "--set-tags", "x", "--add-tag", "y");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("mutually exclusive");

  // ls -t d returns the task; ls -t a returns []
  r = await run("ls", "-t", "d", "--json");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).length).toBe(1);
  r = await run("ls", "-t", "a", "--json");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).length).toBe(0);

  // tag rm d (in use) exits 1; -f succeeds
  r = await run("tag", "rm", "d");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("reference it");
  r = await run("tag", "rm", "d", "-f");
  expect(r.code).toBe(0);

  // invalid tag name exits 1 with validation message
  r = await run("add", "y", "-t", "BAD NAME");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("invalid tag name");

  // cleanup so subsequent test runs (or future tests) start clean
  r = await run("rm", String(id), "-f");
  expect(r.code).toBe(0);
});

test("cortex ls --search searches titles and bodies; @ restricts to title", async () => {
  const ids: number[] = [];
  try {
    let r = await run("add", "alpha title match", "-b", "unrelated body");
    expect(r.code).toBe(0);
    const titleId = Number(r.stdout.match(/^\[(\d+)\]/)?.[1]);
    expect(titleId).toBeGreaterThan(0);
    ids.push(titleId);

    r = await run("add", "body only match", "-b", "notes mention alpha here");
    expect(r.code).toBe(0);
    const bodyId = Number(r.stdout.match(/^\[(\d+)\]/)?.[1]);
    expect(bodyId).toBeGreaterThan(0);
    ids.push(bodyId);

    r = await run("ls", "--search", "alpha", "--json");
    expect(r.code).toBe(0);
    const defaultResults = JSON.parse(r.stdout) as Array<{ id: number }>;
    expect(defaultResults.map(t => t.id)).toContain(titleId);
    expect(defaultResults.map(t => t.id)).toContain(bodyId);

    r = await run("ls", "--search", "@alpha", "--json");
    expect(r.code).toBe(0);
    const titleOnlyResults = JSON.parse(r.stdout) as Array<{ id: number }>;
    expect(titleOnlyResults.map(t => t.id)).toContain(titleId);
    expect(titleOnlyResults.map(t => t.id)).not.toContain(bodyId);
  } finally {
    for (const id of ids) {
      await run("rm", String(id), "-f");
    }
  }
});

test("cortex show + ls render tags in the formatted text view", async () => {
  // `cortex show` should print a 'tags:' line listing every attached tag
  // (full list, no truncation); `cortex ls` should truncate the per-task tag
  // list to keep rows scannable when a task carries many tags.
  let r = await run("add", "many-tagged", "-t", "a,b,c,d,e");
  expect(r.code).toBe(0);
  const id = Number(r.stdout.match(/^\[(\d+)\]/)?.[1]);
  expect(id).toBeGreaterThan(0);

  // `cortex show` formatted view: tags line is present and includes ALL tags.
  r = await run("show", String(id));
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/tags:\s+#a #b #c #d #e/);

  // `cortex ls` formatted view: tags appear bracketed after the title,
  // truncated to first 3 with a '+2' indicator (5 total - 3 limit).
  r = await run("ls");
  expect(r.code).toBe(0);
  // Tag chips are printed in gray ANSI; strip ANSI codes for assertion. The
  // brackets + truncation marker are what matters, not the color.
  // eslint-disable-next-line no-control-regex
  const plain = r.stdout.replace(/\u001b\[[0-9;]*m/g, "");
  expect(plain).toContain("many-tagged [#a #b #c +2]");

  // A task with ≤ LS_TAG_LIMIT tags should NOT show '+N'.
  r = await run("add", "few-tagged", "-t", "x,y");
  expect(r.code).toBe(0);
  const fid = Number(r.stdout.match(/^\[(\d+)\]/)?.[1]);
  r = await run("ls");
  // eslint-disable-next-line no-control-regex
  const plain2 = r.stdout.replace(/\u001b\[[0-9;]*m/g, "");
  expect(plain2).toContain("few-tagged [#x #y]");
  expect(plain2).not.toMatch(/few-tagged \[#x #y \+/);

  // cleanup
  r = await run("rm", String(id), "-f");
  expect(r.code).toBe(0);
  r = await run("rm", String(fid), "-f");
  expect(r.code).toBe(0);
});

test("cortex edit --body-search/--body-replace: success, no-match, ambiguous, mutex", async () => {
  // Add a task with a uniquely anchored body — mirrors the agentic
  // workflow: read the body, identify a unique anchor, send a precise
  // partial edit instead of a full-string overwrite.
  let r = await run("add", "anchored", "-b", "intro\n\n## Plan\n- step 1\n- step 2\n\noutro");
  expect(r.code).toBe(0);
  const id = Number(r.stdout.match(/^\[(\d+)\]/)?.[1]);
  expect(id).toBeGreaterThan(0);

  // Happy path: unique multi-line anchor is spliced.
  r = await run(
    "edit",
    String(id),
    "--body-search",
    "## Plan\n- step 1\n- step 2",
    "--body-replace",
    "## Plan\n- step 1\n- step 2\n- step 3",
  );
  expect(r.code).toBe(0);
  r = await run("show", String(id));
  expect(r.stdout).toContain("- step 1");
  expect(r.stdout).toContain("- step 2");
  expect(r.stdout).toContain("- step 3");

  // Dash-leading anchors: citty 0.1.x never consumes a "-"-prefixed token
  // as a flag value (it left bodySearch boolean-true → "anchor not found",
  // and a value like "-beta" hijacked the -b alias, faking the mutex
  // error). cli.ts pre-normalizes argv (src/args.ts) so these parse as
  // values; markdown list/separator anchors are the routine agent case.
  r = await run("edit", String(id), "--body-search", "- step 1", "--body-replace", "- step ONE");
  expect(r.code).toBe(0);
  r = await run("show", String(id));
  expect(r.stdout).toContain("- step ONE");

  r = await run("edit", String(id), "--body-search", "- step 2", "--body-replace", "- step TWO");
  expect(r.code).toBe(0);
  r = await run("show", String(id));
  expect(r.stdout).toContain("- step TWO");

  // Same-shape values for -b on add/update: dash-leading bodies must not
  // be re-parsed as flags.
  r = await run("add", "dashy", "-b", "- [ ] todo");
  expect(r.code).toBe(0);
  const did = Number(r.stdout.match(/^\[(\d+)\]/)?.[1]);
  expect(did).toBeGreaterThan(0);
  r = await run("show", String(did));
  expect(r.stdout).toContain("- [ ] todo");

  // Anchor not found — non-zero exit + helpful error so an agent can
  // re-read and refine.
  r = await run("edit", String(id), "--body-search", "this anchor does not exist", "--body-replace", "x");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toMatch(/not found/i);

  // Ambiguous anchor: "step" appears 3 times now — must fail with a
  // count so the agent can broaden the anchor for uniqueness.
  r = await run("edit", String(id), "--body-search", "step", "--body-replace", "STEP");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toMatch(/match.*3.*time|ambiguous/i);

  // Mutex with -b: caught locally before round-trip, with a clear error.
  r = await run("edit", String(id), "--body-search", "intro", "--body-replace", "INTRO", "-b", "whole new body");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toMatch(/cannot be combined/i);

  // Pair-required: --body-search alone fails locally.
  r = await run("edit", String(id), "--body-search", "intro");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toMatch(/must be used together/i);

  // cleanup
  r = await run("rm", String(id), "-f");
  expect(r.code).toBe(0);
  r = await run("rm", String(did), "-f");
  expect(r.code).toBe(0);
});
