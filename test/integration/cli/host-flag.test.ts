import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { mkTmpEnv } from "../helpers.ts";
import { isRunning, readIdentity, reap, runBounded, socketHealth, startForeground } from "../fixtures/daemon.ts";
import { CONTROL_PATHS, INSTANCE_HEADER } from "../../../src/api.ts";
import type { DaemonIdentity } from "../../../src/contracts.ts";

// ---------- CLI integration: `cortex serve --host`, the dashboard listener and --no-web ----------
//
// Scope (plan @400 Task 6, N4/N5/N11):
//   1. `cortex serve --host <name>` publishes the FRIENDLY dashboard URL as
//      the metadata's `webUrl` and prints it, while the listener itself
//      binds the LOOPBACK address (127.0.0.1) — the printed-host versus
//      loopback distinction the old cortex.browser-url/cortex.url pair held.
//   2. validateHost in src/commands/serve.ts rejects empty / malformed
//      values BEFORE anything starts.
//   3. `--no-web` serves only the private socket; the IPC-only enable-web
//      control route then starts the dashboard on the SAME instance, and the
//      loopback app never exposes control routes, whatever headers say.
//
// The daemon is spawned directly (`serve --foreground`), so its pid is ours
// to signal; see ../fixtures/daemon.ts.

const REAL_PID = path.join(os.homedir(), ".config", "cortex", "cortex.pid");
const REAL_URL = path.join(os.homedir(), ".config", "cortex", "cortex.url");
const REAL_BROWSER_URL = path.join(os.homedir(), ".config", "cortex", "cortex.browser-url");

type Snap = { mtimeMs: number; size: number } | null;
function snap(p: string): Snap {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}
function snapEq(a: Snap, b: Snap): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

let realPidBefore: Snap = null;
let realUrlBefore: Snap = null;
let realBrowserUrlBefore: Snap = null;
const sandboxes: (() => void)[] = [];

beforeAll(() => {
  realPidBefore = snap(REAL_PID);
  realUrlBefore = snap(REAL_URL);
  realBrowserUrlBefore = snap(REAL_BROWSER_URL);
});

afterEach(async () => {
  await reap();
});

afterAll(async () => {
  await reap();
  for (const cleanup of sandboxes.splice(0)) cleanup();
});

function sandbox(label: string): ReturnType<typeof mkTmpEnv> {
  const env = mkTmpEnv(label);
  sandboxes.push(env.cleanup);
  return env;
}

function portOf(url: string | undefined): string {
  const port = new URL(url ?? "http://invalid").port;
  expect(port).toMatch(/^\d+$/);
  return port;
}

async function control(identity: DaemonIdentity, route: string, body?: unknown, bound = true): Promise<Response> {
  if (identity.endpoint.kind !== "unix") throw new Error("expected a unix endpoint");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bound) headers[INSTANCE_HEADER] = identity.instanceId;
  return fetch(`http://localhost${route}`, {
    method: "POST",
    unix: identity.endpoint.socketPath,
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

describe("cortex serve --host", () => {
  test("publishes and prints the friendly URL while the listener binds 127.0.0.1", async () => {
    const { tmpDir, env } = sandbox("host-flag-friendly");
    const daemon = await startForeground(env, ["--port", "0", "--host", "cortex.example"]);
    const port = portOf(daemon.identity.webUrl);
    expect(daemon.identity.webUrl).toBe(`http://cortex.example:${port}`);
    expect(daemon.stdout()).toContain(`cortex listening on http://cortex.example:${port}`);
    // The CLI-facing side is the loopback address, on the same port.
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { identity: unknown };
    expect(health.identity).toEqual(daemon.identity);
    // No old-style cortex.{pid,url,browser-url} files any more.
    for (const f of ["cortex.pid", "cortex.url", "cortex.browser-url"]) {
      expect(fs.existsSync(path.join(tmpDir, "cortex", f))).toBe(false);
    }

    daemon.proc.kill("SIGTERM");
    expect([0, 143]).toContain(await daemon.proc.exited);
    expect(fs.existsSync(daemon.metadataFile)).toBe(false);
  }, 30_000);

  test("default --host is cortex.localhost (metadata and stdout)", async () => {
    const { env } = sandbox("host-flag-default");
    const daemon = await startForeground(env, ["--port", "0", "--host", "cortex.localhost"]);
    const port = portOf(daemon.identity.webUrl);
    expect(daemon.identity.webUrl).toBe(`http://cortex.localhost:${port}`);
    expect(daemon.stdout()).toContain(`http://cortex.localhost:${port}`);
    daemon.proc.kill("SIGTERM");
    await daemon.proc.exited;
  }, 30_000);

  for (const [name, host] of [
    ["empty", ""],
    ["malformed (contains a space)", "bad host"],
    ["a scheme prefix", "http://cortex.localhost"],
  ] as const) {
    test(`rejects ${name} --host with a non-zero exit and the validateHost error`, async () => {
      const { env } = sandbox("host-flag-bad");
      const r = await runBounded(["serve", "--port", "0", "--no-open", "--host", host], env);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("error: --host must be a valid hostname");
      expect(readIdentity(`${env.CORTEX_DB}.daemon.json`)).toBeNull();
    });
  }
});

describe("cortex serve --no-web and the IPC-only control routes", () => {
  test("enable-web starts the dashboard on the same instance; the loopback app has no control routes", async () => {
    const { env } = sandbox("host-flag-noweb");
    const daemon = await startForeground(env, ["--no-web"]);
    const { identity } = daemon;
    expect(identity.webUrl).toBeUndefined();
    const socketPath = identity.endpoint.kind === "unix" ? identity.endpoint.socketPath : "";
    expect(daemon.stdout()).toContain(`cortex listening on ${socketPath}`);

    expect((await control(identity, CONTROL_PATHS.web, { port: 0 }, false)).status).toBe(400);
    const enabled = await control(identity, CONTROL_PATHS.web, { port: 0, host: "cortex.example" });
    expect(enabled.status).toBe(200);
    const updated = ((await enabled.json()) as { identity: DaemonIdentity }).identity;
    expect(updated.instanceId).toBe(identity.instanceId);
    const port = portOf(updated.webUrl);
    expect(updated.webUrl).toBe(`http://cortex.example:${port}`);
    // Republished atomically with the dashboard, and idempotent.
    expect(readIdentity(daemon.metadataFile)?.webUrl).toBe(updated.webUrl);
    const repeat = await control(identity, CONTROL_PATHS.web, { port: 0 });
    expect(((await repeat.json()) as { identity: DaemonIdentity }).identity.webUrl).toBe(updated.webUrl);

    // The loopback listener serves the API but never control, whatever the headers claim.
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
    const spoofed = await fetch(`http://127.0.0.1:${port}${CONTROL_PATHS.shutdown}`, {
      method: "POST",
      headers: { [INSTANCE_HEADER]: identity.instanceId, "x-cortex-listener": "ipc", forwarded: "for=unix" },
    });
    expect(spoofed.status).toBe(404);
    await Bun.sleep(100);
    expect(isRunning(daemon)).toBe(true);
    expect((await socketHealth(identity)).identity?.instanceId).toBe(identity.instanceId);

    daemon.proc.kill("SIGTERM");
    expect([0, 143]).toContain(await daemon.proc.exited);
    expect(fs.existsSync(daemon.metadataFile)).toBe(false);
  }, 30_000);
});

// The hermetic-guard tests run last (Bun executes tests in file order
// within a describe block). Same belt-and-suspenders pattern as
// serve-stop.test.ts: capture snapshots in beforeAll, fail loud if
// any test path leaked into ~/.config/cortex/.
describe("hermetic guards", () => {
  test("hermetic guard: ~/.config/cortex/cortex.pid mtime+size unchanged", () => {
    expect(snapEq(snap(REAL_PID), realPidBefore)).toBe(true);
  });

  test("hermetic guard: ~/.config/cortex/cortex.url mtime+size unchanged", () => {
    expect(snapEq(snap(REAL_URL), realUrlBefore)).toBe(true);
  });

  test("hermetic guard: ~/.config/cortex/cortex.browser-url mtime+size unchanged", () => {
    expect(snapEq(snap(REAL_BROWSER_URL), realBrowserUrlBefore)).toBe(true);
  });
});
