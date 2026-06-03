import { test, expect, describe, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { daemonUrl, Client } from "../../src/client.ts";
import { pidPath, urlPath } from "../../src/paths.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Hermetic env-pin helpers. Every test that touches pidfile/urlfile MUST
 * redirect XDG_CONFIG_HOME to a fresh tmp dir so we never overwrite the
 * developer's real ~/.config/cortex/cortex.{pid,url} (which would silently
 * kill any running daemon).
 */
type EnvPin = { tmp: string; prevXdg: string | undefined };

function pinEnv(): EnvPin {
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-client-test-"));
  process.env.XDG_CONFIG_HOME = tmp;
  fs.mkdirSync(path.join(tmp, "cortex"), { recursive: true });
  return { tmp, prevXdg };
}

function unpinEnv(pin: EnvPin): void {
  if (pin.prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = pin.prevXdg;
  fs.rmSync(pin.tmp, { recursive: true, force: true });
}

describe("daemonUrl", () => {
  let pin: EnvPin;

  beforeEach(() => {
    pin = pinEnv();
    // Sanity: the pinned config dir lives under tmp, not under the real $HOME
    expect(pidPath().startsWith(pin.tmp)).toBe(true);
    expect(urlPath().startsWith(pin.tmp)).toBe(true);
  });

  afterEach(() => {
    unpinEnv(pin);
  });

  test("returns null when no pid file", () => {
    expect(fs.existsSync(pidPath())).toBe(false);
    expect(daemonUrl()).toBeNull();
  });

  test("returns null when no url file (pid exists)", () => {
    fs.writeFileSync(pidPath(), String(process.pid));
    expect(fs.existsSync(urlPath())).toBe(false);
    expect(daemonUrl()).toBeNull();
  });

  test("returns null when pid file has non-numeric content", () => {
    fs.writeFileSync(pidPath(), "not-a-pid");
    fs.writeFileSync(urlPath(), "http://127.0.0.1:1234");
    expect(daemonUrl()).toBeNull();
  });

  test("returns null when pid is dead", async () => {
    const proc = Bun.spawn(["true"]);
    await proc.exited;
    const deadPid = proc.pid;
    fs.writeFileSync(pidPath(), String(deadPid));
    fs.writeFileSync(urlPath(), "http://127.0.0.1:1234");
    expect(daemonUrl()).toBeNull();
  });

  test("returns null when url file is empty string", () => {
    fs.writeFileSync(pidPath(), String(process.pid));
    fs.writeFileSync(urlPath(), "   \n  ");
    expect(daemonUrl()).toBeNull();
  });

  test("returns the trimmed url when pid is alive", () => {
    fs.writeFileSync(pidPath(), String(process.pid));
    fs.writeFileSync(urlPath(), "  http://127.0.0.1:9999  \n");
    expect(daemonUrl()).toBe("http://127.0.0.1:9999");
  });
});

describe("Client", () => {
  type Recorded = { method: string; pathname: string; search: string; body: string | null };
  const recorded: Recorded[] = [];

  // Per-request override so the error-path test can return a 4xx.
  let nextResponse: Response | null = null;

  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req: Request) {
        const u = new URL(req.url);
        const body = req.method === "GET" || req.method === "DELETE" ? null : await req.text();
        recorded.push({ method: req.method, pathname: u.pathname, search: u.search, body });
        if (nextResponse) {
          const r = nextResponse;
          nextResponse = null;
          return r;
        }
        return new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    recorded.length = 0;
    nextResponse = null;
  });

  function only(): Recorded {
    expect(recorded.length).toBe(1);
    const r = recorded[0];
    if (!r) throw new Error("expected exactly one recorded request");
    return r;
  }

  test("addTask POSTs /api/tasks with json body", async () => {
    const result = await Client.addTask(baseUrl, { title: "hi", lane: "todo" });
    expect(result).toEqual({ ok: 1 });
    const r = only();
    expect(r.method).toBe("POST");
    expect(r.pathname).toBe("/api/tasks");
    expect(JSON.parse(r.body ?? "")).toEqual({ title: "hi", lane: "todo" });
  });

  test("getTask GETs /api/tasks/:id with no body", async () => {
    await Client.getTask(baseUrl, 42);
    const r = only();
    expect(r.method).toBe("GET");
    expect(r.pathname).toBe("/api/tasks/42");
    expect(r.body).toBeNull();
  });

  test("editTask PATCHes /api/tasks/:id with json body", async () => {
    await Client.editTask(baseUrl, 7, { title: "renamed" });
    const r = only();
    expect(r.method).toBe("PATCH");
    expect(r.pathname).toBe("/api/tasks/7");
    expect(JSON.parse(r.body ?? "")).toEqual({ title: "renamed" });
  });

  test("setStatus without author PATCHes /api/tasks/:id/status with {status}", async () => {
    await Client.setStatus(baseUrl, 9, "done");
    const r = only();
    expect(r.method).toBe("PATCH");
    expect(r.pathname).toBe("/api/tasks/9/status");
    expect(JSON.parse(r.body ?? "")).toEqual({ status: "done" });
  });

  test("setStatus with author PATCHes /api/tasks/:id/status with {status, author}", async () => {
    await Client.setStatus(baseUrl, 9, "review", "alice");
    const r = only();
    expect(r.method).toBe("PATCH");
    expect(r.pathname).toBe("/api/tasks/9/status");
    expect(JSON.parse(r.body ?? "")).toEqual({ status: "review", author: "alice" });
  });

  test("moveTask PATCHes /api/tasks/:id/lane with {lane}", async () => {
    await Client.moveTask(baseUrl, 3, "doing");
    const r = only();
    expect(r.method).toBe("PATCH");
    expect(r.pathname).toBe("/api/tasks/3/lane");
    expect(JSON.parse(r.body ?? "")).toEqual({ lane: "doing" });
  });

  test("removeTask DELETEs /api/tasks/:id with no body", async () => {
    await Client.removeTask(baseUrl, 11);
    const r = only();
    expect(r.method).toBe("DELETE");
    expect(r.pathname).toBe("/api/tasks/11");
    expect(r.body).toBeNull();
  });

  test("addUpdate POSTs /api/tasks/:id/updates with json body", async () => {
    await Client.addUpdate(baseUrl, 5, { message: "progress" });
    const r = only();
    expect(r.method).toBe("POST");
    expect(r.pathname).toBe("/api/tasks/5/updates");
    expect(JSON.parse(r.body ?? "")).toEqual({ message: "progress" });
  });

  test("backup POSTs /api/backup with json body", async () => {
    await Client.backup(baseUrl, { outPath: "/tmp/cortex.zip", rotate: 2 });
    const r = only();
    expect(r.method).toBe("POST");
    expect(r.pathname).toBe("/api/backup");
    expect(JSON.parse(r.body ?? "")).toEqual({ outPath: "/tmp/cortex.zip", rotate: 2 });
  });

  test("addLane POSTs /api/lanes with json body", async () => {
    await Client.addLane(baseUrl, { name: "backlog" });
    const r = only();
    expect(r.method).toBe("POST");
    expect(r.pathname).toBe("/api/lanes");
    expect(JSON.parse(r.body ?? "")).toEqual({ name: "backlog" });
  });

  test("editLane PATCHes /api/lanes/:name with encodeURIComponent", async () => {
    await Client.editLane(baseUrl, "with space", { rename: "ws" });
    const r = only();
    expect(r.method).toBe("PATCH");
    expect(r.pathname).toBe("/api/lanes/with%20space");
    expect(JSON.parse(r.body ?? "")).toEqual({ rename: "ws" });
  });

  test("removeLane DELETEs /api/lanes/:name with encodeURIComponent", async () => {
    await Client.removeLane(baseUrl, "with space");
    const r = only();
    expect(r.method).toBe("DELETE");
    expect(r.pathname).toBe("/api/lanes/with%20space");
    expect(r.body).toBeNull();
  });

  test("setTaskTags PATCHes /api/tasks/:id/tags with {set: names}", async () => {
    await Client.setTaskTags(baseUrl, 22, ["urgent", "bug"]);
    const r = only();
    expect(r.method).toBe("PATCH");
    expect(r.pathname).toBe("/api/tasks/22/tags");
    expect(JSON.parse(r.body ?? "")).toEqual({ set: ["urgent", "bug"] });
  });

  test("listTags GETs /api/tags with no body", async () => {
    await Client.listTags(baseUrl);
    const r = only();
    expect(r.method).toBe("GET");
    expect(r.pathname).toBe("/api/tags");
    expect(r.body).toBeNull();
  });

  test("addTag POSTs /api/tags with json body", async () => {
    await Client.addTag(baseUrl, { name: "urgent" });
    const r = only();
    expect(r.method).toBe("POST");
    expect(r.pathname).toBe("/api/tags");
    expect(JSON.parse(r.body ?? "")).toEqual({ name: "urgent" });
  });

  test("editTag PATCHes /api/tags/:name with encodeURIComponent", async () => {
    await Client.editTag(baseUrl, "needs review", { rename: "review" });
    const r = only();
    expect(r.method).toBe("PATCH");
    expect(r.pathname).toBe("/api/tags/needs%20review");
    expect(JSON.parse(r.body ?? "")).toEqual({ rename: "review" });
  });

  test("removeTag without force DELETEs /api/tags/:name (no querystring)", async () => {
    await Client.removeTag(baseUrl, "old tag");
    const r = only();
    expect(r.method).toBe("DELETE");
    expect(r.pathname).toBe("/api/tags/old%20tag");
    expect(r.search).toBe("");
  });

  test("removeTag with force DELETEs /api/tags/:name?force=1", async () => {
    await Client.removeTag(baseUrl, "old tag", true);
    const r = only();
    expect(r.method).toBe("DELETE");
    expect(r.pathname).toBe("/api/tags/old%20tag");
    expect(r.search).toBe("?force=1");
  });

  test("request helper throws Error with documented format on non-2xx (parses {error})", async () => {
    nextResponse = new Response(JSON.stringify({ error: "nope" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    let caught: Error | null = null;
    try {
      await Client.getTask(baseUrl, 1);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    // Source uses Unicode arrow "→" in the error message, not "->"
    if (!caught) throw new Error("expected caught error");
    expect(caught.message).toBe("GET /api/tasks/1 → 400: nope");
  });

  test("request helper falls back to raw text when body is not JSON", async () => {
    nextResponse = new Response("plain failure text", { status: 500 });
    let caught: Error | null = null;
    try {
      await Client.listTags(baseUrl);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    if (!caught) throw new Error("expected caught error");
    expect(caught.message).toBe("GET /api/tags → 500: plain failure text");
  });
});
