// lib/agentTools.ts — what `cortex agents status|install|reset --json` print,
// and the summaries the CLI and the desktop app show for them. The desktop
// renderer imports this file, so it holds only types and pure functions.

/** The `cortex agents` subcommands the desktop app may run. */
export type AgentsAction = "status" | "install" | "reset";

/** Installed files compared with the ones this cortex ships: `outdated` when any differs or is missing. */
export type ToolState = "installed" | "outdated" | "missing";

/** One skill or pi extension; `differs` lists its files that are missing or differ from this cortex's. */
export type FilesStatus = { name: string; dir: string; state: ToolState; differs: string[] };

export type Skip = { name: string; reason: string };

/** The plugin as bb reports it; `cortexPath` is the plugin's setting, shown, never changed. */
export type BbPluginState = { status: string; statusDetail?: string; cortexPath?: string };

/**
 * The bb plugin: `outdated` when install would change it (its files or
 * dependencies, the path bb runs it from, or a plugin bb does not report
 * running), `foreign` when bb installed it from git or npm (only reset
 * replaces that), `skipped` when bb is absent or not running.
 */
export type BbStatus = {
  state: ToolState | "foreign" | "skipped";
  dir?: string;
  reason?: string;
  plugin?: BbPluginState;
};

/** What would bring every tool in line with this cortex. */
export type AgentsSuggestion = "none" | "install" | "reset";

export type AgentsStatus = {
  /** The version of the cortex that checked, whose files the installed ones were compared with. */
  version: string;
  skills: FilesStatus[];
  extensions: FilesStatus[];
  skipped: Skip[];
  bb: BbStatus;
  suggest: AgentsSuggestion;
};

export type BbResult = {
  status: "installed" | "reloaded" | "unchanged" | "skipped" | "failed";
  dir?: string;
  reason?: string;
  /** The source bb had the plugin installed from before this install moved it. */
  from?: string;
  /** What bb reports after the install. */
  plugin?: BbPluginState;
};

export type AgentsResult = {
  skills: { name: string; dir: string }[];
  extensions: { name: string; dir: string }[];
  skipped: Skip[];
  bb: BbResult;
};

export function suggestion(status: Pick<AgentsStatus, "skills" | "extensions" | "bb">): AgentsSuggestion {
  const files = [...status.skills, ...status.extensions];
  if (files.some(f => f.state !== "installed")) return "install";
  if (status.bb.state === "missing" || status.bb.state === "outdated") return "install";
  return status.bb.state === "foreign" ? "reset" : "none";
}

/** One line for an install or reset; a failed bb plugin is an error. */
export function installSummary(result: AgentsResult): { level: "info" | "error"; text: string } {
  const n = result.skills.length;
  const skills = `${n} skill${n === 1 ? "" : "s"}`;
  const pi = result.skipped.find(s => s.name === "pi");
  const base =
    pi === undefined ? `Installed ${skills} and the pi extension` : `Installed ${skills}; skipped pi: ${pi.reason}`;
  const { bb } = result;
  if (bb.status === "failed") return { level: "error", text: `${base}; the bb plugin failed: ${bb.reason}` };
  if (bb.status === "skipped") return { level: "info", text: `${base}; skipped the bb plugin: ${bb.reason}` };
  const state = bb.plugin && bb.plugin.status !== "running" ? ` but it is ${bb.plugin.status}` : "";
  const verb = { installed: "installed", reloaded: "reloaded", unchanged: "up to date" }[bb.status];
  return { level: "info", text: `${base}; bb plugin ${verb}${state}` };
}
