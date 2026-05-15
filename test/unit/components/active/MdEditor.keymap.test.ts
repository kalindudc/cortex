// Asserts the static keymap exported from MdEditor includes the
// indentWithTab binding (Tab) and historyKeymap's Mod-z binding. We test
// the keymap as a plain data structure to avoid pulling CodeMirror into
// happy-dom (the editor itself is exercised via e2e + the smoke test in
// MdEditor.test.tsx).
//
// IMPORTANT: do NOT mock the MdEditor module from this file. The smoke
// test (MdEditor.test.tsx) installs a process-global stub via mock.module
// that REPLACES every export \u2014 including staticMdKeymap. Bun runs each
// *.test.* file in its own process, so the stub installed there does not
// leak into this file. If a future refactor merges these tests into one
// file, the stub will mask the real keymap and these assertions will
// silently fail.

import { describe, test, expect } from "bun:test";
import { staticMdKeymap } from "../../../../src/ui/components/active/MdEditor.tsx";

describe("MdEditor staticMdKeymap", () => {
  test("contains a Tab binding (indentWithTab)", () => {
    const tabBinding = staticMdKeymap.find(b => b.key === "Tab");
    expect(tabBinding).toBeTruthy();
  });

  test("contains a Mod-z binding (historyKeymap undo)", () => {
    const undoBinding = staticMdKeymap.find(b => b.key === "Mod-z");
    expect(undoBinding).toBeTruthy();
  });
});
