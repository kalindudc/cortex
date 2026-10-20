// Companion to showAllTasks.test.ts: covers the garbage-seed gate.
//
// The showAllTasks module accepts only "1" / "0" — anything else (legacy
// "true"/"false" payloads, missing key, random strings) returns null from
// readStored() and the signal keeps its compile-time default of false.
//
// Each garbage variant flows through the same single-branch gate, so one
// representative variant is sufficient behavioral coverage. Bun caches
// ESM modules per-process, which is why this lives in its own file.

import { describe, test, expect } from "bun:test";
import { showAllTasks } from "../../../src/ui/state/signals.ts";

const KEY = "cortex-show-all-tasks";

// Pre-seed a legacy / unrecognized payload BEFORE importing.
localStorage.setItem(KEY, "true");
await import("../../../src/ui/state/showAllTasks.ts");
const seededAfterImport = showAllTasks.value;

describe("state/showAllTasks seed gate", () => {
  test("unrecognized stored value is rejected and the signal keeps its default (false)", () => {
    expect(seededAfterImport).toBe(false);
  });
});
