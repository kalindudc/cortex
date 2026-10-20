import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ConnectionState } from "../../../src/contracts.ts";
import { startBridge } from "../../../src/desktop/bridge.ts";
import type { BridgeFrame } from "../../../src/desktop/ipc.ts";
import { formatCursor } from "../../../src/events.ts";

let dir: string;
let socketPath: string;
let server: http.Server;

const READY_ID = formatCursor("epoch1", 0);
const ADDED_ID = formatCursor("epoch1", 1);

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bridge-"));
  socketPath = path.join(dir, "s.sock");
  server = http.createServer((req, res) => {
    if (req.url !== "/events") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: ready\nid: ${READY_ID}\ndata: {"cursor":"${READY_ID}"}\n\n`);
    res.write(`event: task.added\nid: ${ADDED_ID}\ndata: {"id":7}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("startBridge", () => {
  test("forwards ready and change events in order as frames, reports state, and resolves on abort", async () => {
    const frames: BridgeFrame[] = [];
    const states: ConnectionState[] = [];
    const controller = new AbortController();
    let gotBoth!: () => void;
    const both = new Promise<void>(resolve => {
      gotBoth = resolve;
    });
    const done = startBridge({
      socketPath,
      signal: controller.signal,
      targets: {
        postFrame: frame => {
          frames.push(frame);
          if (frames.length === 2) gotBoth();
        },
        postState: state => states.push(state),
      },
    });
    await both;
    expect(frames).toEqual([
      { event: "ready", data: JSON.stringify({ cursor: READY_ID }), id: READY_ID },
      { event: "task.added", data: JSON.stringify({ id: 7 }), id: ADDED_ID },
    ]);
    expect(states[0]).toBe("connecting");
    expect(states).toContain("live");
    controller.abort();
    await done;
  });
});
