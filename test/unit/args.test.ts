import { test, expect, describe } from "bun:test";
import { normalizeArgv, type SubcommandRegistry } from "../../src/args.ts";

// ---------- normalizeArgv ----------
//
// citty 0.1.x's vendored mri parser never consumes a dash-leading token as
// a string flag's value: `--body-search "- item"` leaves bodySearch as
// boolean true and re-parses "- item" as flags (a value like "-beta line"
// even hijacks the -b body alias, manufacturing a phantom args.body).
// normalizeArgv rewrites `--flag -value` into `--flag=-value` for the
// known string flags of the detected subcommand BEFORE citty parses.

// Synthetic registry covering the arg shapes that matter: long kebab,
// long camel, short alias, boolean, unknown.
const fakeRegistry: SubcommandRegistry = {
  fake: async () => ({
    args: {
      id: { type: "positional", required: true },
      bodySearch: { type: "string" },
      bodyReplace: { type: "string" },
      body: { type: "string", alias: "b" },
      title: { type: "string", alias: ["t"] },
      message: { type: "string", alias: "m" },
      json: { type: "boolean" },
    },
  }),
};

describe("normalizeArgv", () => {
  test("rewrites dash-leading value after long kebab flag", async () => {
    const out = await normalizeArgv(["fake", "1", "--body-search", "- item", "--body-replace", "- ITEM"], fakeRegistry);
    expect(out).toEqual(["fake", "1", "--body-search=- item", "--body-replace=- ITEM"]);
  });

  test("rewrites dash-leading value after long camel flag spelling", async () => {
    const out = await normalizeArgv(["fake", "1", "--bodySearch", "- item", "--bodyReplace", "- ITEM"], fakeRegistry);
    expect(out).toEqual(["fake", "1", "--bodySearch=- item", "--bodyReplace=- ITEM"]);
  });

  test("rewrites dash-leading value after short alias (no -b alias hijack)", async () => {
    // Before the fix, "-beta line" was re-parsed as `-b` + junk, setting a
    // phantom args.body that tripped the edit mutex error.
    const out = await normalizeArgv(
      ["fake", "1", "--body-search", "-beta line", "--body-replace", "BETA"],
      fakeRegistry,
    );
    expect(out).toEqual(["fake", "1", "--body-search=-beta line", "--body-replace", "BETA"]);
    const out2 = await normalizeArgv(["fake", "1", "-b", "- item"], fakeRegistry);
    expect(out2).toEqual(["fake", "1", "-b=- item"]);
  });

  test("leaves non-dash values untouched (parser consumes them natively)", async () => {
    const out = await normalizeArgv(
      ["fake", "1", "--body-search", "plain anchor", "--body-replace", "R"],
      fakeRegistry,
    );
    expect(out).toEqual(["fake", "1", "--body-search", "plain anchor", "--body-replace", "R"]);
  });

  test("leaves attached-value forms untouched", async () => {
    const argv = ["1", "--body-search=- item", "-b=- other"];
    expect(await normalizeArgv(argv, fakeRegistry)).toEqual(argv);
  });

  test("leaves unknown flags and boolean flags untouched", async () => {
    const argv = ["fake", "1", "--json", "--nope", "-zz", "--json", "-x"];
    expect(await normalizeArgv(argv, fakeRegistry)).toEqual(argv);
  });

  test("leaves a trailing flag with no following token untouched", async () => {
    const out = await normalizeArgv(["fake", "1", "--body-search"], fakeRegistry);
    expect(out).toEqual(["fake", "1", "--body-search"]);
  });

  test("leaves every token after a standalone -- untouched", async () => {
    const out = await normalizeArgv(
      ["fake", "1", "--body-search", "- item", "--", "--body-replace", "- X"],
      fakeRegistry,
    );
    expect(out).toEqual(["fake", "1", "--body-search=- item", "--", "--body-replace", "- X"]);
  });

  test("leaves argv unchanged for unknown subcommands", async () => {
    const argv = ["mystery", "1", "--body-search", "- item"];
    expect(await normalizeArgv(argv, fakeRegistry)).toEqual(argv);
  });

  test("rewrites against the detected subcommand's own defs only", async () => {
    const registry: SubcommandRegistry = {
      one: async () => ({ args: { bodySearch: { type: "string" } } }),
      two: async () => ({ args: { json: { type: "boolean" } } }),
    };
    expect(await normalizeArgv(["one", "1", "--body-search", "- x"], registry)).toEqual([
      "one",
      "1",
      "--body-search=- x",
    ]);
    expect(await normalizeArgv(["two", "1", "--body-search", "- x"], registry)).toEqual([
      "two",
      "1",
      "--body-search",
      "- x",
    ]);
  });

  test("real edit command def: dash anchor path parses as values end-to-end", async () => {
    // Use the REAL edit CommandDef through the same registry shape cli.ts
    // feeds citty, asserting the exact reported repro is rewritten.
    const registry: SubcommandRegistry = {
      edit: () => import("../../src/commands/edit.ts").then(m => m.default as unknown),
    };
    const out = await normalizeArgv(["edit", "1", "--body-search", "- item", "--body-replace", "- ITEM"], registry);
    expect(out).toEqual(["edit", "1", "--body-search=- item", "--body-replace=- ITEM"]);
  });
});
