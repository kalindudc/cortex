// StatusBar — app-wide footer row (row 2 of the main grid, spans all 3 cols).
//
// Read-only summary computed from signals:
//   Left:   filter summary text reflecting filters.value (status / lane / tag).
//   Middle: counts — `N shown` (filteredTasks), plus `N blocked` and
//           `N in review` chips when nonzero.
//   Right:  persistent palette hint via kbd("P") from lib/keys.ts.
//
// No interactivity beyond hover tooltips on the count chips.

import type { VNode } from "preact";
import { filters, paletteOpen } from "../state/signals.ts";
import { filteredTasks, blockedTasks, UNTAGGED } from "../state/computed.ts";
import { tasks as allTasks } from "../state/signals.ts";
import { kbd } from "../lib/keys.ts";
import { tip } from "../state/tooltip.ts";
import { Icon } from "./Icon.tsx";

function describeFilters(f: { status: string | null; lane: string | null; tag: string[] }): string {
  const parts: string[] = [];
  if (f.status) parts.push(f.status);
  if (f.lane) parts.push(f.lane);
  // Multi-tag is OR-composed in computed.ts; render each entry as its own
  // term joined by middots. UNTAGGED renders as the literal word "untagged".
  for (const t of f.tag) parts.push(t === UNTAGGED ? "untagged" : `#${t}`);
  if (parts.length === 0) return "All tasks";
  return parts.join(" \u00b7 ");
}

export function StatusBar(): VNode {
  const f = filters.value;
  const shown = filteredTasks.value.length;
  const blocked = blockedTasks.value.length;
  const inReview = allTasks.value.filter(t => t.status === "review").length;

  return (
    <div class="status-bar">
      <span class="filter-summary">{describeFilters(f)}</span>
      <span class="grow"></span>
      <span class="status-counts">
        <span class="num" {...tip("Tasks matching the current filters")}>
          {shown} shown
        </span>
        {blocked > 0 ? (
          <span class="num" {...tip("Tasks currently blocked across all filters")}>
            {" · "}
            {blocked} blocked
          </span>
        ) : null}
        {inReview > 0 ? (
          <span class="num" {...tip("Tasks awaiting review across all filters")}>
            {" · "}
            {inReview} in review
          </span>
        ) : null}
      </span>
      {/* Clickable palette hint — mirrors the keyboard shortcut for mouse
          users. The Commands button in the (now-removed) sidebar foot used
          to fill this role; the hint is the canonical entry now. */}
      <button
        type="button"
        class="hint hint-button"
        onClick={() => (paletteOpen.value = true)}
        aria-label="Open the command palette"
        {...tip("Open the command palette")}
      >
        <Icon name="keyboard" size={12} />
        <span class="kbd">{kbd("P")}</span>
      </button>
    </div>
  );
}
