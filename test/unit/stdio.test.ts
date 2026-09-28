import { describe, expect, test } from "bun:test";
import { routeConsoleThroughStreams } from "../../src/stdio.ts";

// The real-pipe behaviour is certified by test/integration/cli/large-output.test.ts;
// this pins the routing and the console.log-compatible formatting.

function fixture() {
  const out: string[] = [];
  const err: string[] = [];
  const noop = (..._args: unknown[]): void => {};
  const target = { log: noop, info: noop, warn: noop, error: noop };
  routeConsoleThroughStreams(
    target,
    { write: (chunk: string) => out.push(chunk) },
    { write: (chunk: string) => err.push(chunk) },
  );
  return { target, out, err };
}

describe("routeConsoleThroughStreams", () => {
  test("log and info write one newline-terminated chunk to stdout", () => {
    const { target, out, err } = fixture();
    target.log("hello", 42);
    target.info({ a: 1 });
    expect(out).toEqual(["hello 42\n", "{ a: 1 }\n"]);
    expect(err).toEqual([]);
  });

  test("warn and error go to stderr", () => {
    const { target, out, err } = fixture();
    target.warn("careful");
    target.error("error: %s", "boom");
    expect(err).toEqual(["careful\n", "error: boom\n"]);
    expect(out).toEqual([]);
  });

  test("a large payload is handed to the stream whole, never split by the router", () => {
    const { target, out } = fixture();
    const big = "x".repeat(200_000);
    target.log(big);
    expect(out).toEqual([`${big}\n`]);
  });

  test("an empty call prints an empty line like console.log", () => {
    const { target, out } = fixture();
    target.log();
    expect(out).toEqual(["\n"]);
  });
});
