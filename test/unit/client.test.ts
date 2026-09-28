import { test, expect, describe } from "bun:test";
import * as client from "../../src/client.ts";
import { HttpError, createClient } from "../../src/client.ts";
import { HttpError as ApiHttpError, INSTANCE_HEADER, PREFER_VERSIONED, TransportError } from "../../src/api.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The native client (plan @400 N6/N11). Commands reach the daemon through
// daemon.ts withClient, which verifies the instance behind a database's
// published metadata and hands them createClient(endpoint); the old
// URL-first client (daemonUrl() reading cortex.pid/cortex.url, and the
// untyped Client object) is gone, so a pid file can no longer route a write.

describe("legacy URL-file client", () => {
  test("is gone: no daemonUrl(), no Client", () => {
    expect("daemonUrl" in client).toBe(false);
    expect("Client" in client).toBe(false);
  });
});

// ---------- createClient: native endpoints over createApi (plan @400 N11) ----------

describe("createClient", () => {
  type Seen = {
    method: string;
    pathname: string;
    search: string;
    headers: Record<string, string>;
    body: string | null;
  };

  function recordingFetch(seen: Seen[]) {
    return async (req: Request): Promise<Response> => {
      const u = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      seen.push({
        method: req.method,
        pathname: u.pathname,
        search: u.search,
        headers,
        body: req.method === "GET" ? null : await req.text(),
      });
      const versioned = req.headers.get("prefer") === PREFER_VERSIONED;
      return new Response(
        JSON.stringify(versioned ? { task: { id: 1 }, versions: {}, replayed: false } : [{ id: 1 }]),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(versioned ? { "preference-applied": PREFER_VERSIONED } : {}),
          },
        },
      );
    };
  }

  test("http endpoint: absolute URLs (trailing slashes tolerated), typed legacy + versioned calls", async () => {
    const seen: Seen[] = [];
    const server = Bun.serve({ port: 0, fetch: recordingFetch(seen) });
    try {
      const client = createClient({ kind: "http", url: `http://127.0.0.1:${server.port}/` });
      expect(await client.tasks()).toEqual([{ id: 1 }] as never);
      const result = await client.versioned.editTask(3, { title: "x" }, { expected: { title: "t" } });
      expect(result).toEqual({ task: { id: 1 }, versions: {}, replayed: false } as never);
      expect(seen.map(s => `${s.method} ${s.pathname}`)).toEqual(["GET /api/tasks", "PATCH /api/tasks/3"]);
      expect(JSON.parse(seen[1]?.body ?? "")).toEqual({ title: "x", guard: { expected: { title: "t" } } });
      expect(seen[1]?.headers.prefer).toBe(PREFER_VERSIONED);
    } finally {
      server.stop(true);
    }
  });

  test("unix endpoint: requests travel over the socket; instanceId binds every request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-client-sock-"));
    const socketPath = path.join(dir, "d.sock");
    const seen: Seen[] = [];
    const server = Bun.serve({ unix: socketPath, fetch: recordingFetch(seen) });
    try {
      const client = createClient({ kind: "unix", socketPath }, { instanceId: "inst-9" });
      await client.lanes();
      await client.delTag("old tag", true);
      expect(seen.map(s => `${s.method} ${s.pathname}${s.search}`)).toEqual([
        "GET /api/lanes",
        "DELETE /api/tags/old%20tag?force=1",
      ]);
      expect(seen.every(s => s.headers[INSTANCE_HEADER.toLowerCase()] === "inst-9")).toBe(true);
    } finally {
      server.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreachable socket is a TransportError, never a hang", async () => {
    const client = createClient({
      kind: "unix",
      socketPath: path.join(os.tmpdir(), `cortex-missing-${process.pid}.sock`),
    });
    const err = await client.tasks().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ kind: "network", uncertain: false });
  });

  test("HttpError is the shared api class, so one instanceof covers native and browser clients", () => {
    expect(HttpError).toBe(ApiHttpError);
  });
});
