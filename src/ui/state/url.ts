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

import { batch, effect } from "@preact/signals";
import { selectedId, pendingHeadingFragment, tab, readerMode, preferredReaderMode } from "./signals.ts";

// Matches the gate in lastTask.ts:22-30: positive integer only.
const TASK_PATH = /^\/task\/(\d+)$/;

function parsePathname(path: string): number | null {
  const m = TASK_PATH.exec(path);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// Heading fragments (task 330, N1): `/task/5#task-5-beta` scrolls the
// rendered document to that heading once it exists. Valid ONLY alongside a
// task path; consumed one-shot by TaskDocument. Pure parser exported for
// unit tests. Body mode preference is stored separately — no second router.
export function parseHeadingFragment(hash: string, taskId: number | null): string | null {
  if (taskId == null) return null;
  if (!hash.startsWith("#") || hash.length < 2) return null;
  const frag = hash.slice(1);
  // Heading ids are slugified ASCII (MarkdownView) — reject anything else.
  if (!/^[a-z0-9-]{1,256}$/i.test(frag)) return null;
  return frag;
}

function stageHeadingFragment(taskId: number | null, hash: string): void {
  const id = parseHeadingFragment(hash, taskId);
  pendingHeadingFragment.value = taskId != null && id != null ? { taskId, id } : null;
  if (id != null) {
    // A heading target is meaningful in rendered prose. Reveal it even for
    // same-task Back/Forward/hash navigation, where the task-change effect
    // does not run because selectedId itself did not change. This is a
    // temporary view, not a new user preference.
    tab.value = "document";
    readerMode.value = "read";
  } else {
    readerMode.value = preferredReaderMode.peek();
  }
}

// Seed BEFORE the effect runs so the URL (if present) wins over the
// localStorage seed that lastTask.ts already applied.
const seed = parsePathname(window.location.pathname);
if (seed != null) {
  batch(() => {
    selectedId.value = seed;
    stageHeadingFragment(seed, window.location.hash);
  });
}

// Module-local flag separates the first effect tick (canonicalization of
// the initial URL — replaceState) from subsequent user-driven selections
// (pushState). Null transitions ALWAYS use replaceState regardless.
let seeded = false;

// Last location already applied by the navigation listeners. Browsers may
// dispatch popstate and hashchange for the same fragment traversal; this
// prevents staging (and therefore scrolling) the same target twice.
let handledNavigation = `${window.location.pathname}${window.location.hash}`;

effect(() => {
  const id = selectedId.value;

  // A pending target belongs to exactly one task. User selection changes
  // and deletion (`selectedId → null`) retire an old target immediately.
  const pending = pendingHeadingFragment.peek();
  if (pending != null && pending.taskId !== id) pendingHeadingFragment.value = null;

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
    handledNavigation = target; // push/replace target has no fragment
  } catch {
    /* happy-dom / private mode — ignore */
  }
  seeded = true;
});

function applyLocation(): void {
  const key = `${window.location.pathname}${window.location.hash}`;
  if (key === handledNavigation) return;
  handledNavigation = key;
  const id = parsePathname(window.location.pathname);
  batch(() => {
    selectedId.value = id;
    stageHeadingFragment(id, window.location.hash);
  });
}

// Back/Forward: parse the post-navigation pathname and write through to
// selectedId. The pathname-equality short-circuit in the effect above
// makes this echo-safe. Fragment-only traversals are also observed here.
window.addEventListener("popstate", applyLocation);
// Direct same-task anchor navigation does not necessarily change selectedId
// and therefore cannot rely on the selectedId effect. Stage it explicitly.
window.addEventListener("hashchange", applyLocation);
