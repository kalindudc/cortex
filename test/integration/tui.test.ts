import { test, expect, describe, afterEach, afterAll, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import { BIN, mkTmpEnv, runCli } from "./helpers.ts";
import { metadataFileFor, readIdentity } from "./fixtures/daemon.ts";
import { isCooked, isRaw, type Pty, reapPtys, spawnPty } from "./fixtures/pty.ts";

// ---------- the terminal workspace in a real PTY (plan @400 Task 7, G4) ----------
//
// Every test runs the COMPILED bin/cortex inside a real pseudo-terminal
// (fixtures/pty.ts: Bun.Terminal, continuously drained, bounded waits) in its
// own mkTmpEnv() sandbox. The TUI autostarts a headless daemon for that
// sandbox's database; afterEach stops it with `cortex stop` in the SAME env,
// which is instance-bound (never another daemon). The only signals sent are
// to PTY children this file spawned.
//
// Termios is checked from the parent after the child exited: ICANON, ECHO and
// ISIG back on means the TUI restored the terminal; the SIGKILL case is the
// negative control showing that a child that cannot clean up leaves raw
// flags behind, so the check is meaningful.

// PTY sessions start a daemon and a TUI: more than bun's 5 s default, always bounded.
setDefaultTimeout(30_000);

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const PASTE_OFF = "\x1b[?2004l";
/** Button-event tracking with drag (1002) in SGR encoding (1006), and their resets. */
const MOUSE_ON = "\x1b[?1002h\x1b[?1006h";
const MOUSE_OFFS = ["\x1b[?1002l", "\x1b[?1006l"] as const;
/** The mouse was turned off in `output`, before the alternate screen closed. */
function expectMouseOff(output: string): void {
  for (const off of MOUSE_OFFS) {
    expect(output).toContain(off);
    expect(output.indexOf(off)).toBeLessThan(output.lastIndexOf(ALT_OFF));
  }
}

type Sandbox = ReturnType<typeof mkTmpEnv>;
/** This test's sandboxes (their daemons are stopped after it), then every sandbox (removed at the end). */
const current: Sandbox[] = [];
const sandboxes: Sandbox[] = [];

function sandbox(
  label: string,
  over: Record<string, string | undefined> = {},
): Sandbox & { tuiEnv: Record<string, string> } {
  const box = mkTmpEnv(label);
  current.push(box);
  sandboxes.push(box);
  const tuiEnv: Record<string, string> = { ...box.env, TERM: "xterm-256color" };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete tuiEnv[key];
    else tuiEnv[key] = value;
  }
  return { ...box, tuiEnv };
}

async function seed(env: Record<string, string>, ...titles: string[]): Promise<void> {
  for (const title of titles) {
    const r = await runCli({ args: ["add", title], env });
    expect(r.code, r.stderr).toBe(0);
  }
}

/** The TUI is up: its first content frame shows the task list. */
async function ready(pty: Pty): Promise<void> {
  await pty.expect("TASKS", { timeoutMs: 20_000 });
}

/** The pid of `parent`'s child whose command line contains `needle`. */
function childPid(parent: number, needle: string): number {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="]).stdout.toString();
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[2]) === parent && (m[3] ?? "").includes(needle)) return Number(m[1]);
  }
  throw new Error(`no child of ${parent} runs ${JSON.stringify(needle)}:\n${ps}`);
}

/** Wait (bounded) until `ps` reports a state starting with `state` (T: stopped, S: sleeping). */
async function waitForState(pid: number, state: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    if (stat.startsWith(state)) return;
    if (Date.now() >= deadline)
      throw new Error(`pid ${pid} is ${JSON.stringify(stat)}, not ${state}, after ${timeoutMs}ms`);
    await Bun.sleep(20);
  }
}

/**
 * The output with terminal control sequences removed. The renderer writes
 * each changed line whole, so the styled segments of one rendered line read
 * as contiguous text here.
 */
function plainText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b[_P^][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // APC (the cursor marker), DCS, PM
    .replace(/\x1b\[[0-9;?<>=:]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>78c]/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

/** Wait (bounded) until the plain text written at or after `from` contains `needle`; resolves with the output mark then. */
async function expectPlain(pty: Pty, needle: string | RegExp, from = 0, timeoutMs = 10_000): Promise<number> {
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

/** Type keys one input at a time (each is its own read in the TUI), pausing briefly between them. */
async function keys(pty: Pty, ...inputs: string[]): Promise<void> {
  for (const input of inputs) {
    pty.write(input);
    await Bun.sleep(30);
  }
}

async function seedTasks(env: Record<string, string>, ...tasks: string[][]): Promise<void> {
  for (const args of tasks) {
    const r = await runCli({ args: ["add", ...args], env });
    expect(r.code, r.stderr).toBe(0);
  }
}

const FUNCTION_KEY_LABEL = /\bF(?:[1-9]|[12][0-9]|3[0-5])\b/;
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

afterEach(async () => {
  await reapPtys();
  for (const box of current.splice(0)) {
    // Instance-bound: stops only the daemon this sandbox's TUI started.
    const r = await runCli({ args: ["stop"], env: box.env });
    expect(r.code, r.stderr).toBe(0);
  }
});

afterAll(() => {
  for (const box of sandboxes.splice(0)) box.cleanup();
});

describe("cortex tui in a real terminal", () => {
  test("renders the list, follows resizes to 120x40 and 80x24, and :q restores the terminal", async () => {
    const box = sandbox("tui-render");
    await seed(box.env, "alpha task", "beta task");
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 100, rows: 30 });
    await ready(pty);
    await pty.expect("alpha task");
    expect(pty.output()).toContain(ALT_ON);
    expect(isRaw(pty.localFlags())).toBe(true);

    let mark = pty.mark();
    pty.resize(120, 40);
    await pty.expect("\x1b[40;1H", { from: mark });
    await pty.expect("beta task", { from: mark });

    mark = pty.mark();
    pty.resize(80, 24);
    await pty.expect("\x1b[24;1H", { from: mark });
    await pty.expect("TASKS", { from: mark });
    // At 80x24 one pane shows: Tab moves focus to the document.
    mark = pty.mark();
    pty.write("\t");
    await pty.expect(" READ ", { from: mark });

    mark = pty.mark();
    pty.write(":q\r");
    const exit = await pty.exited();
    expect(exit).toEqual({ code: 0, signal: null });
    const after = pty.output().slice(mark);
    expect(after).toContain(ALT_OFF);
    expect(after).toContain(PASTE_OFF);
    expectMouseOff(after);
    // preserveScreen: nothing of the document is dumped into the shell after leaving the alternate screen.
    expect(after.slice(after.lastIndexOf(ALT_OFF))).not.toContain("alpha task");
    expect(isCooked(pty.localFlags())).toBe(true);
    // Quitting closed this TUI's connections, not the shared daemon.
    expect(fs.existsSync(metadataFileFor(box.env.CORTEX_DB ?? ""))).toBe(true);
  });

  test("plain `cortex` (no arguments) in a terminal opens the TUI", async () => {
    const box = sandbox("tui-noarg");
    await seed(box.env, "from plain cortex");
    const pty = spawnPty([BIN], { env: box.tuiEnv });
    await ready(pty);
    await pty.expect("from plain cortex");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });

  test("plain `cortex` without a terminal keeps today's usage output and exit code", async () => {
    const box = sandbox("tui-nontty");
    const r = await runCli({ args: [], env: box.env });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("USAGE cortex");
    expect(r.stdout).toContain("tui");
    expect(r.stderr).toContain("No command specified");
    expect(r.stdout).not.toContain(ALT_ON);
    expect(fs.existsSync(metadataFileFor(box.env.CORTEX_DB ?? ""))).toBe(false);
  });

  test("TERM=dumb is refused with CLI guidance, before the alternate screen", async () => {
    const box = sandbox("tui-dumb", { TERM: "dumb" });
    for (const argv of [[BIN, "tui"], [BIN]]) {
      const pty = spawnPty(argv, { env: box.tuiEnv });
      const exit = await pty.exited();
      expect(exit.code).toBe(1);
      expect(pty.output()).toContain("TERM=dumb");
      expect(pty.output()).toContain("cortex ls");
      expect(pty.output()).not.toContain(ALT_ON);
    }
    expect(fs.existsSync(metadataFileFor(box.env.CORTEX_DB ?? ""))).toBe(false);
  });

  test("invalid arguments exit non-zero before the alternate screen", async () => {
    const box = sandbox("tui-args");
    const cases: [string[], RegExp][] = [
      [["--theme", "nope"], /--theme "nope" not found/],
      [["--theme", "Not A Name"], /--theme/],
      [["abc"], /invalid task id "abc"/],
      [["--profile", "../escape"], /--profile/],
      [["--heading", "plan"], /--heading needs a task id/],
    ];
    for (const [args, message] of cases) {
      const pty = spawnPty([BIN, "tui", ...args], { env: box.tuiEnv });
      const exit = await pty.exited();
      expect(exit.code, args.join(" ")).toBe(1);
      expect(pty.output()).toMatch(message);
      expect(pty.output()).not.toContain(ALT_ON);
      expect(isCooked(pty.localFlags())).toBe(true);
    }
    // Nothing was started for an invalid invocation.
    expect(fs.existsSync(metadataFileFor(box.env.CORTEX_DB ?? ""))).toBe(false);
  });

  test("a task id that does not exist is reported before the alternate screen", async () => {
    const box = sandbox("tui-missing");
    await seed(box.env, "only task");
    const pty = spawnPty([BIN, "tui", "99"], { env: box.tuiEnv });
    const exit = await pty.exited(20_000);
    expect(exit.code).toBe(1);
    expect(pty.output()).toContain("no task @99");
    expect(pty.output()).not.toContain(ALT_ON);
  });

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    test(`${signal} runs a bounded shutdown that restores the terminal and leaves the daemon running`, async () => {
      const box = sandbox(`tui-${signal.toLowerCase()}`);
      await seed(box.env, "signal me");
      const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv });
      await ready(pty);
      expect(isRaw(pty.localFlags())).toBe(true);
      const mark = pty.mark();
      pty.kill(signal);
      const exit = await pty.exited(5000);
      expect(exit).toEqual({ code, signal: null });
      const after = pty.output().slice(mark);
      expect(after).toContain(ALT_OFF);
      expect(after).toContain(PASTE_OFF);
      expectMouseOff(after);
      expect(isCooked(pty.localFlags())).toBe(true);
      const stop = await runCli({ args: ["stop"], env: box.env });
      expect(stop.stdout).toContain("stopped 1 process");
    });
  }

  test("negative control: a SIGKILLed TUI cannot restore, and the termios check sees it", async () => {
    const box = sandbox("tui-sigkill");
    await seed(box.env, "kill me");
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv });
    await ready(pty);
    pty.kill("SIGKILL");
    const exit = await pty.exited(5000);
    expect(exit.signal).toBe("SIGKILL");
    expect(isCooked(pty.localFlags())).toBe(false);
    expect(isRaw(pty.localFlags())).toBe(true);
  });

  test("Ctrl-z under job control restores the terminal BEFORE stopping, and SIGCONT resumes the session", async () => {
    const box = sandbox("tui-suspend");
    await seed(box.env, "suspend me");
    // A job-control shell runs the TUI as a foreground job in its own process
    // group, so SIGTSTP really stops it. (Non-interactive bash never reaps a
    // stopped job, so the test continues the TUI itself: it signals only its
    // own grandchild, found by parent pid and argv.)
    const script = `set -m; "$0" tui; echo "DONE=$?"`;
    const pty = spawnPty(["/bin/bash", "--noprofile", "--norc", "-c", script, BIN], { env: box.tuiEnv });
    await ready(pty);
    const tuiPid = childPid(pty.proc.pid, " tui");
    let mark = pty.mark();
    pty.write("\x1a");
    await waitForState(tuiPid, "T");
    const beforeStop = pty.output().slice(mark);
    expect(beforeStop).toContain(ALT_OFF);
    expect(beforeStop).toContain(PASTE_OFF);
    expectMouseOff(beforeStop);
    expect(isCooked(pty.localFlags())).toBe(true); // restored before SIGTSTP, while stopped
    mark = pty.mark();
    process.kill(tuiPid, "SIGCONT");
    await pty.expect(ALT_ON, { from: mark });
    await pty.expect(MOUSE_ON, { from: mark }); // the mouse is back with the terminal
    await pty.expect("suspend me", { from: mark });
    await waitForState(tuiPid, "S");
    expect(isRaw(pty.localFlags())).toBe(true);
    await Bun.sleep(400);
    expect(pty.output().slice(mark)).not.toContain("no job control");
    mark = pty.mark();
    pty.write(":q\r");
    await pty.expect("DONE=0", { from: mark });
    expect((await pty.exited()).code).toBe(0);
    expect(isCooked(pty.localFlags())).toBe(true);
  }, 30_000);

  test("Ctrl-z without job control (an orphaned process group) keeps the session running and says so", async () => {
    const box = sandbox("tui-nojobs");
    await seed(box.env, "stay with me");
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv });
    await ready(pty);
    const mark = pty.mark();
    pty.write("\x1a");
    const left = await pty.expect(ALT_OFF, { from: mark });
    await pty.expect(ALT_ON, { from: left });
    await pty.expect("no job control", { from: left });
    expect(isRaw(pty.localFlags())).toBe(true);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  }, 30_000);

  for (const [label, replies, enabled, reset] of [
    ["the Kitty keyboard protocol", { "\x1b[?u": "\x1b[?7u" }, "\x1b[>7u", "\x1b[<u"],
    ["modifyOtherKeys", { "\x1b[c": "\x1b[?62;22c" }, "\x1b[>4;2m", "\x1b[>4;0m"],
  ] as const) {
    test(`${label}, when the terminal enables it, is reset on exit`, async () => {
      const box = sandbox("tui-keyboard");
      await seed(box.env, "keyboard task");
      const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, replies });
      await ready(pty);
      // The toolkit enables it once it has read the terminal's reply, which may land after the first frame.
      await pty.expect(enabled, { timeoutMs: 5000 });
      const mark = pty.mark();
      pty.write(":q\r");
      expect((await pty.exited()).code).toBe(0);
      const after = pty.output().slice(mark);
      expect(after).toContain(reset);
      expect(after.indexOf(reset)).toBeLessThan(after.lastIndexOf(ALT_OFF));
      expect(isCooked(pty.localFlags())).toBe(true);
    });
  }

  test("appearance detection answers before the first content frame (a light DSR reply picks cortex-light)", async () => {
    const box = sandbox("tui-theme", { NO_COLOR: undefined, COLORTERM: "truecolor" });
    await seed(box.env, "themed task");
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, replies: { "\x1b[?996n": "\x1b[?997;2n" } });
    await ready(pty);
    const out = pty.output();
    const query = out.indexOf("\x1b[?996n");
    const firstBackground = out.indexOf("48;2;");
    expect(query).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("\x1b]11;?")).toBeGreaterThanOrEqual(0);
    expect(firstBackground).toBeGreaterThan(query);
    expect(out).toContain("48;2;246;242;236"); // cortex-light bg
    expect(out).toContain("\x1b[?2031h"); // auto follows palette notifications
    const mark = pty.mark();
    pty.write(":q\r");
    expect((await pty.exited()).code).toBe(0);
    expect(pty.output().slice(mark)).toContain("\x1b[?2031l");
    expect(isCooked(pty.localFlags())).toBe(true);
  });
});

describe("the command line and the task list in a real terminal (plan @400 Task 8)", () => {
  // Ids follow creation order in each fresh sandbox: 1 alpha one, 2 alpha two, 3 beta three, 4 gamma done.
  const TASKS = [["alpha one"], ["alpha two"], ["beta three"], ["gamma done", "-s", "done"]];

  test("`:` completion cycles with Tab/Shift-Tab over commands and arguments; unknown commands explain", async () => {
    const box = sandbox("tui-complete");
    await seedTasks(box.env, ...TASKS);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "alpha one");
    // :f<Tab> shows filter, focus, forward; a second Tab picks focus.
    let mark = pty.mark();
    await keys(pty, ":", "f", TAB);
    await expectPlain(pty, ":forward", mark);
    await keys(pty, TAB, ..." document", "\r");
    await expectPlain(pty, "│ document │", mark);
    // Shift-Tab steps back through the same candidates.
    mark = pty.mark();
    await keys(pty, ":", "f", TAB, TAB, TAB, SHIFT_TAB, ..." list", "\r");
    await expectPlain(pty, "│ tasks │", mark);
    // Arguments complete too: :set do<Tab> -> :set done shows the done task.
    mark = pty.mark();
    await keys(pty, ":", ..."set do", TAB, "\r");
    await expectPlain(pty, "gamma done", mark);
    mark = pty.mark();
    await keys(pty, ":", ..."frobnicate", "\r");
    await expectPlain(pty, "error: Unknown command :frobnicate", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });

  test("Up/Down and Ctrl-P/Ctrl-N recall the `:` history and restore the unfinished line", async () => {
    const box = sandbox("tui-history");
    await seedTasks(box.env, ...TASKS);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    let mark = pty.mark();
    await keys(pty, ":", ..."messages", "\r");
    await expectPlain(pty, "MESSAGES ·", mark);
    await keys(pty, "q");
    // An empty line: Up recalls the last command.
    mark = pty.mark();
    await keys(pty, ":", UP, "\r");
    await expectPlain(pty, "MESSAGES ·", mark);
    await keys(pty, "q");
    // A typed prefix filters Up.
    mark = pty.mark();
    await keys(pty, ":", ..."mes", UP, "\r");
    await expectPlain(pty, "MESSAGES ·", mark);
    await keys(pty, "q");
    // Walking away from an unfinished line and back restores it.
    mark = pty.mark();
    await keys(pty, ":", ..."help", "\x10", "\x0e", DOWN, "\r");
    await expectPlain(pty, "CORTEX TERMINAL WORKSPACE · help", mark);
    await keys(pty, "q");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });

  test("/ filters the list, n/N step the results, and :open jumps outside the filters without clearing them", async () => {
    const box = sandbox("tui-search");
    await seedTasks(box.env, ...TASKS);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    let mark = pty.mark();
    await keys(pty, "/", ..."alpha", "\r");
    await expectPlain(pty, "2 shown", mark);
    await expectPlain(pty, "/alpha", mark);
    // The fallback is the first result (@1); n and N step through the results.
    mark = pty.mark();
    await keys(pty, "n");
    await expectPlain(pty, "@2 · now", mark);
    mark = pty.mark();
    await keys(pty, "N");
    await expectPlain(pty, "@1 · now", mark);
    // :open is a global jump: beta is shown, the search stays.
    mark = pty.mark();
    await keys(pty, ":", ..."open 3", "\r");
    await expectPlain(pty, "@3 · now", mark);
    await expectPlain(pty, "Outside the current list filters", mark);
    mark = pty.mark();
    await keys(pty, ":", ..."filter", "\r");
    // A bare :filter opens the filter picker, its summary naming the search; Enter closes it (the search stays).
    await expectPlain(pty, "FILTERS", mark);
    await expectPlain(pty, /tasks? shown · \/alpha/, mark);
    mark = pty.mark();
    await keys(pty, "\r");
    await expectPlain(pty, /NORMAL\s+│/, mark);
    // Ctrl-o goes back to the task shown before the jump.
    mark = pty.mark();
    await keys(pty, "\x0f");
    await expectPlain(pty, "@1 · now", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });

  test("no view ever shows a function-key hint", async () => {
    const box = sandbox("tui-nofkeys");
    await seedTasks(box.env, ...TASKS);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, ": commands");
    let mark = pty.mark();
    await keys(pty, "?");
    await expectPlain(pty, "CORTEX TERMINAL WORKSPACE · help", mark);
    // The help is longer than its box: page through all of it so every section is drawn (and scanned).
    for (let i = 0; i < 24; i++) await keys(pty, "\x04");
    await expectPlain(pty, "KEYS · NORMAL", mark);
    await expectPlain(pty, "KEYS · INSERT", mark);
    await keys(pty, "q");
    mark = pty.mark();
    await keys(pty, ":", ..."messages", "\r");
    await expectPlain(pty, "MESSAGES ·", mark);
    await keys(pty, "q");
    mark = pty.mark();
    await keys(pty, "\x10");
    await expectPlain(pty, "COMMANDS ·", mark);
    await keys(pty, "q");
    mark = pty.mark();
    await keys(pty, ":", TAB);
    await expectPlain(pty, "Tab completes", mark);
    await keys(pty, "\x1b");
    // Every dialog kind: lists, the per-task tag picker, the theme picker, a form and a confirmation.
    for (const [command, shown] of [
      ["lanes", "LANES"],
      ["tags", "TAGS"],
      ["tag", "TAGS OF @1"],
      ["status", "STATUS OF @1"],
      ["theme", "THEME"],
    ] as const) {
      mark = pty.mark();
      await keys(pty, ":", ...command, "\r");
      await expectPlain(pty, shown, mark);
      await keys(pty, "q");
    }
    mark = pty.mark();
    await keys(pty, ":", ..."title", "\r");
    await expectPlain(pty, "INSERT", mark);
    await keys(pty, "\x1b", "\x1b");
    mark = pty.mark();
    await keys(pty, ":", ..."delete", "\r");
    await expectPlain(pty, "Delete @1", mark);
    await keys(pty, "n");
    await Bun.sleep(100);
    // Positive control: the scan does see a styled function-key label.
    expect(plainText("\x1b[1;38;5;1mF5\x1b[0m refresh")).toMatch(FUNCTION_KEY_LABEL);
    expect(plainText(pty.output())).not.toMatch(FUNCTION_KEY_LABEL);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });
});

describe("metadata and catalog commands in a real terminal (plan @400 Task 8 part B)", () => {
  type Shown = {
    task: { id: number; title: string; status: string; tags: string[] };
    updates: { author: string; summary: string }[];
  };
  const show = async (env: Record<string, string>, id: number): Promise<Shown> => {
    const r = await runCli({ args: ["show", String(id), "--json"], env });
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as Shown;
  };
  const listJson = async (env: Record<string, string>, ...args: string[]): Promise<{ name: string }[]> => {
    const r = await runCli({ args: [...args, "--json"], env });
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as { name: string }[];
  };

  test(":new creates and selects untitled-<id>, :title names it, :status review moves it as a human (not an agent)", async () => {
    const box = sandbox("tui-new");
    await seedTasks(box.env, ["alpha one"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "alpha one");
    let mark = pty.mark();
    await keys(pty, ":", ..."new", "\r");
    await expectPlain(pty, "Created @2 untitled-2", mark);
    await expectPlain(pty, "@2 · now", mark);
    mark = pty.mark();
    await keys(pty, ":", ..."title Ship the TUI", "\r");
    await expectPlain(pty, "Ship the TUI", mark);
    mark = pty.mark();
    await keys(pty, ":", ..."status review", "\r");
    await expectPlain(pty, "In review", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    const created = await show(box.env, 2);
    expect(created.task).toMatchObject({ title: "Ship the TUI", status: "review" });
    // The status audit row carries the human default author (GET /api/me): an unattributed change.
    const identity = readIdentity(metadataFileFor(box.env.CORTEX_DB ?? ""));
    if (identity?.endpoint.kind !== "unix") throw new Error("no daemon metadata");
    const me = (await (await fetch("http://localhost/api/me", { unix: identity.endpoint.socketPath })).json()) as {
      author: string;
    };
    const audit = created.updates.find(u => u.summary === "status → review");
    expect(audit?.author).toBe(me.author);
  });

  test(";m opens the status picker; x marks the selected task done as a human (not an agent)", async () => {
    const box = sandbox("tui-status-picker");
    await seedTasks(box.env, ["alpha one"], ["beta two"]);
    const pty = spawnPty([BIN, "tui", "1"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "beta two");
    let mark = pty.mark();
    await keys(pty, ";", "m");
    await expectPlain(pty, "STATUS OF @1", mark);
    await expectPlain(pty, "next step", mark);
    mark = pty.mark();
    await keys(pty, "x");
    await expectPlain(pty, "@1: Open \u2192 Done", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    const done = await show(box.env, 1);
    expect(done.task.status).toBe("done");
    // The audit row carries the human default author, as :status does.
    const identity = readIdentity(metadataFileFor(box.env.CORTEX_DB ?? ""));
    if (identity?.endpoint.kind !== "unix") throw new Error("no daemon metadata");
    const me = (await (await fetch("http://localhost/api/me", { unix: identity.endpoint.socketPath })).json()) as {
      author: string;
    };
    expect(done.updates.find(u => u.summary === "status \u2192 done")?.author).toBe(me.author);
    expect((await show(box.env, 2)).task.status).toBe("open");
  });

  test(":tag +x -y applies membership deltas; removing a tag from a task keeps its definition", async () => {
    const box = sandbox("tui-tag");
    await seedTasks(box.env, ["tagged task", "-t", "old,keep"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "tagged task");
    const mark = pty.mark();
    await keys(pty, ":", ..."tag +fresh -old", "\r");
    await expectPlain(pty, "#fresh", mark);
    await expectPlain(pty, "untagged #old", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect((await show(box.env, 1)).task.tags).toEqual(["fresh", "keep"]);
    expect((await listJson(box.env, "tag", "ls")).map(t => t.name)).toContain("old");
  });

  test(":delete asks y/n: n keeps the task, y deletes it", async () => {
    const box = sandbox("tui-delete");
    await seedTasks(box.env, ["doomed task"], ["survivor"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "doomed task");
    let mark = pty.mark();
    await keys(pty, ":", ..."delete", "\r");
    await expectPlain(pty, "Delete @1", mark);
    await expectPlain(pty, "y deletes it · n keeps it", mark);
    mark = pty.mark();
    await keys(pty, "n");
    await expectPlain(pty, "│ tasks │", mark);
    expect((await show(box.env, 1)).task.title).toBe("doomed task");
    mark = pty.mark();
    await keys(pty, ":", ..."delete", "\r");
    await expectPlain(pty, "Delete @1", mark);
    mark = pty.mark();
    await keys(pty, "y");
    await expectPlain(pty, "Deleted @1", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    const gone = await runCli({ args: ["show", "1", "--json"], env: box.env });
    expect(gone.code).not.toBe(0);
    expect((await show(box.env, 2)).task.title).toBe("survivor");
  });

  test(":lanes creates a lane through its form; :tags deletes a tag after confirming its impact count", async () => {
    const box = sandbox("tui-catalogs");
    await seedTasks(box.env, ["one", "-t", "doomed"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "one");
    let mark = pty.mark();
    await keys(pty, ":", ..."lanes", "\r");
    await expectPlain(pty, "LANES", mark);
    mark = pty.mark();
    await keys(pty, "a");
    await expectPlain(pty, "NEW LANE", mark);
    await expectPlain(pty, "INSERT", mark);
    // In a form, q and : are text; :q with input is refused.
    await keys(pty, ..."some", "\x1b", ":", "q", "\r");
    await expectPlain(pty, "unsaved input", mark);
    mark = pty.mark();
    await keys(pty, "i", ..."day", "\r");
    await expectPlain(pty, "Created lane someday", mark);
    await keys(pty, "q");
    mark = pty.mark();
    await keys(pty, ":", ..."tags", "\r");
    await expectPlain(pty, "TAGS", mark);
    mark = pty.mark();
    await keys(pty, "d");
    await expectPlain(pty, "removed from 1 task", mark);
    mark = pty.mark();
    await keys(pty, "y");
    await expectPlain(pty, "Deleted #doomed", mark);
    await keys(pty, "q");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect((await listJson(box.env, "lane", "ls")).map(l => l.name)).toContain("someday");
    expect((await listJson(box.env, "tag", "ls")).map(t => t.name)).not.toContain("doomed");
    expect((await show(box.env, 1)).task.tags).toEqual([]);
  });

  test(":theme previews live, Esc restores, and Enter saves a choice that the next start uses", async () => {
    const box = sandbox("tui-theme-pick", { NO_COLOR: undefined, COLORTERM: "truecolor" });
    await seedTasks(box.env, ["themed"]);
    // A legacy profile state with a density: the first start moves it into tui.toml.
    const stateDir = `${box.env.XDG_CONFIG_HOME}/cortex/tui`;
    const statePath = `${stateDir}/default.state.json`;
    const tomlPath = `${box.env.XDG_CONFIG_HOME}/cortex/tui.toml`;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, view: { density: "compact" } }));
    const DARK_BG = "48;2;29;31;36";
    const LIGHT_BG = "48;2;246;242;236";
    let pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "themed");
    expect(pty.output()).toContain(DARK_BG);
    let mark = pty.mark();
    await keys(pty, ":", ..."theme", "\r");
    await expectPlain(pty, "THEME", mark);
    mark = pty.mark();
    await keys(pty, "j", "j"); // auto -> cortex-dark -> cortex-light
    await pty.expect(LIGHT_BG, { from: mark });
    mark = pty.mark();
    await keys(pty, "\x1b");
    await pty.expect(DARK_BG, { from: mark });
    mark = pty.mark();
    await keys(pty, ":", ..."theme", "\r", "j", "j", "\r");
    await expectPlain(pty, "cortex-light · your :theme choice (saved)", mark);
    // Debounced, so it is the quit path that writes it.
    await keys(pty, ":", ..."set number", "\r");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    const toml = fs.readFileSync(tomlPath, "utf8");
    for (const line of ['theme = "cortex-light"', 'density = "compact"', "number = true"]) expect(toml).toContain(line);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as { view: Record<string, unknown> };
    expect(state.view).not.toHaveProperty("theme");
    expect(state.view).not.toHaveProperty("density");
    // The next start uses tui.toml's theme: no appearance query, light from the first frame.
    pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    expect(pty.output()).toContain(LIGHT_BG);
    expect(pty.output()).not.toContain("\x1b[?996n");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });
});

describe("the document editor and drafts in a real terminal (plan @400 Task 9)", () => {
  type ShownBody = { task: { body: string | null; title: string } };
  const readTask = async (env: Record<string, string>, id: number): Promise<ShownBody["task"]> => {
    const r = await runCli({ args: ["show", String(id), "--json"], env });
    expect(r.code, r.stderr).toBe(0);
    return (JSON.parse(r.stdout) as ShownBody).task;
  };
  /** Poll a SECOND client (the CLI, same sandbox and daemon) until the body satisfies `want`. */
  const waitForBody = async (
    env: Record<string, string>,
    id: number,
    want: (body: string | null) => boolean,
    timeoutMs = 10_000,
  ): Promise<string | null> => {
    const deadline = Date.now() + timeoutMs;
    let last: string | null = null;
    for (;;) {
      last = (await readTask(env, id)).body;
      if (want(last)) return last;
      if (Date.now() >= deadline) throw new Error(`the body never matched; last: ${JSON.stringify(last)}`);
      await Bun.sleep(100);
    }
  };
  const viewState = (box: Sandbox): { mode?: string } => {
    const file = `${box.env.XDG_CONFIG_HOME}/cortex/tui/default.state.json`;
    if (!fs.existsSync(file)) return {};
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { view: { mode?: string } }).view;
  };
  /** Type one character every `everyMs` until `work` settles (keeps the 600 ms idle timer from firing). */
  const typeWhile = async <T>(pty: Pty, char: string, work: Promise<T>, everyMs = 80): Promise<T> => {
    let done = false;
    const result = work.finally(() => {
      done = true;
    });
    while (!done) {
      pty.write(char);
      await Bun.sleep(everyMs);
    }
    return result;
  };

  test("i from Read shows Edit (the preference stays Read); INSERT typing autosaves and a second client reads it", async () => {
    const box = sandbox("tui-autosave");
    await seedTasks(box.env, ["editable task"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "editable task");
    let mark = pty.mark();
    await keys(pty, TAB, "i");
    await expectPlain(pty, "INSERT", mark);
    await expectPlain(pty, "EDIT", mark);
    // In INSERT, j, q and : are text.
    await keys(pty, ..."hello: j q");
    await expectPlain(pty, "hello: j q", mark);
    mark = pty.mark();
    expect(await waitForBody(box.env, 1, b => b === "hello: j q")).toBe("hello: j q");
    await expectPlain(pty, "✓ saved", mark);
    await keys(pty, "\x1b");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
    // The temporary Edit view never changed the saved preference.
    expect(viewState(box).mode ?? "read").toBe("read");
  });

  test("u and Ctrl-r undo and redo in the visible editor and flow through autosave; elsewhere they explain", async () => {
    const box = sandbox("tui-undo");
    await seedTasks(box.env, ["undo task"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await keys(pty, ":", ..."edit", "\r", TAB, "i", ..."one two");
    await keys(pty, "\x1b");
    await waitForBody(box.env, 1, b => b === "one two");
    await keys(pty, "u");
    await waitForBody(box.env, 1, b => b === null || b === "");
    await keys(pty, "\x12");
    await waitForBody(box.env, 1, b => b === "one two");
    const mark = pty.mark();
    await keys(pty, SHIFT_TAB, "u");
    await expectPlain(pty, "only in a visible editor", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });

  test("Tab and Shift-Tab indent in INSERT (indentMore/indentLess); tabs inside the text survive", async () => {
    const box = sandbox("tui-indent");
    await seedTasks(box.env, ["indent task", "-b", "a\tb"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    const mark = pty.mark();
    await keys(pty, ":", ..."edit", "\r", TAB);
    await expectPlain(pty, "1 a", mark);
    await keys(pty, "i", TAB);
    await keys(pty, "\x1b");
    expect(await waitForBody(box.env, 1, b => b === "  a\tb")).toBe("  a\tb");
    await keys(pty, "i", SHIFT_TAB);
    await keys(pty, "\x1b");
    expect(await waitForBody(box.env, 1, b => b === "a\tb")).toBe("a\tb");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });

  test(":q refuses and names an unsaved draft; :wq saves it, then quits", async () => {
    const box = sandbox("tui-quit-guard");
    await seedTasks(box.env, ["guarded task"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    let mark = pty.mark();
    await keys(pty, ":", ..."edit", "\r", TAB, "i");
    await expectPlain(pty, "INSERT", mark);
    // One read: the text, a merged Esc+:, then q and Enter, before any autosave can fire.
    mark = pty.mark();
    pty.write("unsaved words\x1b:q\r");
    await expectPlain(pty, "@1 body", mark);
    expect(pty.running()).toBe(true);
    pty.write(":wq\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
    expect((await readTask(box.env, 1)).body).toBe("unsaved words");
  });

  test(":q! quits at once and discards the local draft", async () => {
    const box = sandbox("tui-discard");
    await seedTasks(box.env, ["discard task", "-b", "kept body"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    const mark = pty.mark();
    await keys(pty, ":", ..."edit", "\r", TAB, "i");
    await expectPlain(pty, "INSERT", mark);
    pty.write("throw this away\x1b:q!\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    await Bun.sleep(800);
    expect((await readTask(box.env, 1)).body).toBe("kept body");
  });

  test("a merged Esc + :w in one read leaves INSERT and writes at once", async () => {
    const box = sandbox("tui-merged-w");
    await seedTasks(box.env, ["merged task"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    let mark = pty.mark();
    await keys(pty, ":", ..."edit", "\r", TAB, "i");
    await expectPlain(pty, "INSERT", mark);
    mark = pty.mark();
    pty.write("written by w\x1b:w\r");
    await expectPlain(pty, "Saved @1 body", mark);
    await expectPlain(pty, "NORMAL", mark);
    expect((await readTask(box.env, 1)).body).toBe("written by w");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });

  test("SIGTERM tries a bounded flush of the drafts before it restores the terminal", async () => {
    const box = sandbox("tui-sigterm-flush");
    await seedTasks(box.env, ["flush task"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    const mark = pty.mark();
    await keys(pty, ":", ..."edit", "\r", TAB, "i");
    await expectPlain(pty, "INSERT", mark);
    pty.write("saved on SIGTERM");
    await expectPlain(pty, "saved on SIGTERM", mark);
    pty.kill("SIGTERM"); // well before the 600 ms idle autosave
    expect(await pty.exited(8000)).toEqual({ code: 143, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
    expect((await readTask(box.env, 1)).body).toBe("saved on SIGTERM");
  });

  test("the editor keeps its identity across focus, panel and mode switches: undo still reverts the typing", async () => {
    const box = sandbox("tui-identity");
    await seedTasks(box.env, ["identity task"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await keys(pty, ":", ..."edit", "\r", TAB, "i", ..."first line");
    await keys(pty, "\x1b");
    await waitForBody(box.env, 1, b => b === "first line");
    const mark = pty.mark();
    await keys(pty, SHIFT_TAB, TAB, ":", ..."read", "\r", ":", ..."split", "\r", ":", ..."edit", "\r");
    await expectPlain(pty, "EDIT", mark);
    await keys(pty, "u");
    await waitForBody(box.env, 1, b => b === null || b === "");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(viewState(box).mode).toBe("edit");
  });

  test("at 80x24 Split shows the focused half (Tab switches halves) without changing the saved preference", async () => {
    const box = sandbox("tui-split-80");
    await seedTasks(box.env, ["split task", "-b", "split body text"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 80, rows: 24 });
    await ready(pty);
    let mark = pty.mark();
    await keys(pty, ":", ..."split", "\r", TAB);
    await expectPlain(pty, "SPLIT · editor", mark);
    await expectPlain(pty, "1 split body text", mark);
    mark = pty.mark();
    await keys(pty, TAB);
    await expectPlain(pty, "SPLIT · preview", mark);
    mark = pty.mark();
    pty.resize(120, 40);
    await expectPlain(pty, "PREVIEW", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(viewState(box).mode).toBe("split");
  });

  test("a concurrent CLI edit becomes a conflict: :keep saves ours over it, then :apply takes theirs", async () => {
    const box = sandbox("tui-conflict");
    await seedTasks(box.env, ["conflict task", "-b", "base text"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    let mark = pty.mark();
    await keys(pty, ":", ..."edit", "\r", TAB);
    await expectPlain(pty, "1 base text", mark);
    await keys(pty, "i");
    // Keep typing while the CLI edits the same body, so the draft is dirty when the change arrives.
    mark = pty.mark();
    const first = await typeWhile(pty, "y", runCli({ args: ["edit", "1", "-b", "cli text"], env: box.env }));
    expect(first.code, first.stderr).toBe(0);
    await expectPlain(pty, "conflict", mark);
    await keys(pty, "\x1b", ":", ..."keep", "\r");
    const kept = await waitForBody(box.env, 1, b => b?.endsWith("base text") === true && b.startsWith("y"));
    expect(kept).toMatch(/^y+base text$/);
    // Again, then take theirs.
    await keys(pty, "i");
    mark = pty.mark();
    const second = await typeWhile(pty, "z", runCli({ args: ["edit", "1", "-b", "second cli text"], env: box.env }));
    expect(second.code, second.stderr).toBe(0);
    await expectPlain(pty, "conflict", mark);
    mark = pty.mark();
    await keys(pty, "\x1b", ":", ..."apply", "\r");
    await expectPlain(pty, "1 second cli text", mark);
    await Bun.sleep(1000);
    expect((await readTask(box.env, 1)).body).toBe("second cli text");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });

  test("VISUAL LINE in Edit: V j y writes exactly ONE OSC 52 whose base64 decodes to those two lines", async () => {
    const box = sandbox("tui-visual-yank");
    await seedTasks(box.env, ["visual task", "-b", "first line\nsecond line\nthird line"]);
    const pty = spawnPty([BIN, "tui", "1"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    let mark = pty.mark();
    await keys(pty, ":", ..."edit", "\r", TAB);
    await expectPlain(pty, "1 first line", mark);
    mark = pty.mark();
    await keys(pty, "V");
    await expectPlain(pty, "VISUAL LINE", mark);
    mark = pty.mark();
    await keys(pty, "j", "y");
    await expectPlain(pty, /Copied 2 lines \(23 bytes\) with OSC 52; unconfirmed/, mark);
    const writes = [...pty.output().matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g)];
    expect(writes.length).toBe(1);
    expect(Buffer.from(writes[0]?.[1] ?? "", "base64").toString("utf8")).toBe("first line\nsecond line\n");
    // A yank never edits: :q quits with nothing unsaved.
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect((await readTask(box.env, 1)).body).toBe("first line\nsecond line\nthird line");
  });

  test("VISUAL in Edit: v + motions + d removes the text through autosave, and u restores it", async () => {
    const box = sandbox("tui-visual-delete");
    await seedTasks(box.env, ["visual delete", "-b", "keep this remove me\nsecond"]);
    const pty = spawnPty([BIN, "tui", "1"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    let mark = pty.mark();
    await keys(pty, ":", ..."edit", "\r", TAB);
    await expectPlain(pty, "1 keep this remove me", mark);
    mark = pty.mark();
    await keys(pty, "w", "w", "v");
    await expectPlain(pty, "VISUAL", mark);
    await keys(pty, "e", "l", "e", "d");
    expect(await waitForBody(box.env, 1, b => b === "keep this \nsecond")).toBe("keep this \nsecond");
    await keys(pty, "u");
    expect(await waitForBody(box.env, 1, b => b === "keep this remove me\nsecond")).toBe("keep this remove me\nsecond");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });
});

describe("the terminal reader in a real terminal (plan @400 Task 10)", () => {
  const LONG = [
    "# Intro",
    "",
    ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of the long document.\n`),
    "## Risks",
    "",
    "first risks",
    "",
    "## Risks",
    "",
    "second risks",
  ].join("\n");

  test("--heading opens at that heading (the shared slugger and repeat numbering); { } step headings; Ctrl-o returns", async () => {
    const box = sandbox("tui-reader-heading");
    await seedTasks(box.env, ["long doc", "-b", LONG]);
    const pty = spawnPty([BIN, "tui", "1", "--heading", "#task-1-risks-2"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "§ Risks 3/3");
    await expectPlain(pty, "second risks");
    let mark = pty.mark();
    await keys(pty, "{");
    await expectPlain(pty, "§ Risks 2/3", mark);
    mark = pty.mark();
    await keys(pty, "{");
    await expectPlain(pty, "§ Intro 1/3", mark);
    mark = pty.mark();
    await keys(pty, "}");
    await expectPlain(pty, "§ Risks 2/3", mark);
    // Ctrl-o (:back) includes heading jumps: back to where the last one started.
    mark = pty.mark();
    await keys(pty, "\x0f");
    await expectPlain(pty, "§ Intro 1/3", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });

  test("with the document focused, / searches its rendered text (not the list) and n/N step the matches", async () => {
    const box = sandbox("tui-reader-search");
    await seedTasks(
      box.env,
      ["searched doc", "-b", "A **needle** here.\n\nMore text.\n\nThe second needle."],
      ["other task"],
    );
    const pty = spawnPty([BIN, "tui", "1"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "A needle here.");
    const searched = pty.mark();
    let mark = searched;
    await keys(pty, TAB, "/", ..."needle", "\r");
    await expectPlain(pty, "/needle: match 1 of 2", mark);
    await expectPlain(pty, "/needle 1/2", mark);
    mark = pty.mark();
    await keys(pty, "n");
    await expectPlain(pty, "/needle 2/2", mark);
    mark = pty.mark();
    await keys(pty, "N");
    await expectPlain(pty, "/needle 1/2", mark);
    // The task list was not filtered by the document search (a filtered list would repaint its count).
    expect(plainText(pty.output().slice(searched))).not.toContain("1 shown");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });

  test("an @id reference in the prose jumps to its task and clears the list filters (web ref parity)", async () => {
    const box = sandbox("tui-reader-ref");
    await seedTasks(box.env, ["ref source", "-b", "See @2 for the plan."], ["ref target"]);
    const pty = spawnPty([BIN, "tui", "1"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    let mark = pty.mark();
    // Filter the list so the target is hidden, then follow the reference from the document.
    await keys(pty, "/", ..."source", "\r");
    await expectPlain(pty, "1 shown", mark);
    mark = pty.mark();
    await keys(pty, TAB, "\r");
    await expectPlain(pty, "LINKS IN @1", mark);
    mark = pty.mark();
    await keys(pty, "\r");
    await expectPlain(pty, "@2 · now", mark);
    await expectPlain(pty, "no filters", mark);
    await expectPlain(pty, "2 shown", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });

  test("Split's preview renders the DRAFT while typing, and the editor keeps its cursor (no remount)", async () => {
    const box = sandbox("tui-reader-split");
    await seedTasks(box.env, ["split preview task"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 130, rows: 32 });
    await ready(pty);
    let mark = pty.mark();
    await keys(pty, ":", ..."split", "\r", TAB, "i");
    await expectPlain(pty, "INSERT", mark);
    mark = pty.mark();
    pty.write("**bold** words");
    // The preview renders the unsaved draft: the emphasis without its asterisks.
    await expectPlain(pty, "bold words", mark);
    mark = pty.mark();
    pty.write(" more");
    await expectPlain(pty, "bold words more", mark);
    pty.write("\x1b:wq\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    const r = await runCli({ args: ["show", "1", "--json"], env: box.env });
    expect((JSON.parse(r.stdout) as { task: { body: string } }).task.body).toBe("**bold** words more");
  });

  test("Split's preview follows the editor's cursor: G in the editor brings the end of a long document into the preview", async () => {
    const box = sandbox("tui-split-follow");
    // The preview renders `**Para n** end` as `Para n end`; the editor shows the asterisks.
    const body = Array.from({ length: 60 }, (_, i) => `**Para ${i + 1}** end`).join("\n\n");
    await seedTasks(box.env, ["long split task", "-b", body]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 130, rows: 32 });
    await ready(pty);
    let mark = pty.mark();
    await keys(pty, ":", ..."split", "\r", TAB);
    await expectPlain(pty, "Para 1 end", mark);
    expect(plainText(pty.output().slice(mark))).not.toContain("Para 60 end");
    mark = pty.mark();
    await keys(pty, "G");
    await expectPlain(pty, "Para 60 end", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });

  test("VISUAL LINE in Read: V j y copies the rendered rows as plain text (no Markdown, no control bytes)", async () => {
    const box = sandbox("tui-visual-read");
    await seedTasks(box.env, ["visual read", "-b", "1. alpha **bold**\n2. beta `code`\n3. gamma"]);
    // 112 columns: 110 plus the comfortable status line's two margin cells (the message is cut at the same place).
    const pty = spawnPty([BIN, "tui", "1"], { env: box.tuiEnv, cols: 112, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "alpha bold");
    let mark = pty.mark();
    await keys(pty, TAB, "V");
    await expectPlain(pty, "VISUAL LINE", mark);
    mark = pty.mark();
    await keys(pty, "j", "y");
    // (The status line cuts the rest of the message at this width.)
    await expectPlain(pty, /Copied 2 rendered rows \(27 bytes\) with OSC 52; unconfirm/, mark);
    const writes = [...pty.output().matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g)];
    expect(writes.length).toBe(1);
    expect(Buffer.from(writes[0]?.[1] ?? "", "base64").toString("utf8")).toBe("1. alpha bold\n2. beta code\n");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });
});

describe("activity and the update composer in a real terminal (plan @400 Task 11)", () => {
  const PI_AUTHOR = "pi-0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  type Shown = { updates: { author: string; summary: string }[] };
  const readUpdates = async (env: Record<string, string>, id: number): Promise<Shown["updates"]> => {
    const r = await runCli({ args: ["show", String(id), "--json"], env });
    expect(r.code, r.stderr).toBe(0);
    return (JSON.parse(r.stdout) as Shown).updates;
  };

  test("c opens the composer; :q keeps the draft (marked); reopened, :w posts it as a human; CLI show and Activity (newest first) see it", async () => {
    const box = sandbox("tui-composer");
    await seedTasks(box.env, ["compose here"]);
    const older = await runCli({ args: ["update", "1", "-m", "older agent note", "--as", PI_AUTHOR], env: box.env });
    expect(older.code, older.stderr).toBe(0);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "compose here");
    let mark = pty.mark();
    await keys(pty, "c");
    await expectPlain(pty, "Post an update", mark);
    await expectPlain(pty, "0/4096", mark);
    // INSERT: j, q and : are text, never keys.
    await keys(pty, ..."first post: j q");
    await expectPlain(pty, "15/4096", mark);
    mark = pty.mark();
    await keys(pty, "\x1b");
    pty.write(":q\r");
    await expectPlain(pty, "✎ Unsent update (15/4096)", mark);
    await expectPlain(pty, "✎ 1 unsent", mark);
    expect(await readUpdates(box.env, 1)).toHaveLength(1); // closing never posts
    // Reopened, the draft is still there; :w posts it (explicit submit only).
    mark = pty.mark();
    await keys(pty, "c");
    await expectPlain(pty, "first post: j q", mark);
    await keys(pty, "\x1b");
    mark = pty.mark();
    pty.write(":w\r");
    await expectPlain(pty, "Posted an update to @1", mark);
    // A second client (the CLI, same sandbox and daemon) sees it after the older note, from a human author.
    const updates = await readUpdates(box.env, 1);
    expect(updates.map(u => u.summary)).toEqual(["older agent note", "first post: j q"]);
    const author = updates[1]?.author ?? "";
    expect(author).not.toBe("");
    expect(author.startsWith("pi-")).toBe(false);
    // The composer closed onto the Activity panel: newest first.
    await expectPlain(pty, /ACTIVITY · 2 · newest first[\s\S]*first post: j q[\s\S]*older agent note/, mark);
    expect(plainText(pty.output().slice(mark))).not.toContain("Unsent update (");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });

  test("the application :q refuses while a composer draft is unsent and names it; :q! discards it and quits", async () => {
    const box = sandbox("tui-composer-guard");
    await seedTasks(box.env, ["guarded"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    let mark = pty.mark();
    await keys(pty, ";", "c");
    await expectPlain(pty, "Post an update", mark);
    await keys(pty, ..."not yet");
    await keys(pty, "\x1b", "q"); // Esc, then q in its NORMAL mode, is :q: closed, draft kept
    await expectPlain(pty, "✎ Unsent update (7/4096)", mark);
    mark = pty.mark();
    pty.write(":q\r");
    await expectPlain(pty, "Not quitting: unsent update for @1", mark);
    expect(pty.running()).toBe(true);
    pty.write(":q!\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
    expect(await readUpdates(box.env, 1)).toEqual([]);
  });
});

describe("pane focus, sorting and fast filters in a real terminal", () => {
  test("NO_COLOR: the unfocused pane is SGR dim, the focused label inverse, and Tab moves the dim", async () => {
    const box = sandbox("tui-pane-dim");
    await seedTasks(box.env, ["alpha one", "--body", "hello body text"], ["alpha two"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 120, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "hello body text");
    // The list has the focus: an inverse label and plain rows; the document is dim.
    expect(pty.output()).toMatch(/\x1b\[1;7m TASKS /);
    expect(pty.output()).toMatch(/\x1b\[2m[^\x1b]*hello body text/);
    expect(pty.output()).not.toMatch(/\x1b\[2m[^\x1b]*alpha two/);
    const mark = pty.mark();
    await keys(pty, TAB);
    // Tab: the dim moves to the list; the document's label turns inverse and its text plain.
    await pty.expect(/\x1b\[2m[^\x1b]*alpha two/, { from: mark });
    await pty.expect(/\x1b\[1;7m READ /, { from: mark });
    expect(pty.output().slice(mark)).toMatch(/\x1b\[2m TASKS /);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });

  test("f opens the filter picker: one key narrows the list live, Enter keeps it, F clears every filter", async () => {
    const box = sandbox("tui-fast-filters");
    await seedTasks(box.env, ["alpha one"], ["alpha two", "-s", "review"], ["beta three", "-s", "review"], ["gamma"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 120, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "4 shown");
    await expectPlain(pty, "no filters · f picks · / search");
    let mark = pty.mark();
    await keys(pty, "f");
    await expectPlain(pty, "FILTERS", mark);
    await expectPlain(pty, "4 tasks shown · no filters", mark);
    mark = pty.mark();
    await keys(pty, "r");
    // The list behind narrows at once; the picker's count follows.
    await expectPlain(pty, "2 shown", mark);
    await expectPlain(pty, "2 tasks shown · status:review", mark);
    mark = pty.mark();
    await keys(pty, "\r");
    await expectPlain(pty, /NORMAL\s+│ tasks/, mark);
    expect(plainText(pty.output().slice(mark))).not.toContain("FILTERS");
    mark = pty.mark();
    await keys(pty, "F");
    await expectPlain(pty, "4 shown", mark);
    await expectPlain(pty, "no filters · f picks", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });

  test(";d shows and hides the done tasks in one key; the list header says +done while they are shown", async () => {
    const box = sandbox("tui-toggle-done");
    await seedTasks(box.env, ["alpha one"], ["shipped thing", "-s", "done"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 120, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "1 shown");
    expect(plainText(pty.output())).not.toContain("shipped thing");
    let mark = pty.mark();
    await keys(pty, ";", "d");
    await expectPlain(pty, "shipped thing", mark);
    await expectPlain(pty, "2 shown", mark);
    await expectPlain(pty, "+done", mark);
    await expectPlain(pty, "Showing done tasks (;d hides them)", mark);
    mark = pty.mark();
    await keys(pty, ";", "d");
    await expectPlain(pty, "1 shown", mark);
    await expectPlain(pty, "Hiding done tasks (;d shows them)", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });

  test("/ in the help searches the help, never the list: n steps through its matches; Esc closes it", async () => {
    const box = sandbox("tui-help-search");
    await seedTasks(box.env, ["alpha one"], ["beta two"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 110, rows: 32 });
    await ready(pty);
    await expectPlain(pty, "beta two");
    let mark = pty.mark();
    await keys(pty, "?");
    await expectPlain(pty, "CORTEX TERMINAL WORKSPACE \u00b7 help", mark);
    mark = pty.mark();
    await keys(pty, "/", ..."picker", "\r");
    await expectPlain(pty, /\/picker: match 1 of \d+/, mark);
    mark = pty.mark();
    await keys(pty, "n");
    await expectPlain(pty, /\/picker: match 2 of \d+/, mark);
    mark = pty.mark();
    await keys(pty, "\x1b");
    // Back in the workspace, the list is unfiltered: the help's search never reached it. (The list header was never
    // under the help box, so it is not redrawn; the rows under the box are, with both tasks.)
    await expectPlain(pty, "alpha one", mark);
    await expectPlain(pty, "beta two", mark);
    await expectPlain(pty, "no filters \u00b7 f picks \u00b7 / search", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });

  test(":sort and :group reorder the list; the header names them; a search ranks by relevance", async () => {
    const box = sandbox("tui-sort-group");
    await seedTasks(box.env, ["zeta first"], ["alpha second", "-s", "review"], ["mid third"]);
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv, cols: 120, rows: 32 });
    await ready(pty);
    // The @id column is as wide as the widest id, then two spaces.
    await expectPlain(pty, /sort id[\s\S]*@1 {2}zeta first[\s\S]*@2 {2}alpha second[\s\S]*@3 {2}mid third/);
    let mark = pty.mark();
    await keys(pty, ":", ..."sort title", "\r");
    await expectPlain(pty, "sort title", mark);
    mark = pty.mark();
    await keys(pty, ":", ..."group status", "\r");
    await expectPlain(pty, /Open · 2[\s\S]*In review · 1/, mark);
    mark = pty.mark();
    await keys(pty, "/", ..."third", "\r");
    await expectPlain(pty, "by relevance (search)", mark);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });
});

describe("the mouse in a real terminal (SGR 1006 reports; N19: optional, on by default)", () => {
  /**
   * The screen as the renderer last drew it: it writes each changed row whole
   * (`CSI row;1H CSI 2K` then the row), so replaying those writes in order
   * gives every row's current plain text (single-width text here, so string
   * index = cell).
   */
  function screenOf(raw: string, rows: number): string[] {
    const screen = Array.from({ length: rows }, () => "");
    const writes = [...raw.matchAll(/\x1b\[2J|\x1b\[(\d+);1H\x1b\[2K/g)];
    writes.forEach((write, i) => {
      if (write[1] === undefined) {
        screen.fill("");
        return;
      }
      const start = (write.index ?? 0) + write[0].length;
      const end = writes[i + 1]?.index ?? raw.length;
      const row = Number(write[1]) - 1;
      if (row >= 0 && row < rows) screen[row] = plainText(raw.slice(start, end));
    });
    return screen;
  }
  /** Where `needle` first shows on the current screen, at or right of column `minX`: [x, y], zero-based. */
  const locate = (pty: Pty, rows: number, needle: string, minX = 0): [number, number] => {
    const screen = screenOf(pty.output(), rows);
    for (const [y, line] of screen.entries()) {
      const x = line.indexOf(needle, minX);
      if (x >= 0) return [x, y];
    }
    throw new Error(`${JSON.stringify(needle)} is not on screen:\n${screen.join("\n")}`);
  };
  const report = (code: number, [x, y]: readonly [number, number], final: "M" | "m" = "M") =>
    `\x1b[<${code};${x + 1};${y + 1}${final}`;

  test("mouse on: click the Edit tab, drag over two words, y copies exactly them (ONE OSC 52); :q turns the mouse off", async () => {
    const box = sandbox("tui-mouse");
    await seedTasks(box.env, ["mouse task", "-b", "alpha beta gamma\nsecond line"]);
    const cols = 120;
    const rows = 32;
    const pty = spawnPty([BIN, "tui", "1"], { env: box.tuiEnv, cols, rows });
    await ready(pty);
    let mark = await expectPlain(pty, "alpha beta gamma");
    const start = pty.output();
    expect(start).toContain(MOUSE_ON);
    expect(start).not.toContain("\x1b[?1003h"); // never any-motion tracking
    // The document header's tabs: a click on Edit is :edit.
    const edit = locate(pty, rows, "Edit ;i");
    await keys(pty, report(0, edit), report(0, edit, "m"));
    await expectPlain(pty, "1 alpha beta gamma", mark);
    const [x, y] = locate(pty, rows, "alpha", 40);
    mark = pty.mark();
    await keys(pty, report(0, [x, y]), report(32, [x + 4, y]), report(32, [x + 9, y]), report(0, [x + 9, y], "m"));
    await expectPlain(pty, "VISUAL", mark);
    mark = pty.mark();
    await keys(pty, "y");
    await expectPlain(pty, /Copied .* with OSC 52; unconfirmed/, mark);
    const writes = [...pty.output().matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g)];
    expect(writes.length).toBe(1);
    expect(Buffer.from(writes[0]?.[1] ?? "", "base64").toString("utf8")).toBe("alpha beta");
    // An unsupported report (a horizontal wheel, an extra button) is ignored; the session goes on.
    await keys(pty, report(66, [x, y]), report(128, [x, y]), "\x1b[<0;0;0M");
    mark = pty.mark();
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expectMouseOff(pty.output().slice(mark));
    expect(isCooked(pty.localFlags())).toBe(true);
    // The click chose Edit like :edit does: the saved preference.
    const state = JSON.parse(fs.readFileSync(`${box.env.XDG_CONFIG_HOME}/cortex/tui/default.state.json`, "utf8")) as {
      view: { mode?: string };
    };
    expect(state.view.mode).toBe("edit");
  });

  test("one wheel notch sent as three reports in ONE read (Ghostty's default mouse-scroll-multiplier) moves the list one task", async () => {
    const box = sandbox("tui-wheel");
    await seedTasks(
      box.env,
      ["wheel one", "-b", "notchbody-1"],
      ["wheel two", "-b", "notchbody-2"],
      ["wheel three", "-b", "notchbody-3"],
      ["wheel four", "-b", "notchbody-4"],
    );
    const rows = 32;
    const pty = spawnPty([BIN, "tui", "1"], { env: box.tuiEnv, cols: 120, rows });
    await ready(pty);
    await expectPlain(pty, "notchbody-1");
    const list = locate(pty, rows, "wheel three");
    const notch = async (code: 64 | 65, shows: string, never: readonly string[]) => {
      const mark = pty.mark();
      pty.write(report(code, list).repeat(3)); // one write: the TUI reads the notch's reports together
      await expectPlain(pty, shows, mark);
      // The notch's frames are drawn (none shows a task past it); the wait also outlasts a notch, so the next is new.
      await Bun.sleep(150);
      const after = plainText(pty.output().slice(mark));
      for (const body of never) expect(after).not.toContain(body);
    };
    await notch(65, "notchbody-2", ["notchbody-3", "notchbody-4"]);
    await notch(65, "notchbody-3", ["notchbody-4"]);
    await notch(64, "notchbody-2", ["notchbody-1"]);
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
  });

  test("mouse = false in tui.toml: no mouse reporting is ever enabled", async () => {
    const box = sandbox("tui-nomouse");
    await seed(box.env, "keyboard only");
    fs.mkdirSync(`${box.env.XDG_CONFIG_HOME}/cortex`, { recursive: true });
    fs.writeFileSync(`${box.env.XDG_CONFIG_HOME}/cortex/tui.toml`, "mouse = false\n");
    const pty = spawnPty([BIN, "tui"], { env: box.tuiEnv });
    await ready(pty);
    await pty.expect("keyboard only");
    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    for (const on of ["\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h", "\x1b[?1006h"])
      expect(pty.output()).not.toContain(on);
  });
});
