// Daemon helpers for the lifecycle integration tests (plan @400 Task 6).
//
// Every process started here runs the compiled bin/cortex (or a harmless
// dummy) inside a mkTmpEnv() sandbox and is tracked, so a test can only ever
// signal processes it spawned: `reap()` SIGKILLs whatever is still running.
// Daemons started in the background by our own `cortex serve` are not our
// children; reap() stops them through their instance-bound shutdown route.

import fs from "node:fs";
import type { Subprocess } from "bun";
import { CONTROL_PATHS, INSTANCE_HEADER } from "../../../src/api.ts";
import type { DaemonIdentity } from "../../../src/contracts.ts";
import { canonicalDatabasePath, tryAcquireOwnership } from "../../../src/ownership.ts";
import { daemonMetadataPath } from "../../../src/paths.ts";
import { BIN, ROOT } from "../helpers.ts";

type Proc = Subprocess<"ignore" | "pipe", "pipe", "pipe">;

const spawned = new Set<Proc>();
const background: DaemonIdentity[] = [];

/** A running process plus everything it has written so far. */
export type Running = {
  proc: Proc;
  stdout(): string;
  stderr(): string;
  exited(): boolean;
};

function spawnTracked(argv: string[], env: Record<string, string>, stdin: "ignore" | "pipe" = "ignore"): Running {
  const proc: Proc = Bun.spawn(argv, { env, cwd: ROOT, stdio: [stdin, "pipe", "pipe"] });
  spawned.add(proc);
  let out = "";
  let err = "";
  const pump = async (stream: ReadableStream<Uint8Array>, sink: (s: string) => void): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      sink(decoder.decode(value, { stream: true }));
    }
  };
  void pump(proc.stdout, s => {
    out += s;
  });
  void pump(proc.stderr, s => {
    err += s;
  });
  return {
    proc,
    stdout: () => out,
    stderr: () => err,
    exited: () => proc.exitCode !== null || proc.signalCode !== null,
  };
}

export async function waitFor<T>(what: string, probe: () => T | null | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await Bun.sleep(25);
  }
}

export function metadataFileFor(databasePath: string): string {
  return daemonMetadataPath(canonicalDatabasePath(databasePath));
}

export function readIdentity(file: string): DaemonIdentity | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DaemonIdentity;
  } catch {
    return null;
  }
}

export function leaseIsFree(databasePath: string): boolean {
  const lease = tryAcquireOwnership(databasePath);
  lease?.release();
  return lease !== null;
}

/** GET /api/health over the daemon's private socket. */
export async function socketHealth(identity: DaemonIdentity): Promise<{ ok: boolean; identity?: DaemonIdentity }> {
  if (identity.endpoint.kind !== "unix") throw new Error("expected a unix endpoint");
  const res = await fetch("http://localhost/api/health", { unix: identity.endpoint.socketPath });
  return (await res.json()) as { ok: boolean; identity?: DaemonIdentity };
}

export type ForegroundDaemon = Running & { identity: DaemonIdentity; metadataFile: string };

/**
 * `cortex serve --foreground --no-open <args>` with `env`; resolves once it
 * printed its success line, which it does only after publishing metadata
 * that names its own pid.
 */
export async function startForeground(
  env: Record<string, string>,
  args: string[] = ["--port", "0"],
): Promise<ForegroundDaemon> {
  const running = spawnTracked([BIN, "serve", "--foreground", "--no-open", ...args], env);
  const metadataFile = metadataFileFor(env.CORTEX_DB ?? "");
  await waitFor(
    "the daemon's success line",
    () => {
      if (running.stdout().includes("cortex listening on")) return true;
      if (running.exited()) throw new Error(`daemon exited early: ${running.stderr()}`);
      return null;
    },
    15_000,
  );
  const identity = readIdentity(metadataFile);
  if (identity?.pid !== running.proc.pid) {
    throw new Error(`metadata does not name the daemon: ${JSON.stringify(identity)}`);
  }
  return { ...running, identity, metadataFile };
}

/** Run `bin/cortex <args>` to completion (SIGKILLed after `timeoutMs`, so a wrongly long-lived run fails fast). */
export async function runBounded(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const running = spawnTracked([BIN, ...args], env);
  const timer = setTimeout(() => running.proc.kill("SIGKILL"), timeoutMs);
  const code = await running.proc.exited;
  clearTimeout(timer);
  // Let the pumps drain the last chunks.
  await Bun.sleep(20);
  if (running.proc.signalCode === "SIGKILL") {
    throw new Error(`\`cortex ${args.join(" ")}\` did not exit within ${timeoutMs}ms: ${running.stderr()}`);
  }
  return { code, stdout: running.stdout(), stderr: running.stderr() };
}

/** A tracked `bin/cortex <args>` whose stdin the test writes later (to answer a prompt). */
export type Interactive = Running & { input(text: string): void; closeInput(): void };

export function spawnInteractive(args: string[], env: Record<string, string>): Interactive {
  const running = spawnTracked([BIN, ...args], env, "pipe");
  const stdin = running.proc.stdin;
  if (stdin === undefined || typeof stdin === "number") throw new Error("expected a piped stdin");
  return {
    ...running,
    input: text => {
      stdin.write(text);
      stdin.flush();
    },
    closeInput: () => {
      void stdin.end();
    },
  };
}

/**
 * Remember a background daemon (from its verified metadata) so reap() can
 * stop it if a test fails: through its instance-bound shutdown route, never
 * a signal (its pid may already belong to someone else by then).
 */
export function trackBackground(identity: DaemonIdentity): void {
  background.push(identity);
}

/** A harmless process whose argv contains "cortex serve", like the targets of the old host-wide stop. */
export function spawnForeignCortexServe(): Running {
  return spawnTracked([process.execPath, "-e", "setInterval(() => {}, 1e9)", "cortex", "serve"], {
    PATH: process.env.PATH ?? "",
  });
}

export function isRunning(running: Running): boolean {
  return !running.exited();
}

/** SIGKILL every process this module started that is still running. */
export async function reap(): Promise<void> {
  for (const proc of spawned) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await proc.exited;
  }
  spawned.clear();
  for (const identity of background.splice(0)) {
    if (identity.endpoint.kind !== "unix") continue;
    try {
      await fetch(`http://localhost${CONTROL_PATHS.shutdown}`, {
        method: "POST",
        unix: identity.endpoint.socketPath,
        headers: { [INSTANCE_HEADER]: identity.instanceId },
      });
    } catch {
      /* already gone: the normal case */
    }
  }
}
