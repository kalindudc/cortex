// state/showAllTasks.ts — Persist the "show done tasks" toggle to
// localStorage and restore it on boot. Mirrors state/lastTask.ts in shape
// and wiring (read at module load, seed the signal, register an effect to
// write back), and state/theme.ts in spirit (the user's choice always wins
// and is persisted forever — no "system" middle option).
//
// Side-effect module: importing it for its side effects is the contract.
// dashboard.tsx does `import "./state/showAllTasks.ts";` before refresh() so
// the seed beats the first paint (preserves the toggle across hard reloads
// without a flash of the wrong sidebar contents).

import { effect } from "@preact/signals";
import { showAllTasks } from "./signals.ts";

const KEY = "cortex-show-all-tasks";

// Read once at module load. Storage format is "1" / "0"; anything else
// (including legacy "true" / "false" strings or null) returns null and the
// signal keeps its compile-time default. Wrapped in try/catch for private-
// mode browsers where localStorage throws on access.
function readStored(): boolean | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "1") return true;
    if (v === "0") return false;
    return null;
  } catch {
    return null;
  }
}

// Seed BEFORE registering the effect so the first effect run doesn't
// immediately overwrite storage with the compile-time default.
const seed = readStored();
if (seed != null) showAllTasks.value = seed;

effect(() => {
  const v = showAllTasks.value;
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    /* private mode — ignore */
  }
});

// No public exports — this module's contract is its side effects.
