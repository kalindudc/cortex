import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { CortexCliError, createCortexRunner, resolveCortexBinary, verifyCortexFeatures } from "./cli";
import { createFakeCortex, type FakeCortex } from "./fake-cortex";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bb-cli-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An executable named `cortex` in `dir` whose body is node code. */
function executable(dir: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "cortex");
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return file;
}

function fake(fixture = {}): FakeCortex {
  const f = createFakeCortex(fixture);
  cleanups.push(f.cleanup);
  return f;
}

async function rejection(promise: Promise<unknown>): Promise<CortexCliError> {
  const err = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(err).toBeInstanceOf(CortexCliError);
  return err as CortexCliError;
}

describe("resolveCortexBinary", () => {
  test("prefers absolute PATH entries, then ~/bin, then ~/.local/bin, skipping relative PATH entries", () => {
    const home = tempDir();
    const onPath = executable(path.join(home, "path-bin"), "");
    const homeBin = executable(path.join(home, "bin"), "");
    const localBin = executable(path.join(home, ".local", "bin"), "");
    const env = { HOME: home, PATH: ["relative-dir", path.join(home, "path-bin")].join(path.delimiter) };
    expect(resolveCortexBinary("", env)).toBe(onPath);
    fs.rmSync(onPath);
    expect(resolveCortexBinary("", env)).toBe(homeBin);
    fs.rmSync(homeBin);
    expect(resolveCortexBinary("", env)).toBe(localBin);
    fs.rmSync(localBin);
    expect(resolveCortexBinary("", env)).toBeNull();
  });

  test("a configured path wins and never falls back; ~ expands and relative paths are refused", () => {
    const home = tempDir();
    const configured = executable(path.join(home, "custom"), "");
    executable(path.join(home, "bin"), "");
    const env = { HOME: home, PATH: "" };
    expect(resolveCortexBinary(configured, env)).toBe(configured);
    expect(resolveCortexBinary("~/custom/cortex", env)).toBe(configured);
    expect(resolveCortexBinary("custom/cortex", env)).toBeNull();
    expect(resolveCortexBinary(path.join(home, "missing"), env)).toBeNull();
  });

  test("createCortexRunner reports a missing binary as `missing`", async () => {
    const err = await rejection(createCortexRunner("", { HOME: tempDir(), PATH: "" }));
    expect(err.code).toBe("missing");
  });
});

describe("runner.run", () => {
  test("passes the exact argv and cwd, and returns the validated JSON", async () => {
    const f = fake({ context: { lane: "cortex", primer: "P" } });
    const runner = await createCortexRunner(f.binary);
    const cwd = tempDir();
    const out = await runner.run(["memory", "context", "--json"], z.object({ lane: z.string() }), { cwd });
    expect(out).toEqual({ lane: "cortex" });
    expect(f.calls()).toEqual([{ argv: ["memory", "context", "--json"], cwd: fs.realpathSync(cwd) }]);
  });

  test("malformed JSON is `json`, a nonconforming shape is `shape`", async () => {
    const dir = tempDir();
    const garbage = await createCortexRunner(executable(path.join(dir, "a"), 'process.stdout.write("not json")'));
    expect((await rejection(garbage.run(["x"], z.unknown()))).code).toBe("json");
    const wrong = await createCortexRunner(executable(path.join(dir, "b"), 'process.stdout.write("{\\"a\\":1}")'));
    expect((await rejection(wrong.run(["x"], z.object({ b: z.string() })))).code).toBe("shape");
  });

  test("an error envelope fails even on exit 0, and a nonzero exit carries the envelope's message", async () => {
    const dir = tempDir();
    const envelope = 'process.stdout.write(JSON.stringify({ error: { code: "not_found", message: "task 7 not found" } }))';
    const zero = await createCortexRunner(executable(path.join(dir, "a"), envelope));
    const err = await rejection(zero.run(["show", "7", "--json"], z.unknown()));
    expect(err.code).toBe("exit");
    expect(err.message).toContain("task 7 not found");
    const one = await createCortexRunner(executable(path.join(dir, "b"), `${envelope}; process.exit(1)`));
    const failed = await rejection(one.run(["show", "7", "--json"], z.unknown()));
    expect(failed.code).toBe("exit");
    expect(failed.message).toContain("task 7 not found");
    const stderr = await createCortexRunner(
      executable(path.join(dir, "c"), 'process.stderr.write("boom\\n"); process.exit(3)'),
    );
    expect((await rejection(stderr.run(["x"], z.unknown()))).message).toContain("boom");
  });

  test("a slow command times out, and an abort stops it", async () => {
    const slow = await createCortexRunner(executable(tempDir(), "setTimeout(() => {}, 10000)"));
    const timedOut = await rejection(slow.run(["x"], z.unknown(), { timeoutMs: 100 }));
    expect(timedOut.code).toBe("timeout");
    expect(timedOut.message).toContain("timed out");
    const controller = new AbortController();
    const pending = slow.run(["x"], z.unknown(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const aborted = await rejection(pending);
    expect(aborted.code).toBe("timeout");
    expect(aborted.message).toContain("aborted");
  });

  test("text returns plain stdout", async () => {
    const f = fake({ tasks: { "4": { task: { id: 4, title: "t", status: "open", lane: "l", tags: [], body: null, created: 1 }, updates: [] } } });
    const runner = await createCortexRunner(f.binary);
    expect(await runner.text(["memory", "show", "4"])).toContain("TEXT memory show 4");
  });
});

describe("verifyCortexFeatures", () => {
  test("passes with watch and author streams, using one schema call and one bounded streams probe", async () => {
    const f = fake();
    await verifyCortexFeatures(await createCortexRunner(f.binary));
    expect(f.calls().map(call => call.argv)).toEqual([
      ["schema", "--json"],
      ["memory", "streams", "--author=bb-plugin-check", "--limit=1", "--json"],
    ]);
  });

  test("a cortex without watch or without author streams is `outdated`", async () => {
    const noWatch = fake({ commands: ["memory"] });
    expect((await rejection(verifyCortexFeatures(await createCortexRunner(noWatch.binary)))).code).toBe("outdated");
    const noStreams = fake({ streamsProbeFails: true });
    const err = await rejection(verifyCortexFeatures(await createCortexRunner(noStreams.binary)));
    expect(err.code).toBe("outdated");
    expect(err.message).toContain("author streams");
  });
});
