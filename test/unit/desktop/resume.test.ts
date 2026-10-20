// desktop/resume.ts — the main process's checked resume.

import { describe, expect, test } from "bun:test";
import { parseResumeRequest, type ResumeDeps, resume } from "../../../src/desktop/resume.ts";
import type { Update } from "../../../src/store.ts";

const PI = "pi-01923f3a-9201-7c0e-b1c8-abcdef012345";
const BB = "bb-thr_2qj8qzdqqr";
const UPDATES: Update[] = [PI, BB, "alice"].map((author, i) => ({
  id: i + 1,
  task_id: 5,
  author,
  summary: `by ${author}`,
  body: null,
  severity: "progress",
  created: i,
}));

function fake(over: Partial<ResumeDeps> = {}) {
  const runs: Array<{ program: string; argv: string[] }> = [];
  const copies: string[] = [];
  const reads: number[] = [];
  const deps: ResumeDeps = {
    updates: async id => {
      reads.push(id);
      return id === 5 ? UPDATES : [];
    },
    run: async (program, argv) => {
      runs.push({ program, argv });
      return { code: 0, missing: false };
    },
    copy: text => copies.push(text),
    env: {},
    ...over,
  };
  return { deps, runs, copies, reads };
}

describe("parseResumeRequest", () => {
  test("accepts a positive safe integer id and a 1 to 80 character author", () => {
    expect(parseResumeRequest({ taskId: 5, author: BB })).toEqual({ taskId: 5, author: BB });
    expect(parseResumeRequest({ taskId: 5, author: "a".repeat(80) })).not.toBeNull();
  });

  test("rejects everything else", () => {
    for (const bad of [
      null,
      "5",
      [5, BB],
      { taskId: "5", author: BB },
      { taskId: 0, author: BB },
      { taskId: -1, author: BB },
      { taskId: 1.5, author: BB },
      { taskId: 2 ** 53, author: BB },
      { taskId: 5, author: "" },
      { taskId: 5, author: "a".repeat(81) },
      { taskId: 5, author: 7 },
      { taskId: 5 },
    ]) {
      expect(parseResumeRequest(bad)).toBeNull();
    }
  });
});

describe("resume", () => {
  test("a bad request reads nothing and runs nothing", async () => {
    const { deps, runs, reads } = fake();
    expect(await resume(deps, { taskId: "5", author: BB })).toEqual({ ok: false, error: "invalid resume request" });
    expect(await resume(deps, { taskId: 5, author: "x".repeat(81) })).toMatchObject({ ok: false });
    expect(reads).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("an author that is not a candidate on the task is refused", async () => {
    const { deps, runs, copies } = fake();
    for (const author of ["alice", "bb-thr_otherthread", `${BB};rm -rf /`]) {
      const result = await resume(deps, { taskId: 5, author });
      expect(result.ok).toBe(false);
    }
    // A well-formed author on another task.
    expect((await resume(deps, { taskId: 6, author: BB })).ok).toBe(false);
    expect(runs).toEqual([]);
    expect(copies).toEqual([]);
  });

  test("bb runs `thread open <id>` through bb, or BB_CLI when set", async () => {
    const plain = fake();
    expect(await resume(plain.deps, { taskId: 5, author: BB })).toEqual({ ok: true, harness: "bb", author: BB });
    expect(plain.runs).toEqual([{ program: "bb", argv: ["thread", "open", "thr_2qj8qzdqqr"] }]);

    const shim = fake({ env: { BB_CLI: "/tmp/bb-shim" } });
    await resume(shim.deps, { taskId: 5, author: BB });
    expect(shim.runs).toEqual([{ program: "/tmp/bb-shim", argv: ["thread", "open", "thr_2qj8qzdqqr"] }]);
  });

  test("a missing program and a non-zero exit are errors", async () => {
    const missing = fake({ env: { BB_CLI: "/no/bb" }, run: async () => ({ code: null, missing: true }) });
    expect(await resume(missing.deps, { taskId: 5, author: BB })).toEqual({
      ok: false,
      error: "/no/bb not found; set BB_CLI or install bb",
    });
    const failed = fake({ run: async () => ({ code: 7, missing: false }) });
    expect(await resume(failed.deps, { taskId: 5, author: BB })).toEqual({
      ok: false,
      error: "bb thread open exited with status 7",
    });
  });

  test("pi copies `pi --session <uuid>` and runs nothing", async () => {
    const { deps, runs, copies } = fake();
    const command = "pi --session 01923f3a-9201-7c0e-b1c8-abcdef012345";
    expect(await resume(deps, { taskId: 5, author: PI })).toEqual({ ok: true, harness: "pi", author: PI, command });
    expect(copies).toEqual([command]);
    expect(runs).toEqual([]);
  });

  test("a failed read becomes an error answer, never a throw", async () => {
    const { deps } = fake({
      updates: async () => {
        throw new Error("daemon unreachable");
      },
    });
    expect(await resume(deps, { taskId: 5, author: BB })).toEqual({ ok: false, error: "daemon unreachable" });
  });
});
