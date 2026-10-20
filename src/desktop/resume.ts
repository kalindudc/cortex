// The desktop's resume, run by the main process for `cortex:resume`. The
// renderer names a task and an author; main re-reads that task's updates
// itself and acts only for an author in resumeCandidates(updates), so the
// window can never make it run anything else. A bb thread opens through
// `bb thread open <id>` (argv only, no shell); a pi session needs a
// terminal, which a window does not have, so its command is copied to the
// clipboard instead. Never imports electron: main passes the effects in.

import { harnessCommand, type HarnessEnv, missingProgramMessage, resumeCandidates } from "../lib/resume.ts";
import type { Update } from "../store.ts";

export type ResumeResult =
  | { ok: true; harness: "bb"; author: string }
  | { ok: true; harness: "pi"; author: string; command: string }
  | { ok: false; error: string };

export interface ResumeRequest {
  taskId: number;
  author: string;
}

export interface ResumeDeps {
  /** The task's updates, read by main over its own daemon connection. */
  updates(taskId: number): Promise<Update[]>;
  /** Run `program` with `argv` and no shell; `missing` when the program does not exist. */
  run(program: string, argv: string[]): Promise<{ code: number | null; missing: boolean }>;
  copy(text: string): void;
  env: HarnessEnv;
}

const MAX_AUTHOR = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseResumeRequest(raw: unknown): ResumeRequest | null {
  if (!isRecord(raw)) return null;
  const { taskId, author } = raw;
  if (typeof taskId !== "number" || !Number.isSafeInteger(taskId) || taskId <= 0) return null;
  if (typeof author !== "string" || author.length < 1 || author.length > MAX_AUTHOR) return null;
  return { taskId, author };
}

/** Resume the session behind `raw`; every failure is a `{ ok: false }` answer, never a throw. */
export async function resume(deps: ResumeDeps, raw: unknown): Promise<ResumeResult> {
  const request = parseResumeRequest(raw);
  if (request === null) return { ok: false, error: "invalid resume request" };
  try {
    const candidate = resumeCandidates(await deps.updates(request.taskId)).find(c => c.author === request.author);
    if (candidate === undefined) {
      return { ok: false, error: `${request.author} has no resumable session on task ${request.taskId}` };
    }
    const { program, argv } = harnessCommand(candidate, deps.env);
    if (candidate.harness === "pi") {
      const command = [program, ...argv].join(" ");
      deps.copy(command);
      return { ok: true, harness: "pi", author: candidate.author, command };
    }
    const { code, missing } = await deps.run(program, argv);
    if (missing) return { ok: false, error: missingProgramMessage(candidate, program) };
    if (code !== 0) return { ok: false, error: `bb thread open exited with status ${code ?? "unknown"}` };
    return { ok: true, harness: "bb", author: candidate.author };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
