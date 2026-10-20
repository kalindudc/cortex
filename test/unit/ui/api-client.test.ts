import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { HttpError, TransportError } from "../../../src/api.ts";
import type { ConnectionState } from "../../../src/contracts.ts";
import type { BridgeFrame, BridgeRequest, BridgeResponse, CortexBridge } from "../../../src/desktop/ipc.ts";
import { api, connectLiveSource } from "../../../src/ui/api/client.ts";

// A plain object stands in for the preload's bridge; no DOM is needed.
type Fake = CortexBridge & {
  requests: BridgeRequest[];
  reply: (init: BridgeRequest) => Promise<BridgeResponse>;
  frameListeners: ((frame: BridgeFrame) => void)[];
  stateListeners: ((state: ConnectionState) => void)[];
  attachCalls: number;
};

function makeFake(): Fake {
  const fake: Fake = {
    requests: [],
    reply: async () => ({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: "{}" }),
    frameListeners: [],
    stateListeners: [],
    attachCalls: 0,
    request: init => {
      fake.requests.push(init);
      return fake.reply(init);
    },
    attach: async () => {
      fake.attachCalls++;
    },
    onFrame: listener => {
      fake.frameListeners.push(listener);
      return () => {};
    },
    onState: listener => {
      fake.stateListeners.push(listener);
      return () => {};
    },
    resume: async () => ({ ok: false, error: "not in this test" }),
    agents: async () => ({ ok: false, error: "not in this test" }),
    onOpen: () => () => {},
    drafts: {
      report: () => {},
      onSaveAll: () => () => {},
      onRelease: () => () => {},
      export: async () => ({ saved: false }),
    },
  };
  return fake;
}

const g = globalThis as { window?: unknown };
const previousWindow = g.window;
let fake: Fake;

beforeEach(() => {
  fake = makeFake();
  g.window = { cortex: fake };
});

afterAll(() => {
  g.window = previousWindow;
});

describe("api over window.cortex", () => {
  test("workspace() sends GET /api/workspace through request()", async () => {
    fake.reply = async () => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: null, cursor: "e:0", tasks: [], lanes: [], tags: [], notifications: [] }),
    });
    const workspace = await api.workspace();
    expect(workspace.cursor).toBe("e:0");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.method).toBe("GET");
    expect(fake.requests[0]?.path).toBe("/api/workspace");
  });

  test("a 404 reply becomes an HttpError and a rejected request a TransportError", async () => {
    fake.reply = async () => ({
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { code: "not_found", message: "task 9 not found" } }),
    });
    const notFound = await api.taskState(9).catch(err => err);
    expect(notFound).toBeInstanceOf(HttpError);
    expect((notFound as HttpError).status).toBe(404);

    fake.reply = () => Promise.reject(new Error("invalid bridge request: path traversal"));
    const failed = await api.workspace().catch(err => err);
    expect(failed).toBeInstanceOf(TransportError);
  });
});

describe("connectLiveSource", () => {
  test("registers its listeners without attaching, turns frames into MessageEvents and non-live states into error", () => {
    const source = connectLiveSource();
    expect(fake.frameListeners).toHaveLength(1);
    expect(fake.stateListeners).toHaveLength(1);
    expect(fake.attachCalls).toBe(0);

    const seen: MessageEvent[] = [];
    source.addEventListener("task.added", e => seen.push(e as MessageEvent));
    let errors = 0;
    source.addEventListener("error", () => errors++);

    fake.frameListeners[0]?.({ event: "task.added", data: '{"id":3}', id: "epoch:4" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.data).toBe('{"id":3}');
    expect(seen[0]?.lastEventId).toBe("epoch:4");

    fake.stateListeners[0]?.("live");
    expect(errors).toBe(0);
    fake.stateListeners[0]?.("stale");
    expect(errors).toBe(1);
  });
});
