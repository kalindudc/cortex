import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { socketResponse, socketSender, socketStreamFetch } from "../../../src/desktop/socketFetch.ts";

let dir: string;
let socketPath: string;
let server: http.Server;
let streamClosed: Promise<void>;
let markStreamClosed: () => void;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sock-"));
  socketPath = path.join(dir, "s.sock");
  streamClosed = new Promise(resolve => {
    markStreamClosed = resolve;
  });
  server = http.createServer((req, res) => {
    if (req.url === "/empty") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ready\nid: e:0\ndata: {}\n\n");
      req.on("close", () => markStreamClosed());
      return;
    }
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json", "x-reply": "yes" });
      res.end(JSON.stringify({ method: req.method, url: req.url, probe: req.headers["x-probe"], body }));
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("socketFetch", () => {
  test("round-trips method, url, headers and body, and returns the JSON reply", async () => {
    const send = socketSender(socketPath);
    const res = await send("/api/tasks?x=1", {
      method: "POST",
      headers: { "x-probe": "p", "content-type": "application/json" },
      body: '{"title":"é"}',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-reply")).toBe("yes");
    expect(await res.json()).toEqual({ method: "POST", url: "/api/tasks?x=1", probe: "p", body: '{"title":"é"}' });
  });

  test("a 204 resolves with an empty body", async () => {
    const res = await socketResponse({ socketPath, method: "GET", path: "/empty" });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(await res.text()).toBe("");
  });

  test("streams the first SSE frame before the response ends, and cancel closes it", async () => {
    const res = await socketStreamFetch("http://localhost/events", { unix: socketPath });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("event: ready");
    await reader.cancel();
    await streamClosed;
  });

  test("socketStreamFetch rejects without init.unix", async () => {
    await expect(socketStreamFetch("http://localhost/events", {})).rejects.toThrow("init.unix");
  });

  test("an aborted signal and a missing socket reject", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(socketResponse({ socketPath, method: "GET", path: "/x", signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
    const missing = socketResponse({ socketPath: path.join(dir, "missing.sock"), method: "GET", path: "/x" });
    await expect(missing).rejects.toMatchObject({ code: "ENOENT" });
  });
});
