import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { runCli, mkTmpEnv } from "../helpers.ts";

// --- --body-file smoke test (Plan 4 task 2) ------------------------------
//
// End-to-end via the CLI binary: writes a tmp file, runs `cortex add
// --body-file <tmp>` and `cortex edit <id> --body-file <tmp>`, asserts the
// task's stored body matches the file. Also verifies the mutex error.

describe("cortex add/edit accept --body-file", () => {
  let testEnv: Record<string, string>;
  let cliTmpDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    const e = mkTmpEnv("bodyfile");
    testEnv = e.env;
    cliTmpDir = e.tmpDir;
    cleanup = e.cleanup;
  });

  afterAll(() => cleanup());

  const cli = (...args: string[]) => runCli({ args, env: testEnv });

  test("add --body-file stores file contents as the task body; edit --body-file updates it; -b + --body-file is rejected", async () => {
    let r = await cli("init");
    expect(r.code).toBe(0);

    const tmp = path.join(cliTmpDir, "plan.md");
    const original = "plan body content here\n\n## Section\n\nbody.";
    fs.writeFileSync(tmp, original);

    r = await cli("add", "test", "-l", "now", "--body-file", tmp);
    expect(r.code).toBe(0);
    const m = r.stdout.match(/^\[(\d+)\]/);
    expect(m).not.toBeNull();
    const id = m?.[1];
    if (!id) throw new Error(`could not parse task id from cli output: ${r.stdout}`);

    // Verify stored body via `show --json` (the canonical body-fetch path
    // documented in Plan 4 Implementation Notes for plan revision).
    r = await cli("show", id, "--json");
    expect(r.code).toBe(0);
    const showOut = JSON.parse(r.stdout);
    const task = showOut.task ?? showOut;
    expect(task.body).toBe(original);

    // Modify the file, run edit --body-file, verify the body updates.
    const updated = `${original}\n\nappended.`;
    fs.writeFileSync(tmp, updated);
    r = await cli("edit", id, "--body-file", tmp);
    expect(r.code).toBe(0);

    r = await cli("show", id, "--json");
    expect(r.code).toBe(0);
    const showOut2 = JSON.parse(r.stdout);
    const task2 = showOut2.task ?? showOut2;
    expect(task2.body).toBe(updated);

    // Mutex: -b together with --body-file MUST fail with the documented error.
    r = await cli("add", "x", "-l", "now", "-b", "inline", "--body-file", tmp);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("use --body-file OR -b");

    // Stdin: `--body-file -` reads the body from stdin. A bare "-" token
    // starts with charCode 45, which citty 0.1.x's parser treats as a flag
    // (bodyFile became boolean true); cli.ts normalizes it to
    // `--body-file=-` and stdinRequested() accepts both spellings.
    const stdinBody = "stdin body line\n- with dash item";
    r = await runCli({ args: ["add", "stdin", "-l", "now", "--body-file", "-"], env: testEnv, stdin: stdinBody });
    expect(r.code).toBe(0);
    const sm = r.stdout.match(/^\[(\d+)\]/);
    expect(sm).not.toBeNull();
    const sid = sm?.[1];
    if (!sid) throw new Error(`could not parse task id from cli output: ${r.stdout}`);
    r = await cli("show", sid, "--json");
    expect(r.code).toBe(0);
    const showOut3 = JSON.parse(r.stdout);
    const task3 = showOut3.task ?? showOut3;
    expect(task3.body).toBe(stdinBody);
    // cleanup
    r = await cli("rm", sid, "-f");
    expect(r.code).toBe(0);
  });
});
