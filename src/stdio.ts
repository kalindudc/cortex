/**
 * Make the CLI's console output safe when it is larger than a pipe buffer.
 *
 * Bun 1.4.2 bug: once anything touches `process.stdout` (citty's consola does
 * at import time), fd 1 is switched to non-blocking. After that,
 * `console.log`, like `fs.writeSync(1, ...)`, issues a single write(2) that
 * stops at the pipe buffer (64 KiB on macOS) and silently DROPS the rest, and
 * `Bun.write(Bun.stdout, ...)` repeats the first chunk. Only the Node streams
 * (`process.stdout.write` / `process.stderr.write`) handle EAGAIN and drain
 * before a natural exit. Without this, `cortex show --json | jq` on a plan
 * body over 64 KiB was cut off mid-string.
 *
 * Routing the console methods through the streams fixes every call site at
 * once. The CLI entry installs it before any command runs. The real-pipe
 * regression test is test/integration/cli/large-output.test.ts. Remove this
 * once the pinned Bun writes console output completely to non-blocking
 * pipes (re-run that test on the new runtime first).
 */

import { format } from "node:util";

interface Writable {
  write(chunk: string): unknown;
}

interface ConsoleLike {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function routeConsoleThroughStreams(
  target: ConsoleLike = console,
  out: Writable = process.stdout,
  err: Writable = process.stderr,
): void {
  const toOut = (...args: unknown[]): void => {
    out.write(`${format(...args)}\n`);
  };
  const toErr = (...args: unknown[]): void => {
    err.write(`${format(...args)}\n`);
  };
  target.log = toOut;
  target.info = toOut;
  target.warn = toErr;
  target.error = toErr;
}
