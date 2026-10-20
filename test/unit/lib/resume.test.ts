// lib/resume.ts — resume candidates and the harness command, shared by
// `cortex resume` and the desktop main process.

import { describe, expect, test } from "bun:test";
import { type Candidate, harnessCommand, missingProgramMessage, resumeCandidates } from "../../../src/lib/resume.ts";
import type { Update } from "../../../src/store.ts";

const PI_ID = "01923f3a-9201-7c0e-b1c8-abcdef012345";
let nextId = 1;
const up = (author: string, created: number, summary = `at ${created}`): Update => ({
  id: nextId++,
  task_id: 1,
  author,
  summary,
  body: null,
  severity: "progress",
  created,
});

describe("resumeCandidates", () => {
  test("keeps pi with a strict uuidv7 and bb with a thread id, newest first, with counts", () => {
    const cands = resumeCandidates([
      up(`pi-${PI_ID}`, 10, "first"),
      up("bb-thr_2qj8qzdqqr", 20, "bb only"),
      up(`pi-${PI_ID}`, 30, "latest pi"),
      up(`pi-${PI_ID}`, 5, "older"),
      up("alice", 40),
    ]);
    expect(cands).toEqual([
      { author: `pi-${PI_ID}`, harness: "pi", sessionId: PI_ID, count: 3, lastSeen: 30, lastSummary: "latest pi" },
      {
        author: "bb-thr_2qj8qzdqqr",
        harness: "bb",
        sessionId: "thr_2qj8qzdqqr",
        count: 1,
        lastSeen: 20,
        lastSummary: "bb only",
      },
    ]);
  });

  test("rejects malformed ids and other harnesses", () => {
    const bad = [
      "pi-01923f3a-9201-4c0e-b1c8-abcdef012345", // uuid v4
      "pi-01923F3A-9201-7c0e-b1c8-abcdef012345", // upper case
      `pi-${PI_ID}x`,
      "bb-thr_abc", // too short
      "bb-thr_2qj8qzdqqr;rm",
      "bb-THR_2qj8qzdqqr",
      `codex-${PI_ID}`,
      "-thr_2qj8qzdqqr",
      "pi",
      "",
    ];
    expect(resumeCandidates(bad.map((a, i) => up(a, i)))).toEqual([]);
  });
});

describe("harnessCommand", () => {
  const bb: Candidate = {
    author: "bb-thr_2qj8qzdqqr",
    harness: "bb",
    sessionId: "thr_2qj8qzdqqr",
    count: 1,
    lastSeen: 0,
    lastSummary: "",
  };
  const pi: Candidate = {
    author: `pi-${PI_ID}`,
    harness: "pi",
    sessionId: PI_ID,
    count: 1,
    lastSeen: 0,
    lastSummary: "",
  };

  test("bb opens the thread through BB_CLI, else bb on PATH", () => {
    expect(harnessCommand(bb, {})).toEqual({ program: "bb", argv: ["thread", "open", "thr_2qj8qzdqqr"] });
    expect(harnessCommand(bb, { BB_CLI: "" })).toEqual({ program: "bb", argv: ["thread", "open", "thr_2qj8qzdqqr"] });
    expect(harnessCommand(bb, { BB_CLI: "/opt/bb" })).toEqual({
      program: "/opt/bb",
      argv: ["thread", "open", "thr_2qj8qzdqqr"],
    });
  });

  test("pi resumes the session, whatever BB_CLI says", () => {
    expect(harnessCommand(pi, { BB_CLI: "/opt/bb" })).toEqual({ program: "pi", argv: ["--session", PI_ID] });
  });

  test("missing-program messages", () => {
    expect(missingProgramMessage(bb, "/opt/bb")).toBe("/opt/bb not found; set BB_CLI or install bb");
    expect(missingProgramMessage(pi, "pi")).toBe("pi not found in PATH; install @earendil-works/pi-coding-agent");
  });
});
