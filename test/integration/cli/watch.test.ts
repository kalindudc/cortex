import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { BIN, ROOT, mkTmpEnv, runCli } from "../helpers.ts";
import {
  type ForegroundDaemon,
  type Running,
  reap,
  socketHealth,
  spawnInteractive,
  startForeground,
  waitFor,
} from "../fixtures/daemon.ts";

// `cortex watch` over the real daemon socket: a short ready marker on each
// connection, every change as one JSON line, and a clean exit (daemon left
// running) on SIGINT, SIGTERM or a closed stdout. Every process is tracked:
// each test starts its own daemon, because reap() after a test also stops the
// daemon, and a watch with none running would start an untracked one.

const AUTHOR = "watcher-1c0ed4a8";
const CURSOR = /^[A-Za-z0-9._-]+:\d+$/;

let env: Record<string, string>;
let cleanup: () => void;
let daemon: ForegroundDaemon;

type Line = { kind: string; cursor?: string; payload?: Record<string, unknown> };

const lines = (w: Running): Line[] =>
  w
    .stdout()
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as Line);
const readyCount = (w: Running) => lines(w).filter(l => l.kind === "ready").length;

async function post(message: string): Promise<void> {
  const r = await runCli({ args: ["update", "1", "-m", message, "--as", AUTHOR], env });
  expect(r.code).toBe(0);
}

beforeAll(async () => {
  const tmp = mkTmpEnv("watch");
  env = tmp.env;
  cleanup = tmp.cleanup;
  expect((await runCli({ args: ["init"], env })).code).toBe(0);
  expect((await runCli({ args: ["add", "watched task"], env })).code).toBe(0);
});

beforeEach(async () => {
  daemon = await startForeground(env);
});
afterEach(() => reap());
afterAll(async () => {
  await reap();
  // Every daemon was tracked and reaped, so none may still serve this database.
  const left = await runCli({ args: ["stop"], env });
  cleanup();
  expect(left.stdout.trim()).toBe("not running");
});

describe("cortex watch", () => {
  test("ready marker, change lines, a ready marker after reconnect, and SIGINT exits 0", async () => {
    const w = spawnInteractive(["watch", "--json"], env);
    await waitFor("the ready marker", () => readyCount(w) === 1 || null);
    expect(lines(w)[0]).toEqual({ kind: "ready" });

    await post("first");
    const posted = await waitFor("update.posted", () => lines(w).find(l => l.kind === "update.posted"));
    expect(Object.keys(posted).sort()).toEqual(["cursor", "kind", "payload"]);
    expect(posted.cursor).toMatch(CURSOR);
    expect(posted.payload).toMatchObject({ task_id: 1, author: AUTHOR, summary: "first" });

    // Restart this database's daemon: the same socket comes back and watch reconnects.
    daemon.proc.kill("SIGTERM");
    await daemon.proc.exited;
    daemon = await startForeground(env);
    await waitFor("the reconnect marker", () => readyCount(w) === 2 || null, 15_000);
    await post("second");
    await waitFor("the second update", () =>
      lines(w).find(l => l.kind === "update.posted" && l.payload?.summary === "second"),
    );

    w.proc.kill("SIGINT");
    expect(await w.proc.exited).toBe(0);
    expect(w.stderr()).toBe("");
    expect((await socketHealth(daemon.identity)).ok).toBe(true);
  });

  test("SIGTERM exits 0 and leaves the daemon running; human output is one short line per event", async () => {
    const w = spawnInteractive(["watch"], env);
    await waitFor("the ready line", () => w.stdout().includes("ready (refetch state)\n") || null);
    await post("human");
    await waitFor("the update line", () => w.stdout().includes(`update.posted @1 [${AUTHOR}] human\n`) || null);
    w.proc.kill("SIGTERM");
    expect(await w.proc.exited).toBe(0);
    expect(w.stderr()).toBe("");
    expect((await socketHealth(daemon.identity)).ok).toBe(true);
  });

  test("a closed stdout ends watch with exit 0", async () => {
    const proc = Bun.spawn([BIN, "watch", "--json"], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe('{"kind":"ready"}\n');
      await reader.cancel();
      // The next event line hits the closed pipe.
      await post("into a closed pipe");
      const code = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "still running")]);
      expect(code).toBe(0);
      expect(await new Response(proc.stderr).text()).toBe("");
      expect((await socketHealth(daemon.identity)).ok).toBe(true);
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await proc.exited;
    }
  });
});
