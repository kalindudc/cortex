// StatusBar — app-wide footer row (row 2 of the main grid, spans every column).
//
// Read-only summary computed from signals:
//   Left:   the connection indicator (liveState), the filter summary text
//           reflecting filters.value (status / lane / tag), then the latest
//           notice (state/notice.ts), if any.
//   Right:  counts — `N shown` (visibleTasks), plus `N blocked` and
//           `N in review` when nonzero, each led by its status shape — then
//           the notifications bell and the palette hint via kbd("P") from
//           lib/keys.ts.
//
// The bell shows or hides the side panel at Inbox; the palette hint opens
// the palette. Otherwise only hover tooltips on the count chips.

import type { VNode } from "preact";
import { filters, paletteOpen, workspaceQuery } from "../state/signals.ts";
import { visibleTasks, blockedTasks, UNTAGGED } from "../state/computed.ts";
import { tasks as allTasks } from "../state/signals.ts";
import { unreadCount } from "../state/notifications.ts";
import { toggleContext } from "../state/context.ts";
import { notice } from "../state/notice.ts";
import { kbd } from "../lib/keys.ts";
import { tip } from "../state/tooltip.ts";
import { Icon } from "./Icon.tsx";
import { ConnectionIndicator } from "./ConnectionIndicator.tsx";

function describeFilters(f: { status: string | null; lane: string | null; tag: string[] }, query: string): string {
  const parts: string[] = [];
  // The workspace search query is a first-class filter term — lead
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
      <ConnectionIndicator />
      <span class="filter-summary">{describeFilters(f, workspaceQuery.value)}</span>
      {/* Always mounted, so screen readers announce each notice as it appears. */}
      <span class="status-notice" role="status">
        {notice.value?.text ?? ""}
      </span>
      <span class="grow"></span>
      <span class="status-counts">
        <span class="num" {...tip("Tasks matching the current filters")}>
          {shown} shown
        </span>
        {blocked > 0 ? (
          <span class="num status-count-blocked" {...tip("Tasks currently blocked across all filters")}>
            <span class="dot dot-status-blocked" aria-hidden="true"></span>
            {blocked} blocked
          </span>
        ) : null}
        {inReview > 0 ? (
          <span class="num" {...tip("Tasks awaiting review across all filters")}>
            <span class="dot dot-status-review" aria-hidden="true"></span>
            {inReview} in review
          </span>
        ) : null}
      </span>
      {/* The side panel's Inbox trigger. Bell + unread badge mirrors the
          status-counts language above (numeric chip). */}
      <button
        type="button"
        class="notif-bell"
        aria-label="Notifications"
        onClick={() => toggleContext("inbox")}
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
