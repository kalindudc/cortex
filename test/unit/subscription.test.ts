import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSseParser, subscribeChanges, type SseFrame, type SubscribeOptions } from "../../src/subscription.ts";
import type { ConnectionState, LiveEvent } from "../../src/contracts.ts";
import { buildApp, createRuntime } from "../../src/server.ts";
import { Store } from "../../src/store.ts";

// Native SSE for Bun 1.4.2 (no global EventSource; plan @400 N12/N25):
// createSseParser must follow the WHATWG event-stream rules on arbitrary
// chunk boundaries, and subscribeChanges must deliver only fresh, ordered
// frames, signal ready/resync/stale, reconnect and stop on abort.

const enc = new TextEncoder();

function parseAll(chunks: (string | Uint8Array)[]): SseFrame[] {
  const frames: SseFrame[] = [];
  const parser = createSseParser(frame => frames.push(frame));
  for (const chunk of chunks) parser.feed(typeof chunk === "string" ? enc.encode(chunk) : chunk);
  parser.end();
  return frames;
}

/** Every split of `text` into two chunks must parse identically. */
function everySplit(text: string): SseFrame[] {
  const bytes = enc.encode(text);
  const whole = parseAll([bytes]);
  for (let i = 1; i < bytes.length; i++) {
    expect(parseAll([bytes.slice(0, i), bytes.slice(i)]), `split at byte ${i}`).toEqual(whole);
  }
  expect(parseAll([...bytes].map(b => Uint8Array.of(b)))).toEqual(whole);
  return whole;
}

describe("createSseParser", () => {
  test("dispatches event/data/id and defaults the type to message", () => {
    expect(parseAll(['event: task.added\ndata: {"id":1}\nid: e:1\n\ndata: plain\n\n'])).toEqual([
      { event: "task.added", data: '{"id":1}', id: "e:1" },
      { event: "message", data: "plain", id: "e:1" },
    ]);
  });

  test("CRLF, CR and LF line endings are equivalent, even when CRLF straddles chunks", () => {
    const lf = parseAll(["event: a\ndata: 1\n\nevent: b\ndata: 2\n\n"]);
    expect(parseAll(["event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n"])).toEqual(lf);
    expect(parseAll(["event: a\rdata: 1\r\revent: b\rdata: 2\r\r"])).toEqual(lf);
    expect(parseAll(["event: a\r", "\ndata: 1\r", "\n\r", "\nevent: b\r\ndata: 2\r\n\r\n"])).toEqual(lf);
    everySplit("event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r");
  });

  test("multi-line data joins with LF and keeps empty data lines", () => {
    expect(parseAll(["data: one\ndata:two\ndata\ndata:  three\n\n"])).toEqual([
      { event: "message", data: "one\ntwo\n\n three", id: "" },
    ]);
  });

  test("multi-byte UTF-8 split across chunks decodes intact; a leading BOM is ignored", () => {
    const frames = everySplit("\uFEFFevent: t\ndata: caf\u00e9 \u2192 \u{1F680} \u4e2d\n\n");
    expect(frames).toEqual([{ event: "t", data: "caf\u00e9 \u2192 \u{1F680} \u4e2d", id: "" }]);
  });

  test("comments, unknown fields and blank lines without data dispatch nothing", () => {
    expect(parseAll([": heartbeat comment\n\nevent: x\n\nfoo: bar\n\n:c\ndata: y\n\n"])).toEqual([
      { event: "message", data: "y", id: "" },
    ]);
  });

  test("id persists across events, a NULL-bearing id is ignored, an empty id resets it", () => {
    expect(parseAll(["id: e:1\ndata: a\n\ndata: b\n\nid: bad\u0000\ndata: c\n\nid\ndata: d\n\n"])).toEqual([
      { event: "message", data: "a", id: "e:1" },
      { event: "message", data: "b", id: "e:1" },
      { event: "message", data: "c", id: "e:1" },
      { event: "message", data: "d", id: "" },
    ]);
  });

  test("retry accepts only ASCII digits; a field without a colon has an empty value", () => {
    const frames: SseFrame[] = [];
    const parser = createSseParser(frame => frames.push(frame));
    parser.feed(enc.encode("retry: 1500\n\nretry: 12a\n\ndata\n\n"));
    expect(parser.retry).toBe(1500);
    expect(frames).toEqual([{ event: "message", data: "", id: "" }]);
  });

  test("an event left unterminated when the stream ends is discarded", () => {
    expect(parseAll(["data: complete\n\ndata: partial"])).toEqual([{ event: "message", data: "complete", id: "" }]);
    expect(parseAll(["data: partial\n"])).toEqual([]);
  });

  test("a frame larger than the bound throws instead of buffering without limit", () => {
    const parser = createSseParser(() => {}, { maxEventChars: 64 });
    expect(() => parser.feed(enc.encode(`data: ${"x".repeat(100)}`))).toThrow(/64/);
    const multi = createSseParser(() => {}, { maxEventChars: 64 });
    expect(() => multi.feed(enc.encode(`${"data: 0123456789\n".repeat(10)}`))).toThrow(/64/);
  });
});

// ---------- subscribeChanges with scripted streams ----------

type Script = (string | { wait: number } | "hang")[];

/** A fetch whose Nth call streams scripts[N] (then ends, unless it hangs). */
function scriptedFetch(scripts: Script[], calls: string[] = []): NonNullable<SubscribeOptions["fetch"]> {
  return async (url, init) => {
    calls.push(`${url} ${init.unix ?? ""}`.trim());
    const script = scripts.shift();
    if (!script) return new Response("gone", { status: 503 });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const step of script) {
          if (step === "hang") return;
          if (typeof step === "string") controller.enqueue(enc.encode(step));
          else await Bun.sleep(step.wait);
        }
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
}

const frame = (event: string, id: string, data: unknown = {}): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\nid: ${id}\n\n`;

type Run = { events: LiveEvent[]; states: ConnectionState[]; done: Promise<void>; controller: AbortController };

function run(options: SubscribeOptions, until: (events: LiveEvent[]) => boolean): Run {
  const controller = new AbortController();
  const events: LiveEvent[] = [];
  const states: ConnectionState[] = [];
  const done = subscribeChanges(
    { kind: "http", url: "http://cortex.test" },
    event => {
      events.push(event);
      if (until(events)) controller.abort();
    },
    state => states.push(state),
    controller.signal,
    { retryDelayMs: 1, maxRetryDelayMs: 2, ...options },
  );
  return { events, states, done, controller };
}

const kinds = (events: LiveEvent[]): string[] => events.map(e => `${e.kind}@${e.cursor}`);

describe("subscribeChanges (scripted server)", () => {
  test("delivers ready first, then events in order with their cursors and parsed payloads", async () => {
    const r = run(
      {
        fetch: scriptedFetch([
          [": hi\n\n", frame("ready", "e:0", { cursor: "e:0" }), frame("task.added", "e:1", { id: 7 }), "hang"],
        ]),
      },
      events => events.length === 2,
    );
    await r.done;
    expect(kinds(r.events)).toEqual(["ready@e:0", "task.added@e:1"]);
    expect(r.events[1]?.payload).toEqual({ id: 7 });
    expect(r.states).toEqual(["connecting", "live"]);
  });

  test("drops duplicate, stale and out-of-order frames; a gap becomes resync", async () => {
    const r = run(
      {
        fetch: scriptedFetch([
          [
            frame("ready", "e:5"),
            frame("task.updated", "e:5"),
            frame("task.updated", "e:6", { n: 6 }),
            frame("task.updated", "e:6", { n: "dup" }),
            frame("task.updated", "e:4", { n: "stale" }),
            "event: heartbeat\ndata: 1\n\n",
            frame("task.updated", "e:7", { n: 7 }),
            frame("task.updated", "e:9", { n: 9 }),
            frame("task.updated", "e:10", { n: 10 }),
            "hang",
          ],
        ]),
      },
      events => events.some(e => e.cursor === "e:10"),
    );
    await r.done;
    expect(kinds(r.events)).toEqual([
      "ready@e:5",
      "task.updated@e:6",
      "task.updated@e:7",
      "resync@e:9",
      "task.updated@e:10",
    ]);
    expect(r.events[3]?.payload).toEqual({ reason: "gap", cursor: "e:9" });
  });

  test("server resync frames pass through; frames before ready or without a cursor are ignored", async () => {
    const r = run(
      {
        fetch: scriptedFetch([
          [
            frame("task.added", "e:1"),
            frame("ready", "e:1"),
            "event: task.added\ndata: {}\n\n",
            frame("resync", "e:40", { reason: "overflow", cursor: "e:40" }),
            frame("tag.changed", "e:41"),
            "hang",
          ],
        ]),
      },
      events => events.length === 3,
    );
    await r.done;
    expect(kinds(r.events)).toEqual(["ready@e:1", "resync@e:40", "tag.changed@e:41"]);
    expect(r.events[1]?.payload).toEqual({ reason: "overflow", cursor: "e:40" });
  });

  test("an unknown future event kind advances the cursor without delivery (no false gap)", async () => {
    const r = run(
      {
        fetch: scriptedFetch([
          [frame("ready", "e:0"), frame("task.renamed.v2", "e:1"), frame("task.added", "e:2"), "hang"],
        ]),
      },
      events => events.length === 2,
    );
    await r.done;
    expect(kinds(r.events)).toEqual(["ready@e:0", "task.added@e:2"]);
  });

  test("a dropped connection goes stale, reconnects and re-announces ready (new epoch)", async () => {
    const calls: string[] = [];
    const r = run(
      {
        fetch: scriptedFetch(
          [
            [frame("ready", "old:3"), frame("task.added", "old:4")],
            [frame("ready", "new:0"), frame("task.removed", "new:1"), "hang"],
          ],
          calls,
        ),
      },
      events => events.some(e => e.kind === "task.removed"),
    );
    await r.done;
    expect(kinds(r.events)).toEqual(["ready@old:3", "task.added@old:4", "ready@new:0", "task.removed@new:1"]);
    expect(r.states).toEqual(["connecting", "live", "stale", "live"]);
    expect(calls).toEqual(["http://cortex.test/events", "http://cortex.test/events"]);
  });

  test("an epoch change inside one stream is a resync", async () => {
    const r = run(
      {
        fetch: scriptedFetch([[frame("ready", "a:2"), frame("task.added", "b:1"), frame("task.added", "b:2"), "hang"]]),
      },
      events => events.length === 3,
    );
    await r.done;
    expect(kinds(r.events)).toEqual(["ready@a:2", "resync@b:1", "task.added@b:2"]);
    expect(r.events[1]?.payload).toEqual({ reason: "epoch", cursor: "b:1" });
  });

  test("non-SSE responses, fetch failures and malformed frames retry until ready", async () => {
    let n = 0;
    const scripted = scriptedFetch([[frame("ready", "e:0"), "hang"]]);
    const r = run(
      {
        fetch: async (url, init) => {
          n++;
          if (n === 1) throw new TypeError("connect ECONNREFUSED");
          if (n === 2) return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
          if (n === 3) return new Response("nope", { status: 404 });
          if (n === 4) {
            return new Response(frame("ready", "not-a-cursor"), { headers: { "content-type": "text/event-stream" } });
          }
          if (n === 5) {
            return new Response(`${frame("ready", "e:0")}event: task.added\ndata: {bad json\nid: e:1\n\n`, {
              headers: { "content-type": "text/event-stream" },
            });
          }
          return scripted(url, init);
        },
      },
      events => events.length === 2,
    );
    await r.done;
    expect(n).toBe(6);
    expect(kinds(r.events)).toEqual(["ready@e:0", "ready@e:0"]);
    expect(r.states).toEqual(["connecting", "live", "stale", "live"]);
  });

  test("an idle stream (no bytes, not even heartbeats) is torn down and reconnected", async () => {
    const calls: string[] = [];
    const r = run(
      {
        idleTimeoutMs: 30,
        fetch: scriptedFetch(
          [
            [frame("ready", "e:0"), "hang"],
            [frame("ready", "e:1"), "hang"],
          ],
          calls,
        ),
      },
      events => events.length === 2,
    );
    await r.done;
    expect(calls.length).toBe(2);
    expect(r.states).toEqual(["connecting", "live", "stale", "live"]);
  });

  test("aborting resolves promptly, even mid-connect and mid-backoff; an aborted signal never connects", async () => {
    const pre = new AbortController();
    pre.abort();
    let fetched = 0;
    const counting: SubscribeOptions["fetch"] = async () => {
      fetched++;
      return new Promise<Response>(() => {});
    };
    await subscribeChanges(
      { kind: "http", url: "http://x" },
      () => {},
      () => {},
      pre.signal,
      { fetch: counting },
    );
    expect(fetched).toBe(0);

    const mid = new AbortController();
    const hung = subscribeChanges(
      { kind: "http", url: "http://x" },
      () => {},
      () => {},
      mid.signal,
      { fetch: counting },
    );
    await Bun.sleep(10);
    mid.abort();
    await hung;
    expect(fetched).toBe(1);

    const backoff = new AbortController();
    const failing = subscribeChanges(
      { kind: "http", url: "http://x" },
      () => {},
      () => {},
      backoff.signal,
      { fetch: async () => new Response("down", { status: 503 }), retryDelayMs: 60_000 },
    );
    await Bun.sleep(10);
    const t0 = performance.now();
    backoff.abort();
    await failing;
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("a throwing consumer rejects the subscription instead of being retried silently", async () => {
    const controller = new AbortController();
    const done = subscribeChanges(
      { kind: "http", url: "http://x" },
      () => {
        throw new Error("consumer bug");
      },
      () => {},
      controller.signal,
      { fetch: scriptedFetch([[frame("ready", "e:0"), "hang"]]), retryDelayMs: 1 },
    );
    await expect(done).rejects.toThrow("consumer bug");
  });
});

// ---------- real transports: a Unix socket and loopback HTTP ----------

async function waitFor(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

describe("subscribeChanges over real transports", () => {
  let socketDir: string;

  beforeAll(() => {
    // Prefer the (sandboxed) runtime dir: the tmp/impl gate pins it under the
    // repo; fall back to the system temp dir elsewhere. Bun 1.4.2 refuses to
    // bind an existing socket path (EADDRINUSE), so every test gets a fresh one.
    const base =
      process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR)
        ? process.env.XDG_RUNTIME_DIR
        : os.tmpdir();
    socketDir = fs.mkdtempSync(path.join(base, "sub-"));
  });

  afterAll(() => {
    fs.rmSync(socketDir, { recursive: true, force: true });
  });

  for (const transport of ["unix", "http"] as const) {
    test(`${transport}: ready, then live writes with increasing cursors; abort unsubscribes`, async () => {
      const store = Store.open(":memory:");
      const runtime = createRuntime();
      const app = buildApp(store, runtime);
      const socketPath = path.join(socketDir, `${transport}.sock`);
      const server =
        transport === "unix"
          ? Bun.serve({ unix: socketPath, fetch: app.fetch })
          : Bun.serve({ port: 0, fetch: app.fetch });
      const endpoint =
        transport === "unix"
          ? ({ kind: "unix", socketPath } as const)
          : ({ kind: "http", url: `http://127.0.0.1:${server.port}` } as const);
      const post = (body: unknown): Promise<Response> =>
        transport === "unix"
          ? fetch("http://localhost/api/tasks", {
              method: "POST",
              unix: socketPath,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          : fetch(`${endpoint.kind === "http" ? endpoint.url : ""}/api/tasks`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
      const controller = new AbortController();
      const events: LiveEvent[] = [];
      const states: ConnectionState[] = [];
      try {
        const done = subscribeChanges(
          endpoint,
          e => events.push(e),
          s => states.push(s),
          controller.signal,
        );
        await waitFor(() => events.length === 1, "ready");
        expect(events[0]?.kind).toBe("ready");
        expect(events[0]?.cursor).toBe(runtime.events.cursor());
        expect(runtime.events.listenerCount()).toBe(1);

        expect((await post({ title: `over ${transport}` })).status).toBe(201);
        await waitFor(() => events.length === 3, "task.added + notification.added");
        expect(events.map(e => e.kind)).toEqual(["ready", "task.added", "notification.added"]);
        expect((events[1]?.payload as { title: string }).title).toBe(`over ${transport}`);
        expect(events.map(e => e.cursor)).toEqual([0, 1, 2].map(seq => `${runtime.events.epoch}:${seq}`));
        expect(states).toEqual(["connecting", "live"]);

        controller.abort();
        await done;
        await waitFor(() => runtime.events.listenerCount() === 0, "server-side unsubscribe");
      } finally {
        controller.abort();
        server.stop(true);
        store.close();
      }
    });
  }
});
