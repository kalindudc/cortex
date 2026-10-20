import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Store,
  BodySearchError,
  ConflictError,
  DatabaseNotFoundError,
  MutationReuseError,
  WriteGuardError,
  mutationDigest,
  RECEIPT_RETENTION_MS,
  validateTagName,
  TAG_NAME_RE,
  type Task,
} from "../../src/store.ts";
import type { ResourceScope, Versions, WriteGuard } from "../../src/contracts.ts";
import { OwnershipError, tryAcquireOwnership } from "../../src/ownership.ts";
import { configDir, ownerLockPath } from "../../src/paths.ts";

const open = () => Store.open(":memory:");

/** The table `idx_updates_task` indexes, or undefined when it is missing. */
const updatesIndexTable = (s: Store): string | undefined =>
  s.runInTransaction(
    raw =>
      raw
        .query<{ tbl_name: string }, []>(
          "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_updates_task';",
        )
        .get()?.tbl_name,
  );

// ---------- revision / guard / receipt helpers (plan @400 N7-N9) ----------

const TASK_SCOPES: ResourceScope[] = ["body", "entity", "lane", "priority", "status", "title"];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function versionsOf(s: Store, id: number): Versions {
  const state = s.taskState(id);
  if (!state) throw new Error(`task ${id} has no state`);
  return state.versions;
}

function mustGet(s: Store, id: number): Task {
  const task = s.getTask(id);
  if (!task) throw new Error(`task ${id} missing`);
  return task;
}

/** Every token value in a Versions map. */
function tokens(versions: Versions | null): string[] {
  return Object.values(versions ?? {}).filter((value): value is string => typeof value === "string");
}

function token(versions: Versions | null, scope: ResourceScope): string {
  const value = versions?.[scope];
  if (value === undefined) throw new Error(`no ${scope} token`);
  return value;
}

/** Scopes whose token differs between two reads, sorted. */
function changedScopes(before: Versions, after: Versions): ResourceScope[] {
  const scopes = new Set([...Object.keys(before), ...Object.keys(after)] as ResourceScope[]);
  return [...scopes].filter(scope => before[scope] !== after[scope]).sort();
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

/** Every persisted row a rejected write must leave untouched, private metadata included. */
function snapshot(s: Store): Record<string, unknown[]> {
  const tables: Record<string, string> = {
    tasks: "SELECT * FROM tasks ORDER BY id",
    updates: "SELECT * FROM updates ORDER BY id",
    lanes: "SELECT * FROM lanes ORDER BY name",
    tags: "SELECT * FROM tags ORDER BY name",
    task_tags: "SELECT * FROM task_tags ORDER BY task_id, tag_name",
    notifications: "SELECT * FROM notifications ORDER BY id",
    memory_exclusions: "SELECT * FROM memory_exclusions ORDER BY task_id",
    revisions: "SELECT * FROM _resource_revisions ORDER BY resource, scope",
    receipts: "SELECT * FROM _mutation_receipts ORDER BY mutation_id",
    bodyEdits: "SELECT * FROM _body_edits ORDER BY task_id",
  };
  return s.runInTransaction(raw => {
    const out: Record<string, unknown[]> = {};
    for (const [name, sql] of Object.entries(tables)) out[name] = raw.query<Record<string, unknown>, []>(sql).all();
    return out;
  });
}

/** Fault injection: make the next matching write abort inside the Store's own transaction. */
function failOn(s: Store, name: string, event: string): () => void {
  s.runInTransaction(raw => raw.run(`CREATE TRIGGER ${name} ${event} BEGIN SELECT RAISE(ABORT, 'injected'); END;`));
  return () => s.runInTransaction(raw => raw.run(`DROP TRIGGER ${name};`));
}

describe("Store: tasks", () => {
  test("addTask + getTask + listTasks round-trip", () => {
    const s = open();
    const t = s.addTask({ title: "first" });
    expect(t.id).toBeGreaterThan(0);
    expect(t.lane).toBe("now");
    expect(t.status).toBe("open");
    expect(s.getTask(t.id)?.title).toBe("first");
    expect(s.listTasks().length).toBe(1);
    s.close();
  });

  test("addTask accepts explicit status including draft", () => {
    const s = open();
    const t = s.addTask({ title: "plan", status: "draft" });
    expect(t.status).toBe("draft");
    expect(s.listTasks({ status: "draft" }).length).toBe(1);
    s.close();
  });

  test("listTasks filters by lane and status", () => {
    const s = open();
    s.addLane({ name: "later" });
    s.addTask({ title: "a", lane: "now" });
    s.addTask({ title: "b", lane: "later" });
    const t3 = s.addTask({ title: "c", lane: "now" });
    s.setStatus(t3.id, "done");
    expect(s.listTasks({ lane: "now" }).length).toBe(2);
    expect(s.listTasks({ lane: "later" }).length).toBe(1);
    expect(s.listTasks({ status: "done" }).length).toBe(1);
    expect(s.listTasks({ lane: "now", status: "open" }).length).toBe(1);
    s.close();
  });

  test("listTasks orders by priority ASC (0 = highest, sorts first); null-priority falls to the end", () => {
    const s = open();
    s.addTask({ title: "normal", priority: 1 });
    s.addTask({ title: "top", priority: 0 });
    s.addTask({ title: "low", priority: 5 });
    // No --priority flag: priority is null and the row must sort AFTER
    // every prioritized row regardless of created-time tie-break.
    s.addTask({ title: "unranked" });
    const order = s.listTasks().map(t => t.title);
    expect(order).toEqual(["top", "normal", "low", "unranked"]);
    s.close();
  });

  test("addTask without --priority stores priority=null", () => {
    const s = open();
    const t = s.addTask({ title: "unranked" });
    expect(t.priority).toBeNull();
    expect(s.getTask(t.id)?.priority).toBeNull();
    s.close();
  });

  test("editTask({ priority: null }) clears an existing priority back to null and persists", () => {
    const s = open();
    const t = s.addTask({ title: "ranked", priority: 2 });
    expect(t.priority).toBe(2);
    const cleared = s.editTask(t.id, { priority: null });
    expect(cleared.priority).toBeNull();
    // Round-trip via getTask so we exercise the read path too.
    expect(s.getTask(t.id)?.priority).toBeNull();
    s.close();
  });

  test("listTasks({ search }) filters by title or body substring", () => {
    const s = open();
    s.addTask({ title: "Alpha task", body: "some body" });
    s.addTask({ title: "Beta task", body: "alpha is here" });
    s.addTask({ title: "Gamma", body: "nothing" });
    const results = s.listTasks({ search: "alpha" }).map(t => t.title);
    expect(results.sort()).toEqual(["Alpha task", "Beta task"]);
    s.close();
  });

  test("listTasks({ title }) filters by title substring only", () => {
    const s = open();
    s.addTask({ title: "Alpha task", body: "beta is here" });
    s.addTask({ title: "Beta task", body: "alpha is here" });
    const results = s.listTasks({ title: "alpha" }).map(t => t.title);
    expect(results).toEqual(["Alpha task"]);
    s.close();
  });

  test("listTasks({ tagQuery }) filters by tag name substring", () => {
    const s = open();
    const t1 = s.addTask({ title: "a" });
    const t2 = s.addTask({ title: "b" });
    s.setTaskTags(t1.id, ["bugfix", "ui"]);
    s.setTaskTags(t2.id, ["feature"]);
    const results = s.listTasks({ tagQuery: "bug" }).map(t => t.title);
    expect(results).toEqual(["a"]);
    s.close();
  });

  test("listTasks combines search with status filter", () => {
    const s = open();
    const t1 = s.addTask({ title: "Alpha bug" });
    s.setStatus(t1.id, "done");
    s.addTask({ title: "Beta bug" });
    const results = s.listTasks({ search: "bug", status: "open" }).map(t => t.title);
    expect(results).toEqual(["Beta bug"]);
    s.close();
  });

  test("editTask updates only provided fields and bumps updated", async () => {
    const s = open();
    const t = s.addTask({ title: "x", body: "orig", priority: 1 });
    await Bun.sleep(2);
    const edited = s.editTask(t.id, { title: "y" });
    expect(edited.title).toBe("y");
    expect(edited.body).toBe("orig");
    expect(edited.priority).toBe(1);
    expect(edited.updated).toBeGreaterThan(t.updated);
    s.close();
  });

  test("editTask bodySearch/bodyReplace splices a unique anchor", () => {
    const s = open();
    const t = s.addTask({ title: "x", body: "alpha TODO investigate beta" });
    const edited = s.editTask(t.id, {
      bodySearch: "TODO investigate",
      bodyReplace: "DONE \u2014 see updates",
    });
    expect(edited.body).toBe("alpha DONE \u2014 see updates beta");
    s.close();
  });

  test("editTask bodySearch supports multi-line anchors", () => {
    const s = open();
    const body = "intro\n\n## Plan\n- step 1\n- step 2\n\noutro";
    const t = s.addTask({ title: "x", body });
    const edited = s.editTask(t.id, {
      bodySearch: "## Plan\n- step 1\n- step 2",
      bodyReplace: "## Plan\n- step 1\n- step 2\n- step 3",
    });
    expect(edited.body).toBe("intro\n\n## Plan\n- step 1\n- step 2\n- step 3\n\noutro");
    s.close();
  });

  test("editTask bodyReplace empty string deletes the anchor", () => {
    const s = open();
    const t = s.addTask({ title: "x", body: "keep DELETE_ME also-keep" });
    const edited = s.editTask(t.id, {
      bodySearch: " DELETE_ME",
      bodyReplace: "",
    });
    expect(edited.body).toBe("keep also-keep");
    s.close();
  });

  test("editTask bodySearch throws BodySearchError(not_found) on no match", () => {
    const s = open();
    const t = s.addTask({ title: "x", body: "alpha beta" });
    let caught: unknown;
    try {
      s.editTask(t.id, { bodySearch: "gamma", bodyReplace: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BodySearchError);
    expect((caught as BodySearchError).kind).toBe("not_found");
    s.close();
  });

  test("editTask bodySearch throws BodySearchError(ambiguous) with match count on duplicate anchor", () => {
    const s = open();
    const t = s.addTask({ title: "x", body: "foo bar foo bar foo" });
    let caught: unknown;
    try {
      s.editTask(t.id, { bodySearch: "foo", bodyReplace: "baz" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BodySearchError);
    expect((caught as BodySearchError).kind).toBe("ambiguous");
    expect((caught as BodySearchError).matches).toBe(3);
    s.close();
  });

  test("editTask bodySearch combined with title in same call is atomic", () => {
    const s = open();
    const t = s.addTask({ title: "old", body: "hello world" });
    const edited = s.editTask(t.id, {
      title: "new",
      bodySearch: "world",
      bodyReplace: "there",
    });
    expect(edited.title).toBe("new");
    expect(edited.body).toBe("hello there");
    s.close();
  });

  test("editTask rejects bodySearch without bodyReplace (defensive)", () => {
    const s = open();
    const t = s.addTask({ title: "x", body: "hi" });
    expect(() => s.editTask(t.id, { bodySearch: "hi" } as never)).toThrow(
      /bodySearch and bodyReplace must be provided together/,
    );
    s.close();
  });

  test("editTask rejects bodySearch combined with body (defensive)", () => {
    const s = open();
    const t = s.addTask({ title: "x", body: "hi" });
    expect(() =>
      s.editTask(t.id, {
        body: "new",
        bodySearch: "hi",
        bodyReplace: "yo",
      }),
    ).toThrow(/cannot be combined with body/);
    s.close();
  });

  test("editTask rejects empty bodySearch (would match everywhere)", () => {
    const s = open();
    const t = s.addTask({ title: "x", body: "hi" });
    expect(() => s.editTask(t.id, { bodySearch: "", bodyReplace: "y" })).toThrow(/bodySearch cannot be empty/);
    s.close();
  });

  test("moveTask succeeds for existing lane and auto-creates missing lane", () => {
    const s = open();
    s.addLane({ name: "later" });
    const t = s.addTask({ title: "x" });
    const moved = s.moveTask(t.id, "later");
    expect(moved.lane).toBe("later");
    // missing lane is auto-created with defaults
    const moved2 = s.moveTask(t.id, "new-lane");
    expect(moved2.lane).toBe("new-lane");
    const lane = s.listLanes().find(l => l.name === "new-lane");
    expect(lane?.color).toBeNull();
    expect(lane?.sort).toBe(0);
    s.close();
  });

  test("addTask auto-creates missing lane", () => {
    const s = open();
    const t = s.addTask({ title: "x", lane: "fresh" });
    expect(t.lane).toBe("fresh");
    expect(s.listLanes().some(l => l.name === "fresh")).toBe(true);
    s.close();
  });

  test("setStatus mutates only the targeted row", () => {
    const s = open();
    const a = s.addTask({ title: "a" });
    const b = s.addTask({ title: "b" });
    s.setStatus(a.id, "done");
    expect(s.getTask(a.id)?.status).toBe("done");
    expect(s.getTask(b.id)?.status).toBe("open");
    s.close();
  });

  test("removeTask cascades updates via foreign_keys=ON", () => {
    const s = open();
    const t = s.addTask({ title: "x" });
    s.addUpdate({ task_id: t.id, author: "me", summary: "hi" });
    s.addUpdate({ task_id: t.id, author: "me", summary: "ho" });
    expect(s.listUpdates(t.id).length).toBe(2);
    s.removeTask(t.id);
    expect(s.getTask(t.id)).toBeNull();
    expect(s.listUpdates(t.id).length).toBe(0);
    s.close();
  });
});

describe("Store: updates", () => {
  // Plan 3 raised the CHECK cap from 200 → 1024: cortex summaries are
  // notifications, not diffs (the original SmartBear LOC argument doesn't
  // transfer). Raised again 1024 → 4096 so an agent can post a multi-
  // paragraph status in `-m` without spilling into `-b`; the UI renders
  // summaries with `white-space: pre-wrap`, so length is the only bound.
  test("addUpdate accepts 4096-char summary, throws on 4097", () => {
    const s = open();
    const t = s.addTask({ title: "x" });
    expect(() => s.addUpdate({ task_id: t.id, author: "me", summary: "x".repeat(4096) })).not.toThrow();
    expect(() => s.addUpdate({ task_id: t.id, author: "me", summary: "x".repeat(4097) })).toThrow("summary too long");
    s.close();
  });
});

describe("Store: migrate", () => {
  // Guards _seedMigrations(): a DB created with the CURRENT schema must
  // seed every known migration as applied, otherwise every open warns
  // "migrations pending" and `cortex init` rebuilds tables for nothing.
  test("fresh DB reports no pending migrations", () => {
    const s = open();
    expect(s.pendingMigrations()).toEqual([]);
    s.close();
  });

  test("updates are indexed by task, so per-task reads never scan the table", () => {
    const s = open();
    expect(updatesIndexTable(s)).toBe("updates");
    const plan = s.runInTransaction(raw =>
      raw
        .query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT * FROM updates WHERE task_id = 1;")
        .all()
        .map(row => row.detail)
        .join(" | "),
    );
    expect(plan).toContain("USING INDEX idx_updates_task");
    s.close();
  });

  test("migrate is idempotent — reopening preserves data and schema", () => {
    // Re-open the same on-disk DB twice; second open's migrate() must be a no-op.
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/cortex-migrate-${Date.now()}.db`;
    let s = Store.open(tmp);
    const t = s.addTask({ title: "persisted", body: "keep me", priority: 2 });
    s.close();
    s = Store.open(tmp);
    const reopened = s.getTask(t.id);
    expect(reopened?.title).toBe("persisted");
    expect(reopened?.body).toBe("keep me");
    expect(reopened?.priority).toBe(2);
    s.close();
    for (const ext of ["", "-wal", "-shm", ".owner.lock"]) {
      try {
        require("node:fs").rmSync(tmp + ext, { force: true });
      } catch {}
    }
  });
});

describe("Store: tags", () => {
  test("addTag/listTags/editTag/removeTag round-trip; rename cascades to task_tags", () => {
    const s = open();
    s.addTag({ name: "foo", color: "#abc" });
    let listed = s.listTags();
    expect(listed.find(t => t.name === "foo")?.color).toBe("#abc");
    expect(listed.find(t => t.name === "foo")?.task_count).toBe(0);
    // attach to a task to validate task_count + cascade-on-rename
    const task = s.addTask({ title: "x" });
    s.setTaskTags(task.id, ["foo"]);
    listed = s.listTags();
    expect(listed.find(t => t.name === "foo")?.task_count).toBe(1);
    s.editTag("foo", { rename: "foobar" });
    expect(s.getTask(task.id)?.tags).toEqual(["foobar"]);
    expect(s.listTags().some(t => t.name === "foo")).toBe(false);
    s.removeTag("foobar", { force: true });
    expect(s.listTags().some(t => t.name === "foobar")).toBe(false);
    expect(s.getTask(task.id)?.tags).toEqual([]);
    s.close();
  });

  test("setTaskTags is replace semantics; auto-creates missing tags; validates names", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    s.setTaskTags(t.id, ["a", "b"]);
    expect(s.getTask(t.id)?.tags).toEqual(["a", "b"]);
    // replace, not merge
    s.setTaskTags(t.id, ["c"]);
    expect(s.getTask(t.id)?.tags).toEqual(["c"]);
    // tags auto-created on first reference
    expect(
      s
        .listTags()
        .map(x => x.name)
        .sort(),
    ).toEqual(["a", "b", "c"]);
    expect(() => s.setTaskTags(t.id, ["BAD!"])).toThrow(/invalid tag name/);
    s.close();
  });

  test("listTasks({ tags: [a, b] }) returns AND intersection only", () => {
    const s = open();
    const ta = s.addTask({ title: "ta" });
    const tab = s.addTask({ title: "tab" });
    const tb = s.addTask({ title: "tb" });
    s.setTaskTags(ta.id, ["a"]);
    s.setTaskTags(tab.id, ["a", "b"]);
    s.setTaskTags(tb.id, ["b"]);
    const both = s.listTasks({ tags: ["a", "b"] }).map(t => t.title);
    expect(both).toEqual(["tab"]);
    const onlyA = s
      .listTasks({ tags: ["a"] })
      .map(t => t.title)
      .sort();
    expect(onlyA).toEqual(["ta", "tab"]);
    s.close();
  });

  test("removeTask cascades task_tags rows", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    s.setTaskTags(t.id, ["a", "b"]);
    expect(s.listTags().find(x => x.name === "a")?.task_count).toBe(1);
    s.removeTask(t.id);
    // tag rows survive removeTask; only join rows are dropped
    expect(s.listTags().find(x => x.name === "a")?.task_count).toBe(0);
    expect(s.listTags().find(x => x.name === "b")?.task_count).toBe(0);
    s.close();
  });

  test("removeTag refuses while a task uses it; force succeeds and drops join rows", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    s.setTaskTags(t.id, ["keep"]);
    expect(() => s.removeTag("keep")).toThrow(/task\(s\) reference it/);
    s.removeTag("keep", { force: true });
    expect(s.listTags().some(x => x.name === "keep")).toBe(false);
    expect(s.getTask(t.id)?.tags).toEqual([]);
    s.close();
  });

  test("every Task carries tags: [] (alphabetical when populated)", () => {
    const s = open();
    const fresh = s.addTask({ title: "untagged" });
    expect(fresh.tags).toEqual([]);
    expect(s.getTask(fresh.id)?.tags).toEqual([]);
    expect(s.listTasks()[0]?.tags).toEqual([]);
    s.setTaskTags(fresh.id, ["zeta", "alpha", "mu"]);
    // GROUP_CONCAT(... ORDER BY tag_name) yields deterministic alphabetical order
    expect(s.getTask(fresh.id)?.tags).toEqual(["alpha", "mu", "zeta"]);
    s.close();
  });
});

describe("Store: lanes", () => {
  test("add/list/edit/remove lifecycle", () => {
    const s = open();
    expect(s.listLanes().map(l => l.name)).toEqual(["now"]);
    s.addLane({ name: "later", color: "#abc", sort: 5 });
    expect(s.listLanes().length).toBe(2);
    const edited = s.editLane("later", { color: "#def" });
    expect(edited.color).toBe("#def");
    s.removeLane("later");
    expect(s.listLanes().length).toBe(1);
    s.close();
  });

  test("removeLane refuses 'now' and non-empty lanes", () => {
    const s = open();
    expect(() => s.removeLane("now")).toThrow(/cannot remove the 'now' lane/);
    s.addLane({ name: "later" });
    s.addTask({ title: "x", lane: "later" });
    expect(() => s.removeLane("later")).toThrow(/task\(s\) reference it/);
    s.close();
  });

  test("rename lane cascades to tasks via ON UPDATE CASCADE", () => {
    const s = open();
    s.addLane({ name: "later" });
    const t = s.addTask({ title: "x", lane: "later" });
    s.editLane("later", { rename: "soon" });
    expect(s.listLanes().some(l => l.name === "soon")).toBe(true);
    expect(s.getTask(t.id)?.lane).toBe("soon");
    s.close();
  });
});

// ---------- validateTagName: pure validator gap-closers ----------
//
// validateTagName is the single chokepoint enforced from three sites:
//   1. CLI flag-parse (commands/tag.ts, commands/edit.ts) — defense in depth
//   2. HTTP handler (server.ts) — early 400 rejection
//   3. Store.addTag/setTaskTags — final guard at the DB layer
// Tests below pin the documented contract: lowercase alnum/_@/- only, max 32.
describe("validateTagName", () => {
  test("accepts a typical tag and trims surrounding whitespace", () => {
    expect(validateTagName("plan")).toBe("plan");
    expect(validateTagName("  spaced-tag  ")).toBe("spaced-tag");
  });

  test("rejects empty string (HTTP/CLI rely on this for 400)", () => {
    expect(() => validateTagName("")).toThrow(/invalid tag name/);
    expect(() => validateTagName("   ")).toThrow(/invalid tag name/);
  });

  test("rejects uppercase / punctuation outside the documented charset", () => {
    expect(() => validateTagName("BAD!")).toThrow(/invalid tag name/);
    expect(() => validateTagName("with space")).toThrow(/invalid tag name/);
    expect(() => validateTagName("Capital")).toThrow(/invalid tag name/);
  });

  test("rejects names > 32 chars; 32 succeeds (boundary)", () => {
    expect(() => validateTagName("a".repeat(33))).toThrow(/invalid tag name/);
    expect(validateTagName("a".repeat(32))).toBe("a".repeat(32));
  });

  test("TAG_NAME_RE allows the documented charset (a-z 0-9 _ @ -)", () => {
    expect(TAG_NAME_RE.test("a_b@c-1")).toBe(true);
    expect(TAG_NAME_RE.test("@release")).toBe(true);
    expect(TAG_NAME_RE.test("a.b")).toBe(false);
  });
});

// ---------- listUpdates: read-side gap-closer ----------
//
// Exercised end-to-end by integration tests, but the ordering direction is
// fast to pin in-process via Store.open(":memory:").
describe("Store: listUpdates ordering", () => {
  test("returns rows ordered by created ASC (chronological)", async () => {
    const s = open();
    const t = s.addTask({ title: "x" });
    s.addUpdate({ task_id: t.id, author: "a1", summary: "first" });
    // Bun.sleep(2) is enough to bump SQLite's millisecond `created` value
    // since rows insert too fast otherwise. We use a real sleep here
    // (rather than forging timestamps) because Store.addUpdate doesn't
    // accept a `created` override and we deliberately avoid touching
    // production code in this plan.
    await Bun.sleep(2);
    s.addUpdate({ task_id: t.id, author: "a2", summary: "second" });
    await Bun.sleep(2);
    s.addUpdate({ task_id: t.id, author: "a3", summary: "third" });
    const rows = s.listUpdates(t.id);
    expect(rows.map(r => r.summary)).toEqual(["first", "second", "third"]);
    s.close();
  });

  test("returns [] for a task with no updates (and for a missing task_id)", () => {
    const s = open();
    const t = s.addTask({ title: "x" });
    expect(s.listUpdates(t.id)).toEqual([]);
    expect(s.listUpdates(9999)).toEqual([]);
    s.close();
  });
});

describe("Store: notifications", () => {
  test("addNotification round-trips with default read=false", () => {
    const s = open();
    s.addNotification({ status: "open", title: "hi", message: "m" });
    const rows = s.listNotifications();
    expect(rows[0].read).toBe(false);
    s.close();
  });

  test("listNotifications orders by created DESC", async () => {
    const s = open();
    s.addNotification({ status: "open", title: "a", message: "m" });
    await Bun.sleep(2);
    s.addNotification({ status: "open", title: "b", message: "m" });
    await Bun.sleep(2);
    s.addNotification({ status: "open", title: "c", message: "m" });
    expect(s.listNotifications().map(n => n.title)).toEqual(["c", "b", "a"]);
    s.close();
  });

  test("markNotificationRead flips read flag for one row only", () => {
    const s = open();
    const n1 = s.addNotification({ status: "open", title: "a", message: "m" });
    s.addNotification({ status: "open", title: "b", message: "m" });
    s.markNotificationRead(n1.id);
    expect(s.listNotifications().filter(n => n.read).length).toBe(1);
    s.close();
  });

  test("markNotificationUnread flips a read row back to unread (only)", () => {
    const s = open();
    const n1 = s.addNotification({ status: "open", title: "a", message: "m" });
    const n2 = s.addNotification({ status: "open", title: "b", message: "m" });
    s.markNotificationRead(n1.id);
    s.markNotificationRead(n2.id);
    s.markNotificationUnread(n1.id);
    const list = s.listNotifications();
    expect(list.find(n => n.id === n1.id)?.read).toBe(false);
    expect(list.find(n => n.id === n2.id)?.read).toBe(true);
    s.close();
  });

  test("markAllNotificationsRead flips every unread row to read", () => {
    const s = open();
    s.addNotification({ status: "open", title: "a", message: "m" });
    s.addNotification({ status: "open", title: "b", message: "m" });
    s.addNotification({ status: "open", title: "c", message: "m" });
    s.markAllNotificationsRead();
    expect(s.listNotifications().every(n => n.read)).toBe(true);
    s.close();
  });

  test("dismissNotification deletes one row", () => {
    const s = open();
    const n1 = s.addNotification({ status: "open", title: "a", message: "m" });
    s.addNotification({ status: "open", title: "b", message: "m" });
    s.dismissNotification(n1.id);
    expect(s.listNotifications().length).toBe(1);
    s.close();
  });

  test("clearNotifications empties the table", () => {
    const s = open();
    s.addNotification({ status: "open", title: "a", message: "m" });
    s.addNotification({ status: "open", title: "b", message: "m" });
    s.addNotification({ status: "open", title: "c", message: "m" });
    s.clearNotifications();
    expect(s.listNotifications()).toEqual([]);
    s.close();
  });

  test("removing a task cascades and drops its notifications", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    s.addNotification({ task_id: t.id, status: "open", title: "a", message: "m" });
    s.removeTask(t.id);
    expect(s.listNotifications()).toEqual([]);
    s.close();
  });

  test("addNotification rejects status not in TaskStatus enum (CHECK constraint)", () => {
    const s = open();
    expect(() => s.addNotification({ status: "bogus" as never, title: "a", message: "m" })).toThrow();
    s.close();
  });
});

// ---------- file-backed stores: ownership leases + readonly snapshots ----------
//
// These need real files, so every test pins XDG_CONFIG_HOME and CORTEX_DB to a
// fresh mkdtemp root (Store.open calls ensureConfigDir()) and restores both.
// Leases use the real flock boundary: a second open file description in the
// same process is contended, which makes lease lifetime directly observable.

const savedFileEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, CORTEX_DB: process.env.CORTEX_DB };
let fileRoot: string;
let fileDb: string;

function pinFileEnv(): void {
  fileRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cortex-store-file-")));
  fileDb = path.join(fileRoot, "cortex.db");
  process.env.XDG_CONFIG_HOME = path.join(fileRoot, "config");
  process.env.CORTEX_DB = fileDb;
}

function restoreFileEnv(): void {
  for (const [key, value] of Object.entries(savedFileEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(fileRoot, { recursive: true, force: true });
}

/** true when nobody (including this process) holds the database lease. */
function leaseIsFree(db: string): boolean {
  const probe = tryAcquireOwnership(db);
  probe?.release();
  return probe !== null;
}

function ownershipCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OwnershipError);
    return (err as OwnershipError).code;
  }
  throw new Error("expected an OwnershipError");
}

describe("Store: ownership lease lifetime", () => {
  beforeEach(pinFileEnv);
  afterEach(restoreFileEnv);

  test("a file-backed open holds the lease for the Store's lifetime and close() releases it", () => {
    const s = Store.open(fileDb);
    expect(leaseIsFree(fileDb)).toBe(false);
    s.addTask({ title: "owned write" });
    s.close();
    expect(leaseIsFree(fileDb)).toBe(true);
    expect(fs.existsSync(ownerLockPath(fileDb))).toBe(true);
  });

  test("an open refuses a database another owner holds, before creating or opening it", () => {
    const held = tryAcquireOwnership(fileDb);
    if (held === null) throw new Error("expected a lease");
    expect(ownershipCode(() => Store.open(fileDb))).toBe("busy");
    expect(fs.existsSync(fileDb)).toBe(false);
    held.release();
  });

  test("two simultaneous opens in ONE process contend (flock is per open file description): share the Store or the lease", () => {
    const first = Store.open(fileDb);
    try {
      expect(ownershipCode(() => Store.open(fileDb))).toBe("busy");
      const link = path.join(fileRoot, "alias.db");
      fs.symlinkSync(fileDb, link);
      expect(ownershipCode(() => Store.open(link))).toBe("busy");
    } finally {
      first.close();
    }
  });

  test("a supplied lease is validated through canonical aliases and is never released by close()", () => {
    Store.open(fileDb).close();
    const link = path.join(fileRoot, "link.db");
    fs.symlinkSync(fileDb, link);
    const lease = tryAcquireOwnership(fileDb);
    if (lease === null) throw new Error("expected a lease");
    const s = Store.open(link, { owner: lease });
    s.addTask({ title: "via symlink" });
    s.close();
    expect(leaseIsFree(fileDb)).toBe(false);
    // A second Store on the same lease reuses it instead of contending with it.
    const again = Store.open(fileDb, { owner: lease });
    expect(again.listTasks().length).toBe(1);
    again.close();
    expect(leaseIsFree(fileDb)).toBe(false);
    lease.release();
    expect(leaseIsFree(fileDb)).toBe(true);
  });

  test("a lease for a different database is rejected without creating the requested one", () => {
    const other = path.join(fileRoot, "other.db");
    const lease = tryAcquireOwnership(fileDb);
    if (lease === null) throw new Error("expected a lease");
    expect(ownershipCode(() => Store.open(other, { owner: lease }))).toBe("lease-mismatch");
    expect(ownershipCode(() => Store.open(":memory:", { owner: lease }))).toBe("lease-mismatch");
    expect(fs.existsSync(other)).toBe(false);
    lease.release();
  });

  test("a failed open releases the lease it acquired", () => {
    fs.writeFileSync(fileDb, "this is not a sqlite database, just bytes".repeat(64));
    expect(() => Store.open(fileDb)).toThrow();
    expect(leaseIsFree(fileDb)).toBe(true);
  });

  test(":memory: is exempt from ownership", () => {
    const s = Store.open(":memory:");
    s.addTask({ title: "memory" });
    s.close();
    expect(fs.existsSync(ownerLockPath(path.resolve(":memory:")))).toBe(false);
  });

  test("there is no opt-out: every writable open either owns the database or reuses the caller's lease", () => {
    const options = { own: false } as unknown as Parameters<typeof Store.open>[1];
    const s = Store.open(fileDb, options);
    try {
      expect(leaseIsFree(fileDb)).toBe(false);
    } finally {
      s.close();
    }
  });
});

/**
 * Rewrite a current-schema DB into a 1024-era legacy shape: pending migration,
 * no notifications table and none of the private revision/receipt/identity
 * tables, which that era's binaries never created.
 */
function makeLegacyDb(db: string, options: { preMigrations?: boolean } = {}): void {
  const s = Store.open(db);
  const t = s.addTask({ title: "legacy task", body: "legacy body" });
  s.addUpdate({ task_id: t.id, author: "legacy-1", summary: "kept" });
  s.runInTransaction(raw => {
    // A database from before `_migrations` and tags existed (200/1024-era binaries).
    if (options.preMigrations) {
      raw.run("DROP TABLE task_tags;");
      raw.run("DROP TABLE tags;");
      raw.run("DROP TABLE _migrations;");
    }
    raw.run("DROP TABLE notifications;");
    raw.run("DROP TABLE memory_exclusions;");
    raw.run("DROP TABLE _resource_revisions;");
    raw.run("DROP TABLE _mutation_receipts;");
    raw.run("DROP TABLE _database_identity;");
    raw.run(`CREATE TABLE updates_legacy (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author   TEXT    NOT NULL,
      summary  TEXT    NOT NULL CHECK(length(summary) <= 1024),
      body     TEXT,
      severity TEXT    NOT NULL CHECK(severity IN ('progress','review','blocked')),
      created  INTEGER NOT NULL
    );`);
    raw.run("INSERT INTO updates_legacy SELECT * FROM updates;");
    raw.run("DROP TABLE updates;");
    raw.run("ALTER TABLE updates_legacy RENAME TO updates;");
    if (!options.preMigrations) raw.run("DELETE FROM _migrations WHERE name = 'updates-summary-4096';");
  });
  s.close();
}

const sha256 = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("Store.readSnapshot", () => {
  beforeEach(pinFileEnv);
  afterEach(restoreFileEnv);

  test("a missing database throws DatabaseNotFoundError and creates nothing (file, parent or config dir)", () => {
    for (const missing of [path.join(fileRoot, "absent.db"), path.join(fileRoot, "no-dir", "cortex.db")]) {
      let caught: unknown = null;
      try {
        Store.readSnapshot(missing, s => s.listTasks());
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DatabaseNotFoundError);
      expect((caught as DatabaseNotFoundError).path).toBe(missing);
      expect(fs.existsSync(missing)).toBe(false);
    }
    expect(fs.existsSync(path.join(fileRoot, "no-dir"))).toBe(false);
    expect(fs.existsSync(configDir())).toBe(false);
    expect(() => Store.readSnapshot(":memory:", s => s.listTasks())).toThrow();
  });

  test("reads a legacy schema without migrating it; the database file is byte-identical afterwards", () => {
    makeLegacyDb(fileDb);
    const before = sha256(fileDb);
    const snap = Store.readSnapshot(fileDb, s => ({
      pending: s.pendingMigrations(),
      titles: s.listTasks().map(t => t.title),
      updates: s.listUpdates(1).map(u => u.summary),
      excluded: [s.listTasks()[0]?.memory_excluded, s.getTask(1)?.memory_excluded],
    }));
    expect(snap).toEqual({
      pending: ["updates-summary-4096"],
      titles: ["legacy task"],
      updates: ["kept"],
      excluded: [false, false],
    });
    expect(sha256(fileDb)).toBe(before);
    // No migrate(): the notifications table is still absent, the migration still pending.
    expect(() => Store.readSnapshot(fileDb, s => s.listNotifications())).toThrow(/no such table/);
    expect(Store.readSnapshot(fileDb, s => s.pendingMigrations())).toEqual(["updates-summary-4096"]);
    expect(sha256(fileDb)).toBe(before);
  });

  test("counts() and pendingMigrations() read databases older than _migrations and tags, without writing", () => {
    makeLegacyDb(fileDb, { preMigrations: true });
    const before = sha256(fileDb);
    const snap = Store.readSnapshot(fileDb, s => ({ pending: s.pendingMigrations(), counts: s.counts() }));
    expect(snap).toEqual({ pending: ["updates-summary-4096"], counts: { tasks: 1, lanes: 1, tags: 0 } });
    expect(sha256(fileDb)).toBe(before);
  });

  test("counts() matches the list lengths of a current database", () => {
    const s = Store.open(fileDb);
    s.addTask({ title: "a", tags: ["x", "y"] });
    s.addTask({ title: "b", lane: "later" });
    s.close();
    expect(Store.readSnapshot(fileDb, r => r.counts())).toEqual({ tasks: 2, lanes: 2, tags: 2 });
  });

  test("rejects writes and leaves the data unchanged", () => {
    const s = Store.open(fileDb);
    s.addTask({ title: "only" });
    s.close();
    const before = sha256(fileDb);
    expect(() => Store.readSnapshot(fileDb, snap => snap.addTask({ title: "sneaky" }))).toThrow(/readonly/i);
    expect(() => Store.readSnapshot(fileDb, snap => snap.migrate())).toThrow(/readonly/i);
    expect(Store.readSnapshot(fileDb, snap => snap.listTasks().map(t => t.title))).toEqual(["only"]);
    expect(sha256(fileDb)).toBe(before);
  });

  test("neither takes nor needs the ownership lease", () => {
    Store.open(fileDb).close();
    const held = tryAcquireOwnership(fileDb);
    if (held === null) throw new Error("expected a lease");
    expect(Store.readSnapshot(fileDb, s => s.listLanes().map(l => l.name))).toEqual(["now"]);
    held.release();
    expect(Store.readSnapshot(fileDb, () => leaseIsFree(fileDb))).toBe(true);
  });

  test("sees one consistent snapshot while another connection commits", () => {
    const writer = Store.open(fileDb);
    writer.addTask({ title: "first" });
    const counts = Store.readSnapshot(fileDb, s => {
      const beforeWrite = s.listTasks().length;
      writer.addTask({ title: "committed mid-snapshot" });
      return [beforeWrite, s.listTasks().length];
    });
    expect(counts).toEqual([1, 1]);
    expect(Store.readSnapshot(fileDb, s => s.listTasks().length)).toBe(2);
    writer.close();
  });

  test("closes the connection even when the reader throws", () => {
    Store.open(fileDb).close();
    let captured: Store | null = null;
    expect(() =>
      Store.readSnapshot(fileDb, s => {
        captured = s;
        throw new Error("reader failed");
      }),
    ).toThrow("reader failed");
    const leaked = captured as Store | null;
    if (leaked === null) throw new Error("reader never ran");
    expect(() => leaked.listTasks()).toThrow();
  });
});

// ---------- scoped revisions (plan @400 N7) ----------

describe("Store: database identity and private metadata", () => {
  test("every database gets its own UUID while Task/Lane/Tag/Update JSON keep exactly their public fields", () => {
    const s = open();
    const id = s.databaseId();
    expect(id).toMatch(UUID_V4);
    expect(s.databaseId()).toBe(id);
    const other = open();
    expect(other.databaseId()).not.toBe(id);
    other.close();

    const t = s.addTask({ title: "x", tags: ["a"], author: "agent-1" });
    s.setStatus(t.id, "review", { author: "agent-1" });
    expect(Object.keys(t).sort()).toEqual([
      "body",
      "created",
      "id",
      "lane",
      "memory_excluded",
      "priority",
      "status",
      "tags",
      "title",
      "updated",
    ]);
    expect(Object.keys(s.getTask(t.id) ?? {}).sort()).toEqual(Object.keys(t).sort());
    expect(Object.keys(s.listLanes()[0]).sort()).toEqual(["color", "name", "sort"]);
    expect(Object.keys(s.listTags()[0]).sort()).toEqual(["color", "created", "name", "task_count"]);
    expect(Object.keys(s.listUpdates(t.id)[0]).sort()).toEqual([
      "author",
      "body",
      "created",
      "id",
      "severity",
      "summary",
      "task_id",
    ]);
    s.close();
  });
});

describe("Store: scoped revisions (N7)", () => {
  test("taskState returns the task, its updates and one opaque token per task scope", () => {
    const s = open();
    const t = s.addTask({ title: "doc", body: "b" });
    s.addUpdate({ task_id: t.id, author: "a-1", summary: "hello" });
    const state = s.taskState(t.id);
    expect(state?.task).toEqual(s.getTask(t.id) ?? undefined);
    expect(state?.updates.map(u => u.summary)).toEqual(["hello"]);
    expect(Object.keys(state?.versions ?? {}).sort()).toEqual(TASK_SCOPES);
    for (const value of tokens(state?.versions ?? null)) {
      expect(value.length).toBeGreaterThan(0);
      // Opaque, not timestamps: no numeric token, none equal to the row clocks.
      expect(Number.isFinite(Number(value))).toBe(false);
    }
    expect(s.taskState(9999)).toBeNull();
    s.close();
  });

  test("laneState and tagState pair a definition, its member count and its catalog tokens from one read", () => {
    const s = open();
    s.addLane({ name: "big ideas", color: "#2563eb", sort: 3 });
    s.addTask({ title: "a", lane: "big ideas", tags: ["x"] });
    s.addTask({ title: "b", tags: ["x"] });
    expect(s.laneState("big ideas")).toEqual({
      lane: { name: "big ideas", color: "#2563eb", sort: 3, task_count: 1 },
      versions: s.versions("lane", "big ideas") ?? {},
    });
    expect(s.laneState("now")?.lane.task_count).toBe(1);
    expect(Object.keys(s.laneState("now")?.versions ?? {}).sort()).toEqual(["definition", "entity"]);
    const tag = s.tagState("x");
    expect(tag?.tag).toMatchObject({ name: "x", color: null, task_count: 2 });
    expect(tag?.versions).toEqual(s.versions("tag", "x") ?? {});
    expect(s.laneState("nope")).toBeNull();
    expect(s.tagState("nope")).toBeNull();
    s.close();
  });

  test("tokens are not clocks: back-to-back writes in the same millisecond still get distinct tokens", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      s.editTask(t.id, { title: `t${i}` });
      seen.add(token(versionsOf(s, t.id), "title"));
    }
    expect(seen.size).toBe(20);
    s.close();
  });

  test("title and body tokens survive status, priority, lane, tag and activity changes; entity covers all of them", () => {
    const s = open();
    s.addLane({ name: "later" });
    const t = s.addTask({ title: "doc", body: "b2" });
    const steps: Array<[string, () => unknown, ResourceScope[]]> = [
      ["status", () => s.setStatus(t.id, "review", { author: "a-1" }), ["entity", "status"]],
      ["priority", () => s.editTask(t.id, { priority: 2 }), ["entity", "priority"]],
      ["lane", () => s.moveTask(t.id, "later"), ["entity", "lane"]],
      ["tags", () => s.setTaskTags(t.id, ["x"]), ["entity"]],
      // A post is a dependent row a delete would cascade: it moves `entity`, never a field token.
      ["activity", () => s.addUpdate({ task_id: t.id, author: "a-1", summary: "note" }), ["entity"]],
      ["title", () => s.editTask(t.id, { title: "doc 2" }), ["entity", "title"]],
      ["body", () => s.editTask(t.id, { body: "b3" }), ["body", "entity"]],
      ["anchor", () => s.editTask(t.id, { bodySearch: "b3", bodyReplace: "b4" }), ["body", "entity"]],
    ];
    for (const [label, write, expected] of steps) {
      const before = versionsOf(s, t.id);
      write();
      expect([label, changedScopes(before, versionsOf(s, t.id))]).toEqual([label, expected]);
    }
    s.close();
  });

  test("an identical value is not a field change, but every accepted status write is audited and advances status", () => {
    const s = open();
    const t = s.addTask({ title: "same", body: "b" });
    let before = versionsOf(s, t.id);
    s.editTask(t.id, { title: "same", body: "b" });
    // The row is still written (updated moves), so only the entity token moves.
    expect(changedScopes(before, versionsOf(s, t.id))).toEqual(["entity"]);
    before = versionsOf(s, t.id);
    s.setStatus(t.id, "open", { author: "a-1" });
    expect(changedScopes(before, versionsOf(s, t.id))).toEqual(["entity", "status"]);
    expect(s.listUpdates(t.id).map(u => u.summary)).toEqual(["status \u2192 open"]);
    s.close();
  });

  test("legacy unguarded writes stay last-writer-wins but advance tokens, so a stale guard conflicts afterwards", () => {
    const s = open();
    const t = s.addTask({ title: "t", body: "v1" });
    const seen = versionsOf(s, t.id);
    s.editTask(t.id, { body: "legacy overwrite" });
    expect(s.getTask(t.id)?.body).toBe("legacy overwrite");
    expect(thrown(() => s.editTask(t.id, { body: "stale draft" }, { expected: { body: seen.body } }))).toBeInstanceOf(
      ConflictError,
    );
    expect(s.getTask(t.id)?.body).toBe("legacy overwrite");
    s.editTask(t.id, { body: "second legacy write" });
    expect(s.getTask(t.id)?.body).toBe("second legacy write");
    s.close();
  });

  test("tag rename/delete and lane rename cascade into dependent task tokens, never title/body", () => {
    const s = open();
    s.addLane({ name: "later" });
    const a = s.addTask({ title: "a", lane: "later", tags: ["bug"] });
    const b = s.addTask({ title: "b" });
    const steps: Array<[string, () => unknown, ResourceScope[]]> = [
      ["tag rename", () => s.editTag("bug", { rename: "defect" }), ["entity"]],
      ["lane rename", () => s.editLane("later", { rename: "soon" }), ["entity", "lane"]],
      ["lane color", () => s.editLane("soon", { color: "#123456" }), []],
      ["tag delete", () => s.removeTag("defect", { force: true }), ["entity"]],
    ];
    for (const [label, write, expected] of steps) {
      const beforeA = versionsOf(s, a.id);
      const beforeB = versionsOf(s, b.id);
      write();
      expect([label, changedScopes(beforeA, versionsOf(s, a.id))]).toEqual([label, expected]);
      expect([label, changedScopes(beforeB, versionsOf(s, b.id))]).toEqual([label, []]);
    }
    expect(s.getTask(a.id)).toMatchObject({ lane: "soon", tags: [] });
    s.close();
  });

  test("catalog tokens: definition tracks name/color/sort, entity also tracks membership", () => {
    const s = open();
    s.addLane({ name: "later" });
    s.addTag({ name: "x" });
    const t = s.addTask({ title: "t" });
    expect(Object.keys(s.versions("lane", "later") ?? {}).sort()).toEqual(["definition", "entity"]);
    expect(Object.keys(s.versions("tag", "x") ?? {}).sort()).toEqual(["definition", "entity"]);
    const steps: Array<[string, () => unknown, "lane" | "tag", string, ResourceScope[]]> = [
      ["move in", () => s.moveTask(t.id, "later"), "lane", "later", ["entity"]],
      ["lane color", () => s.editLane("later", { color: "#111111" }), "lane", "later", ["definition", "entity"]],
      ["lane sort", () => s.editLane("later", { sort: 3 }), "lane", "later", ["definition", "entity"]],
      ["same color", () => s.editLane("later", { color: "#111111" }), "lane", "later", []],
      ["tag member", () => s.setTaskTags(t.id, ["x"]), "tag", "x", ["entity"]],
      ["tag color", () => s.editTag("x", { color: "#222222" }), "tag", "x", ["definition", "entity"]],
      ["untag", () => s.setTaskTags(t.id, []), "tag", "x", ["entity"]],
    ];
    for (const [label, write, kind, name, expected] of steps) {
      const before = s.versions(kind, name) ?? {};
      write();
      expect([label, changedScopes(before, s.versions(kind, name) ?? {})]).toEqual([label, expected]);
    }
    expect(s.versions("lane", "missing")).toBeNull();
    expect(s.versions("tag", "missing")).toBeNull();
    expect(s.versions("task", 9999)).toBeNull();
    s.close();
  });

  test("deleted names and ids never reuse a token when they come back (ABA)", () => {
    const s = open();
    const history = new Map<string, Set<string>>();
    const record = (key: string, values: string[]): void => {
      const seen = history.get(key) ?? new Set<string>();
      for (const value of values) seen.add(value);
      history.set(key, seen);
    };
    const expectFresh = (key: string, values: string[]): void => {
      const seen = history.get(key) ?? new Set<string>();
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) expect([key, seen.has(value)]).toEqual([key, false]);
    };

    s.addLane({ name: "later" });
    record("lane", tokens(s.versions("lane", "later")));
    s.removeLane("later");
    expect(s.versions("lane", "later")).toBeNull();
    s.addLane({ name: "later" });
    expectFresh("lane", tokens(s.versions("lane", "later")));

    s.addTag({ name: "x" });
    record("tag", tokens(s.versions("tag", "x")));
    s.removeTag("x");
    s.addTag({ name: "x" });
    expectFresh("tag", tokens(s.versions("tag", "x")));

    // Renaming away and back is a delete + recreate of the name.
    record("tag", tokens(s.versions("tag", "x")));
    s.editTag("x", { rename: "y" });
    s.editTag("y", { rename: "x" });
    expectFresh("tag", tokens(s.versions("tag", "x")));

    const t = s.addTask({ title: "first life", body: "b" });
    record("task", tokens(versionsOf(s, t.id)));
    s.removeTask(t.id);
    expect(s.taskState(t.id)).toBeNull();
    const tombstones = s.runInTransaction(raw =>
      raw
        .query<{ token: string }, [string]>("SELECT token FROM _resource_revisions WHERE resource = ?;")
        .all(`task:${t.id}`)
        .map(row => row.token),
    );
    // Tombstones are retained (one per task scope) and are themselves fresh.
    expect(tombstones.length).toBe(TASK_SCOPES.length);
    expectFresh("task", tombstones);
    record("task", tombstones);
    // Put the id back into circulation, as a legacy tasks-table rebuild (which lowers
    // sqlite_sequence) or a merge-restored id does.
    s.runInTransaction(raw => raw.run("UPDATE sqlite_sequence SET seq = 0 WHERE name = 'tasks';"));
    const again = s.addTask({ title: "second life", body: "b" });
    expect(again.id).toBe(t.id);
    expectFresh("task", tokens(versionsOf(s, again.id)));
    s.close();
  });

  test("a token never comes back once superseded, across a long mixed history", () => {
    const s = open();
    s.addLane({ name: "later" });
    const t = s.addTask({ title: "t", body: "b" });
    const timeline: Versions[] = [versionsOf(s, t.id)];
    const writes: Array<() => unknown> = [
      () => s.editTask(t.id, { title: "t2" }),
      () => s.editTask(t.id, { title: "t" }),
      () => s.editTask(t.id, { body: "b2" }),
      () => s.editTask(t.id, { body: "b" }),
      () => s.setStatus(t.id, "blocked"),
      () => s.setStatus(t.id, "open"),
      () => s.moveTask(t.id, "later"),
      () => s.moveTask(t.id, "now"),
      () => s.setTaskTags(t.id, ["x"]),
      () => s.setTaskTags(t.id, []),
      () => s.editTask(t.id, { priority: 1 }),
      () => s.editTask(t.id, { priority: null }),
    ];
    for (const write of writes) {
      write();
      timeline.push(versionsOf(s, t.id));
    }
    for (const scope of TASK_SCOPES) {
      const runs = timeline.map(v => token(v, scope)).filter((value, i, all) => i === 0 || value !== all[i - 1]);
      expect([scope, new Set(runs).size]).toEqual([scope, runs.length]);
    }
    s.close();
  });
});

// ---------- guarded writes (plan @400 N8) ----------

describe("Store: guarded writes (N8)", () => {
  test("a stale same-field guard throws a structured ConflictError and writes nothing", () => {
    const s = open();
    const t = s.addTask({ title: "t", body: "base" });
    const seen = versionsOf(s, t.id);
    s.editTask(t.id, { body: "theirs" }, { expected: { body: seen.body } });
    const current = versionsOf(s, t.id);
    const before = snapshot(s);
    const err = thrown(() => s.editTask(t.id, { body: "mine" }, { expected: { body: seen.body } }));
    expect(err).toBeInstanceOf(ConflictError);
    const conflict = err as ConflictError;
    expect(conflict.code).toBe("version_conflict");
    expect(conflict.kind).toBe("task");
    expect(conflict.key).toBe(t.id);
    expect(conflict.mismatches).toEqual([
      { scope: "body", expected: token(seen, "body"), current: token(current, "body") },
    ]);
    expect(conflict.current).toEqual(current);
    expect(snapshot(s)).toEqual(before);
    expect(s.getTask(t.id)?.body).toBe("theirs");
    s.close();
  });

  test("same task, different fields: independent guarded saves all succeed from one baseline", () => {
    const s = open();
    s.addLane({ name: "later" });
    const t = s.addTask({ title: "t", body: "b" });
    const other = s.addTask({ title: "other" });
    const seen = versionsOf(s, t.id);
    const seenOther = versionsOf(s, other.id);
    s.editTask(t.id, { title: "title by A" }, { expected: { title: seen.title } });
    s.editTask(t.id, { body: "body by B" }, { expected: { body: seen.body } });
    s.setStatus(t.id, "review", { author: "c-1" }, { expected: { status: seen.status } });
    s.editTask(t.id, { priority: 1 }, { expected: { priority: seen.priority } });
    s.moveTask(t.id, "later", { expected: { lane: seen.lane } });
    s.editTask(other.id, { title: "other task" }, { expected: { title: seenOther.title } });
    expect(s.getTask(t.id)).toMatchObject({
      title: "title by A",
      body: "body by B",
      status: "review",
      priority: 1,
      lane: "later",
    });
    expect(s.getTask(other.id)?.title).toBe("other task");
    s.close();
  });

  test("a supplied guard must cover every changed field", () => {
    const s = open();
    const t = s.addTask({ title: "t", body: "b" });
    const v = versionsOf(s, t.id);
    const lane = s.versions("lane", "now");
    const before = snapshot(s);
    const partial: Array<() => unknown> = [
      () => s.editTask(t.id, { title: "x", body: "y" }, { expected: { title: v.title } }),
      () => s.editTask(t.id, { title: "x" }, { expected: {} }),
      () => s.editTask(t.id, { bodySearch: "b", bodyReplace: "c" }, { expected: { title: v.title } }),
      () => s.setStatus(t.id, "done", {}, { expected: { title: v.title } }),
      () => s.moveTask(t.id, "later", { expected: { status: v.status } }),
      () => s.setTaskTags(t.id, ["a"], { expected: { title: v.title } }),
      () => s.removeTask(t.id, { expected: { title: v.title } }),
      () =>
        s.postUpdate({ task_id: t.id, author: "a-1", summary: "s", status: "done" }, { expected: { body: v.body } }),
      () => s.editLane("now", { color: "#000000" }, { expected: { entity: token(lane, "entity") } }),
      // A rename is identity-changing: it needs the entity token too.
      () => s.editLane("now", { rename: "today" }, { expected: { definition: token(lane, "definition") } }),
    ];
    for (const write of partial) expect(thrown(write)).toBeInstanceOf(WriteGuardError);
    expect(snapshot(s)).toEqual(before);
    s.close();
  });

  test("malformed guards fail validation before touching data", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    s.addTag({ name: "x" });
    const before = snapshot(s);
    const malformed: unknown[] = [
      null,
      "token",
      [],
      { expected: "t" },
      { expected: [] },
      { expected: { tags: "x" } },
      { expected: { title: "x", definition: "y" } },
      { expected: { title: 1 } },
      { expected: { title: "" } },
      { expect: { title: "x" } },
      { mutationId: "" },
      { mutationId: 5 },
      { mutationId: "has space" },
    ];
    for (const guard of malformed) {
      expect([guard, thrown(() => s.editTask(t.id, { title: "x" }, guard as WriteGuard))]).toEqual([
        guard,
        expect.any(WriteGuardError),
      ]);
    }
    expect(thrown(() => s.editTag("x", { color: "#000000" }, { expected: { title: "x" } }))).toBeInstanceOf(
      WriteGuardError,
    );
    // A create has no prior version to compare against.
    expect(thrown(() => s.addTask({ title: "n" }, { expected: { title: "x" } }))).toBeInstanceOf(WriteGuardError);
    expect(snapshot(s)).toEqual(before);
    s.close();
  });

  test("status, move, tags and delete honor their scopes; stale guards leave the audit trail untouched", () => {
    const s = open();
    s.addLane({ name: "later" });
    const t = s.addTask({ title: "t" });
    const seen = versionsOf(s, t.id);
    s.setStatus(t.id, "blocked", { author: "other-1" });
    s.moveTask(t.id, "later");
    s.setTaskTags(t.id, ["x"]);
    const before = snapshot(s);
    const stale: Array<() => unknown> = [
      () => s.setStatus(t.id, "done", { author: "me-1" }, { expected: { status: seen.status } }),
      () => s.moveTask(t.id, "now", { expected: { lane: seen.lane } }),
      () => s.setTaskTags(t.id, [], { expected: { entity: seen.entity } }),
      () => s.removeTask(t.id, { expected: { entity: seen.entity } }),
      () =>
        s.postUpdate(
          { task_id: t.id, author: "me-1", summary: "closing", status: "done", notify: true },
          { expected: { status: seen.status } },
        ),
    ];
    for (const write of stale) expect(thrown(write)).toBeInstanceOf(ConflictError);
    expect(snapshot(s)).toEqual(before);

    s.removeTask(t.id, { expected: { entity: versionsOf(s, t.id).entity } });
    expect(s.getTask(t.id)).toBeNull();
    // A guarded write to a missing task is a not-found, not a conflict.
    const missing = thrown(() => s.editTask(t.id, { title: "x" }, { expected: { title: seen.title } }));
    expect(missing).not.toBeInstanceOf(ConflictError);
    expect((missing as Error).message).toMatch(/not found/);
    s.close();
  });

  test("a delete confirmed before a concurrent post is refused and cascades nothing; unguarded deletes still work", () => {
    const s = open();
    const t = s.addTask({ title: "doomed", body: "b" });
    const confirmed = versionsOf(s, t.id); // what the delete confirmation read
    const late = s.postUpdate({ task_id: t.id, author: "agent-1", summary: "posted after the dialog opened" });
    const before = snapshot(s);
    const stale = thrown(() => s.removeTask(t.id, { expected: { entity: token(confirmed, "entity") } }));
    expect(stale).toBeInstanceOf(ConflictError);
    expect((stale as ConflictError).mismatches.map(m => m.scope)).toEqual(["entity"]);
    expect(snapshot(s)).toEqual(before);
    expect(s.listUpdates(t.id).map(u => u.id)).toEqual([late.update.id]);
    // N7: activity never invalidates a title/body draft.
    const now = versionsOf(s, t.id);
    expect([now.title, now.body]).toEqual([confirmed.title, confirmed.body]);
    // A status post's message and audit rows move it too (one transaction).
    s.postUpdate({ task_id: t.id, author: "agent-1", summary: "closing", status: "done" });
    expect(thrown(() => s.removeTask(t.id, { expected: { entity: token(now, "entity") } }))).toBeInstanceOf(
      ConflictError,
    );
    expect(s.listUpdates(t.id)).toHaveLength(3);
    // Confirmed against a fresh read, the delete goes through; a legacy unguarded delete never conflicts.
    s.removeTask(t.id, { expected: { entity: token(versionsOf(s, t.id), "entity") } });
    expect(s.getTask(t.id)).toBeNull();
    const legacy = s.addTask({ title: "legacy" });
    s.addUpdate({ task_id: legacy.id, author: "agent-1", summary: "note" });
    s.removeTask(legacy.id);
    expect(s.getTask(legacy.id)).toBeNull();
    s.close();
  });

  test("a catalog delete confirmed at zero members and raced by a new member conflicts before the membership policy", () => {
    const s = open();
    s.addTag({ name: "old" });
    const confirmed = s.versions("tag", "old"); // no members when the user confirmed
    s.addTask({ title: "joins", tags: ["old"] });
    s.addLane({ name: "later" });
    const empty = s.versions("lane", "later");
    s.addTask({ title: "arrives", lane: "later" });
    const before = snapshot(s);
    expect(thrown(() => s.removeTag("old", {}, { expected: { entity: token(confirmed, "entity") } }))).toBeInstanceOf(
      ConflictError,
    );
    expect(thrown(() => s.removeLane("later", { expected: { entity: token(empty, "entity") } }))).toBeInstanceOf(
      ConflictError,
    );
    expect(snapshot(s)).toEqual(before);
    // Current versions (or none): the membership policy still refuses, as a plain error.
    const policies = [
      () => s.removeTag("old", {}, { expected: { entity: token(s.versions("tag", "old"), "entity") } }),
      () => s.removeTag("old"),
      () => s.removeLane("later", { expected: { entity: token(s.versions("lane", "later"), "entity") } }),
      () => s.removeLane("later"),
    ];
    for (const write of policies) {
      const err = thrown(write);
      expect(err).not.toBeInstanceOf(ConflictError);
      expect((err as Error).message).toMatch(/task\(s\) reference it/);
    }
    // A missing catalog entry is a not-found, never a conflict.
    for (const write of [
      () => s.removeTag("nope", {}, { expected: { entity: "stale" } }),
      () => s.removeLane("nope", { expected: { entity: "stale" } }),
    ]) {
      const err = thrown(write);
      expect(err).not.toBeInstanceOf(ConflictError);
      expect((err as Error).message).toMatch(/not found/);
    }
    expect(snapshot(s)).toEqual(before);
    s.close();
  });

  test("catalog guards: stale definitions and impact counts are refused", () => {
    const s = open();
    s.addLane({ name: "later" });
    const lane = s.versions("lane", "later");
    s.editLane("later", { color: "#333333" });
    expect(
      thrown(() => s.editLane("later", { color: "#444444" }, { expected: { definition: token(lane, "definition") } })),
    ).toBeInstanceOf(ConflictError);
    expect(s.listLanes().find(l => l.name === "later")?.color).toBe("#333333");

    s.addTag({ name: "old" });
    s.addTask({ title: "a", tags: ["old"] });
    const confirmed = s.versions("tag", "old");
    s.addTask({ title: "b", tags: ["old"] }); // impact grew after the user confirmed
    expect(
      thrown(() => s.removeTag("old", { force: true }, { expected: { entity: token(confirmed, "entity") } })),
    ).toBeInstanceOf(ConflictError);
    expect(s.listTags().find(t => t.name === "old")?.task_count).toBe(2);
    s.removeTag("old", { force: true }, { expected: { entity: token(s.versions("tag", "old"), "entity") } });
    expect(s.listTags().some(t => t.name === "old")).toBe(false);

    const empty = s.versions("lane", "later");
    const t = s.addTask({ title: "passing through", lane: "later" });
    s.moveTask(t.id, "now");
    expect(thrown(() => s.removeLane("later", { expected: { entity: token(empty, "entity") } }))).toBeInstanceOf(
      ConflictError,
    );
    s.removeLane("later", { expected: { entity: token(s.versions("lane", "later"), "entity") } });
    expect(s.listLanes().some(l => l.name === "later")).toBe(false);
    s.close();
  });
});

// ---------- transactional receipts (plan @400 N8) ----------

describe("Store: idempotent receipts (N8)", () => {
  test("the first run commits effects with its receipt; a retry replays the original result without re-running", () => {
    const s = open();
    const input = { title: "created once", tags: ["x"] };
    const digest = mutationDigest("task.create", input);
    let runs = 0;
    const create = () => {
      runs++;
      return s.addTask(input);
    };
    const first = s.runIdempotent("m-create-1", digest, create);
    expect(first.replayed).toBe(false);
    s.editTask(first.value.id, { title: "renamed later" });
    const retry = s.runIdempotent("m-create-1", digest, create);
    // The ORIGINAL acknowledgement, not the current state.
    expect(retry).toEqual({ value: first.value, replayed: true });
    expect(runs).toBe(1);
    expect(s.listTasks().length).toBe(1);
    s.close();
  });

  test("reusing a mutation id with a different input is rejected without writing", () => {
    const s = open();
    s.runIdempotent("m-1", mutationDigest("task.create", { title: "a" }), () => s.addTask({ title: "a" }));
    const before = snapshot(s);
    const err = thrown(() =>
      s.runIdempotent("m-1", mutationDigest("task.create", { title: "b" }), () => s.addTask({ title: "b" })),
    );
    expect(err).toBeInstanceOf(MutationReuseError);
    expect((err as MutationReuseError).mutationId).toBe("m-1");
    expect(snapshot(s)).toEqual(before);
    s.close();
  });

  test("a failed write rolls back every effect and leaves no receipt", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    const before = snapshot(s);
    const err = thrown(() =>
      s.runIdempotent("m-fail", "digest-1", () => {
        s.editTask(t.id, { title: "partial" });
        s.addUpdate({ task_id: t.id, author: "a-1", summary: "half done" });
        throw new Error("boom");
      }),
    );
    expect((err as Error).message).toBe("boom");
    expect(snapshot(s)).toEqual(before);
    // The id was never consumed, so a corrected attempt runs normally.
    const ok = s.runIdempotent("m-fail", "digest-2", () => s.editTask(t.id, { title: "complete" }));
    expect(ok.replayed).toBe(false);
    expect(s.getTask(t.id)?.title).toBe("complete");
    s.close();
  });

  test("receipts are consulted before guards and existence checks", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    const guard: WriteGuard = { mutationId: "m-status", expected: { status: versionsOf(s, t.id).status } };
    const digest = mutationDigest("task.status", { id: t.id, status: "done", guard });
    const write = () => s.setStatus(t.id, "done", { author: "a-1" }, guard);
    const first = s.runIdempotent("m-status", digest, write);
    // Lost acknowledgement: by the retry the guard is stale AND the task is gone.
    s.removeTask(t.id);
    expect(s.runIdempotent("m-status", digest, write)).toEqual({ value: first.value, replayed: true });
    s.close();
  });

  test("a guard's mutationId must name the enclosing runIdempotent call", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    expect(thrown(() => s.editTask(t.id, { title: "x" }, { mutationId: "m-outside" }))).toBeInstanceOf(WriteGuardError);
    expect(
      thrown(() => s.runIdempotent("m-a", "d", () => s.editTask(t.id, { title: "x" }, { mutationId: "m-b" }))),
    ).toBeInstanceOf(WriteGuardError);
    const ok = s.runIdempotent("m-a", "d", () => s.editTask(t.id, { title: "x" }, { mutationId: "m-a" }));
    expect(ok.value.title).toBe("x");
    s.close();
  });

  test("malformed mutation ids and digests are rejected", () => {
    const s = open();
    for (const id of ["", " spaced", "a".repeat(129), "line\nbreak"]) {
      expect(thrown(() => s.runIdempotent(id, "d", () => 1))).toBeInstanceOf(WriteGuardError);
    }
    expect(thrown(() => s.runIdempotent("m-ok", "", () => 1))).toBeInstanceOf(TypeError);
    s.close();
  });

  test("mutationDigest is canonical over key order and undefined fields, sensitive to everything else", () => {
    expect(mutationDigest("op", { a: 1, b: [1, 2], c: undefined })).toBe(mutationDigest("op", { b: [1, 2], a: 1 }));
    expect(mutationDigest("op", { a: 1 })).not.toBe(mutationDigest("op2", { a: 1 }));
    expect(mutationDigest("op", { b: [1, 2] })).not.toBe(mutationDigest("op", { b: [2, 1] }));
    expect(mutationDigest("op", { a: { x: 1, y: 2 } })).toBe(mutationDigest("op", { a: { y: 2, x: 1 } }));
    expect(mutationDigest("op", { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------- atomic attributed operations (plan @400 N9) ----------

describe("Store: atomic attributed operations (N9)", () => {
  test("addTask applies tags, the `created` attribution and revisions in one transaction", () => {
    const s = open();
    const t = s.addTask({ title: "t", tags: ["zeta", "alpha", "alpha"], author: "agent-1" });
    expect(t.tags).toEqual(["alpha", "zeta"]);
    expect(s.listUpdates(t.id).map(u => [u.author, u.summary])).toEqual([["agent-1", "created"]]);
    expect(s.versions("tag", "alpha")).not.toBeNull();

    const before = snapshot(s);
    expect(() => s.addTask({ title: "bad", tags: ["ok", "BAD!"] })).toThrow(/invalid tag name/);
    expect(() => s.addTask({ title: "bad", author: "x".repeat(81) })).toThrow(/author tag/);
    // A failure after the insert (here: the tag join) rolls back the task, its
    // `created` row, the auto-created tag and every revision stamp.
    const restore = failOn(s, "fail_task_tags", "BEFORE INSERT ON task_tags");
    expect(() => s.addTask({ title: "half", tags: ["fresh"], author: "agent-1" })).toThrow(/injected/);
    restore();
    expect(snapshot(s)).toEqual(before);
    s.close();
  });

  test("an opt-in untitled create is named after its id; explicit titles are never renamed", () => {
    const s = open();
    const u = s.addTask({ untitled: true, lane: "later" });
    expect(u.title).toBe(`untitled-${u.id}`);
    expect(s.getTask(u.id)?.title).toBe(`untitled-${u.id}`);
    expect(s.addTask({ title: "untitled" }).title).toBe("untitled");
    expect(s.addTask({ title: "untitled-99" }).title).toBe("untitled-99");
    const before = snapshot(s);
    expect(() => s.addTask({ untitled: true, title: "Real title" } as never)).toThrow(/untitled/);
    expect(snapshot(s)).toEqual(before);
    s.close();
  });

  test("a status-bearing post writes the message and the `status → x` audit row in one transaction", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    const posted = s.postUpdate({ task_id: t.id, author: "agent-1", summary: "ready for review", status: "review" });
    const rows = s.listUpdates(t.id);
    expect(rows.map(u => [u.author, u.summary])).toEqual([
      ["agent-1", "ready for review"],
      ["agent-1", "status \u2192 review"],
    ]);
    expect(posted.update).toEqual(rows[0]);
    expect(posted.status).toEqual({
      task: mustGet(s, t.id),
      previous: "open",
      audit: rows[1],
      notification: null,
    });
    // addUpdate keeps its Update-only contract while honoring the status.
    const plain = s.addUpdate({ task_id: t.id, author: "agent-1", summary: "shipped", status: "done" });
    expect(plain.summary).toBe("shipped");
    expect(s.getTask(t.id)?.status).toBe("done");
    // Without a status nothing but the message is written.
    expect(s.postUpdate({ task_id: t.id, author: "agent-1", summary: "fyi" }).status).toBeNull();

    // Atomicity: a failing status write takes the message row down with it.
    const before = snapshot(s);
    const restore = failOn(s, "fail_status", "BEFORE UPDATE OF status ON tasks");
    expect(() => s.postUpdate({ task_id: t.id, author: "agent-1", summary: "reopen", status: "open" })).toThrow(
      /injected/,
    );
    restore();
    expect(snapshot(s)).toEqual(before);
    expect(() => s.postUpdate({ task_id: t.id, author: "agent-1", summary: "x", status: "bogus" as never })).toThrow(
      /status/,
    );
    expect(snapshot(s)).toEqual(before);
    s.close();
  });

  test("transition notifications persist inside the status transaction; same-status writes audit but never notify", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    const blocked = s.postUpdate({
      task_id: t.id,
      author: "agent-1",
      summary: "stuck",
      status: "blocked",
      notify: true,
    });
    expect(blocked.status?.notification).toMatchObject({
      task_id: t.id,
      author: "agent-1",
      status: "blocked",
      title: `[${t.id}] t`,
      message: "open \u2192 blocked",
      read: false,
    });
    const note = blocked.status?.notification;
    if (!note) throw new Error("expected a transition notification");
    expect(s.listNotifications()).toEqual([note]);

    const again = s.postUpdate({
      task_id: t.id,
      author: "agent-1",
      summary: "still stuck",
      status: "blocked",
      notify: true,
    });
    expect(again.status?.notification).toBeNull();
    expect(again.status?.audit.summary).toBe("status \u2192 blocked");
    expect(s.listNotifications().length).toBe(1);

    // Human clicks stay silent unless the caller asks; setStatus is unchanged.
    const human = s.transitionStatus(t.id, "open", { author: "kalindu" });
    expect(human).toMatchObject({ previous: "blocked", notification: null });
    expect(s.setStatus(t.id, "review", { author: "kalindu" }).status).toBe("review");
    expect(s.listNotifications().length).toBe(1);
    const agent = s.transitionStatus(t.id, "blocked", { author: "agent-2", notify: true });
    expect(agent.notification?.message).toBe("review \u2192 blocked");
    expect(agent.audit).toMatchObject({ author: "agent-2", summary: "status \u2192 blocked" });

    // The notification commits with the status or not at all.
    const before = snapshot(s);
    const restore = failOn(s, "fail_notify", "BEFORE INSERT ON notifications");
    expect(() =>
      s.postUpdate({ task_id: t.id, author: "agent-1", summary: "done", status: "done", notify: true }),
    ).toThrow(/injected/);
    restore();
    expect(snapshot(s)).toEqual(before);
    s.close();
  });

  test("a deduplicated replay of a status post persists and returns nothing new", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    const input = {
      task_id: t.id,
      author: "agent-1",
      summary: "blocked on review",
      status: "blocked" as const,
      notify: true,
    };
    const digest = mutationDigest("update.post", input);
    const first = s.runIdempotent("m-post", digest, () => s.postUpdate(input));
    expect(first.value.status?.notification).not.toBeNull();
    const before = snapshot(s);
    expect(s.runIdempotent("m-post", digest, () => s.postUpdate(input))).toEqual({
      value: first.value,
      replayed: true,
    });
    expect(snapshot(s)).toEqual(before);
    expect(s.listUpdates(t.id).length).toBe(2);
    expect(s.listNotifications().length).toBe(1);
    s.close();
  });
});

// ---------- file-backed: identity, receipts and legacy rows across restarts ----------

describe("Store: revisions and receipts across restarts", () => {
  beforeEach(pinFileEnv);
  afterEach(restoreFileEnv);

  test("lost acknowledgement: a receipt replays the original result after a restart, until reset", () => {
    let s = Store.open(fileDb);
    const databaseId = s.databaseId();
    const input = { title: "created before the crash", tags: ["x"], author: "agent-1" };
    const digest = mutationDigest("task.create", input);
    const first = s.runIdempotent("m-restart", digest, () => s.addTask(input));
    s.close();

    s = Store.open(fileDb); // the daemon restarts; the client retries with the same id
    expect(s.databaseId()).toBe(databaseId);
    expect(s.runIdempotent("m-restart", digest, () => s.addTask(input))).toEqual({
      value: first.value,
      replayed: true,
    });
    expect(s.listTasks().length).toBe(1);
    expect(s.listUpdates(first.value.id).length).toBe(1);
    s.close();

    // `cortex reset` deletes the files: a fresh identity and no receipts.
    for (const file of [fileDb, `${fileDb}-wal`, `${fileDb}-shm`]) fs.rmSync(file, { force: true });
    s = Store.open(fileDb);
    expect(s.databaseId()).not.toBe(databaseId);
    expect(s.runIdempotent("m-restart", digest, () => s.addTask(input)).replayed).toBe(false);
    s.close();
  });

  test("receipts older than RECEIPT_RETENTION_MS are pruned on the next open; younger ones still replay", () => {
    let s = Store.open(fileDb);
    const create = (title: string) => () => s.addTask({ title });
    const oldDigest = mutationDigest("task.create", { title: "old" });
    const youngDigest = mutationDigest("task.create", { title: "young" });
    s.runIdempotent("m-old", oldDigest, create("old"));
    s.runIdempotent("m-young", youngDigest, create("young"));
    const at = Date.now();
    s.runInTransaction(raw => {
      raw.run(`UPDATE _mutation_receipts SET created = ? WHERE mutation_id = 'm-old';`, [
        at - RECEIPT_RETENTION_MS - 1000,
      ]);
      raw.run(`UPDATE _mutation_receipts SET created = ? WHERE mutation_id = 'm-young';`, [
        at - RECEIPT_RETENTION_MS + 60_000,
      ]);
    });
    s.close();

    s = Store.open(fileDb);
    expect(s.runIdempotent("m-young", youngDigest, create("young")).replayed).toBe(true);
    expect(s.runIdempotent("m-old", oldDigest, create("old")).replayed).toBe(false);
    expect(s.listTasks().length).toBe(3);
    const index = s.runInTransaction(raw =>
      raw
        .query<{ tbl_name: string }, []>(
          `SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = '_mutation_receipts_created';`,
        )
        .get(),
    );
    expect(index?.tbl_name).toBe("_mutation_receipts");
    s.close();
  });

  test("rows written without revision metadata get deterministic, database-scoped tokens; taskState never writes", () => {
    const legacyRow =
      "INSERT INTO tasks (id, lane, title, body, status, priority, created, updated) VALUES (7, 'now', 'legacy', 'b', 'open', NULL, 1, 1);";
    const s = Store.open(fileDb);
    s.runInTransaction(raw => raw.run(legacyRow));
    const first = versionsOf(s, 7);
    expect(Object.keys(first).sort()).toEqual(TASK_SCOPES);
    expect(versionsOf(s, 7)).toEqual(first);
    // A readonly connection computes the same tokens, so reading persisted nothing.
    expect(Store.readSnapshot(fileDb, r => r.taskState(7)?.versions)).toEqual(first);

    const otherPath = path.join(fileRoot, "other.db");
    const other = Store.open(otherPath);
    other.runInTransaction(raw => raw.run(legacyRow));
    expect(token(versionsOf(other, 7), "title")).not.toBe(token(first, "title"));
    other.close();

    s.editTask(7, { title: "renamed" }, { expected: { title: first.title } });
    expect(changedScopes(first, versionsOf(s, 7))).toEqual(["entity", "title"]);
    s.close();
  });

  test("opening a pre-revision database adds the private tables without touching its data", () => {
    makeLegacyDb(fileDb);
    const s = Store.open(fileDb, { warnMigrations: false });
    expect(s.databaseId()).toMatch(UUID_V4);
    expect(s.pendingMigrations()).toEqual(["updates-summary-4096"]);
    expect(s.listTasks().map(t => t.title)).toEqual(["legacy task"]);
    expect(s.listUpdates(1).map(u => u.summary)).toEqual(["kept"]);
    // makeLegacyDb rebuilds `updates`, which drops its indexes: the path of an old or rebuilt table.
    expect(updatesIndexTable(s)).toBe("updates");
    const legacy = versionsOf(s, 1);
    s.editTask(1, { body: "guarded edit" }, { expected: { body: legacy.body } });
    expect(thrown(() => s.editTask(1, { body: "stale" }, { expected: { body: legacy.body } }))).toBeInstanceOf(
      ConflictError,
    );
    s.close();
  });
});

// ---------- plan @400 Task 5: tag deltas, created notifications, snapshots ----------

describe("Store: atomic tag membership deltas", () => {
  test("changeTaskTags adds and removes members without replacing the set", () => {
    const s = open();
    const t = s.addTask({ title: "t", tags: ["keep", "old"] });
    expect(s.changeTaskTags(t.id, { add: ["new", "keep"], remove: ["old", "absent"] }).tags).toEqual(["keep", "new"]);
    expect(s.changeTaskTags(t.id, { add: ["zeta"] }).tags).toEqual(["keep", "new", "zeta"]);
    expect(s.changeTaskTags(t.id, { remove: ["keep", "zeta"] }).tags).toEqual(["new"]);
    expect(s.listTags().map(g => g.name)).toEqual(["keep", "new", "old", "zeta"]);
    s.close();
  });

  test("validates the whole delta before writing: bad names, missing task, add+remove overlap", () => {
    const s = open();
    const t = s.addTask({ title: "t", tags: ["a"] });
    const before = snapshot(s);
    expect(() => s.changeTaskTags(t.id, { add: ["ok", "BAD!"] })).toThrow(/invalid tag name/);
    expect(() => s.changeTaskTags(t.id, { remove: ["BAD!"] })).toThrow(/invalid tag name/);
    expect(() => s.changeTaskTags(t.id, { add: ["x"], remove: [" x "] })).toThrow(/both added and removed/);
    expect(() => s.changeTaskTags(9999, { add: ["x"] })).toThrow(/task 9999 not found/);
    expect(snapshot(s)).toEqual(before);
    s.close();
  });

  test("revisions: a real membership change bumps the task entity and each touched tag; a no-op bumps nothing", () => {
    const s = open();
    const t = s.addTask({ title: "t", tags: ["a"] });
    const v0 = versionsOf(s, t.id);
    const a0 = s.versions("tag", "a");
    s.changeTaskTags(t.id, { add: ["a"], remove: ["never-there"] });
    expect(changedScopes(v0, versionsOf(s, t.id))).toEqual([]);
    expect(s.versions("tag", "a")).toEqual(a0);
    s.changeTaskTags(t.id, { add: ["fresh"], remove: ["a"] });
    expect(changedScopes(v0, versionsOf(s, t.id))).toEqual(["entity"]);
    expect(token(s.versions("tag", "a"), "entity")).not.toBe(token(a0, "entity"));
    expect(token(s.versions("tag", "a"), "definition")).toBe(token(a0, "definition"));
    expect(s.versions("tag", "fresh")).not.toBeNull();
    s.close();
  });

  test("a guard is optional; its scopes are extra preconditions compared in the transaction", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    const v = versionsOf(s, t.id);
    s.editTask(t.id, { title: "moved on" });
    const before = snapshot(s);
    expect(thrown(() => s.changeTaskTags(t.id, { add: ["x"] }, { expected: { title: v.title } }))).toBeInstanceOf(
      ConflictError,
    );
    expect(thrown(() => s.changeTaskTags(t.id, { add: ["x"] }, { expected: { tags: "t" } as never }))).toBeInstanceOf(
      WriteGuardError,
    );
    expect(snapshot(s)).toEqual(before);
    expect(s.changeTaskTags(t.id, { add: ["x"] }, { expected: { title: versionsOf(s, t.id).title } }).tags).toEqual([
      "x",
    ]);
    s.close();
  });

  test("a failure mid-delta rolls back every membership row and revision", () => {
    const s = open();
    const t = s.addTask({ title: "t", tags: ["a", "b"] });
    const before = snapshot(s);
    const restore = failOn(s, "fail_tag_insert", "BEFORE INSERT ON task_tags");
    expect(() => s.changeTaskTags(t.id, { add: ["c"], remove: ["a"] })).toThrow(/injected/);
    restore();
    expect(snapshot(s)).toEqual(before);
    s.close();
  });
});

describe("Store: createTask persists the created notification in the insert's transaction", () => {
  test("returns the task, its `created` row and the notification it committed", () => {
    const s = open();
    const created = s.createTask({ untitled: true, tags: ["x"], author: "agent-1", notification: { author: "kal" } });
    expect(created.task.title).toBe(`untitled-${created.task.id}`);
    expect(created.created).toMatchObject({ task_id: created.task.id, author: "agent-1", summary: "created" });
    expect(created.notification).toMatchObject({
      task_id: created.task.id,
      author: "kal",
      status: "open",
      title: `[${created.task.id}] untitled-${created.task.id}`,
      message: "created",
      read: false,
    });
    expect(s.listNotifications()).toEqual([created.notification as never]);
    expect(s.createTask({ title: "quiet" })).toMatchObject({ created: null, notification: null });
    expect(s.listNotifications().length).toBe(1);
    s.close();
  });

  test("a failing notification insert rolls back the whole create", () => {
    const s = open();
    const before = snapshot(s);
    const restore = failOn(s, "fail_created_notice", "BEFORE INSERT ON notifications");
    expect(() => s.createTask({ title: "doomed", tags: ["t"], notification: { author: null } })).toThrow(/injected/);
    restore();
    expect(snapshot(s)).toEqual(before);
    s.close();
  });

  test("addTask keeps its Task-only contract", () => {
    const s = open();
    const t = s.addTask({ title: "plain" });
    expect(t).toEqual(mustGet(s, t.id));
    expect(s.listNotifications()).toEqual([]);
    s.close();
  });
});

describe("Store: workspace snapshot and change reports", () => {
  test("workspace() returns tasks, lanes, tags and notifications as the list methods do", () => {
    const s = open();
    s.createTask({ title: "a", tags: ["x"], notification: { author: null } });
    s.addLane({ name: "later", sort: 1 });
    expect(s.workspace()).toEqual({
      tasks: s.listTasks(),
      lanes: s.listLanes(),
      tags: s.listTags(),
      notifications: s.listNotifications(),
    });
    s.close();
  });

  test("notification acknowledgements report whether anything changed", () => {
    const s = open();
    const n1 = s.addNotification({ status: "open", title: "a", message: "m" });
    const n2 = s.addNotification({ status: "open", title: "b", message: "m" });
    expect(s.markNotificationRead(n1.id)).toBe(true);
    expect(s.markNotificationRead(n1.id)).toBe(false);
    expect(s.markNotificationUnread(n1.id)).toBe(true);
    expect(s.markNotificationUnread(n1.id)).toBe(false);
    expect(s.markAllNotificationsRead()).toBe(2);
    expect(s.markAllNotificationsRead()).toBe(0);
    expect(s.dismissNotification(n2.id)).toBe(true);
    expect(s.dismissNotification(n2.id)).toBe(false);
    expect(s.clearNotifications()).toBe(1);
    expect(s.clearNotifications()).toBe(0);
    s.close();
  });

  test("removeTask reports the notifications its cascade removed", () => {
    const s = open();
    const noisy = s.createTask({ title: "noisy", notification: { author: null } }).task;
    s.transitionStatus(noisy.id, "blocked", { author: "agent-1", notify: true });
    const quiet = s.addTask({ title: "quiet" });
    expect(s.removeTask(noisy.id)).toEqual({ notifications: 2 });
    expect(s.removeTask(quiet.id)).toEqual({ notifications: 0 });
    s.close();
  });
});
