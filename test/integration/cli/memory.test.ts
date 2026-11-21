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

  test("the checkout probe and cached lane distinguish a git checkout from a plain folder", async () => {
    const scratch = path.join(path.dirname(repo), "scratch-notes");
    fs.mkdirSync(scratch, { recursive: true });
    expect((await cli(["memory", "lane", "--checkout"])).stdout.trim()).toBe("myproj");
    expect((await cli(["memory", "lane"], { cwd: scratch })).stdout.trim()).toBe("scratch-notes");
    const shortcut = await cli(["memory", "lane", "--checkout"], { cwd: scratch });
    expect(shortcut.code).toBe(0);
    expect(shortcut.stdout.trim()).toBe("");
    expect(await json(["memory", "context", "--json"], scratch)).toMatchObject({
      lane: "scratch-notes",
      checkoutLane: null,
    });
    expect(await json(["memory", "context", "--json"])).toMatchObject({ lane: "myproj", checkoutLane: "myproj" });
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
    const none = await json<{ terms: string[]; recent: boolean; hits: unknown[] }>([
      "memory",
      "search",
      "?! ...",
      "--json",
    ]);
    expect(none).toEqual({ terms: [], recent: false, hits: [] });
  });

  test("memory context returns the primer and hits in one call; --no-primer returns hits only", async () => {
    expect((await cli(["add", "Archived mouse wheel notes", "-l", "myproj", "--status", "done"])).code).toBe(0);
    expect((await cli(["update", String(streamId), "-m", "touched", "--as", "t-1"])).code).toBe(0);
    const ctx = await json<{
      lane: string;
      primer: string;
      primerIds: number[];
      hits: { id: number }[];
      hitsText: string;
    }>(["memory", "context", "--json", "--query=mouse wheel", "--author=t-1"]);
    expect(ctx.lane).toBe("myproj");
    expect(ctx.primer).toContain("your author tag t-1");
    expect(ctx.primer).toContain(`[${streamId}]`);
    expect(ctx.primer).not.toContain("Archived");
    // primerIds: exactly the streams the primer lists, in its order.
    expect(ctx.primerIds).toContain(streamId);
    expect(ctx.primerIds).toEqual([...ctx.primer.matchAll(/^- \[(\d+)\]/gm)].map(m => Number(m[1])));
    // The author's own streams are already its work: never a hit.
    expect(ctx.hits.map(hit => hit.id)).not.toContain(streamId);
    expect(ctx.hitsText).toContain("Archived mouse wheel notes");
    expect(ctx.hitsText).toContain("(query: mouse, wheel)");
    expect(ctx.hitsText).toContain("(2/2: mouse, wheel)");
    const hitsOnly = await json<{ primer: string; primerIds: number[]; hits: { id: number }[] }>([
      "memory",
      "context",
      "--json",
      "--no-primer",
      "--query=mouse wheel",
    ]);
    expect(hitsOnly.primer).toBe("");
    expect(hitsOnly.primerIds).toEqual([]);
    expect(hitsOnly.hits.map(hit => hit.id)).toContain(streamId);
  });

  test("memory context --parent links the starting thread's streams and leaves keyword hits out", async () => {
    expect((await cli(["update", String(streamId), "-m", "parent work", "--as", "bb-thr_parent01"])).code).toBe(0);
    const ctx = await json<{ hits: { id: number; via?: { kind: string } }[]; hitsText: string }>([
      "memory",
      "context",
      "--json",
      "--no-primer",
      "--parent=bb-thr_parent01",
      "--query=check the archived mouse wheel notes",
    ]);
    expect(ctx.hits.map(hit => [hit.id, hit.via?.kind])).toEqual([[streamId, "parent"]]);
    expect(ctx.hitsText).toContain("(linked: the thread that started this one worked on it)");
    expect(ctx.hitsText).not.toContain("Possibly relevant");
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

  test("a stream in another lane is found from this repo; context boosts this lane and says `recent`", async () => {
    const other = await json<{ id: number }>([
      "add",
      "Gateway routing-events handover",
      "-l",
      "infra",
      "-b",
      "## State\nrouting-events consumer split\n## Next\n1. flip the traffic\n## Notes\nold notes",
      "--json",
    ]);
    const found = await json<{ hits: { id: number; lane: string }[] }>([
      "memory",
      "search",
      "routing-events",
      "--boost=myproj",
      "--json",
    ]);
    expect(found.hits.map(hit => hit.id)).toEqual([other.id]);
    const filtered = await json<{ hits: unknown[] }>(["memory", "search", "routing-events", "--lane=myproj", "--json"]);
    expect(filtered.hits).toEqual([]);
    const ctx = await json<{ lane: string; recent: boolean; primer: string; hitsText: string }>([
      "memory",
      "context",
      "--json",
      "--query=what was I last doing on routing-events",
      '--load-hint=cortex_recall "@<id>"',
    ]);
    expect(ctx.lane).toBe("myproj");
    expect(ctx.recent).toBe(true);
    expect(ctx.hitsText).toContain(`[${other.id}] open \u00b7 infra`);
    expect(ctx.hitsText).toContain('newest first). Load one with `cortex_recall "@<id>"`');
    expect(ctx.primer).toContain(`Recently active in other lanes:\n- [${other.id}] open \u00b7 infra`);

    const section = await cli(["memory", "show", String(other.id), "--section=next"]);
    expect(section.code).toBe(0);
    expect(section.stdout).toContain("## Next\n1. flip the traffic");
    expect(section.stdout).not.toContain("## State");
    expect(section.stdout).not.toContain("## Notes");
    const sections = await json<{
      sections: { heading: string | null; slug: string; text: string }[];
      latest: unknown;
    }>(["memory", "show", String(other.id), "--section=next", "--json"]);
    expect(sections.sections).toEqual([{ heading: "Next", slug: "next", text: "## Next\n1. flip the traffic" }]);
    expect(sections.latest).toBeNull();
  });

  test("memory show of a missing task exits 1", async () => {
    const r = await cli(["memory", "show", "999"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("task 999 not found");
  });

  test("add can start excluded and memory curation reports attribution and no-ops", async () => {
    const author = "agent-42";
    const added = await json<{ id: number; memory_excluded: boolean; memory_exclusion: object }>([
      "add",
      "unique temporary zircon notes",
      "--memory-excluded",
      "--as",
      author,
      "--json",
    ]);
    expect(added).toMatchObject({
      memory_excluded: true,
      memory_exclusion: { excluded_by: author, reason: null, excluded_at: expect.any(Number) },
    });
    const id = String(added.id);
    const missingAuthor = await cli(["memory", "include", id, "-m", "Verified against source"]);
    expect(missingAuthor.code).toBe(1);
    expect(missingAuthor.stderr).toContain("--as is required outside a bb thread");
    const curate = (action: string, reason: string) =>
      json<{ changed: boolean }>(["memory", action, id, "-m", reason, "--as", author, "--json"]);
    expect(await curate("include", "Verified against source")).toMatchObject({ changed: true, memory_excluded: false });
    expect(await curate("include", "Already visible")).toMatchObject({ changed: false, memory_excluded: false });
    expect(await curate("exclude", "Temporary draft only")).toMatchObject({ changed: true, memory_excluded: true });
    const listed = await json<{ id: number; memory_exclusion: object }[]>(["memory", "excluded", "--json"]);
    expect(listed.find(t => t.id === added.id)?.memory_exclusion).toMatchObject({
      excluded_by: author,
      reason: "Temporary draft only",
      excluded_at: expect.any(Number),
    });
    const show = await json<{ updates: { author: string; summary: string }[] }>(["show", id, "--json"]);
    expect(show.updates).toEqual([
      expect.objectContaining({ author, summary: "created" }),
      expect.objectContaining({ author, summary: "Included in memory again: Verified against source" }),
      expect.objectContaining({ author, summary: "Excluded from memory: Temporary draft only" }),
    ]);
    expect((await cli(["memory", "include", id])).code).toBe(0);
  });

  test("an add can persist its initial exclusion reason, but only with memory-excluded", async () => {
    const author = "bb-thr_aaaaaaaa";
    const reason = "Saved excluded: the lane's daily memory budget is used";
    const cmd = ["add", "Test budget excluded document", `--as=${author}`, `--memory-exclusion-reason=${reason}`];
    const invalid = await cli(cmd);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("requires --memory-excluded");
    for (const invalidReason of ["", "two\nlines", "x".repeat(301)]) {
      const bad = await cli([
        "add",
        "Invalid exclusion reason",
        "--memory-excluded",
        `--memory-exclusion-reason=${invalidReason}`,
      ]);
      expect(bad.code).toBe(1);
    }
    const task = await json<{ id: number }>([...cmd, "--memory-excluded", "--json"]);
    try {
      expect(task).toMatchObject({ memory_excluded: true, memory_exclusion: { reason, excluded_by: author } });
      expect((await cli(["memory", "excluded"])).stdout).toContain(reason);
      expect(await json(["show", String(task.id), "--json"])).toMatchObject({
        task: { memory_exclusion: { excluded_by: author, reason, excluded_at: expect.any(Number) } },
      });
    } finally {
      await cli(["memory", "include", String(task.id)]);
    }
  });

  test("the plugin's argv form keeps a dash-leading title literal and reads the body from stdin", async () => {
    const body = "## State\nVerifiable zircon evidence from the isolated fixture.\n";
    const added = await cli(
      [
        "add",
        "--lane=project",
        "--as=agent-42",
        "--body-file=-",
        "--memory-excluded",
        "--json",
        "--",
        "--no-memory-excluded",
      ],
      { stdin: body },
    );
    expect(added.code).toBe(0);
    const task = JSON.parse(added.stdout) as { id: number };
    expect(task).toMatchObject({ title: "--no-memory-excluded", memory_excluded: true, lane: "project", body });
    const hits = await json<{ hits: { id: number }[] }>([
      "memory",
      "search",
      "--boost=project",
      "--limit=3",
      "--json",
      "--",
      "--zircon",
    ]);
    expect(hits.hits.some(hit => hit.id === task.id)).toBe(false);
    expect(await json(["edit", String(task.id), "--json", "--bodySearch=zircon ", "--bodyReplace="])).toMatchObject({
      body: body.replace("zircon ", ""),
    });
    expect((await cli(["memory", "include", String(task.id)])).code).toBe(0);
  });

  test("memory exclude keeps a task out of recall; reading it by id still works", async () => {
    type Row = { id: number; memory_excluded: boolean };
    const kept = (await json<Row>(["add", "gizmo visible notes", "--as", "x-1", "--json"])).id;
    const hidden = (await json<Row>(["add", "gizmo hidden notes", "--as", "x-1", "--json"])).id;
    const hits = async (): Promise<number[]> =>
      (await json<{ hits: Row[] }>(["memory", "search", "gizmo notes", "--json"])).hits.map(h => h.id);
    expect((await hits()).sort()).toEqual([kept, hidden].sort());

    const r = await cli(["memory", "exclude", String(hidden)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`@${hidden} excluded from memory`);
    expect(await hits()).toEqual([kept]);
    // Another author's session: x-1's own streams would never come back as its hits.
    const context = await json<{ hits: Row[]; primerIds: number[] }>([
      "memory",
      "context",
      "--json",
      "--query=gizmo notes",
      "--author=y-1",
    ]);
    expect(context.hits.map(h => h.id)).toEqual([kept]);
    expect(context.primerIds).not.toContain(hidden);

    const shown = await cli(["memory", "show", String(hidden)]);
    expect(shown.code).toBe(0);
    expect(shown.stdout.split("\n")[1]).toContain("excluded from memory");
    expect((await json<{ task: Row }>(["show", String(hidden), "--json"])).task.memory_excluded).toBe(true);
    expect((await json<Row[]>(["memory", "excluded", "--json"])).map(t => t.id)).toEqual([hidden]);
    expect((await json<Row[]>(["memory", "streams", "--author=x-1", "--json"])).map(t => t.id)).toEqual([kept]);
    const all = await json<Row[]>(["memory", "streams", "--author=x-1", "--with-excluded", "--json"]);
    expect(all.find(t => t.id === hidden)?.memory_excluded).toBe(true);

    expect((await cli(["memory", "include", String(hidden)])).code).toBe(0);
    expect((await hits()).sort()).toEqual([kept, hidden].sort());
    expect((await cli(["memory", "excluded"])).stdout).toContain("(no tasks are excluded from memory)");
    const missing = await cli(["memory", "exclude", "999"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("task 999 not found");
  });
});
