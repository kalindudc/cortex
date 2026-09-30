import { test, expect, describe, afterAll, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Task } from "../../../src/store.ts";
import { Store } from "../../../src/store.ts";
import { canonicalDatabasePath } from "../../../src/ownership.ts";
import { ownerLockPath } from "../../../src/paths.ts";
import { mkTmpEnv, ROOT } from "../helpers.ts";
import {
  isRunning,
  leaseIsFree,
  metadataFileFor,
  reap,
  runBounded,
  spawnForeignCortexServe,
  spawnInteractive,
  startForeground,
  waitFor,
} from "../fixtures/daemon.ts";

// ---------- CLI integration: every normal command goes through withClient ----------
//
// Plan @400 Task 6 (N4-N6, gates G1/G2), against the COMPILED binary:
//   - no daemon: a command owns the database (the ownership lease) only for
//     its own database work, serving itself through the daemon's handlers
//     in-process; it never publishes a daemon or leaves a socket behind;
//   - a transient owner (another offline command) is waited for, not failed;
//   - a verified daemon: commands send their requests to it, so its SSE
//     subscribers see CLI writes;
//   - a healthy legacy (pre-identity) daemon blocks commands with a restart
//     instruction even though the new lock is free;
//   - `doctor` reports without starting a daemon or taking the lease;
//   - prompts and launched programs (pi, fzf) never run inside a lease;
//   - `reset` stops exactly this database's daemon and keeps the lock file.
//
// SAFETY: every process signalled here was spawned by this file (tracked by
// ../fixtures/daemon.ts); each test runs in its own mkTmpEnv() sandbox.

const HOLDER = path.join(ROOT, "test", "integration", "fixtures", "ownership-holder.ts");
const PI_AUTHOR_A = "pi-01923f3a-9201-7c0e-b1c8-abcdef012345";
const PI_AUTHOR_B = "pi-01abcdef-1234-7567-89ab-cdef01234567";

const sandboxes: (() => void)[] = [];

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

async function ok(env: Record<string, string>, ...args: string[]): Promise<string> {
  const r = await runBounded(args, env);
  expect(r.code, `cortex ${args.join(" ")}: ${r.stderr}`).toBe(0);
  return r.stdout;
}

function taskTitles(db: string): string[] {
  return Store.readSnapshot(db, s => s.listTasks({}).map(t => t.title));
}

/** Hold the database lease in a separate process until `release()`. */
async function holdLease(env: Record<string, string>, db: string): Promise<{ release(): void; done: Promise<number> }> {
  const holder = Bun.spawn([process.execPath, HOLDER, "hold", db], {
    env,
    cwd: ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = holder.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(first.value)).toContain("OWNED");
  sandboxes.push(() => {
    if (holder.exitCode === null) holder.kill("SIGKILL");
  });
  return { release: () => void holder.stdin.end(), done: holder.exited };
}

type Frame = { event: string; data: string };

/**
 * Subscribe to a daemon's /events over its private socket; frames
 * accumulate as they arrive. Closed by cancelling the reader.
 */
async function subscribe(socketPath: string): Promise<{ frames: Frame[]; close(): void }> {
  const res = await fetch("http://localhost/events", { unix: socketPath });
  const body = res.body;
  if (body === null) throw new Error("no event stream");
  const frames: Frame[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame: Frame = { event: "message", data: "" };
          for (const line of buffer.slice(0, end).split("\n")) {
            if (line.startsWith("event:")) frame.event = line.slice(6).trim();
            else if (line.startsWith("data:")) frame.data += line.slice(5).trim();
          }
          buffer = buffer.slice(end + 2);
          frames.push(frame);
        }
      }
    } catch {
      /* cancelled by close() */
    }
  })();
  return { frames, close: () => void reader.cancel().catch(() => {}) };
}

/**
 * A PATH directory whose `pi` and `fzf` are shims that record whether the
 * database lease was free while they ran (probe.ts, in bun), then behave:
 * pi exits 0, fzf prints the first line it was given (a selection).
 */
function programShims(env: Record<string, string>, tmpDir: string): { env: Record<string, string>; log: string } {
  const dir = path.join(tmpDir, "shims");
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(tmpDir, "probe.log");
  const probe = path.join(tmpDir, "probe.ts");
  fs.writeFileSync(
    probe,
    [
      `import fs from "node:fs";`,
      `import { tryAcquireOwnership } from ${JSON.stringify(path.join(ROOT, "src", "ownership.ts"))};`,
      `const [label, ...rest] = process.argv.slice(2);`,
      `const lease = tryAcquireOwnership(process.env.CORTEX_DB ?? "");`,
      `const line = [label, lease ? "free" : "held", ...rest].join(" ");`,
      `fs.appendFileSync(process.env.CORTEX_TEST_PROBE_LOG ?? "", line + "\\n");`,
      `lease?.release();`,
    ].join("\n"),
  );
  const shim = (name: string, body: string): void => {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  shim("pi", `exec "$CORTEX_TEST_BUN" "$CORTEX_TEST_PROBE" pi "$@"`);
  shim(
    "fzf",
    [
      `first=""`,
      // The last line arrives without a newline: still read it.
      `while IFS= read -r line || [ -n "$line" ]; do if [ -z "$first" ]; then first="$line"; fi; done`,
      `"$CORTEX_TEST_BUN" "$CORTEX_TEST_PROBE" fzf`,
      `printf '%s\\n' "$first"`,
    ].join("\n"),
  );
  return {
    env: {
      ...env,
      PATH: dir,
      CORTEX_TEST_BUN: process.execPath,
      CORTEX_TEST_PROBE: probe,
      CORTEX_TEST_PROBE_LOG: log,
    },
    log,
  };
}

function probeLines(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
}

describe("offline: commands own the database only for their own work", () => {
  test("a command takes the lease (its lock file appears), publishes nothing, and releases it", async () => {
    const { env, runtimeDir } = sandbox("route-offline");
    const db = env.CORTEX_DB ?? "";
    await ok(env, "init");
    const created = JSON.parse(await ok(env, "add", "offline task", "--json")) as Task;
    expect(created.title).toBe("offline task");
    expect(fs.existsSync(ownerLockPath(canonicalDatabasePath(db)))).toBe(true);
    expect(leaseIsFree(db)).toBe(true);
    expect(fs.existsSync(metadataFileFor(db))).toBe(false);
    expect(fs.readdirSync(runtimeDir)).toEqual([]);
    expect(taskTitles(db)).toEqual(["offline task"]);
  }, 30_000);

  test("a transient owner is waited for: writes and reads land once it lets go", async () => {
    const { env } = sandbox("route-transient");
    const db = env.CORTEX_DB ?? "";
    await ok(env, "init");
    const holder = await holdLease(env, db);
    setTimeout(() => holder.release(), 700);
    const startedAt = Date.now();
    const [add, ls] = await Promise.all([
      runBounded(["add", "after the wait", "--json"], env),
      runBounded(["ls", "--json"], env),
    ]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600);
    expect(await holder.done).toBe(0);
    expect(add.code, add.stderr).toBe(0);
    expect(ls.code, ls.stderr).toBe(0);
    expect(taskTitles(db)).toEqual(["after the wait"]);
  }, 30_000);

  test("concurrent offline commands retry the lease instead of failing, and every write lands", async () => {
    const { env } = sandbox("route-concurrent");
    const db = env.CORTEX_DB ?? "";
    await ok(env, "init");
    const holder = await holdLease(env, db);
    setTimeout(() => holder.release(), 500);
    const startedAt = Date.now();
    const runs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => runBounded(["add", `concurrent ${i}`, "--json"], env)),
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    for (const r of runs) expect(r.code, r.stderr).toBe(0);
    const ids = runs.map(r => (JSON.parse(r.stdout) as Task).id);
    expect(new Set(ids).size).toBe(6);
    expect(taskTitles(db).sort()).toEqual(Array.from({ length: 6 }, (_, i) => `concurrent ${i}`).sort());
    expect(leaseIsFree(db)).toBe(true);
  }, 30_000);
});

describe("a verified daemon serves every command", () => {
  test("CLI writes go through the daemon, so its SSE subscribers see them; reads work beside it", async () => {
    const { env } = sandbox("route-daemon");
    const db = env.CORTEX_DB ?? "";
    const daemon = await startForeground(env);
    const { endpoint } = daemon.identity;
    if (endpoint.kind !== "unix") throw new Error("expected a unix endpoint");
    const stream = await subscribe(endpoint.socketPath);
    try {
      await waitFor("the stream to be ready", () => (stream.frames.some(f => f.event === "ready") ? true : null));

      const created = JSON.parse(await ok(env, "add", "via the daemon", "-t", "cli", "--json")) as Task;
      await ok(env, "update", String(created.id), "-m", "stuck on review", "-s", "blocked", "--as", "agent-1");

      const added = await waitFor("task.added", () => stream.frames.find(f => f.event === "task.added"));
      expect((JSON.parse(added.data) as Task).title).toBe("via the daemon");
      const posted = await waitFor("update.posted", () => stream.frames.find(f => f.event === "update.posted"));
      expect(JSON.parse(posted.data)).toMatchObject({ summary: "stuck on review", author: "agent-1" });
      await waitFor("task.blocked", () => stream.frames.find(f => f.event === "task.blocked"));

      // Reads are served by the daemon too, while it keeps the lease.
      const listed = JSON.parse(await ok(env, "ls", "--json")) as Task[];
      expect(listed.map(t => t.title)).toEqual(["via the daemon"]);
      const shown = JSON.parse(await ok(env, "show", String(created.id), "--json")) as { task: Task };
      expect(shown.task.status).toBe("blocked");
      expect(leaseIsFree(db)).toBe(false);
      expect(isRunning(daemon)).toBe(true);
    } finally {
      stream.close();
    }
  }, 30_000);

  test("a healthy legacy daemon blocks commands with a restart instruction; its pid is never signalled", async () => {
    const { tmpDir, env } = sandbox("route-legacy");
    const db = env.CORTEX_DB ?? "";
    await ok(env, "init");
    await ok(env, "add", "before the legacy daemon");
    const foreign = spawnForeignCortexServe();
    const legacy = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      // An old binary's daemon: answers everything, never with an identity.
      fetch: () => Response.json({ ok: true, version: "0.1.0" }),
    });
    try {
      fs.writeFileSync(path.join(tmpDir, "cortex", "cortex.pid"), String(foreign.proc.pid));
      fs.writeFileSync(path.join(tmpDir, "cortex", "cortex.url"), `http://127.0.0.1:${legacy.port}`);
      expect(leaseIsFree(db)).toBe(true);

      for (const args of [["add", "must not land"], ["ls"]]) {
        const r = await runBounded(args, env);
        expect(r.code, args.join(" ")).toBe(1);
        expect(r.stderr).toContain("older cortex binary");
        expect(r.stderr).toMatch(/stop it first/);
      }
      const asJson = await runBounded(["add", "must not land", "--json"], env);
      expect(asJson.code).toBe(1);
      expect((JSON.parse(asJson.stdout) as { error: { message: string } }).error.message).toContain(
        "older cortex binary",
      );
      expect(taskTitles(db)).toEqual(["before the legacy daemon"]);
      expect(leaseIsFree(db)).toBe(true);
      expect(isRunning(foreign)).toBe(true);
    } finally {
      await legacy.stop(true);
    }
  }, 30_000);
});

describe("doctor reports; it never starts a daemon or takes the lease", () => {
  test("missing database, offline database and live daemon", async () => {
    const { env, runtimeDir } = sandbox("route-doctor");
    const db = env.CORTEX_DB ?? "";

    // Nothing exists yet: reported, not created.
    let r = await runBounded(["doctor", "--json"], env);
    expect(r.code, r.stderr).toBe(0);
    let report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ initialized: false });
    expect(report.daemon).toEqual({ running: false });
    expect(report.counts).toEqual({ tasks: 0, lanes: 0, tags: 0 });
    expect(fs.existsSync(db)).toBe(false);
    expect(fs.existsSync(`${db}.owner.lock`)).toBe(false);
    expect(fs.readdirSync(runtimeDir)).toEqual([]);

    await ok(env, "init");
    await ok(env, "add", "counted", "-t", "x");
    r = await runBounded(["doctor", "--json"], env);
    report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ initialized: true, pendingMigrations: [] });
    expect(report.daemon).toEqual({ running: false });
    expect(report.counts).toEqual({ tasks: 1, lanes: 1, tags: 1 });
    expect(fs.existsSync(metadataFileFor(db))).toBe(false);
    expect(fs.readdirSync(runtimeDir)).toEqual([]);

    const daemon = await startForeground(env);
    const startedAt = Date.now();
    r = await runBounded(["doctor", "--json"], env);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    report = JSON.parse(r.stdout);
    const socket = daemon.identity.endpoint.kind === "unix" ? daemon.identity.endpoint.socketPath : "";
    expect(report.daemon).toEqual({ running: true, pid: daemon.proc.pid, socket });
    expect(report.counts).toEqual({ tasks: 1, lanes: 1, tags: 1 });
    const human = await ok(env, "doctor");
    expect(human).toContain(`running (pid ${daemon.proc.pid}, ${socket})`);
    expect(leaseIsFree(db)).toBe(false);
    expect(isRunning(daemon)).toBe(true);
  }, 30_000);
});

describe("prompts and launched programs never run inside a lease", () => {
  test("rm waits at its confirmation without the lease, then deletes", async () => {
    const { env } = sandbox("route-rm-prompt");
    const db = env.CORTEX_DB ?? "";
    await ok(env, "init");
    await ok(env, "add", "doomed");
    const rm = spawnInteractive(["rm", "1"], env);
    await waitFor("the rm prompt", () => (rm.stdout().includes("[y/N]") ? true : null));
    expect(leaseIsFree(db)).toBe(true);
    rm.input("y\n");
    expect(await rm.proc.exited).toBe(0);
    expect(rm.stdout()).toContain("✓ removed task 1");
    expect(taskTitles(db)).toEqual([]);
  }, 30_000);

  test("resume: the picker prompt and the launched pi both run without the lease", async () => {
    const { tmpDir, env: base } = sandbox("route-resume");
    const db = base.CORTEX_DB ?? "";
    await ok(base, "init");
    await ok(base, "add", "resumable");
    await ok(base, "update", "1", "--as", PI_AUTHOR_A, "-m", "first session");
    await ok(base, "update", "1", "--as", PI_AUTHOR_B, "-m", "second session");
    const shims = programShims(base, tmpDir);
    // No fzf on PATH for this run: the readline picker asks on stderr.
    const env = { ...shims.env, PATH: path.join(tmpDir, "no-fzf") };
    fs.mkdirSync(env.PATH, { recursive: true });
    fs.copyFileSync(path.join(tmpDir, "shims", "pi"), path.join(env.PATH, "pi"));
    fs.chmodSync(path.join(env.PATH, "pi"), 0o755);

    const resume = spawnInteractive(["resume", "1"], env);
    await waitFor("the resume picker", () => (resume.stderr().includes("select [1-2]") ? true : null));
    expect(leaseIsFree(db)).toBe(true);
    resume.input("1\n");
    expect(await resume.proc.exited).toBe(0);
    const lines = probeLines(shims.log);
    expect(lines).toHaveLength(1);
    // The newest session is listed first.
    expect(lines[0]).toBe(`pi free --session ${PI_AUTHOR_B.slice(3)}`);
  }, 30_000);

  test("search: fzf runs without the lease; the selection is re-read afterwards", async () => {
    const { tmpDir, env: base } = sandbox("route-search");
    await ok(base, "init");
    await ok(base, "add", "findable", "-b", "body text");
    const shims = programShims(base, tmpDir);
    const r = await runBounded(["search"], shims.env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("[1] findable");
    expect(r.stdout).toContain("body text");
    expect(probeLines(shims.log)).toEqual(["fzf free"]);
  }, 30_000);
});

describe("reset is database-scoped", () => {
  test("the confirmation runs without the lease", async () => {
    const { env } = sandbox("route-reset-prompt");
    const db = env.CORTEX_DB ?? "";
    await ok(env, "init");
    await ok(env, "add", "wiped");
    const reset = spawnInteractive(["reset"], env);
    await waitFor("the reset prompt", () => (reset.stdout().includes("Type RESET to confirm") ? true : null));
    expect(leaseIsFree(db)).toBe(true);
    reset.input("RESET\n");
    expect(await reset.proc.exited).toBe(0);
    expect(reset.stdout()).toContain("✓ reset complete");
    expect(taskTitles(db)).toEqual([]);
  }, 30_000);

  test("reset stops exactly this database's daemon, keeps the owner lock file and reinitializes", async () => {
    const { env } = sandbox("route-reset-daemon");
    const db = env.CORTEX_DB ?? "";
    const foreign = spawnForeignCortexServe();
    await ok(env, "init");
    await ok(env, "add", "served then wiped");
    const lock = ownerLockPath(canonicalDatabasePath(db));
    const inode = fs.statSync(lock).ino;
    const daemon = await startForeground(env);

    const reset = spawnInteractive(["reset"], env);
    await waitFor("the reset prompt", () => (reset.stdout().includes("Type RESET to confirm") ? true : null));
    expect(reset.stdout()).toContain(`(pid ${daemon.proc.pid})`);
    reset.input("RESET\n");
    expect(await reset.proc.exited).toBe(0);
    expect(reset.stdout()).toContain("✓ stopped daemon");
    expect(reset.stdout()).toContain("✓ reset complete");
    expect([0, 143]).toContain(await daemon.proc.exited);
    expect(fs.existsSync(metadataFileFor(db))).toBe(false);
    expect(fs.statSync(lock).ino).toBe(inode);
    expect(taskTitles(db)).toEqual([]);
    expect(leaseIsFree(db)).toBe(true);
    expect(isRunning(foreign)).toBe(true);
  }, 30_000);
});
