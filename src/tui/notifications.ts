// Notifications for one terminal session, as a keyboard-complete list dialog.
//
// - The feed is the daemon's persisted notifications (the session's
//   workspace snapshot, `notification.added` rows, and one coalesced re-read
//   after `notification.changed`): unread first, then newest first inside
//   each group. This session's errors are not rows: every one is recorded in
//   :messages and shown on the status line.
// - Read state is SHARED: read, unread, all read, dismiss and clear go to the
//   daemon through session.acknowledgeNotifications (shown at once; a re-read
//   that predates the write never undoes it; a failure is reported and
//   re-read), and every other client converges on `notification.changed`.
//   The highlighted row and the dialog belong to the session.
// - :notifications opens the dialog: Enter opens the row's task (the explicit
//   selection plus a :back entry; the list filters are untouched) and marks
//   it read; r read, u unread, a all read, x dismiss, X clear all. The status
//   line counts the unread rows with a text marker.
// - Attention ONLY for the daemon's explicit blocked-transition frame
//   (`task.blocked`, which the session hands over as it arrives): never a
//   snapshot, a reconnect, a replay or a task.updated copy of a task that is
//   (still) blocked. By default it flashes the status line; tui.toml
//   `bell = true` also rings the terminal bell and `flash = false` silences
//   the flash.
// - Every untrusted string (titles, messages, authors, errors) is escaped by
//   the dialog (src/tui/safety.ts) or the status line before style().

import type { BlockedTransition } from "../contracts.ts";
import type { Notification } from "../store.ts";
import { STATUS_LABEL } from "../lib/constants.ts";
import { fmtTime } from "../lib/format.ts";
import { CommandError } from "./commands.ts";
import { type DialogRow, showDialog } from "./dialogs.ts";
import type { TuiSession } from "./session.ts";
import { STATUS_MARK } from "./workspace.ts";

export interface NotificationOptions {
  /** Flash the status line when a task becomes blocked (tui.toml `flash`; default true). */
  readonly flash?: boolean;
  /** Also ring the terminal bell (tui.toml `bell`; default false: opt-in). */
  readonly bell?: boolean;
  /** Writes to the shell's terminal (the bell); null without one. */
  readonly write?: ((data: string) => void) | null;
}

/** The unread marker (the status line uses it too): a glyph and a word, never color alone. */
export const UNREAD_MARK = "✉";
const BEL = "\x07";
const NOTIF_KEY = "n:";

/** The feed order: unread before read, then newest first inside each group. */
export function orderFeed(rows: readonly Notification[]): Notification[] {
  return [...rows].sort((a, b) => Number(a.read) - Number(b.read) || b.created - a.created);
}

/** The unread count. */
export function countUnread(rows: readonly Notification[]): number {
  return rows.reduce((n, r) => n + (r.read ? 0 : 1), 0);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class Notifications {
  readonly #session: TuiSession;
  #flash: boolean;
  #bell: boolean;
  readonly #write: ((data: string) => void) | null;
  #memo: { notifications: readonly Notification[]; value: Notification[] } | null = null;

  constructor(session: TuiSession, options: NotificationOptions = {}) {
    this.#session = session;
    this.#flash = options.flash ?? true;
    this.#bell = options.bell ?? false;
    this.#write = options.write ?? null;
  }

  get flash(): boolean {
    return this.#flash;
  }

  get bell(): boolean {
    return this.#bell;
  }

  /** The ordered feed (memoized per input). */
  feed(): Notification[] {
    const notifications = this.#session.notifications;
    const memo = this.#memo;
    if (memo !== null && memo.notifications === notifications) return memo.value;
    const value = orderFeed(notifications);
    this.#memo = { notifications, value };
    return value;
  }

  unread(): number {
    return countUnread(this.feed());
  }

  // ---------- session hooks ----------

  /** The daemon's explicit transition into blocked, as it arrived on the live stream. */
  blocked(transition: BlockedTransition): void {
    const task = transition?.task;
    if (task === null || typeof task !== "object" || typeof task.id !== "number") return;
    if (this.#flash) {
      const by = typeof transition.author === "string" && transition.author !== "" ? ` by ${transition.author}` : "";
      this.#session.notify(
        "warn",
        `${STATUS_MARK.blocked} @${task.id} is blocked${by}: ${task.title} · :notifications`,
      );
    }
    if (this.#bell) this.#write?.(BEL);
  }

  // ---------- the row and footer controls ----------

  markRead(id: number): void {
    this.#acknowledge(
      rows => rows.map(n => (n.id === id && !n.read ? { ...n, read: true } : n)),
      client => client.markNotifRead(id),
      "mark the notification read",
    );
  }

  markUnread(id: number): void {
    this.#acknowledge(
      rows => rows.map(n => (n.id === id && n.read ? { ...n, read: false } : n)),
      client => client.markNotifUnread(id),
      "mark the notification unread",
    );
  }

  markAllRead(): void {
    this.#acknowledge(
      rows => rows.map(n => (n.read ? n : { ...n, read: true })),
      client => client.markAllNotifRead(),
      "mark every notification read",
    );
  }

  dismiss(id: number): void {
    this.#acknowledge(
      rows => rows.filter(n => n.id !== id),
      client => client.delNotif(id),
      "dismiss the notification",
    );
  }

  clearAll(): void {
    this.#acknowledge(
      () => [],
      client => client.clearNotifs(),
      "clear the notifications",
    );
  }

  /** Enter: open the row's task (keeping the list filters; :back returns), mark it read. */
  open(row: Notification): void {
    if (row.task_id !== null) {
      const id = row.task_id;
      if (this.#session.tasks.some(t => t.id === id)) this.#session.jump(id);
      else this.#session.notify("info", `@${id} no longer exists`);
    }
    this.markRead(row.id);
  }

  /** :notifications: the feed as a keyboard-complete list dialog. */
  show(): void {
    const byKey = (row: DialogRow | null): Notification | null =>
      row === null ? null : (this.feed().find(r => keyOf(r) === row.key) ?? null);
    const need = (row: DialogRow | null): Notification => {
      const found = byKey(row);
      if (found === null) throw new CommandError("Highlight a notification first");
      return found;
    };
    const feed = this;
    showDialog(
      this.#session,
      {
        kind: "list",
        get title() {
          return `NOTIFICATIONS · ${feed.unread()} unread`;
        },
        label: "notifications",
        pickLabel: "opens its task",
        empty: "No notifications",
        rows: () => this.feed().map(rowOf),
        pick: (row, dialog) => {
          const found = byKey(row);
          if (found !== null) this.open(found);
          dialog.finish();
        },
        keys: [
          { key: "r", label: "read", row: true, run: row => this.markRead(need(row).id) },
          { key: "u", label: "unread", row: true, run: row => this.markUnread(need(row).id) },
          { key: "a", label: "all read", run: () => this.markAllRead() },
          { key: "x", label: "dismiss", row: true, run: row => this.dismiss(need(row).id) },
          { key: "X", label: "clear all", run: () => this.clearAll() },
        ],
      },
      "large",
    );
  }

  #acknowledge(
    patch: (rows: readonly Notification[]) => Notification[],
    send: Parameters<TuiSession["acknowledgeNotifications"]>[1],
    what: string,
  ): void {
    this.#session
      .acknowledgeNotifications(patch, send)
      .catch(err => this.#session.notify("error", `Could not ${what}: ${errorText(err)}`));
  }
}

function keyOf(n: Notification): string {
  return `${NOTIF_KEY}${n.id}`;
}

function rowOf(n: Notification): DialogRow {
  return {
    key: keyOf(n),
    mark: n.read ? " " : UNREAD_MARK,
    label: `${STATUS_MARK[n.status] ?? STATUS_MARK.open} ${n.title}`,
    detail: `${n.message} · ${fmtTime(n.created)}`,
    search: [n.title, n.message, STATUS_LABEL[n.status] ?? n.status, n.author ?? ""].join(" "),
  };
}

/** The session's notification feed and attention; registers itself with the session. */
export function createNotifications(session: TuiSession, options: NotificationOptions = {}): Notifications {
  const feed = new Notifications(session, options);
  session.attachNotifications(feed);
  return feed;
}
