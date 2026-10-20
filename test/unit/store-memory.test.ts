// store-memory.test.ts — agent memory in the Store (plan @414): the body-sync
// record (`_body_edits`), the derived section-level FTS5 index
// (`_memory_sections` / `_memory_section_map`, created on first search and
// reconciled on every search)
// and the bodiless stream reads. Hermetic: Store.open(":memory:").

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { breadcrumbs, MEMORY_LIMITS } from "../../src/memory.ts";
import { Store } from "../../src/store.ts";

const open = () => Store.open(":memory:");

afterEach(() => {
  setSystemTime(); // back to the real clock
});

const at = (ms: number): void => {
  setSystemTime(new Date(ms));
};

const hasTable = (s: Store, name: string): boolean =>
  s.runInTransaction(raw => raw.query("SELECT 1 FROM sqlite_master WHERE name = ?;").get(name) !== null);

const ids = (hits: { id: number }[]): number[] => hits.map(hit => hit.id);

describe("body sync (_body_edits)", () => {
  test("only real body changes move synced; every other write leaves it alone", () => {
    const s = open();
    at(1_000);
    const t = s.addTask({ title: "stream", body: "v1", lane: "l" });
    expect(s.memoryStream(t.id)?.synced).toBe(1_000);

    at(2_000);
    s.editTask(t.id, { title: "renamed" });
    at(2_100);
    s.moveTask(t.id, "other");
    at(2_200);
    s.setStatus(t.id, "review", { author: "pi-x" });
    at(2_300);
    s.postUpdate({ task_id: t.id, author: "pi-x", summary: "progress", status: "blocked" });
    at(2_400);
    s.changeTaskTags(t.id, { add: ["topic"] });
    at(2_500);
    s.addUpdate({ task_id: t.id, author: "pi-x", summary: "more progress" });
    expect(s.memoryStream(t.id)?.synced).toBe(1_000);

    at(3_000);
    s.editTask(t.id, { body: "v2" });
    expect(s.memoryStream(t.id)?.synced).toBe(3_000);
    at(4_000);
    s.editTask(t.id, { body: "v2" }); // unchanged text is not a sync
    expect(s.memoryStream(t.id)?.synced).toBe(3_000);
    at(5_000);
    s.editTask(t.id, { bodySearch: "v2", bodyReplace: "v3" });
    expect(s.memoryStream(t.id)?.synced).toBe(5_000);
  });

  test("a task without a body-sync record falls back to created", () => {
    const s = open();
    at(1_000);
    const t = s.addTask({ title: "legacy" });
    at(9_000);
    s.editTask(t.id, { body: "later" });
    s.runInTransaction(raw => raw.run("DELETE FROM _body_edits WHERE task_id = ?;", [t.id]));
    expect(s.memoryStream(t.id)?.synced).toBe(1_000);
    expect(s.memoryStreams().find(row => row.id === t.id)?.synced).toBe(1_000);
    s.addUpdate({ task_id: t.id, author: "pi-x", summary: "after creation" });
    const stream = s.memoryStream(t.id);
    expect(stream?.syncedUpdateId).toBe(0);
    expect(breadcrumbs(stream?.updates ?? [], stream?.syncedUpdateId ?? 0).map(u => u.summary)).toEqual([
      "after creation",
    ]);
  });

  test("breadcrumbs follow the update-id watermark: a same-millisecond post after the sync counts (review @418 F2)", () => {
    const s = open();
    at(7_000);
    const t = s.addTask({ title: "stream", body: "v1", author: "pi-x" });
    const created = s.memoryStream(t.id);
    expect(breadcrumbs(created?.updates ?? [], created?.syncedUpdateId ?? 0)).toEqual([]); // `created` is not a breadcrumb
    at(8_000);
    s.addUpdate({ task_id: t.id, author: "pi-x", summary: "before the sync" });
    at(9_000);
    s.editTask(t.id, { body: "v2" });
    s.addUpdate({ task_id: t.id, author: "pi-x", summary: "after the sync" }); // the same millisecond as the edit
    const stream = s.memoryStream(t.id);
    expect(stream?.synced).toBe(9_000);
    expect(breadcrumbs(stream?.updates ?? [], stream?.syncedUpdateId ?? 0).map(u => u.summary)).toEqual([
      "after the sync",
    ]);
  });

  test("removeTask deletes the record; forgetBodySync falls a task back to created (review @418 F1)", () => {
    const s = open();
    at(1_000);
    const a = s.addTask({ title: "a" });
    const b = s.addTask({ title: "b" });
    at(9_000);
    s.editTask(a.id, { body: "x" });
    s.editTask(b.id, { body: "y" });
    s.removeTask(a.id);
    const rows = s.runInTransaction(raw => raw.query("SELECT task_id FROM _body_edits ORDER BY task_id;").all());
    expect(rows).toEqual([{ task_id: b.id }]);
    s.forgetBodySync([b.id]);
    expect(s.memoryStream(b.id)?.synced).toBe(1_000);
  });
});

describe("Store.searchMemory", () => {
  test("no terms → no hits, and the index is created by the first search only", () => {
    const s = open();
    s.addTask({ title: "mouse wheel" });
    expect(s.searchMemory([])).toEqual([]);
    expect(hasTable(s, "_memory_sections")).toBe(false);
    expect(ids(s.searchMemory(["mouse"]))).toHaveLength(1);
    expect(hasTable(s, "_memory_sections")).toBe(true);
    expect(hasTable(s, "_memory_section_map")).toBe(true);
  });

  test("title/tag matches outrank body-only matches; hits carry matched terms, snippet and synced", () => {
    const s = open();
    const body = s.addTask({ title: "unrelated", body: "notes about the mouse wheel handler" });
    const title = s.addTask({ title: "Mouse wheel handler" });
    const hits = s.searchMemory(["mouse", "wheel"]);
    expect(ids(hits)).toEqual([title.id, body.id]);
    expect(hits[0]?.matched).toEqual(["mouse", "wheel"]);
    expect(hits[0]?.snippet).toContain("**");
    expect(hits[0]?.synced).toBe(title.created);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  test("porter stemming matches word forms", () => {
    const s = open();
    const t = s.addTask({ title: "Smooth scrolling" });
    expect(ids(s.searchMemory(["scroll"]))).toEqual([t.id]);
  });

  test("coverage: a task matching fewer than min(terms, 2) distinct terms is dropped", () => {
    const s = open();
    const both = s.addTask({ title: "mouse wheel" });
    const one = s.addTask({ title: "mouse trap" });
    expect(ids(s.searchMemory(["mouse", "wheel", "trackpad"]))).toEqual([both.id]);
    expect(ids(s.searchMemory(["mouse"])).sort()).toEqual([both.id, one.id].sort());
    expect(s.searchMemory(["wheel", "mouse"])[0]?.matched).toEqual(["wheel", "mouse"]);
  });

  test("coverage counts stems, not terms: word forms of one stem are one group (validation F1)", () => {
    const s = open();
    const doc = s.addTask({ title: "rollout", body: "notes on the implementation" });
    s.addTask({ title: "zebra crossing" });
    const terms = ["implement", "implementer", "zebra"];
    // implement + implementer both match `implementation`: ONE of the two groups needed.
    expect(s.searchMemory(terms)).toEqual([]);
    s.editTask(doc.id, { body: "notes on the implementation of the zebra" });
    const hits = s.searchMemory(terms);
    expect(ids(hits)).toEqual([doc.id]);
    expect(hits[0]?.matched).toEqual(terms);
  });

  test("lane, exclude and limit (clamped to [1, maxHits])", () => {
    const s = open();
    const a = s.addTask({ title: "gizmo alpha", lane: "one" });
    const b = s.addTask({ title: "gizmo beta", lane: "two" });
    expect(ids(s.searchMemory(["gizmo"], { lane: "two" }))).toEqual([b.id]);
    expect(ids(s.searchMemory(["gizmo"], { exclude: [b.id] }))).toEqual([a.id]);
    for (let i = 0; i < 25; i++) s.addTask({ title: `gizmo ${i}` });
    expect(s.searchMemory(["gizmo"], { limit: 0 })).toHaveLength(1);
    expect(s.searchMemory(["gizmo"], { limit: 99 })).toHaveLength(MEMORY_LIMITS.maxHits);
    expect(s.searchMemory(["gizmo"])).toHaveLength(MEMORY_LIMITS.hits);
  });
});

describe("section-level coverage", () => {
  test("terms scattered across sections do not qualify a task; co-occurring terms (or a title term) do", () => {
    const s = open();
    const scattered = s.addTask({ title: "long plan", body: "## Alpha\nzebra notes\n## Beta\nquokka notes" });
    const together = s.addTask({ title: "short note", body: "## Gamma\nzebra and quokka together" });
    const titled = s.addTask({ title: "zebra handbook", body: "## Delta\nquokka care" });
    const hits = ids(s.searchMemory(["zebra", "quokka"]));
    expect(hits).toContain(together.id);
    expect(hits).toContain(titled.id);
    expect(hits).not.toContain(scattered.id);
    // A single-term query still finds every task that has the term anywhere.
    expect(ids(s.searchMemory(["quokka"])).sort()).toEqual([scattered.id, together.id, titled.id].sort());
  });

  test("matched terms and the snippet come from the best section", () => {
    const s = open();
    const t = s.addTask({ title: "stream", body: "## One\nwidget only\n## Two\nwidget and sprocket" });
    const [hit] = s.searchMemory(["widget", "sprocket"]);
    expect(hit?.id).toBe(t.id);
    expect(hit?.matched).toEqual(["widget", "sprocket"]);
    expect(hit?.snippet).toContain("**sprocket**");
  });

  test("the snippet comes from the section text, never the tags column (validation F3)", () => {
    const s = open();
    const t = s.addTask({ title: "stream", body: "the wheel handler moves one notch", tags: ["wheel"] });
    const [hit] = s.searchMemory(["wheel", "notch"]);
    expect(hit?.id).toBe(t.id);
    expect(hit?.snippet).toContain("**wheel** handler");
    expect(hit?.snippet).toContain("**notch**");
  });

  test("a title/tag-only match falls back to a title snippet, not tag names (validation F3)", () => {
    const s = open();
    const t = s.addTask({ title: "Scrolling notes", body: "unrelated body text", tags: ["mouse-wheel"] });
    const [hit] = s.searchMemory(["mouse", "wheel"]);
    expect(hit?.id).toBe(t.id);
    expect(hit?.snippet).toBe("Scrolling notes");
    const [titled] = s.searchMemory(["scrolling", "mouse"]);
    expect(titled?.snippet).toBe("**Scrolling** notes");
  });

  test("re-indexing replaces a task's sections without leftovers; removal drops them", () => {
    const s = open();
    const t = s.addTask({ title: "stream", body: "## A\none\n## B\ntwo\n## C\nthree" });
    const sections = (): number =>
      s.runInTransaction(
        raw =>
          raw.query<{ n: number }, [number]>("SELECT count(*) AS n FROM _memory_sections WHERE task_id = ?;").get(t.id)
            ?.n ?? 0,
      );
    s.searchMemory(["warmup"]);
    expect(sections()).toBe(3);
    s.editTask(t.id, { body: "flat body" });
    s.searchMemory(["warmup"]);
    expect(sections()).toBe(1);
    s.removeTask(t.id);
    s.searchMemory(["warmup"]);
    expect(sections()).toBe(0);
  });

  test("a legacy whole-document index is dropped and rebuilt as sections", () => {
    const s = open();
    const t = s.addTask({ title: "mouse wheel" });
    s.runInTransaction(raw => {
      raw.run("CREATE VIRTUAL TABLE _memory_fts USING fts5(title, tags, body, log);");
      raw.run("CREATE TABLE _memory_index (task_id INTEGER PRIMARY KEY, sig TEXT NOT NULL) WITHOUT ROWID;");
    });
    expect(ids(s.searchMemory(["mouse", "wheel"]))).toEqual([t.id]);
    expect(hasTable(s, "_memory_fts")).toBe(false);
    expect(hasTable(s, "_memory_index")).toBe(false);
  });
});

describe("reconcile-on-read", () => {
  test("an edit in the same millisecond as the last search is still indexed (entity token)", () => {
    const s = open();
    at(50_000);
    const t = s.addTask({ title: "stream", body: "about widgets" });
    expect(ids(s.searchMemory(["widgets"]))).toEqual([t.id]);
    s.editTask(t.id, { body: "about sprockets" }); // same `updated` as the indexed row
    expect(ids(s.searchMemory(["sprockets"]))).toEqual([t.id]);
    expect(s.searchMemory(["widgets"])).toEqual([]);
  });

  test("update summaries are indexed; status audits and attributed `created` rows are not", () => {
    const s = open();
    const t = s.addTask({ title: "stream", author: "pi-x" });
    s.searchMemory(["warmup"]);
    s.addUpdate({ task_id: t.id, author: "pi-x", summary: "tuned the flux capacitor" });
    s.setStatus(t.id, "review", { author: "pi-x" });
    expect(ids(s.searchMemory(["flux", "capacitor"]))).toEqual([t.id]);
    expect(s.searchMemory(["review"])).toEqual([]);
    expect(s.searchMemory(["created"])).toEqual([]);
  });

  test("tag additions and renames are indexed; removed tasks leave the index", () => {
    const s = open();
    const t = s.addTask({ title: "stream" });
    s.searchMemory(["warmup"]);
    s.changeTaskTags(t.id, { add: ["gizmo"] });
    expect(ids(s.searchMemory(["gizmo"]))).toEqual([t.id]);
    s.editTag("gizmo", { rename: "widget" });
    expect(ids(s.searchMemory(["widget"]))).toEqual([t.id]);
    expect(s.searchMemory(["gizmo"])).toEqual([]);
    s.removeTask(t.id);
    expect(s.searchMemory(["widget"])).toEqual([]);
    expect(s.searchMemory(["stream"])).toEqual([]);
  });
});

describe("Store.memoryStreams / memoryStream", () => {
  test("lane, author and active filters, newest activity first, bodiless rows", () => {
    const s = open();
    at(1_000);
    const a = s.addTask({ title: "a", lane: "l", body: "secret body" });
    at(2_000);
    const b = s.addTask({ title: "b", lane: "l" });
    at(3_000);
    const c = s.addTask({ title: "c", lane: "other" });
    at(4_000);
    s.setStatus(b.id, "done");
    s.addUpdate({ task_id: c.id, author: "pi-x", summary: "touched" });
    expect(ids(s.memoryStreams({ lane: "l" }))).toEqual([b.id, a.id]);
    expect(ids(s.memoryStreams({ lane: "l", active: true }))).toEqual([a.id]);
    expect(ids(s.memoryStreams({ author: "pi-x" }))).toEqual([c.id]);
    const [row] = s.memoryStreams({ lane: "l", active: true });
    expect(row).toEqual({
      id: a.id,
      title: "a",
      lane: "l",
      status: "open",
      updated: 1_000,
      synced: 1_000,
      activity: 1_000,
      tags: [],
      memory_excluded: false,
    });
    expect(Object.keys(row ?? {})).not.toContain("body");
  });

  test("memoryStream returns the task, its updates and synced; null when missing", () => {
    const s = open();
    const t = s.addTask({ title: "a" });
    s.addUpdate({ task_id: t.id, author: "pi-x", summary: "one" });
    const stream = s.memoryStream(t.id);
    expect(stream?.task.id).toBe(t.id);
    expect(stream?.updates.map(u => u.summary)).toEqual(["one"]);
    expect(stream?.synced).toBe(t.created);
    expect(stream?.latest).toBeNull();
    expect(s.memoryStream(999)).toBeNull();
  });
});

describe("activity time (plan @422)", () => {
  const activity = (s: Store, id: number): number | undefined => s.memoryStreams().find(r => r.id === id)?.activity;

  test("status audits, lane moves, tag and title changes are not activity; updates and body edits are", () => {
    const s = open();
    at(1_000);
    const t = s.addTask({ title: "a", lane: "l", body: "v1", author: "pi-x" });
    at(2_000);
    s.setStatus(t.id, "done", { author: "pi-x" });
    s.moveTask(t.id, "other");
    s.changeTaskTags(t.id, { add: ["topic"] });
    s.editTask(t.id, { title: "renamed" });
    expect(activity(s, t.id)).toBe(1_000);
    at(3_000);
    s.addUpdate({ task_id: t.id, author: "pi-x", summary: "progress" });
    expect(activity(s, t.id)).toBe(3_000);
    at(4_000);
    s.editTask(t.id, { body: "v2" });
    expect(activity(s, t.id)).toBe(4_000);
  });

  test("memoryStreams orders by activity (not `updated`) and excludeLane keeps every other lane", () => {
    const s = open();
    at(1_000);
    const a = s.addTask({ title: "a", lane: "l" });
    at(2_000);
    const b = s.addTask({ title: "b", lane: "l" });
    at(3_000);
    s.addUpdate({ task_id: a.id, author: "pi-x", summary: "progress" });
    const c = s.addTask({ title: "c", lane: "other" });
    at(5_000);
    s.setStatus(b.id, "review"); // bumps `updated`, not activity
    expect(ids(s.memoryStreams({ lane: "l" }))).toEqual([a.id, b.id]);
    expect(ids(s.memoryStreams({ excludeLane: "l" }))).toEqual([c.id]);
    expect(ids(s.memoryStreams({ excludeLane: "other", active: true }))).toEqual([a.id, b.id]);
  });
});

describe("cross-lane ranking (plan @422)", () => {
  test("every lane is searched; `lane` filters and `boost` ranks the caller's lane above an equal hit", () => {
    const s = open();
    const mine = s.addTask({ title: "gizmo sprocket", lane: "cortex" });
    const theirs = s.addTask({ title: "gizmo sprocket", lane: "infra" });
    expect(ids(s.searchMemory(["gizmo", "sprocket"]))).toEqual([theirs.id, mine.id]); // tie: newest id
    expect(ids(s.searchMemory(["gizmo", "sprocket"], { boost: "cortex" }))).toEqual([mine.id, theirs.id]);
    expect(ids(s.searchMemory(["gizmo", "sprocket"], { lane: "cortex" }))).toEqual([mine.id]);
    const [boosted, plain] = s.searchMemory(["gizmo", "sprocket"], { boost: "cortex" });
    expect(boosted?.score).toBeCloseTo((plain?.score ?? 0) * MEMORY_LIMITS.laneBoost, 3);
  });

  test("a section matching a query phrase ranks first", () => {
    const s = open();
    const titled = s.addTask({ title: "events of routing", body: "routing and events" });
    const phrased = s.addTask({ title: "notes", body: "the routing-events work" });
    expect(ids(s.searchMemory(["routing", "events"]))[0]).toBe(titled.id);
    expect(ids(s.searchMemory(["routing", "events"], { phrases: [["routing", "events"]] }))).toEqual([
      phrased.id,
      titled.id,
    ]);
  });

  test("more matched groups rank above a stronger BM25 with fewer groups", () => {
    const s = open();
    s.addTask({ title: "alpha only" }); // distinct match sets: alpha and beta are separate groups
    const two = s.addTask({ title: "alpha beta" });
    const three = s.addTask({ title: "notes", body: `alpha ${"filler ".repeat(40)} beta gamma` });
    expect(ids(s.searchMemory(["alpha", "beta", "gamma"]))).toEqual([three.id, two.id]);
  });

  test("recent: equally covered hits sort by newest activity; groups still come first", () => {
    const s = open();
    at(1_000);
    const older = s.addTask({ title: "gizmo sprocket" });
    at(2_000);
    const newer = s.addTask({ title: "gizmo sprocket" });
    at(3_000);
    s.addUpdate({ task_id: older.id, author: "pi-x", summary: "progress" });
    at(4_000);
    s.setStatus(newer.id, "done", { author: "pi-x" }); // a bulk close is not activity
    expect(ids(s.searchMemory(["gizmo", "sprocket"]))).toEqual([newer.id, older.id]);
    expect(ids(s.searchMemory(["gizmo", "sprocket"], { recent: true }))).toEqual([older.id, newer.id]);
    at(5_000);
    s.addTask({ title: "gizmo solo" }); // distinct match sets: gizmo and sprocket are separate groups
    s.addTask({ title: "sprocket solo" });
    const fuller = s.addTask({ title: "gizmo sprocket widget" });
    at(6_000);
    s.addUpdate({ task_id: older.id, author: "pi-x", summary: "more" });
    expect(ids(s.searchMemory(["gizmo", "sprocket", "widget"], { recent: true }))).toEqual([
      fuller.id,
      older.id,
      newer.id,
    ]);
  });
});

describe("linked streams (_memory_links, plan @422)", () => {
  const links = (s: Store): { task_id: number; ref_id: number }[] =>
    s.runInTransaction(raw =>
      raw
        .query<{ task_id: number; ref_id: number }, []>("SELECT task_id, ref_id FROM _memory_links ORDER BY 1, 2;")
        .all(),
    );

  test("links are rebuilt from bodies and update summaries on edit, post and remove; self refs are skipped", () => {
    const s = open();
    const a = s.addTask({ title: "a" });
    const b = s.addTask({ title: "b", body: `continues @${a.id} and @${a.id}, not me @0` });
    s.editTask(a.id, { body: `self @${a.id}` });
    s.searchMemory(["warmup"]);
    expect(links(s)).toEqual([{ task_id: b.id, ref_id: a.id }]);
    s.editTask(b.id, { body: "no refs" });
    s.addUpdate({ task_id: a.id, author: "pi-x", summary: `handed off \u2192 @${b.id}` });
    expect(s.memoryStream(a.id)).not.toBeNull(); // show reconciles too
    expect(links(s)).toEqual([{ task_id: a.id, ref_id: b.id }]);
    s.removeTask(a.id);
    s.searchMemory(["warmup"]);
    expect(links(s)).toEqual([]);
  });

  test("an index built before _memory_links existed is rebuilt with every task's links", () => {
    const s = open();
    const a = s.addTask({ title: "a" });
    const b = s.addTask({ title: "b", body: `continues @${a.id}` });
    s.searchMemory(["warmup"]);
    s.runInTransaction(raw => raw.run("DROP TABLE _memory_links;"));
    expect(ids(s.searchMemory(["continues"]))).toEqual([b.id]);
    expect(links(s)).toEqual([{ task_id: b.id, ref_id: a.id }]);
  });

  test("latest follows same-lane links to later-created streams; other lanes and older referencers are ignored", () => {
    const s = open();
    at(500);
    const older = s.addTask({ title: "older", lane: "infra" });
    at(1_000);
    const a = s.addTask({ title: "handover a", lane: "infra" });
    at(2_000);
    const b = s.addTask({ title: "handover b", lane: "infra", body: `continues @${a.id}` });
    at(3_000);
    const c = s.addTask({ title: "handover c", lane: "infra", body: `continues @${b.id}` });
    at(4_000);
    const d = s.addTask({ title: "handover d", lane: "infra", body: `continues @${c.id}` });
    at(5_000);
    s.addTask({ title: "other lane", lane: "cortex", body: `continues @${d.id}` });
    s.editTask(older.id, { body: `see @${d.id}` });
    expect(s.memoryStream(a.id)?.latest).toEqual({ id: d.id, status: "open", activity: 4_000 });
    expect(s.memoryStream(c.id)?.latest?.id).toBe(d.id);
    expect(s.memoryStream(d.id)?.latest).toBeNull();
    const hit = s.searchMemory(["handover"]).find(h => h.id === b.id);
    expect(hit?.latest?.id).toBe(d.id);
  });

  test("mutual links terminate, and a hop takes the linked candidate with the newest activity", () => {
    const s = open();
    at(1_000);
    const a = s.addTask({ title: "a", lane: "l" });
    at(2_000);
    const b = s.addTask({ title: "b", lane: "l", body: `continues @${a.id}` });
    at(3_000);
    const review = s.addTask({ title: "review", lane: "l", body: `reviews @${a.id}` });
    at(4_000);
    s.addUpdate({ task_id: a.id, author: "pi-x", summary: `handed off \u2192 @${b.id}` });
    s.addUpdate({ task_id: b.id, author: "pi-x", summary: "still going" });
    at(5_000);
    s.setStatus(review.id, "done", { author: "pi-x" }); // not activity: b stays the newest
    expect(s.memoryStream(a.id)?.latest?.id).toBe(b.id);
    expect(s.memoryStream(b.id)?.latest).toBeNull();
  });
});

describe("memory exclusion (memory_exclusions)", () => {
  const sectionsOf = (s: Store, taskId: number): number =>
    s.runInTransaction(
      raw =>
        raw.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM _memory_sections WHERE task_id = ?;").get(taskId)
          ?.n ?? 0,
    );

  test("an excluded task is never a hit, and including it restores it at once", () => {
    const s = open();
    const alpha = s.addTask({ title: "gizmo alpha", lane: "l" });
    const beta = s.addTask({ title: "gizmo beta", lane: "l" });
    expect(ids(s.searchMemory(["gizmo"])).sort()).toEqual([alpha.id, beta.id].sort());
    s.setMemoryExcluded(beta.id, true);
    expect(ids(s.searchMemory(["gizmo"]))).toEqual([alpha.id]);
    expect(ids(s.searchMemory(["gizmo"], { lane: "l" }))).toEqual([alpha.id]);
    expect(s.getTask(beta.id)?.memory_excluded).toBe(true);
    expect(s.listTasks().find(t => t.id === beta.id)?.memory_excluded).toBe(true);
    expect(s.memoryStream(beta.id)?.task.memory_excluded).toBe(true);
    expect(s.getTask(alpha.id)?.memory_excluded).toBe(false);
    s.setMemoryExcluded(beta.id, false);
    expect(ids(s.searchMemory(["gizmo"])).sort()).toEqual([alpha.id, beta.id].sort());
  });

  test("the hit limit counts only included tasks", () => {
    const s = open();
    const shown = s.addTask({ title: "gizmo shown" });
    for (let i = 0; i < MEMORY_LIMITS.hits; i++) {
      const hidden = s.addTask({ title: `gizmo hidden ${i}` });
      s.setMemoryExcluded(hidden.id, true);
    }
    expect(ids(s.searchMemory(["gizmo"]))).toEqual([shown.id]);
  });

  test("the index holds no text of an excluded task", () => {
    const s = open();
    const t = s.addTask({ title: "gizmo", body: "secret plans" });
    s.addUpdate({ task_id: t.id, author: "pi-x", summary: "more secret plans" });
    s.searchMemory(["gizmo"]);
    expect(sectionsOf(s, t.id)).toBeGreaterThan(0);
    s.setMemoryExcluded(t.id, true);
    expect(s.searchMemory(["secret", "plans"])).toEqual([]);
    expect(sectionsOf(s, t.id)).toBe(0);
  });

  test("stream lists hide excluded tasks unless withExcluded", () => {
    const s = open();
    const a = s.addTask({ title: "a", lane: "l" });
    const b = s.addTask({ title: "b", lane: "l" });
    s.addUpdate({ task_id: a.id, author: "pi-x", summary: "work" });
    s.addUpdate({ task_id: b.id, author: "pi-x", summary: "work" });
    s.setMemoryExcluded(b.id, true);
    expect(ids(s.memoryStreams({ lane: "l" }))).toEqual([a.id]);
    expect(ids(s.memoryStreams({ lane: "l", active: true }))).toEqual([a.id]);
    expect(ids(s.memoryStreams({ author: "pi-x" }))).toEqual([a.id]);
    expect(ids(s.memoryStreams({ excludeLane: "other" }))).toEqual([a.id]);
    const all = s.memoryStreams({ author: "pi-x", withExcluded: true });
    expect(ids(all).sort()).toEqual([a.id, b.id].sort());
    expect(all.find(row => row.id === b.id)?.memory_excluded).toBe(true);
    expect(all.find(row => row.id === a.id)?.memory_excluded).toBe(false);
  });

  test("latest linked skips an excluded task, which still loads by id", () => {
    const s = open();
    at(1_000);
    const a = s.addTask({ title: "a", lane: "l" });
    at(2_000);
    const b = s.addTask({ title: "b", lane: "l", body: `continues @${a.id}` });
    s.setMemoryExcluded(b.id, true);
    expect(s.memoryStream(a.id)?.latest).toBeNull();
    const loaded = s.memoryStream(b.id);
    expect(loaded?.task.id).toBe(b.id);
    expect(loaded?.task.memory_excluded).toBe(true);
    s.setMemoryExcluded(b.id, false);
    expect(s.memoryStream(a.id)?.latest?.id).toBe(b.id);
  });

  test("exclusion is idempotent, survives tag rewrites, and goes with its task", () => {
    const s = open();
    const t = s.addTask({ title: "t", tags: ["topic"] });
    const before = s.taskState(t.id)?.versions.entity;
    s.setMemoryExcluded(t.id, true);
    const once = s.taskState(t.id)?.versions.entity;
    expect(once).not.toBe(before);
    s.setMemoryExcluded(t.id, true);
    expect(s.taskState(t.id)?.versions.entity).toBe(once);
    s.setTaskTags(t.id, ["other"]);
    s.changeTaskTags(t.id, { remove: ["other"] });
    expect(s.getTask(t.id)?.memory_excluded).toBe(true);
    s.removeTask(t.id);
    const rows = s.runInTransaction(
      raw => raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_exclusions;").get()?.n,
    );
    expect(rows).toBe(0);
    expect(() => s.setMemoryExcluded(999, true)).toThrow("task 999 not found");
  });
});
