// store-related.test.ts — Coverage for Store.relatedTasks(id).
//
// Three pairwise-disjoint buckets (priority: referencedBy > references > shared):
//   - referencedBy : OTHER tasks whose body OR any update summary
//                    contains `@id` (the active task's id).
//   - references   : tasks the active task's body OR any of its own
//                    update summaries reference via `@targetId`.
//   - shared       : tasks sharing ≥1 NON-blocklisted tag with the
//                    active task (organizational tags like `plan`,
//                    `pr-desc`, `research` are excluded). Falls back
//                    to empty when the active task carries only
//                    blocklisted tags.
//
// Uses Store.open(":memory:") for hermetic isolation (matches store.test.ts
// precedent — the env-swap pattern from paths.test.ts is for code paths
// that internally call dbPath()).

import { test, expect, describe } from "bun:test";
import { Store, SHARED_TAG_BLOCKLIST } from "../../src/store.ts";

const open = () => Store.open(":memory:");
const AUTHOR = "test-1234";

describe("Store.relatedTasks", () => {
  test("three buckets populated correctly with body refs + shared tag (referencedBy wins over references in dedup)", () => {
    const s = open();
    const a = s.addTask({ title: "A" });
    const b = s.addTask({ title: "B" });
    const c = s.addTask({ title: "C" });
    // A refs B; B refs A; C has no refs but shares topical tag "topic" with A.
    s.editTask(a.id, { body: `see @${b.id}` });
    s.editTask(b.id, { body: `back to @${a.id}` });
    s.setTaskTags(a.id, ["topic"]);
    s.setTaskTags(c.id, ["topic"]);

    const rel = s.relatedTasks(a.id);
    expect(rel.referencedBy.map(t => t.id)).toEqual([b.id]); // B's body -> A
    expect(rel.references.map(t => t.id)).toEqual([]); // dedup: B already in referencedBy
    expect(rel.shared.map(t => t.id)).toEqual([c.id]); // shared "topic" tag
    // B must NOT appear in shared even if it carried "topic" — same dedup.
    expect(rel.shared.find(t => t.id === b.id)).toBeUndefined();
    s.close();
  });

  test("asymmetric refs: A->B with no B->A keeps B in references alone", () => {
    const s = open();
    const a = s.addTask({ title: "A" });
    const b = s.addTask({ title: "B" });
    s.editTask(a.id, { body: `see @${b.id}` }); // outbound only
    const rel = s.relatedTasks(a.id);
    expect(rel.referencedBy).toEqual([]);
    expect(rel.references.map(t => t.id)).toEqual([b.id]);
    expect(rel.shared).toEqual([]);
    s.close();
  });

  test("an update on another task referencing :id surfaces it in referencedBy", () => {
    const s = open();
    const a = s.addTask({ title: "A" });
    const d = s.addTask({ title: "D" });
    expect(s.relatedTasks(a.id).referencedBy.length).toBe(0);
    s.addUpdate({ task_id: d.id, author: AUTHOR, summary: `ping @${a.id}` });
    const rel = s.relatedTasks(a.id);
    expect(rel.referencedBy.map(t => t.id)).toEqual([d.id]);
    s.close();
  });

  test("an update ON :id referencing another task surfaces it in references (and drops it from shared)", () => {
    const s = open();
    const a = s.addTask({ title: "A" });
    const c = s.addTask({ title: "C" });
    s.setTaskTags(a.id, ["topic"]);
    s.setTaskTags(c.id, ["topic"]);
    expect(s.relatedTasks(a.id).shared.map(t => t.id)).toEqual([c.id]);
    expect(s.relatedTasks(a.id).references.length).toBe(0);
    s.addUpdate({ task_id: a.id, author: AUTHOR, summary: `see @${c.id}` });
    const rel = s.relatedTasks(a.id);
    expect(rel.references.map(t => t.id)).toEqual([c.id]);
    expect(rel.shared.length).toBe(0);
    s.close();
  });

  test("a task with no body, no updates, no tags returns three empty arrays", () => {
    const s = open();
    const a = s.addTask({ title: "alone" });
    const rel = s.relatedTasks(a.id);
    expect(rel.referencedBy).toEqual([]);
    expect(rel.references).toEqual([]);
    expect(rel.shared).toEqual([]);
    s.close();
  });

  test("the active task is never present in any bucket (self-ref ignored)", () => {
    const s = open();
    const a = s.addTask({ title: "A" });
    s.editTask(a.id, { body: `loop @${a.id}` });
    s.setTaskTags(a.id, ["self"]);
    const rel = s.relatedTasks(a.id);
    expect(rel.references.find(t => t.id === a.id)).toBeUndefined();
    expect(rel.referencedBy.find(t => t.id === a.id)).toBeUndefined();
    expect(rel.shared.find(t => t.id === a.id)).toBeUndefined();
    s.close();
  });

  test("word-boundary safety: `@123abc` must NOT register as a reference to @123", () => {
    // The bracketless grammar uses word-boundary lookaround; LIKE alone
    // would false-positive on `%@1%`. The post-filter must reject this.
    const s = open();
    const a = s.addTask({ title: "id-1" });
    expect(a.id).toBe(1); // first auto-id is 1 in a fresh DB
    const b = s.addTask({ title: "id-2" });
    s.editTask(b.id, { body: "deploy@123abc not a ref" });
    const rel = s.relatedTasks(a.id);
    expect(rel.referencedBy.find(t => t.id === b.id)).toBeUndefined();
    s.close();
  });

  test("longer-id substring safety: a body containing @1234 must NOT register as referencing @1", () => {
    const s = open();
    const a = s.addTask({ title: "id-1" });
    expect(a.id).toBe(1);
    const b = s.addTask({ title: "id-2" });
    s.editTask(b.id, { body: "see @1234" });
    const rel = s.relatedTasks(a.id);
    expect(rel.referencedBy.find(t => t.id === b.id)).toBeUndefined();
    s.close();
  });

  test("sorts each bucket by priority ASC then id ASC", () => {
    const s = open();
    const a = s.addTask({ title: "A", priority: 0 });
    const m1 = s.addTask({ title: "m1", priority: 5, body: `@${a.id}` });
    const m2 = s.addTask({ title: "m2", priority: 0, body: `@${a.id}` });
    const m3 = s.addTask({ title: "m3", priority: 5, body: `@${a.id}` });
    const rel = s.relatedTasks(a.id);
    expect(rel.referencedBy.map(t => t.id)).toEqual([m2.id, m1.id, m3.id]);
    s.close();
  });

  test("shared bucket excludes blocklisted organizational tags (plan, pr-desc, research)", () => {
    const s = open();
    const a = s.addTask({ title: "A" });
    const b = s.addTask({ title: "B" });
    const c = s.addTask({ title: "C" });
    // A and B both tagged ONLY with blocklisted tags — they must NOT be
    // related via shared. C shares a topical tag with A — IS related.
    s.setTaskTags(a.id, ["plan", "topic"]);
    s.setTaskTags(b.id, ["plan", "pr-desc", "research"]);
    s.setTaskTags(c.id, ["topic"]);
    const rel = s.relatedTasks(a.id);
    expect(rel.shared.map(t => t.id)).toEqual([c.id]);
    expect(rel.shared.find(t => t.id === b.id)).toBeUndefined();
    s.close();
  });

  test("when the active task has ONLY blocklisted tags, shared is empty", () => {
    const s = open();
    const a = s.addTask({ title: "A" });
    const b = s.addTask({ title: "B" });
    s.setTaskTags(a.id, ["plan"]);
    s.setTaskTags(b.id, ["plan"]); // both `plan` — still empty
    const rel = s.relatedTasks(a.id);
    expect(rel.shared).toEqual([]);
    s.close();
  });

  test("SHARED_TAG_BLOCKLIST is the documented constant", () => {
    expect(SHARED_TAG_BLOCKLIST.has("plan")).toBe(true);
    expect(SHARED_TAG_BLOCKLIST.has("pr-desc")).toBe(true);
    expect(SHARED_TAG_BLOCKLIST.has("research")).toBe(true);
  });
});
