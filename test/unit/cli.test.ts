import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTuiArgs, entryArgs } from "../../src/commands/tui.ts";

// ---------- meta-tests on src/cli.ts ----------
//
// src/cli.ts calls runMain() at module-import time (top level), so we
// cannot `import` it here without actually invoking the CLI. Instead we
// load the source as text and assert on its structure, plus dynamically
// import each command module to validate the citty CommandDef shape.

const EXPECTED_SUBCOMMANDS = [
  "init",
  "add",
  "ls",
  "show",
  "search",
  "schema",
  "doctor",
  "update",
  "edit",
  "mv",
  "rm",
  "lane",
  "tag",
  "tui",
  "serve",
  "open",
  "stop",
  "reset",
  "resume",
  "backup",
  "restore",
] as const;

const cliSourcePromise = Bun.file("src/cli.ts").text();

describe("src/cli.ts source registration", () => {
  test("registers every expected subCommand key", async () => {
    const src = await cliSourcePromise;
    EXPECTED_SUBCOMMANDS.forEach(name => {
      // matches e.g.   init: () => import("./commands/init.ts").then(...)
      const re = new RegExp(`\\b${name}\\s*:\\s*\\(\\)\\s*=>\\s*import\\(["']\\./commands/${name}\\.ts["']\\)`);
      expect(src).toMatch(re);
    });
  });

  test("declares meta name 'cortex'", async () => {
    const src = await cliSourcePromise;
    expect(src).toMatch(/name\s*:\s*["']cortex["']/);
  });

  test("does not register any unexpected subCommand keys", async () => {
    const src = await cliSourcePromise;
    // pull every "<key>: () => import(\"./commands/...\")" pair and confirm
    // they are all in EXPECTED_SUBCOMMANDS — guards against drift.
    const re = /(\w+)\s*:\s*\(\)\s*=>\s*import\(["']\.\/commands\/[^"']+["']\)/g;
    const found = [...src.matchAll(re)].map(m => m[1]);
    expect(found.sort()).toEqual([...EXPECTED_SUBCOMMANDS].sort());
  });
});

describe("command modules export citty CommandDef", () => {
  test("every expected command module's default export looks like a CommandDef", async () => {
    for (const name of EXPECTED_SUBCOMMANDS) {
      const mod = await import(`../../src/commands/${name}.ts`);
      expect(mod.default, `${name}.default`).toBeDefined();
      const def = mod.default;
      // citty CommandDef has at least one of: meta / args / run
      const looksLikeCommand =
        def != null && typeof def === "object" && ("meta" in def || "args" in def || "run" in def);
      expect(looksLikeCommand, `${name} default is a CommandDef`).toBe(true);
    }
  });
});

// ---------- plain `cortex` opens the TUI only on an interactive terminal ----------
//
// Plan @400 N5: no-argument `cortex` on a TTY (stdin AND stdout) runs `cortex
// tui`; without a TTY it keeps today's usage output and exit code, and every
// other argv (--help, --version, commands) is untouched.

describe("no-argument entry (N5)", () => {
  const tty = () => true;
  const pipe = () => false;

  test("no arguments on an interactive terminal run `cortex tui`", () => {
    expect(entryArgs([], tty)).toEqual(["tui"]);
  });

  test("no arguments without a TTY keep today's behavior (usage, exit 1)", () => {
    expect(entryArgs([], pipe)).toEqual([]);
  });

  test("any argument is passed through unchanged, and the terminal is not even inspected", () => {
    const inspect = () => {
      throw new Error("the terminal must not be inspected");
    };
    for (const argv of [["--help"], ["-h"], ["--version"], ["ls"], ["tui", "12"], ["show", "1", "--json"]]) {
      expect(entryArgs(argv, inspect)).toEqual(argv);
    }
  });

  test("src/cli.ts routes runMain through entryArgs with a stdin+stdout TTY check", async () => {
    const src = await cliSourcePromise;
    // entryArgs decides plain `cortex` -> `tui` first; normalizeArgv (src/args.ts) then rewrites dash-leading values.
    expect(src).toMatch(
      /runMain\(main,\s*\{\s*rawArgs:\s*await normalizeArgv\(\s*entryArgs\(process\.argv\.slice\(2\),/,
    );
    expect(src).toMatch(/isatty\(0\)\s*&&\s*isatty\(1\)/);
  });
});

describe("cortex tui argument checks (run before the alternate screen)", () => {
  const interactive = { stdin: true, stdout: true, term: "xterm-256color" };
  const saved = process.env.XDG_CONFIG_HOME;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-args-"));
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const reason = async (args: Parameters<typeof checkTuiArgs>[0], term = interactive) => {
    const r = await checkTuiArgs(args, term);
    return r.ok ? null : r.message;
  };

  test("valid arguments become runTui options", async () => {
    expect(await checkTuiArgs({}, interactive)).toEqual({ ok: true, options: { profile: "default" } });
    expect(
      await checkTuiArgs({ id: "@12", heading: "task-12-plan", profile: "work", theme: "cortex-light" }, interactive),
    ).toEqual({ ok: true, options: { taskId: 12, heading: "task-12-plan", profile: "work", theme: "cortex-light" } });
  });

  test("a task id is a positive integer", async () => {
    for (const id of ["0", "-3", "abc", "1.5", "12x", "99999999999999999999"]) {
      expect(await reason({ id })).toMatch(/task id/);
    }
  });

  test("--heading needs a task id and an anchor slug", async () => {
    expect(await reason({ heading: "plan" })).toMatch(/--heading needs a task id/);
    expect(await reason({ id: "3", heading: "" })).toMatch(/--heading/);
    expect(await reason({ id: "3", heading: "no spaces" })).toMatch(/--heading/);
    expect(await reason({ id: "3", heading: true })).toMatch(/--heading/);
    expect(await reason({ id: "3", heading: "#" })).toMatch(/--heading/);
  });

  test("--heading takes a bare slug, the web anchor, or the web URL's #fragment as written", async () => {
    for (const [heading, expected] of [
      ["plan-2", "plan-2"],
      ["task-3-plan", "task-3-plan"],
      ["#task-3-plan", "task-3-plan"],
    ] as const) {
      const r = await checkTuiArgs({ id: "3", heading }, interactive);
      expect(r).toEqual({ ok: true, options: { taskId: 3, heading: expected, profile: "default" } });
    }
  });

  test("--profile must be a safe profile name", async () => {
    for (const profile of ["../x", ".hidden", "", "a/b", "-x"]) expect(await reason({ profile })).toMatch(/profile/);
  });

  test("--theme must name a bundled theme or a loadable custom theme", async () => {
    expect(await reason({ theme: "Not A Name" })).toMatch(/--theme/);
    expect(await reason({ theme: "missing" })).toMatch(/--theme "missing".*not found/);
    fs.mkdirSync(path.join(dir, "cortex", "themes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cortex", "themes", "mine.toml"), 'extends = "cortex-dark"\n');
    expect(await reason({ theme: "mine" })).toBeNull();
    fs.writeFileSync(path.join(dir, "cortex", "themes", "broken.toml"), "text = [");
    expect(await reason({ theme: "broken" })).toMatch(/--theme "broken".*invalid TOML/);
  });

  test("stdin and stdout must be a TTY, and TERM=dumb is refused with CLI guidance", async () => {
    expect(await reason({}, { ...interactive, stdin: false })).toMatch(/interactive terminal.*cortex ls/);
    expect(await reason({}, { ...interactive, stdout: false })).toMatch(/interactive terminal/);
    expect(await reason({}, { ...interactive, term: "dumb" })).toMatch(/TERM=dumb.*cortex ls/);
  });

  test("argument errors are reported before terminal problems", async () => {
    expect(await reason({ id: "x" }, { stdin: false, stdout: false, term: "dumb" })).toMatch(/task id/);
  });
});

describe("static command discovery stays in step with the CLI", () => {
  test("`cortex schema` lists every registered subcommand", async () => {
    const schema = await Bun.file("src/commands/schema.ts").text();
    for (const name of EXPECTED_SUBCOMMANDS) {
      expect(schema, `schema.ts lists ${name}`).toMatch(new RegExp(`name:\\s*"${name}"`));
    }
  });
});
