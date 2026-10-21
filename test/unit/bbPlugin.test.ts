import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bbPluginDir,
  bbPluginFiles,
  bbReportLine,
  differingBbPluginFiles,
  findBbCli,
  needsNpm,
  writeBbPluginFiles,
} from "../../src/bbPlugin.ts";

// Pure parts of the bb plugin install: detection, the embedded file set, the
// file writer and the report line. Nothing here runs bb or npm; the install
// flow itself is exercised against fakes in test/integration/cli/agents-bb.test.ts.

let dir: string;
let savedXdg: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bb-plugin-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("findBbCli", () => {
  const all = new Set(["/explicit/bb", "/thread/bb", "/home/me/.bb/bin/bb"]);
  const executable = (file: string) => all.has(file);
  const which = (cmd: string) => (cmd === "bb" ? "/path/bb" : null);
  const find = (env: NodeJS.ProcessEnv, opts: { which?: typeof which; exec?: typeof executable } = {}) =>
    findBbCli({ env, which: opts.which ?? which, home: "/home/me", executable: opts.exec ?? executable });

  test("CORTEX_BB_CLI, then BB_CLI, then PATH, then ~/.bb/bin/bb", () => {
    expect(find({ CORTEX_BB_CLI: "/explicit/bb", BB_CLI: "/thread/bb" })).toEqual({ cli: "/explicit/bb" });
    expect(find({ BB_CLI: "/thread/bb" })).toEqual({ cli: "/thread/bb" });
    expect(find({})).toEqual({ cli: "/path/bb" });
    expect(find({}, { which: () => null })).toEqual({ cli: "/home/me/.bb/bin/bb" });
    expect(find({}, { which: () => null, exec: () => false })).toEqual({ cli: null, reason: "bb not found" });
  });

  test("an empty CORTEX_BB_CLI turns bb off even inside a bb thread; a bad path is reported", () => {
    expect(find({ CORTEX_BB_CLI: "", BB_CLI: "/thread/bb" })).toEqual({
      cli: null,
      reason: "bb is turned off (CORTEX_BB_CLI is empty)",
    });
    expect(find({ CORTEX_BB_CLI: "/nope/bb" })).toEqual({
      cli: null,
      reason: "CORTEX_BB_CLI=/nope/bb is not an executable file",
    });
    // A BB_CLI that is not executable falls through to PATH.
    expect(find({ BB_CLI: "/gone/bb" })).toEqual({ cli: "/path/bb" });
  });
});

describe("the embedded plugin", () => {
  test("holds what the plugin's build reads and none of its tests or build output", () => {
    const files = Object.keys(bbPluginFiles());
    for (const needed of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "components.json",
      "server.ts",
      "app.tsx",
    ]) {
      expect(files).toContain(needed);
    }
    expect(files.some(f => /\.test\.tsx?$/.test(f))).toBe(false);
    expect(files.some(f => f.startsWith("node_modules/") || f.startsWith("dist/") || f.startsWith("."))).toBe(false);
    expect(files).not.toContain("fake-cortex.ts");
    expect(files).not.toContain("vitest.config.ts");
    const pkg = JSON.parse(bbPluginFiles()["package.json"] ?? "{}");
    expect(pkg.name).toBe("bb-plugin-cortex");
    expect(pkg.bb.skills).toEqual(["skills"]);
    for (const skill of ["cortex", "cortex-planner"]) {
      const source = fs.readFileSync(
        path.join(import.meta.dir, "..", "..", "src", "skills", skill, "SKILL.md"),
        "utf8",
      );
      expect(bbPluginFiles()[`skills/${skill}/SKILL.md`]).toBe(source);
    }
  });

  test("lives in cortex's config dir, never bb's state dir", () => {
    expect(bbPluginDir()).toBe(path.join(dir, "xdg", "cortex", "bb-plugin"));
  });
});

describe("writeBbPluginFiles and needsNpm", () => {
  test("writes every file, then only what differs; node_modules and dist stay", () => {
    const target = path.join(dir, "plugin");
    const first = writeBbPluginFiles(target);
    expect(first.changed.sort()).toEqual(Object.keys(bbPluginFiles()).sort());
    fs.mkdirSync(path.join(target, "node_modules", "zod"), { recursive: true });
    fs.mkdirSync(path.join(target, "dist"), { recursive: true });
    fs.writeFileSync(path.join(target, "dist", "app.js"), "built");
    expect(writeBbPluginFiles(target).changed).toEqual([]);
    fs.appendFileSync(path.join(target, "app.tsx"), "\n// edited");
    expect(writeBbPluginFiles(target).changed).toEqual(["app.tsx"]);
    expect(fs.readFileSync(path.join(target, "app.tsx"), "utf8")).toBe(bbPluginFiles()["app.tsx"]);
    expect(fs.existsSync(path.join(target, "node_modules", "zod"))).toBe(true);
    expect(fs.readFileSync(path.join(target, "dist", "app.js"), "utf8")).toBe("built");
  });

  test("differingBbPluginFiles names every missing or changed file, and nothing once written", () => {
    const target = path.join(dir, "plugin");
    expect(differingBbPluginFiles(target).sort()).toEqual(Object.keys(bbPluginFiles()).sort());
    writeBbPluginFiles(target);
    expect(differingBbPluginFiles(target)).toEqual([]);
    fs.appendFileSync(path.join(target, "app.tsx"), "\n// edited");
    fs.rmSync(path.join(target, "package.json"));
    expect(differingBbPluginFiles(target).sort()).toEqual(["app.tsx", "package.json"]);
  });

  test("npm is needed until a marker for this lockfile exists", () => {
    const target = path.join(dir, "plugin");
    writeBbPluginFiles(target);
    expect(needsNpm(target)).toBe(true);
    fs.mkdirSync(path.join(target, "node_modules"), { recursive: true });
    expect(needsNpm(target)).toBe(true);
    fs.writeFileSync(path.join(target, "node_modules", ".cortex-installed"), "stale\n");
    expect(needsNpm(target)).toBe(true);
  });
});

describe("bbReportLine", () => {
  test("one line per outcome", () => {
    expect(bbReportLine({ status: "skipped", reason: "bb not found" })).toBe("– skipped bb plugin: bb not found");
    expect(bbReportLine({ status: "failed", dir: "/d", reason: "npm ci failed (exit 1)" })).toBe(
      "✗ bb plugin failed: npm ci failed (exit 1)",
    );
    expect(bbReportLine({ status: "unchanged", dir: "/d", plugin: { status: "running" } })).toBe(
      "✓ bb plugin up to date → /d (running)",
    );
    expect(
      bbReportLine({
        status: "installed",
        dir: "/d",
        from: "path:/old",
        plugin: { status: "needs-configuration", statusDetail: "cortex missing", cortexPath: "/x/cortex" },
      }),
    ).toBe(
      "✓ bb plugin installed → /d (needs-configuration: cortex missing), moved from path:/old · runs cortex at /x/cortex",
    );
  });
});
