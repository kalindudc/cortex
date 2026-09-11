import { test, expect, describe, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitError, emitOk, printJson, resolveBody, ErrCode } from "../../src/output.ts";
import { BodySearchError } from "../../src/store.ts";
import { HttpError } from "../../src/client.ts";

/**
 * emitError/emitOk/resolveBody all touch console + process.exit. This helper
 * captures stdout/stderr and the exit code without terminating the test
 * runner: process.exit is mocked to throw a sentinel that we swallow.
 */
async function capture(
  fn: () => unknown,
): Promise<{ code?: number; stdout: string[]; stderr: string[]; result?: unknown }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation(((...a: unknown[]) => {
    stdout.push(a.join(" "));
  }) as never);
  const errSpy = spyOn(console, "error").mockImplementation(((...a: unknown[]) => {
    stderr.push(a.join(" "));
  }) as never);
  let code: number | undefined;
  const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
    code = c;
    throw new Error("__exit__");
  }) as never);
  let result: unknown;
  try {
    result = await fn();
  } catch (e) {
    if ((e as Error).message !== "__exit__") throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { code, stdout, stderr, result };
}

describe("emitOk", () => {
  test("json mode prints the object to stdout", async () => {
    const r = await capture(() => {
      emitOk(true, { id: 7, title: "x" }, "[7] x");
    });
    expect(r.stdout).toEqual(['{"id":7,"title":"x"}']);
    expect(r.code).toBeUndefined();
  });

  test("human mode prints the human line", async () => {
    const r = await capture(() => {
      emitOk(false, { id: 7 }, "[7] x");
    });
    expect(r.stdout).toEqual(["[7] x"]);
  });
});

describe("emitError classification", () => {
  test("BodySearchError(ambiguous) → code + matches in a stdout envelope, exit 1", async () => {
    const r = await capture(() => {
      emitError(true, new BodySearchError("ambiguous", "anchor matched 2 times", 2));
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout[0] ?? "{}")).toEqual({
      error: { code: ErrCode.BODY_SEARCH_AMBIGUOUS, message: "anchor matched 2 times", matches: 2 },
    });
  });

  test("BodySearchError(not_found) → body_search_not_found, no matches key", async () => {
    const r = await capture(() => {
      emitError(true, new BodySearchError("not_found", "anchor not found"));
    });
    const env = JSON.parse(r.stdout[0] ?? "{}");
    expect(env.error.code).toBe(ErrCode.BODY_SEARCH_NOT_FOUND);
    expect(env.error).not.toHaveProperty("matches");
  });

  test("HttpError with explicit code + matches passes them through", async () => {
    const r = await capture(() => {
      emitError(true, new HttpError(409, "matched 3 times", "body_search_ambiguous", 3));
    });
    expect(JSON.parse(r.stdout[0] ?? "{}")).toEqual({
      error: { code: ErrCode.BODY_SEARCH_AMBIGUOUS, message: "matched 3 times", matches: 3 },
    });
  });

  test("HttpError without a code falls back to the status→code map", async () => {
    const r = await capture(() => {
      emitError(true, new HttpError(400, "bad request"));
    });
    expect(JSON.parse(r.stdout[0] ?? "{}").error.code).toBe(ErrCode.BAD_REQUEST);
  });

  test("generic 'not found' Error → not_found code + actionable hint", async () => {
    const r = await capture(() => {
      emitError(true, new Error("task 99 not found"));
    });
    const env = JSON.parse(r.stdout[0] ?? "{}");
    expect(env.error.code).toBe(ErrCode.NOT_FOUND);
    expect(env.error.message).toContain("cortex ls");
  });

  test("other generic Error → generic code, no hint", async () => {
    const r = await capture(() => {
      emitError(true, new Error("boom"));
    });
    expect(JSON.parse(r.stdout[0] ?? "{}")).toEqual({ error: { code: ErrCode.GENERIC, message: "boom" } });
  });

  test("human mode writes 'error: <message>' to stderr and exits 1", async () => {
    const r = await capture(() => {
      emitError(false, new Error("boom"));
    });
    expect(r.stderr).toEqual(["error: boom"]);
    expect(r.stdout).toEqual([]);
    expect(r.code).toBe(1);
  });
});

describe("resolveBody", () => {
  test("returns the -b value when no --body-file", async () => {
    const r = await capture(() => resolveBody(false, "hello", undefined));
    expect(r.result).toBe("hello");
  });

  test("returns undefined when neither flag is set", async () => {
    const r = await capture(() => resolveBody(false, undefined, undefined));
    expect(r.result).toBeUndefined();
  });

  test("-b and --body-file together is a mutex error (exit 1)", async () => {
    const r = await capture(() => resolveBody(true, "x", "/tmp/whatever"));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout[0] ?? "{}").error.message).toContain("not both");
  });

  test("--body-file - reads stdin", async () => {
    const stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue("PIPED BODY");
    try {
      const r = await capture(() => resolveBody(false, undefined, "-"));
      expect(r.result).toBe("PIPED BODY");
    } finally {
      stdinSpy.mockRestore();
    }
  });

  test("--body-file <path> reads the file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-output-"));
    const p = path.join(dir, "body.md");
    fs.writeFileSync(p, "FILE BODY");
    try {
      const r = await capture(() => resolveBody(false, undefined, p));
      expect(r.result).toBe("FILE BODY");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("printJson", () => {
  test("prints single-line JSON", async () => {
    const r = await capture(() => {
      printJson({ a: 1, b: [2, 3] });
    });
    expect(r.stdout).toEqual(['{"a":1,"b":[2,3]}']);
  });
});
