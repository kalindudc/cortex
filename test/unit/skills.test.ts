import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { writeSkill, listSkills, skillsRoot, skillDir, type SkillName } from "../../src/skills.ts";
import { writeExtension, listExtensions } from "../../src/extensions.ts";

// All shipped skills are embedded in the cortex binary and self-installed at
// ~/.agents/skills/<name>/. Tests use writeSkill's targetDir override (and
// CORTEX_SKILL_DIR for end-to-end CLI tests) to write into a tmp dir instead
// of the user's real home, so assertions are reproducible and do not corrupt
// user data.

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-skills-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Per-skill structural assertions: every shipped skill MUST have a
// SKILL.md with valid frontmatter, the right `name:` line, and >200 bytes
// of body. This loop catches missing skills as new ones are added to SKILLS.
describe("writeSkill — every shipped skill", () => {
  for (const name of listSkills()) {
    test(`${name}: SKILL.md exists with valid frontmatter`, async () => {
      const dir = path.join(tmpDir, name);
      await writeSkill(name, dir);
      const skillMd = path.join(dir, "SKILL.md");
      expect(fs.existsSync(skillMd)).toBe(true);
      const txt = fs.readFileSync(skillMd, "utf8");
      expect(txt.startsWith("---\n")).toBe(true);
      expect(txt).toContain(`name: ${name}`);
      expect(txt.length).toBeGreaterThan(200);
    });
  }
});

// Cortex base skill: the cli/*.md and recipes/*.md leaf files ship and
// are not empty (each must be > 200 bytes).
describe("cortex base skill — leaf files", () => {
  const expectedLeaves = [
    "cli/init.md",
    "cli/reset.md",
    "cli/add.md",
    "cli/update.md",
    "cli/serve.md",
    "cli/memory.md",
    "cli/agents.md",
    "recipes/session-id.md",
    "recipes/persistence.md",
    "recipes/memory.md",
  ];

  test("every cli/*.md and recipes/*.md exists and > 200 bytes", async () => {
    const dir = path.join(tmpDir, "cortex");
    await writeSkill("cortex", dir);
    for (const rel of expectedLeaves) {
      const abs = path.join(dir, rel);
      expect(fs.existsSync(abs)).toBe(true);
      expect(fs.statSync(abs).size).toBeGreaterThan(200);
    }
  });
});

// --- pi-extension manifest -----------------------------------------------
//
// Every shipped pi extension MUST install at least one .ts file > 200 bytes
// that contains the structural literals proving prompt-integration is
// wired correctly. Without `promptSnippet`, custom tools are OMITTED from
// the system prompt entirely (per pi `core/extensions/types.ts:432-433`),
// so the agent never discovers them. Asserting the literal is the
// cheapest guard against accidental removal.
describe("writeExtension — every shipped extension", () => {
  for (const name of listExtensions()) {
    test(`${name}: index.ts written, > 200 bytes, contains tool + prompt-integration literals`, async () => {
      const dir = path.join(tmpDir, `ext-${name}`);
      await writeExtension(name, dir);
      const extFile = path.join(dir, "index.ts");
      expect(fs.existsSync(extFile)).toBe(true);
      expect(fs.statSync(extFile).size).toBeGreaterThan(200);
      const txt = fs.readFileSync(extFile, "utf8");
      expect(txt).toContain("cortex_update");
      expect(txt).toContain("pi.exec");
      expect(txt).toContain("getSessionId");
      expect(txt).toContain("promptSnippet");
      expect(txt).toContain("promptGuidelines");
    });
  }
});

// --- gap-closers: registry + path resolution + error branches --------------
describe("skills: registry + path resolution", () => {
  test("listSkills() returns every shipped skill name (deterministic order)", () => {
    const expected: SkillName[] = ["cortex", "cortex-planner", "cortex-implementer", "cortex-research"];
    expect(listSkills()).toEqual(expected);
  });

  test("writeSkill('not-a-real-skill') throws /unknown skill/", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypass SkillName narrowing to test the runtime guard
    await expect(writeSkill("not-a-real-skill" as any, path.join(tmpDir, "nope"))).rejects.toThrow(/unknown skill/);
  });

  test("skillsRoot() honors CORTEX_SKILL_DIR override", () => {
    const prev = process.env.CORTEX_SKILL_DIR;
    const override = path.join(tmpDir, "skill-root-override");
    try {
      process.env.CORTEX_SKILL_DIR = override;
      expect(skillsRoot()).toBe(override);
      expect(skillDir("cortex")).toBe(path.join(override, "cortex"));
    } finally {
      if (prev === undefined) delete process.env.CORTEX_SKILL_DIR;
      else process.env.CORTEX_SKILL_DIR = prev;
    }
  });

  test("skillsRoot() falls back to <homedir>/.agents/skills when env unset (string assertion only)", () => {
    const prev = process.env.CORTEX_SKILL_DIR;
    try {
      delete process.env.CORTEX_SKILL_DIR;
      // String-only assertion — DO NOT call any function that writes to disk.
      expect(skillsRoot().endsWith(path.join(".agents", "skills"))).toBe(true);
    } finally {
      if (prev !== undefined) process.env.CORTEX_SKILL_DIR = prev;
    }
  });
});
