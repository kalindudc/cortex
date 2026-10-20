import { test, expect, describe, beforeEach, afterEach, setSystemTime, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildApp,
  createRuntime,
  DEFAULT_STREAM_LIMITS,
  type DaemonControl,
  type DaemonRuntime,
} from "../../src/server.ts";
import { CONTROL_PATHS, INSTANCE_HEADER } from "../../src/api.ts";
import { Store, type Notification, type Task, type Update } from "../../src/store.ts";
import { parseCursor, type PublishedEvent } from "../../src/events.ts";
import { createSseParser, type SseFrame } from "../../src/subscription.ts";
import type {
  DaemonIdentity,
  LaneStateSnapshot,
  PostUpdateResult,
  TagStateSnapshot,
  TaskWriteResult,
  Versions,
  WorkspaceSnapshot,
} from "../../src/contracts.ts";

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

  // `cortex add -s <status>` reaches this handler with or without a daemon
  // (plan @400 N6), so a bad status is a clean 400, never a 500 plus a stack.
  test("POST /api/tasks 400 when status is invalid, and nothing is created", async () => {
    const { status, json } = await fetchJson(req("POST", "/api/tasks", { title: "t", status: "bogus" }));
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("invalid status");
    expect(store.listTasks()).toEqual([]);
  });

  // `cortex ls -t a,b` goes through GET /api/tasks (plan @400 N6): the same
  // AND tag filter as Store.listTasks, validated names, combinable with the rest.
  test("GET /api/tasks?tags=a,b returns tasks carrying every listed tag", async () => {
    const both = store.addTask({ title: "both", tags: ["a", "b"] });
    store.addTask({ title: "only a", tags: ["a"] });
    store.addTask({ title: "none" });
    const { status, json } = await fetchJson(req("GET", "/api/tasks?tags=a%2Cb"));
    expect(status).toBe(200);
    expect((json as Task[]).map(t => t.id)).toEqual([both.id]);
    const one = await fetchJson(req("GET", "/api/tasks?tags=a&search=only"));
    expect((one.json as Task[]).map(t => t.title)).toEqual(["only a"]);
  });

  test("GET /api/tasks?tags= rejects an invalid tag name with 400", async () => {
    const { status, json } = await fetchJson(req("GET", "/api/tasks?tags=BAD!"));
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

describe("server: memory", () => {
  test("GET /api/memory/search validates q, limit and exclude", async () => {
    expect((await fetchJson(req("GET", "/api/memory/search"))).status).toBe(400);
    expect((await fetchJson(req("GET", "/api/memory/search?q=mouse&limit=x"))).status).toBe(400);
    expect((await fetchJson(req("GET", "/api/memory/search?q=mouse&exclude=a"))).status).toBe(400);
    const punctuation = await fetchJson(req("GET", "/api/memory/search?q=%3F%3F"));
    expect(punctuation).toEqual({ status: 200, json: { terms: [], recent: false, hits: [] } });
    // Only recency words: flagged, but no terms to search.
    const recencyOnly = await fetchJson(req("GET", "/api/memory/search?q=latest%20today"));
    expect(recencyOnly).toEqual({ status: 200, json: { terms: [], recent: true, hits: [] } });
  });

  test("GET /api/memory/search returns bodiless hits with the exact key set", async () => {
    const t = store.addTask({ title: "Mouse wheel handler", lane: "cortex", body: "secret body" });
    const { status, json } = await fetchJson(req("GET", "/api/memory/search?q=mouse%20wheel&lane=cortex"));
    expect(status).toBe(200);
    const result = json as { terms: string[]; hits: Record<string, unknown>[] };
    expect(result.terms).toEqual(["mouse", "wheel"]);
    expect(result.hits.map(hit => hit.id)).toEqual([t.id]);
    expect(Object.keys(result.hits[0] ?? {}).sort()).toEqual(
      [
        "id",
        "title",
        "lane",
        "status",
        "tags",
        "updated",
        "synced",
        "activity",
        "score",
        "matched",
        "snippet",
        "latest",
        "memory_excluded",
      ].sort(),
    );
  });

  test("GET /api/memory/search spans lanes, boosts one, strips recency words and ranks a phrase first", async () => {
    const theirs = store.addTask({ title: "notes", lane: "infra", body: "the routing-events handover" });
    const mine = store.addTask({ title: "events of routing", lane: "cortex", body: "routing and events" });
    const all = await fetchJson(req("GET", "/api/memory/search?q=routing-events"));
    // The phrase outranks the boosted lane's stronger title match.
    const boosted = await fetchJson(req("GET", "/api/memory/search?q=routing-events&boost=cortex"));
    for (const { json } of [all, boosted]) {
      expect((json as { hits: { id: number }[] }).hits.map(hit => hit.id)).toEqual([theirs.id, mine.id]);
    }
    const filtered = await fetchJson(req("GET", "/api/memory/search?q=routing%20events&lane=cortex"));
    expect((filtered.json as { hits: { id: number }[] }).hits.map(hit => hit.id)).toEqual([mine.id]);
    const recent = await fetchJson(
      req("GET", "/api/memory/search?q=what%20was%20I%20last%20doing%20on%20routing%20events"),
    );
    expect(recent.json).toMatchObject({ terms: ["routing", "events"], recent: true });
  });

  test("GET /api/memory/streams filters by active and author and validates the author tag", async () => {
    const open = store.addTask({ title: "open", lane: "l" });
    const done = store.addTask({ title: "done", lane: "l" });
    store.setStatus(done.id, "done", { author: "pi-x" });
    const active = await fetchJson(req("GET", "/api/memory/streams?lane=l&active=1"));
    expect((active.json as { id: number }[]).map(row => row.id)).toEqual([open.id]);
    const authored = await fetchJson(req("GET", "/api/memory/streams?author=pi-x"));
    expect((authored.json as { id: number }[]).map(row => row.id)).toEqual([done.id]);
    const other = store.addTask({ title: "elsewhere", lane: "infra" });
    const elsewhere = await fetchJson(req("GET", "/api/memory/streams?excludeLane=l"));
    expect((elsewhere.json as { id: number }[]).map(row => row.id)).toEqual([other.id]);
    expect((await fetchJson(req("GET", "/api/memory/streams?author=a%0Ab"))).status).toBe(400);
    expect((await fetchJson(req("GET", "/api/memory/streams?limit=0"))).status).toBe(400);
  });

  test("GET /api/memory/streams/:id returns { task, updates, synced, latest } or 404", async () => {
    const t = store.addTask({ title: "stream" });
    const { status, json } = await fetchJson(req("GET", `/api/memory/streams/${t.id}`));
    expect(status).toBe(200);
    expect(Object.keys(json as object).sort()).toEqual(["latest", "synced", "syncedUpdateId", "task", "updates"]);
    expect((await fetchJson(req("GET", "/api/memory/streams/999"))).status).toBe(404);
  });
});

describe("server: memory exclusion", () => {
  test("PATCH /api/tasks/:id/memory validates, 404s, answers legacy or versioned, and publishes once", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    const seen = recordEvents(runtime);
    const t = store.addTask({ title: "private" });
    expect((await call(a, "PATCH", `/api/tasks/${t.id}/memory`, { excluded: "yes" })).status).toBe(400);
    expect((await call(a, "PATCH", "/api/tasks/999/memory", { excluded: true })).status).toBe(404);
    const legacy = await call(a, "PATCH", `/api/tasks/${t.id}/memory`, { excluded: true });
    expect(legacy.status).toBe(200);
    expect(legacy.text).toBe(JSON.stringify(store.getTask(t.id)));
    expect((legacy.json as Task).memory_excluded).toBe(true);
    const versioned = await call(a, "PATCH", `/api/tasks/${t.id}/memory`, { excluded: false }, VERSIONED);
    const dto = versioned.json as TaskWriteResult;
    expect(dto.task.memory_excluded).toBe(false);
    expect(dto.versions).toEqual(stateOf(store, t.id).versions);
    expect(dto.replayed).toBe(false);
    const updates = seen.filter(ev => ev.kind === "task.updated");
    expect(updates.map(ev => (ev.payload as Task).memory_excluded)).toEqual([true, false]);
  });

  test("every memory route hides an excluded task; a load by id still works", async () => {
    const at = (ms: number): void => {
      setSystemTime(new Date(ms));
    };
    at(1_000);
    const visible = store.addTask({ title: "gizmo visible", lane: "cortex" });
    at(2_000);
    const hidden = store.addTask({ title: "gizmo hidden", lane: "cortex", body: `continues @${visible.id}` });
    store.addUpdate({ task_id: visible.id, author: "pi-x", summary: "worked" });
    store.addUpdate({ task_id: hidden.id, author: "pi-x", summary: "worked" });
    setSystemTime();
    store.setMemoryExcluded(hidden.id, true);
    const rowIds = (json: unknown): number[] => (json as { id: number }[]).map(row => row.id);
    const cases: Record<string, () => Promise<void>> = {
      "/api/memory/search": async () => {
        const { json } = await fetchJson(req("GET", "/api/memory/search?q=gizmo"));
        expect(rowIds((json as { hits: unknown }).hits)).toEqual([visible.id]);
      },
      "/api/memory/streams": async () => {
        expect(rowIds((await fetchJson(req("GET", "/api/memory/streams?lane=cortex"))).json)).toEqual([visible.id]);
        expect(rowIds((await fetchJson(req("GET", "/api/memory/streams?author=pi-x"))).json)).toEqual([visible.id]);
        const all = (await fetchJson(req("GET", "/api/memory/streams?author=pi-x&withExcluded=1"))).json;
        expect(rowIds(all).sort()).toEqual([visible.id, hidden.id].sort());
      },
      "/api/memory/streams/:id": async () => {
        const shown = await fetchJson(req("GET", `/api/memory/streams/${visible.id}`));
        expect((shown.json as { latest: unknown }).latest).toBeNull();
        const loaded = await fetchJson(req("GET", `/api/memory/streams/${hidden.id}`));
        expect(loaded.status).toBe(200);
        expect((loaded.json as { task: Task }).task.memory_excluded).toBe(true);
      },
    };
    for (const check of Object.values(cases)) await check();
    // A new memory read must come with a case here, so it cannot leak an excluded task unnoticed.
    const memoryRoutes = app.routes
      .filter(route => route.method === "GET" && route.path.startsWith("/api/memory/"))
      .map(route => route.path);
    expect([...new Set(memoryRoutes)].sort()).toEqual(Object.keys(cases).sort());
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
    const res = await app.fetch(req("GET", "/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.startsWith("text/event-stream")).toBe(true);
    // Cancel the stream so the test doesn't leak the never-closing reader.
    await res.body?.cancel();
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

  test("PATCH /api/tasks/:id/status open→blocked WITHOUT author (a human change) does NOT insert a transition notification", async () => {
    // A human status change (the TUI) sends `{ status }` only — no author. That
    // signals "the supervisor changed this themselves", so the transition
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

// =====================================================================
// plan @400 Task 5: snapshots, guarded/versioned writes, live events
// =====================================================================

const VERSIONED = { prefer: "cortex-versioned" } as const;

const send = (
  a: ReturnType<typeof buildApp>,
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> => {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json", ...headers };
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(a.fetch(new Request(`http://localhost${p}`, init)));
};

const call = async (
  a: ReturnType<typeof buildApp>,
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; text: string; headers: Headers }> => {
  const res = await send(a, method, p, body, headers);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text, headers: res.headers };
};

function stateOf(s: Store, id: number): { task: Task; versions: Versions } {
  const state = s.taskState(id);
  if (!state) throw new Error(`task ${id} has no state`);
  return { task: state.task, versions: state.versions };
}

function recordEvents(runtime: DaemonRuntime): PublishedEvent[] {
  const seen: PublishedEvent[] = [];
  runtime.events.subscribe(ev => seen.push(ev));
  return seen;
}

describe("server: workspace snapshot and task state (N11)", () => {
  test("GET /api/workspace returns every list a client reads, plus the stream cursor", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    await call(a, "POST", "/api/tasks", { title: "a", tags: ["x"] });
    store.addLane({ name: "later", sort: 2 });
    const { status, json } = await call(a, "GET", "/api/workspace");
    expect(status).toBe(200);
    const snap = json as WorkspaceSnapshot;
    expect(snap.tasks).toEqual(store.listTasks());
    expect(snap.lanes).toEqual(store.listLanes());
    expect(snap.tags).toEqual(store.listTags());
    expect(snap.notifications).toEqual(store.listNotifications());
    expect(snap.cursor).toBe(runtime.events.cursor());
    expect(parseCursor(snap.cursor)).toEqual({ epoch: runtime.events.epoch, seq: 2 });
    expect(snap.identity).toBeNull();
  });

  test("the workspace identity is the runtime's published identity", async () => {
    const identity: DaemonIdentity = {
      protocol: 1,
      instanceId: "inst-1",
      databaseId: store.databaseId(),
      databasePath: ":memory:",
      endpoint: { kind: "unix", socketPath: "/tmp/x.sock" },
      pid: process.pid,
    };
    const a = buildApp(store, createRuntime({ identity }));
    expect(((await call(a, "GET", "/api/workspace")).json as WorkspaceSnapshot).identity).toEqual(identity);
  });

  test("GET /api/tasks/:id/state pairs the task, its activity and versions with the cursor; 404 when missing", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    const t = store.addTask({ title: "t", author: "agent-1" });
    const { status, json } = await call(a, "GET", `/api/tasks/${t.id}/state`);
    expect(status).toBe(200);
    expect(json).toEqual({ ...store.taskState(t.id), cursor: runtime.events.cursor() });
    expect((await call(a, "GET", "/api/tasks/9999/state")).status).toBe(404);
  });

  test("GET /api/lanes/:name/state and /api/tags/:name/state pair the definition, its member count and versions with the cursor", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    store.addLane({ name: "big ideas", color: "#2563eb", sort: 3 });
    store.addTask({ title: "t", lane: "big ideas", tags: ["x"] });
    const lane = await call(a, "GET", `/api/lanes/${encodeURIComponent("big ideas")}/state`);
    expect(lane.status).toBe(200);
    expect(lane.json).toEqual({ ...store.laneState("big ideas"), cursor: runtime.events.cursor() });
    expect((lane.json as LaneStateSnapshot).lane).toEqual({
      name: "big ideas",
      color: "#2563eb",
      sort: 3,
      task_count: 1,
    });
    const tag = await call(a, "GET", "/api/tags/x/state");
    expect(tag.status).toBe(200);
    expect(tag.json).toEqual({ ...store.tagState("x"), cursor: runtime.events.cursor() });
    expect((tag.json as TagStateSnapshot).tag.task_count).toBe(1);
    expect((await call(a, "GET", "/api/lanes/nope/state")).status).toBe(404);
    expect((await call(a, "GET", "/api/tags/nope/state")).status).toBe(404);
  });

  test("a catalog state's tokens guard its edits and deletes: a stale impact count is a 412 and nothing changes", async () => {
    const a = buildApp(store, createRuntime());
    store.addTask({ title: "t", tags: ["x"] });
    const seen = ((await call(a, "GET", "/api/tags/x/state")).json as TagStateSnapshot).versions;
    // Another writer tags one more task after the count was shown.
    store.addTask({ title: "u", tags: ["x"] });
    const del = await call(
      a,
      "DELETE",
      "/api/tags/x?force=1",
      { guard: { expected: { entity: seen.entity } } },
      VERSIONED,
    );
    expect(del.status).toBe(412);
    expect(store.tagState("x")?.tag.task_count).toBe(2);
    const fresh = ((await call(a, "GET", "/api/tags/x/state")).json as TagStateSnapshot).versions;
    const ok = await call(
      a,
      "DELETE",
      "/api/tags/x?force=1",
      { guard: { expected: { entity: fresh.entity } } },
      VERSIONED,
    );
    expect(ok.status).toBe(200);
    expect(store.tagState("x")).toBeNull();
    const lane = ((await call(a, "GET", "/api/lanes/now/state")).json as LaneStateSnapshot).versions;
    store.editLane("now", { color: "#dc2626" });
    const edit = await call(
      a,
      "PATCH",
      "/api/lanes/now",
      { sort: 9, guard: { expected: { definition: lane.definition } } },
      VERSIONED,
    );
    expect(edit.status).toBe(412);
    expect(store.laneState("now")?.lane.sort).toBe(0);
  });
});

describe("server: legacy responses stay byte-compatible without Prefer", () => {
  test("every task/lane/tag write returns the exact legacy JSON and no Preference-Applied", async () => {
    const created = await call(app, "POST", "/api/tasks", { title: "t" });
    const id = (created.json as Task).id;
    expect(created.status).toBe(201);
    expect(created.text).toBe(JSON.stringify(store.getTask(id)));
    const checks: [string, string, unknown, () => unknown][] = [
      ["PATCH", `/api/tasks/${id}`, { title: "t2", body: "b" }, () => store.getTask(id)],
      ["PATCH", `/api/tasks/${id}/status`, { status: "review" }, () => store.getTask(id)],
      ["PATCH", `/api/tasks/${id}/lane`, { lane: "later" }, () => store.getTask(id)],
      ["PATCH", `/api/tasks/${id}/tags`, { add: ["x"] }, () => store.getTask(id)],
      ["PATCH", `/api/tasks/${id}/tags`, { remove: ["x"] }, () => store.getTask(id)],
      ["PATCH", `/api/tasks/${id}/tags`, { set: ["y"] }, () => store.getTask(id)],
      ["POST", "/api/lanes", { name: "soon" }, () => store.listLanes().find(l => l.name === "soon")],
      ["PATCH", "/api/lanes/soon", { color: "#fff" }, () => store.listLanes().find(l => l.name === "soon")],
      [
        "POST",
        "/api/tags",
        { name: "z" },
        () => ({ ...store.listTags().find(g => g.name === "z"), task_count: undefined }),
      ],
      [
        "PATCH",
        "/api/tags/z",
        { color: "#000" },
        () => ({ ...store.listTags().find(g => g.name === "z"), task_count: undefined }),
      ],
    ];
    for (const [method, p, body, expected] of checks) {
      const r = await call(app, method, p, body);
      expect(r.status, `${method} ${p}`).toBeLessThan(300);
      expect(r.text, `${method} ${p}`).toBe(JSON.stringify(expected()));
      expect(r.headers.get("preference-applied"), `${method} ${p}`).toBeNull();
    }
    const posted = await call(app, "POST", `/api/tasks/${id}/updates`, { author: "kal", summary: "hi" });
    expect(posted.status).toBe(201);
    expect(posted.text).toBe(JSON.stringify(store.listUpdates(id).at(-1)));
    for (const p of [`/api/tasks/${id}`, "/api/lanes/soon", "/api/tags/z"]) {
      const r = await call(app, "DELETE", p);
      expect(r.text, p).toBe('{"ok":true}');
    }
  });
});

describe("server: versioned results and guarded writes (N8/N11)", () => {
  test("Prefer: cortex-versioned returns task + versions + replayed and says so", async () => {
    const created = await call(app, "POST", "/api/tasks", { title: "t", tags: ["x"] }, VERSIONED);
    expect(created.status).toBe(201);
    expect(created.headers.get("preference-applied")).toBe("cortex-versioned");
    const id = (created.json as TaskWriteResult).task.id;
    expect(created.json).toEqual({ ...stateOf(store, id), replayed: false });

    const edited = await call(
      app,
      "PATCH",
      `/api/tasks/${id}`,
      { title: "t2" },
      { prefer: "respond-async, cortex-versioned" },
    );
    expect(edited.json).toEqual({ ...stateOf(store, id), replayed: false });
    for (const [method, p, body] of [
      ["PATCH", `/api/tasks/${id}/status`, { status: "done" }],
      ["PATCH", `/api/tasks/${id}/lane`, { lane: "later" }],
      ["PATCH", `/api/tasks/${id}/tags`, { remove: ["x"] }],
    ] as const) {
      const r = await call(app, method, p, body, VERSIONED);
      expect(r.json, p).toEqual({ ...stateOf(store, id), replayed: false });
    }
    const post = await call(
      app,
      "POST",
      `/api/tasks/${id}/updates`,
      { author: "a", summary: "s", status: "open" },
      VERSIONED,
    );
    const rows = store.listUpdates(id);
    expect(post.status).toBe(201);
    expect(post.json).toEqual({ update: rows.at(-2), audit: rows.at(-1), ...stateOf(store, id), replayed: false });

    const lane = await call(app, "POST", "/api/lanes", { name: "soon" }, VERSIONED);
    expect(lane.json).toEqual({
      lane: { name: "soon", color: null, sort: 0 },
      versions: store.versions("lane", "soon"),
      replayed: false,
    });
    const tag = await call(app, "PATCH", "/api/tags/x", { color: "#123456" }, VERSIONED);
    expect(tag.json).toMatchObject({ tag: { name: "x", color: "#123456" }, versions: store.versions("tag", "x") });
    const removed = await call(app, "DELETE", `/api/tasks/${id}`, undefined, VERSIONED);
    expect(removed.json).toEqual({ ok: true, replayed: false });
    expect(removed.headers.get("preference-applied")).toBe("cortex-versioned");
  });

  test("a stale guard is a structured 412 and every write path leaves the data unchanged", async () => {
    const t = store.addTask({ title: "t", body: "v1", tags: ["a"] });
    const seen = stateOf(store, t.id).versions;
    store.editTask(t.id, { title: "someone else", body: "v2", priority: 3 });
    store.moveTask(t.id, "later");
    store.setStatus(t.id, "review");
    const now = stateOf(store, t.id);
    const attempts: [string, string, unknown][] = [
      ["PATCH", `/api/tasks/${t.id}`, { body: "mine", guard: { expected: { body: seen.body } } }],
      ["PATCH", `/api/tasks/${t.id}`, { title: "mine", guard: { expected: { title: seen.title } } }],
      ["PATCH", `/api/tasks/${t.id}/status`, { status: "done", guard: { expected: { status: seen.status } } }],
      ["PATCH", `/api/tasks/${t.id}/lane`, { lane: "now", guard: { expected: { lane: seen.lane } } }],
      ["PATCH", `/api/tasks/${t.id}/tags`, { set: ["b"], guard: { expected: { entity: seen.entity } } }],
      ["PATCH", `/api/tasks/${t.id}/tags`, { add: ["b"], guard: { expected: { entity: seen.entity } } }],
      [
        "POST",
        `/api/tasks/${t.id}/updates`,
        { author: "a", summary: "s", status: "done", guard: { expected: { status: seen.status } } },
      ],
      ["DELETE", `/api/tasks/${t.id}`, { guard: { expected: { entity: seen.entity } } }],
    ];
    for (const [method, p, body] of attempts) {
      const r = await call(app, method, p, body, VERSIONED);
      expect(r.status, `${method} ${p}`).toBe(412);
      expect(r.json, `${method} ${p}`).toMatchObject({
        code: "version_conflict",
        kind: "task",
        key: t.id,
        current: now.versions,
      });
      const mismatch = (r.json as { mismatches: { scope: string; expected: string; current: string }[] }).mismatches;
      expect(mismatch.length, `${method} ${p}`).toBeGreaterThan(0);
      for (const m of mismatch)
        expect(m).toEqual({
          scope: m.scope,
          expected: seen[m.scope as keyof Versions] as string,
          current: now.versions[m.scope as keyof Versions] as string,
        });
      expect(stateOf(store, t.id), `${method} ${p}`).toEqual(now);
    }
    expect(store.listUpdates(t.id).map(u => u.summary)).toEqual(["status \u2192 review"]);

    const lane = store.versions("lane", "later");
    store.editLane("later", { color: "#111" });
    const staleLane = await call(app, "PATCH", "/api/lanes/later", {
      sort: 5,
      guard: { expected: { definition: lane?.definition } },
    });
    expect(staleLane.status).toBe(412);
    expect(staleLane.json).toMatchObject({ code: "version_conflict", kind: "lane", key: "later" });
    expect(store.listLanes().find(l => l.name === "later")?.sort).toBe(0);
  });

  test("guarded writes to different fields of one task both succeed; legacy writes stay last-writer-wins", async () => {
    const t = store.addTask({ title: "t", body: "b" });
    const v = stateOf(store, t.id).versions;
    const body = await call(app, "PATCH", `/api/tasks/${t.id}`, {
      body: "mine",
      guard: { expected: { body: v.body } },
    });
    const title = await call(app, "PATCH", `/api/tasks/${t.id}`, {
      title: "yours",
      guard: { expected: { title: v.title } },
    });
    const status = await call(app, "PATCH", `/api/tasks/${t.id}/status`, {
      status: "done",
      guard: { expected: { status: v.status } },
    });
    expect([body.status, title.status, status.status]).toEqual([200, 200, 200]);
    expect(store.getTask(t.id)).toMatchObject({ title: "yours", body: "mine", status: "done" });
    const before = stateOf(store, t.id).versions;
    const legacy = await call(app, "PATCH", `/api/tasks/${t.id}`, { body: "blind overwrite" });
    expect(legacy.status).toBe(200);
    expect(stateOf(store, t.id).versions.body).not.toBe(before.body);
  });

  test("a guarded DELETE read before a concurrent post is a 412 and deletes nothing; the legacy DELETE still works", async () => {
    const t = store.addTask({ title: "doomed", body: "b" });
    const confirmed = stateOf(store, t.id).versions; // what the TUI's :delete confirmation read
    const posted = await call(app, "POST", `/api/tasks/${t.id}/updates`, { author: "agent-1", summary: "late note" });
    expect(posted.status).toBe(201);
    const now = stateOf(store, t.id);
    // N7: the post moved only `entity`; a title/body draft stays valid.
    expect([now.versions.title, now.versions.body]).toEqual([confirmed.title, confirmed.body]);
    const removed = await call(
      app,
      "DELETE",
      `/api/tasks/${t.id}`,
      { guard: { expected: { entity: confirmed.entity } } },
      VERSIONED,
    );
    expect(removed.status).toBe(412);
    expect(removed.json).toMatchObject({ code: "version_conflict", kind: "task", key: t.id, current: now.versions });
    expect(stateOf(store, t.id)).toEqual(now);
    expect(store.listUpdates(t.id).map(u => u.summary)).toEqual(["late note"]);
    const legacy = await call(app, "DELETE", `/api/tasks/${t.id}`);
    expect(legacy.status).toBe(200);
    expect(store.getTask(t.id)).toBeNull();
  });

  test("a catalog DELETE confirmed at zero members and raced by a new member is a 412, not the membership 400", async () => {
    store.addTag({ name: "old" });
    const tag = (await call(app, "GET", "/api/tags/old/state")).json as TagStateSnapshot;
    store.addTask({ title: "joins", tags: ["old"] });
    store.addLane({ name: "later" });
    const lane = (await call(app, "GET", "/api/lanes/later/state")).json as LaneStateSnapshot;
    store.addTask({ title: "arrives", lane: "later" });
    const staleTag = await call(
      app,
      "DELETE",
      "/api/tags/old",
      { guard: { expected: { entity: tag.versions.entity } } },
      VERSIONED,
    );
    expect(staleTag.status).toBe(412);
    expect(staleTag.json).toMatchObject({ code: "version_conflict", kind: "tag", key: "old" });
    const staleLane = await call(
      app,
      "DELETE",
      "/api/lanes/later",
      { guard: { expected: { entity: lane.versions.entity } } },
      VERSIONED,
    );
    expect(staleLane.status).toBe(412);
    expect(staleLane.json).toMatchObject({ code: "version_conflict", kind: "lane", key: "later" });
    expect(store.listTags().find(t => t.name === "old")?.task_count).toBe(1);
    expect(store.listLanes().some(l => l.name === "later")).toBe(true);
    // Unguarded, the membership policy still answers 400.
    expect((await call(app, "DELETE", "/api/tags/old")).status).toBe(400);
    expect((await call(app, "DELETE", "/api/lanes/later")).status).toBe(400);
  });

  test("a partial or malformed guard is a 400 invalid_guard and writes nothing", async () => {
    const t = store.addTask({ title: "t", body: "b" });
    const v = stateOf(store, t.id).versions;
    const now = stateOf(store, t.id);
    for (const guard of [
      { expected: { title: v.title } },
      { expected: { tags: "x" } },
      { expected: { body: "" } },
      { expected: "nope" },
      "nope",
      null,
      { expected: { body: v.body }, extra: 1 },
      { mutationId: "has spaces" },
    ]) {
      const r = await call(app, "PATCH", `/api/tasks/${t.id}`, { body: "x", guard });
      expect(r.status, JSON.stringify(guard)).toBe(400);
      expect((r.json as { code: string }).code, JSON.stringify(guard)).toBe("invalid_guard");
    }
    const create = await call(app, "POST", "/api/tasks", { title: "t", guard: { expected: { entity: "e" } } });
    expect([create.status, (create.json as { code: string }).code]).toEqual([400, "invalid_guard"]);
    expect(stateOf(store, t.id)).toEqual(now);
    expect(store.listTasks().length).toBe(1);
  });

  test("anchor conflicts keep their legacy 409 codes, guarded or not", async () => {
    const t = store.addTask({ title: "t", body: "a a" });
    const v = stateOf(store, t.id).versions;
    const r = await call(app, "PATCH", `/api/tasks/${t.id}`, {
      bodySearch: "a",
      bodyReplace: "b",
      guard: { expected: { body: v.body } },
    });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({
      error: "body-search anchor matched 2 times; refine for uniqueness",
      code: "body_search_ambiguous",
      matches: 2,
    });
  });

  test("mutation ids: a retry replays the original result, persists nothing and publishes nothing", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    const events = recordEvents(runtime);
    const guard = { mutationId: "create-1" };
    const first = await call(
      a,
      "POST",
      "/api/tasks",
      { title: "once", tags: ["x"], author: "agent-1", guard },
      VERSIONED,
    );
    const published = events.length;
    const legacyRetry = await call(a, "POST", "/api/tasks", { title: "once", tags: ["x"], author: "agent-1", guard });
    const versionedRetry = await call(
      a,
      "POST",
      "/api/tasks",
      { title: "once", tags: ["x"], author: "agent-1", guard },
      VERSIONED,
    );
    expect(first.status).toBe(201);
    expect(legacyRetry.status).toBe(201);
    expect(legacyRetry.text).toBe(JSON.stringify((first.json as TaskWriteResult).task));
    expect(versionedRetry.json).toEqual({ ...(first.json as TaskWriteResult), replayed: true });
    expect(events.length).toBe(published);
    expect(store.listTasks().length).toBe(1);
    expect(store.listNotifications().length).toBe(1);

    const id = (first.json as TaskWriteResult).task.id;
    const post = {
      author: "agent-1",
      summary: "blocked on x",
      status: "blocked",
      notify: true,
      guard: { mutationId: "post-1" },
    };
    const posted = await call(a, "POST", `/api/tasks/${id}/updates`, post);
    const afterPost = events.length;
    const replay = await call(a, "POST", `/api/tasks/${id}/updates`, post);
    expect(replay.text).toBe(posted.text);
    expect(events.length).toBe(afterPost);
    expect(store.listUpdates(id).filter(u => u.summary === "blocked on x").length).toBe(1);

    const status = { status: "review", author: "agent-1", guard: { mutationId: "status-1" } };
    expect((await call(a, "PATCH", `/api/tasks/${id}/status`, status)).status).toBe(200);
    const afterStatus = events.length;
    expect((await call(a, "PATCH", `/api/tasks/${id}/status`, status)).status).toBe(200);
    expect(events.length).toBe(afterStatus);

    const reuse = await call(a, "POST", `/api/tasks/${id}/updates`, { ...post, summary: "different" });
    expect(reuse.status).toBe(409);
    expect(reuse.json).toMatchObject({ code: "mutation_reused", mutationId: "post-1" });
    expect(store.listUpdates(id).some(u => u.summary === "different")).toBe(false);

    // Receipts are looked up before existence: a lost ack for a since-deleted task still replays.
    store.removeTask(id);
    const late = await call(a, "POST", `/api/tasks/${id}/updates`, post);
    expect([late.status, late.text]).toEqual([201, posted.text]);
  });

  test("Cortex-Instance binds a request to the daemon instance it verified", async () => {
    const identity: DaemonIdentity = {
      protocol: 1,
      instanceId: "inst-A",
      databaseId: store.databaseId(),
      databasePath: ":memory:",
      endpoint: { kind: "unix", socketPath: "/tmp/a.sock" },
      pid: process.pid,
    };
    const a = buildApp(store, createRuntime({ identity }));
    expect((await call(a, "GET", "/api/tasks", undefined, { "cortex-instance": "inst-A" })).status).toBe(200);
    const wrong = await call(a, "POST", "/api/tasks", { title: "misdirected" }, { "cortex-instance": "inst-B" });
    expect(wrong.status).toBe(421);
    expect(wrong.json).toMatchObject({ code: "instance_mismatch" });
    expect(store.listTasks().length).toBe(0);
    const unpublished = await call(app, "GET", "/api/tasks", undefined, { "cortex-instance": "inst-A" });
    expect(unpublished.status).toBe(421);
    expect((await call(app, "GET", "/api/tasks")).status).toBe(200);
  });
});

describe("server: atomic create and tag deltas (N9)", () => {
  test("POST /api/tasks applies tags, the created author and untitled titles atomically", async () => {
    const r = await call(app, "POST", "/api/tasks", { untitled: true, lane: "later", tags: ["x"], author: "agent-1" });
    expect(r.status).toBe(201);
    const t = r.json as Task;
    expect(t).toMatchObject({ title: `untitled-${t.id}`, lane: "later", tags: ["x"] });
    expect(store.listUpdates(t.id).map(u => [u.author, u.summary])).toEqual([["agent-1", "created"]]);
    expect(store.listNotifications()[0]).toMatchObject({
      task_id: t.id,
      message: "created",
      title: `[${t.id}] untitled-${t.id}`,
    });
    expect((await call(app, "POST", "/api/tasks", { untitled: true, title: "both" })).status).toBe(400);
    expect((await call(app, "POST", "/api/tasks", { untitled: "yes" })).status).toBe(400);
    expect((await call(app, "POST", "/api/tasks", { title: "t", author: "bad\nauthor" })).status).toBe(400);
    expect((await call(app, "POST", "/api/tasks", { title: "untitled" })).json).toMatchObject({ title: "untitled" });
  });

  test("the created notification commits with the task or not at all", async () => {
    const before = store.listTasks().length;
    store.runInTransaction(raw =>
      raw.run(`CREATE TRIGGER fail_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'injected'); END;`),
    );
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    let r: Response;
    try {
      r = await send(app, "POST", "/api/tasks", { title: "half", tags: ["t"] });
    } finally {
      quiet.mockRestore();
      store.runInTransaction(raw => raw.run(`DROP TRIGGER fail_notice;`));
    }
    expect(r.status).toBe(500);
    expect(store.listTasks().length).toBe(before);
    expect(store.listTags().length).toBe(0);
  });

  test("PATCH tags add/remove use the Store's atomic delta instead of read-then-replace", async () => {
    const t = store.addTask({ title: "t", tags: ["a"] });
    const replace = spyOn(store, "setTaskTags");
    const delta = spyOn(store, "changeTaskTags");
    try {
      expect(((await call(app, "PATCH", `/api/tasks/${t.id}/tags`, { add: ["b"] })).json as Task).tags).toEqual([
        "a",
        "b",
      ]);
      expect(((await call(app, "PATCH", `/api/tasks/${t.id}/tags`, { remove: ["a"] })).json as Task).tags).toEqual([
        "b",
      ]);
      expect(replace).not.toHaveBeenCalled();
      expect(delta).toHaveBeenCalledTimes(2);
      expect((await call(app, "PATCH", `/api/tasks/${t.id}/tags`, { add: ["BAD!"] })).status).toBe(400);
      expect((await call(app, "PATCH", "/api/tasks/9999/tags", { add: ["BAD!"] })).status).toBe(404);
    } finally {
      replace.mockRestore();
      delta.mockRestore();
    }
  });
});

describe("server: published events (N12)", () => {
  test("writes publish their legacy kinds and payloads in commit order", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    const events = recordEvents(runtime);
    const t = (await call(a, "POST", "/api/tasks", { title: "t", author: "agent-1" })).json as Task;
    await call(a, "POST", `/api/tasks/${t.id}/updates`, {
      author: "agent-1",
      summary: "go",
      status: "review",
      notify: true,
    });
    expect(events.map(e => e.kind)).toEqual([
      "task.added",
      "update.posted", // the `created` row
      "notification.added",
      "update.posted", // the message
      "update.posted", // its `status → review` audit row, committed with it
      "notification.added",
      "task.updated",
    ]);
    expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events[0]?.payload).toEqual(t);
    expect(events.slice(1, 5).flatMap(e => (e.kind === "update.posted" ? [e.payload] : []))).toEqual(
      store.listUpdates(t.id),
    );
    expect(events[6]?.payload).toEqual(store.getTask(t.id));
    expect((events[5]?.payload as { message: string }).message).toBe("open \u2192 review");
  });

  test("a status change publishes its committed audit row as update.posted, once; a replay publishes nothing", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    const t = store.addTask({ title: "t" });
    const events = recordEvents(runtime);
    const posted = () => events.filter(e => e.kind === "update.posted").map(e => e.payload as Update);
    const change = { status: "review", author: "agent-1", guard: { mutationId: "status-1" } };
    const first = await call(a, "PATCH", `/api/tasks/${t.id}/status`, change, VERSIONED);
    expect(first.status).toBe(200);
    const audit = store.listUpdates(t.id);
    expect(audit.map(u => [u.author, u.summary])).toEqual([["agent-1", "status \u2192 review"]]);
    // The same payload shape as a normal post: the committed row itself.
    expect(posted()).toEqual(audit);
    expect(events.map(e => e.kind)).toEqual(["update.posted", "notification.added", "task.updated"]);
    const replay = await call(a, "PATCH", `/api/tasks/${t.id}/status`, change, VERSIONED);
    expect((replay.json as TaskWriteResult).replayed).toBe(true);
    expect(events.length).toBe(3);

    // A status post: the message, then its audit row (the DTO's `audit`), each exactly once.
    const post = { author: "agent-1", summary: "closing", status: "done", guard: { mutationId: "post-1" } };
    const result = (await call(a, "POST", `/api/tasks/${t.id}/updates`, post, VERSIONED)).json as PostUpdateResult;
    expect(posted().slice(1)).toEqual([result.update, result.audit as Update]);
    expect(result.audit?.summary).toBe("status \u2192 done");
    const count = events.length;
    const again = (await call(a, "POST", `/api/tasks/${t.id}/updates`, post, VERSIONED)).json as PostUpdateResult;
    expect(again.replayed).toBe(true);
    expect(events.length).toBe(count);
    expect(store.listUpdates(t.id)).toHaveLength(3);
    expect(new Set(posted().map(u => u.id)).size).toBe(3);
  });

  test("task.blocked fires once per real transition into blocked, never for creation, edits or same-status writes", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    const me = ((await call(a, "GET", "/api/me")).json as { author: string }).author;
    const events = recordEvents(runtime);
    const blocked = () =>
      events
        .filter(e => e.kind === "task.blocked")
        .map(e => e.payload as { task: Task; previous: string; author: string });
    const created = (await call(a, "POST", "/api/tasks", { title: "born blocked", status: "blocked" })).json as Task;
    await call(a, "PATCH", `/api/tasks/${created.id}`, { title: "still blocked" });
    await call(a, "PATCH", `/api/tasks/${created.id}/status`, { status: "blocked", author: "agent-1" });
    expect(blocked()).toEqual([]);

    const t = store.addTask({ title: "t" });
    await call(a, "PATCH", `/api/tasks/${t.id}/status`, { status: "blocked" });
    await call(a, "PATCH", `/api/tasks/${t.id}`, { body: "edit while blocked" });
    await call(a, "PATCH", `/api/tasks/${t.id}/lane`, { lane: "later" });
    await call(a, "PATCH", `/api/tasks/${t.id}/status`, { status: "blocked", author: "agent-2" });
    expect(blocked().map(b => [b.task.id, b.previous, b.task.status])).toEqual([[t.id, "open", "blocked"]]);

    await call(a, "PATCH", `/api/tasks/${t.id}/status`, { status: "open" });
    await call(a, "POST", `/api/tasks/${t.id}/updates`, {
      author: "agent-2",
      summary: "stuck",
      status: "blocked",
      notify: true,
    });
    await call(a, "POST", `/api/tasks/${t.id}/updates`, {
      author: "agent-2",
      summary: "stuck still",
      status: "blocked",
      notify: true,
    });
    expect(blocked().map(b => [b.previous, b.author])).toEqual([
      ["open", me],
      ["open", "agent-2"],
    ]);
    // Notifications keep the human/agent split: only the attributed post notified.
    expect(
      store
        .listNotifications()
        .filter(n => n.message.endsWith("\u2192 blocked"))
        .map(n => n.author),
    ).toEqual(["agent-2"]);
  });

  test("notification acknowledgements publish notification.changed; no-op acknowledgements publish nothing", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    const n1 = store.addNotification({ status: "open", title: "a", message: "m" });
    const n2 = store.addNotification({ status: "open", title: "b", message: "m" });
    const events = recordEvents(runtime);
    const changes = () => events.filter(e => e.kind === "notification.changed").map(e => e.payload);
    await call(a, "PATCH", `/api/notifications/${n1.id}/read`);
    await call(a, "PATCH", `/api/notifications/${n1.id}/read`);
    await call(a, "PATCH", `/api/notifications/${n1.id}/unread`);
    await call(a, "POST", "/api/notifications/read-all");
    await call(a, "POST", "/api/notifications/read-all");
    await call(a, "DELETE", `/api/notifications/${n2.id}`);
    await call(a, "DELETE", "/api/notifications/9999");
    await call(a, "DELETE", "/api/notifications");
    await call(a, "DELETE", "/api/notifications");
    expect(changes()).toEqual([
      { action: "read", id: n1.id, task_id: null },
      { action: "unread", id: n1.id, task_id: null },
      { action: "read_all", id: null, task_id: null },
      { action: "dismiss", id: n2.id, task_id: null },
      { action: "clear", id: null, task_id: null },
    ]);
    expect(events.every(e => e.kind === "notification.changed")).toBe(true);
  });

  test("deleting a task publishes task.removed and invalidates the notifications it cascaded", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    const noisy = (await call(a, "POST", "/api/tasks", { title: "noisy" })).json as Task;
    const quiet = store.addTask({ title: "quiet" });
    const events = recordEvents(runtime);
    await call(a, "DELETE", `/api/tasks/${noisy.id}`);
    await call(a, "DELETE", `/api/tasks/${quiet.id}`);
    expect(events.map(e => [e.kind, e.payload])).toEqual([
      ["task.removed", { id: noisy.id }],
      ["notification.changed", { action: "task_removed", id: null, task_id: noisy.id }],
      ["task.removed", { id: quiet.id }],
    ]);
    expect((await call(a, "GET", `/api/tasks/${noisy.id}/state`)).status).toBe(404);
  });
});

// ---------- SSE stream ----------

type Frame = SseFrame;

async function withNativeStreams(): Promise<() => void> {
  const web = await import("node:stream/web");
  const prevTS = globalThis.TransformStream;
  const prevWS = globalThis.WritableStream;
  (globalThis as { TransformStream: unknown }).TransformStream = web.TransformStream;
  (globalThis as { WritableStream: unknown }).WritableStream = web.WritableStream;
  return () => {
    (globalThis as { TransformStream: unknown }).TransformStream = prevTS;
    (globalThis as { WritableStream: unknown }).WritableStream = prevWS;
  };
}

async function openEvents(
  a: ReturnType<typeof buildApp>,
): Promise<{ next(timeoutMs?: number): Promise<Frame>; close(): Promise<void>; res: Response }> {
  const res = await send(a, "GET", "/events");
  if (!res.body) throw new Error("no SSE body");
  const reader = res.body.getReader();
  const frames: Frame[] = [];
  const parser = createSseParser(frame => frames.push(frame));
  let pending: ReturnType<typeof reader.read> | null = null;
  return {
    res,
    async next(timeoutMs = 2000) {
      const deadline = performance.now() + timeoutMs;
      while (frames.length === 0) {
        pending ??= reader.read();
        const left = deadline - performance.now();
        const result = await Promise.race([pending, Bun.sleep(Math.max(0, left)).then(() => null)]);
        if (result === null) throw new Error("timed out waiting for an SSE frame");
        pending = null;
        if (result.done) throw new Error("SSE stream ended");
        parser.feed(result.value);
      }
      const frame = frames.shift();
      if (!frame) throw new Error("unreachable");
      return frame;
    },
    async close() {
      await reader.cancel();
    },
  };
}

describe("server: GET /events (N12)", () => {
  let restore: () => void = () => {};
  beforeEach(async () => {
    restore = await withNativeStreams();
  });
  afterEach(() => restore());

  test("ready is the first frame, sent after the subscription is live, carrying the cursor", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    store.addTask({ title: "before" });
    runtime.events.publish("task.added", { id: 0 });
    const stream = await openEvents(a);
    expect(runtime.events.listenerCount()).toBe(1);
    // Published after the handler returned, before anything was read: must not be lost.
    runtime.events.publish("lane.changed", { name: "x" });
    const ready = await stream.next();
    expect(ready.event).toBe("ready");
    expect(ready.id).toBe(`${runtime.events.epoch}:1`);
    expect(JSON.parse(ready.data)).toEqual({
      cursor: `${runtime.events.epoch}:1`,
      epoch: runtime.events.epoch,
      instanceId: null,
      databaseId: store.databaseId(),
    });
    expect(await stream.next()).toEqual({
      event: "lane.changed",
      data: '{"name":"x"}',
      id: `${runtime.events.epoch}:2`,
    });
    expect(stream.res.headers.get("content-type")?.startsWith("text/event-stream")).toBe(true);
    await stream.close();
    await Bun.sleep(5);
    expect(runtime.events.listenerCount()).toBe(0);
  });

  test("a write between subscribe and snapshot is in the snapshot or strictly after its cursor", async () => {
    const runtime = createRuntime();
    const a = buildApp(store, runtime);
    const stream = await openEvents(a);
    const ready = await stream.next();
    const during = (await call(a, "POST", "/api/tasks", { title: "during fetch" })).json as Task;
    const snap = (await call(a, "GET", "/api/workspace")).json as WorkspaceSnapshot;
    const after = (await call(a, "POST", "/api/tasks", { title: "after snapshot" })).json as Task;
    const snapSeq = parseCursor(snap.cursor)?.seq ?? -1;
    const seqOf = (f: Frame) => parseCursor(f.id)?.seq ?? -1;
    const frames = [await stream.next(), await stream.next(), await stream.next(), await stream.next()];
    expect(frames.map(f => f.event)).toEqual(["task.added", "notification.added", "task.added", "notification.added"]);
    expect(seqOf(ready)).toBeLessThan(seqOf(frames[0] as Frame));
    expect(snap.tasks.map(t => t.id)).toEqual([during.id]);
    expect(seqOf(frames[1] as Frame)).toBeLessThanOrEqual(snapSeq);
    expect(seqOf(frames[2] as Frame)).toBeGreaterThan(snapSeq);
    expect(JSON.parse((frames[2] as Frame).data).id).toBe(after.id);
    await stream.close();
  });

  test("ids are <epoch>:<seq>, strictly increasing, and a restarted daemon has a new epoch", async () => {
    const one = createRuntime();
    const a = buildApp(store, one);
    const stream = await openEvents(a);
    await stream.next();
    const t = (await call(a, "POST", "/api/tasks", { title: "t" })).json as Task;
    await call(a, "PATCH", `/api/tasks/${t.id}`, { title: "t2" });
    const ids = [await stream.next(), await stream.next(), await stream.next()].map(f => parseCursor(f.id));
    expect(ids).toEqual([1, 2, 3].map(seq => ({ epoch: one.events.epoch, seq })));
    await stream.close();

    const two = createRuntime();
    const restarted = await openEvents(buildApp(store, two));
    const ready = await restarted.next();
    expect(parseCursor(ready.id)?.epoch).toBe(two.events.epoch);
    expect(two.events.epoch).not.toBe(one.events.epoch);
    await restarted.close();
  });

  test("a slow reader's bounded queue collapses into one resync instead of growing", async () => {
    const runtime = createRuntime({ stream: { maxQueuedFrames: 4 } });
    const a = buildApp(store, runtime);
    const stream = await openEvents(a);
    // Nothing reads while 40 events publish: the queue overflows at the 5th
    // and every later event only advances the one pending resync's cursor.
    for (let i = 1; i <= 40; i++) runtime.events.publish("task.updated", { i });
    const frames: Frame[] = [await stream.next(), await stream.next()];
    expect(frames.map(f => f.event)).toEqual(["ready", "resync"]);
    const resync = frames[1] as Frame;
    expect(resync.id).toBe(`${runtime.events.epoch}:40`);
    expect(JSON.parse(resync.data)).toEqual({ reason: "overflow", cursor: `${runtime.events.epoch}:40` });
    runtime.events.publish("tag.changed", { after: true });
    expect(await stream.next()).toEqual({
      event: "tag.changed",
      data: '{"after":true}',
      id: `${runtime.events.epoch}:41`,
    });
    await stream.close();
  });

  test("a single event larger than maxQueuedChars collapses into a resync even with an empty queue", async () => {
    const runtime = createRuntime({ stream: { maxQueuedChars: 64 } });
    const stream = await openEvents(buildApp(store, runtime));
    expect((await stream.next()).event).toBe("ready"); // the queue is empty from here on
    // One frame past the per-client bound (an unrestricted task body): never queued.
    runtime.events.publish("task.updated", { body: "x".repeat(200) });
    const resync = await stream.next();
    expect(resync).toEqual({
      event: "resync",
      data: JSON.stringify({ reason: "overflow", cursor: `${runtime.events.epoch}:1` }),
      id: `${runtime.events.epoch}:1`,
    });
    // Frames within the bound flow again after it.
    runtime.events.publish("tag.changed", { after: true });
    expect(await stream.next()).toEqual({
      event: "tag.changed",
      data: '{"after":true}',
      id: `${runtime.events.epoch}:2`,
    });
    await stream.close();
  });

  test("heartbeats keep legacy framing (no id) and never displace events", async () => {
    const runtime = createRuntime({ stream: { heartbeatMs: 10 } });
    const stream = await openEvents(buildApp(store, runtime));
    expect((await stream.next()).event).toBe("ready");
    const beat = await stream.next();
    expect(beat.event).toBe("heartbeat");
    expect(Number(beat.data)).toBeGreaterThan(0);
    expect(beat.id).toBe(`${runtime.events.epoch}:0`); // persisted last-event-id, no new id field
    await stream.close();
  });

  test("an idle stream is written to more often than Bun.serve's default 10 s idle timeout closes it", () => {
    // The daemon's listeners keep Bun's default idleTimeout (10 s) for ordinary requests; an idle
    // SSE stream survives only because a heartbeat is written first (15 s dropped every idle client).
    expect(DEFAULT_STREAM_LIMITS.heartbeatMs).toBeLessThan(10_000);
    expect(createRuntime().stream.heartbeatMs).toBe(DEFAULT_STREAM_LIMITS.heartbeatMs);
  });
});

// =====================================================================
// plan @400 Task 6: IPC-only control routes and the published identity
// =====================================================================

describe("server: IPC-only control routes (N11)", () => {
  const controlIdentity = (): DaemonIdentity => ({
    protocol: 1,
    instanceId: "inst-ctl",
    databaseId: store.databaseId(),
    databasePath: ":memory:",
    endpoint: { kind: "unix", socketPath: "/tmp/ctl.sock" },
    pid: process.pid,
    capabilities: ["control.shutdown"],
  });

  function recordingControl(): { calls: string[]; control: DaemonControl } {
    const calls: string[] = [];
    const control: DaemonControl = {
      shutdown: () => {
        calls.push("shutdown");
      },
    };
    return { calls, control };
  }

  test("a runtime without control has no control routes, whatever a request's headers claim", async () => {
    const identity = controlIdentity();
    const bare = buildApp(store, createRuntime({ identity }));
    const spoofed = {
      [INSTANCE_HEADER]: identity.instanceId,
      "x-cortex-listener": "ipc",
      forwarded: "for=unix",
      "x-forwarded-for": "127.0.0.1",
    };
    expect((await send(bare, "POST", CONTROL_PATHS.shutdown, {}, spoofed)).status).toBe(404);
    // The removed control routes (control.web, control.preview) are gone from every app.
    const { control } = recordingControl();
    const ipc = buildApp(store, createRuntime({ identity, control }));
    for (const route of ["/api/control/web", "/api/control/preview"]) {
      expect((await send(ipc, "POST", route, {}, spoofed)).status).toBe(404);
    }
  });

  test("shutdown is bound to the verified instance and answers before it shuts down", async () => {
    const identity = controlIdentity();
    const { calls, control } = recordingControl();
    const ipc = buildApp(store, createRuntime({ identity, control }));
    const missing = await call(ipc, "POST", CONTROL_PATHS.shutdown, {});
    expect(missing.status).toBe(400);
    expect(missing.json).toMatchObject({ code: "instance_required" });
    const wrong = await call(ipc, "POST", CONTROL_PATHS.shutdown, {}, { [INSTANCE_HEADER]: "inst-other" });
    expect(wrong.status).toBe(421);
    expect(wrong.json).toMatchObject({ code: "instance_mismatch" });
    const bound = { [INSTANCE_HEADER]: identity.instanceId };
    expect((await send(ipc, "GET", CONTROL_PATHS.shutdown, undefined, bound)).status).toBe(404);
    await Bun.sleep(40);
    expect(calls).toEqual([]);

    const ok = await call(ipc, "POST", CONTROL_PATHS.shutdown, {}, bound);
    expect(ok.status).toBe(202);
    expect(ok.json).toEqual({ ok: true, instanceId: identity.instanceId });
    expect(calls).toEqual([]); // deferred until the response is on its way
    await Bun.sleep(80);
    expect(calls).toEqual(["shutdown"]);
  });

  test("GET /api/health carries the published identity; an unpublished app answers without one", async () => {
    expect((await call(app, "GET", "/api/health")).json).not.toHaveProperty("identity");
    const identity = controlIdentity();
    const a = buildApp(store, createRuntime({ identity }));
    expect((await call(a, "GET", "/api/health")).json).toMatchObject({ ok: true, identity });
  });
});

describe("server: parallel update posts", () => {
  test("8 concurrent posts: all 201, all rows persisted, 8 update.posted events with their authors", async () => {
    const runtime = createRuntime();
    const live = buildApp(store, runtime);
    store.addTask({ title: "concurrent-target" });
    const events: PublishedEvent[] = [];
    const unsubscribe = runtime.events.subscribe(ev => {
      if (ev.kind === "update.posted") events.push(ev);
    });
    try {
      const authors = Array.from({ length: 8 }, (_, i) => `agent-${i}`);
      const responses = await Promise.all(
        authors.map(author =>
          live.fetch(req("POST", "/api/tasks/1/updates", { author, summary: `concurrent post from ${author}` })),
        ),
      );
      expect(responses.map(r => r.status)).toEqual(Array(8).fill(201));
      expect(
        store
          .listUpdates(1)
          .map(u => u.author)
          .sort(),
      ).toEqual([...authors].sort());
      expect(events.map(e => (e.payload as { author: string }).author).sort()).toEqual([...authors].sort());
    } finally {
      unsubscribe();
    }
  });
});

describe("server: GET /api/tasks/:id/related", () => {
  test("returns the three buckets, and 404 for a missing task", async () => {
    // A is referenced by D (an update), references B (its body) and shares a topical tag with C.
    const a = store.addTask({ title: "A" });
    const b = store.addTask({ title: "B" });
    const c = store.addTask({ title: "C" });
    const d = store.addTask({ title: "D" });
    store.editTask(a.id, { body: `out to @${b.id}` });
    store.addUpdate({ task_id: d.id, author: "test-9999", summary: `ping @${a.id}` });
    store.setTaskTags(a.id, ["share"]);
    store.setTaskTags(c.id, ["share"]);
    const { status, json } = await fetchJson(req("GET", `/api/tasks/${a.id}/related`));
    expect(status).toBe(200);
    const related = json as { referencedBy: Task[]; references: Task[]; shared: Task[] };
    expect(related.referencedBy.map(t => t.title)).toEqual(["D"]);
    expect(related.references.map(t => t.title)).toEqual(["B"]);
    expect(related.shared.map(t => t.title)).toEqual(["C"]);
    expect(await fetchJson(req("GET", "/api/tasks/9999/related"))).toEqual({
      status: 404,
      json: { error: "not found" },
    });
  });
});
