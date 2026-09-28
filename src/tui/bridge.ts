// Bridges from the terminal workspace to other programs (plan @400 Task 10
// part B: N5, N20, N21).
//
// - openRichPreview (`:preview`): full-fidelity rendering (the web's DOMPurify
//   boundary, every tested Mermaid diagram type) lives in the browser. It
//   1. enables the loopback dashboard on the SAME verified daemon when that
//      daemon runs headless (its IPC-only control route, as `cortex open`
//      does; the TUI never starts a second daemon),
//   2. hands that daemon the EXACT text the terminal shows: the task's draft
//      (unsaved edits included), else its saved body. The daemon holds it as
//      a private preview (src/preview.ts: a random 128-bit token, 10 minutes,
//      1 MiB) and never writes it to the task,
//   3. reports the private URL in :messages (the browser may not open), and
//   4. starts the platform's URL opener with an argv (src/open-browser.ts
//      browserCommand; never a shell string), detached from the terminal, so
//      its output can never reach the screen; a failure is reported.
// - withExternalProgram: an interactive program (a resume or editor handoff)
//   gets the terminal through the shell's handoff: the same restore as
//   Ctrl-z, the program with inherited stdio, then the terminal is taken back
//   and redrawn. Resolves with the program's exit status.
// - resumeTask (`:resume`): the existing `cortex resume <id>` flow (it picks
//   the task's pi session, with fzf or a prompt when there are several, then
//   runs pi) through withExternalProgram, as this same binary's argv. It is
//   checked first (a task without a resumable pi session never takes the
//   terminal) and it never stops the daemon: `cortex resume` attaches to it.

import os from "node:os";
import { resumeCandidates } from "../commands/resume.ts";
import type { DaemonIdentity, PreviewCreated, PreviewRequest } from "../contracts.ts";
import { createPreview, enableWeb, selfCommand } from "../daemon.ts";
import { type BrowserCommand, browserCommand } from "../open-browser.ts";
import { CommandError } from "./commands.ts";
import type { Update } from "../store.ts";
import { safeUrl } from "./safety.ts";
import type { TuiSession } from "./session.ts";

/** The side effects the bridges perform (tests replace them). */
export interface BridgeDeps {
  /** Start (or report) the daemon's loopback dashboard; resolves with its identity including `webUrl`. */
  enableWeb(identity: DaemonIdentity): Promise<DaemonIdentity>;
  /** Hold one preview on the daemon (IPC control route). */
  createPreview(identity: DaemonIdentity, request: PreviewRequest): Promise<PreviewCreated>;
  /** The platform URL opener's argv. */
  browserCommand(url: string): BrowserCommand;
  /** Start a URL opener detached from the terminal (no inherited stdio); `exited` settles with its exit status. */
  launch(argv: readonly string[]): { exited: Promise<number> };
  /** Run an interactive program on the terminal (inherited stdio); resolves with its exit status. */
  run(argv: readonly string[]): Promise<number>;
}

/** The shell convention: a program killed by a signal exits with 128 + its number. */
function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal !== null) return 128 + (os.constants.signals[signal] ?? 0);
  return code ?? 1;
}

const DEFAULTS: BridgeDeps = {
  enableWeb: identity => enableWeb(identity),
  createPreview: (identity, request) => createPreview(identity, request),
  browserCommand: url => browserCommand(url),
  launch: argv => {
    const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref(); // quitting the TUI never waits for the opener
    return { exited: child.exited.then(code => exitStatus(code, child.signalCode)) };
  },
  run: async argv => {
    const child = Bun.spawn([...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    return exitStatus(code, child.signalCode);
  },
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** `webUrl` + the preview path as an http(s) URL on the dashboard's own origin, else null. */
function previewUrl(webUrl: string, previewPath: string): string | null {
  let base: URL;
  let url: URL;
  try {
    base = new URL(webUrl);
    url = new URL(previewPath, base);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== base.origin) return null;
  return safeUrl(url.href);
}

/**
 * `:preview`: show the selected task's EXACT current text (unsaved edits
 * included) rendered in full fidelity in the browser, through the same
 * daemon's loopback dashboard. Throws CommandError when nothing can be
 * previewed; a browser that does not open is reported, with the URL.
 */
export async function openRichPreview(session: TuiSession, deps: Partial<BridgeDeps> = {}): Promise<void> {
  const d: BridgeDeps = { ...DEFAULTS, ...deps };
  const task = session.selectedTask();
  if (task === null) throw new CommandError("No task selected: :open <id> picks one");
  let identity = session.identity;
  if (!(identity.capabilities ?? []).includes("control.preview")) {
    throw new CommandError(
      `The cortex daemon (pid ${identity.pid}) predates rich previews: restart it (quit every TUI, run cortex stop, then cortex) to use :preview`,
    );
  }
  // The text the terminal shows (the reader's rule): the draft, else the saved body.
  const draft = session.documentOf(task.id)?.draft ?? null;
  const request: PreviewRequest = {
    taskId: task.id,
    title: draft?.text("title") ?? task.title,
    source: draft?.text("body") ?? task.body ?? "",
    unsaved: draft !== null && draft.unsaved().length > 0,
  };

  let started = false;
  if (identity.webUrl === undefined) {
    try {
      identity = await d.enableWeb(identity);
    } catch (err) {
      throw new CommandError(`Could not start the dashboard for the preview: ${errorText(err)}`);
    }
    started = true;
  }
  const webUrl = identity.webUrl;
  if (webUrl === undefined) throw new CommandError("The daemon did not report its dashboard URL; try :preview again");

  let created: PreviewCreated;
  try {
    created = await d.createPreview(identity, request);
  } catch (err) {
    throw new CommandError(`No preview of @${task.id}: ${errorText(err)}`);
  }
  const url = previewUrl(webUrl, created.path);
  if (url === null) {
    throw new CommandError(
      `Not opening the preview: the dashboard URL ${JSON.stringify(webUrl)} is not a safe http(s) link`,
    );
  }

  const what = request.unsaved ? "unsaved draft" : "saved text";
  const dashboard = started ? `; started this daemon's dashboard at ${webUrl}` : "";
  session.notify(
    "info",
    `Rich preview of @${task.id} (${what}, ${formatBytes(created.bytes)}; private link, expires ${formatClock(created.expiresAt)}${dashboard}): ${url}`,
  );

  const yourself = `open the preview link yourself: ${url}`;
  const command = d.browserCommand(url);
  if (command.problem !== undefined) {
    session.notify("warn", `Could not open a browser (${command.problem}); ${yourself}`);
    return;
  }
  const opener = command.argv[0] ?? "the opener";
  let launched: { exited: Promise<number> };
  try {
    launched = d.launch(command.argv);
  } catch (err) {
    session.notify("warn", `Could not open a browser (${errorText(err)}); ${yourself}`);
    return;
  }
  launched.exited.then(
    code => {
      if (code !== 0) session.notify("warn", `The browser opener (${opener}) exited with ${code}; ${yourself}`);
    },
    (err: unknown) => session.notify("warn", `The browser opener (${opener}) failed (${errorText(err)}); ${yourself}`),
  );
}

/**
 * Run an interactive program on the terminal: the shell restores the
 * terminal as for a suspend, the program runs with inherited stdio (an argv,
 * never a shell string), then the shell takes the terminal back and redraws.
 * Resolves with the program's exit status; CommandError when it cannot run.
 */
export async function withExternalProgram(
  session: TuiSession,
  argv: readonly string[],
  deps: Partial<Pick<BridgeDeps, "run">> = {},
): Promise<number> {
  const program = [...argv];
  if (program.length === 0 || program.some(a => typeof a !== "string") || program[0] === "") {
    throw new CommandError("No program to run");
  }
  const run = deps.run ?? DEFAULTS.run;
  try {
    return await session.handOffTerminal(() => run(program));
  } catch (err) {
    if (err instanceof CommandError) throw err;
    throw new CommandError(`Could not run ${program[0]}: ${errorText(err)}`);
  }
}

/**
 * `:resume`: resume the pi session that posted on a task, through the
 * existing `cortex resume <id>` flow on the handed-over terminal. Refuses
 * (without taking the terminal) when no update came from a resumable
 * `pi-<uuidv7>` author; otherwise reports how it exited. `command` is the
 * argv that runs this cortex (default: this binary, or bun + its entry).
 */
export async function resumeTask(
  session: TuiSession,
  taskId: number,
  deps: Partial<Pick<BridgeDeps, "run">> & { command?: readonly string[] } = {},
): Promise<number> {
  let updates: Update[];
  try {
    updates = await session.client.updates(taskId);
  } catch (err) {
    throw new CommandError(`Could not read @${taskId}'s updates: ${errorText(err)}`);
  }
  if (resumeCandidates(updates).length === 0) {
    throw new CommandError(
      `No pi session to resume on @${taskId}: cortex resume needs an update posted by a pi-<session id> author`,
    );
  }
  const code = await withExternalProgram(session, [...(deps.command ?? selfCommand()), "resume", String(taskId)], deps);
  if (code === 0) session.notify("info", `Back from cortex resume @${taskId}`);
  else session.notify("warn", `cortex resume @${taskId} exited with status ${code}`);
  return code;
}
