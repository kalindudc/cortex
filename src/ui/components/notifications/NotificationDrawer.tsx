// NotificationDrawer — right-anchored slide-in panel listing notifications
// newest-first. Sources its data from the merged tagged-union signal in
// src/ui/state/notifications.ts (server-persisted notifications + ephemeral
// local errors); only rendered when notificationsOpen.value === true.
//
// Mount-discipline contract: this component is conditionally mounted by
// App so that opening + closing the drawer fully runs mount/unmount. We
// intentionally do NOT early-return null here — same reasoning as
// CommandPalette (otherwise useEffect-based one-shot focus would only fire
// the very first time the drawer opens).
//
// Row interaction:
//   click row     → if it's a notif row with a task_id, jump to it
//                   (selectedId = task_id) AND markRead(id), then close
//                   the drawer. Error rows just markRead.
//   click x       → dismiss(id), drawer stays open.
//
// Footer offers "Mark all read" + "Clear all".
//
// Persistence vs ephemeral routing happens inside the state module —
// markRead/dismiss/markAllRead/clearAll inspect the id sign (positive =
// persisted, negative = ephemeral local error) so this component never
// branches on row.kind for write operations.

import type { VNode } from "preact";

import { selectedId } from "../../state/signals.ts";
import {
  merged,
  notificationsOpen,
  markRead,
  markUnread,
  markAllRead,
  dismiss,
  clearAll,
  type MergedRow,
} from "../../state/notifications.ts";
import { fmtTime } from "../../lib/format.ts";
import { Icon } from "../Icon.tsx";

function activate(row: MergedRow): void {
  if (row.kind === "notif" && row.row.task_id != null) {
    selectedId.value = row.row.task_id;
  }
  markRead(row.row.id);
  notificationsOpen.value = false;
}

/** CSS class for the left-edge accent stripe. Notifications mirror their
 *  status' dot color via `notif-status-${status}`; ephemeral errors keep
 *  the legacy `notif-kind-error` class (red). */
function rowAccentClass(row: MergedRow): string {
  if (row.kind === "notif") return `notif-status-${row.row.status}`;
  return "notif-kind-error";
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

export function NotificationDrawer(): VNode {
  const list = merged.value;
  return (
    <aside class="notif-drawer" data-pop>
      <header class="notif-head">
        <h2 class="eyebrow grow">Notifications</h2>
        <button type="button" class="hint hint-button" onClick={() => (notificationsOpen.value = false)}>
          <Icon name="x" size={14} />
        </button>
      </header>
      {list.length === 0 ? (
        <div class="empty">
          <Icon name="bell" size={32} />
          <div class="empty-title">No notifications.</div>
        </div>
      ) : (
        <ul class="notif-list">
          {list.map(entry => (
            <li
              key={`${entry.kind}-${entry.row.id}`}
              class={`notif-row ${rowAccentClass(entry)} ${entry.row.read ? "is-read" : ""}`}
            >
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
      {list.length > 0 ? (
        <footer class="notif-foot">
          <button type="button" class="hint hint-button" onClick={() => markAllRead()}>
            Mark all read
          </button>
          <button type="button" class="hint hint-button" onClick={() => clearAll()}>
            Clear all
          </button>
        </footer>
      ) : null}
    </aside>
  );
}
