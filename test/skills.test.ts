import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { writeSkill, listSkills, type SkillName } from "../src/skills.ts";

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
  const methodologySkills: SkillName[] = ["cortex-planner", "cortex-implementer"];
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
    // The planner description tells the picker to use the implementer for execution.
    expect(planner).toContain("cortex-implementer");
    // The implementer description tells the picker to use the planner for drafting.
    expect(implementer).toContain("cortex-planner");
  });
});

// --- --body-file smoke test (Plan 4 task 2) ------------------------------
//
// End-to-end via the CLI binary: writes a tmp file, runs `cortex add
// --body-file <tmp>` and `cortex edit <id> --body-file <tmp>`, asserts the
// task's stored body matches the file. Also verifies the mutex error.

import { runCli, mkTmpEnv } from "./helpers.ts";

describe("cortex add/edit accept --body-file", () => {
  let testEnv: Record<string, string>;
  let cliTmpDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    const e = mkTmpEnv("bodyfile");
    testEnv = e.env;
    cliTmpDir = e.tmpDir;
    cleanup = e.cleanup;
  });

  afterAll(() => cleanup());

  const cli = (...args: string[]) => runCli({ args, env: testEnv });

  test("add --body-file stores file contents as the task body; edit --body-file updates it; -b + --body-file is rejected", async () => {
    let r = await cli("init");
    expect(r.code).toBe(0);

    const tmp = path.join(cliTmpDir, "plan.md");
    const original = "plan body content here\n\n## Section\n\nbody.";
    fs.writeFileSync(tmp, original);

    r = await cli("add", "test", "-l", "now", "--body-file", tmp);
    expect(r.code).toBe(0);
    const m = r.stdout.match(/^\[(\d+)\]/);
    expect(m).not.toBeNull();
    const id = m?.[1];
    if (!id) throw new Error(`could not parse task id from cli output: ${r.stdout}`);

    // Verify stored body via `show --json` (the canonical body-fetch path
    // documented in Plan 4 Implementation Notes for plan revision).
    r = await cli("show", id, "--json");
    expect(r.code).toBe(0);
    const showOut = JSON.parse(r.stdout);
    const task = showOut.task ?? showOut;
    expect(task.body).toBe(original);

    // Modify the file, run edit --body-file, verify the body updates.
    const updated = `${original}\n\nappended.`;
    fs.writeFileSync(tmp, updated);
    r = await cli("edit", id, "--body-file", tmp);
    expect(r.code).toBe(0);

    r = await cli("show", id, "--json");
    expect(r.code).toBe(0);
    const showOut2 = JSON.parse(r.stdout);
    const task2 = showOut2.task ?? showOut2;
    expect(task2.body).toBe(updated);

    // Mutex: -b together with --body-file MUST fail with the documented error.
    r = await cli("add", "x", "-l", "now", "-b", "inline", "--body-file", tmp);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("use --body-file OR -b");
  });
});
