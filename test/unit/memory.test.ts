import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  breadcrumbs,
  checkStaleness,
  citedPaths,
  isoDay,
  laneForCommonDir,
  MEMORY_LIMITS,
  MEMORY_PREAMBLE,
  memoryLane,
  memoryTerms,
  renderHits,
  renderPrimer,
  renderStream,
  repoInfo,
} from "../../src/memory.ts";
import type { MemoryHit, MemoryStream, MemoryStreamRow, Task, Update } from "../../src/store.ts";

// Hermetic: every git fixture lives under one mkdtemp root; commits never
// sign and never read the developer's identity. Staleness is made
// deterministic with fs.utimesSync against a fake `synced`, never sleeps.

const DAY = 86_400_000;
let root: string;
let repo: string;
let worktree: string;
let plain: string;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function write(rel: string, text: string, mtimeMs?: number): void {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-memory-test-"));
  repo = path.join(root, "myrepo");
  worktree = path.join(root, "myrepo-wt");
  plain = path.join(root, "plain-dir");
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  git(repo, "init", "-q");
  write("src/a.ts", "a");
  write("src/b.ts", "b");
  write("src/sub/c.ts", "c");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "baseline");
  git(repo, "worktree", "add", "-q", worktree);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const task = (over: Partial<Task> = {}): Task => ({
  id: 7,
  lane: "myrepo",
  title: "TUI mouse wheel",
  body: null,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  ...over,
});

let nextUpdateId = 1;
const update = (created: number, summary: string): Update => ({
  id: nextUpdateId++,
  task_id: 7,
  author: "pi-x",
  summary,
  body: null,
  severity: "progress",
  created,
});

const row = (over: Partial<MemoryStreamRow> = {}): MemoryStreamRow => ({
  id: 1,
  title: "a stream",
  lane: "l",
  status: "open",
  tags: [],
  updated: 0,
  synced: 0,
  ...over,
});

const FILES = "## Files\n- `src/a.ts`\n- `src/b.ts`\n";

describe("memoryTerms", () => {
  test("lowercases, splits like unicode61, and drops punctuation-only input", () => {
    expect(memoryTerms("TUI Mouse wheel_notch?!")).toEqual(["tui", "mouse", "wheel", "notch"]);
    expect(memoryTerms("?? !! ...")).toEqual([]);
  });

  test("drops stopwords, short tokens and all-digit tokens; keeps mixed alphanumerics", () => {
    expect(memoryTerms("please continue the work on it 305 fts5")).toEqual(["fts5"]);
  });

  test("dedupes in first-seen order and caps at MEMORY_LIMITS.terms", () => {
    expect(memoryTerms("zeta alpha zeta beta alpha")).toEqual(["zeta", "alpha", "beta"]);
    const many = Array.from({ length: 40 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${i}`).join(" ");
    expect(memoryTerms(many)).toHaveLength(MEMORY_LIMITS.terms);
  });
});

describe("citedPaths", () => {
  test("reads only Files / Beginning context sections", () => {
    const body =
      "Prose cites `src/prose.ts`.\n## Files\n- `src/a.ts`\n## Next\n- `src/next.ts`\n### Beginning context\n- `src/b.ts`";
    expect(citedPaths(body)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(citedPaths("no sections `src/a.ts`")).toEqual([]);
    expect(citedPaths(null)).toEqual([]);
  });

  test("keeps paths and known file names, strips line suffixes and ./, rejects non-paths", () => {
    const body = [
      "## Files",
      "- `src/a.ts:12-20` `AGENTS.md` `src/tui/` `./src/b.ts` `src/a.ts`",
      "- `Store.open` `1.4.2` `@scope/pkg` `https://x.dev/a.ts` `/abs/p.ts` `../up.ts` `a b.ts` `~/x.ts`",
    ].join("\n");
    expect(citedPaths(body)).toEqual(["src/a.ts", "AGENTS.md", "src/tui/", "src/b.ts"]);
  });

  test("caps at MEMORY_LIMITS.citedPaths", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- \`src/f${i}.ts\``);
    expect(citedPaths(`## Files\n${lines.join("\n")}`)).toHaveLength(MEMORY_LIMITS.citedPaths);
  });
});

describe("lanes", () => {
  test("laneForCommonDir names the repo for .git, dot-dir (.bare) and bare layouts", () => {
    expect(laneForCommonDir("/x/proj/.git")).toBe("proj");
    expect(laneForCommonDir("/x/proj/.bare")).toBe("proj");
    expect(laneForCommonDir("/x/proj.git")).toBe("proj");
    expect(laneForCommonDir("/x/proj")).toBe("proj");
  });

  test("repoInfo/memoryLane: a repo, its subdirectory and a worktree share the main repo's lane", () => {
    expect(memoryLane(repo)).toBe("myrepo");
    expect(repoInfo(path.join(repo, "src", "sub"))?.lane).toBe("myrepo");
    expect(memoryLane(worktree)).toBe("myrepo");
    expect(fs.realpathSync(repoInfo(worktree)?.root ?? "")).toBe(fs.realpathSync(worktree));
  });

  test("a non-git directory falls back to its basename", () => {
    expect(repoInfo(plain)).toBeNull();
    expect(memoryLane(plain)).toBe("plain-dir");
  });
});

describe("breadcrumbs + checkStaleness", () => {
  test("breadcrumbs are the updates after the sync's watermark, oldest first, status audits included", () => {
    const before = update(10, "old");
    const updates = [before, update(30, "progress"), update(40, "status \u2192 review")];
    expect(breadcrumbs(updates, before.id).map(u => u.summary)).toEqual(["progress", "status \u2192 review"]);
  });

  test("a post in the same millisecond as the sync counts only when it came after it (review @418 F2)", () => {
    const earlier = update(500, "same ms, before the sync");
    const later = update(500, "same ms, after the sync");
    expect(breadcrumbs([earlier, later], earlier.id).map(u => u.summary)).toEqual(["same ms, after the sync"]);
  });

  test("a cited file modified after the sync is changed; an older one is not; a vanished one is missing", () => {
    const synced = Date.now() - 60_000;
    write("src/a.ts", "a2", synced + 30_000);
    write("src/b.ts", "b", synced - 30_000);
    const stream: MemoryStream = {
      task: task({ body: `${FILES}- \`src/gone.ts\`\n` }),
      updates: [],
      synced,
      syncedUpdateId: 0,
    };
    const staleness = checkStaleness(stream, repo, synced + 60_000);
    expect(staleness).toMatchObject({ verdict: "stale", repo: "this", checked: 3, old: false });
    expect(staleness.changed).toEqual(["src/a.ts"]);
    expect(staleness.missing).toEqual(["src/gone.ts"]);
    // From a subdirectory cwd, paths still resolve against the work-tree root.
    expect(checkStaleness(stream, path.join(repo, "src", "sub"), synced + 60_000)).toMatchObject({
      changed: ["src/a.ts"],
      missing: ["src/gone.ts"],
    });
  });

  test("recent with unchanged files is fresh; behind counts non-audit breadcrumbs only", () => {
    const synced = Date.now() - 60_000;
    write("src/a.ts", "a", synced - 30_000);
    write("src/b.ts", "b", synced - 30_000);
    const beforeSync = update(synced - 1, "before sync");
    const stream: MemoryStream = {
      task: task({ body: FILES }),
      updates: [beforeSync, update(synced + 1, "did X"), update(synced + 2, "status \u2192 review")],
      synced,
      syncedUpdateId: beforeSync.id,
    };
    expect(checkStaleness(stream, repo, synced + 1_000)).toMatchObject({ verdict: "fresh", behind: 1, changed: [] });
  });

  test("a sync older than oldDays is old and stale", () => {
    const now = Date.now();
    const synced = now - 40 * DAY;
    write("src/a.ts", "a", synced - DAY);
    write("src/b.ts", "b", synced - DAY);
    const staleness = checkStaleness(
      { task: task({ body: FILES }), updates: [], synced, syncedUpdateId: 0 },
      repo,
      now,
    );
    expect(staleness).toMatchObject({ verdict: "stale", old: true, ageDays: 40, changed: [] });
  });

  test("another lane or no git checkout is unverifiable", () => {
    const stream: MemoryStream = {
      task: task({ lane: "elsewhere", body: FILES }),
      updates: [],
      synced: Date.now(),
      syncedUpdateId: 0,
    };
    expect(checkStaleness(stream, repo)).toMatchObject({ verdict: "unverifiable", repo: "other", checked: 0 });
    expect(checkStaleness({ ...stream, task: task({ body: FILES }) }, plain)).toMatchObject({
      verdict: "unverifiable",
      repo: "none",
    });
  });
});

describe("rendering", () => {
  const now = Date.UTC(2026, 8, 29);

  test("renderPrimer is empty without streams and otherwise opens with the preamble", () => {
    expect(renderPrimer({ lane: "l", active: [], authored: [], now })).toBe("");
    const text = renderPrimer({ lane: "l", active: [row({ synced: now })], authored: [], now });
    expect(text.split("\n")[0]).toBe(MEMORY_PREAMBLE);
    expect(text).toContain(`synced ${isoDay(now)}`);
    expect(text).not.toContain("Streams you touched");
  });

  test("renderPrimer lists touched streams first, never repeats them, caps and counts the rest", () => {
    const active = Array.from({ length: 9 }, (_, i) => row({ id: i + 1, title: `s${i + 1}`, synced: now }));
    const authored = [row({ id: 1, title: "s1", synced: now - 40 * DAY })];
    const text = renderPrimer({ lane: "l", author: "pi-x", active, authored, now });
    expect(text).toContain("your author tag pi-x");
    expect(text).toContain("Streams you touched:\n- [1] open");
    expect(text).toContain("synced 2026-08-20 \u00b7 old");
    expect(text.match(/- \[1\]/g)).toHaveLength(1);
    expect(text).toContain(`(+${8 - MEMORY_LIMITS.primerStreams} more: cortex ls -l l)`);
  });

  test("renderHits is empty without hits and names the matched terms and snippets", () => {
    expect(renderHits(["mouse"], [], now)).toBe("");
    const hit: MemoryHit = { ...row({ id: 4, synced: now }), score: 1, matched: ["mouse"], snippet: "the **mouse**" };
    const text = renderHits(["mouse", "wheel"], [hit], now);
    expect(text.split("\n")[0]).toBe(MEMORY_PREAMBLE);
    expect(text).toContain("matched: mouse, wheel");
    expect(text).toContain("- [4] open \u00b7 l \u00b7 synced 2026-09-29 \u00b7 a stream \u2014 the **mouse**");
  });

  test("renderStream truncates long bodies and caps the trail", () => {
    const synced = now - DAY;
    const updates = Array.from({ length: 13 }, (_, i) => update(synced + i + 1, `step ${i + 1}`));
    const stream: MemoryStream = {
      task: task({ body: "x".repeat(MEMORY_LIMITS.showBodyChars + 5) }),
      updates,
      synced,
      syncedUpdateId: 0,
    };
    const text = renderStream(stream, checkStaleness(stream, plain, now));
    expect(text.split("\n")[0]).toBe(MEMORY_PREAMBLE);
    expect(text).toContain("(truncated; cortex show 7)");
    expect(text).toContain("Since last sync (2026-09-28): 13 updates (13 not yet folded into the body)");
    expect(text).toContain(`(+${13 - MEMORY_LIMITS.trail} earlier since sync; cortex show 7)`);
    expect(text).toContain("step 13");
    expect(text).not.toContain("step 3\n");
  });

  test("renderStream says when nothing happened since the sync", () => {
    const before = update(1, "before");
    const stream: MemoryStream = {
      task: task({ body: "state" }),
      updates: [before],
      synced: 5,
      syncedUpdateId: before.id,
    };
    expect(renderStream(stream, checkStaleness(stream, plain, now))).toContain("No updates since the last sync.");
  });
});
