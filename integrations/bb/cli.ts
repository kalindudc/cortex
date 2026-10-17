import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export type CortexRunOptions = { cwd?: string; signal?: AbortSignal; timeoutMs?: number };

export type CortexRunner = {
  binary: string;
  run<T>(args: readonly string[], schema: z.ZodType<T>, options?: CortexRunOptions): Promise<T>;
  /** Plain stdout, for the agent-facing text cortex renders itself (`memory show`, `memory search`). */
  text(args: readonly string[], options?: CortexRunOptions): Promise<string>;
};

export type CortexCliErrorCode = "missing" | "outdated" | "timeout" | "exit" | "json" | "shape";

export class CortexCliError extends Error {
  readonly code: CortexCliErrorCode;
  constructor(code: CortexCliErrorCode, message: string) {
    super(message);
    this.name = "CortexCliError";
    this.code = code;
  }
}

export const DEFAULT_TIMEOUT_MS = 5_000;
// Task bodies and update trails are bounded by cortex, so 16 MiB is far above any real answer.
const MAX_BUFFER = 16 * 1024 * 1024;

const errorEnvelope = z.object({ error: z.object({ message: z.string() }).passthrough() });
const schemaCommands = z.object({ commands: z.array(z.object({ name: z.string() }).passthrough()) }).passthrough();

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The cortex executable: the configured path when one is set (never a silent
 * fallback past it), else the first `cortex` in an absolute PATH directory,
 * `~/bin` or `~/.local/bin`. Null when none is executable.
 */
export function resolveCortexBinary(configuredPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME || os.homedir();
  const configured = configuredPath.trim().replace(/^~(?=\/|$)/, home);
  if (configured) return path.isAbsolute(configured) && isExecutableFile(configured) ? configured : null;
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir));
  const candidates = [...dirs, path.join(home, "bin"), path.join(home, ".local", "bin")].map(dir =>
    path.join(dir, "cortex"),
  );
  return candidates.find(isExecutableFile) ?? null;
}

function failureMessage(stdout: string, stderr: string): string | null {
  try {
    const parsed = errorEnvelope.safeParse(JSON.parse(stdout));
    if (parsed.success) return parsed.data.error.message;
  } catch {
    // Not JSON: fall back to stderr.
  }
  return stderr.trim() || stdout.trim() || null;
}

export async function createCortexRunner(
  configuredPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CortexRunner> {
  const found = resolveCortexBinary(configuredPath, env);
  if (found === null) {
    throw new CortexCliError(
      "missing",
      configuredPath.trim()
        ? `cortexPath ${JSON.stringify(configuredPath.trim())} is not an executable file (use an absolute path)`
        : "cortex was not found on PATH, in ~/bin or in ~/.local/bin",
    );
  }
  const binary: string = found;
  /** stdout of one bounded run; every failure (exit, timeout, abort, spawn) rejects with a typed error. */
  function exec(args: readonly string[], options: CortexRunOptions): Promise<string> {
    const what = `cortex ${args.slice(0, 2).join(" ")}`;
    return new Promise<string>((resolve, reject) => {
      execFile(
        binary,
        [...args],
        {
          cwd: options.cwd,
          env,
          signal: options.signal,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
            return;
          }
          const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          if (err.name === "AbortError" || options.signal?.aborted) {
            reject(new CortexCliError("timeout", `${what} was aborted`));
          } else if (err.code === "ENOENT") {
            reject(new CortexCliError("missing", `cannot run ${binary}${options.cwd ? ` in ${options.cwd}` : ""}`));
          } else if (err.killed) {
            reject(new CortexCliError("timeout", `${what} timed out`));
          } else {
            const detail =
              failureMessage(stdout, stderr) ?? (err.signal ? `killed by ${err.signal}` : `exit ${String(err.code)}`);
            reject(new CortexCliError("exit", `${what} failed: ${detail}`));
          }
        },
      );
    });
  }

  return {
    binary,
    async run<T>(args: readonly string[], schema: z.ZodType<T>, options: CortexRunOptions = {}): Promise<T> {
      const what = `cortex ${args.slice(0, 2).join(" ")}`;
      const stdout = await exec(args, options);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new CortexCliError("json", `${what} printed unreadable JSON`);
      }
      const envelope = errorEnvelope.safeParse(parsed);
      if (envelope.success) throw new CortexCliError("exit", `${what} failed: ${envelope.data.error.message}`);
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw new CortexCliError("shape", `${what} printed an unexpected shape: ${result.error.message}`);
      }
      return result.data;
    },
    text: (args, options = {}) => exec(args, options),
  };
}

/**
 * Throws `outdated` unless this cortex has `watch` and author streams (both
 * added for bb). Read-only: one schema call and one bounded streams query.
 */
export async function verifyCortexFeatures(runner: CortexRunner): Promise<void> {
  const schema = await runner.run(["schema", "--json"], schemaCommands);
  if (!schema.commands.some(command => command.name === "watch")) {
    throw new CortexCliError("outdated", `${runner.binary} has no \`cortex watch\`; install a newer cortex`);
  }
  try {
    await runner.run(["memory", "streams", "--author=bb-plugin-check", "--limit=1", "--json"], z.array(z.unknown()));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CortexCliError("outdated", `${runner.binary} cannot list author streams (${detail}); install a newer cortex`);
  }
}
