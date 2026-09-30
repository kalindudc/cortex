// refGrammar.ts — the @id / #tag grammar with NO runtime imports, so any
// renderer (the terminal reader, src/tui/reader.ts) can share it. This file
// pins the segmentation contract itself.

import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as grammar from "../../../src/lib/refGrammar.ts";

const SOURCE = fs.readFileSync(path.resolve(import.meta.dir, "../../../src/lib/refGrammar.ts"), "utf8");

describe("refGrammar", () => {
  test("has no imports at all (safe for the terminal and any renderer)", () => {
    expect(SOURCE).not.toMatch(/^\s*import\s/m);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
  });

  test("prose segmentation the reader relies on", () => {
    expect(grammar.parseRefs("see @7, #ops.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "task", id: 7 },
      { kind: "text", text: ", " },
      { kind: "tag", name: "ops" },
      { kind: "text", text: "." },
    ]);
  });
});

describe("parseRefs", () => {
  test("interleaves text + task ref (no brackets)", () => {
    expect(grammar.parseRefs("hello @12 world")).toEqual([
      { kind: "text", text: "hello " },
      { kind: "task", id: 12 },
      { kind: "text", text: " world" },
    ]);
  });

  test("mixes task + tag refs in order", () => {
    expect(grammar.parseRefs("see #done and @1")).toEqual([
      { kind: "text", text: "see " },
      { kind: "tag", name: "done" },
      { kind: "text", text: " and " },
      { kind: "task", id: 1 },
    ]);
  });

  test("rejects refs inside identifiers — `path@123` and `#BadTag` stay plain", () => {
    expect(grammar.parseRefs("path@123 not a ref, #BadTag uppercase")).toEqual([
      { kind: "text", text: "path@123 not a ref, #BadTag uppercase" },
    ]);
  });

  test("rejects refs glued to a word char on either side", () => {
    expect(grammar.parseRefs("@123abc")).toEqual([{ kind: "text", text: "@123abc" }]);
    expect(grammar.parseRefs("a@123")).toEqual([{ kind: "text", text: "a@123" }]);
  });

  test("matches at start of input and after whitespace", () => {
    expect(grammar.parseRefs("@7")).toEqual([{ kind: "task", id: 7 }]);
    expect(grammar.parseRefs(" @7")).toEqual([
      { kind: "text", text: " " },
      { kind: "task", id: 7 },
    ]);
  });

  test("matches refs followed by punctuation", () => {
    expect(grammar.parseRefs("see @7, @12; #ops.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "task", id: 7 },
      { kind: "text", text: ", " },
      { kind: "task", id: 12 },
      { kind: "text", text: "; " },
      { kind: "tag", name: "ops" },
      { kind: "text", text: "." },
    ]);
  });

  test("markdown heading `# Heading` is NOT matched as #h… (space breaks the tag class)", () => {
    expect(grammar.parseRefs("# Heading")).toEqual([{ kind: "text", text: "# Heading" }]);
  });

  test("empty input yields []", () => {
    expect(grammar.parseRefs("")).toEqual([]);
  });

  test("multi-digit id parses to a number", () => {
    expect(grammar.parseRefs("@12345")).toEqual([{ kind: "task", id: 12345 }]);
  });

  test("REF_RE has the global flag (required by matchAll)", () => {
    expect(grammar.REF_RE.flags).toContain("g");
  });
});
