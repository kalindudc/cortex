import { defineCommand } from "citty";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { extensionDir, listExtensions, piDetected, writeAllExtensions } from "../extensions.ts";
import { emitError, printJson } from "../output.ts";
import { listSkills, skillDir, writeAllSkills } from "../skills.ts";

/**
 * `cortex agents install|reset` — the agent tooling, split from the
 * datastore (`cortex init`/`cortex reset` never touch it). Skills
 * (`~/.agents/skills`, harness-neutral) are always written; the pi extension
 * only when pi is detected (`piDetected`), otherwise the skip is reported.
 *
 *   install  overwrite in place (extra files in the dirs are kept)
 *   reset    wipe every cortex-owned skill/extension dir, then install
 *            (drops files stranded by an upgrade, and hand-edits)
 *
 * Both touch only `skillDir(name)` / `extensionDir(name)` and never open the
 * database.
 */

const CONFIRM = "RESET";
const PI_MISSING = "pi not found (no `pi` on PATH, no pi agent dir)";

const jsonArg = {
  type: "boolean" as const,
  default: false,
  description: "emit the result as JSON instead of the human lines",
};

type AgentsResult = {
  skills: { name: string; dir: string }[];
  extensions: { name: string; dir: string }[];
  skipped: { name: string; reason: string }[];
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

async function installAll(wipe: boolean): Promise<AgentsResult> {
  const result: AgentsResult = { skills: [], extensions: [], skipped: [] };
  const skills = listSkills();
  if (wipe) {
    for (const name of skills) fs.rmSync(skillDir(name), { recursive: true, force: true });
  }
  await writeAllSkills();
  for (const name of skills) result.skills.push({ name, dir: skillDir(name) });

  if (!piDetected()) {
    result.skipped.push({ name: "pi", reason: PI_MISSING });
    return result;
  }
  const extensions = listExtensions();
  if (wipe) {
    for (const name of extensions) fs.rmSync(extensionDir(name), { recursive: true, force: true });
  }
  await writeAllExtensions();
  for (const name of extensions) result.extensions.push({ name, dir: extensionDir(name) });
  return result;
}

function report(result: AgentsResult): void {
  for (const { name, dir } of result.skills) console.log(`✓ skill ${name} → ${dir}`);
  for (const { name, dir } of result.extensions) console.log(`✓ ${name} extension → ${path.join(dir, "index.ts")}`);
  for (const { name, reason } of result.skipped) console.log(`– skipped ${name}: ${reason}`);
}

const install = defineCommand({
  meta: { name: "install", description: "write (overwrite) the skills, plus the pi extension when pi is present" },
  args: { json: jsonArg },
  async run({ args }) {
    let result: AgentsResult;
    try {
      result = await installAll(false);
    } catch (err) {
      emitError(args.json, err);
    }
    if (args.json) {
      printJson(result);
      return;
    }
    report(result);
  },
});

const reset = defineCommand({
  meta: {
    name: "reset",
    description: "wipe the cortex skill and pi extension dirs, then reinstall (type RESET, or --force)",
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
      console.log("Hand-edits in these dirs are LOST.");
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
    if (json) {
      printJson(result);
      return;
    }
    report(result);
    console.log("✓ agents reset complete");
  },
});

export default defineCommand({
  meta: { name: "agents", description: "install or reset cortex's agent skills and pi extension" },
  subCommands: { install, reset },
});
