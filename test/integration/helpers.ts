import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

// Shared CLI-spawn isolation for every test that spawns the cortex CLI.
//
// Why this exists (Plan 15 root cause, still load-bearing):
//   every normal command goes through daemon.ts withClient, which finds the
//   daemon serving the CONFIGURED database (CORTEX_DB, else configDir()'s
//   cortex.db; configDir() only honors XDG_CONFIG_HOME). Before the
//   database-scoped daemon, an older binary's cortex.pid/cortex.url alone routed every
//   mutation to whatever daemon they named, so a test that pinned CORTEX_DB
//   but not XDG_CONFIG_HOME wrote into the user's real DB. A test that pins
//   only some of these paths can still reach, or be blocked by, the
//   developer's real daemon or legacy files.
//
// Five env vars MUST always be pinned (plan @400 N24), in order of importance:
//   1. XDG_CONFIG_HOME         -- closes the daemon-routing escape hatch
//   2. CORTEX_DB               -- pins SQLite file even on the no-daemon path
//   3. XDG_RUNTIME_DIR         -- private 0700 dir for daemon sockets (src/paths.ts
//                                 runtimeDir()); kept SHORT so socket paths stay
//                                 under the ~104-byte AF_UNIX limit
//   4. CORTEX_SKILL_DIR        -- keeps init/reset from clobbering ~/.agents/skills/
//   5. CORTEX_PI_EXTENSION_DIR -- keeps init/reset from clobbering
//                                 ~/.pi/agent/extensions/
//
// Defense in depth: this module DELETES every inherited copy of the five
// keys from the env it builds before assigning, so a developer with these
// set in their shell can't make a test silently re-target the wrong place.
// We never spread + overwrite (an empty-string XDG_CONFIG_HOME from the
// parent shell still defeats the ?? in paths.ts:9).

export const ROOT: string = path.resolve(import.meta.dir, "../..");
export const BIN: string = path.join(ROOT, "bin/cortex");

// Top-level guard: fail loudly with an actionable message if the binary is
// missing. `pnpm test` runs `pnpm run build` first, so under the canonical
// run path this is unreachable. The throw exists so that running
// `bun test` directly in a fresh checkout produces a clear next-step.
if (!fs.existsSync(BIN)) {
  throw new Error(`bin/cortex missing -- run \`pnpm run build\` (or \`pnpm test\` which builds first)`);
}

export type RunResult = { code: number; stdout: string; stderr: string };

export type RunOpts = {
  args: string[];
  env: Record<string, string>;
  stdin?: string;
  /** Working directory (default: the repo root). Memory tests run inside a tmp git checkout. */
  cwd?: string;
};

const ISOLATED_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "CORTEX_DB",
  "CORTEX_SKILL_DIR",
  "CORTEX_PI_EXTENSION_DIR",
  // Dropped, never pinned: a bb thread's values would add a stray author or open a real thread.
  "BB_THREAD_ID",
  "BB_CLI",
] as const;

/**
 * Build a hermetic env that points cortex at a fresh tmp dir for its
 * config, DB, skill and pi-extension output, plus a separate fresh 0700
 * runtime dir. The caller is responsible for invoking `cleanup()`
 * (typically from afterAll), which removes both directories.
 *
 * `label` is folded into the tmp-dir basename for easier debugging when
 * multiple test files leave artefacts around mid-run. The runtime dir
 * deliberately does NOT carry the label: daemon sockets live there and the
 * AF_UNIX path limit (~104 bytes) leaves no room for long names.
 */
export function mkTmpEnv(label: string): {
  tmpDir: string;
  runtimeDir: string;
  env: Record<string, string>;
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cortex-${label}-${crypto.randomBytes(4).toString("hex")}-`));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxr-"));
  fs.chmodSync(runtimeDir, 0o700);

  // Build env explicitly: shallow-copy parent env, DELETE the five keys we
  // care about (so an inherited "" or wrong path can't leak through), then
  // SET them to tmp paths. Spread + overwrite would not erase an inherited
  // empty string, which `?? path.join(homedir(), ".config")` treats as
  // truthy and silently routes to the user's real config dir.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const key of ISOLATED_KEYS) delete env[key];
  env.XDG_CONFIG_HOME = tmpDir;
  env.XDG_RUNTIME_DIR = runtimeDir;
  env.CORTEX_DB = path.join(tmpDir, "cortex.db");
  env.CORTEX_SKILL_DIR = path.join(tmpDir, "skill");
  env.CORTEX_PI_EXTENSION_DIR = path.join(tmpDir, "ext");
  env.NO_COLOR = "1";

  const cleanup = () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  };

  return { tmpDir, runtimeDir, env, cleanup };
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
    cwd: opts.cwd ?? ROOT,
    stdin: opts.stdin !== undefined ? "pipe" : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (opts.stdin !== undefined) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}
