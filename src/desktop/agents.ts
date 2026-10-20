// The desktop's agent tools, run by the main process for `cortex:agents`. The
// renderer names only an action; main runs the app's own cortex with that
// action's fixed argv (no shell) and hands back its parsed `--json` output,
// so the window can never run anything else. One install or reset runs at a
// time. Never imports electron: main passes the runner in.

import type { AgentsAction, AgentsResult, AgentsStatus } from "../lib/agentTools.ts";

export interface AgentsRequest {
  action: AgentsAction;
}

export type AgentsReply =
  | { ok: true; action: "status"; status: AgentsStatus }
  | { ok: true; action: "install" | "reset"; result: AgentsResult }
  | { ok: false; error: string };

/** Reset never prompts here: the renderer asked the user before sending it. */
export const AGENTS_ARGV: Readonly<Record<AgentsAction, readonly string[]>> = {
  status: ["agents", "status", "--json"],
  install: ["agents", "install", "--json"],
  reset: ["agents", "reset", "--force", "--json"],
};

/** An install may run `npm ci` and a bb plugin build, each allowed several minutes by the CLI itself. */
export const AGENTS_TIMEOUT_MS: Readonly<Record<AgentsAction, number>> = {
  status: 60_000,
  install: 900_000,
  reset: 900_000,
};

export interface CortexRun {
  /** The exit code, or null when the program could not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface AgentsDeps {
  /** Run the app's cortex with `argv` and no shell; resolves with its output even when it fails. */
  run(argv: readonly string[], timeoutMs: number): Promise<CortexRun>;
}

const ACTIONS: ReadonlySet<string> = new Set(Object.keys(AGENTS_ARGV));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAgentsRequest(raw: unknown): AgentsRequest | null {
  if (!isRecord(raw) || typeof raw.action !== "string" || !ACTIONS.has(raw.action)) return null;
  return { action: raw.action as AgentsAction };
}

function failure(action: AgentsAction, out: CortexRun, why: string): AgentsReply {
  const stderr = out.stderr.trim();
  return { ok: false, error: `cortex ${AGENTS_ARGV[action].join(" ")} ${why}${stderr ? `: ${stderr}` : ""}` };
}

/** The CLI's answer: its JSON on stdout, which a failed bb plugin prints too (with exit 1). */
export function interpret(action: AgentsAction, out: CortexRun): AgentsReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    return failure(
      action,
      out,
      out.code === 0 ? "printed something other than JSON" : `failed (exit ${out.code ?? "none"})`,
    );
  }
  if (!isRecord(parsed)) return failure(action, out, "printed something other than an object");
  const error = parsed.error;
  if (isRecord(error) && typeof error.message === "string") return { ok: false, error: error.message };
  const bb = parsed.bb;
  if (!Array.isArray(parsed.skills) || !Array.isArray(parsed.extensions) || !isRecord(bb)) {
    return failure(action, out, "printed an unexpected result");
  }
  if (action === "status") {
    if (typeof bb.state !== "string" || typeof parsed.suggest !== "string") {
      return failure(action, out, "printed an unexpected result");
    }
    return { ok: true, action, status: parsed as unknown as AgentsStatus };
  }
  if (typeof bb.status !== "string") return failure(action, out, "printed an unexpected result");
  return { ok: true, action, result: parsed as unknown as AgentsResult };
}

/** The `cortex:agents` handler; every failure is a `{ ok: false }` answer, never a throw. */
export function createAgents(deps: AgentsDeps): (raw: unknown) => Promise<AgentsReply> {
  let writing: AgentsAction | null = null;
  return async raw => {
    const request = parseAgentsRequest(raw);
    if (request === null) return { ok: false, error: "invalid agents request" };
    const { action } = request;
    const writes = action !== "status";
    if (writes) {
      if (writing !== null) return { ok: false, error: `an agent tools ${writing} is already running` };
      writing = action;
    }
    try {
      return interpret(action, await deps.run(AGENTS_ARGV[action], AGENTS_TIMEOUT_MS[action]));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (writes) writing = null;
    }
  };
}
