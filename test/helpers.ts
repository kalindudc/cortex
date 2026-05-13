import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

// Shared CLI-spawn isolation for every test that spawns the cortex CLI.
//
// Why this exists (Plan 15 root cause):
//   commands/{add,update,edit,mv,rm,lane}.ts call daemonUrl() (client.ts:21)
//   BEFORE Store.open(). daemonUrl() reads ~/.config/cortex/cortex.{pid,url}
//   via pidPath()/urlPath() (paths.ts:25-37); configDir() (paths.ts:9-12)
//   only honors XDG_CONFIG_HOME. When tests set CORTEX_DB but not
//   XDG_CONFIG_HOME, the live daemon is detected, the HTTP early-return
//   fires, and CORTEX_DB is never consulted -- mutations land in the user's
//   production DB.
//
// Three env vars MUST always be pinned, in order of importance:
//   1. XDG_CONFIG_HOME -- closes the daemon-routing escape hatch
//   2. CORTEX_DB       -- pins SQLite file even on the no-daemon path
//   3. CORTEX_SKILL_DIR -- keeps init/reset from clobbering ~/.agents/skills/
//
// Defense in depth: this module DELETES inherited XDG_CONFIG_HOME /
// CORTEX_DB / CORTEX_SKILL_DIR from the env it builds before assigning,
// so a developer with these set in their shell can't make a test silently
// re-target the wrong place. We never spread + overwrite (an empty-string
// XDG_CONFIG_HOME from the parent shell still defeats the ?? in paths.ts:9).

export const ROOT: string = path.resolve(import.meta.dir, "..");
export const BIN: string = path.join(ROOT, "bin/cortex");

// Top-level guard: fail loudly with an actionable message if the binary is
// missing. `task test` (Taskfile.yml) depends on `task build`, so under the
// canonical run path this is unreachable. The throw exists so that running
// `bun test` directly in a fresh checkout produces a clear next-step.
if (!fs.existsSync(BIN)) {
  throw new Error(
    `bin/cortex missing -- run \`task build\` (or \`task test\` which builds first)`,
  );
}

export type RunResult = { code: number; stdout: string; stderr: string };

export type RunOpts = {
  args: string[];
  env: Record<string, string>;
  stdin?: string;
};

/**
 * Build a hermetic env that points cortex at a fresh tmp dir for its
 * config, DB, and skill output. The caller is responsible for invoking
 * `cleanup()` (typically from afterAll).
 *
 * `label` is folded into the tmp-dir basename for easier debugging when
 * multiple test files leave artefacts around mid-run.
 */
export function mkTmpEnv(label: string): {
  tmpDir: string;
  env: Record<string, string>;
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `cortex-${label}-${crypto.randomBytes(4).toString("hex")}-`),
  );
  const dbPath = path.join(tmpDir, "cortex.db");
  const skillDir = path.join(tmpDir, "skill");

  // Build env explicitly: shallow-copy parent env, DELETE the three keys we
  // care about (so an inherited "" or wrong path can't leak through), then
  // SET them to tmp paths. Spread + overwrite would not erase an inherited
  // empty string, which `?? path.join(homedir(), ".config")` treats as
  // truthy and silently routes to the user's real config dir.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.XDG_CONFIG_HOME;
  delete env.CORTEX_DB;
  delete env.CORTEX_SKILL_DIR;
  env.XDG_CONFIG_HOME = tmpDir;
  env.CORTEX_DB = dbPath;
  env.CORTEX_SKILL_DIR = skillDir;
  env.NO_COLOR = "1";

  const cleanup = () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { tmpDir, env, cleanup };
}

/**
 * Spawn the built `bin/cortex` binary with the supplied args/env. Returns
 * exit code, stdout, and stderr as strings. Optional stdin is piped in
 * before the process closes its input.
 *
 * We deliberately spawn the BINARY (not `bun cli.ts`) so binary-only
 * code paths are exercised -- e.g. the `/$bunfs/` argv handling in
 * commands/serve.ts:42 that is dead under `bun cli.ts`.
 */
export async function runCli(opts: RunOpts): Promise<RunResult> {
  const proc = Bun.spawn([BIN, ...opts.args], {
    env: opts.env,
    cwd: ROOT,
    stdin: opts.stdin !== undefined ? "pipe" : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (opts.stdin !== undefined) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}
