import { test, expect, describe, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../../src/server.ts";
import { Store, type Notification } from "../../src/store.ts";

let store: Store;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  // Store.open(":memory:") already runs migrate() — no .init() exists/needed.
  store = Store.open(":memory:");
  app = buildApp(store);
});

const req = (method: string, path: string, body?: unknown): Request => {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
};

const fetchJson = async (request: Request): Promise<{ status: number; json: unknown }> => {
  const res = await app.fetch(request);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

describe("server: health/me", () => {
  test("POST /api/backup writes a zip for a file-backed store", async () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-server-backup-"));
    process.env.XDG_CONFIG_HOME = tmpDir;
    const fileStore = Store.open(path.join(tmpDir, "cortex.db"), { warnMigrations: false });
    try {
      fileStore.addTask({ title: "backup me" });
      const fileApp = buildApp(fileStore);
      const { status, json } = await (async () => {
        const res = await fileApp.fetch(req("POST", "/api/backup", {}));
        const text = await res.text();
        return { status: res.status, json: text ? JSON.parse(text) : null };
      })();
      const payload = json as {
        outPath: string;
        bytes: number;
        stats: { tasks: number };
        notification: { title: string; message: string; task_id: number | null; status: string };
      };
      expect(status).toBe(200);
      expect(payload.stats.tasks).toBe(1);
      expect(payload.bytes).toBeGreaterThan(0);
      expect(payload.outPath.startsWith(path.join(tmpDir, "cortex", "backups"))).toBe(true);
      expect(fs.existsSync(payload.outPath)).toBe(true);
      expect(payload.notification.title).toBe("Backup created");
      expect(payload.notification.task_id).toBeNull();
      expect(payload.notification.status).toBe("done");
      expect(payload.notification.message).toContain("1 tasks, 0 updates");
      expect(fileStore.listNotifications()[0]?.title).toBe("Backup created");
    } finally {
      fileStore.close();
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("GET /api/health returns ok + version", async () => {
    const { status, json } = await fetchJson(req("GET", "/api/health"));
    expect(status).toBe(200);
    expect((json as { ok: boolean }).ok).toBe(true);
    expect(typeof (json as { version: string }).version).toBe("string");
  });

  test("GET /api/me returns a resolved author string", async () => {
    const { status, json } = await fetchJson(req("GET", "/api/me"));
    expect(status).toBe(200);
    expect(typeof (json as { author: string }).author).toBe("string");
    expect((json as { author: string }).author.length).toBeGreaterThan(0);
  });
});

describe("server: tasks", () => {
  test("GET /api/tasks returns an array (empty initially)", async () => {
    const { status, json } = await fetchJson(req("GET", "/api/tasks"));
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect((json as unknown[]).length).toBe(0);
  });

  test("GET /api/tasks honors lane and status filters", async () => {
    store.addTask({ title: "a", lane: "now" });
    store.addLane({ name: "later" });
    store.addTask({ title: "b", lane: "later" });
    const { json } = await fetchJson(req("GET", "/api/tasks?lane=later"));
    expect((json as { title: string }[]).map(t => t.title)).toEqual(["b"]);
  });

  test("GET /api/tasks search matches task titles and bodies", async () => {
    store.addTask({ title: "alpha title match", body: "unrelated body", status: "open" });
    store.addTask({ title: "body only match", body: "notes mention alpha here", status: "done" });
    store.addTask({ title: "no match", body: "nothing relevant" });

    const { json } = await fetchJson(req("GET", "/api/tasks?search=alpha"));
    expect((json as { title: string }[]).map(t => t.title)).toEqual(["alpha title match", "body only match"]);

    const filtered = await fetchJson(req("GET", "/api/tasks?search=alpha&status=open"));
    expect((filtered.json as { title: string }[]).map(t => t.title)).toEqual(["alpha title match"]);
  });

  test("GET /api/tasks @search restricts matches to titles", async () => {
    store.addTask({ title: "alpha title match", body: "unrelated body" });
    store.addTask({ title: "body only match", body: "notes mention alpha here" });

    const { json } = await fetchJson(req("GET", "/api/tasks?search=@alpha"));
    expect((json as { title: string }[]).map(t => t.title)).toEqual(["alpha title match"]);
  });

  test("GET /api/tasks #search matches tag names", async () => {
    const tagged = store.addTask({ title: "tagged task" });
    const alsoTagged = store.addTask({ title: "also tagged" });
    const untagged = store.addTask({ title: "untagged" });
    store.setTaskTags(tagged.id, ["bug"]);
    store.setTaskTags(alsoTagged.id, ["debugging"]);
    store.setTaskTags(untagged.id, ["feature"]);

    const { json } = await fetchJson(req("GET", "/api/tasks?search=%23bug"));
    expect((json as { title: string }[]).map(t => t.title)).toEqual(["tagged task", "also tagged"]);
  });

  test("POST /api/tasks creates a task", async () => {
    const { status, json } = await fetchJson(req("POST", "/api/tasks", { title: "hello" }));
    expect(status).toBe(201);
    expect((json as { id: number; title: string }).title).toBe("hello");
    expect((json as { id: number }).id).toBeGreaterThan(0);
  });

  test("POST /api/tasks 400 when title missing", async () => {
    const { status, json } = await fetchJson(req("POST", "/api/tasks", {}));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/title/);
  });

  test("POST /api/tasks 400 when tag name invalid", async () => {
    const { status, json } = await fetchJson(req("POST", "/api/tasks", { title: "t", tags: ["BAD!"] }));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/invalid tag name/);
  });

  test("GET /api/tasks/:id returns the task", async () => {
    const t = store.addTask({ title: "x" });
    const { status, json } = await fetchJson(req("GET", `/api/tasks/${t.id}`));
    expect(status).toBe(200);
    expect((json as { id: number }).id).toBe(t.id);
  });

  test("GET /api/tasks/:id 404 on missing", async () => {
    const { status } = await fetchJson(req("GET", "/api/tasks/9999"));
    expect(status).toBe(404);
  });

  test("PATCH /api/tasks/:id edits title", async () => {
    const t = store.addTask({ title: "old" });
    const { status, json } = await fetchJson(req("PATCH", `/api/tasks/${t.id}`, { title: "new" }));
    expect(status).toBe(200);
    expect((json as { title: string }).title).toBe("new");
  });

  test("PATCH /api/tasks/:id 400 when bodySearch + body both provided (mutex)", async () => {
    const t = store.addTask({ title: "x", body: "alpha" });
    const { status, json } = await fetchJson(
      req("PATCH", `/api/tasks/${t.id}`, { body: "z", bodySearch: "alpha", bodyReplace: "beta" }),
    );
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/cannot be combined/);
  });

  test("PATCH /api/tasks/:id 400 when bodySearch alone (no bodyReplace)", async () => {
    const t = store.addTask({ title: "x", body: "alpha" });
    const { status, json } = await fetchJson(req("PATCH", `/api/tasks/${t.id}`, { bodySearch: "alpha" }));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/must be provided together/);
  });

  test("PATCH /api/tasks/:id 400 when bodySearch is empty", async () => {
    const t = store.addTask({ title: "x", body: "alpha" });
    const { status, json } = await fetchJson(
      req("PATCH", `/api/tasks/${t.id}`, { bodySearch: "", bodyReplace: "beta" }),
    );
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/empty/);
  });

  test("PATCH /api/tasks/:id 409 when bodySearch anchor not found", async () => {
    const t = store.addTask({ title: "x", body: "alpha" });
    const { status, json } = await fetchJson(
      req("PATCH", `/api/tasks/${t.id}`, { bodySearch: "missing", bodyReplace: "beta" }),
    );
    expect(status).toBe(409);
    expect((json as { code: string }).code).toBe("body_search_not_found");
  });

  test("PATCH /api/tasks/:id 404 on missing task", async () => {
    const { status } = await fetchJson(req("PATCH", "/api/tasks/9999", { title: "z" }));
    expect(status).toBe(404);
  });

  test("PATCH /api/tasks/:id/status updates status", async () => {
    const t = store.addTask({ title: "x" });
    const { status, json } = await fetchJson(req("PATCH", `/api/tasks/${t.id}/status`, { status: "done" }));
    expect(status).toBe(200);
    expect((json as { status: string }).status).toBe("done");
  });

  test("PATCH /api/tasks/:id/status 400 on invalid status", async () => {
    const t = store.addTask({ title: "x" });
    const { status, json } = await fetchJson(req("PATCH", `/api/tasks/${t.id}/status`, { status: "nope" }));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/invalid status/);
  });

  test("PATCH /api/tasks/:id/status 400 on invalid author tag", async () => {
    const t = store.addTask({ title: "x" });
    const { status, json } = await fetchJson(
      req("PATCH", `/api/tasks/${t.id}/status`, { status: "done", author: "bad\nname" }),
    );
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/newlines/);
  });

  test("PATCH /api/tasks/:id/lane moves a task", async () => {
    store.addLane({ name: "later" });
    const t = store.addTask({ title: "x" });
    const { status, json } = await fetchJson(req("PATCH", `/api/tasks/${t.id}/lane`, { lane: "later" }));
    expect(status).toBe(200);
    expect((json as { lane: string }).lane).toBe("later");
  });

  test("PATCH /api/tasks/:id/lane 400 when lane missing", async () => {
    const t = store.addTask({ title: "x" });
    const { status } = await fetchJson(req("PATCH", `/api/tasks/${t.id}/lane`, {}));
    expect(status).toBe(400);
  });

  test("PATCH /api/tasks/:id/tags set replaces tags", async () => {
    const t = store.addTask({ title: "x" });
    const { status, json } = await fetchJson(req("PATCH", `/api/tasks/${t.id}/tags`, { set: ["alpha", "beta"] }));
    expect(status).toBe(200);
    expect((json as { tags: string[] }).tags).toEqual(["alpha", "beta"]);
  });

  test("PATCH /api/tasks/:id/tags add appends, remove drops", async () => {
    const t = store.addTask({ title: "x" });
    await fetchJson(req("PATCH", `/api/tasks/${t.id}/tags`, { set: ["alpha"] }));
    const added = await fetchJson(req("PATCH", `/api/tasks/${t.id}/tags`, { add: ["beta"] }));
    expect((added.json as { tags: string[] }).tags).toEqual(["alpha", "beta"]);
    const removed = await fetchJson(req("PATCH", `/api/tasks/${t.id}/tags`, { remove: ["alpha"] }));
    expect((removed.json as { tags: string[] }).tags).toEqual(["beta"]);
  });

  test("PATCH /api/tasks/:id/tags 400 when zero modes provided", async () => {
    const t = store.addTask({ title: "x" });
    const { status } = await fetchJson(req("PATCH", `/api/tasks/${t.id}/tags`, {}));
    expect(status).toBe(400);
  });

  test("PATCH /api/tasks/:id/tags 400 when more than one mode provided", async () => {
    const t = store.addTask({ title: "x" });
    const { status } = await fetchJson(req("PATCH", `/api/tasks/${t.id}/tags`, { set: ["a"], add: ["b"] }));
    expect(status).toBe(400);
  });

  test("PATCH /api/tasks/:id/tags 404 when add targets missing task", async () => {
    const { status } = await fetchJson(req("PATCH", "/api/tasks/9999/tags", { add: ["alpha"] }));
    expect(status).toBe(404);
  });

  test("DELETE /api/tasks/:id removes the task", async () => {
    const t = store.addTask({ title: "x" });
    const { status, json } = await fetchJson(req("DELETE", `/api/tasks/${t.id}`));
    expect(status).toBe(200);
    expect((json as { ok: boolean }).ok).toBe(true);
  });

  test("DELETE /api/tasks/:id 404 on missing", async () => {
    const { status } = await fetchJson(req("DELETE", "/api/tasks/9999"));
    expect(status).toBe(404);
  });
});

describe("server: updates", () => {
  test("GET /api/tasks/:id/updates returns an array", async () => {
    const t = store.addTask({ title: "x" });
    const { status, json } = await fetchJson(req("GET", `/api/tasks/${t.id}/updates`));
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
  });

  test("POST /api/tasks/:id/updates creates an update", async () => {
    const t = store.addTask({ title: "x" });
    const { status, json } = await fetchJson(
      req("POST", `/api/tasks/${t.id}/updates`, { author: "kal", summary: "hi" }),
    );
    expect(status).toBe(201);
    expect((json as { author: string; summary: string }).summary).toBe("hi");
  });

  test("POST /api/tasks/:id/updates 400 when author or summary missing", async () => {
    const t = store.addTask({ title: "x" });
    const { status, json } = await fetchJson(req("POST", `/api/tasks/${t.id}/updates`, { author: "kal" }));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/author and summary/);
  });

  test("POST /api/tasks/:id/updates 400 when author tag invalid", async () => {
    const t = store.addTask({ title: "x" });
    const { status, json } = await fetchJson(
      req("POST", `/api/tasks/${t.id}/updates`, { author: "bad\nname", summary: "hi" }),
    );
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/newlines/);
  });
});

describe("server: authors", () => {
  test("GET /api/authors returns an array", async () => {
    const { status, json } = await fetchJson(req("GET", "/api/authors"));
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
  });
});

describe("server: lanes", () => {
  test("GET /api/lanes returns an array containing 'now'", async () => {
    const { status, json } = await fetchJson(req("GET", "/api/lanes"));
    expect(status).toBe(200);
    expect((json as { name: string }[]).some(l => l.name === "now")).toBe(true);
  });

  test("POST /api/lanes creates a lane", async () => {
    const { status, json } = await fetchJson(req("POST", "/api/lanes", { name: "later" }));
    expect(status).toBe(201);
    expect((json as { name: string }).name).toBe("later");
  });

  test("POST /api/lanes 400 when name missing", async () => {
    const { status } = await fetchJson(req("POST", "/api/lanes", {}));
    expect(status).toBe(400);
  });

  test("PATCH /api/lanes/:name 404 when lane missing", async () => {
    const { status } = await fetchJson(req("PATCH", "/api/lanes/nope", { color: "#fff" }));
    expect(status).toBe(404);
  });

  test("DELETE /api/lanes/now is rejected with 400", async () => {
    const { status, json } = await fetchJson(req("DELETE", "/api/lanes/now"));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/cannot remove the 'now' lane/);
  });

  test("DELETE /api/lanes/:name 400 when lane is non-empty", async () => {
    store.addLane({ name: "later" });
    store.addTask({ title: "x", lane: "later" });
    const { status, json } = await fetchJson(req("DELETE", "/api/lanes/later"));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/reference it/);
  });
});

describe("server: tags", () => {
  test("GET /api/tags returns an array", async () => {
    const { status, json } = await fetchJson(req("GET", "/api/tags"));
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
  });

  test("POST /api/tags creates a tag", async () => {
    const { status, json } = await fetchJson(req("POST", "/api/tags", { name: "alpha" }));
    expect(status).toBe(201);
    expect((json as { name: string }).name).toBe("alpha");
  });

  test("POST /api/tags 400 when name missing", async () => {
    const { status } = await fetchJson(req("POST", "/api/tags", {}));
    expect(status).toBe(400);
  });

  test("POST /api/tags 400 when name fails validateTagName", async () => {
    const { status, json } = await fetchJson(req("POST", "/api/tags", { name: "BAD!" }));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/invalid tag name/);
  });

  test("PATCH /api/tags/:name 404 on missing tag", async () => {
    const { status } = await fetchJson(req("PATCH", "/api/tags/nope", { color: "#fff" }));
    expect(status).toBe(404);
  });

  test("DELETE /api/tags/:name?force=1 forces removal even when used", async () => {
    store.addTag({ name: "alpha" });
    const t = store.addTask({ title: "x" });
    store.setTaskTags(t.id, ["alpha"]);
    const blocked = await fetchJson(req("DELETE", "/api/tags/alpha"));
    expect(blocked.status).toBe(400);
    const forced = await fetchJson(req("DELETE", "/api/tags/alpha?force=1"));
    expect(forced.status).toBe(200);
    expect((forced.json as { ok: boolean }).ok).toBe(true);
  });
});

describe("server: events (SSE)", () => {
  test("GET /events returns text/event-stream with status 200", async () => {
    // happy-dom (preloaded by bunfig.toml) shadows globalThis.TransformStream
    // and WritableStream with Node's Transform/Writable, which lack the
    // getWriter() that Hono's streamSSE helper calls. Restore the native
    // Web Streams classes from node:stream/web for this test only, then
    // put happy-dom's versions back so the rest of the suite is unaffected.
    const sw = await import("node:stream/web");
    const prevTS = globalThis.TransformStream;
    const prevWS = globalThis.WritableStream;
    (globalThis as { TransformStream: unknown }).TransformStream = sw.TransformStream;
    (globalThis as { WritableStream: unknown }).WritableStream = sw.WritableStream;
    try {
      const res = await app.fetch(req("GET", "/events"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")?.startsWith("text/event-stream")).toBe(true);
      // Cancel the stream so the test doesn't leak the never-closing reader.
      await res.body?.cancel();
    } finally {
      (globalThis as { TransformStream: unknown }).TransformStream = prevTS;
      (globalThis as { WritableStream: unknown }).WritableStream = prevWS;
    }
  });
});

describe("server: notifications", () => {
  test("POST /api/tasks inserts a notification with status=task.status and message='created'", async () => {
    const created = await fetchJson(req("POST", "/api/tasks", { title: "hello" }));
    expect(created.status).toBe(201);
    const task = created.json as { id: number; status: Notification["status"] };
    const { status, json } = await fetchJson(req("GET", "/api/notifications"));
    expect(status).toBe(200);
    const list = json as Notification[];
    expect(list.length).toBe(1);
    expect(list[0]?.status).toBe(task.status);
    expect(list[0]?.message).toBe("created");
    expect(list[0]?.task_id).toBe(task.id);
  });

  test("PATCH /api/tasks/:id/status open→blocked WITH author (CLI/agent) inserts a transition notification alongside the create row", async () => {
    const created = await fetchJson(req("POST", "/api/tasks", { title: "x" }));
    const taskId = (created.json as { id: number }).id;
    // Sending an explicit `author` mimics the CLI path (`cortex update --as <session>`).
    // Attributed status changes are the only ones that fire a bell-drawer
    // notification — the supervisor wants to know an agent moved a task,
    // but doesn't need to be pinged about clicks they made themselves.
    const patched = await fetchJson(
      req("PATCH", `/api/tasks/${taskId}/status`, {
        status: "blocked",
        author: "agent-deadbeef",
      }),
    );
    expect(patched.status).toBe(200);
    const { json } = await fetchJson(req("GET", "/api/notifications"));
    const list = json as Notification[];
    // Two rows: the create-notification AND the attributed open→blocked transition.
    expect(list.length).toBe(2);
    // Newest-first: transition row sits at index 0, create row at index 1.
    expect(list[0]?.status).toBe("blocked");
    expect(list[0]?.message).toContain("\u2192");
    expect(list[0]?.author).toBe("agent-deadbeef");
    expect(list[1]?.message).toBe("created");
  });

  test("PATCH /api/tasks/:id/status open→blocked WITHOUT author (dashboard click) does NOT insert a transition notification", async () => {
    // The dashboard's setStat() sends `{ status }` only — no author. That
    // signals "the supervisor clicked this themselves", so the bell-drawer
    // notification is suppressed (the row is already visibly updated
    // in-app via the task.updated SSE event). Only the original create
    // notification persists.
    const created = await fetchJson(req("POST", "/api/tasks", { title: "x" }));
    const taskId = (created.json as { id: number }).id;
    const patched = await fetchJson(req("PATCH", `/api/tasks/${taskId}/status`, { status: "blocked" }));
    expect(patched.status).toBe(200);
    const { json } = await fetchJson(req("GET", "/api/notifications"));
    const list = json as Notification[];
    expect(list.length).toBe(1);
    expect(list[0]?.message).toBe("created");
  });

  test("PATCH /api/tasks/:id/status open→open (no-op) does NOT insert a new notification row", async () => {
    const created = await fetchJson(req("POST", "/api/tasks", { title: "x" }));
    const taskId = (created.json as { id: number }).id;
    const patched = await fetchJson(
      req("PATCH", `/api/tasks/${taskId}/status`, {
        status: "open",
        author: "agent-deadbeef",
      }),
    );
    expect(patched.status).toBe(200);
    const { json } = await fetchJson(req("GET", "/api/notifications"));
    const list = json as Notification[];
    expect(list.length).toBe(1);
    expect(list[0]?.message).toBe("created");
  });

  test("GET /api/notifications returns rows newest-first", async () => {
    const first = await fetchJson(req("POST", "/api/tasks", { title: "first" }));
    const second = await fetchJson(req("POST", "/api/tasks", { title: "second" }));
    const firstId = (first.json as { id: number }).id;
    const secondId = (second.json as { id: number }).id;
    const { json } = await fetchJson(req("GET", "/api/notifications"));
    const list = json as Notification[];
    expect(list.length).toBe(2);
    // Second-created task's notification sits at index 0 (newest first).
    expect(list[0]?.task_id).toBe(secondId);
    expect(list[1]?.task_id).toBe(firstId);
  });

  test("PATCH /api/notifications/:id/read flips the row's read flag to true", async () => {
    await fetchJson(req("POST", "/api/tasks", { title: "x" }));
    const before = (await fetchJson(req("GET", "/api/notifications"))).json as Notification[];
    expect(before[0]?.read).toBe(false);
    const notifId = before[0]?.id as number;
    const r = await fetchJson(req("PATCH", `/api/notifications/${notifId}/read`));
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    const after = (await fetchJson(req("GET", "/api/notifications"))).json as Notification[];
    expect(after[0]?.read).toBe(true);
  });

  test("PATCH /api/notifications/:id/read 400 on non-numeric id", async () => {
    const { status, json } = await fetchJson(req("PATCH", "/api/notifications/abc/read"));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/invalid id/);
  });

  test("PATCH /api/notifications/:id/unread flips a read row back to unread", async () => {
    await fetchJson(req("POST", "/api/tasks", { title: "x" }));
    const list = (await fetchJson(req("GET", "/api/notifications"))).json as Notification[];
    const id = list[0]?.id as number;
    await fetchJson(req("PATCH", `/api/notifications/${id}/read`));
    const r = await fetchJson(req("PATCH", `/api/notifications/${id}/unread`));
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    const after = (await fetchJson(req("GET", "/api/notifications"))).json as Notification[];
    expect(after[0]?.read).toBe(false);
  });

  test("PATCH /api/notifications/:id/unread 400 on non-numeric id", async () => {
    const { status, json } = await fetchJson(req("PATCH", "/api/notifications/abc/unread"));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/invalid id/);
  });

  test("POST /api/notifications/read-all flips every unread row", async () => {
    await fetchJson(req("POST", "/api/tasks", { title: "a" }));
    await fetchJson(req("POST", "/api/tasks", { title: "b" }));
    const before = (await fetchJson(req("GET", "/api/notifications"))).json as Notification[];
    expect(before.length).toBe(2);
    expect(before.every(n => n.read === false)).toBe(true);
    const r = await fetchJson(req("POST", "/api/notifications/read-all"));
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    const after = (await fetchJson(req("GET", "/api/notifications"))).json as Notification[];
    expect(after.length).toBe(2);
    expect(after.every(n => n.read === true)).toBe(true);
  });

  test("DELETE /api/notifications/:id removes that row; the rest remain", async () => {
    await fetchJson(req("POST", "/api/tasks", { title: "a" }));
    await fetchJson(req("POST", "/api/tasks", { title: "b" }));
    const before = (await fetchJson(req("GET", "/api/notifications"))).json as Notification[];
    expect(before.length).toBe(2);
    const dropId = before[0]?.id as number;
    const survivorId = before[1]?.id as number;
    const r = await fetchJson(req("DELETE", `/api/notifications/${dropId}`));
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    const after = (await fetchJson(req("GET", "/api/notifications"))).json as Notification[];
    expect(after.length).toBe(1);
    expect(after[0]?.id).toBe(survivorId);
  });

  test("DELETE /api/notifications/:id 400 on non-numeric id", async () => {
    const { status, json } = await fetchJson(req("DELETE", "/api/notifications/abc"));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/invalid id/);
  });

  test("DELETE /api/notifications empties the list", async () => {
    await fetchJson(req("POST", "/api/tasks", { title: "a" }));
    await fetchJson(req("POST", "/api/tasks", { title: "b" }));
    const r = await fetchJson(req("DELETE", "/api/notifications"));
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    const { json } = await fetchJson(req("GET", "/api/notifications"));
    expect((json as Notification[]).length).toBe(0);
  });
});
