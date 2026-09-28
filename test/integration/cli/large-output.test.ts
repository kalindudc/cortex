import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { runCli, mkTmpEnv, BIN, ROOT } from "../helpers.ts";

// --- stdout larger than a pipe buffer --------------------------------------
//
// Agents pipe `cortex show --json` / `cortex ls --json --full` into jq, and
// plan bodies routinely exceed 64 KiB. Under Bun 1.4.2, once anything touches
// `process.stdout` (citty's consola does at import), fd 1 is non-blocking and
// `console.log` issues a single short write(2) to a full pipe, silently
// dropping everything past 64 KiB (see src/stdio.ts).
//
// runCli's Bun.spawn stdout does NOT reproduce it, so these tests go through a
// real shell pipe (`cortex ... | cat`), the exact path of `cortex ... | jq`.
// Arguments travel as positional parameters, never spliced into the script.
async function runPiped(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["sh", "-c", '"$0" "$@" | cat; exit "${PIPESTATUS:-0}"', BIN, ...args], {
    env,
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}

describe("CLI output larger than a pipe buffer arrives complete", () => {
  let env: Record<string, string>;
  let tmpDir: string;
  let cleanup: () => void;
  const body = `${"0123456789abcdef".repeat(9375)}\n`; // 150,001 bytes

  beforeAll(async () => {
    const e = mkTmpEnv("large-output");
    env = e.env;
    tmpDir = e.tmpDir;
    cleanup = e.cleanup;
    const file = path.join(tmpDir, "body.md");
    fs.writeFileSync(file, body);
    expect((await runCli({ args: ["init"], env })).code).toBe(0);
    const added = await runCli({ args: ["add", "big", "--body-file", file, "--json"], env });
    expect(added.code).toBe(0);
  });

  afterAll(() => cleanup());

  test("show --json delivers the whole task through a pipe", async () => {
    const r = await runPiped(["show", "1", "--json"], env);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(150_000);
    expect(JSON.parse(r.stdout).task.body).toBe(body);
  });

  test("ls --json --full delivers every body through a pipe", async () => {
    const r = await runPiped(["ls", "--json", "--full"], env);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ id: number; body: string }>;
    expect(rows.find(t => t.id === 1)?.body).toBe(body);
  });

  test("human show output is complete too", async () => {
    const r = await runPiped(["show", "1"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(body.trimEnd());
  });
});
