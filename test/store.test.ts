import { test, expect, describe } from "bun:test";
import { Store, BodySearchError } from "../src/store.ts";

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
    const order = s.listTasks().map((t) => t.title);
    expect(order).toEqual(["top", "normal", "low"]);
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
      bodySearch:  "TODO investigate",
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
      bodySearch:  "## Plan\n- step 1\n- step 2",
      bodyReplace: "## Plan\n- step 1\n- step 2\n- step 3",
    });
    expect(edited.body).toBe(
      "intro\n\n## Plan\n- step 1\n- step 2\n- step 3\n\noutro",
    );
    s.close();
  });

  test("editTask bodyReplace empty string deletes the anchor", () => {
    const s = open();
    const t = s.addTask({ title: "x", body: "keep DELETE_ME also-keep" });
    const edited = s.editTask(t.id, {
      bodySearch:  " DELETE_ME",
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
    } catch (e) { caught = e; }
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
    } catch (e) { caught = e; }
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
      bodySearch:  "world",
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
        bodySearch:  "hi",
        bodyReplace: "yo",
      }),
    ).toThrow(/cannot be combined with body/);
    s.close();
  });

  test("editTask rejects empty bodySearch (would match everywhere)", () => {
    const s = open();
    const t = s.addTask({ title: "x", body: "hi" });
    expect(() =>
      s.editTask(t.id, { bodySearch: "", bodyReplace: "y" }),
    ).toThrow(/bodySearch cannot be empty/);
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
    const lane = s.listLanes().find((l) => l.name === "new-lane");
    expect(lane?.color).toBeNull();
    expect(lane?.sort).toBe(0);
    s.close();
  });

  test("addTask auto-creates missing lane", () => {
    const s = open();
    const t = s.addTask({ title: "x", lane: "fresh" });
    expect(t.lane).toBe("fresh");
    expect(s.listLanes().some((l) => l.name === "fresh")).toBe(true);
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
    expect(() =>
      s.addUpdate({ task_id: t.id, author: "me", summary: "x".repeat(1024) }),
    ).not.toThrow();
    expect(() =>
      s.addUpdate({ task_id: t.id, author: "me", summary: "x".repeat(1025) }),
    ).toThrow("summary too long");
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
      try { require("node:fs").rmSync(tmp + ext, { force: true }); } catch {}
    }
  });
});

describe("Store: tags", () => {
  test("addTag/listTags/editTag/removeTag round-trip; rename cascades to task_tags", () => {
    const s = open();
    s.addTag({ name: "foo", color: "#abc" });
    let listed = s.listTags();
    expect(listed.find((t) => t.name === "foo")?.color).toBe("#abc");
    expect(listed.find((t) => t.name === "foo")?.task_count).toBe(0);
    // attach to a task to validate task_count + cascade-on-rename
    const task = s.addTask({ title: "x" });
    s.setTaskTags(task.id, ["foo"]);
    listed = s.listTags();
    expect(listed.find((t) => t.name === "foo")?.task_count).toBe(1);
    s.editTag("foo", { rename: "foobar" });
    expect(s.getTask(task.id)?.tags).toEqual(["foobar"]);
    expect(s.listTags().some((t) => t.name === "foo")).toBe(false);
    s.removeTag("foobar", { force: true });
    expect(s.listTags().some((t) => t.name === "foobar")).toBe(false);
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
    expect(s.listTags().map((x) => x.name).sort()).toEqual(["a", "b", "c"]);
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
    const both = s.listTasks({ tags: ["a", "b"] }).map((t) => t.title);
    expect(both).toEqual(["tab"]);
    const onlyA = s.listTasks({ tags: ["a"] }).map((t) => t.title).sort();
    expect(onlyA).toEqual(["ta", "tab"]);
    s.close();
  });

  test("removeTask cascades task_tags rows", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    s.setTaskTags(t.id, ["a", "b"]);
    expect(s.listTags().find((x) => x.name === "a")?.task_count).toBe(1);
    s.removeTask(t.id);
    // tag rows survive removeTask; only join rows are dropped
    expect(s.listTags().find((x) => x.name === "a")?.task_count).toBe(0);
    expect(s.listTags().find((x) => x.name === "b")?.task_count).toBe(0);
    s.close();
  });

  test("removeTag refuses while a task uses it; force succeeds and drops join rows", () => {
    const s = open();
    const t = s.addTask({ title: "t" });
    s.setTaskTags(t.id, ["keep"]);
    expect(() => s.removeTag("keep")).toThrow(/task\(s\) reference it/);
    s.removeTag("keep", { force: true });
    expect(s.listTags().some((x) => x.name === "keep")).toBe(false);
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
    expect(s.listLanes().map((l) => l.name)).toEqual(["now"]);
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
    expect(s.listLanes().some((l) => l.name === "soon")).toBe(true);
    expect(s.getTask(t.id)?.lane).toBe("soon");
    s.close();
  });
});
