// related.test.ts — End-to-end coverage for GET /api/tasks/:id/related.
//
// Follows the in-process integration pattern from concurrency.test.ts:
// boot a startServer({ port: 0 }) against an in-memory Store, hit the
// route over real HTTP. Two scenarios: a happy path that exercises every
// bucket, and a 404 for a missing task id. The store-level logic itself
// is exhaustively covered by test/unit/store-related.test.ts; this file
// just pins down the route shape.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Store, type RelatedTasks } from "../../src/store.ts";
import { startServer, type ServerHandle } from "../../src/server.ts";

let store: Store;
let h: ServerHandle;
const AUTHOR = "test-9999";

beforeAll(async () => {
  store = Store.open(":memory:");
  h = startServer({ port: 0, store });
  // Seed: A referenced-by D (via an update), A references B (via body), C shares a topical tag.
  const a = store.addTask({ title: "A" });
  const b = store.addTask({ title: "B" });
  const c = store.addTask({ title: "C" });
  const d = store.addTask({ title: "D" });
  store.editTask(a.id, { body: `out to @${b.id}` });
  store.addUpdate({ task_id: d.id, author: AUTHOR, summary: `ping @${a.id}` });
  // Topical tag — NOT in SHARED_TAG_BLOCKLIST so it surfaces in `shared`.
  store.setTaskTags(a.id, ["share"]);
  store.setTaskTags(c.id, ["share"]);
});

afterAll(async () => {
  await h.stop();
  store.close();
});

describe("GET /api/tasks/:id/related", () => {
  test("happy path returns 200 + the three buckets populated correctly", async () => {
    const res = await fetch(`${h.url}/api/tasks/1/related`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RelatedTasks;
    expect(body.referencedBy.map(t => t.title)).toEqual(["D"]);
    expect(body.references.map(t => t.title)).toEqual(["B"]);
    expect(body.shared.map(t => t.title)).toEqual(["C"]);
  });

  test("404 when :id does not exist", async () => {
    const res = await fetch(`${h.url}/api/tasks/9999/related`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
  });
});
