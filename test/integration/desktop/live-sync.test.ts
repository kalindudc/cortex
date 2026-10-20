// The desktop bridge against a real daemon, with no Electron: startBridge
// follows the daemon's socket exactly as the main process does for a
// window, so each attach (a first load or a reload) gets its own `ready`,
// and a daemon restart reaches the renderer as a `ready` with a new epoch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApi } from "../../../src/api.ts";
import type { ConnectionState, ReadyPayload } from "../../../src/contracts.ts";
import { startBridge } from "../../../src/desktop/bridge.ts";
import type { BridgeFrame } from "../../../src/desktop/ipc.ts";
import { socketSender } from "../../../src/desktop/socketFetch.ts";
import { parseCursor } from "../../../src/events.ts";
import type { Task } from "../../../src/store.ts";
import { reap, startForeground, waitFor } from "../fixtures/daemon.ts";
import { mkTmpEnv, runCli } from "../helpers.ts";

type Recorder = { frames: BridgeFrame[]; states: ConnectionState[]; stop(): Promise<void> };

function record(socketPath: string): Recorder {
  const frames: BridgeFrame[] = [];
  const states: ConnectionState[] = [];
  const controller = new AbortController();
  const done = startBridge({
    socketPath,
    targets: { postFrame: frame => frames.push(frame), postState: state => states.push(state) },
    signal: controller.signal,
  });
  return {
    frames,
    states,
    stop: async () => {
      controller.abort();
      await done.catch(() => {});
    },
  };
}

const readies = (r: Recorder): BridgeFrame[] => r.frames.filter(f => f.event === "ready");
const added = (r: Recorder, title: string): BridgeFrame | undefined =>
  r.frames.find(f => f.event === "task.added" && (JSON.parse(f.data) as Task).title === title);

function socketOf(identity: { endpoint: { kind: string; socketPath?: string } }): string {
  if (identity.endpoint.kind !== "unix" || !identity.endpoint.socketPath) throw new Error("expected a unix endpoint");
  return identity.endpoint.socketPath;
}

describe("desktop bridge live sync against a real daemon", () => {
  let sandbox: ReturnType<typeof mkTmpEnv>;
  let socketPath: string;
  const recorders: Recorder[] = [];
  const follow = (): Recorder => {
    const r = record(socketPath);
    recorders.push(r);
    return r;
  };
  const cli = async (args: string[]): Promise<void> => {
    const result = await runCli({ args, env: sandbox.env });
    if (result.code !== 0) throw new Error(`cortex ${args.join(" ")} failed: ${result.stderr}`);
  };

  beforeEach(async () => {
    sandbox = mkTmpEnv("desktop-live");
    await cli(["init"]);
    const daemon = await startForeground(sandbox.env);
    socketPath = socketOf(daemon.identity);
  });

  afterEach(async () => {
    for (const r of recorders.splice(0)) await r.stop();
    await runCli({ args: ["stop"], env: sandbox.env });
    await reap();
    sandbox.cleanup();
  });

  test("the first frame is ready at sequence 0, and a CLI write arrives as task.added after it", async () => {
    const r = follow();
    const ready = await waitFor("the first frame", () => r.frames[0]);
    expect(ready.event).toBe("ready");
    const at = parseCursor(ready.id);
    expect(at?.seq).toBe(0);
    expect(r.states).toEqual(["connecting", "live"]);

    await cli(["add", "probe", "--as", "agent-1"]);
    const frame = await waitFor("task.added for probe", () => added(r, "probe"));
    const next = parseCursor(frame.id);
    expect(next?.epoch).toBe(at?.epoch);
    expect(next?.seq).toBeGreaterThan(at?.seq ?? 0);
  });

  test("a second bridge on the same socket (a window reload) gets its own ready; the first keeps receiving", async () => {
    const first = follow();
    await waitFor("the first bridge's ready", () => readies(first)[0]);
    const second = follow();
    await waitFor("the second bridge's ready", () => readies(second)[0]);
    expect(readies(first)).toHaveLength(1);

    await cli(["add", "seen twice", "--as", "agent-1"]);
    await waitFor("task.added on the second bridge", () => added(second, "seen twice"));
    await waitFor("task.added on the first bridge", () => added(first, "seen twice"));

    await first.stop();
    await cli(["add", "after abort", "--as", "agent-1"]);
    await waitFor("task.added after the first bridge aborted", () => added(second, "after abort"));
    expect(added(first, "after abort")).toBeUndefined();
  });

  test("a daemon restart reconnects with a new epoch, and its snapshot holds what was written while it was down", async () => {
    const r = follow();
    const firstReady = await waitFor("the first ready", () => readies(r)[0]);
    const firstEpoch = (JSON.parse(firstReady.data) as ReadyPayload).epoch;

    await cli(["stop"]);
    await waitFor("the stale state", () => (r.states.includes("stale") ? true : null));
    // No daemon runs, so the CLI writes the database directly and nothing is published.
    await cli(["add", "while down", "--as", "agent-1"]);
    const restarted = await startForeground(sandbox.env);
    const newSocket = socketOf(restarted.identity);

    const secondReady = await waitFor("a ready from the restarted daemon", () => readies(r)[1], 15_000);
    expect((JSON.parse(secondReady.data) as ReadyPayload).epoch).not.toBe(firstEpoch);
    expect(r.states.at(-1)).toBe("live");

    const snapshot = await createApi(socketSender(newSocket)).workspace();
    expect(snapshot.tasks.map(t => t.title)).toContain("while down");

    await cli(["add", "after restart", "--as", "agent-1"]);
    await waitFor("task.added after the restart", () => added(r, "after restart"));
  }, 30_000);
});
