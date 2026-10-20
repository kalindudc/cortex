// state/sectionOpen.ts — Persist the sidebar section-open booleans (Views /
// Lanes / Tasks) to localStorage and restore them on boot.
//
// Storage layout: three flat keys, each "1" / "0" — same single-bool-per-key
// shape as state/showAllTasks.ts. A heterogeneous JSON blob would be
// overkill for three independent booleans.
//
// Side-effect module: importing it for its side effects is the contract.
// dashboard.tsx does `import "./state/sectionOpen.ts";` before refresh() so the
// seed beats the first paint of the sidebar.
//
// `KEYS` and `parseStored` are exported ONLY for unit tests so the parser
// can be exercised as a pure function (avoids the bun:test ESM-cache trap
// where a single-process test runner can't re-execute a module's seed
// across files). No production code outside this module imports them.

import { effect } from "@preact/signals";
import { sectionOpen } from "./signals.ts";

export const KEYS = {
  views: "cortex-section-views-open",
  lanes: "cortex-section-lanes-open",
  tasks: "cortex-section-tasks-open",
} as const;

export type SectionState = { views: boolean; lanes: boolean; tasks: boolean };

// Pure per-key parser. "1" / "0" only; anything else returns null so that
// slot keeps its compile-time default.
function parseBool(raw: string | null): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

// Pure parser over a (key → raw) map. Returns the partial overrides that
// should be merged with the compile-time default. Keys whose raw value
// fails parseBool are omitted from the result.
export function parseStored(raws: {
  views: string | null;
  lanes: string | null;
  tasks: string | null;
}): Partial<SectionState> {
  const out: Partial<SectionState> = {};
  const v = parseBool(raws.views);
  if (v != null) out.views = v;
  const l = parseBool(raws.lanes);
  if (l != null) out.lanes = l;
  const t = parseBool(raws.tasks);
  if (t != null) out.tasks = t;
  return out;
}

// Side-effect wrapper around parseStored: localStorage access is wrapped
// in try/catch for private-mode browsers where it throws.
function readStored(): Partial<SectionState> {
  try {
    return parseStored({
      views: localStorage.getItem(KEYS.views),
      lanes: localStorage.getItem(KEYS.lanes),
      tasks: localStorage.getItem(KEYS.tasks),
    });
  } catch {
    return {};
  }
}

// Seed BEFORE registering the effect so the first effect run doesn't
// immediately overwrite storage with the compile-time default.
sectionOpen.value = { ...sectionOpen.value, ...readStored() };

effect(() => {
  const v = sectionOpen.value;
  try {
    localStorage.setItem(KEYS.views, v.views ? "1" : "0");
    localStorage.setItem(KEYS.lanes, v.lanes ? "1" : "0");
    localStorage.setItem(KEYS.tasks, v.tasks ? "1" : "0");
  } catch {
    /* private mode — ignore */
  }
});
