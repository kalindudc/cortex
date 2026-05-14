import { test, expect, describe, beforeEach } from "bun:test";
import { buildApp } from "../../src/server.ts";
import { Store } from "../../src/store.ts";

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
