import { test, expect, describe } from "bun:test";
import { Store, BodySearchError, validateTagName, TAG_NAME_RE } from "../../src/store.ts";

const open = () => Store.open(":memory:");

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

  test("listTasks orders by priority ASC (0 = highest, sorts first)", () => {
    const s = open();
    s.addTask({ title: "normal", priority: 1 });
    s.addTask({ title: "top", priority: 0 });
    s.addTask({ title: "low", priority: 5 });
    const order = s.listTasks().map(t => t.title);
    expect(order).toEqual(["top", "normal", "low"]);
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
  // transfer). 1024 lets agents write a useful one-paragraph status.
  test("addUpdate accepts 1024-char summary, throws on 1025", () => {
    const s = open();
    const t = s.addTask({ title: "x" });
    expect(() => s.addUpdate({ task_id: t.id, author: "me", summary: "x".repeat(1024) })).not.toThrow();
    expect(() => s.addUpdate({ task_id: t.id, author: "me", summary: "x".repeat(1025) })).toThrow("summary too long");
    s.close();
  });
});

describe("Store: migrate", () => {
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
    for (const ext of ["", "-wal", "-shm"]) {
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

// ---------- listUpdates / listAuthorsLast24h: read-side gap-closers ----------
//
// Both queries are exercised end-to-end by integration tests, but the SHAPE
// (column projection + ordering direction) is fast to pin in-process via
// Store.open(":memory:"). 24h cutoff is timing-dependent and integration-only.
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

describe("Store: listAuthorsLast24h", () => {
  test("returns one row per distinct author with MAX(created) and COUNT(*) shape", async () => {
    const s = open();
    const t = s.addTask({ title: "x" });
    s.addUpdate({ task_id: t.id, author: "alice", summary: "a1" });
    await Bun.sleep(2);
    s.addUpdate({ task_id: t.id, author: "bob", summary: "b1" });
    await Bun.sleep(2);
    s.addUpdate({ task_id: t.id, author: "alice", summary: "a2" });
    const rows = s.listAuthorsLast24h();
    expect(rows.length).toBe(2);
    const alice = rows.find(r => r.author === "alice");
    const bob = rows.find(r => r.author === "bob");
    expect(alice?.posts).toBe(2);
    expect(bob?.posts).toBe(1);
    expect(alice?.last_seen).toBeGreaterThan(bob?.last_seen ?? 0);
    s.close();
  });

  test("orders by last_seen DESC (most recent author first)", async () => {
    const s = open();
    const t = s.addTask({ title: "x" });
    s.addUpdate({ task_id: t.id, author: "first-poster", summary: "x" });
    await Bun.sleep(2);
    s.addUpdate({ task_id: t.id, author: "second-poster", summary: "y" });
    await Bun.sleep(2);
    s.addUpdate({ task_id: t.id, author: "third-poster", summary: "z" });
    const rows = s.listAuthorsLast24h();
    // ORDER BY last_seen DESC: third → second → first
    expect(rows.map(r => r.author)).toEqual(["third-poster", "second-poster", "first-poster"]);
    s.close();
  });

  test("returns [] when no updates exist", () => {
    const s = open();
    expect(s.listAuthorsLast24h()).toEqual([]);
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
