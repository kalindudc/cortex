// Bridges from the terminal workspace to other programs.
//
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
import { selfCommand } from "../daemon.ts";
import { CommandError } from "./commands.ts";
import type { Update } from "../store.ts";
import type { TuiSession } from "./session.ts";

/** The side effects the bridges perform (tests replace them). */
export interface BridgeDeps {
  /** Run an interactive program on the terminal (inherited stdio); resolves with its exit status. */
  run(argv: readonly string[]): Promise<number>;
}

/** The shell convention: a program killed by a signal exits with 128 + its number. */
function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal !== null) return 128 + (os.constants.signals[signal] ?? 0);
  return code ?? 1;
}

const DEFAULTS: BridgeDeps = {
  run: async argv => {
    const child = Bun.spawn([...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    return exitStatus(code, child.signalCode);
  },
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
