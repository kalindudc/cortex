// StatusBar — app-wide footer row (row 2 of the main grid, spans all 3 cols).
//
// Read-only summary computed from signals:
//   Left:   filter summary text reflecting filters.value (status / lane / tag).
//   Middle: counts — `N shown` (visibleTasks), plus `N blocked` and
//           `N in review` chips when nonzero.
//   Right:  persistent palette hint via kbd("P") from lib/keys.ts.
//
// No interactivity beyond hover tooltips on the count chips.

import type { VNode } from "preact";
import { filters, paletteOpen, workspaceQuery } from "../state/signals.ts";
import { visibleTasks, blockedTasks, UNTAGGED } from "../state/computed.ts";
import { tasks as allTasks } from "../state/signals.ts";
import { notificationsOpen, unreadCount } from "../state/notifications.ts";
import { kbd } from "../lib/keys.ts";
import { tip } from "../state/tooltip.ts";
import { Icon } from "./Icon.tsx";

function describeFilters(f: { status: string | null; lane: string | null; tag: string[] }, query: string): string {
  const parts: string[] = [];
  // The workspace search query is a first-class filter term (W3) — lead
  // with it so the summary reads like the composed filter it is.
  if (query.trim() !== "") parts.push(`“${query.trim()}”`);
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
  const shown = visibleTasks.value.length;
  const blocked = blockedTasks.value.length;
  const inReview = allTasks.value.filter(t => t.status === "review").length;

  return (
    <div class="status-bar">
      <span class="filter-summary">{describeFilters(f, workspaceQuery.value)}</span>
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
      {/* Notifications drawer trigger. Bell + unread badge mirrors the
          status-counts language above (numeric chip). data-pop opts the
          button out of the document-level outside-click close handler so
          this click can toggle the drawer without it being closed in the
          same event flow (the drawer body also carries data-pop). */}
      <button
        type="button"
        class="notif-bell"
        data-pop
        aria-label="Notifications"
        onClick={() => (notificationsOpen.value = !notificationsOpen.value)}
        {...tip("Notifications")}
      >
        <Icon name="bell" size={14} />
        {unreadCount.value > 0 ? <span class="notif-badge num">{unreadCount.value}</span> : null}
      </button>
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
        <span class="kbd">{kbd("K")}</span>
        <span class="meta">/</span>
        <span class="kbd">{kbd("P")}</span>
      </button>
    </div>
  );
}
