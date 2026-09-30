import { test, expect, describe, beforeAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { runCli, mkTmpEnv } from "../helpers.ts";

// ---------- CLI integration: `cortex agents install|reset` ----------
//
// Each test builds its OWN env via mkTmpEnv (which pins CORTEX_SKILL_DIR and
// CORTEX_PI_EXTENSION_DIR under a fresh tmp dir). The pi-absent/pi-present
// cases go further: they delete both pi overrides, point HOME at an empty tmp
// home and restrict PATH, so detection never sees the developer's machine.
// A final pair of tests asserts the real installed skill and extension
// files did not move.

// Hardcoded (not derived from listSkills()) so the test fails LOUD when a
// skill is added or removed without a test update.
const EXPECTED_SKILLS = ["cortex", "cortex-planner", "cortex-implementer", "cortex-research"] as const;

const REAL_SKILL = path.join(os.homedir(), ".agents", "skills", "cortex", "SKILL.md");
const REAL_EXT = path.join(os.homedir(), ".pi", "agent", "extensions", "cortex", "index.ts");

function mtimeOrNull(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

let realSkillBefore: number | null = null;
let realExtBefore: number | null = null;
beforeAll(() => {
  realSkillBefore = mtimeOrNull(REAL_SKILL);
  realExtBefore = mtimeOrNull(REAL_EXT);
});

/** mkTmpEnv plus the resolved skill and extension roots. */
function mkAgentsEnv(label: string) {
  const base = mkTmpEnv(label);
  return { ...base, skillRoot: base.env.CORTEX_SKILL_DIR ?? "", extRoot: base.env.CORTEX_PI_EXTENSION_DIR ?? "" };
}

/** No explicit pi target: detection sees only an empty tmp HOME and a PATH without pi. */
function withoutPi(env: Record<string, string>, tmpDir: string) {
  const home = path.join(tmpDir, "home");
  fs.mkdirSync(home);
  const next: Record<string, string> = { ...env, HOME: home, PATH: "/usr/bin:/bin" };
  delete next.CORTEX_PI_EXTENSION_DIR;
  delete next.PI_CODING_AGENT_DIR;
  return { env: next, home };
}

const skillFile = (root: string, name: string) => path.join(root, name, "SKILL.md");
const extFile = (root: string) => path.join(root, "cortex", "index.ts");

describe("cortex agents install", () => {
  test("--json writes every shipped skill and the pi extension (explicit CORTEX_PI_EXTENSION_DIR target)", async () => {
    const { env, skillRoot, extRoot, cleanup } = mkAgentsEnv("agents-install");
    try {
      const r = await runCli({ args: ["agents", "install", "--json"], env });
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.skills.map((s: { name: string }) => s.name)).toEqual([...EXPECTED_SKILLS]);
      expect(out.extensions).toEqual([{ name: "pi", dir: path.join(extRoot, "cortex") }]);
      expect(out.skipped).toEqual([]);
      for (const name of EXPECTED_SKILLS) expect(fs.existsSync(skillFile(skillRoot, name))).toBe(true);
      expect(fs.statSync(extFile(extRoot)).size).toBeGreaterThan(200);
      // The memory status + /memory view, imported by index.ts as ./memory-view.ts.
      const view = path.join(extRoot, "cortex", "memory-view.ts");
      expect(fs.statSync(view).size).toBeGreaterThan(200);
      expect(fs.readFileSync(view, "utf8")).toContain("export function memoryStatus");
      // No database: agents never opens it.
      expect(fs.existsSync(env.CORTEX_DB ?? "")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("pi absent: the extension is skipped and reported, no ~/.pi is created, skills are still written", async () => {
    const { tmpDir, env: base, skillRoot, cleanup } = mkAgentsEnv("agents-nopi");
    try {
      const { env, home } = withoutPi(base, tmpDir);
      const r = await runCli({ args: ["agents", "install", "--json"], env });
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.extensions).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0].name).toBe("pi");
      expect(out.skipped[0].reason).toContain("pi not found");
      expect(fs.existsSync(path.join(home, ".pi"))).toBe(false);
      for (const name of EXPECTED_SKILLS) expect(fs.existsSync(skillFile(skillRoot, name))).toBe(true);

      const text = await runCli({ args: ["agents", "install"], env });
      expect(text.code).toBe(0);
      expect(text.stdout).toContain("– skipped pi: pi not found");
    } finally {
      cleanup();
    }
  });

  test("pi present via its agent dir in HOME: the extension lands in <home>/.pi/agent/extensions/cortex", async () => {
    const { tmpDir, env: base, cleanup } = mkAgentsEnv("agents-homepi");
    try {
      const { env, home } = withoutPi(base, tmpDir);
      fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
      const r = await runCli({ args: ["agents", "install"], env });
      expect(r.code).toBe(0);
      const installed = extFile(path.join(home, ".pi", "agent", "extensions"));
      expect(r.stdout).toContain(`✓ pi extension → ${installed}`);
      expect(fs.statSync(installed).size).toBeGreaterThan(200);
    } finally {
      cleanup();
    }
  });

  test("install keeps an extra file in a skill dir; reset --force removes it and reinstalls", async () => {
    const { env, skillRoot, extRoot, cleanup } = mkAgentsEnv("agents-stray");
    try {
      expect((await runCli({ args: ["agents", "install"], env })).code).toBe(0);
      const stray = path.join(skillRoot, "cortex", "stray.md");
      fs.writeFileSync(stray, "hand-edit");
      expect((await runCli({ args: ["agents", "install"], env })).code).toBe(0);
      expect(fs.existsSync(stray)).toBe(true);

      const r = await runCli({ args: ["agents", "reset", "--force"], env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("✓ agents reset complete");
      expect(fs.existsSync(stray)).toBe(false);
      expect(fs.existsSync(skillFile(skillRoot, "cortex"))).toBe(true);
      expect(fs.existsSync(extFile(extRoot))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("cortex agents reset confirmation", () => {
  test("--json without --force refuses with a JSON error and removes nothing", async () => {
    const { env, skillRoot, cleanup } = mkAgentsEnv("agents-json");
    try {
      await runCli({ args: ["agents", "install"], env });
      const stray = path.join(skillRoot, "cortex", "stray.md");
      fs.writeFileSync(stray, "hand-edit");
      const r = await runCli({ args: ["agents", "reset", "--json"], env });
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout).error.message).toContain("pass --force");
      expect(fs.existsSync(stray)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('piped "RESET" resets; piped "no" and EOF abort with the files intact', async () => {
    const { env, skillRoot, cleanup } = mkAgentsEnv("agents-prompt");
    try {
      await runCli({ args: ["agents", "install"], env });
      const stray = path.join(skillRoot, "cortex", "stray.md");
      fs.writeFileSync(stray, "hand-edit");

      for (const stdin of ["no\n", ""]) {
        const r = await runCli({ args: ["agents", "reset"], env, stdin });
        expect(r.code).toBe(1);
        expect(r.stdout).toContain("aborted");
        expect(fs.existsSync(stray)).toBe(true);
      }

      const r = await runCli({ args: ["agents", "reset"], env, stdin: "RESET\n" });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(path.join(skillRoot, "cortex"));
      expect(r.stdout).toContain("✓ agents reset complete");
      expect(fs.existsSync(stray)).toBe(false);
      expect(fs.existsSync(skillFile(skillRoot, "cortex"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// MUST run last in this file (bun runs tests in file order).
describe("hermetic guard", () => {
  test("the real ~/.agents/skills/cortex/SKILL.md mtime did not change", () => {
    expect(mtimeOrNull(REAL_SKILL)).toBe(realSkillBefore);
  });

  test("the real ~/.pi/agent/extensions/cortex/index.ts mtime did not change", () => {
    expect(mtimeOrNull(REAL_EXT)).toBe(realExtBefore);
  });
});
