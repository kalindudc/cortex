import { test, expect, describe, afterAll, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Subprocess } from "bun";
import { mkTmpEnv, ROOT } from "./helpers.ts";
import { canonicalDatabasePath, tryAcquireOwnership } from "../../src/ownership.ts";
import { ownerLockPath } from "../../src/paths.ts";

// Real multi-process database ownership (plan @400 N2/N3, gate G1).
//
// Each contender is a separate OS process running
// test/integration/fixtures/ownership-holder.ts (from source, and once as a
// compiled ESM-bytecode binary) against databases in a mkTmpEnv() sandbox.
// The test process itself also calls tryAcquireOwnership(): flock treats
// separate open(2) calls independently, so it contends like any process.
//
// SAFETY: the only processes ever signalled are ones this file spawned (the
// holders) and the `sleep` children a holder reports it spawned. Nothing here
// opens SQLite, starts a daemon, or looks up processes host-wide.

const HOLDER = path.join(ROOT, "test", "integration", "fixtures", "ownership-holder.ts");
const BUSY_EXIT = 3;

const sandbox = mkTmpEnv("ownership");
const base = fs.realpathSync(sandbox.tmpDir);
afterAll(() => sandbox.cleanup());

type Holder = Subprocess<"pipe", "pipe", "pipe">;
const running = new Set<Holder>();
const orphans = new Set<number>();

afterEach(async () => {
  for (const proc of running) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await proc.exited;
  }
  running.clear();
  for (const pid of orphans) killIfAlive(pid);
  orphans.clear();
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // existence probe only; delivers no signal
    return true;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number): void {
  if (isAlive(pid)) process.kill(pid, "SIGKILL");
}

function startHolder(
  mode: "try" | "hold" | "spawn",
  databasePath: string,
  command: string[] = [process.execPath, HOLDER],
): Holder {
  const proc = Bun.spawn([...command, mode, databasePath], {
    env: sandbox.env,
    cwd: base,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  running.add(proc);
  return proc;
}

/** Resolve with the holder's first stdout line (OWNED ... | BUSY), or fail with its stderr. */
async function firstLine(proc: Holder, timeoutMs = 15_000): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out waiting for holder output")), timeoutMs);
  });
  try {
    while (!text.includes("\n")) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* a read is still pending after a timeout; the timeout error wins */
    }
  }
  if (!text.includes("\n")) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`holder exited without a status line (code ${await proc.exited}): ${stderr}`);
  }
  return text.slice(0, text.indexOf("\n")).trim();
}

/** Run a one-shot `try` contender; resolve "OWNED" | "BUSY" after asserting its exit code. */
async function tryOnce(databasePath: string, command?: string[]): Promise<string> {
  const proc = startHolder("try", databasePath, command);
  const line = await firstLine(proc);
  const code = await proc.exited;
  expect(code).toBe(line === "BUSY" ? BUSY_EXIT : 0);
  return line;
}

async function stopHolder(proc: Holder): Promise<void> {
  proc.stdin.end();
  expect(await proc.exited).toBe(0);
}

function freeInProcess(databasePath: string): boolean {
  const lease = tryAcquireOwnership(databasePath);
  lease?.release();
  return lease !== null;
}

function scratch(name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("database ownership across processes (source)", () => {
  test("one owner per canonical database, through symlinked file and directory paths", async () => {
    const dir = scratch("aliases");
    const db = path.join(dir, "cortex.db");
    fs.writeFileSync(db, "");
    const fileLink = path.join(dir, "link.db");
    fs.symlinkSync(db, fileLink);
    const dirLink = path.join(base, "aliases-link");
    fs.symlinkSync(dir, dirLink);

    const holder = startHolder("hold", fileLink);
    expect(await firstLine(holder)).toBe("OWNED");
    for (const alias of [db, fileLink, path.join(dirLink, "cortex.db"), path.join(dirLink, "link.db")]) {
      expect(canonicalDatabasePath(alias)).toBe(db);
      expect(await tryOnce(alias)).toBe("BUSY");
      expect(freeInProcess(alias)).toBe(false);
    }
    await stopHolder(holder);
    expect(await tryOnce(path.join(dirLink, "cortex.db"))).toBe("OWNED");
  }, 60_000);

  test("a not-yet-created database is owned through its real parent, and acquisition never creates it", async () => {
    const dir = scratch("fresh");
    const dirLink = path.join(base, "fresh-link");
    fs.symlinkSync(dir, dirLink);
    const db = path.join(dir, "cortex.db");

    const holder = startHolder("hold", path.join(dirLink, "cortex.db"));
    expect(await firstLine(holder)).toBe("OWNED");
    expect(await tryOnce(db)).toBe("BUSY");
    expect(fs.existsSync(db)).toBe(false);
    expect(fs.existsSync(ownerLockPath(db))).toBe(true);
    await stopHolder(holder);
  }, 60_000);

  test("cold-start race: exactly one of several simultaneous processes owns a fresh database", async () => {
    const db = path.join(scratch("race"), "cortex.db");
    const contenders = Array.from({ length: 6 }, () => startHolder("hold", db));
    const lines = await Promise.all(contenders.map(proc => firstLine(proc)));
    expect(lines.filter(l => l === "OWNED").length).toBe(1);
    expect(lines.filter(l => l === "BUSY").length).toBe(contenders.length - 1);
    const owner = contenders[lines.indexOf("OWNED")];
    for (const proc of contenders) if (proc !== owner) expect(await proc.exited).toBe(BUSY_EXIT);
    expect(freeInProcess(db)).toBe(false);
    await stopHolder(owner);
    expect(freeInProcess(db)).toBe(true);
  }, 60_000);

  test("the OS releases ownership when the holder is SIGKILLed; the lock inode persists", async () => {
    const db = path.join(scratch("crash"), "cortex.db");
    const holder = startHolder("hold", db);
    expect(await firstLine(holder)).toBe("OWNED");
    const lock = ownerLockPath(db);
    const ino = fs.statSync(lock).ino;
    expect(freeInProcess(db)).toBe(false);
    expect(await tryOnce(db)).toBe("BUSY");

    holder.kill("SIGKILL");
    await holder.exited;
    expect(holder.signalCode).toBe("SIGKILL");

    expect(fs.statSync(lock).ino).toBe(ino);
    expect(await tryOnce(db)).toBe("OWNED");
    const lease = tryAcquireOwnership(db);
    expect(lease).not.toBeNull();
    lease?.release();
    expect(fs.statSync(lock).ino).toBe(ino);
  }, 60_000);

  test("children do not inherit the lease: after the holder dies, its live children do not keep it", async () => {
    const db = path.join(scratch("inherit"), "cortex.db");
    const holder = startHolder("spawn", db);
    const line = await firstLine(holder);
    const [status, ...pids] = line.split(" ");
    expect(status).toBe("OWNED");
    const childPids = pids.map(Number);
    expect(childPids.length).toBe(2);
    for (const pid of childPids) orphans.add(pid);
    expect(freeInProcess(db)).toBe(false);

    // Crash the holder WITHOUT release(): release() would LOCK_UN the shared
    // open file description and mask an inherited descriptor.
    holder.kill("SIGKILL");
    await holder.exited;
    for (const pid of childPids) expect(isAlive(pid)).toBe(true);

    expect(freeInProcess(db)).toBe(true);
    expect(await tryOnce(db)).toBe("OWNED");
    for (const pid of childPids) expect(isAlive(pid)).toBe(true);
  }, 60_000);

  test("different databases are independent, even in one directory", async () => {
    const dir = scratch("pair");
    const a = path.join(dir, "a.db");
    const b = path.join(dir, "b.db");
    const holder = startHolder("hold", a);
    expect(await firstLine(holder)).toBe("OWNED");
    expect(await tryOnce(b)).toBe("OWNED");
    expect(freeInProcess(b)).toBe(true);
    expect(await tryOnce(a)).toBe("BUSY");
    expect(ownerLockPath(a)).not.toBe(ownerLockPath(b));
    await stopHolder(holder);
  }, 60_000);
});

describe("database ownership from a compiled ESM-bytecode binary", () => {
  test("a compiled holder (lazy bun:ffi) excludes source contenders and releases on SIGKILL", async () => {
    const out = path.join(scratch("compiled"), "ownership-holder");
    const env: Record<string, string> = { ...sandbox.env };
    const build = Bun.spawnSync(
      [process.execPath, "build", HOLDER, "--compile", "--minify", "--bytecode", "--format=esm", "--outfile", out],
      { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" },
    );
    expect(build.exitCode, build.stderr.toString()).toBe(0);

    const db = path.join(scratch("compiled-db"), "cortex.db");
    const holder = startHolder("hold", db, [out]);
    expect(await firstLine(holder)).toBe("OWNED");
    expect(await tryOnce(db)).toBe("BUSY");
    expect(await tryOnce(db, [out])).toBe("BUSY");
    holder.kill("SIGKILL");
    await holder.exited;
    expect(await tryOnce(db, [out])).toBe("OWNED");
    expect(await tryOnce(db)).toBe("OWNED");
  }, 120_000);
});
