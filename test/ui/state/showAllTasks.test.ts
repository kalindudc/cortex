// Unit tests for the showAllTasks persistence module.
//
// Mirrors test/ui/state/lastTask.test.ts in shape: pre-set localStorage
// BEFORE the dynamic import so the seed runs against a known value, then
// capture the signal value into a const before any beforeEach reset can
// clobber it. Effect-write behavior is asserted by mutating the signal
// after the module has loaded.
//
// Bun caches ESM modules per-process. The garbage-seed path (e.g. legacy
// "true" / "false" payloads or missing keys) is covered separately in
// test/ui/state/showAllTasks.seed-invalid.test.ts.

import { describe, test, expect, beforeEach } from "bun:test";
import { showAllTasks } from "../../../src/ui/state/signals.ts";

const KEY = "cortex-show-all-tasks";

// Pre-seed BEFORE importing the module under test — the seed runs at
// module load. Capture the signal value immediately so the beforeEach
// reset below doesn't overwrite the assertion target.
localStorage.setItem(KEY, "1");
await import("../../../src/ui/state/showAllTasks.ts");
const seededAfterImport = showAllTasks.value;

describe("state/showAllTasks", () => {
  beforeEach(() => {
    showAllTasks.value = false;
    localStorage.removeItem(KEY);
  });

  test("seed restores showAllTasks from a stored '1' at module load", () => {
    expect(seededAfterImport).toBe(true);
  });

  test("effect writes '1' to localStorage when the toggle goes on", () => {
    showAllTasks.value = true;
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  test("effect writes '0' to localStorage when the toggle goes off", () => {
    showAllTasks.value = true;
    showAllTasks.value = false;
    expect(localStorage.getItem(KEY)).toBe("0");
  });
});
