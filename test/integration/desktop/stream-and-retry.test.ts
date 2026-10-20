// Two daemon promises the desktop app relies on, over its own socket
// transport against the compiled daemon: a post retried with the same
// mutation id after a lost answer lands once, and a live stream left idle
// past Bun.serve's 10 s idle timeout stays connected.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createApi, HttpError, newMutationId, type RequestSender, TransportError } from "../../../src/api.ts";
import type { ConnectionState, LiveEvent, PostUpdateResult } from "../../../src/contracts.ts";
import { socketSender, socketStreamFetch } from "../../../src/desktop/socketFetch.ts";
import type { Task, Update } from "../../../src/store.ts";
import { subscribeChanges } from "../../../src/subscription.ts";
import { reap, startForeground, waitFor } from "../fixtures/daemon.ts";
import { mkTmpEnv, runCli } from "../helpers.ts";

setDefaultTimeout(60_000);

const box = mkTmpEnv("desk-stream");
const events: LiveEvent[] = [];
const states: ConnectionState[] = [];
const stop = new AbortController();
let socketPath = "";
let following: Promise<void> = Promise.resolve();

const readies = (): number => events.filter(e => e.kind === "ready").length;

async function cli(args: string[]): Promise<string> {
  const r = await runCli({ args, env: box.env });
  if (r.code !== 0) throw new Error(`cortex ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

describe("the desktop transport against a real daemon", () => {
  beforeAll(async () => {
    const daemon = await startForeground(box.env);
    const endpoint = daemon.identity.endpoint;
    if (endpoint.kind !== "unix" || !endpoint.socketPath) throw new Error("expected a unix endpoint");
    socketPath = endpoint.socketPath;
    following = subscribeChanges(
      { kind: "unix", socketPath },
      e => events.push(e),
      s => states.push(s),
      stop.signal,
      { fetch: socketStreamFetch },
    );
    await waitFor("the first ready", () => (readies() > 0 ? true : null));
  });

  afterAll(async () => {
    stop.abort();
    await following.catch(() => {});
    await runCli({ args: ["stop"], env: box.env });
    await reap();
    box.cleanup();
  });

  test("a post retried with the same mutation id after a lost answer lands once", async () => {
    const task = JSON.parse(await cli(["add", "retried post", "--json"])) as Task;
    const real = socketSender(socketPath);
    let dropped = false;
    // The daemon applies the first post, but its answer never reaches the client.
    const lossy: RequestSender = async (path, init) => {
      const res = await real(path, init);
      if (!dropped && init?.method === "POST" && path.endsWith("/updates")) {
        dropped = true;
        await res.text();
        throw new Error("connection reset");
      }
      return res;
    };
    const api = createApi(lossy);
    const input = { summary: "posted once", author: "pi-retry" };
    const guard = { mutationId: newMutationId() };

    const lost = await api.versioned.postUpdate(task.id, input, guard).catch((err: unknown) => err);
    expect(lost).toBeInstanceOf(TransportError);
    expect((lost as TransportError).uncertain).toBe(true);

    const retried: PostUpdateResult = await api.versioned.postUpdate(task.id, input, guard);
    expect(retried.replayed).toBe(true);

    const reused = await api.versioned
      .postUpdate(task.id, { ...input, summary: "a different post" }, guard)
      .catch((err: unknown) => err);
    expect(reused).toBeInstanceOf(HttpError);
    expect((reused as HttpError).status).toBe(409);
    expect((reused as HttpError).code).toBe("mutation_reused");

    const shown = JSON.parse(await cli(["show", String(task.id), "--json"])) as { updates: Update[] };
    expect(shown.updates.filter(u => u.summary === "posted once")).toHaveLength(1);
    const posted = (): LiveEvent[] =>
      events.filter(e => e.kind === "update.posted" && (e.payload as Update).summary === "posted once");
    await waitFor("the posted event", () => (posted().length > 0 ? true : null));
    expect(posted()).toHaveLength(1);
  });

  test("an idle stream outlives Bun.serve's 10 s idle timeout without reconnecting", async () => {
    const readyBefore = readies();
    const statesBefore = states.length;
    await Bun.sleep(14_000);
    expect(readies()).toBe(readyBefore);
    expect(states).toHaveLength(statesBefore);
    expect(states.at(-1)).toBe("live");

    const eventsBefore = events.length;
    await cli(["add", "after the idle window", "--json"]);
    await waitFor("an event after the idle window", () => (events.length > eventsBefore ? true : null));
  });
});
