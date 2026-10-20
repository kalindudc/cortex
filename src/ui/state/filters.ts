// state/filters.ts — Persist the unified `filters` signal ({ status, lane,
// tag[] }) to localStorage and restore it on boot.
//
// Storage layout: ONE JSON key (cortex-filters) — heterogeneous shape rules
// out the three-flat-keys approach used for the boolean modules. On any
// validation failure the WHOLE payload is rejected and the compile-time
// default wins (no partial-merge — half-restored filter chips would confuse
// the user more than a clean reset).
//
// Stored lanes / tags that no longer exist are NOT validated against
// lanes.value / tags.value: those signals aren't populated at module-load
// time, and filteredTasks already degrades gracefully (visible list goes
// empty; FilterChips strip lets the user clear).
//
// Side-effect module: importing it for its side effects is the contract.
// dashboard.tsx does `import "./state/filters.ts";` before refresh() so the
// seed beats the first paint of the sidebar.
//
// `KEY` and `parseStored` are exported ONLY for unit tests so the parser
// can be exercised as a pure function (avoids the bun:test ESM-cache trap
// where a single-process test runner can't re-execute a module's seed
// across files). No production code outside this module imports them.

import { effect } from "@preact/signals";
import { filters, type Filters } from "./signals.ts";
import type { TaskStatus } from "../api/types.ts";

export const KEY = "cortex-filters";

const STATUS_VALUES: readonly TaskStatus[] = ["draft", "open", "review", "blocked", "done"];

// Pure parser. Accepts the raw localStorage string (or null) and returns a
// fully-typed Filters object on success, or null on any failure (missing
// payload, JSON parse error, or any shape violation). Validation is whole-
// payload: one bad field rejects the whole object so the user never sees a
// half-restored filter chip strip.
export function parseStored(raw: string | null): Filters | null {
  if (raw == null || raw === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // status: null OR one of the known TaskStatus literals.
  const status = obj.status;
  if (status !== null && !(typeof status === "string" && (STATUS_VALUES as readonly string[]).includes(status))) {
    return null;
  }

  // lane: null OR string.
  const lane = obj.lane;
  if (lane !== null && typeof lane !== "string") return null;

  // tag: array of strings (UNTAGGED sentinel is just a string at runtime).
  const tag = obj.tag;
  if (!Array.isArray(tag) || !tag.every(x => typeof x === "string")) return null;

  return {
    status: status as TaskStatus | null,
    lane: lane as string | null,
    tag: tag as string[],
  };
}

// Side-effect wrapper around parseStored: localStorage access is wrapped
// in try/catch for private-mode browsers where it throws.
function readStored(): Filters | null {
  try {
    return parseStored(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

// Seed BEFORE registering the effect so the first effect run doesn't
// immediately overwrite storage with the compile-time default.
const seed = readStored();
if (seed != null) filters.value = seed;

effect(() => {
  const v = filters.value;
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private mode — ignore */
  }
});
