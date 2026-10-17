/**
 * cortex resume for bb thread authors (`bb-<thread id>`): the chosen thread
 * opens with `$BB_CLI thread open <id>`, else `bb` from PATH, and its exit
 * code propagates. PATH is an empty tmp dir (no real bb, pi or fzf); the
 * only programs are shims that log their argv and exit 7.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmpEnv, runCli } from "../helpers.ts";

const THREAD = "thr_2qj8qzdqqr";
const BB_AUTHOR = `bb-${THREAD}`;
const PI_AUTHOR = "pi-01923f3a-9201-7c0e-b1c8-abcdef012345";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function mkEnv(label: string): { env: Record<string, string>; dir: string } {
  const base = mkTmpEnv(label);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bb-resume-path-"));
  base.env.PATH = dir;
  cleanups.push(() => {
    base.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { env: base.env, dir };
}

/** A shim at `<dir>/<name>` that writes its argv (one per line) to `<dir>/<name>.argv` and exits 7. */
function shim(dir: string, name: string): { path: string; argv: () => string[] } {
  const file = path.join(dir, name);
  const log = `${file}.argv`;
  fs.writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\nexit 7\n`, {
    mode: 0o755,
  });
  return { path: file, argv: () => fs.readFileSync(log, "utf8").trim().split("\n") };
}

async function seedTask(env: Record<string, string>, authors: string[]): Promise<string> {
  expect((await runCli({ args: ["init"], env })).code).toBe(0);
  const r = await runCli({ args: ["add", "resume me", "--json"], env });
  expect(r.code).toBe(0);
  const id = String((JSON.parse(r.stdout) as { id: number }).id);
  for (const author of authors) {
    expect((await runCli({ args: ["update", id, "-m", `from ${author}`, "--as", author], env })).code).toBe(0);
  }
  return id;
}

describe("cortex resume for bb threads", () => {
  test("an explicit BB_CLI runs `thread open <id>` and propagates its exit code", async () => {
    const { env, dir } = mkEnv("bb-resume-cli");
    const bb = shim(dir, "bb-app");
    const id = await seedTask(env, [BB_AUTHOR]);
    const r = await runCli({ args: ["resume", id], env: { ...env, BB_CLI: bb.path } });
    expect(r.code).toBe(7);
    expect(r.stderr).toContain(`→ resuming ${BB_AUTHOR}`);
    expect(bb.argv()).toEqual(["thread", "open", THREAD]);
  });

  test("without BB_CLI, bb from PATH runs `thread open <id>`", async () => {
    const { env, dir } = mkEnv("bb-resume-path");
    const bb = shim(dir, "bb");
    const id = await seedTask(env, [BB_AUTHOR]);
    const r = await runCli({ args: ["resume", id], env });
    expect(r.code).toBe(7);
    expect(bb.argv()).toEqual(["thread", "open", THREAD]);
  });

  test("no bb program prints the bb message and exits 1", async () => {
    const { env } = mkEnv("bb-resume-missing");
    const id = await seedTask(env, [BB_AUTHOR]);
    const missing = await runCli({ args: ["resume", id], env });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("bb not found; set BB_CLI or install bb");
    expect(missing.stderr).not.toContain("pi not found");

    const named = await runCli({ args: ["resume", id], env: { ...env, BB_CLI: "/nonexistent/bb-cli" } });
    expect(named.code).toBe(1);
    expect(named.stderr).toContain("/nonexistent/bb-cli not found; set BB_CLI or install bb");
  });

  test("short, long or malformed thread ids are not resumable", async () => {
    const { env, dir } = mkEnv("bb-resume-bad");
    shim(dir, "bb");
    const id = await seedTask(env, [
      "bb-thr_abc12",
      `bb-thr_${"a".repeat(41)}`,
      "bb-thr_ABC123",
      "bb-thread_abc123",
      "bb-thr_abc123;rm",
    ]);
    const r = await runCli({ args: ["resume", id], env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no resumable harness sessions");
    expect(fs.existsSync(path.join(dir, "bb.argv"))).toBe(false);
  });

  test("pi and bb authors share the picker, and the chosen bb row opens its thread", async () => {
    const { env, dir } = mkEnv("bb-resume-mixed");
    const bb = shim(dir, "bb");
    const pi = shim(dir, "pi");
    // The bb update is newest, so it is row [1].
    const id = await seedTask(env, [PI_AUTHOR, BB_AUTHOR]);
    const cancel = await runCli({ args: ["resume", id], env, stdin: "\n" });
    expect(cancel.code).toBe(0);
    expect(cancel.stderr).toContain(`[1] ${BB_AUTHOR}`);
    expect(cancel.stderr).toContain(`[2] ${PI_AUTHOR}`);

    const chosen = await runCli({ args: ["resume", id], env, stdin: "1\n" });
    expect(chosen.code).toBe(7);
    expect(bb.argv()).toEqual(["thread", "open", THREAD]);
    expect(fs.existsSync(path.join(dir, "pi.argv"))).toBe(false);

    const piChosen = await runCli({ args: ["resume", id], env, stdin: "2\n" });
    expect(piChosen.code).toBe(7);
    expect(pi.argv()).toEqual(["--session", PI_AUTHOR.slice(3)]);
  });
});
