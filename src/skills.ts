/**
 * Embedded multi-skill registry — written into ~/.agents/skills/{cortex,
 * cortex-planner,cortex-implementer,cortex-research}/ by `cortex agents install`
 * (and wiped+rewritten by `cortex agents reset`).
 *
 * Why embedded: the CLI binary ships everything an agent needs to learn
 * cortex — the base vocabulary skill plus the three methodology skills
 * (cortex-planner, cortex-implementer, cortex-research) — without a separate install step
 * or external download. Each markdown file is imported with
 * `with { type: "file" }`, which `bun build --compile` rewrites to a
 * `/$bunfs/...` virtual path; we read the bytes via `Bun.file(path)`.
 *
 * Idempotency: writeSkill() / writeAllSkills() always overwrite. Skills are
 * machine-generated; documenting that in cli/agents.md is the load-bearing
 * convention. Hand-edits are LOST on the next `cortex agents install|reset`.
 *
 * Multi-skill registry: SKILLS maps each skill name to its file
 * manifest. Adding a new skill = add a new entry to SKILLS + import its
 * files; `cortex agents` and the tests pick it up automatically via listSkills().
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Base cortex skill ---------------------------------------------------
import cortexSkillMd from "./skills/cortex/SKILL.md" with { type: "file" };
import cortexCliInitPath from "./skills/cortex/cli/init.md" with { type: "file" };
import cortexCliResetPath from "./skills/cortex/cli/reset.md" with { type: "file" };
import cortexCliAddPath from "./skills/cortex/cli/add.md" with { type: "file" };
import cortexCliEditPath from "./skills/cortex/cli/edit.md" with { type: "file" };
import cortexCliUpdatePath from "./skills/cortex/cli/update.md" with { type: "file" };
import cortexCliServePath from "./skills/cortex/cli/serve.md" with { type: "file" };
import cortexCliTagPath from "./skills/cortex/cli/tag.md" with { type: "file" };
import cortexCliSchemaPath from "./skills/cortex/cli/schema.md" with { type: "file" };
import cortexCliDoctorPath from "./skills/cortex/cli/doctor.md" with { type: "file" };
import cortexCliMemoryPath from "./skills/cortex/cli/memory.md" with { type: "file" };
import cortexCliAgentsPath from "./skills/cortex/cli/agents.md" with { type: "file" };
import cortexRecipeSession from "./skills/cortex/recipes/session-id.md" with { type: "file" };
import cortexRecipePersistence from "./skills/cortex/recipes/persistence.md" with { type: "file" };
import cortexRecipeMemory from "./skills/cortex/recipes/memory.md" with { type: "file" };

// --- Methodology skills --------------------------------------------------
import plannerSkillMd from "./skills/cortex-planner/SKILL.md" with { type: "file" };
import implementerSkillMd from "./skills/cortex-implementer/SKILL.md" with { type: "file" };
import researchSkillMd from "./skills/cortex-research/SKILL.md" with { type: "file" };

export type SkillName = "cortex" | "cortex-planner" | "cortex-implementer" | "cortex-research";

// Map relative path inside the skill dir → embedded blob path. The relPath
// becomes the on-disk name under skillDir(name).
type Manifest = Record<string /*relPath*/, string /*embeddedPath*/>;

const SKILLS: Record<SkillName, Manifest> = {
  cortex: {
    "SKILL.md": cortexSkillMd,
    "cli/init.md": cortexCliInitPath,
    "cli/reset.md": cortexCliResetPath,
    "cli/add.md": cortexCliAddPath,
    "cli/edit.md": cortexCliEditPath,
    "cli/update.md": cortexCliUpdatePath,
    "cli/serve.md": cortexCliServePath,
    "cli/tag.md": cortexCliTagPath,
    "cli/schema.md": cortexCliSchemaPath,
    "cli/doctor.md": cortexCliDoctorPath,
    "cli/memory.md": cortexCliMemoryPath,
    "cli/agents.md": cortexCliAgentsPath,
    "recipes/session-id.md": cortexRecipeSession,
    "recipes/persistence.md": cortexRecipePersistence,
    "recipes/memory.md": cortexRecipeMemory,
  },
  "cortex-planner": {
    "SKILL.md": plannerSkillMd,
  },
  "cortex-implementer": {
    "SKILL.md": implementerSkillMd,
  },
  "cortex-research": {
    "SKILL.md": researchSkillMd,
  },
};

/**
 * Root install directory for ALL cortex-shipped skills.
 * `CORTEX_SKILL_DIR` env var overrides for test isolation — same idiom as
 * `CORTEX_DB` in paths.ts so the integration test never clobbers the user's
 * real ~/.agents/skills/ tree.
 *
 * Note: when CORTEX_SKILL_DIR is set, it is used as the ROOT (containing
 * subdirs cortex/, cortex-planner/, cortex-implementer/), preserving the
 * Plan-3 single-skill override semantics in spirit while supporting N skills.
 */
export function skillsRoot(): string {
  return process.env.CORTEX_SKILL_DIR ?? path.join(os.homedir(), ".agents", "skills");
}

/**
 * Install location for a single skill by name.
 */
export function skillDir(name: SkillName): string {
  return path.join(skillsRoot(), name);
}

/**
 * List every shipped skill name (deterministic insertion order from SKILLS).
 */
export function listSkills(): SkillName[] {
  return Object.keys(SKILLS) as SkillName[];
}

/**
 * Write every embedded file for a single skill into `targetDir`.
 * Always overwrites — skills are machine-generated; that's the contract.
 *
 * `targetDir` is overridable so tests can write into a tmp dir.
 */
export async function writeSkill(name: SkillName, targetDir: string = skillDir(name)): Promise<void> {
  const manifest = SKILLS[name];
  if (!manifest) throw new Error(`unknown skill: ${name}`);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [rel, embedPath] of Object.entries(manifest)) {
    const target = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = await Bun.file(embedPath).bytes();
    fs.writeFileSync(target, bytes);
  }
}

/**
 * Write all shipped skills under their default skillDir() locations.
 * Called by `cortex agents install|reset`.
 */
export async function writeAllSkills(): Promise<void> {
  for (const name of listSkills()) {
    await writeSkill(name);
  }
}
