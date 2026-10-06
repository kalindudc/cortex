import { test, expect, describe, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { DaemonIdentity } from "../../src/contracts.ts";
import { BIN, mkTmpEnv, runCli } from "./helpers.ts";
import { metadataFileFor, readIdentity, waitFor } from "./fixtures/daemon.ts";
import { isCooked, type Pty, reapPtys, spawnPty } from "./fixtures/pty.ts";

// ---------- three terminal sessions and CLI writers on ONE daemon (plan @400 Task 11 part B, P8, G3) ----------
//
// ONE mkTmpEnv() sandbox for the whole file: three COMPILED `cortex tui`
// sessions in real PTYs (fixtures/pty.ts) share the headless daemon the
// first one starts, while the CLI (the same sandbox env) writes as a fourth
// client. The tests run in order and build on each other: independent
// fields/tasks from every writer, a stale same-field write, post dedupe,
// shared notification read state and blocked attention, a daemon stop and
// restart (then an idle window longer than Bun's 10 s idle timeout: no
// spurious reconnect), a stopped (slow) subscriber and closing one session. Every wait is
// bounded; afterAll quits the sessions and stops the sandbox's daemon with
// `cortex stop` in the SAME env (instance-bound: never another daemon). The
// only signals sent go to PTY children this file spawned.

setDefaultTimeout(60_000);

const PI_AUTHOR = "pi-0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const TAB = "\t";
const ESC = "\x1b";

const box = mkTmpEnv("tui-conc");
const tuiEnv: Record<string, string> = { ...box.env, TERM: "xterm-256color" };
const all: Pty[] = [];
let a: Pty;
let b: Pty;
let c: Pty;

type ShownTask = { title: string; body: string | null; status: string; priority: number | null };
type Shown = { task: ShownTask; updates: { author: string; summary: string }[] };

/** The output with terminal control sequences removed (each changed line is written whole). */
function plainText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b[_P^][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // APC (the cursor marker), DCS, PM
    .replace(/\x1b\[[0-9;?<>=:]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>78c]/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

/** Wait (bounded) until the plain text written at or after `from` matches; resolves with the output mark then. */
async function expectPlain(pty: Pty, needle: string | RegExp, from = 0, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = plainText(pty.output().slice(from));
    if (typeof needle === "string" ? text.includes(needle) : needle.test(text)) return pty.mark();
    if (!pty.running())
      throw new Error(`the TUI exited before ${String(needle)}; plain tail: ${JSON.stringify(text.slice(-600))}`);
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${String(needle)}; plain tail: ${JSON.stringify(text.slice(-600))}`);
    }
    await Bun.sleep(10);
  }
}

const since = (pty: Pty, from: number): string => plainText(pty.output().slice(from));

/** Type keys one input at a time (each is its own read in the TUI). */
async function keys(pty: Pty, ...inputs: string[]): Promise<void> {
  for (const input of inputs) {
    pty.write(input);
    await Bun.sleep(30);
  }
}

/** A `:` command line: the prompt, the text, then Enter. */
async function command(pty: Pty, line: string): Promise<void> {
  await keys(pty, ":", line, "\r");
}

/** Type one character every `everyMs` until `work` settles (keeps the draft's idle autosave from firing). */
async function typeWhile<T>(pty: Pty, char: string, work: Promise<T>, everyMs = 80): Promise<T> {
  let done = false;
  const result = work.finally(() => {
    done = true;
  });
  while (!done) {
    pty.write(char);
    await Bun.sleep(everyMs);
  }
  return result;
}

async function show(id: number): Promise<Shown> {
  const r = await runCli({ args: ["show", String(id), "--json"], env: box.env });
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Shown;
}

/** Poll the CLI (a second client of the same daemon) until task `id` satisfies `want`. */
async function waitForTask(id: number, want: (t: Shown) => boolean, timeoutMs = 15_000): Promise<Shown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const shown = await show(id);
    if (want(shown)) return shown;
    if (Date.now() >= deadline) throw new Error(`@${id} never matched; last: ${JSON.stringify(shown.task)}`);
    await Bun.sleep(100);
  }
}

async function cli(...args: string[]): Promise<void> {
  const r = await runCli({ args, env: box.env });
  expect(r.code, `cortex ${args.join(" ")}: ${r.stderr}`).toBe(0);
}

/** `cortex add --json <title>`: the new task's id. */
async function addTask(title: string): Promise<number> {
  const r = await runCli({ args: ["add", "--json", title], env: box.env });
  expect(r.code, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { id: number }).id;
}

function daemon(): DaemonIdentity {
  const identity = readIdentity(metadataFileFor(box.env.CORTEX_DB ?? ""));
  if (identity === null) throw new Error("no daemon metadata in the sandbox");
  return identity;
}

function open(): Pty {
  const pty = spawnPty([BIN, "tui"], { env: tuiEnv, cols: 110, rows: 32 });
  all.push(pty);
  return pty;
}

beforeAll(async () => {
  await cli("add", "alpha task");
  await cli("add", "beta task", "-b", "beta base");
  await cli("add", "gamma task");
  // The first session starts the sandbox's headless daemon; the others attach to it.
  a = open();
  await expectPlain(a, "● live", 0, 20_000);
  b = open();
  c = open();
  await expectPlain(b, "● live", 0, 20_000);
  await expectPlain(c, "● live", 0, 20_000);
});

afterAll(async () => {
  for (const pty of all) {
    if (!pty.running()) continue;
    pty.proc.kill("SIGCONT"); // in case a failure left one stopped
    pty.write(`${ESC}${ESC}`);
    await Bun.sleep(50);
    pty.write(":q!\r");
    await Promise.race([pty.proc.exited, Bun.sleep(5000)]);
  }
  await reapPtys();
  // Instance-bound: stops only this sandbox's daemon (whichever instance runs now).
  const stopped = await runCli({ args: ["stop"], env: box.env });
  box.cleanup();
  expect(stopped.code, stopped.stderr).toBe(0);
});

describe("three TUI sessions and CLI writers on one daemon", () => {
  test("every session attaches to the one sandbox daemon and shows the same workspace", async () => {
    expect(daemon().pid).toBeGreaterThan(0);
    for (const pty of [a, b, c]) {
      await expectPlain(pty, "alpha task");
      await expectPlain(pty, "beta task");
      await expectPlain(pty, "gamma task");
    }
    // A CLI write reaches every session live.
    const marks = [a, b, c].map(p => p.mark());
    await cli("add", "delta task");
    await Promise.all([a, b, c].map((p, i) => expectPlain(p, "delta task", marks[i])));
  });

  test("independent fields and tasks written at once by three sessions and the CLI all land, with no conflict", async () => {
    const marks = [a, b, c].map(p => p.mark());
    await Promise.all([
      command(a, "1").then(() => command(a, "title alpha renamed by A")),
      command(b, "1").then(() => command(b, "priority 2")),
      command(c, "3").then(() => command(c, "status review")),
      cli("edit", "3", "-b", "gamma body from the cli"),
    ]);
    await waitForTask(1, s => s.task.title === "alpha renamed by A" && s.task.priority === 2);
    await waitForTask(3, s => s.task.status === "review" && s.task.body === "gamma body from the cli");
    await Promise.all([a, b, c].map((p, i) => expectPlain(p, "alpha renamed by A", marks[i])));
    for (const [i, p] of [a, b, c].entries()) expect(since(p, marks[i] ?? 0)).not.toMatch(/onflict|error:/);
  });

  test("a stale same-field write is rejected: one session sees the conflict and the other's text is kept", async () => {
    for (const pty of [a, b]) {
      const mark = pty.mark();
      await command(pty, "2");
      await command(pty, "edit");
      await keys(pty, TAB);
      await expectPlain(pty, "1 beta base", mark);
    }
    await keys(a, "i");
    await keys(b, "i");
    const markB = b.mark();
    // B keeps typing (a dirty draft on the old version) while A writes the same body.
    await typeWhile(
      b,
      "z",
      (async () => {
        await keys(a, ..."from A ");
        return await waitForTask(2, s => s.task.body?.startsWith("from A ") === true);
      })(),
    );
    await expectPlain(b, "conflict", markB);
    await Bun.sleep(1000);
    let body = (await show(2)).task.body ?? "";
    expect(body).toBe("from A beta base"); // B's stale write never replaced A's text
    // B takes theirs; nothing of B's typing is written.
    await keys(a, ESC);
    await keys(b, ESC);
    const mark = b.mark();
    await command(b, "apply");
    await expectPlain(b, "1 from A beta base", mark);
    await Bun.sleep(1000);
    body = (await show(2)).task.body ?? "";
    expect(body).toBe("from A beta base");
    expect(since(a, 0)).not.toContain("onflict");
    for (const pty of [a, b]) {
      await command(pty, "read"); // back to Read for the rest of the file
      await keys(pty, ";", "h"); // focus the task list (h moves the reading cursor)
    }
  });

  test("posts are deduped: a composer post, a CLI post and an API retry with one mutation id each show once", async () => {
    const before = (await show(1)).updates.length;
    let mark = a.mark();
    await command(a, "1");
    await keys(a, "c");
    await expectPlain(a, "Post an update", mark);
    await keys(a, ..."posted from A");
    await keys(a, ESC);
    mark = a.mark();
    await command(a, "w");
    await expectPlain(a, "Posted an update to @1", mark);
    await cli("update", "1", "-m", "posted from the cli", "--as", PI_AUTHOR);
    // An agent retrying a post whose answer it lost: the same mutation id posts ONCE.
    const socketPath = (daemon().endpoint as { socketPath: string }).socketPath;
    const mutationId = crypto.randomUUID();
    const post = async () => {
      const res = await fetch("http://localhost/api/tasks/1/updates", {
        method: "POST",
        unix: socketPath,
        headers: { "content-type": "application/json", prefer: "cortex-versioned" },
        body: JSON.stringify({ summary: "posted through the api once", author: PI_AUTHOR, guard: { mutationId } }),
      });
      expect(res.ok).toBe(true);
      return (await res.json()) as { update: { id: number }; replayed: boolean };
    };
    const first = await post();
    const again = await post();
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    expect(again.update.id).toBe(first.update.id);
    const after = await show(1);
    expect(after.updates.length).toBe(before + 3);
    expect(after.updates.filter(u => u.summary === "posted through the api once")).toHaveLength(1);
    const total = after.updates.length;
    for (const pty of [b, c]) {
      const from = pty.mark();
      await command(pty, "1");
      await command(pty, "activity");
      await expectPlain(pty, new RegExp(`ACTIVITY · ${total} · newest first`), from);
      await expectPlain(pty, "posted through the api once", from);
      expect(since(pty, from)).not.toContain(`ACTIVITY · ${total + 1}`);
    }
    // A (the poster) shows it once too: its acknowledgement and the live echo are one card.
    mark = a.mark();
    await command(a, "activity");
    await expectPlain(a, new RegExp(`ACTIVITY · ${total} · newest first`), mark);
    for (const pty of [a, b, c]) {
      await keys(pty, "]", "]", "]"); // Activity → Related → Authors → Document
    }
  });

  test("notification read state is shared: all-read in one session converges in the others, and back", async () => {
    // Every session opens the feed; creations left unread notifications.
    for (const pty of [a, b, c]) {
      const mark = pty.mark();
      await command(pty, "notifications");
      await expectPlain(pty, /NOTIFICATIONS · [1-9]\d* unread/, mark);
    }
    const marks = [a, b, c].map(p => p.mark());
    await keys(a, "a"); // A: all read
    await Promise.all([a, b, c].map((p, i) => expectPlain(p, "NOTIFICATIONS · 0 unread", marks[i])));
    // B marks its highlighted row unread: A and C follow.
    const back = [a, c].map(p => p.mark());
    await keys(b, "u");
    await Promise.all([a, c].map((p, i) => expectPlain(p, "NOTIFICATIONS · 1 unread", back[i])));
    for (const pty of [a, b, c]) await keys(pty, "q");
  });

  test("an agent's blocked transition raises attention in every session and adds an unread notification", async () => {
    const marks = [a, b, c].map(p => p.mark());
    await cli("update", "2", "-m", "needs a decision", "-s", "blocked", "--as", PI_AUTHOR);
    await Promise.all([a, b, c].map((p, i) => expectPlain(p, "@2 is blocked", marks[i])));
    await Promise.all([a, b, c].map((p, i) => expectPlain(p, /✉ \d+ unread/, marks[i])));
  });

  test("a daemon stop and restart: sessions show stale, reattach to the new instance, resnapshot and stay usable", async () => {
    const was = daemon().instanceId;
    let marks = [a, b, c].map(p => p.mark());
    await cli("stop");
    await Promise.all([a, b, c].map((p, i) => expectPlain(p, "○ stale · reconnecting", marks[i])));
    // Written while no daemon runs (the CLI's in-process fallback): the sessions cannot see it yet.
    await cli("edit", "3", "--title", "gamma edited while the daemon was down");
    marks = [a, b, c].map(p => p.mark());
    await cli("serve");
    expect(daemon().instanceId).not.toBe(was);
    await Promise.all(
      [a, b, c].map((p, i) => expectPlain(p, "Reconnected to the restarted cortex daemon", marks[i], 20_000)),
    );
    await Promise.all([a, b, c].map((p, i) => expectPlain(p, "gamma edited while", marks[i])));
    await Promise.all([a, b, c].map((p, i) => expectPlain(p, "● live", marks[i])));
    // Idle past Bun.serve's 10 s idle timeout: the heartbeat keeps every stream up (no spurious reconnect).
    const idle = [a, b, c].map(p => p.mark());
    await Bun.sleep(14_000);
    for (const [i, p] of [a, b, c].entries()) expect(since(p, idle[i] ?? 0)).not.toContain("○ stale");
    // Writes go to the new instance.
    const after = [b, c].map(p => p.mark());
    await command(a, "3");
    await command(a, "title gamma after the restart");
    await waitForTask(3, s => s.task.title === "gamma after the restart");
    await Promise.all([b, c].map((p, i) => expectPlain(p, "gamma after the restart", after[i])));
  });

  test("a stopped (slow) subscriber catches up when it resumes and stays usable", async () => {
    // Keep the big task out of every document pane.
    for (const pty of [a, b, c]) await command(pty, "1");
    const markC = c.mark();
    c.proc.kill("SIGSTOP");
    try {
      // About 10 MB of frames the stopped session cannot read while it is stopped. Whether the
      // daemon hands it the backlog or (past its 8 MiB per-client bound) one resync, the resumed
      // session must converge. (Observed: it drains the backlog; the overflow resync path is
      // certified by the server and session unit tests.)
      const file = path.join(box.tmpDir, "flood.md");
      const filler = `${"flood line of the slow subscriber test ".repeat(40)}\n`.repeat(700);
      for (let round = 1; round <= 9; round++) {
        fs.writeFileSync(file, `# round ${round}\n\n${filler}`);
        await cli("edit", "4", "--body-file", file);
      }
      await cli("edit", "1", "--title", "alpha after the flood");
    } finally {
      c.proc.kill("SIGCONT");
    }
    await expectPlain(c, "alpha after the flood", markC, 30_000);
    await expectPlain(a, "alpha after the flood");
    // Still usable: a write from the resumed session lands and the others see it. (Task @4 with
    // the 1 MB body is never read through `cortex show --json`: piped, the CLI truncates its
    // output at 64 KiB, a pre-existing CLI issue outside the TUI.)
    const marks = [a, b].map(p => p.mark());
    await command(c, "title alpha written after resuming");
    await waitForTask(1, s => s.task.title === "alpha written after resuming");
    await Promise.all([a, b].map((p, i) => expectPlain(p, "alpha written after resuming", marks[i])));
  });

  test("closing one session leaves the others connected and usable", async () => {
    await command(c, "1");
    c.write(":q\r");
    expect(await c.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(c.localFlags())).toBe(true);
    const markB = b.mark();
    await command(a, "2");
    await command(a, "title beta after C left");
    await waitForTask(2, s => s.task.title === "beta after C left");
    await expectPlain(b, "beta after C left", markB);
    const markA = a.mark();
    await command(b, "3");
    await command(b, "priority 1");
    await waitForTask(3, s => s.task.priority === 1);
    await command(a, "3");
    await expectPlain(a, "P1", markA);
    // The daemon outlives the closed session.
    await waitFor("the daemon", () => (readIdentity(metadataFileFor(box.env.CORTEX_DB ?? "")) ? true : null));
  });

  // Review @405 F1: a status-less post advanced no task token, so a delete confirmed before it
  // cascaded the new update away instead of conflicting.
  test("a delete confirmed after a concurrent CLI post is refused and deletes nothing", async () => {
    const id = await addTask("doomed task");
    let mark = a.mark();
    await command(a, String(id));
    await command(a, "delete");
    await expectPlain(a, `Delete @${id} doomed task?`, mark);
    await cli("update", String(id), "-m", "posted after the dialog opened", "--as", PI_AUTHOR);
    mark = a.mark();
    await keys(a, "y");
    await expectPlain(a, `Conflict: @${id} changed after you confirmed`, mark);
    const kept = await show(id);
    expect(kept.task.title).toBe("doomed task");
    expect(kept.updates.map(u => u.summary)).toContain("posted after the dialog opened");
    // Confirmed against what it is now, the delete goes through.
    mark = a.mark();
    await command(a, "delete");
    await expectPlain(a, `Delete @${id} doomed task?`, mark);
    await keys(a, "y");
    await expectPlain(a, `Deleted @${id} doomed task`, mark);
    const gone = await runCli({ args: ["show", String(id), "--json"], env: box.env });
    expect(gone.code).not.toBe(0);
  });

  // Review @405 F7: status transactions commit a `status → x` audit row, but only the task and
  // notification frames were published, so a loaded Activity panel never showed it.
  test("status audit rows reach a loaded Activity panel live, once, from a status post and a status change", async () => {
    const id = await addTask("audited task");
    let mark = a.mark();
    await command(a, String(id));
    await command(a, "activity");
    const base = (await show(id)).updates.length;
    await expectPlain(a, new RegExp(`ACTIVITY · ${base} · newest first`), mark);
    // An agent's status post: its message and its audit row, in one transaction.
    mark = a.mark();
    await cli("update", String(id), "-m", "ready for a look", "-s", "review", "--as", PI_AUTHOR);
    await expectPlain(a, "status → review", mark);
    await expectPlain(a, new RegExp(`ACTIVITY · ${base + 2} · newest first`), mark);
    // Another session's status change (PATCH /status) audits too.
    mark = a.mark();
    await command(b, String(id));
    await command(b, "status done");
    await waitForTask(id, s => s.task.status === "done");
    await expectPlain(a, "status → done", mark);
    await expectPlain(a, new RegExp(`ACTIVITY · ${base + 3} · newest first`), mark);
    const shown = await show(id);
    expect(shown.updates.length).toBe(base + 3);
    expect(since(a, mark)).not.toContain(`ACTIVITY · ${base + 4}`);
    await keys(a, "]", "]", "]"); // Activity → Related → Authors → Document
  });
});
