// Rich draft previews (plan @400 N11/N21, Task 10 part B): the bounded
// private token store and its routes. The create route exists ONLY on the
// IPC app (a control route bound to the verified instance); reads work on
// loopback with the EXACT token and nothing else; a preview never writes
// the task.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONTROL_PATHS, INSTANCE_HEADER } from "../../src/api.ts";
import type { DaemonIdentity, PreviewCreated, PreviewSnapshot } from "../../src/contracts.ts";
import {
  createPreviewStore,
  PREVIEW_MAX_BYTES,
  PREVIEW_TOTAL_BYTES,
  PREVIEW_TTL_MS,
  PreviewError,
  type PreviewErrorCode,
  type PreviewErrorStatus,
  type PreviewStore,
} from "../../src/preview.ts";
import { buildApp, createRuntime } from "../../src/server.ts";
import { createEventPublisher } from "../../src/events.ts";
import { Store } from "../../src/store.ts";

const MiB = 1024 * 1024;

let store: Store;
beforeEach(() => {
  store = Store.open(":memory:");
});
afterEach(() => {
  store.close();
});

/** A clock the tests move by hand. */
function manualClock(start = Date.UTC(2026, 0, 2, 3, 4, 5)): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: ms => void (t += ms) };
}

const draft = (source: string, over: Partial<{ taskId: number; title: string; unsaved: boolean }> = {}) => ({
  taskId: over.taskId ?? 7,
  title: over.title ?? "Plan the preview",
  source,
  unsaved: over.unsaved ?? true,
});

function expectPreviewError(run: () => unknown, code: PreviewErrorCode, status: PreviewErrorStatus): PreviewError {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(PreviewError);
  const err = caught as PreviewError;
  expect(err.code).toBe(code);
  expect(err.status).toBe(status);
  return err;
}

describe("preview store: tokens, TTL and limits", () => {
  test("the documented bounds: 10-minute TTL, 1 MiB per preview, 8 MiB in total", () => {
    expect(PREVIEW_TTL_MS).toBe(10 * 60 * 1000);
    expect(PREVIEW_MAX_BYTES).toBe(MiB);
    expect(PREVIEW_TOTAL_BYTES).toBe(8 * MiB);
  });

  test("a token is 128 random bits (32 lowercase hex) and never repeats", () => {
    const previews = createPreviewStore();
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { token, path } = previews.create(draft(`body ${i}`));
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(path).toBe(`/preview/${token}`);
      tokens.add(token);
    }
    expect(tokens.size).toBe(200);
  });

  test("reads return the EXACT source and identity until the TTL, then an explicit expiry", () => {
    const clock = manualClock();
    const previews = createPreviewStore({ now: clock.now });
    const source = "# Draft\r\n\n\tunsaved text \u{1F600} e\u0301\n\u001b]52;c;aGk=\u0007 <script>x</script>\n";
    const created = previews.create(draft(source, { title: "T\u0000itle" }));
    expect(created.expiresAt).toBe(new Date(clock.now() + PREVIEW_TTL_MS).toISOString());
    expect(created.bytes).toBe(Buffer.byteLength(source, "utf8") + Buffer.byteLength("T\u0000itle", "utf8"));
    clock.advance(PREVIEW_TTL_MS - 1);
    const read = previews.read(created.token);
    expect(read).toEqual({
      taskId: 7,
      title: "T\u0000itle",
      source,
      unsaved: true,
      createdAt: new Date(clock.now() - (PREVIEW_TTL_MS - 1)).toISOString(),
      expiresAt: created.expiresAt,
      bytes: created.bytes,
    } satisfies PreviewSnapshot);
    clock.advance(1);
    const err = expectPreviewError(() => previews.read(created.token), "preview_expired", 410);
    expect(err.message).toContain("expired");
    expect(err.message).toContain("10 minutes");
    expect(err.message).toContain(":preview");
  });

  test("an unknown, altered or malformed token is not found (only the exact token reads)", () => {
    const previews = createPreviewStore();
    const { token } = previews.create(draft("secret"));
    const flipped = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    for (const wrong of [
      flipped,
      token.toUpperCase(),
      token.slice(0, 31),
      `${token}0`,
      ` ${token}`,
      "",
      "../etc",
      "0".repeat(32),
    ]) {
      const err = expectPreviewError(() => previews.read(wrong), "preview_not_found", 404);
      expect(err.message).not.toContain("secret");
    }
    expect(previews.read(token).source).toBe("secret");
  });

  test("a shorter requested lifetime is honoured; it can never be longer than the TTL", () => {
    const clock = manualClock();
    const previews = createPreviewStore({ now: clock.now });
    const short = previews.create({ ...draft("soon"), ttlMs: 1000 });
    expect(short.expiresAt).toBe(new Date(clock.now() + 1000).toISOString());
    clock.advance(1000);
    expectPreviewError(() => previews.read(short.token), "preview_expired", 410);
    for (const ttlMs of [0, -1, 1.5, PREVIEW_TTL_MS + 1, Number.NaN]) {
      expectPreviewError(() => previews.create({ ...draft("x"), ttlMs }), "invalid_preview", 400);
    }
  });

  test("one preview may hold at most 1 MiB of UTF-8 (title and source), with an explicit error", () => {
    const previews = createPreviewStore();
    expect(previews.create(draft("a".repeat(MiB), { title: "" })).bytes).toBe(MiB);
    const err = expectPreviewError(
      () => previews.create(draft("a".repeat(MiB), { title: "t" })),
      "preview_too_large",
      413,
    );
    expect(err.message).toContain("1 MiB");
    // Multi-byte characters count by their UTF-8 bytes, not UTF-16 units.
    expectPreviewError(() => previews.create(draft("é".repeat(MiB / 2 + 1), { title: "" })), "preview_too_large", 413);
  });

  test("all previews together hold at most 8 MiB; expiry frees the space again", () => {
    const clock = manualClock();
    const previews = createPreviewStore({ now: clock.now });
    const first = previews.create(draft("a".repeat(MiB), { title: "" }));
    clock.advance(1000);
    for (let i = 1; i < 8; i++) previews.create(draft("b".repeat(MiB), { title: "" }));
    expect(previews.usage()).toEqual({ count: 8, bytes: 8 * MiB });
    const full = expectPreviewError(() => previews.create(draft("c", { title: "" })), "preview_storage_full", 507);
    expect(full.message).toContain("8 MiB");
    expect(full.message).toContain("expire");
    // The first one expires one second before the rest: exactly its space comes back.
    clock.advance(PREVIEW_TTL_MS - 1000);
    expectPreviewError(() => previews.read(first.token), "preview_expired", 410);
    expect(previews.usage()).toEqual({ count: 7, bytes: 7 * MiB });
    expect(previews.create(draft("d".repeat(MiB), { title: "" })).bytes).toBe(MiB);
  });

  test("expired tokens are remembered without their content, and only a bounded number of them", () => {
    const clock = manualClock();
    const previews = createPreviewStore({ now: clock.now, maxExpired: 2 });
    const tokens = [1, 2, 3].map(i => previews.create(draft(`body ${i}`)).token);
    clock.advance(PREVIEW_TTL_MS);
    // The oldest expired token fell out of the bounded memory: it reads as unknown.
    expectPreviewError(() => previews.read(tokens[0] as string), "preview_not_found", 404);
    expectPreviewError(() => previews.read(tokens[1] as string), "preview_expired", 410);
    expectPreviewError(() => previews.read(tokens[2] as string), "preview_expired", 410);
    expect(previews.usage()).toEqual({ count: 0, bytes: 0 });
  });

  test("create validates its request", () => {
    const previews = createPreviewStore();
    const bad: unknown[] = [
      null,
      [],
      "text",
      { title: "t", source: "s" },
      { taskId: 0, title: "t", source: "s" },
      { taskId: 1.5, title: "t", source: "s" },
      { taskId: "1", title: "t", source: "s" },
      { taskId: 1, title: 3, source: "s" },
      { taskId: 1, title: "t" },
      { taskId: 1, title: "t", source: 5 },
      { taskId: 1, title: "t", source: "s", unsaved: "yes" },
    ];
    for (const request of bad) {
      expectPreviewError(() => previews.create(request as never), "invalid_preview", 400);
    }
    expect(previews.usage()).toEqual({ count: 0, bytes: 0 });
  });
});

// ---------- routes ----------

const IDENTITY: DaemonIdentity = {
  protocol: 1,
  instanceId: "inst-preview",
  databaseId: "db-preview",
  databasePath: ":memory:",
  endpoint: { kind: "unix", socketPath: "/tmp/preview.sock" },
  pid: process.pid,
  capabilities: ["control.shutdown", "control.web", "control.preview"],
};

type App = ReturnType<typeof buildApp>;

async function call(
  app: App,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await app.fetch(new Request(`http://cortex${path}`, init));
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { text }; // e.g. Hono's plain-text 404 for a route that is not registered
  }
  return { status: res.status, json, headers: res.headers };
}

/** The daemon's two apps as `cortex serve` builds them: one publisher, one preview store. */
function daemonApps(previews: PreviewStore = createPreviewStore()): { ipc: App; web: App; events: number[] } {
  const events = createEventPublisher();
  const seen: number[] = [];
  events.subscribe(() => seen.push(1));
  const identity = { ...IDENTITY, databaseId: store.databaseId() };
  const ipc = buildApp(store, createRuntime({ identity, events, listener: "ipc", previews }));
  const web = buildApp(store, createRuntime({ identity, events, listener: "loopback", previews }));
  return { ipc, web, events: seen };
}

const bound = { [INSTANCE_HEADER]: IDENTITY.instanceId };

describe("preview routes (N11): IPC-only create, exact-token loopback reads", () => {
  test("the create route is a control route: only the IPC app has it, whatever a request claims", async () => {
    const { web } = daemonApps();
    const spoofed = {
      ...bound,
      "x-cortex-listener": "ipc",
      forwarded: "for=unix",
      "x-forwarded-for": "127.0.0.1",
      host: "localhost",
    };
    expect(CONTROL_PATHS.preview).toBe("/api/control/preview");
    expect((await call(web, "POST", CONTROL_PATHS.preview, draft("x"), spoofed)).status).toBe(404);
    // An in-process app (no runtime) is loopback: no create route either. (It has no identity,
    // so a Cortex-Instance header would already get 421 from the instance check.)
    const { [INSTANCE_HEADER]: _instance, ...unbound } = spoofed;
    expect((await call(buildApp(store), "POST", CONTROL_PATHS.preview, draft("x"), unbound)).status).toBe(404);
  });

  test("create must name the verified instance", async () => {
    const { ipc } = daemonApps();
    const missing = await call(ipc, "POST", CONTROL_PATHS.preview, draft("x"));
    expect(missing.status).toBe(400);
    expect(missing.json).toMatchObject({ code: "instance_required" });
    const wrong = await call(ipc, "POST", CONTROL_PATHS.preview, draft("x"), { [INSTANCE_HEADER]: "inst-other" });
    expect(wrong.status).toBe(421);
    expect(wrong.json).toMatchObject({ code: "instance_mismatch" });
  });

  test("a preview created over IPC reads back EXACTLY on loopback, and never writes the task", async () => {
    const task = store.addTask({ lane: "inbox", title: "Saved title", body: "saved body" });
    const before = store.taskState(task.id);
    const { ipc, web, events } = daemonApps();
    const source = "# Unsaved\r\n\n\t- [ ] draft only \u{1F600}\n<img src=x onerror=alert(1)>\n";
    const created = await call(
      ipc,
      "POST",
      CONTROL_PATHS.preview,
      draft(source, { taskId: task.id, title: "Draft title" }),
      bound,
    );
    expect(created.status).toBe(201);
    const answer = created.json as unknown as PreviewCreated;
    expect(answer.token).toMatch(/^[0-9a-f]{32}$/);
    expect(answer.path).toBe(`/preview/${answer.token}`);
    expect(created.headers.get("cache-control")).toContain("no-store");

    const read = await call(web, "GET", `/api/preview/${answer.token}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toContain("no-store");
    expect(read.json).toMatchObject({ taskId: task.id, title: "Draft title", source, unsaved: true });

    // Nothing was written or published: the task, its versions and its updates are untouched.
    expect(store.taskState(task.id)).toEqual(before);
    expect(events).toEqual([]);
  });

  test("reads ignore transport headers: only the exact token matters", async () => {
    const { ipc, web } = daemonApps();
    const { json } = await call(ipc, "POST", CONTROL_PATHS.preview, draft("only by token"), bound);
    const token = String(json.token);
    const trusted = await call(web, "GET", `/api/preview/${token.slice(0, 31)}`, undefined, {
      "x-cortex-listener": "ipc",
      forwarded: "for=unix",
      "x-forwarded-for": "127.0.0.1",
      "x-preview-token": token,
      cookie: `preview=${token}`,
    });
    expect(trusted.status).toBe(404);
    expect(trusted.json).toMatchObject({ code: "preview_not_found" });
    expect(JSON.stringify(trusted.json)).not.toContain("only by token");
    expect((await call(web, "GET", `/api/preview/${token.toUpperCase()}`)).status).toBe(404);
    expect((await call(web, "GET", `/api/preview/${token}`)).json).toMatchObject({ source: "only by token" });
  });

  test("expiry, limits and bad requests are explicit errors", async () => {
    const clock = manualClock();
    const { ipc, web } = daemonApps(createPreviewStore({ now: clock.now }));
    const { json } = await call(ipc, "POST", CONTROL_PATHS.preview, draft("soon gone"), bound);
    clock.advance(PREVIEW_TTL_MS);
    const expired = await call(web, "GET", `/api/preview/${String(json.token)}`);
    expect(expired.status).toBe(410);
    expect(expired.json).toMatchObject({ code: "preview_expired" });
    expect(String(expired.json.error)).toContain("expired");

    const big = await call(ipc, "POST", CONTROL_PATHS.preview, draft("a".repeat(MiB + 1), { title: "" }), bound);
    expect(big.status).toBe(413);
    expect(big.json).toMatchObject({ code: "preview_too_large", limit: MiB, bytes: MiB + 1 });
    expect(String(big.json.error)).toContain("1 MiB");

    for (const body of ["not json", "[]", JSON.stringify({ taskId: 1, title: "t" })]) {
      const bad = await call(ipc, "POST", CONTROL_PATHS.preview, body, bound);
      expect(bad.status).toBe(400);
      expect(bad.json).toMatchObject({ code: "invalid_preview" });
    }
  });

  test("the storage-full error names the total limit", async () => {
    const { ipc } = daemonApps(createPreviewStore({ totalBytes: 10 }));
    expect((await call(ipc, "POST", CONTROL_PATHS.preview, draft("12345", { title: "" }), bound)).status).toBe(201);
    const full = await call(ipc, "POST", CONTROL_PATHS.preview, draft("123456", { title: "" }), bound);
    expect(full.status).toBe(507);
    expect(full.json).toMatchObject({ code: "preview_storage_full", limit: 10 });
  });

  test("the dashboard serves its existing HTML shell at /preview/:token; / and task deep links are unchanged", async () => {
    const { web } = daemonApps();
    const shellRes = await web.fetch(new Request("http://cortex/"));
    const shell = await shellRes.text();
    expect(shell).toContain('src="/bundle.js"');
    for (const path of ["/preview/0123456789abcdef0123456789abcdef", "/preview/unknown", "/task/12"]) {
      const res = await web.fetch(new Request(`http://cortex${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
      expect(res.headers.get("cache-control") ?? "").toMatch(/no-store/);
      expect(await res.text()).toBe(shell);
    }
  });

  test("the daemon's two apps must share ONE store: separate runtimes cannot read each other's previews", async () => {
    const identity = { ...IDENTITY, databaseId: store.databaseId() };
    const ipc = buildApp(store, createRuntime({ identity, listener: "ipc" }));
    const web = buildApp(store, createRuntime({ identity, listener: "loopback" }));
    const { json } = await call(ipc, "POST", CONTROL_PATHS.preview, draft("private"), bound);
    expect((await call(web, "GET", `/api/preview/${String(json.token)}`)).status).toBe(404);
  });
});
