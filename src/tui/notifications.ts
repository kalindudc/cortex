// Notifications for one terminal session, as a keyboard-complete list dialog.
//
// - The feed merges the daemon's persisted notifications (the session's
//   workspace snapshot, `notification.added` rows, and one coalesced re-read
//   after `notification.changed`) with this session's own errors (every error
//   message; kept only here, because they are often about the daemon being
//   unreachable). Unread first, then newest first inside each group.
// - Read state is SHARED: read, unread, all read, dismiss and clear go to the
//   daemon through session.acknowledgeNotifications (shown at once; a re-read
//   that predates the write never undoes it; a failure is reported and
//   re-read), and every other client converges on `notification.changed`.
//   Local errors, the highlighted row and the dialog belong to the session.
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
import type { SessionMessage, TuiSession } from "./session.ts";
import { STATUS_MARK } from "./workspace.ts";

/** A session-local error row: negative ids never collide with the daemon's positive ones. */
export interface LocalError {
  readonly id: number;
  readonly text: string;
  readonly at: number;
  read: boolean;
}

/** One row of the merged feed. */
export type FeedRow = { kind: "notif"; row: Notification } | { kind: "error"; row: LocalError };

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
const ERROR_KEY = "e:";

const time = (r: FeedRow): number => (r.kind === "notif" ? r.row.created : r.row.at);

/** The feed order: unread before read, then newest first inside each group. */
export function mergeFeed(notifications: readonly Notification[], errors: readonly LocalError[]): FeedRow[] {
  const rows: FeedRow[] = [
    ...notifications.map(row => ({ kind: "notif" as const, row })),
    ...errors.map(row => ({ kind: "error" as const, row })),
  ];
  return rows.sort((a, b) => Number(a.row.read) - Number(b.row.read) || time(b) - time(a));
}

/** The unread count: unread rows of both sources. */
export function countUnread(rows: readonly FeedRow[]): number {
  return rows.reduce((n, r) => n + (r.row.read ? 0 : 1), 0);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class Notifications {
  readonly #session: TuiSession;
  #errors: LocalError[] = [];
  #nextLocal = -1;
  #flash: boolean;
  #bell: boolean;
  readonly #write: ((data: string) => void) | null;
  #memo: { notifications: readonly Notification[]; errors: LocalError[]; value: FeedRow[] } | null = null;

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

  /** The merged feed (memoized per input). */
  feed(): FeedRow[] {
    const notifications = this.#session.notifications;
    const memo = this.#memo;
    if (memo !== null && memo.notifications === notifications && memo.errors === this.#errors) return memo.value;
    const value = mergeFeed(notifications, this.#errors);
    this.#memo = { notifications, errors: this.#errors, value };
    return value;
  }

  unread(): number {
    return countUnread(this.feed());
  }

  // ---------- session hooks ----------

  /** An error message of this session becomes a local, unread row. */
  localError(message: SessionMessage): void {
    this.#errors = [{ id: this.#nextLocal--, text: message.text, at: message.at, read: false }, ...this.#errors];
  }

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
    if (id < 0) {
      this.#local(id, e => (e.read ? e : { ...e, read: true }));
      return;
    }
    this.#acknowledge(
      rows => rows.map(n => (n.id === id && !n.read ? { ...n, read: true } : n)),
      client => client.markNotifRead(id),
      "mark the notification read",
    );
  }

  markUnread(id: number): void {
    if (id < 0) {
      this.#local(id, e => (e.read ? { ...e, read: false } : e));
      return;
    }
    this.#acknowledge(
      rows => rows.map(n => (n.id === id && n.read ? { ...n, read: false } : n)),
      client => client.markNotifUnread(id),
      "mark the notification unread",
    );
  }

  markAllRead(): void {
    this.#errors = this.#errors.map(e => (e.read ? e : { ...e, read: true }));
    this.#acknowledge(
      rows => rows.map(n => (n.read ? n : { ...n, read: true })),
      client => client.markAllNotifRead(),
      "mark every notification read",
    );
  }

  dismiss(id: number): void {
    if (id < 0) {
      this.#local(id, () => null);
      return;
    }
    this.#acknowledge(
      rows => rows.filter(n => n.id !== id),
      client => client.delNotif(id),
      "dismiss the notification",
    );
  }

  clearAll(): void {
    this.#errors = [];
    this.#acknowledge(
      () => [],
      client => client.clearNotifs(),
      "clear the notifications",
    );
  }

  /** Enter: open the row's task (keeping the list filters; :back returns), mark it read. */
  open(row: FeedRow): void {
    if (row.kind === "notif" && row.row.task_id !== null) {
      const id = row.row.task_id;
      if (this.#session.tasks.some(t => t.id === id)) this.#session.jump(id);
      else this.#session.notify("info", `@${id} no longer exists`);
    }
    this.markRead(row.row.id);
  }

  /** :notifications: the feed as a keyboard-complete list dialog. */
  show(): void {
    const byKey = (row: DialogRow | null): FeedRow | null =>
      row === null ? null : (this.feed().find(r => keyOf(r) === row.key) ?? null);
    const need = (row: DialogRow | null): FeedRow => {
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
          { key: "r", label: "read", row: true, run: row => this.markRead(need(row).row.id) },
          { key: "u", label: "unread", row: true, run: row => this.markUnread(need(row).row.id) },
          { key: "a", label: "all read", run: () => this.markAllRead() },
          { key: "x", label: "dismiss", row: true, run: row => this.dismiss(need(row).row.id) },
          { key: "X", label: "clear all", run: () => this.clearAll() },
        ],
      },
      "large",
    );
  }

  #local(id: number, change: (e: LocalError) => LocalError | null): void {
    this.#errors = this.#errors.flatMap(e => {
      if (e.id !== id) return [e];
      const next = change(e);
      return next === null ? [] : [next];
    });
    this.#session.redraw();
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

function keyOf(r: FeedRow): string {
  return `${r.kind === "notif" ? NOTIF_KEY : ERROR_KEY}${r.row.id}`;
}

function rowOf(r: FeedRow): DialogRow {
  const mark = r.row.read ? " " : UNREAD_MARK;
  if (r.kind === "error") {
    return { key: keyOf(r), mark, label: `error: ${r.row.text}`, detail: `this session · ${fmtTime(r.row.at)}` };
  }
  const n = r.row;
  return {
    key: keyOf(r),
    mark,
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
