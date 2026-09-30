/**
 * Native live-change subscription. Bun 1.4.2 has no global EventSource, so
 * this module parses the daemon's `/events` stream itself, over
 * `fetch(url, { unix })` on the private socket.
 *
 * Contract for consumers: after every `ready` (first connect, reconnect, new
 * epoch) and every `resync`, take a new snapshot and apply only events whose
 * cursor is after the snapshot's cursor. Frames are delivered at most once,
 * in order; duplicates, stale and out-of-order frames are dropped, and a
 * missed sequence number becomes a `resync`. There is no durable replay.
 */

import type { ConnectionState, Endpoint, LiveEvent } from "./contracts.ts";
import { EVENT_KINDS, type EventKind, parseCursor } from "./events.ts";

// ---------- WHATWG event-stream parser ----------

/** One dispatched event. `id` is the stream's last event ID (it persists across events, per the spec). */
export interface SseFrame {
  event: string;
  data: string;
  id: string;
}

export interface SseParser {
  /** Feed the next chunk of bytes; any split (inside UTF-8 sequences or CRLF) is fine. */
  feed(chunk: Uint8Array): void;
  /** The stream ended: an unterminated event is discarded. */
  end(): void;
  /** The last valid `retry:` value in milliseconds, if any. */
  readonly retry: number | null;
}

const DEFAULT_MAX_EVENT_CHARS = 32 * 1024 * 1024;

/**
 * Incremental, spec-compliant parser (html.spec.whatwg.org, "Interpreting an
 * event stream"): UTF-8 decoding with BOM removal, CRLF/CR/LF line endings,
 * comments, multi-line data, persistent ids (a NULL-bearing id is ignored),
 * digit-only retry, and dispatch only on a blank line. Bounded: a frame
 * (buffered line plus data) longer than `maxEventChars` throws.
 */
export function createSseParser(
  onFrame: (frame: SseFrame) => void,
  options: { maxEventChars?: number } = {},
): SseParser {
  const maxChars = options.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS;
  // Per parser: a global-flag regex keeps lastIndex state, and onFrame may re-enter another parser.
  const lineBreak = /\r\n|\r|\n/g;
  let decoder = new TextDecoder("utf-8");
  let buffer = "";
  let skipLeadingLF = false;
  let eventType = "";
  let data = "";
  let hasData = false;
  let lastEventId = "";
  let retry: number | null = null;

  const overflow = (): never => {
    throw new RangeError(`SSE frame exceeds ${maxChars} characters`);
  };

  const processLine = (line: string): void => {
    if (line === "") {
      if (hasData) {
        const frame: SseFrame = { event: eventType || "message", data, id: lastEventId };
        eventType = "";
        data = "";
        hasData = false;
        onFrame(frame);
      } else {
        eventType = "";
      }
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        data = hasData ? `${data}\n${value}` : value;
        hasData = true;
        if (data.length > maxChars) overflow();
        break;
      case "id":
        if (!value.includes("\u0000")) lastEventId = value;
        break;
      case "retry":
        if (/^[0-9]+$/.test(value)) retry = Number(value);
        break;
      default:
        break;
    }
  };

  const feedText = (text: string): void => {
    if (text.length === 0) return;
    if (skipLeadingLF) {
      skipLeadingLF = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    buffer += text;
    let start = 0;
    lineBreak.lastIndex = 0;
    for (;;) {
      const match = lineBreak.exec(buffer);
      if (!match) break;
      processLine(buffer.slice(start, match.index));
      start = match.index + match[0].length;
      // A CR ending this chunk may be the first half of a CRLF split across chunks.
      if (match[0] === "\r" && start === buffer.length) skipLeadingLF = true;
    }
    buffer = buffer.slice(start);
    if (buffer.length + data.length > maxChars) overflow();
  };

  return {
    feed(chunk) {
      feedText(decoder.decode(chunk, { stream: true }));
    },
    end() {
      feedText(decoder.decode());
      decoder = new TextDecoder("utf-8");
      buffer = "";
      skipLeadingLF = false;
      eventType = "";
      data = "";
      hasData = false;
    },
    get retry() {
      return retry;
    },
  };
}

// ---------- subscribeChanges ----------

/** The fetch used to open the stream (injectable for tests); Bun's supports `unix`. */
export type StreamFetch = (url: string, init: BunFetchRequestInit) => Promise<Response>;

export interface SubscribeOptions {
  fetch?: StreamFetch;
  /** First reconnect delay; doubles per failed attempt up to maxRetryDelayMs, reset by a ready. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Tear the connection down when no bytes (not even a heartbeat) arrive for this long. */
  idleTimeoutMs?: number;
  maxEventChars?: number;
}

const DEFAULT_RETRY_MS = 250;
const DEFAULT_MAX_RETRY_MS = 5000;
/** Silence across several daemon heartbeats (server.ts DEFAULT_STREAM_LIMITS.heartbeatMs) means the peer is gone. */
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

const KNOWN_KINDS: ReadonlySet<string> = new Set(EVENT_KINDS);

/** A malformed frame or response: reconnect rather than trust the stream. */
class StreamProtocolError extends Error {}

/** Wraps an exception thrown by onEvent/onState so it is rethrown, never retried. */
class ConsumerError extends Error {
  constructor(readonly original: unknown) {
    super("subscription consumer failed");
  }
}

function eventsUrl(endpoint: Endpoint): { url: string; unix: string } {
  return { url: "http://localhost/events", unix: endpoint.socketPath };
}

const ABORTED: unique symbol = Symbol("aborted");

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      err => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function parsePayload(data: string, kind: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new StreamProtocolError(`malformed ${kind} payload`);
  }
}

/**
 * Follow a daemon's change stream until `signal` aborts (then resolve).
 * `onState` reports "connecting" until the first ready, "live" after each
 * ready, and "stale" while reconnecting after having been live. Transport
 * and protocol failures reconnect with backoff; an exception thrown by
 * onEvent/onState rejects the returned promise. The caller's signal is
 * observed, never handed to fetch, so any AbortSignal implementation works.
 */
export async function subscribeChanges(
  endpoint: Endpoint,
  onEvent: (event: LiveEvent) => void,
  onState: (state: ConnectionState) => void,
  signal: AbortSignal,
  options: SubscribeOptions = {},
): Promise<void> {
  if (signal.aborted) return;
  const doFetch: StreamFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_MS;
  const maxDelay = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const target = eventsUrl(endpoint);

  let state: ConnectionState | null = null;
  let everLive = false;
  const setState = (next: ConnectionState): void => {
    if (state === next) return;
    state = next;
    try {
      onState(next);
    } catch (err) {
      throw new ConsumerError(err);
    }
  };
  const deliver = (event: LiveEvent): void => {
    try {
      onEvent(event);
    } catch (err) {
      throw new ConsumerError(err);
    }
  };

  /** One connection: resolves true when it reached ready, false otherwise. */
  const connectOnce = async (): Promise<boolean> => {
    let gotReady = false;
    let epoch = "";
    let lastSeq = 0;
    const handle = (frame: SseFrame): void => {
      if (frame.event === "heartbeat") return;
      const cursor = parseCursor(frame.id);
      if (frame.event === "ready") {
        if (!cursor) throw new StreamProtocolError("ready frame without a valid cursor");
        epoch = cursor.epoch;
        lastSeq = cursor.seq;
        gotReady = true;
        everLive = true;
        setState("live");
        deliver({ kind: "ready", cursor: frame.id, payload: parsePayload(frame.data, "ready") });
        return;
      }
      if (!gotReady || !cursor) return;
      if (cursor.epoch !== epoch) {
        epoch = cursor.epoch;
        lastSeq = cursor.seq;
        deliver({ kind: "resync", cursor: frame.id, payload: { reason: "epoch", cursor: frame.id } });
        return;
      }
      if (cursor.seq <= lastSeq) return;
      const gap = cursor.seq > lastSeq + 1;
      lastSeq = cursor.seq;
      if (frame.event === "resync") {
        deliver({ kind: "resync", cursor: frame.id, payload: parsePayload(frame.data, "resync") });
        return;
      }
      if (gap) {
        deliver({ kind: "resync", cursor: frame.id, payload: { reason: "gap", cursor: frame.id } });
        return;
      }
      if (!KNOWN_KINDS.has(frame.event)) return;
      deliver({ kind: frame.event as EventKind, cursor: frame.id, payload: parsePayload(frame.data, frame.event) });
    };

    const init: BunFetchRequestInit = {
      headers: { accept: "text/event-stream", "cache-control": "no-cache" },
      unix: target.unix,
    };
    let res: Response | typeof ABORTED;
    const pending = doFetch(target.url, init);
    try {
      res = await abortable(pending, signal);
    } catch {
      return false;
    }
    if (res === ABORTED) {
      pending.then(
        r => r.body?.cancel().catch(() => {}),
        () => {},
      );
      return false;
    }
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.toLowerCase().startsWith("text/event-stream") || !res.body) {
      await res.body?.cancel().catch(() => {});
      return false;
    }

    const reader = res.body.getReader();
    const stop = (): void => {
      reader.cancel().catch(() => {});
    };
    let idle: ReturnType<typeof setTimeout> = setTimeout(stop, idleTimeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    const parser = createSseParser(handle, { maxEventChars: options.maxEventChars });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(idle);
        idle = setTimeout(stop, idleTimeoutMs);
        parser.feed(value);
      }
    } catch (err) {
      if (err instanceof ConsumerError) throw err;
      // Transport, protocol or idle teardown: the caller reconnects.
    } finally {
      clearTimeout(idle);
      signal.removeEventListener("abort", stop);
      stop();
    }
    return gotReady;
  };

  let delay = baseDelay;
  try {
    setState("connecting");
    while (!signal.aborted) {
      const reachedReady = await connectOnce();
      if (signal.aborted) break;
      if (reachedReady) delay = baseDelay;
      setState(everLive ? "stale" : "connecting");
      await sleep(delay, signal);
      delay = Math.min(delay * 2, maxDelay);
    }
  } catch (err) {
    if (err instanceof ConsumerError) throw err.original;
    throw err;
  }
}
