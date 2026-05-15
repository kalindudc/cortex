// NotificationDrawer — right-anchored slide-in panel listing notifications
// newest-first. Sources its data from src/ui/state/notifications.ts; only
// rendered when notificationsOpen.value === true.
//
// Mount-discipline contract: this component is conditionally mounted by
// App so that opening + closing the drawer fully runs mount/unmount. We
// intentionally do NOT early-return null here — same reasoning as
// CommandPalette (otherwise useEffect-based one-shot focus would only fire
// the very first time the drawer opens).
//
// Row interaction:
//   click row     → if a taskId is set, jump to it (selectedId = taskId)
//                   AND markRead(id), then close the drawer.
//   click x       → dismiss(id), drawer stays open.
//
// Footer offers "Mark all read" + "Clear all".

import type { VNode } from "preact";

import { selectedId } from "../../state/signals.ts";
import {
  notifications,
  notificationsOpen,
  markRead,
  markAllRead,
  dismiss,
  clearAll,
  type Notification,
} from "../../state/notifications.ts";
import { fmtTime } from "../../lib/format.ts";
import { Icon } from "../Icon.tsx";

function activate(n: Notification): void {
  if (n.taskId != null) {
    selectedId.value = n.taskId;
  }
  markRead(n.id);
  notificationsOpen.value = false;
}

export function NotificationDrawer(): VNode {
  const list = notifications.value;
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
          {list.map(n => (
            <li class={`notif-row notif-kind-${n.kind} ${n.read ? "is-read" : ""}`}>
              <button type="button" class="notif-row-body" onClick={() => activate(n)}>
                <div class="row" style="gap:8px; align-items:flex-start">
                  <span
                    class={`dot dot-status-${n.kind === "blocked" ? "blocked" : n.kind === "error" ? "blocked" : "open"}`}
                  />
                  <div class="grow">
                    <div class="summary">{n.title}</div>
                    <div class="meta">
                      <span>{n.message}</span>
                      <span>&middot;</span>
                      <span>{fmtTime(n.ts)}</span>
                    </div>
                  </div>
                </div>
              </button>
              <button
                type="button"
                class="hint hint-button notif-dismiss"
                aria-label="Dismiss"
                onClick={() => dismiss(n.id)}
              >
                <Icon name="x" size={12} />
              </button>
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
