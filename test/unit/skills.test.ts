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

// Cortex base skill: preserve Plan 3 coverage of the cli/*.md and
// recipes/*.md leaf files (each must be > 200 bytes).
describe("cortex base skill — Plan 3 leaf files", () => {
  const expectedLeaves = [
    "cli/init.md",
    "cli/reset.md",
    "cli/add.md",
    "cli/update.md",
    "cli/serve.md",
    "recipes/session-id.md",
    "recipes/persistence.md",
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

  test("cli/update.md contains the literal 'REQUIRED' warning (Plan 3 contract)", async () => {
    const dir = path.join(tmpDir, "cortex");
    await writeSkill("cortex", dir);
    const text = fs.readFileSync(path.join(dir, "cli/update.md"), "utf8");
    expect(text).toContain("REQUIRED");
  });
});

// Methodology skills: standalone discipline. Each MUST be a substantial,
// self-contained skill that teaches the cortex methodology AND embeds the
// cortex-CLI essentials it uses (no cross-references to a base skill).
//
// Discovery: the description follows Anthropic's third-person trigger-phrase
// shape ("This skill should be used when ..."), and explicitly disambiguates
// the sibling skill so the harness skill-picker doesn't fire both on
// overlapping prompts.
describe("methodology skills — standalone discipline", () => {
  const methodologySkills: SkillName[] = ["cortex-planner", "cortex-implementer", "cortex-research"];
  for (const name of methodologySkills) {
    test(`${name}: substantial body (≥ 4 KB) and embeds cortex CLI essentials`, async () => {
      const dir = path.join(tmpDir, name);
      await writeSkill(name, dir);
      const skillMd = path.join(dir, "SKILL.md");
      const txt = fs.readFileSync(skillMd, "utf8");
      // Standalone skills are substantive (~250 lines / ~4-15 KB).
      expect(fs.statSync(skillMd).size).toBeGreaterThan(4_000);
      // Embeds the session-id pattern inline (no cross-ref to a base skill).
      expect(txt).toContain("$SESSION_ID");
      expect(txt).toContain("openssl rand -hex 4");
      // Embeds the cortex commands it actually uses.
      expect(txt).toContain("cortex update");
    });

    test(`${name}: third-person trigger-phrase description (Anthropic discovery shape)`, async () => {
      const dir = path.join(tmpDir, name);
      await writeSkill(name, dir);
      const txt = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
      const closingIdx = txt.indexOf("---", 4);
      expect(closingIdx).toBeGreaterThan(0);
      const frontmatter = txt.slice(0, closingIdx);
      expect(frontmatter).toContain("This skill should be used when");
    });
  }

  test("cortex-planner and cortex-implementer disambiguate each other", async () => {
    await writeSkill("cortex-planner", path.join(tmpDir, "cortex-planner"));
    await writeSkill("cortex-implementer", path.join(tmpDir, "cortex-implementer"));
    const planner = fs.readFileSync(path.join(tmpDir, "cortex-planner", "SKILL.md"), "utf8");
    const implementer = fs.readFileSync(path.join(tmpDir, "cortex-implementer", "SKILL.md"), "utf8");
    // The planner description tells the picker to use the implementer for drafting.
    expect(planner).toContain("cortex-implementer");
    // The implementer description tells the picker to use the planner for drafting.
    expect(implementer).toContain("cortex-planner");
  });

  // cortex-research must disambiguate against BOTH siblings: planning work is
  // for cortex-planner, execution is for cortex-implementer. Without these
  // names in the body, the pi skill-picker can fire cortex-research on
  // prompts that should route to planner/implementer.
  test("cortex-research disambiguates from cortex-planner and cortex-implementer", async () => {
    await writeSkill("cortex-research", path.join(tmpDir, "cortex-research"));
    const research = fs.readFileSync(path.join(tmpDir, "cortex-research", "SKILL.md"), "utf8");
    expect(research).toContain("cortex-planner");
    expect(research).toContain("cortex-implementer");
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
