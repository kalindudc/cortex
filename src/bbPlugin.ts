/**
 * The Cortex bb plugin, installed by `cortex agents install|reset` when bb is
 * present, the way the pi extension is. Its source is embedded in the binary
 * (src/bbPluginSource.ts), so the installed plugin always matches the cortex
 * that installed it: the files go to a cortex-owned directory, npm installs
 * their runtime dependencies there, and bb registers that directory as a
 * `path:` plugin. Why not `bb plugin install git:...`? It needs the plugin
 * pushed, network access and credentials, and installs whatever the remote
 * holds rather than what matches this binary.
 *
 * Every child runs with captured output and an argument array (the TUI's
 * :config calls this too), with timeouts long enough for bb to build.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { embeddedBbPlugin } from "./bbPluginSource.ts" with { type: "macro" };
import { configDir } from "./paths.ts";

const FILES: Record<string, string> = embeddedBbPlugin();

export const BB_PLUGIN_ID = "cortex";
/** Written into node_modules after a successful `npm ci`: the lockfile's hash. */
const INSTALLED_MARKER = ".cortex-installed";
/** The flags bb itself uses for git installs: runtime dependencies only, no lifecycle scripts. */
export const NPM_CI_ARGS = ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"];
const LIST_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 300_000;
const NPM_TIMEOUT_MS = 600_000;
const OUTPUT_TAIL_CHARS = 1_500;

export const BB_NOT_RUNNING = "bb is installed but not running; start bb, then run `cortex agents install` again";

/** The embedded plugin files, relative path to content. */
export function bbPluginFiles(): Readonly<Record<string, string>> {
  return FILES;
}

/** Where the plugin is written: cortex's own config dir, never bb's state dir (`~/.bb/plugins/cortex`). */
export function bbPluginDir(): string {
  return path.join(configDir(), "bb-plugin");
}

export type BbCli = { cli: string } | { cli: null; reason: string };

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * The bb CLI, first match wins: `CORTEX_BB_CLI` (a path, or "" to turn bb
 * off: tests and opt-out), `BB_CLI` (set inside bb threads), `bb` on PATH,
 * then the launcher the bb app installs at `~/.bb/bin/bb`.
 */
export function findBbCli(
  opts: {
    env?: NodeJS.ProcessEnv;
    which?: (cmd: string) => string | null;
    home?: string;
    executable?: (file: string) => boolean;
  } = {},
): BbCli {
  const env = opts.env ?? process.env;
  const executable = opts.executable ?? isExecutable;
  const explicit = env.CORTEX_BB_CLI;
  if (explicit !== undefined) {
    if (explicit === "") return { cli: null, reason: "bb is turned off (CORTEX_BB_CLI is empty)" };
    return executable(explicit)
      ? { cli: explicit }
      : { cli: null, reason: `CORTEX_BB_CLI=${explicit} is not an executable file` };
  }
  if (env.BB_CLI && executable(env.BB_CLI)) return { cli: env.BB_CLI };
  const onPath = (opts.which ?? ((cmd: string) => Bun.which(cmd, { PATH: env.PATH ?? "" })))("bb");
  if (onPath) return { cli: onPath };
  const launcher = path.join(opts.home ?? os.homedir(), ".bb", "bin", "bb");
  if (executable(launcher)) return { cli: launcher };
  return { cli: null, reason: "bb not found" };
}

export type BbResult = {
  status: "installed" | "reloaded" | "unchanged" | "skipped" | "failed";
  dir?: string;
  reason?: string;
  /** The source bb had the plugin installed from before this install moved it. */
  from?: string;
  /** What bb reports after the install; `cortexPath` is the plugin's setting, shown, never changed. */
  plugin?: { status: string; statusDetail?: string; cortexPath?: string };
};

type Run = { code: number; output: string };

async function run(cmd: string[], opts: { cwd?: string; timeoutMs: number }): Promise<Run> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeoutMs,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const timedOut = proc.signalCode !== null && code !== 0;
    const output = stdout + (stderr ? `\n${stderr}` : "");
    return { code, output: timedOut ? `${output}\n(timed out after ${opts.timeoutMs / 1000}s)` : output };
  } catch (err) {
    return { code: -1, output: (err as Error).message };
  }
}

const tail = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= OUTPUT_TAIL_CHARS ? trimmed : `\u2026${trimmed.slice(-OUTPUT_TAIL_CHARS)}`;
};

const failure = (what: string, r: Run): string =>
  `${what} failed (exit ${r.code})${r.output.trim() ? `: ${tail(r.output)}` : ""}`;

type Entry = { source: string; rootDir: string | null; status: string; statusDetail: string | null };

/** bb's record of the plugin, null when it is not installed; undefined when bb cannot be reached. */
async function listPlugin(cli: string): Promise<Entry | null | undefined> {
  const r = await run([cli, "plugin", "list", "--json"], { timeoutMs: LIST_TIMEOUT_MS });
  if (r.code !== 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.output);
  } catch {
    return undefined;
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(plugins)) return undefined;
  const found = plugins.find(p => (p as { id?: unknown } | null)?.id === BB_PLUGIN_ID) as
    | Record<string, unknown>
    | undefined;
  if (!found) return null;
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    source: text(found.source) ?? "",
    rootDir: text(found.rootDir),
    status: text(found.status) ?? "unknown",
    statusDetail: text(found.statusDetail),
  };
}

async function cortexPathSetting(cli: string): Promise<string | undefined> {
  const r = await run([cli, "plugin", "config", BB_PLUGIN_ID, "--json"], { timeoutMs: LIST_TIMEOUT_MS });
  if (r.code !== 0) return undefined;
  try {
    const value = (JSON.parse(r.output) as { values?: { cortexPath?: unknown } }).values?.cortexPath;
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

const realpath = (p: string): string => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Write the embedded files into `dir`, rewriting only files whose content
 * differs; `node_modules/` and `dist/` are left alone. Files that are no
 * longer shipped stay until `reset`, as with the skills.
 */
export function writeBbPluginFiles(dir: string = bbPluginDir()): { changed: string[] } {
  const changed: string[] = [];
  for (const [rel, content] of Object.entries(FILES)) {
    const target = path.join(dir, rel);
    let current: string | null = null;
    try {
      current = fs.readFileSync(target, "utf8");
    } catch {
      current = null;
    }
    if (current === content) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    changed.push(rel);
  }
  return { changed };
}

/** Whether `npm ci` must run: no successful install yet, or one for another lockfile. */
export function needsNpm(dir: string = bbPluginDir()): boolean {
  const lock = FILES["package-lock.json"] ?? "";
  try {
    return fs.readFileSync(path.join(dir, "node_modules", INSTALLED_MARKER), "utf8").trim() !== sha256(lock);
  } catch {
    return true;
  }
}

async function npmInstall(dir: string): Promise<string | null> {
  const npm = Bun.which("npm");
  if (npm === null) return "npm not found: install Node.js (it includes npm), then run `cortex agents install` again";
  const r = await run([npm, ...NPM_CI_ARGS], { cwd: dir, timeoutMs: NPM_TIMEOUT_MS });
  if (r.code !== 0) return failure("npm ci", r);
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", INSTALLED_MARKER), `${sha256(FILES["package-lock.json"] ?? "")}\n`);
  return null;
}

/**
 * Install (or with `wipe`, remove and reinstall) the bb plugin. Skipped,
 * exit 0: no bb, bb not running, or a plugin installed from a non-path
 * source (only `reset` replaces that). Failed: npm or bb returned an error.
 * The plugin's settings are never changed by install; reset clears them,
 * because bb deletes a removed plugin's settings.
 */
export async function installBbPlugin(opts: { wipe: boolean }): Promise<BbResult> {
  const dir = bbPluginDir();
  const found = findBbCli();
  if (found.cli === null) {
    // Without bb nothing points at the directory, so a reset may wipe it.
    if (opts.wipe) fs.rmSync(dir, { recursive: true, force: true });
    return { status: "skipped", reason: found.reason };
  }
  const cli = found.cli;
  let entry = await listPlugin(cli);
  if (entry === undefined) return { status: "skipped", reason: BB_NOT_RUNNING };
  if (opts.wipe) {
    if (entry !== null) {
      const removed = await run([cli, "plugin", "remove", BB_PLUGIN_ID], { timeoutMs: BUILD_TIMEOUT_MS });
      if (removed.code !== 0) return { status: "failed", dir, reason: failure("bb plugin remove", removed) };
    }
    fs.rmSync(dir, { recursive: true, force: true });
    entry = null;
  }
  if (entry !== null && !entry.source.startsWith("path:")) {
    return {
      status: "skipped",
      reason: `the bb plugin is installed from ${entry.source}; \`cortex agents reset\` replaces it`,
    };
  }

  const { changed } = writeBbPluginFiles(dir);
  let npmRan = false;
  if (needsNpm(dir)) {
    const npmError = await npmInstall(dir);
    if (npmError !== null) return { status: "failed", dir, reason: npmError };
    npmRan = true;
  }

  const installedDir = entry === null ? null : (entry.rootDir ?? entry.source.slice("path:".length));
  let status: BbResult["status"];
  let from: string | undefined;
  if (entry === null || realpath(installedDir ?? "") !== realpath(dir)) {
    // Installing another path over a path plugin moves it and keeps its settings.
    const installed = await run([cli, "plugin", "install", `path:${dir}`, "--yes"], { timeoutMs: BUILD_TIMEOUT_MS });
    if (installed.code !== 0) return { status: "failed", dir, reason: failure("bb plugin install", installed) };
    status = "installed";
    if (entry !== null) from = entry.source;
  } else if (changed.length > 0 || npmRan || entry.status !== "running") {
    const reloaded = await run([cli, "plugin", "reload", BB_PLUGIN_ID], { timeoutMs: BUILD_TIMEOUT_MS });
    if (reloaded.code !== 0) return { status: "failed", dir, reason: failure("bb plugin reload", reloaded) };
    status = "reloaded";
  } else {
    status = "unchanged";
  }

  const after = await listPlugin(cli);
  if (!after) return { status: "failed", dir, reason: "bb does not list the plugin after installing it" };
  const cortexPath = await cortexPathSetting(cli);
  const plugin: NonNullable<BbResult["plugin"]> = { status: after.status };
  if (after.status !== "running" && after.statusDetail) plugin.statusDetail = after.statusDetail;
  if (cortexPath !== undefined) plugin.cortexPath = cortexPath;
  return { status, dir, ...(from === undefined ? {} : { from }), plugin };
}

/** One line for the human report. */
export function bbReportLine(result: BbResult): string {
  if (result.status === "skipped") return `\u2013 skipped bb plugin: ${result.reason}`;
  if (result.status === "failed") return `\u2717 bb plugin failed: ${result.reason}`;
  const verb = { installed: "installed", reloaded: "reloaded", unchanged: "up to date" }[result.status];
  const plugin = result.plugin;
  const state = plugin ? ` (${plugin.status}${plugin.statusDetail ? `: ${plugin.statusDetail}` : ""})` : "";
  const moved = result.from ? `, moved from ${result.from}` : "";
  const cortexPath = plugin?.cortexPath ? ` \u00b7 runs cortex at ${plugin.cortexPath}` : "";
  return `\u2713 bb plugin ${verb} \u2192 ${result.dir}${state}${moved}${cortexPath}`;
}
