import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { mkTmpEnv, runCli } from "../helpers.ts";

// `cortex memory` against the COMPILED binary (plan @414): proves FTS5 works
// inside `bun build --compile`, and exercises lane derivation, staleness and
// breadcrumbs from a real git checkout as cwd. Hermetic via mkTmpEnv (never
// the production DB); the checkout lives in the same tmp dir and commits
// never sign. Tests run in order and share one stream.

let env: Record<string, string>;
let cleanup: () => void;
let repo: string;
let streamId = 0;

function git(...args: string[]): void {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

const cli = (args: string[], opts: { cwd?: string; stdin?: string } = {}) =>
  runCli({ args, env, cwd: opts.cwd ?? repo, stdin: opts.stdin });

async function json<T>(args: string[], cwd?: string): Promise<T> {
  const r = await cli(args, { cwd });
  if (r.code !== 0) throw new Error(`cortex ${args.join(" ")} exited ${r.code}: ${r.stderr}${r.stdout}`);
  return JSON.parse(r.stdout) as T;
}

type Shown = {
  synced: number;
  trail: { summary: string }[];
  staleness: { verdict: string; changed: string[]; missing: string[]; repo: string };
};

const BODY = "## Goal\nSmooth mouse wheel scrolling\n## Files\n- `src/a.ts`\n";

beforeAll(async () => {
  const tmp = mkTmpEnv("memory");
  env = tmp.env;
  cleanup = tmp.cleanup;
  repo = path.join(tmp.tmpDir, "myproj");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(repo, "src", "a.ts"), past, past);
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "baseline");
  expect((await cli(["init"])).code).toBe(0);
});

afterAll(() => cleanup());

describe("cortex memory (compiled binary)", () => {
  test("memory lane prints the checkout's repo name", async () => {
    const r = await cli(["memory", "lane"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("myproj");
  });

  test("memory search ranks a stream and ignores punctuation", async () => {
    const created = await json<{ id: number }>([
      "add",
      "TUI mouse wheel scrolling",
      "-l",
      "myproj",
      "-b",
      BODY,
      "--json",
    ]);
    streamId = created.id;
    const found = await json<{ terms: string[]; hits: { id: number; matched: string[]; synced: number }[] }>([
      "memory",
      "search",
      "how does the mouse wheel scroll?",
      "--json",
    ]);
    expect(found.terms).toEqual(["mouse", "wheel", "scroll"]);
    expect(found.hits.map(hit => hit.id)).toEqual([streamId]);
    expect(found.hits[0]?.matched).toEqual(["mouse", "wheel", "scroll"]);
    const none = await json<{ terms: string[]; hits: unknown[] }>(["memory", "search", "?! ...", "--json"]);
    expect(none).toEqual({ terms: [], hits: [] });
  });

  test("memory context returns the primer and hits in one call; --no-primer returns hits only", async () => {
    expect((await cli(["add", "Archived mouse wheel notes", "-l", "myproj", "--status", "done"])).code).toBe(0);
    expect((await cli(["update", String(streamId), "-m", "touched", "--as", "t-1"])).code).toBe(0);
    const ctx = await json<{ lane: string; primer: string; hits: { id: number }[]; hitsText: string }>([
      "memory",
      "context",
      "--json",
      "--query=mouse wheel",
      "--author=t-1",
    ]);
    expect(ctx.lane).toBe("myproj");
    expect(ctx.primer).toContain("your author tag t-1");
    expect(ctx.primer).toContain(`[${streamId}]`);
    expect(ctx.primer).not.toContain("Archived");
    expect(ctx.hitsText).toContain(`[${streamId}]`);
    expect(ctx.hitsText).toContain("(query: mouse, wheel)");
    expect(ctx.hitsText).toContain("(2/2: mouse, wheel)");
    const hitsOnly = await json<{ primer: string; hits: unknown[] }>([
      "memory",
      "context",
      "--json",
      "--no-primer",
      "--query=mouse wheel",
    ]);
    expect(hitsOnly.primer).toBe("");
    expect(hitsOnly.hits.length).toBeGreaterThan(0);
  });

  test("memory show: status flips are breadcrumbs, file edits make it stale, a body edit re-syncs", async () => {
    const id = String(streamId);
    const fresh = await json<Shown>(["memory", "show", id, "--json"]);
    expect(fresh.staleness).toMatchObject({ verdict: "fresh", repo: "this", changed: [], missing: [] });

    expect((await cli(["update", id, "-m", "flip", "-s", "review", "--as", "t-1"])).code).toBe(0);
    const flipped = await json<Shown>(["memory", "show", id, "--json"]);
    expect(flipped.staleness.verdict).toBe("fresh");
    expect(flipped.synced).toBe(fresh.synced);
    expect(flipped.trail.map(u => u.summary)).toContain("status \u2192 review");

    fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
    const stale = await json<Shown>(["memory", "show", id, "--json"]);
    expect(stale.staleness).toMatchObject({ verdict: "stale", changed: ["src/a.ts"] });
    const fromSubdir = await json<Shown>(["memory", "show", id, "--json"], path.join(repo, "src"));
    expect(fromSubdir.staleness.changed).toEqual(["src/a.ts"]);

    expect((await cli(["edit", id, "-b", `${BODY}\nVerified: re-read src/a.ts\n`])).code).toBe(0);
    const resynced = await json<Shown>(["memory", "show", id, "--json"]);
    expect(resynced.staleness.verdict).toBe("fresh");
    expect(resynced.synced).toBeGreaterThan(fresh.synced);
    expect(resynced.trail).toEqual([]);
  });

  test("memory show of a missing task exits 1", async () => {
    const r = await cli(["memory", "show", "999"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("task 999 not found");
  });
});
