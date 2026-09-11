/**
 * Shared CLI output + error contract for agent-first consumption.
 *
 * Every mutating command routes success through `emitOk` and failure through
 * `emitError` so the machine-readable surface is identical everywhere:
 *   - success + `--json`  -> the resulting object on stdout, exit 0
 *   - success (human)     -> the existing human line on stdout, exit 0
 *   - error + `--json`    -> `{ error: { code, message, matches? } }` on stdout, exit 1
 *   - error (human)       -> `error: <message>` on stderr, exit 1
 *
 * JSON always goes to stdout; diagnostics/human error text goes to stderr.
 * Exit codes stay 0 (success) / 1 (error) for back-compat — the machine
 * discriminator is the `code` field, never the exit code.
 */

import fs from "node:fs";
import { BodySearchError } from "./store.ts";
import { HttpError } from "./client.ts";

/** Stable machine-readable error codes surfaced in the `--json` error envelope. */
export const ErrCode = {
  NOT_FOUND: "not_found",
  BAD_REQUEST: "bad_request",
  VALIDATION: "validation",
  CONFLICT: "conflict",
  BODY_SEARCH_NOT_FOUND: "body_search_not_found",
  BODY_SEARCH_AMBIGUOUS: "body_search_ambiguous",
  GENERIC: "error",
} as const;

export type ErrCodeValue = (typeof ErrCode)[keyof typeof ErrCode];

type ErrorEnvelope = { error: { code: ErrCodeValue; message: string; matches?: number } };

/** Print a value as single-line JSON to stdout. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

/**
 * Emit a successful result. With `--json`, prints the structured object;
 * otherwise prints the human-readable line. stdout in both cases.
 */
export function emitOk(json: boolean, jsonValue: unknown, humanLine: string): void {
  if (json) {
    printJson(jsonValue);
    return;
  }
  console.log(humanLine);
}

/** Map an HTTP status to a stable error code when the server sent no `code`. */
function codeFromStatus(status: number): ErrCodeValue {
  if (status === 404) return ErrCode.NOT_FOUND;
  if (status === 409) return ErrCode.CONFLICT;
  if (status === 400) return ErrCode.BAD_REQUEST;
  return ErrCode.GENERIC;
}

/** Classify an arbitrary thrown value into the error envelope shape. */
function classify(err: unknown): { code: ErrCodeValue; message: string; matches?: number } {
  if (err instanceof BodySearchError) {
    return {
      code: err.kind === "not_found" ? ErrCode.BODY_SEARCH_NOT_FOUND : ErrCode.BODY_SEARCH_AMBIGUOUS,
      message: err.message,
      matches: err.matches,
    };
  }
  if (err instanceof HttpError) {
    const code = (err.code as ErrCodeValue | undefined) ?? codeFromStatus(err.status);
    return { code, message: err.message, matches: err.matches };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code = /not found/i.test(message) ? ErrCode.NOT_FOUND : ErrCode.GENERIC;
  return { code, message };
}

/**
 * Errors are documentation: append a next-step hint for the codes where a
 * recovery command is obvious. Kept minimal and idempotent (never doubles a
 * hint that the source message already carries).
 */
function withHint(code: ErrCodeValue, message: string): string {
  if (code === ErrCode.NOT_FOUND && !message.includes("cortex ls")) {
    return `${message} (run \`cortex ls\` to list tasks)`;
  }
  return message;
}

/**
 * Emit a failure and exit 1. With `--json`, prints the error envelope to
 * stdout; otherwise prints `error: <message>` to stderr.
 */
export function emitError(json: boolean, err: unknown): never {
  const { code, message, matches } = classify(err);
  const hinted = withHint(code, message);
  if (json) {
    const envelope: ErrorEnvelope = { error: { code, message: hinted } };
    if (matches !== undefined) envelope.error.matches = matches;
    printJson(envelope);
  } else {
    console.error(`error: ${hinted}`);
  }
  process.exit(1);
}

/**
 * True when the invocation asked to read the body from stdin. `--body-file=-`
 * binds the value "-" cleanly, but citty parses `--body-file -` as a
 * value-less flag and leaves the bare "-" as a loose argv token — so we scan
 * argv for the `--body-file -` pair as well. Precise (checks the token that
 * immediately follows the flag) to avoid matching an unrelated "-".
 */
function stdinRequested(bodyFile: string | undefined): boolean {
  if (bodyFile === "-") return true;
  const argv = process.argv;
  const i = argv.indexOf("--body-file");
  if (i >= 0 && argv[i + 1] === "-") return true;
  return argv.includes("--body-file=-");
}

/**
 * Resolve a task body from the `-b/--body` and `--body-file` flags.
 * `--body-file -` (or `--body-file=-`) reads stdin. Returns `undefined` when
 * neither flag is set (caller decides the no-op vs clear semantics). Enforces
 * the -b/--body-file mutual exclusion and routes read errors through
 * `emitError`.
 */
export async function resolveBody(
  json: boolean,
  body: string | undefined,
  bodyFile: string | undefined,
): Promise<string | undefined> {
  if (bodyFile !== undefined && body !== undefined) {
    emitError(json, new Error("use --body-file OR -b, not both"));
  }
  if (bodyFile !== undefined) {
    if (stdinRequested(bodyFile)) {
      return await Bun.stdin.text();
    }
    // citty leaves `--body-file` with no parseable value as boolean `true`;
    // guard so a value-less flag yields a clear message, not a readFileSync
    // type error.
    if (typeof bodyFile !== "string") {
      emitError(json, new Error("--body-file requires a path or - for stdin"));
    }
    try {
      return fs.readFileSync(bodyFile, "utf8");
    } catch (e) {
      emitError(json, new Error(`--body-file: ${(e as Error).message}`));
    }
  }
  return body;
}
