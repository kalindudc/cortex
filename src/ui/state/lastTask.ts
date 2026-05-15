// state/lastTask.ts — Persist the last viewed task id to localStorage and
// restore it on boot. Mirrors state/theme.ts in shape and wiring.
//
// Filter state is intentionally NOT persisted (matches sibling sidebar
// signals which are all in-memory only). "Respect the filters" is enforced
// by activeTask in computed.ts: a stored id that the current filters /
// showAllTasks gate exclude is silently dropped and the fallback runs.
//
// Side-effect module: importing it for its side effects is the contract.
// index.tsx does `import "./state/lastTask.ts";` before refresh() so the
// seed beats the first task fetch.

import { effect } from "@preact/signals";
import { selectedId } from "./signals.ts";
import { activeTask } from "./computed.ts";

const KEY = "cortex-last-task";

// Read once at module load; reject non-positive-int payloads. Wrap in
// try/catch for private-mode browsers where localStorage throws on access.
function readStoredId(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null || raw === "") return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

// Seed selectedId BEFORE registering the effect so the first run doesn't
// overwrite the stored value with null while tasks are still loading.
const seed = readStoredId();
if (seed != null) selectedId.value = seed;

// De-dupe writes per closure so unrelated activeTask recomputations don't
// hammer setItem. Skip nulls — preserves the prior value during transient
// null states (e.g. between filter swap and next refresh resolve).
let lastWritten: number | null = null;
effect(() => {
  const at = activeTask.value;
  if (!at || at.id === lastWritten) return;
  lastWritten = at.id;
  try {
    localStorage.setItem(KEY, String(at.id));
  } catch {
    /* private mode — ignore */
  }
});

// No public exports — this module's contract is its side effects.
