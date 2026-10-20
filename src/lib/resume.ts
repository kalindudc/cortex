// Resume candidates and the harness command for them, shared by
// `cortex resume` and the desktop app's main process.
// Only well-formed session ids ever reach a program's argv.

import type { Update } from "../store.ts";

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BB_THREAD_RE = /^thr_[0-9a-z]{6,40}$/;

export type Candidate = {
  author: string;
  harness: "pi" | "bb";
  sessionId: string;
  count: number;
  lastSeen: number;
  lastSummary: string;
};

/**
 * The task's resumable harness sessions, most recent first: updates
 * aggregated by author (count, lastSeen, lastSummary), kept only when the
 * first dash splits the tag into `pi` and a strict uuidv7 or `bb` and a
 * thread id. Defense in depth: only well-formed ids reach `spawn`. The
 * desktop app's resume action checks this before it hands a session over.
 */
export function resumeCandidates(updates: readonly Update[]): Candidate[] {
  const byAuthor = new Map<string, { count: number; lastSeen: number; lastSummary: string }>();
  for (const u of updates) {
    const prev = byAuthor.get(u.author);
    if (!prev || u.created > prev.lastSeen) {
      byAuthor.set(u.author, {
        count: (prev?.count ?? 0) + 1,
        lastSeen: u.created,
        lastSummary: u.summary,
      });
    } else {
      byAuthor.set(u.author, {
        count: prev.count + 1,
        lastSeen: prev.lastSeen,
        lastSummary: prev.lastSummary,
      });
    }
  }
  const cands: Candidate[] = [];
  for (const [author, agg] of byAuthor) {
    const dash = author.indexOf("-");
    if (dash <= 0) continue;
    const harness = author.slice(0, dash);
    const sessionId = author.slice(dash + 1);
    if (harness === "pi" && UUIDV7_RE.test(sessionId)) cands.push({ author, harness, sessionId, ...agg });
    else if (harness === "bb" && BB_THREAD_RE.test(sessionId)) cands.push({ author, harness, sessionId, ...agg });
  }
  cands.sort((a, b) => b.lastSeen - a.lastSeen);
  return cands;
}

export type HarnessEnv = Readonly<Record<string, string | undefined>>;

/** The program and argv that resume `c`: `$BB_CLI` (else `bb`) `thread open <id>`, or `pi --session <id>`. */
export function harnessCommand(c: Candidate, env: HarnessEnv): { program: string; argv: string[] } {
  return c.harness === "bb"
    ? { program: env.BB_CLI || "bb", argv: ["thread", "open", c.sessionId] }
    : { program: "pi", argv: ["--session", c.sessionId] };
}

/** The message for a harness program that is not installed. */
export function missingProgramMessage(c: Candidate, program: string): string {
  return c.harness === "bb"
    ? `${program} not found; set BB_CLI or install bb`
    : "pi not found in PATH; install @earendil-works/pi-coding-agent";
}
