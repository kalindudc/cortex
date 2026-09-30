/**
 * Change events. Writes publish through a daemon's EventPublisher, which
 * numbers them for the SSE stream. No replay buffer: clients re-snapshot on
 * (re)connect.
 *
 * Environment-neutral on purpose (crypto.randomUUID is a web-standard
 * global), so clients may reuse the cursor helpers.
 */

/** Every event name the daemon publishes, in the order they were introduced. */
export const EVENT_KINDS = [
  "task.added",
  "task.updated",
  "task.removed",
  "update.posted",
  "lane.changed",
  "tag.changed",
  "notification.added",
  /** Acknowledgement state changed or rows were removed; payload: NotificationChange. */
  "notification.changed",
  /** An actual transition into blocked; payload: BlockedTransition. */
  "task.blocked",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export type CortexEvent = {
  kind: EventKind;
  payload: unknown;
  ts: number;
};

// ---------- cursors ----------

const EPOCH_RE = /^[A-Za-z0-9._-]+$/;
const CURSOR_RE = /^([A-Za-z0-9._-]+):(0|[1-9][0-9]*)$/;

/** `<epoch>:<seq>`: the SSE id of an event and the position a snapshot is valid at. */
export function formatCursor(epoch: string, seq: number): string {
  if (!EPOCH_RE.test(epoch)) throw new TypeError(`invalid cursor epoch '${epoch}'`);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError(`invalid cursor sequence ${seq}`);
  return `${epoch}:${seq}`;
}

/** Parse a canonical cursor; anything else (including non-strings) is null. */
export function parseCursor(cursor: unknown): { epoch: string; seq: number } | null {
  if (typeof cursor !== "string") return null;
  const m = CURSOR_RE.exec(cursor);
  if (!m?.[1] || m[2] === undefined) return null;
  const seq = Number(m[2]);
  return Number.isSafeInteger(seq) ? { epoch: m[1], seq } : null;
}

// ---------- sequenced publisher ----------

/** A published event with its position in the publisher's stream. */
export type PublishedEvent = CortexEvent & { seq: number; cursor: string };

export interface EventPublisher {
  /** Names this publisher's lifetime; a restarted daemon has a new epoch. */
  readonly epoch: string;
  /** Cursor of the newest published event (`<epoch>:0` before the first). */
  cursor(): string;
  /**
   * Number the event and deliver it to stream subscribers. Call only AFTER
   * the write committed, in the same synchronous
   * turn, so a snapshot's cursor covers exactly the writes it can see. A
   * failing subscriber is reported and skipped: the write already committed.
   */
  publish(kind: EventKind, payload: unknown): PublishedEvent;
  subscribe(listener: (event: PublishedEvent) => void): () => void;
  listenerCount(): number;
}

export function createEventPublisher(epoch: string = crypto.randomUUID()): EventPublisher {
  formatCursor(epoch, 0);
  let seq = 0;
  const listeners = new Set<(event: PublishedEvent) => void>();
  return {
    epoch,
    cursor: () => formatCursor(epoch, seq),
    publish(kind, payload) {
      seq += 1;
      const event: PublishedEvent = { kind, payload, ts: Date.now(), seq, cursor: formatCursor(epoch, seq) };
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          console.error(`cortex: event subscriber failed on ${kind}:`, err);
        }
      }
      return event;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
  };
}
