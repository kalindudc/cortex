import { test, expect, describe, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitError, emitOk, printJson, resolveBody, ErrCode } from "../../src/output.ts";
import { BodySearchError, ConflictError, MutationReuseError, WriteGuardError } from "../../src/store.ts";
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

  // Every command now reaches the daemon's handlers (remote or in-process,
  // plan @400 N6), and some routes answer a missing task with 400 (e.g. PATCH
  // /lane). The message still names the miss, so it keeps the not_found code
  // and hint that the direct-Store path always gave it.
  test("HttpError without a code but a 'not found' message → not_found + hint, whatever the status", async () => {
    const r = await capture(() => {
      emitError(true, new HttpError(400, "task 99 not found"));
    });
    const env = JSON.parse(r.stdout[0] ?? "{}");
    expect(env.error.code).toBe(ErrCode.NOT_FOUND);
    expect(env.error.message).toBe("task 99 not found (run `cortex ls` to list tasks)");
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

// ---------- concurrency errors (plan @400 N8/N11) ----------

describe("emitError: guarded-write codes", () => {
  const code = async (err: unknown): Promise<string> => {
    const r = await capture(() => {
      emitError(true, err);
    });
    return JSON.parse(r.stdout[0] ?? "{}").error.code;
  };

  test("the new stable codes are exported", () => {
    expect(ErrCode.VERSION_CONFLICT).toBe("version_conflict");
    expect(ErrCode.INVALID_GUARD).toBe("invalid_guard");
    expect(ErrCode.MUTATION_REUSED).toBe("mutation_reused");
    expect(ErrCode.INSTANCE_MISMATCH).toBe("instance_mismatch");
  });

  test("server codes pass through; code-less 412/421 map by status", async () => {
    expect(await code(new HttpError(412, "stale", "version_conflict"))).toBe(ErrCode.VERSION_CONFLICT);
    expect(await code(new HttpError(409, "reused", "mutation_reused"))).toBe(ErrCode.MUTATION_REUSED);
    expect(await code(new HttpError(412, "stale"))).toBe(ErrCode.VERSION_CONFLICT);
    expect(await code(new HttpError(421, "other daemon"))).toBe(ErrCode.INSTANCE_MISMATCH);
  });

  test("Store guard errors classify without an HTTP hop (offline paths)", async () => {
    expect(await code(new ConflictError("task", 1, [{ scope: "body", expected: "a", current: "b" }], {}))).toBe(
      ErrCode.VERSION_CONFLICT,
    );
    expect(await code(new WriteGuardError("guard must be an object"))).toBe(ErrCode.INVALID_GUARD);
    expect(await code(new MutationReuseError("m-1"))).toBe(ErrCode.MUTATION_REUSED);
  });
});
