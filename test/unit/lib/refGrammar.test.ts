// refGrammar.ts — the @id / #tag grammar with NO runtime imports, so the
// terminal reader (src/tui/reader.ts) shares the browser's exact grammar
// without loading its singleton signals (plan @400 N15). The segmentation
// contract itself is pinned by refs.test.ts through refs.ts's re-export.

import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as grammar from "../../../src/ui/lib/refGrammar.ts";
import * as refs from "../../../src/ui/lib/refs.ts";

const SOURCE = fs.readFileSync(path.resolve(import.meta.dir, "../../../src/ui/lib/refGrammar.ts"), "utf8");

describe("refGrammar", () => {
  test("has no imports at all (safe for the terminal and any renderer)", () => {
    expect(SOURCE).not.toMatch(/^\s*import\s/m);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
  });

  test("refs.ts re-exports the same grammar (one source of truth)", () => {
    expect(refs.parseRefs).toBe(grammar.parseRefs);
    expect(refs.REF_RE).toBe(grammar.REF_RE);
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
