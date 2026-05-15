// state/postUpdateOpen.ts — Persist the active-task "Post update" form
// collapse state to localStorage and restore it on boot.
//
// Single global boolean across all tasks (no per-task collapse state) — see
// the plan's Implementation Notes for the KISS rationale.
//
// Side-effect module: importing it for its side effects is the contract.
// index.tsx does `import "./state/postUpdateOpen.ts";` before refresh() so
// the seed beats the first paint of the active-task pane.
//
// `KEY` and `parseStored` are exported ONLY for unit tests so the parser
// can be exercised as a pure function (avoids the bun:test ESM-cache trap
// where a single-process test runner can't re-execute a module's seed
// across files). No production code outside this module imports them.

import { effect } from "@preact/signals";
import { postUpdateOpen } from "./signals.ts";

export const KEY = "cortex-post-update-open";

// Pure parser. "1" / "0" only; anything else (including legacy
// "true"/"false" or null) returns null so the signal keeps its default.
export function parseStored(raw: string | null): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

// Side-effect wrapper around parseStored: localStorage access is wrapped
// in try/catch for private-mode browsers where it throws.
function readStored(): boolean | null {
  try {
    return parseStored(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

// Seed BEFORE registering the effect so the first effect run doesn't
// immediately overwrite storage with the compile-time default.
const seed = readStored();
if (seed != null) postUpdateOpen.value = seed;

effect(() => {
  const v = postUpdateOpen.value;
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    /* private mode — ignore */
  }
});
