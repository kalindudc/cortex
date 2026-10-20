import { test, expect, describe, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  createApi,
  HttpError,
  INSTANCE_HEADER,
  newMutationId,
  parseHttpError,
  PREFER_VERSIONED,
  TransportError,
  type RequestSender,
} from "../../src/api.ts";
import type { CortexClient, TaskStateSnapshot, Versions, WorkspaceSnapshot } from "../../src/contracts.ts";
import { buildApp, createRuntime } from "../../src/server.ts";
import { Store } from "../../src/store.ts";

// src/api.ts is the environment-neutral typed client (plan @400 N11): the
// native client wraps it with socket/absolute-URL fetch, and it may import
// nothing but contract types.

const SOURCE = fs.readFileSync(path.resolve(import.meta.dir, "../../src/api.ts"), "utf8");

describe("api: environment-neutral module", () => {
  test("imports only types from ./contracts.ts", () => {
    const imports = [...SOURCE.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["'];?/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [statement, typeKeyword, specifier] of imports) {
      expect(typeKeyword, `runtime import: ${statement.trim()}`).toBe("type ");
      expect(specifier).toBe("./contracts.ts");
    }
    expect(SOURCE).not.toMatch(/^\s*import\s+["']/m);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
  });

  test("touches no Bun, node, DOM or UI-state globals", () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of [/\bBun\./, /\bprocess\./, /\bwindow\b/, /\bdocument\b/, /\blocalStorage\b/, /\bnode:/]) {
      expect(code, String(banned)).not.toMatch(banned);
    }
  });
});

// ---------- recording sender ----------

type Sent = { path: string; method: string; headers: Record<string, string>; body: unknown };

function recorder(respond: (sent: Sent) => Response = () => json({ ok: 1 })): { send: RequestSender; sent: Sent[] } {
  const sent: Sent[] = [];
  const send: RequestSender = async (p, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const record: Sent = {
      path: p,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? null),
    };
    sent.push(record);
    return respond(record);
  };
  return { send, sent };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

const versionedOk = (value: unknown, status = 200): Response =>
  json(value, status, { "preference-applied": PREFER_VERSIONED });

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject");
}

describe("api: legacy methods keep their routes and bodies", () => {
  const cases: [string, (api: CortexClient) => Promise<unknown>, string, string, unknown][] = [
    ["tasks", a => a.tasks(), "GET", "/api/tasks", null],
    ["tasks({})", a => a.tasks({}), "GET", "/api/tasks", null],
    [
      "tasks(query)",
      a => a.tasks({ lane: "a b", status: "open", search: "#x y", tags: ["t1", "t2"] }),
      "GET",
      "/api/tasks?lane=a%20b&status=open&search=%23x%20y&tags=t1%2Ct2",
      null,
    ],
    ["lanes", a => a.lanes(), "GET", "/api/lanes", null],
    ["updates", a => a.updates(4), "GET", "/api/tasks/4/updates", null],
    ["related", a => a.related(4), "GET", "/api/tasks/4/related", null],
    ["migrations", a => a.migrations(), "GET", "/api/migrations", null],
    ["backup", a => a.backup(), "POST", "/api/backup", {}],
    ["backup(opts)", a => a.backup({ rotate: 2 }), "POST", "/api/backup", { rotate: 2 }],
    ["addTask", a => a.addTask({ title: "t", lane: "now" }), "POST", "/api/tasks", { title: "t", lane: "now" }],
    ["editTask", a => a.editTask(3, { title: "x" }), "PATCH", "/api/tasks/3", { title: "x" }],
    ["moveLane", a => a.moveLane(3, "later"), "PATCH", "/api/tasks/3/lane", { lane: "later" }],
    ["delTask", a => a.delTask(3), "DELETE", "/api/tasks/3", null],
    [
      "postUpd",
      a => a.postUpd(3, { author: "me", summary: "s" }),
      "POST",
      "/api/tasks/3/updates",
      { author: "me", summary: "s" },
    ],
    ["addLane", a => a.addLane({ name: "l" }), "POST", "/api/lanes", { name: "l" }],
    ["editLane", a => a.editLane("a b", { color: "#fff" }), "PATCH", "/api/lanes/a%20b", { color: "#fff" }],
    ["delLane", a => a.delLane("a b"), "DELETE", "/api/lanes/a%20b", null],
    ["tags", a => a.tags(), "GET", "/api/tags", null],
    ["setTags", a => a.setTags(3, ["a"]), "PATCH", "/api/tasks/3/tags", { set: ["a"] }],
    ["addTaskTag", a => a.addTaskTag(3, "a"), "PATCH", "/api/tasks/3/tags", { add: ["a"] }],
    ["removeTaskTag", a => a.removeTaskTag(3, "a"), "PATCH", "/api/tasks/3/tags", { remove: ["a"] }],
    ["addTag", a => a.addTag({ name: "a" }), "POST", "/api/tags", { name: "a" }],
    ["editTag", a => a.editTag("a", { rename: "b" }), "PATCH", "/api/tags/a", { rename: "b" }],
    ["delTag", a => a.delTag("a"), "DELETE", "/api/tags/a", null],
    ["delTag(force)", a => a.delTag("a", true), "DELETE", "/api/tags/a?force=1", null],
    ["notifications", a => a.notifications(), "GET", "/api/notifications", null],
    ["markNotifRead", a => a.markNotifRead(9), "PATCH", "/api/notifications/9/read", null],
    ["markNotifUnread", a => a.markNotifUnread(9), "PATCH", "/api/notifications/9/unread", null],
    ["markAllNotifRead", a => a.markAllNotifRead(), "POST", "/api/notifications/read-all", null],
    ["delNotif", a => a.delNotif(9), "DELETE", "/api/notifications/9", null],
    ["clearNotifs", a => a.clearNotifs(), "DELETE", "/api/notifications", null],
    ["health", a => a.health(), "GET", "/api/health", null],
    ["me", a => a.me(), "GET", "/api/me", null],
    ["workspace", a => a.workspace(), "GET", "/api/workspace", null],
    ["taskState", a => a.taskState(5), "GET", "/api/tasks/5/state", null],
    ["laneState", a => a.laneState("a b"), "GET", "/api/lanes/a%20b/state", null],
    ["tagState", a => a.tagState("x"), "GET", "/api/tags/x/state", null],
    [
      "memorySearch",
      a => a.memorySearch({ q: "a b", lane: "l", limit: 3, exclude: [1, 2] }),
      "GET",
      "/api/memory/search?q=a%20b&lane=l&limit=3&exclude=1%2C2",
      null,
    ],
    [
      "memorySearch(boost)",
      a => a.memorySearch({ q: "x", boost: "my lane" }),
      "GET",
      "/api/memory/search?q=x&boost=my%20lane",
      null,
    ],
    [
      "memoryStreams",
      a => a.memoryStreams({ lane: "l", author: "pi-x", active: true }),
      "GET",
      "/api/memory/streams?lane=l&author=pi-x&active=1",
      null,
    ],
    [
      "memoryStreams(excludeLane)",
      a => a.memoryStreams({ excludeLane: "l", active: true, limit: 3 }),
      "GET",
      "/api/memory/streams?excludeLane=l&active=1&limit=3",
      null,
    ],
    [
      "memoryStreams(withExcluded)",
      a => a.memoryStreams({ author: "pi-x", withExcluded: true }),
      "GET",
      "/api/memory/streams?author=pi-x&withExcluded=1",
      null,
    ],
    ["memoryStreams()", a => a.memoryStreams(), "GET", "/api/memory/streams", null],
    ["memoryStream", a => a.memoryStream(4), "GET", "/api/memory/streams/4", null],
  ];

  for (const [name, call, method, route, body] of cases) {
    test(`${name} → ${method} ${route}`, async () => {
      const { send, sent } = recorder();
      await call(createApi(send));
      expect(sent.length).toBe(1);
      expect(sent[0]).toMatchObject({ method, path: route, body });
      expect(sent[0]?.headers.prefer).toBeUndefined();
      expect(sent[0]?.headers["content-type"] as string | undefined).toBe(
        body === null ? undefined : "application/json",
      );
    });
  }

  test("void methods resolve to undefined; data methods resolve to the parsed body", async () => {
    const { send } = recorder(() => json({ ok: true }));
    const api = createApi(send);
    expect(await api.delTask(1)).toBeUndefined();
    expect(await api.markAllNotifRead()).toBeUndefined();
    expect(await api.tasks()).toEqual({ ok: true } as never);
  });
});

describe("api: versioned guarded writes", () => {
  const guard = { expected: { body: "tok" } as Versions, mutationId: "m-1" };
  const cases: [string, (api: CortexClient) => Promise<unknown>, string, string, unknown][] = [
    [
      "addTask",
      a => a.versioned.addTask({ untitled: true, tags: ["x"] }, { mutationId: "m-1" }),
      "POST",
      "/api/tasks",
      { untitled: true, tags: ["x"], guard: { mutationId: "m-1" } },
    ],
    ["editTask", a => a.versioned.editTask(3, { body: "b" }, guard), "PATCH", "/api/tasks/3", { body: "b", guard }],
    [
      "setStatus",
      a => a.versioned.setStatus(3, { status: "review", author: "agent-1" }, guard),
      "PATCH",
      "/api/tasks/3/status",
      { status: "review", author: "agent-1", guard },
    ],
    ["moveTask", a => a.versioned.moveTask(3, "later"), "PATCH", "/api/tasks/3/lane", { lane: "later" }],
    ["changeTags", a => a.versioned.changeTags(3, { add: ["a"] }), "PATCH", "/api/tasks/3/tags", { add: ["a"] }],
    [
      "setMemory",
      a => a.versioned.setMemory(3, { excluded: true }),
      "PATCH",
      "/api/tasks/3/memory",
      { excluded: true },
    ],
    [
      "removeTask",
      a => a.versioned.removeTask(3, { expected: { entity: "e" } }),
      "DELETE",
      "/api/tasks/3",
      { guard: { expected: { entity: "e" } } },
    ],
    [
      "postUpdate",
      a =>
        a.versioned.postUpdate(3, { author: "a", summary: "s", status: "done", notify: true }, { mutationId: "m-2" }),
      "POST",
      "/api/tasks/3/updates",
      { author: "a", summary: "s", status: "done", notify: true, guard: { mutationId: "m-2" } },
    ],
    ["addLane", a => a.versioned.addLane({ name: "l" }), "POST", "/api/lanes", { name: "l" }],
    [
      "editLane",
      a => a.versioned.editLane("l", { sort: 2 }, { expected: { definition: "d" } }),
      "PATCH",
      "/api/lanes/l",
      { sort: 2, guard: { expected: { definition: "d" } } },
    ],
    ["removeLane", a => a.versioned.removeLane("l"), "DELETE", "/api/lanes/l", null],
    ["addTag", a => a.versioned.addTag({ name: "t" }), "POST", "/api/tags", { name: "t" }],
    ["editTag", a => a.versioned.editTag("t", { color: null }), "PATCH", "/api/tags/t", { color: null }],
    ["removeTag", a => a.versioned.removeTag("t", { force: true }), "DELETE", "/api/tags/t?force=1", null],
  ];

  for (const [name, call, method, route, body] of cases) {
    test(`${name} → ${method} ${route} with Prefer: ${PREFER_VERSIONED}`, async () => {
      const { send, sent } = recorder(() => versionedOk({ ok: true, replayed: false }));
      expect(await call(createApi(send))).toEqual({ ok: true, replayed: false });
      expect(sent[0]).toMatchObject({ method, path: route, body });
      expect(sent[0]?.headers.prefer).toBe(PREFER_VERSIONED);
    });
  }

  test("a response without Preference-Applied is a protocol error, not a silent legacy success", async () => {
    const { send } = recorder(() => json({ id: 1 }));
    const err = await caught(createApi(send).versioned.editTask(1, { title: "x" }));
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ kind: "protocol", method: "PATCH", path: "/api/tasks/1", uncertain: true });
  });
});

describe("api: typed errors", () => {
  test("412 carries the structured version conflict", async () => {
    const conflict = {
      error: "task 1 changed since it was read (stale: body)",
      code: "version_conflict",
      kind: "task",
      key: 1,
      mismatches: [{ scope: "body" as const, expected: "old", current: "new" }],
      current: { body: "new", entity: "e" },
    };
    const { send } = recorder(() => json(conflict, 412));
    const err = (await caught(
      createApi(send).versioned.editTask(1, { body: "x" }, { expected: { body: "old" } }),
    )) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(412);
    expect(err.code).toBe("version_conflict");
    expect(err.message).toBe(conflict.error);
    expect(err.conflict).toEqual({ kind: "task", key: 1, mismatches: conflict.mismatches, current: conflict.current });
  });

  test("409 anchor errors and mutation reuse keep distinct codes", async () => {
    const anchor = await caught(
      createApi(
        recorder(() => json({ error: "matched 2", code: "body_search_ambiguous", matches: 2 }, 409)).send,
      ).editTask(1, {
        bodySearch: "a",
        bodyReplace: "b",
      }),
    );
    expect(anchor).toMatchObject({ status: 409, code: "body_search_ambiguous", matches: 2 });
    const reuse = await caught(
      createApi(recorder(() => json({ error: "reused", code: "mutation_reused", mutationId: "m" }, 409)).send).postUpd(
        1,
        {
          author: "a",
          summary: "s",
        },
      ),
    );
    expect(reuse).toMatchObject({ status: 409, code: "mutation_reused" });
    expect((reuse as HttpError).conflict).toBeUndefined();
  });

  test("parseHttpError keeps the legacy client's message/code/matches rules", () => {
    expect(parseHttpError(500, "plain failure")).toMatchObject({ status: 500, message: "plain failure" });
    expect(parseHttpError(400, JSON.stringify({ nope: 1 })).message).toBe('{"nope":1}');
    const e = parseHttpError(404, JSON.stringify({ error: "gone", code: 7, matches: "x" }));
    expect([e.message, e.code, e.matches]).toEqual(["gone", undefined, undefined]);
    expect(parseHttpError(502, "").message).toBe("HTTP 502");
  });

  test("transport failures are TransportErrors; writes are uncertain, reads are not", async () => {
    const down: RequestSender = async () => {
      throw new TypeError("connect ECONNREFUSED");
    };
    const read = await caught(createApi(down).tasks());
    expect(read).toBeInstanceOf(TransportError);
    expect(read).toMatchObject({ kind: "network", method: "GET", path: "/api/tasks", uncertain: false });
    const write = await caught(createApi(down).addTask({ title: "t" }));
    expect(write).toMatchObject({ kind: "network", method: "POST", uncertain: true });
    expect((write as Error).message).toContain("ECONNREFUSED");
  });

  test("a 2xx body that is not JSON is a protocol error", async () => {
    const err = await caught(createApi(async () => new Response("<html>", { status: 200 })).tasks());
    expect(err).toMatchObject({ kind: "protocol", uncertain: false });
  });

  test("timeouts and caller aborts reject promptly with their own kinds", async () => {
    const never: RequestSender = () => new Promise<Response>(() => {});
    const timeout = await caught(createApi(never, { timeoutMs: 20 }).editTask(1, { title: "x" }));
    expect(timeout).toMatchObject({ kind: "timeout", uncertain: true });

    const controller = new AbortController();
    const pending = caught(createApi(never, { signal: controller.signal }).tasks());
    controller.abort();
    expect(await pending).toMatchObject({ kind: "aborted", uncertain: false });

    const already = new AbortController();
    already.abort();
    let calls = 0;
    const counted: RequestSender = async () => {
      calls++;
      return json([]);
    };
    expect(await caught(createApi(counted, { signal: already.signal }).tasks())).toMatchObject({ kind: "aborted" });
    expect(calls).toBe(0);
  });

  test("a late response after a timeout is released, not leaked", async () => {
    let cancelled = false;
    const slow: RequestSender = async () => {
      await Bun.sleep(40);
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    };
    await caught(createApi(slow, { timeoutMs: 5 }).tasks());
    await Bun.sleep(80);
    expect(cancelled).toBe(true);
  });
});

describe("api: instance binding and mutation ids", () => {
  test("instanceId is sent on every request", async () => {
    const { send, sent } = recorder();
    const api = createApi(send, { instanceId: "inst-1" });
    await api.tasks();
    await api.addTask({ title: "t" });
    expect(sent.map(s => s.headers[INSTANCE_HEADER.toLowerCase()])).toEqual(["inst-1", "inst-1"]);
    await createApi(send).tasks();
    expect(sent[2]?.headers[INSTANCE_HEADER.toLowerCase()]).toBeUndefined();
  });

  test("newMutationId returns distinct valid ids", () => {
    const a = newMutationId();
    const b = newMutationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  });
});

// ---------- end to end against the in-process app ----------

describe("api: end to end against buildApp", () => {
  let store: Store;
  let api: CortexClient;

  beforeEach(() => {
    store = Store.open(":memory:");
    const app = buildApp(store, createRuntime());
    api = createApi((p, init) => Promise.resolve(app.fetch(new Request(`http://cortex${p}`, init))));
  });

  test("workspace and taskState read what the legacy methods read", async () => {
    const task = await api.addTask({ title: "e2e", tags: ["x"] });
    const snap: WorkspaceSnapshot = await api.workspace();
    expect(snap.tasks).toEqual(await api.tasks());
    expect(snap.tags).toEqual(await api.tags());
    expect(snap.notifications).toEqual(await api.notifications());
    const state: TaskStateSnapshot = await api.taskState(task.id);
    expect(state.task).toEqual(task);
    expect(state.versions).toEqual(store.taskState(task.id)?.versions ?? {});
    expect(state.cursor).toBe(snap.cursor);
  });

  test("a stale guard is a 412 HttpError and the fresh one succeeds with new versions", async () => {
    const task = await api.addTask({ title: "t" });
    const { versions } = await api.taskState(task.id);
    await api.editTask(task.id, { body: "someone else" });
    const err = (await caught(
      api.versioned.editTask(task.id, { body: "mine" }, { expected: { body: versions.body } }),
    )) as HttpError;
    expect(err.status).toBe(412);
    expect(err.conflict?.mismatches.map(m => m.scope)).toEqual(["body"]);
    const fresh = await api.taskState(task.id);
    const ok = await api.versioned.editTask(task.id, { body: "mine" }, { expected: { body: fresh.versions.body } });
    expect(ok.task.body).toBe("mine");
    expect(ok.versions.body).not.toBe(fresh.versions.body);
    expect(ok.replayed).toBe(false);
  });

  test("a retried post with the same mutation id is replayed, not duplicated", async () => {
    const task = await api.addTask({ title: "t" });
    const mutationId = newMutationId();
    const input = { author: "agent-1", summary: "ping", status: "review" as const };
    const first = await api.versioned.postUpdate(task.id, input, { mutationId });
    const again = await api.versioned.postUpdate(task.id, input, { mutationId });
    expect(again).toEqual({ ...first, replayed: true });
    expect((await api.updates(task.id)).map(u => u.summary)).toEqual(["ping", "status \u2192 review"]);
    const reuse = await caught(api.versioned.postUpdate(task.id, { ...input, summary: "other" }, { mutationId }));
    expect(reuse).toMatchObject({ status: 409, code: "mutation_reused" });
  });
});
