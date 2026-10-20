// desktop/agents.ts — the main process's checked agent tools: only three
// fixed argvs ever run, the CLI's JSON comes back parsed, and one install or
// reset runs at a time.

import { describe, expect, test } from "bun:test";
import {
  AGENTS_ARGV,
  type AgentsDeps,
  type CortexRun,
  createAgents,
  interpret,
  parseAgentsRequest,
} from "../../../src/desktop/agents.ts";
import type { AgentsResult, AgentsStatus } from "../../../src/lib/agentTools.ts";

const STATUS: AgentsStatus = {
  version: "0.2.0",
  skills: [{ name: "cortex", dir: "/s/cortex", state: "installed", differs: [] }],
  extensions: [],
  skipped: [{ name: "pi", reason: "pi not found" }],
  bb: { state: "skipped", reason: "bb not found" },
  suggest: "none",
};

const RESULT: AgentsResult = {
  skills: [{ name: "cortex", dir: "/s/cortex" }],
  extensions: [],
  skipped: [],
  bb: { status: "failed", dir: "/b", reason: "npm not found" },
};

const ok = (value: unknown, code = 0): CortexRun => ({ code, stdout: `${JSON.stringify(value)}\n`, stderr: "" });

function fake(answer: (argv: readonly string[]) => Promise<CortexRun>) {
  const runs: Array<{ argv: readonly string[]; timeoutMs: number }> = [];
  const deps: AgentsDeps = {
    run: (argv, timeoutMs) => {
      runs.push({ argv, timeoutMs });
      return answer(argv);
    },
  };
  return { agents: createAgents(deps), runs };
}

describe("parseAgentsRequest", () => {
  test("accepts exactly the three actions", () => {
    for (const action of ["status", "install", "reset"] as const) {
      expect(parseAgentsRequest({ action })).toEqual({ action });
    }
  });

  test("rejects anything else, including extra argv smuggled in", () => {
    for (const bad of [null, "status", ["status"], {}, { action: "remove" }, { action: 1 }, { action: "status --x" }]) {
      expect(parseAgentsRequest(bad)).toBeNull();
    }
    expect(parseAgentsRequest({ action: "status", argv: ["rm"] })).toEqual({ action: "status" });
  });
});

describe("interpret", () => {
  test("a status or install result comes back parsed, even when a failed bb plugin exited 1", () => {
    expect(interpret("status", ok(STATUS))).toEqual({ ok: true, action: "status", status: STATUS });
    expect(interpret("install", ok(RESULT, 1))).toEqual({ ok: true, action: "install", result: RESULT });
  });

  test("the CLI's error envelope, output that is not JSON and an unexpected shape are failures", () => {
    expect(interpret("reset", ok({ error: { code: "error", message: "EACCES: permission denied" } }, 1))).toEqual({
      ok: false,
      error: "EACCES: permission denied",
    });
    expect(interpret("status", { code: null, stdout: "", stderr: "spawn cortex ENOENT" })).toEqual({
      ok: false,
      error: "cortex agents status --json failed (exit none): spawn cortex ENOENT",
    });
    expect(interpret("status", { code: 0, stdout: "✓ skill cortex", stderr: "" })).toEqual({
      ok: false,
      error: "cortex agents status --json printed something other than JSON",
    });
    expect(interpret("status", ok(RESULT))).toMatchObject({ ok: false });
    expect(interpret("install", ok(STATUS))).toMatchObject({ ok: false });
    expect(interpret("install", ok([1]))).toMatchObject({ ok: false });
  });
});

describe("createAgents", () => {
  test("runs only the action's fixed argv, with reset never prompting", async () => {
    const { agents, runs } = fake(async argv => ok(argv[1] === "status" ? STATUS : RESULT));
    await agents({ action: "status" });
    await agents({ action: "install" });
    await agents({ action: "reset" });
    expect(runs.map(r => r.argv)).toEqual([AGENTS_ARGV.status, AGENTS_ARGV.install, AGENTS_ARGV.reset]);
    expect(AGENTS_ARGV.reset).toEqual(["agents", "reset", "--force", "--json"]);
    expect(runs[1]?.timeoutMs).toBeGreaterThan(runs[0]?.timeoutMs ?? 0);
  });

  test("an invalid request runs nothing", async () => {
    const { agents, runs } = fake(async () => ok(STATUS));
    expect(await agents({ action: "uninstall" })).toEqual({ ok: false, error: "invalid agents request" });
    expect(runs).toEqual([]);
  });

  test("one install or reset at a time; a check may run meanwhile, and a finished one frees the slot", async () => {
    let release: (run: CortexRun) => void = () => {};
    const { agents, runs } = fake(argv =>
      argv[1] === "status" ? Promise.resolve(ok(STATUS)) : new Promise(resolve => (release = resolve)),
    );
    const first = agents({ action: "install" });
    expect(await agents({ action: "reset" })).toEqual({
      ok: false,
      error: "an agent tools install is already running",
    });
    expect((await agents({ action: "status" })).ok).toBe(true);
    release(ok(RESULT, 1));
    expect((await first).ok).toBe(true);
    const second = agents({ action: "reset" });
    release(ok(RESULT));
    expect((await second).ok).toBe(true);
    expect(runs.map(r => r.argv[1])).toEqual(["install", "status", "reset"]);
  });

  test("a runner that throws is an answer, and frees the slot", async () => {
    let calls = 0;
    const { agents } = fake(async () => {
      calls++;
      if (calls === 1) throw new Error("cortex binary is missing");
      return ok(RESULT);
    });
    expect(await agents({ action: "install" })).toEqual({ ok: false, error: "cortex binary is missing" });
    expect((await agents({ action: "install" })).ok).toBe(true);
  });
});
