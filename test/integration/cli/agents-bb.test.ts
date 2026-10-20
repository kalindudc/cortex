import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createFakeBb, type FakeBb, type FakeBbState } from "../fixtures/fake-bb.ts";
import { mkTmpEnv, ROOT, runCli } from "../helpers.ts";

// `cortex agents install|reset` installs the bb plugin when bb is present.
// Every bb and npm here is a fake (test/integration/fixtures/fake-bb.ts):
// CORTEX_BB_CLI names the fake bb, and PATH holds only the fake npm, so the
// real bb and npm never run. The plugin dir is <XDG_CONFIG_HOME>/cortex/bb-plugin.

const NPM_ARGS = ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(label: string, initial: Partial<FakeBbState> = {}) {
  const base = mkTmpEnv(label);
  cleanups.push(base.cleanup);
  const fake = createFakeBb(base.tmpDir, initial);
  const env: Record<string, string> = { ...base.env, CORTEX_BB_CLI: fake.bb, PATH: fake.binDir };
  const dir = path.join(base.tmpDir, "cortex", "bb-plugin");
  const install = (...extra: string[]) => runCli({ args: ["agents", "install", ...extra], env });
  const reset = (...extra: string[]) => runCli({ args: ["agents", "reset", "--force", ...extra], env });
  const status = async () => {
    const r = await runCli({ args: ["agents", "status", "--json"], env });
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as { bb: Record<string, unknown>; suggest: string };
  };
  return { ...base, env, fake, dir, install, reset, status };
}

/** The bb and npm calls, as `bb plugin list` / `npm ci ...` strings with the plugin dir shown as <dir>. */
function calls(fake: FakeBb, dir: string): string[] {
  return fake.calls().map(call => {
    const line = [call.cmd, ...call.argv].join(" ").replaceAll(dir, "<dir>");
    return call.cmd === "npm" ? `${line} @ ${call.cwd === fs.realpathSync(dir) ? "<dir>" : call.cwd}` : line;
  });
}

const INSTALL_CALLS = [
  "bb plugin list --json",
  `npm ${NPM_ARGS.join(" ")} @ <dir>`,
  "bb plugin install path:<dir> --yes",
  "bb plugin list --json",
  "bb plugin config cortex --json",
];

/** The repository's plugin files that the binary must embed: everything but dotfiles and test-only files. */
function expectedPluginFiles(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "integrations/bb"], {
    cwd: ROOT,
  });
  expect(listed.exitCode).toBe(0);
  return new TextDecoder()
    .decode(listed.stdout)
    .split("\n")
    .filter(Boolean)
    .map(file => file.slice("integrations/bb/".length))
    .filter(file => !path.basename(file).startsWith("."))
    .filter(file => !/\.test\.tsx?$/.test(file) && file !== "fake-cortex.ts" && file !== "vitest.config.ts")
    .sort();
}

function writtenFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

describe("cortex agents install: the bb plugin", () => {
  test("a fresh install writes exactly the plugin's files, runs npm ci there, then installs the path", async () => {
    const s = setup("bb-fresh", { settings: {} });
    const r = await s.install();
    expect(r.code, r.stderr).toBe(0);
    expect(calls(s.fake, s.dir)).toEqual(INSTALL_CALLS);
    expect(r.stdout).toContain(`✓ bb plugin installed → ${s.dir} (running)`);

    const expected = expectedPluginFiles();
    expect(expected).toContain("package-lock.json");
    expect(expected).toContain("panel/panel.tsx");
    expect(writtenFiles(s.dir)).toEqual(expected);
    for (const file of expected) {
      expect(fs.readFileSync(path.join(s.dir, file), "utf8"), file).toBe(
        fs.readFileSync(path.join(ROOT, "integrations", "bb", file), "utf8"),
      );
    }
    expect(s.fake.state().plugin).toMatchObject({ source: `path:${s.dir}`, status: "running" });
  });

  test("a second install with nothing changed runs no npm, no reload: unchanged", async () => {
    const s = setup("bb-unchanged");
    expect((await s.install()).code).toBe(0);
    s.fake.clearCalls();
    const r = await s.install("--json");
    expect(r.code, r.stderr).toBe(0);
    expect(calls(s.fake, s.dir)).toEqual([
      "bb plugin list --json",
      "bb plugin list --json",
      "bb plugin config cortex --json",
    ]);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out).sort()).toEqual(["bb", "extensions", "skills", "skipped"]);
    expect(out.bb).toEqual({ status: "unchanged", dir: s.dir, plugin: { status: "running" } });
  });

  test("a changed file reloads; a changed lockfile runs npm, then reloads", async () => {
    const s = setup("bb-changed");
    expect((await s.install()).code).toBe(0);
    fs.appendFileSync(path.join(s.dir, "app.tsx"), "\n// a hand edit");
    s.fake.clearCalls();
    let r = await s.install();
    expect(r.code, r.stderr).toBe(0);
    expect(calls(s.fake, s.dir)).toEqual([
      "bb plugin list --json",
      "bb plugin reload cortex",
      "bb plugin list --json",
      "bb plugin config cortex --json",
    ]);
    expect(r.stdout).toContain(`✓ bb plugin reloaded → ${s.dir} (running)`);
    expect(fs.readFileSync(path.join(s.dir, "app.tsx"), "utf8")).toBe(
      fs.readFileSync(path.join(ROOT, "integrations", "bb", "app.tsx"), "utf8"),
    );

    // As an older cortex leaves it: its lockfile, and node_modules installed from that lockfile.
    fs.writeFileSync(path.join(s.dir, "package-lock.json"), "{}");
    fs.writeFileSync(path.join(s.dir, "node_modules", ".cortex-installed"), "hash-of-an-older-lockfile\n");
    s.fake.clearCalls();
    r = await s.install();
    expect(r.code, r.stderr).toBe(0);
    expect(calls(s.fake, s.dir)).toEqual([
      "bb plugin list --json",
      `npm ${NPM_ARGS.join(" ")} @ <dir>`,
      "bb plugin reload cortex",
      "bb plugin list --json",
      "bb plugin config cortex --json",
    ]);
  });

  test("node_modules missing: npm runs again, then reloads", async () => {
    const s = setup("bb-no-modules");
    expect((await s.install()).code).toBe(0);
    fs.rmSync(path.join(s.dir, "node_modules"), { recursive: true });
    s.fake.clearCalls();
    expect((await s.install()).code).toBe(0);
    expect(calls(s.fake, s.dir)).toEqual([
      "bb plugin list --json",
      `npm ${NPM_ARGS.join(" ")} @ <dir>`,
      "bb plugin reload cortex",
      "bb plugin list --json",
      "bb plugin config cortex --json",
    ]);
  });

  test("a plugin installed from another path is moved here, keeping its settings, which are shown", async () => {
    const other = "/Users/someone/src/cortex/integrations/bb";
    const s = setup("bb-move", {
      plugin: { id: "cortex", source: `path:${other}`, rootDir: other, status: "running", statusDetail: null },
      settings: { cortexPath: "/opt/cortex/bin/cortex" },
    });
    const r = await s.install("--json");
    expect(r.code, r.stderr).toBe(0);
    expect(calls(s.fake, s.dir)).toEqual(INSTALL_CALLS);
    expect(JSON.parse(r.stdout).bb).toEqual({
      status: "installed",
      dir: s.dir,
      from: `path:${other}`,
      plugin: { status: "running", cortexPath: "/opt/cortex/bin/cortex" },
    });
    expect(s.fake.state().settings).toEqual({ cortexPath: "/opt/cortex/bin/cortex" });
    const human = await s.install();
    expect(human.stdout).toContain(
      `✓ bb plugin up to date → ${s.dir} (running) · runs cortex at /opt/cortex/bin/cortex`,
    );
  });

  test("a plugin that is not running after the install reports why", async () => {
    const s = setup("bb-not-running", { installStatus: "needs-configuration", installDetail: "Cortex is unavailable" });
    const r = await s.install();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`✓ bb plugin installed → ${s.dir} (needs-configuration: Cortex is unavailable)`);
    // Not running, so the next install reloads it.
    s.fake.clearCalls();
    await s.install();
    expect(calls(s.fake, s.dir)).toContain("bb plugin reload cortex");
  });

  test("a plugin from git is left alone; reset removes it and installs this one", async () => {
    const s = setup("bb-git", {
      plugin: {
        id: "cortex",
        source: "git:github.com/kalindudc/cortex",
        rootDir: "/bb/plugins/cortex",
        status: "running",
        statusDetail: null,
      },
      settings: { cortexPath: "/x/cortex" },
    });
    let r = await s.install("--json");
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).bb).toEqual({
      status: "skipped",
      reason: "the bb plugin is installed from git:github.com/kalindudc/cortex; `cortex agents reset` replaces it",
    });
    expect(calls(s.fake, s.dir)).toEqual(["bb plugin list --json"]);
    expect(fs.existsSync(s.dir)).toBe(false);

    s.fake.clearCalls();
    r = await s.reset();
    expect(r.code, r.stderr).toBe(0);
    expect(calls(s.fake, s.dir)).toEqual([
      "bb plugin list --json",
      "bb plugin remove cortex",
      ...INSTALL_CALLS.slice(1),
    ]);
    expect(s.fake.state().plugin).toMatchObject({ source: `path:${s.dir}` });
    // bb deletes a removed plugin's settings: reset says so before it runs.
    expect(s.fake.state().settings).toEqual({});
    expect(r.stdout).toContain("✓ agents reset complete");
  });

  test("reset of this plugin removes it, wipes the dir (hand files too) and installs again", async () => {
    const s = setup("bb-reset");
    expect((await s.install()).code).toBe(0);
    fs.writeFileSync(path.join(s.dir, "stray.ts"), "// left behind");
    s.fake.clearCalls();
    const prompt = await runCli({ args: ["agents", "reset"], env: s.env, stdin: "no\n" });
    expect(prompt.stdout).toContain(`  • ${s.dir}`);
    expect(prompt.stdout).toContain("which resets its settings (cortexPath)");
    expect(s.fake.calls()).toEqual([]);
    const r = await s.reset();
    expect(r.code, r.stderr).toBe(0);
    expect(calls(s.fake, s.dir)).toEqual([
      "bb plugin list --json",
      "bb plugin remove cortex",
      ...INSTALL_CALLS.slice(1),
    ]);
    expect(fs.existsSync(path.join(s.dir, "stray.ts"))).toBe(false);
  });

  test("bb installed but not running: skipped, exit 0, nothing written or run", async () => {
    const s = setup("bb-down", { reachable: false });
    const r = await s.install();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "– skipped bb plugin: bb is installed but not running; start bb, then run `cortex agents install` again",
    );
    expect(calls(s.fake, s.dir)).toEqual(["bb plugin list --json"]);
    expect(fs.existsSync(s.dir)).toBe(false);
    // reset does not wipe a dir a stopped bb may still point at.
    fs.mkdirSync(s.dir, { recursive: true });
    expect((await s.reset()).code).toBe(0);
    expect(fs.existsSync(s.dir)).toBe(true);
  });

  test("npm failing: failed, exit 1, with npm's output, after the skills and pi extension were written", async () => {
    const s = setup("bb-npm-fails", { npmFails: "npm ERR! network request to registry failed" });
    const r = await s.install("--json");
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.bb.status).toBe("failed");
    expect(out.bb.reason).toContain("npm ci failed (exit 1)");
    expect(out.bb.reason).toContain("npm ERR! network request to registry failed");
    expect(out.skills.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(s.env.CORTEX_SKILL_DIR ?? "", "cortex", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(s.env.CORTEX_PI_EXTENSION_DIR ?? "", "cortex", "index.ts"))).toBe(true);
    expect(calls(s.fake, s.dir).some(call => call.startsWith("bb plugin install"))).toBe(false);

    const human = await s.install();
    expect(human.code).toBe(1);
    expect(human.stderr).toContain("✗ bb plugin failed: npm ci failed (exit 1)");
    // A failed install leaves no marker, so the next run tries npm again.
    s.fake.setState({ npmFails: undefined });
    s.fake.clearCalls();
    expect((await s.install()).code).toBe(0);
    expect(calls(s.fake, s.dir)).toEqual(INSTALL_CALLS);
  });

  test("no npm on PATH: failed with how to fix it", async () => {
    const s = setup("bb-no-npm");
    const empty = path.join(s.tmpDir, "empty-bin");
    fs.mkdirSync(empty);
    const r = await runCli({ args: ["agents", "install", "--json"], env: { ...s.env, PATH: empty } });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).bb.reason).toBe(
      "npm not found: install Node.js (it includes npm), then run `cortex agents install` again",
    );
  });

  test("CORTEX_BB_CLI empty turns bb off; a path that is not executable is reported", async () => {
    const s = setup("bb-off");
    let r = await runCli({
      args: ["agents", "install", "--json"],
      env: { ...s.env, CORTEX_BB_CLI: "", BB_CLI: s.fake.bb },
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).bb).toEqual({ status: "skipped", reason: "bb is turned off (CORTEX_BB_CLI is empty)" });
    r = await runCli({ args: ["agents", "install", "--json"], env: { ...s.env, CORTEX_BB_CLI: "/nonexistent/bb" } });
    expect(JSON.parse(r.stdout).bb.reason).toBe("CORTEX_BB_CLI=/nonexistent/bb is not an executable file");
    expect(s.fake.calls()).toEqual([]);
  });

  test("BB_CLI is used when CORTEX_BB_CLI is unset", async () => {
    const s = setup("bb-thread");
    // An empty HOME too, so a fall-through could never reach the real ~/.bb/bin/bb.
    const env: Record<string, string> = { ...s.env, BB_CLI: s.fake.bb, HOME: path.join(s.tmpDir, "home") };
    delete env.CORTEX_BB_CLI;
    const r = await runCli({ args: ["agents", "install", "--json"], env });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).bb.status).toBe("installed");
    expect(calls(s.fake, s.dir)).toEqual(INSTALL_CALLS);
  });
});

describe("cortex agents status: the bb plugin", () => {
  test("only asks bb: missing before an install, installed after, with its settings shown", async () => {
    const s = setup("bb-status", { settings: { cortexPath: "/opt/cortex/bin/cortex" } });
    expect((await s.status()).bb).toEqual({ state: "missing", dir: s.dir });
    expect(calls(s.fake, s.dir)).toEqual(["bb plugin list --json"]);
    expect(fs.existsSync(s.dir)).toBe(false);

    expect((await s.install()).code).toBe(0);
    s.fake.clearCalls();
    const after = await s.status();
    expect(after.bb).toEqual({
      state: "installed",
      dir: s.dir,
      plugin: { status: "running", cortexPath: "/opt/cortex/bin/cortex" },
    });
    expect(after.suggest).toBe("none");
    expect(calls(s.fake, s.dir)).toEqual(["bb plugin list --json", "bb plugin config cortex --json"]);
  });

  test("outdated says what install would change: files, dependencies, the path bb runs, a stopped plugin", async () => {
    const s = setup("bb-status-outdated");
    expect((await s.install()).code).toBe(0);
    fs.appendFileSync(path.join(s.dir, "app.tsx"), "\n// a hand edit");
    fs.rmSync(path.join(s.dir, "node_modules"), { recursive: true });
    const other = "/Users/someone/src/cortex/integrations/bb";
    s.fake.setState({
      plugin: { id: "cortex", source: `path:${other}`, rootDir: other, status: "error", statusDetail: "build failed" },
    });
    s.fake.clearCalls();
    const out = await s.status();
    expect(out.bb).toEqual({
      state: "outdated",
      dir: s.dir,
      reason: `bb runs it from ${other}; 1 file differs from this version; its dependencies are not installed for this version; bb reports it error`,
      plugin: { status: "error", statusDetail: "build failed" },
    });
    expect(out.suggest).toBe("install");
    expect(calls(s.fake, s.dir).some(c => !c.startsWith("bb plugin list") && !c.startsWith("bb plugin config"))).toBe(
      false,
    );
  });

  test("a plugin from git suggests reset; bb not running is skipped", async () => {
    const s = setup("bb-status-git", {
      plugin: {
        id: "cortex",
        source: "git:github.com/kalindudc/cortex",
        rootDir: "/bb/plugins/cortex",
        status: "running",
        statusDetail: null,
      },
    });
    expect((await s.install()).code).toBe(0);
    const out = await s.status();
    expect(out.bb).toMatchObject({ state: "foreign", dir: s.dir });
    expect(String(out.bb.reason)).toContain("installed from git:github.com/kalindudc/cortex");
    expect(out.suggest).toBe("reset");

    s.fake.setState({ reachable: false });
    expect((await s.status()).bb).toEqual({
      state: "skipped",
      reason: "bb is installed but not running; start bb to check the plugin",
    });
  });
});
