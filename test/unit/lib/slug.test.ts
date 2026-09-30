// lib/slug.ts — the ONE heading anchor rule shared by the terminal reader
// (`:heading`) and `cortex memory show` section loads.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { slugify } from "../../../src/lib/slug.ts";

describe("slugify", () => {
  test("lowercase ASCII words joined by '-', else 'section'", () => {
    expect(slugify("Final Notes!")).toBe("final-notes");
    expect(slugify("  Hello,   World  ")).toBe("hello-world");
    expect(slugify("Ünïcode")).toBe("n-code");
    expect(slugify("!!!")).toBe("section");
    expect(slugify("")).toBe("section");
  });

  test("has no imports (safe for any caller)", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dir, "../../../src/lib/slug.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
