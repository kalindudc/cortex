/**
 * `cortex resume <task-id>` — re-open the pi session or bb thread that
 * posted updates on a task.
 *
 * Positional input is RESTRICTED to a positive integer (a task id) — never
 * an author tag — to eliminate the injection surface that would exist if
 * `cortex resume <some-string>` shelled out with the string in argv.
 *
 * Flow:
 *   1. Validate the id (positive integer; `Number.parseInt` + `>0`).
 *   2. Read the task and its updates through withClient (mirrors
 *      `src/commands/show.ts`: the verified daemon, or offline under the
 *      ownership lease), released BEFORE any picker prompt or pi runs.
 *   3. Missing task → `task <id> not found`, exit 1.
 *   4. Aggregate updates by author (count, lastSeen, lastSummary).
 *   5. Filter to harness-attributable tags: the first dash splits off the
 *      harness, `pi` with a strict uuidv7 suffix or `bb` with a thread id.
 *   6. Dispatch:
 *        0 candidates → stderr + exit 1
 *        1 candidate  → auto-resume (announce on stderr, exec)
 *        N candidates → fzf-or-readline picker (no fzf path: line-numbered
 *                       prompt). Cancel → exit 0 silently.
 *   7. Selected author → `pi --session <id>`, or for bb `$BB_CLI` (else
 *      `bb`) `thread open <id>`, as an argument array with stdio inherited. ENOENT → friendly message + exit 1. Otherwise
 *      propagate child exit code.
 *
 * Deliberately does NOT:
 *   - chdir or scan `~/.pi/agent/sessions/`
 *   - accept author-tag input
 *   - add new Store methods
 *   - hold the database (lease or daemon request) while picking or running pi
 */

import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { type Candidate, harnessCommand, missingProgramMessage, resumeCandidates } from "../lib/resume.ts";
import { readTaskOrExit } from "./show.ts";

/** Pure-TS relative-time helper. No date library. */
function rel(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Multi-candidate picker via fzf when available, else readline. Returns
 * the chosen Candidate or null on cancel / out-of-range.
 */
async function pickCandidate(cands: Candidate[]): Promise<Candidate | null> {
  const fzfPath = Bun.which("fzf");
  if (fzfPath) {
    return pickWithFzf(fzfPath, cands);
  }
  return pickWithReadline(cands);
}

async function pickWithFzf(fzfPath: string, cands: Candidate[]): Promise<Candidate | null> {
  const child = spawn(fzfPath, ["--ansi", "--prompt=resume> ", "--height=40%", "--reverse", "--no-multi"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const lines = cands
    .map((c, i) => `${i}\t${c.author}\t×${c.count}\tlast ${rel(c.lastSeen)}\t"${truncate(c.lastSummary, 60)}"`)
    .join("\n");
  child.stdin.write(`${lines}\n`);
  child.stdin.end();

  const chunks: Buffer[] = [];
  child.stdout.on("data", (b: Buffer) => chunks.push(b));

  const exitCode = await new Promise<number>(resolve => {
    child.on("close", code => resolve(code ?? 0));
  });

  if (exitCode !== 0) return null;
  const out = Buffer.concat(chunks).toString("utf8").trim();
  if (!out) return null;
  const fields = out.split("\t");
  const idx = Number.parseInt(fields[0] ?? "", 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= cands.length) return null;
  return cands[idx] ?? null;
}

async function pickWithReadline(cands: Candidate[]): Promise<Candidate | null> {
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (!c) continue;
    console.error(`[${i + 1}] ${c.author}  ×${c.count}  last ${rel(c.lastSeen)}  "${truncate(c.lastSummary, 60)}"`);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const answer: string = await new Promise(resolve => {
    rl.question(`select [1-${cands.length}] (Enter to cancel): `, ans => {
      rl.close();
      resolve(ans);
    });
  });
  const trimmed = answer.trim();
  if (trimmed === "") return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > cands.length) return null;
  return cands[n - 1] ?? null;
}

/**
 * Spawn `pi --session <id>` or `$BB_CLI thread open <id>` (else `bb`) with stdio inherited. Never returns.
 *
 * Bun's `child_process.spawn` (under `bun build --compile`) raises ENOENT
 * synchronously rather than via the `error` event, so we guard with a
 * try/catch AND keep the async handler for non-Bun runtimes (test runs
 * via `bun run` and the production binary both go through the sync path).
 */
function execHarness(c: Candidate): void {
  const { program, argv } = harnessCommand(c, process.env);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(program, argv, { stdio: "inherit" });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || /not found/i.test(e.message ?? "")) {
      console.error(missingProgramMessage(c, program));
    } else {
      console.error(e.message ?? String(err));
    }
    process.exit(1);
  }
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      console.error(missingProgramMessage(c, program));
    } else {
      console.error(err.message);
    }
    process.exit(1);
  });
  child.on("exit", code => {
    process.exit(code ?? 0);
  });
}

export default defineCommand({
  meta: {
    name: "resume",
    description:
      "open the pi session or bb thread that posted updates on a task. Picks interactively when there are several.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      valueHint: "task-id",
      description: "task id (see `cortex ls`)",
    },
  },
  async run({ args }) {
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id) || id <= 0 || String(id) !== args.id.trim()) {
      console.error("error: id must be a positive integer");
      process.exit(1);
    }

    const { updates } = await readTaskOrExit(id);
    const cands = resumeCandidates(updates);

    if (cands.length === 0) {
      console.error(`cortex resume: no resumable harness sessions in updates for task ${id}`);
      process.exit(1);
    }

    if (cands.length === 1) {
      const c = cands[0];
      if (!c) {
        process.exit(1);
      }
      console.error(`→ resuming ${c.author} (last update ${rel(c.lastSeen)})`);
      execHarness(c);
      return;
    }

    const chosen = await pickCandidate(cands);
    if (!chosen) {
      process.exit(0);
    }
    execHarness(chosen);
  },
});
