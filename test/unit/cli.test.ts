import { test, expect, describe } from "bun:test";
import { entryArgs } from "../../src/commands/app.ts";

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
  "serve",
  "stop",
  "reset",
  "resume",
  "watch",
  "backup",
  "restore",
  "memory",
  "agents",
  "app",
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

// ---------- plain `cortex` opens the desktop app only on an interactive terminal ----------
//
// No-argument `cortex` on a TTY (stdin AND stdout) runs `cortex app`; without
// a TTY it keeps the usage output and exit code, and every other argv is
// untouched.

describe("no-argument entry", () => {
  const tty = () => true;
  const pipe = () => false;

  test("no arguments on an interactive terminal run `cortex app`", () => {
    expect(entryArgs([], tty)).toEqual(["app"]);
  });

  test("no arguments without a TTY keep today's behavior (usage, exit 1)", () => {
    expect(entryArgs([], pipe)).toEqual([]);
  });

  test("any argument is passed through unchanged, and the terminal is not even inspected", () => {
    const inspect = () => {
      throw new Error("the terminal must not be inspected");
    };
    for (const argv of [["--help"], ["-h"], ["--version"], ["ls"], ["app", "12"], ["show", "1", "--json"]]) {
      expect(entryArgs(argv, inspect)).toEqual(argv);
    }
  });

  test("src/cli.ts routes runMain through entryArgs with a stdin+stdout TTY check", async () => {
    const src = await cliSourcePromise;
    // entryArgs decides plain `cortex` -> `app` first; normalizeArgv (src/args.ts) then rewrites dash-leading values.
    expect(src).toMatch(
      /runMain\(main,\s*\{\s*rawArgs:\s*await normalizeArgv\(\s*entryArgs\(process\.argv\.slice\(2\),/,
    );
    expect(src).toMatch(/isatty\(0\)\s*&&\s*isatty\(1\)/);
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
