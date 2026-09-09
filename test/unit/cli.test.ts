import { test, expect, describe } from "bun:test";

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
  "update",
  "edit",
  "mv",
  "rm",
  "lane",
  "tag",
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
