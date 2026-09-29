// store-memory.test.ts — agent memory in the Store (plan @414): the body-sync
// record (`_body_edits`), the derived FTS5 index (`_memory_fts` /
// `_memory_index`, created on first search and reconciled on every search)
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
    expect(hasTable(s, "_memory_fts")).toBe(false);
    expect(ids(s.searchMemory(["mouse"]))).toHaveLength(1);
    expect(hasTable(s, "_memory_fts")).toBe(true);
    expect(hasTable(s, "_memory_index")).toBe(true);
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
    expect(row).toEqual({ id: a.id, title: "a", lane: "l", status: "open", updated: 1_000, synced: 1_000, tags: [] });
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
    expect(s.memoryStream(999)).toBeNull();
  });
});
