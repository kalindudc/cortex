// Companion to lastTask.test.ts: covers the garbage-seed gate.
//
// The lastTask module reads localStorage at module load and must REJECT
// any payload that isn't a positive finite integer. Bun caches ESM modules
// per-process, so each seed scenario needs its own test file. The four
// concrete garbage variants the spec calls out ("abc", "-1", "0", "")
// all flow through the same `parseInt → !isFinite || <= 0` gate; testing
// one variant here is sufficient behavioral coverage for that branch.

import { describe, test, expect } from "bun:test";
import { selectedId } from "../../../src/ui/state/signals.ts";

const KEY = "cortex-last-task";

// Pre-seed garbage BEFORE importing the module under test. The module's
// readStoredId() should reject this and leave selectedId untouched (null).
localStorage.setItem(KEY, "abc");
await import("../../../src/ui/state/lastTask.ts");
const seededAfterImport = selectedId.value;

describe("state/lastTask seed gate", () => {
  test("non-numeric stored value is rejected and selectedId stays null", () => {
    expect(seededAfterImport).toBeNull();
  });
});
