import { defineCommand } from "citty";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import pkg from "../../package.json" with { type: "json" };
import { bbPluginDir, bbPluginStatus, bbReportLine, findBbCli, installBbPlugin } from "../bbPlugin.ts";
import { extensionDir, extensionsStatus, listExtensions, piDetected, writeAllExtensions } from "../extensions.ts";
import { type AgentsResult, type AgentsStatus, type FilesStatus, suggestion } from "../lib/agentTools.ts";
import { emitError, printJson } from "../output.ts";
import { listSkills, skillDir, skillsStatus, writeAllSkills } from "../skills.ts";

/**
 * `cortex agents status|install|reset` — the agent tooling, split from the
 * datastore (`cortex init`/`cortex reset` never touch it). Skills
 * (`~/.agents/skills`, harness-neutral) are always written; the pi extension
 * only when pi is detected (`piDetected`), and the bb plugin only when bb is
 * found and running (src/bbPlugin.ts); every skip is reported.
 *
 *   status   compare what is installed with what this binary ships; writes nothing
 *   install  overwrite in place (extra files in the dirs are kept)
 *   reset    wipe every cortex-owned skill/extension dir, remove the bb
 *            plugin and its dir, then install (drops files stranded by an
 *            upgrade, and hand-edits)
 *
 * They touch only `skillDir(name)`, `extensionDir(name)` and `bbPluginDir()`
 * (plus bb's own record of the plugin) and never open the database. The
 * desktop app runs them as `--json` children (src/desktop/agents.ts).
 */

const CONFIRM = "RESET";
const PI_MISSING = "pi not found (no `pi` on PATH, no pi agent dir)";

const jsonArg = {
  type: "boolean" as const,
  default: false,
  description: "emit the result as JSON instead of the human lines",
};

/** Resolves "" on EOF so a closed stdin aborts instead of exiting silently. */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer);
      rl.close();
    });
    rl.once("close", () => resolve(""));
  });
}

/**
 * The skills, the pi extension when pi is present, then the bb plugin when bb
 * is; `wipe` removes their dirs (and bb's plugin record) first. A bb failure is reported in `bb`, after the rest is written.
 */
export async function installAll(wipe: boolean): Promise<AgentsResult> {
  const skills = listSkills();
  if (wipe) {
    for (const name of skills) fs.rmSync(skillDir(name), { recursive: true, force: true });
  }
  await writeAllSkills();
  const result: Omit<AgentsResult, "bb"> = {
    skills: skills.map(name => ({ name, dir: skillDir(name) })),
    extensions: [],
    skipped: [],
  };

  if (piDetected()) {
    const extensions = listExtensions();
    if (wipe) {
      for (const name of extensions) fs.rmSync(extensionDir(name), { recursive: true, force: true });
    }
    await writeAllExtensions();
    for (const name of extensions) result.extensions.push({ name, dir: extensionDir(name) });
  } else {
    result.skipped.push({ name: "pi", reason: PI_MISSING });
  }
  return { ...result, bb: await installBbPlugin({ wipe }) };
}

/** What is installed, compared with this binary's files; the same detection as `installAll`. */
export async function agentsStatus(): Promise<AgentsStatus> {
  const skills = await skillsStatus();
  const pi = piDetected();
  const extensions = pi ? await extensionsStatus() : [];
  const skipped = pi ? [] : [{ name: "pi", reason: PI_MISSING }];
  const bb = await bbPluginStatus();
  return { version: pkg.version, skills, extensions, skipped, bb, suggest: suggestion({ skills, extensions, bb }) };
}

function filesLine(kind: string, f: FilesStatus): string {
  if (f.state === "installed") return `✓ ${kind} → ${f.dir}`;
  if (f.state === "missing") return `✗ ${kind} not installed → ${f.dir}`;
  const n = f.differs.length;
  return `! ${kind} differs from this version (${n} file${n === 1 ? "" : "s"}) → ${f.dir}`;
}

function bbStatusLine(bb: AgentsStatus["bb"]): string {
  const plugin = bb.plugin;
  const state = plugin ? ` (${plugin.status}${plugin.statusDetail ? `: ${plugin.statusDetail}` : ""})` : "";
  const cortexPath = plugin?.cortexPath ? ` · runs cortex at ${plugin.cortexPath}` : "";
  switch (bb.state) {
    case "installed":
      return `✓ bb plugin → ${bb.dir}${state}${cortexPath}`;
    case "outdated":
      return `! bb plugin needs updating: ${bb.reason} → ${bb.dir}${state}`;
    case "missing":
      return `✗ bb plugin not installed → ${bb.dir}`;
    case "foreign":
      return `! ${bb.reason}`;
    case "skipped":
      return `– bb plugin: ${bb.reason}`;
  }
}

function reportStatus(status: AgentsStatus): void {
  for (const s of status.skills) console.log(filesLine(`skill ${s.name}`, s));
  for (const e of status.extensions) console.log(filesLine(`${e.name} extension`, e));
  for (const { name, reason } of status.skipped) console.log(`– ${name} extension: ${reason}`);
  console.log(bbStatusLine(status.bb));
  if (status.suggest === "none") console.log(`✓ every agent tool matches cortex ${status.version}`);
  else console.log(`→ run \`cortex agents ${status.suggest}\``);
}

function report(result: AgentsResult): void {
  for (const { name, dir } of result.skills) console.log(`✓ skill ${name} → ${dir}`);
  for (const { name, dir } of result.extensions) console.log(`✓ ${name} extension → ${path.join(dir, "index.ts")}`);
  for (const { name, reason } of result.skipped) console.log(`– skipped ${name}: ${reason}`);
  const bb = bbReportLine(result.bb);
  if (result.bb.status === "failed") console.error(bb);
  else console.log(bb);
}

/** The result as JSON or the human lines; a failed bb plugin exits 1 after everything else was written. */
function finish(result: AgentsResult, json: boolean, done?: string): void {
  if (json) printJson(result);
  else {
    report(result);
    if (done && result.bb.status !== "failed") console.log(done);
  }
  if (result.bb.status === "failed") process.exit(1);
}

const status = defineCommand({
  meta: {
    name: "status",
    description: "compare the installed skills, pi extension and bb plugin with this cortex's; writes nothing",
  },
  args: { json: jsonArg },
  async run({ args }) {
    let result: AgentsStatus;
    try {
      result = await agentsStatus();
    } catch (err) {
      emitError(args.json, err);
    }
    if (args.json) printJson(result);
    else reportStatus(result);
  },
});

const install = defineCommand({
  meta: {
    name: "install",
    description: "write (overwrite) the skills, plus the pi extension when pi is present and the bb plugin when bb is",
  },
  args: { json: jsonArg },
  async run({ args }) {
    let result: AgentsResult;
    try {
      result = await installAll(false);
    } catch (err) {
      emitError(args.json, err);
    }
    finish(result, args.json);
  },
});

const reset = defineCommand({
  meta: {
    name: "reset",
    description:
      "wipe the cortex skill and pi extension dirs and remove the bb plugin, then reinstall (type RESET, or --force)",
  },
  args: {
    force: { type: "boolean", alias: "f", default: false, description: "skip the RESET confirmation prompt" },
    json: jsonArg,
  },
  async run({ args }) {
    const json = args.json;
    if (!args.force) {
      // --json callers can't answer an interactive prompt; requiring --force
      // keeps stdout clean and never hangs. Piped stdin answers the human
      // prompt, and EOF aborts.
      if (json) emitError(json, new Error("refusing to prompt in --json mode; pass --force"));
      console.log("This will wipe and reinstall:");
      for (const name of listSkills()) console.log(`  • ${skillDir(name)}`);
      if (piDetected()) {
        for (const name of listExtensions()) console.log(`  • ${extensionDir(name)}`);
      }
      const bb = findBbCli().cli !== null;
      if (bb) console.log(`  • ${bbPluginDir()}`);
      console.log("Hand-edits in these dirs are LOST.");
      if (bb)
        console.log("The bb plugin is removed from bb and installed again, which resets its settings (cortexPath).");
      const answer = await prompt(`Type ${CONFIRM} to confirm: `);
      if (answer.trim() !== CONFIRM) {
        console.log("aborted (input did not match RESET)");
        process.exit(1);
      }
    }
    let result: AgentsResult;
    try {
      result = await installAll(true);
    } catch (err) {
      emitError(json, err);
    }
    finish(result, json, "✓ agents reset complete");
  },
});

export default defineCommand({
  meta: {
    name: "agents",
    description: "check, install or reset cortex's agent skills, pi extension and bb plugin",
  },
  subCommands: { status, install, reset },
});
