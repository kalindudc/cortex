// InboxTab — the side panel's Inbox tab: every notification (server rows)
// and local error, unread first and newest first, from the merged feed in
// state/notifications.ts. All, Unread and Blocked filter the list; a local
// error counts as blocked, as its shape already shows.
//
// Row interaction:
//   click row     → if it's a notif row with a task_id, open that task
//                   (selectedId = task_id) AND markRead(id). Nothing
//                   closes: the panel stays beside the document.
//   click x / 👁️ → dismiss(id) / markUnread(id).
//
// Footer offers "Mark all read" + "Clear all".
//
// Persistence vs ephemeral routing happens inside the state module —
// markRead/dismiss/markAllRead/clearAll inspect the id sign (positive =
// persisted, negative = ephemeral local error) so this component never
// branches on row.kind for write operations.

import type { VNode } from "preact";
import { useSignal } from "@preact/signals";

import { selectedId } from "../../state/signals.ts";
import {
  merged,
  unreadCount,
  markRead,
  markUnread,
  markAllRead,
  dismiss,
  clearAll,
  type MergedRow,
} from "../../state/notifications.ts";
import { fmtTime } from "../../../lib/format.ts";
import { Icon } from "../Icon.tsx";

type InboxFilter = "all" | "unread" | "blocked";

function activate(row: MergedRow): void {
  if (row.kind === "notif" && row.row.task_id != null) {
    selectedId.value = row.row.task_id;
  }
  markRead(row.row.id);
}

function matches(row: MergedRow, filter: InboxFilter): boolean {
  if (filter === "unread") return !row.row.read;
  if (filter === "blocked") return row.kind === "error" || row.row.status === "blocked";
  return true;
}

/** CSS class for the dot. Notifications use the existing
 *  `dot-status-${status}` family that task rows use. Errors fall back to
 *  the blocked color (red) since errors don't have a status. */
function rowDotClass(row: MergedRow): string {
  if (row.kind === "notif") return `dot dot-status-${row.row.status}`;
  return "dot dot-status-blocked";
}

function rowTimestamp(row: MergedRow): number {
  return row.kind === "notif" ? row.row.created : row.row.ts;
}

const EMPTY_TITLE: Record<InboxFilter, string> = {
  all: "No notifications.",
  unread: "No unread notifications.",
  blocked: "No blocked notifications.",
};

export function InboxTab(): VNode {
  const filter = useSignal<InboxFilter>("all");
  const all = merged.value;
  const list = all.filter(row => matches(row, filter.value));
  const unread = unreadCount.value;
  const chip = (id: InboxFilter, label: string): VNode => (
    <button
      type="button"
      class={`ctx-chip${filter.value === id ? " is-on" : ""}`}
      aria-pressed={filter.value === id}
      onClick={() => {
        filter.value = id;
      }}
    >
      {label}
    </button>
  );
  return (
    <div class="ctx-inbox">
      <fieldset class="ctx-chips" aria-label="Filter notifications">
        {chip("all", "All")}
        {chip("unread", `Unread ${unread}`)}
        {chip("blocked", "Blocked")}
      </fieldset>
      {list.length === 0 ? (
        <div class="empty">
          <Icon name="bell" size={32} />
          <div class="empty-title">{EMPTY_TITLE[filter.value]}</div>
        </div>
      ) : (
        <ul class="notif-list">
          {list.map(entry => (
            <li key={`${entry.kind}-${entry.row.id}`} class={`notif-row${entry.row.read ? " is-read" : ""}`}>
              <button type="button" class="notif-row-body" onClick={() => activate(entry)}>
                <div class="row" style="gap:8px; align-items:flex-start">
                  <span class={rowDotClass(entry)} />
                  <div class="grow">
                    <div class="summary">{entry.row.title}</div>
                    <div class="meta">
                      <span>{entry.row.message}</span>
                      <span>&middot;</span>
                      <span>{fmtTime(rowTimestamp(entry))}</span>
                      {!entry.row.read ? <span class="notif-unread-pip" role="img" aria-label="Unread" /> : null}
                    </div>
                  </div>
                </div>
              </button>
              <div class="notif-row-controls">
                <button
                  type="button"
                  class="hint hint-button notif-dismiss"
                  aria-label="Dismiss"
                  onClick={() => dismiss(entry.row.id)}
                >
                  <Icon name="x" size={12} />
                </button>
                {entry.row.read ? (
                  <button
                    type="button"
                    class="hint hint-button notif-mark-unread"
                    aria-label="Mark as unread"
                    title="Mark as unread"
                    onClick={() => markUnread(entry.row.id)}
                  >
                    <Icon name="eyeOff" size={12} />
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {all.length > 0 ? (
        <footer class="notif-foot">
          <button type="button" class="hint hint-button" onClick={() => markAllRead()}>
            <Icon name="check" size={12} />
            <span>Mark all read</span>
          </button>
          <button type="button" class="hint hint-button" onClick={() => clearAll()}>
            Clear all
          </button>
        </footer>
      ) : null}
    </div>
  );
}
