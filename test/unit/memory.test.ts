import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  breadcrumbs,
  checkStaleness,
  citedPaths,
  headingSections,
  isoDay,
  laneForCommonDir,
  MEMORY_LIMITS,
  MEMORY_PREAMBLE,
  matchingSections,
  memoryLane,
  memoryPhrases,
  memorySections,
  memoryTerms,
  primerRows,
  recencyIntent,
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
  activity: 0,
  ...over,
});

const stream = (over: Partial<MemoryStream> = {}): MemoryStream => ({
  task: task(),
  updates: [],
  synced: 0,
  syncedUpdateId: 0,
  latest: null,
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

describe("recencyIntent + memoryPhrases", () => {
  test("recency words leave the terms and flag the query; without one the terms are unchanged", () => {
    expect(recencyIntent(memoryTerms("what was I last doing for the routing-events work"))).toEqual({
      terms: ["routing", "events"],
      recent: true,
    });
    expect(recencyIntent(["latest", "today", "currently"])).toEqual({ terms: [], recent: true });
    expect(recencyIntent(["mouse", "wheel"])).toEqual({ terms: ["mouse", "wheel"], recent: false });
  });

  test("memoryPhrases: compounds with two real terms, every part kept for adjacency", () => {
    expect(memoryPhrases("routing-events and wheel.notch_mode")).toEqual([
      ["routing", "events"],
      ["wheel", "notch", "mode"],
    ]);
    // Fewer than two parts under memoryTerms' rules is no phrase (x.y_z, 1.4.2, memory.ts, please-fix,
    // on-call); a qualifying compound keeps its short and stop parts; repeats dedupe case-insensitively.
    expect(
      memoryPhrases(
        "cortex-as-agent-memory x.y_z 1.4.2 src/memory.ts please-fix on-call routing-events-phase-1 ROUTING_EVENTS routing-events",
      ),
    ).toEqual([
      ["cortex", "as", "agent", "memory"],
      ["routing", "events", "phase", "1"],
      ["routing", "events"],
    ]);
    expect(memoryPhrases("plain words only")).toEqual([]);
  });

  test("memoryPhrases caps at MEMORY_LIMITS.phrases", () => {
    const text = Array.from({ length: 8 }, (_, i) => `alpha${i}-beta${i}`).join(" ");
    expect(memoryPhrases(text)).toHaveLength(MEMORY_LIMITS.phrases);
  });
});

describe("headingSections", () => {
  test("splits at headings only, with the reader's slugs (repeats -2, -3) and levels", () => {
    const body = "intro\n## Steps\na\n### Steps\nb\n## Steps\nc\n# Final Notes!\nd";
    expect(headingSections(body)).toEqual([
      { heading: null, slug: "", level: 0, text: "intro" },
      { heading: "Steps", slug: "steps", level: 2, text: "## Steps\na" },
      { heading: "Steps", slug: "steps-2", level: 3, text: "### Steps\nb" },
      { heading: "Steps", slug: "steps-3", level: 2, text: "## Steps\nc" },
      { heading: "Final Notes!", slug: "final-notes", level: 1, text: "# Final Notes!\nd" },
    ]);
  });

  test("never splits by size, skips headings inside fenced code and drops empty leading text", () => {
    const long = "x".repeat(5_000);
    const body = `\n## A\n${long}\n\`\`\`bash\n# not a heading\n\`\`\`\n## B ##`;
    const sections = headingSections(body);
    expect(sections.map(s => s.slug)).toEqual(["a", "b"]);
    expect(sections[0]?.text).toContain("# not a heading");
    expect(sections[1]?.heading).toBe("B");
  });

  test("matchingSections returns each match with its subsections", () => {
    const body = "## 9. Next Steps\n1. a\n### Next detail\nb\n## Notes\nc";
    expect(matchingSections(body, "next")).toEqual([
      { heading: "9. Next Steps", slug: "9-next-steps", text: "## 9. Next Steps\n1. a\n\n### Next detail\nb" },
    ]);
    expect(matchingSections(body, "nope")).toEqual([]);
  });
});

describe("memorySections", () => {
  test("splits at headings and keeps each heading with its section", () => {
    expect(memorySections("intro\n## A\na1\n### B\nb1", 2000)).toEqual(["intro", "## A\na1", "### B\nb1"]);
  });

  test("splits oversized sections at line boundaries; a single long line stays whole", () => {
    const line = "x".repeat(30);
    expect(memorySections([line, line, line].join("\n"), 70)).toEqual([`${line}\n${line}`, line]);
    expect(memorySections("y".repeat(100), 10)).toEqual(["y".repeat(100)]);
  });

  test("empty text is one empty section (title and tags stay indexed)", () => {
    expect(memorySections("", 2000)).toEqual([""]);
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

  test("laneForCommonDir: a common dir named `git` names its parent (~/world/git \u2192 world)", () => {
    expect(laneForCommonDir("/x/world/git")).toBe("world");
    expect(laneForCommonDir("/x/gitlab")).toBe("gitlab");
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
    const s = stream({ task: task({ body: `${FILES}- \`src/gone.ts\`\n` }), synced });
    const staleness = checkStaleness(s, repo, synced + 60_000);
    expect(staleness).toMatchObject({ verdict: "stale", repo: "this", checked: 3, old: false });
    expect(staleness.changed).toEqual(["src/a.ts"]);
    expect(staleness.missing).toEqual(["src/gone.ts"]);
    // From a subdirectory cwd, paths still resolve against the work-tree root.
    expect(checkStaleness(s, path.join(repo, "src", "sub"), synced + 60_000)).toMatchObject({
      changed: ["src/a.ts"],
      missing: ["src/gone.ts"],
    });
  });

  test("recent with unchanged files is fresh; behind counts non-audit breadcrumbs only", () => {
    const synced = Date.now() - 60_000;
    write("src/a.ts", "a", synced - 30_000);
    write("src/b.ts", "b", synced - 30_000);
    const beforeSync = update(synced - 1, "before sync");
    const s = stream({
      task: task({ body: FILES }),
      updates: [beforeSync, update(synced + 1, "did X"), update(synced + 2, "status \u2192 review")],
      synced,
      syncedUpdateId: beforeSync.id,
    });
    expect(checkStaleness(s, repo, synced + 1_000)).toMatchObject({ verdict: "fresh", behind: 1, changed: [] });
  });

  test("a sync older than oldDays is old and stale", () => {
    const now = Date.now();
    const synced = now - 40 * DAY;
    write("src/a.ts", "a", synced - DAY);
    write("src/b.ts", "b", synced - DAY);
    const staleness = checkStaleness(stream({ task: task({ body: FILES }), synced }), repo, now);
    expect(staleness).toMatchObject({ verdict: "stale", old: true, ageDays: 40, changed: [] });
  });

  test("cited files absent from this checkout (fewer than half on disk) or no git checkout is unverifiable", () => {
    const absent = stream({
      task: task({ body: "## Files\n- `lib/x.go`\n- `lib/y.go`\n- `src/a.ts`\n" }),
      synced: Date.now(),
    });
    expect(checkStaleness(absent, repo)).toMatchObject({ verdict: "unverifiable", repo: "other", checked: 0 });
    expect(checkStaleness(stream({ task: task({ body: FILES }) }), plain)).toMatchObject({
      verdict: "unverifiable",
      repo: "none",
    });
  });

  test("the lane is not consulted: a stream of another lane whose files are here is checked", () => {
    const synced = Date.now() - 60_000;
    write("src/a.ts", "a", synced - 30_000);
    write("src/b.ts", "b", synced - 30_000);
    const other = stream({ task: task({ lane: "elsewhere", body: `${FILES}- \`src/gone.ts\`\n` }), synced });
    // 2 of 3 on disk: checked, and the vanished one is missing.
    expect(checkStaleness(other, repo, synced + 1_000)).toMatchObject({
      verdict: "stale",
      repo: "this",
      checked: 3,
      missing: ["src/gone.ts"],
    });
    // No cited files: nothing to check, so fresh from any checkout.
    expect(
      checkStaleness(stream({ task: task({ lane: "elsewhere", body: "state" }), synced }), repo, synced + 1_000),
    ).toMatchObject({ verdict: "fresh", repo: "this", checked: 0 });
  });
});

describe("rendering", () => {
  const now = Date.UTC(2026, 8, 29);

  test("renderPrimer is empty without streams and otherwise opens with the preamble", () => {
    expect(renderPrimer({ lane: "l", active: [], authored: [], elsewhere: [], now })).toBe("");
    const text = renderPrimer({ lane: "l", active: [row({ synced: now, activity: now })], authored: [], now });
    expect(text.split("\n")[0]).toBe(MEMORY_PREAMBLE);
    expect(text).toContain(`active ${isoDay(now)} \u00b7 a stream`);
    expect(text).not.toContain("synced");
    expect(text).not.toContain("Streams you touched");
    expect(text).not.toContain("other lanes");
  });

  test("renderPrimer lists touched streams first, never repeats them, caps and counts the rest", () => {
    const active = Array.from({ length: 9 }, (_, i) =>
      row({ id: i + 1, title: `s${i + 1}`, synced: now, activity: now }),
    );
    const authored = [row({ id: 1, title: "s1", synced: now - 40 * DAY, activity: now })];
    const text = renderPrimer({ lane: "l", author: "pi-x", active, authored, now });
    expect(text).toContain("your author tag pi-x");
    expect(text).toContain("Streams you touched:\n- [1] open");
    expect(text).toContain("active 2026-09-29 \u00b7 synced 2026-08-20 \u00b7 old");
    expect(text.match(/- \[1\]/g)).toHaveLength(1);
    expect(text).toContain(`(+${8 - MEMORY_LIMITS.primerStreams} more: cortex ls -l l)`);
  });

  test("renderPrimer lists streams recently active in other lanes last, capped, never a touched one", () => {
    const elsewhere = Array.from({ length: 5 }, (_, i) =>
      row({ id: 20 + i, lane: "infra", title: `e${i}`, activity: now }),
    );
    const authored = [row({ id: 20, lane: "infra", title: "e0", activity: now })];
    const text = renderPrimer({ lane: "l", active: [row({ activity: now })], authored, elsewhere, now });
    const lines = text.split("\n");
    const at = lines.indexOf("Recently active in other lanes:");
    expect(at).toBeGreaterThan(lines.indexOf("Active streams (newest activity first):"));
    expect(lines.slice(at + 1).map(line => line.slice(0, 6))).toEqual(["- [21]", "- [22]", "- [23]"]);
    expect(MEMORY_LIMITS.elsewhereStreams).toBe(3);
    // Only other-lane streams still make a primer.
    expect(renderPrimer({ lane: "l", active: [], authored: [], elsewhere, now })).toContain("- [20] open \u00b7 infra");
  });

  test("primerRows are exactly the rows renderPrimer prints: deduped against touched, capped, the overflow counted", () => {
    const cap = MEMORY_LIMITS.primerStreams;
    const authored = Array.from({ length: cap + 2 }, (_, i) => row({ id: 100 + i, title: `t${i}`, activity: now }));
    const active = [
      row({ id: 100, title: "t0", activity: now }),
      ...Array.from({ length: cap + 3 }, (_, i) => row({ id: 1 + i, title: `a${i}`, activity: now })),
    ];
    const elsewhere = [
      row({ id: 101, lane: "infra", title: "t1", activity: now }),
      ...Array.from({ length: 5 }, (_, i) => row({ id: 200 + i, lane: "infra", title: `e${i}`, activity: now })),
    ];
    const input = { lane: "l", active, authored, elsewhere, now };
    const rows = primerRows(input);
    expect(rows.touched.map(r => r.id)).toEqual(authored.slice(0, cap).map(r => r.id));
    expect(rows.active.map(r => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.more).toBe(3);
    expect(rows.elsewhere.map(r => r.id)).toEqual([200, 201, 202]);
    // renderPrimer prints exactly these rows, in this order, and the overflow line.
    const text = renderPrimer(input);
    const printed = [...text.matchAll(/^- \[(\d+)\]/gm)].map(m => Number(m[1]));
    expect(printed).toEqual([...rows.touched, ...rows.active, ...rows.elsewhere].map(r => r.id));
    expect(text).toContain("(+3 more: cortex ls -l l)");
    expect(primerRows({ lane: "l", active: [], authored: [], now })).toEqual({
      touched: [],
      active: [],
      elsewhere: [],
      more: 0,
    });
  });

  test("renderHits is empty without hits; the header names the query, each hit its own matched terms (validation F2)", () => {
    expect(renderHits(["mouse"], [], now)).toBe("");
    const hit: MemoryHit = {
      ...row({ id: 4, synced: now - DAY, activity: now }),
      score: 1,
      matched: ["mouse"],
      snippet: "the **mouse**",
      latest: null,
    };
    const text = renderHits(["mouse", "wheel"], [hit], now);
    expect(text.split("\n")[0]).toBe(MEMORY_PREAMBLE);
    expect(text).toContain("(query: mouse, wheel). Load one with `cortex memory show <id>` before relying on it.");
    expect(text).not.toContain("matched: mouse, wheel");
    expect(text).toContain(
      "- [4] open \u00b7 l \u00b7 active 2026-09-29 \u00b7 synced 2026-09-28 \u00b7 a stream (1/2: mouse) \u2014 the **mouse**",
    );
  });

  test("renderHits names recency ordering, the load hint and a hit's latest linked stream", () => {
    const hit: MemoryHit = {
      ...row({ id: 4, synced: now, activity: now }),
      score: 1,
      matched: ["routing", "events"],
      snippet: "s",
      latest: { id: 9, status: "review", activity: now + DAY },
    };
    const text = renderHits(["routing", "events"], [hit], now, { recent: true, loadHint: 'cortex_recall "@<id>"' });
    expect(text).toContain('(query: routing, events, newest first). Load one with `cortex_recall "@<id>"` before');
    expect(text).toContain("a stream \u00b7 latest linked @9 (review, active 2026-09-30) (2/2: routing, events)");
  });

  test("renderStream prints a short body unchanged and names the latest linked stream", () => {
    const body = "## Goal\ng\n## Next\nn";
    const s = stream({ task: task({ body }), latest: { id: 9, status: "open", activity: now } });
    const text = renderStream(s, checkStaleness(s, plain, now));
    expect(text.split("\n")[1]).toBe(
      "[7] TUI mouse wheel (open \u00b7 myrepo) \u00b7 latest linked @9 (open, active 2026-09-29)",
    );
    expect(text).toContain(`\n${body}\n`);
    expect(text).not.toContain("Contents:");
    expect(text).toContain("not in a git checkout");
  });

  test("renderStream leads a long body with Next, open questions and Decisions, then a Contents line", () => {
    const filler = `${"x".repeat(199)}\n`.repeat(40);
    const body = [
      "# Handover",
      "intro",
      "## 1. Context",
      filler,
      "## 2. Decisions",
      "- keep it",
      "### 2.1 Rejected",
      "- a relation table",
      "## 3. Notes",
      filler,
      "## 9. Next Steps",
      "1. ship it",
      "## Open questions",
      "- none",
    ].join("\n");
    expect(body.length).toBeGreaterThan(MEMORY_LIMITS.showBodyChars);
    const s = stream({ task: task({ body }) });
    const text = renderStream(s, checkStaleness(s, plain, now));
    const next = text.indexOf("## 9. Next Steps\n1. ship it");
    expect(next).toBeGreaterThan(0);
    expect(text.indexOf("## Open questions")).toBeGreaterThan(next);
    expect(text.indexOf("## 2. Decisions")).toBeGreaterThan(text.indexOf("## Open questions"));
    expect(text).toContain("### 2.1 Rejected\n- a relation table"); // subsections travel with their section
    expect(text).not.toContain("xxxx");
    expect(text).toContain("Contents: #handover #1-context #3-notes (cortex memory show 7 --section=<text>)");
  });

  test("renderStream cuts the section that crosses the budget; a long headingless body is truncated", () => {
    const long = `## Next\n${`${"y".repeat(99)}\n`.repeat(200)}`;
    const cut = renderStream(stream({ task: task({ body: long }) }), checkStaleness(stream(), plain, now));
    expect(cut).toContain("\u2026 (#next continues)");
    const flat = stream({ task: task({ body: "x".repeat(MEMORY_LIMITS.showBodyChars + 5) }) });
    const text = renderStream(flat, checkStaleness(flat, plain, now));
    expect(text).toContain(`${"x".repeat(MEMORY_LIMITS.showBodyChars)}\n\u2026 (truncated; cortex show 7)`);
  });

  test("renderStream --section prints only the matching sections, or lists the sections", () => {
    const body = "## Goal\ng\n## 9. Next Steps\n1. a\n### Next detail\nb\n## Notes\nc";
    const s = stream({ task: task({ body }) });
    const staleness = checkStaleness(s, plain, now);
    const text = renderStream(s, staleness, { section: "next" });
    expect(text).toContain("## 9. Next Steps\n1. a\n\n### Next detail\nb\n");
    expect(text).not.toContain("## Goal");
    expect(text).not.toContain("## Notes");
    expect(renderStream(s, staleness, { section: "Open Questions" })).toContain(
      "No section matches 'Open Questions'; sections: #goal #9-next-steps #next-detail #notes",
    );
  });

  test("renderStream caps the trail and reports cited files from another checkout", () => {
    const synced = now - DAY;
    const updates = Array.from({ length: 13 }, (_, i) => update(synced + i + 1, `step ${i + 1}`));
    const s = stream({ task: task({ body: "## Files\n- `lib/x.go`\n" }), updates, synced });
    const text = renderStream(s, checkStaleness(s, repo, now));
    expect(text.split("\n")[0]).toBe(MEMORY_PREAMBLE);
    expect(text).toContain("staleness: unverifiable");
    expect(text).toContain("cited files are not in this checkout");
    expect(text).toContain("Since last sync (2026-09-28): 13 updates (13 not yet folded into the body)");
    expect(text).toContain(`(+${13 - MEMORY_LIMITS.trail} earlier since sync; cortex show 7)`);
    expect(text).toContain("step 13");
    expect(text).not.toContain("step 3\n");
  });

  test("renderStream says when nothing happened since the sync", () => {
    const before = update(1, "before");
    const s = stream({ task: task({ body: "state" }), updates: [before], synced: 5, syncedUpdateId: before.id });
    expect(renderStream(s, checkStaleness(s, plain, now))).toContain("No updates since the last sync.");
  });
});
