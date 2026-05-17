// state/url.ts — URL ⇄ selectedId side-effect module.
//
// Reflects the active task in the browser URL as `/task/<id>` so users can
// Back/Forward, refresh, copy-link, and bookmark — without changing how
// task selection works today. Mirrors the seed-then-effect shape used by
// state/lastTask.ts.
//
// Seed priority (boot): URL → localStorage → priority fallback.
// Enforced by import order in src/ui/index.tsx (lastTask.ts BEFORE url.ts).
//
// Watches selectedId DIRECTLY, never activeTask. activeTask has a priority
// fallback in computed.ts that surfaces a non-null task when nothing is
// selected; watching it would stamp `/task/<fallback>` into history during
// boot before the user has chosen anything, and silently rewrite the URL on
// filter/lane changes that move the fallback.

import { effect } from "@preact/signals";
import { selectedId } from "./signals.ts";

// Matches the gate in lastTask.ts:22-30: positive integer only.
const TASK_PATH = /^\/task\/(\d+)$/;

function parsePathname(path: string): number | null {
  const m = TASK_PATH.exec(path);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// Seed BEFORE the effect runs so the URL (if present) wins over the
// localStorage seed that lastTask.ts already applied.
const seed = parsePathname(window.location.pathname);
if (seed != null) selectedId.value = seed;

// Module-local flag separates the first effect tick (canonicalization of
// the initial URL — replaceState) from subsequent user-driven selections
// (pushState). Null transitions ALWAYS use replaceState regardless.
let seeded = false;

effect(() => {
  const id = selectedId.value;
  const target = id == null ? "/" : `/task/${id}`;
  // Short-circuit when the URL already matches the target. This is the
  // echo guard for popstate → effect (no extra suppression flag needed)
  // and also makes the synchronous first-run after registration a no-op
  // when the URL already matches the seed (no spurious extra history
  // entry on a `/task/42` cold load).
  if (window.location.pathname === target) {
    seeded = true;
    return;
  }
  try {
    if (!seeded || id == null) {
      // (a) initial seed reconciliation (e.g. `/` → `/task/42` because
      // localStorage restored 42 and no URL was present), and
      // (b) selectedId → null (e.g. ModalRoot clears on delete) should not
      // pollute the back stack with an entry the user did not navigate to.
      window.history.replaceState(null, "", target);
    } else {
      // Genuine user-driven selection change.
      window.history.pushState(null, "", target);
    }
  } catch {
    /* happy-dom / private mode — ignore */
  }
  seeded = true;
});

// Back/Forward: parse the post-navigation pathname and write through to
// selectedId. The pathname-equality short-circuit in the effect above
// makes this echo-safe even when the parsed id equals the current value
// (signals dedupe equal writes, so the effect does not fire at all).
window.addEventListener("popstate", () => {
  selectedId.value = parsePathname(window.location.pathname);
});

// No public exports — this module's contract is its side effects.
