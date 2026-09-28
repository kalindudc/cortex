// Real pseudo-terminal harness for the TUI integration tests (plan @400 G4,
// N24): `Bun.spawn(argv, { terminal })`, no python3.
//
// - Output is drained CONTINUOUSLY through the terminal's `data` callback, so
//   the child never blocks on a full PTY buffer. (A harness that stopped
//   reading made the prototype's app block and receive `Esc` and `:` merged
//   into one Alt pair.)
// - Every wait is bounded and fails with the tail of the output.
// - Termios is read from the PARENT (`terminal.localFlags`) after the child
//   exited, which works because the PTY keeps the child's last settings; a
//   SIGKILLed child leaves raw flags behind, which is the negative control
//   proving the check can fail.
// - Every PTY spawned here is tracked; `reapPtys()` SIGKILLs any child still
//   running (only processes this module started) and closes the terminals.

import type { Subprocess } from "bun";
import { ROOT } from "../helpers.ts";

/** termios c_lflag bits (darwin/BSD and Linux differ). */
export const LFLAG =
  process.platform === "darwin" ? { ECHO: 0x8, ISIG: 0x80, ICANON: 0x100 } : { ECHO: 0x8, ISIG: 0x1, ICANON: 0x2 };

/** ICANON, ECHO and ISIG are all on: a line-editing shell terminal. */
export function isCooked(localFlags: number): boolean {
  return (localFlags & LFLAG.ICANON) !== 0 && (localFlags & LFLAG.ECHO) !== 0 && (localFlags & LFLAG.ISIG) !== 0;
}

/** ICANON, ECHO and ISIG are all off: a raw-mode program owns the terminal. */
export function isRaw(localFlags: number): boolean {
  return (localFlags & (LFLAG.ICANON | LFLAG.ECHO | LFLAG.ISIG)) === 0;
}

export interface PtyOptions {
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  cwd?: string;
  /**
   * Answers to terminal queries: whenever the child writes a key, the reply
   * is typed back once per occurrence (for example DSR 996 -> a light report).
   */
  replies?: Record<string, string>;
}

export interface Exit {
  code: number | null;
  signal: string | null;
}

export interface Pty {
  readonly proc: Subprocess;
  readonly terminal: Bun.Terminal;
  /** Everything the child wrote so far. */
  output(): string;
  /** The current output length, to wait for something written after now. */
  mark(): number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Wait until `pattern` appears at or after `from`; resolves with the offset just past the match. */
  expect(pattern: string | RegExp, options?: { from?: number; timeoutMs?: number }): Promise<number>;
  /** Wait (bounded) for the child to exit. */
  exited(timeoutMs?: number): Promise<Exit>;
  /** termios c_lflag as the parent sees it (the PTY keeps the child's last settings). */
  localFlags(): number;
  kill(signal?: NodeJS.Signals): void;
  running(): boolean;
  /** A short printable tail of the output, for failure messages. */
  tail(chars?: number): string;
}

const MAX_OUTPUT = 16 * 1024 * 1024;
const live = new Set<Pty>();

function printable(text: string): string {
  return JSON.stringify(text);
}

export function spawnPty(argv: string[], options: PtyOptions): Pty {
  const decoder = new TextDecoder();
  let out = "";
  const replies = Object.entries(options.replies ?? {});
  const answered = new Map<string, number>(replies.map(([query]) => [query, 0]));
  let terminalRef: Bun.Terminal | null = null;
  const proc = Bun.spawn(argv, {
    cwd: options.cwd ?? ROOT,
    env: options.env,
    terminal: {
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      name: options.env.TERM ?? "xterm-256color",
      data(terminal, data) {
        out += decoder.decode(data, { stream: true });
        if (out.length > MAX_OUTPUT) out = out.slice(out.length - MAX_OUTPUT);
        for (const [query, reply] of replies) {
          const seen = out.split(query).length - 1;
          const done = answered.get(query) ?? 0;
          for (let i = done; i < seen; i++) terminal.write(reply);
          answered.set(query, seen);
        }
      },
    },
  });
  const terminal = proc.terminal;
  if (terminal === undefined) throw new Error("Bun.spawn did not create a terminal");
  terminalRef = terminal;

  const tail = (chars = 600): string => printable(out.slice(-chars));
  const running = (): boolean => proc.exitCode === null && proc.signalCode === null;

  const pty: Pty = {
    proc,
    terminal,
    output: () => out,
    mark: () => out.length,
    write(data) {
      terminal.write(data);
    },
    resize(cols, rows) {
      terminal.resize(cols, rows);
    },
    async expect(pattern, opts = {}) {
      const from = opts.from ?? 0;
      const timeoutMs = opts.timeoutMs ?? 10_000;
      const deadline = Date.now() + timeoutMs;
      const find = (): number | null => {
        const rest = out.slice(from);
        if (typeof pattern === "string") {
          const at = rest.indexOf(pattern);
          return at < 0 ? null : from + at + pattern.length;
        }
        const m = pattern.exec(rest);
        return m ? from + m.index + m[0].length : null;
      };
      let goneSince: number | null = null;
      for (;;) {
        const found = find();
        if (found !== null) return found;
        if (!running()) {
          // Gone: allow the last chunks to drain, then fail fast instead of waiting out the deadline.
          goneSince ??= Date.now();
          if (Date.now() - goneSince > 200) {
            throw new Error(
              `the process exited (${proc.signalCode ?? proc.exitCode}) before ${String(pattern)}; output tail: ${tail()}`,
            );
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`timed out after ${timeoutMs}ms waiting for ${String(pattern)}; output tail: ${tail()}`);
        }
        await Bun.sleep(10);
      }
    },
    async exited(timeoutMs = 10_000) {
      const outcome = await Promise.race([
        proc.exited.then(() => "exited" as const),
        Bun.sleep(timeoutMs).then(() => "timeout" as const),
      ]);
      if (outcome === "timeout")
        throw new Error(`the process did not exit within ${timeoutMs}ms; output tail: ${tail()}`);
      // Let the last chunks drain through the data callback.
      await Bun.sleep(50);
      return { code: proc.exitCode, signal: proc.signalCode };
    },
    localFlags: () => terminalRef?.localFlags ?? 0,
    kill(signal = "SIGTERM") {
      if (running()) proc.kill(signal);
    },
    running,
    tail,
  };
  live.add(pty);
  return pty;
}

/** SIGKILL every PTY child still running and close every terminal this module opened. */
export async function reapPtys(): Promise<void> {
  for (const pty of live) {
    if (pty.running()) pty.proc.kill("SIGKILL");
    await Promise.race([pty.proc.exited, Bun.sleep(5000)]);
    try {
      pty.terminal.close();
    } catch {
      /* already closed */
    }
  }
  live.clear();
}
