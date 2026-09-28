import { test, expect, describe, afterEach, spyOn } from "bun:test";
import {
  subscribe,
  emit,
  EVENT_KINDS,
  createEventPublisher,
  formatCursor,
  parseCursor,
  type CortexEvent,
  type PublishedEvent,
} from "../../src/events.ts";

const unsubs = new Set<() => void>();
const track = (cb: (ev: CortexEvent) => void): (() => void) => {
  const off = subscribe(cb);
  unsubs.add(off);
  return off;
};

afterEach(() => {
  for (const off of unsubs) off();
  unsubs.clear();
});

describe("events bus", () => {
  test("subscribe returns an unsubscribe function", () => {
    const off = track(() => {});
    expect(typeof off).toBe("function");
  });

  test("emit fires subscribers with the same event object (kind, payload, ts)", () => {
    const seen: CortexEvent[] = [];
    track(ev => seen.push(ev));
    const ev: CortexEvent = { kind: "task.added", payload: { id: 1 }, ts: 42 };
    emit(ev);
    expect(seen).toEqual([ev]);
  });

  test("after unsubscribe the callback is NOT fired", () => {
    let count = 0;
    const off = track(() => {
      count++;
    });
    off();
    unsubs.delete(off);
    emit({ kind: "task.updated", payload: null, ts: 1 });
    expect(count).toBe(0);
  });

  test("multiple subscribers each receive every emit", () => {
    const a: number[] = [],
      b: number[] = [];
    track(ev => a.push(ev.ts));
    track(ev => b.push(ev.ts));
    emit({ kind: "task.added", payload: null, ts: 1 });
    emit({ kind: "task.removed", payload: null, ts: 2 });
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  test("emitter is kind-agnostic — every subscriber sees every kind", () => {
    const kinds: CortexEvent["kind"][] = [];
    track(ev => kinds.push(ev.kind));
    const all: CortexEvent["kind"][] = [
      "task.added",
      "task.updated",
      "task.removed",
      "update.posted",
      "lane.changed",
      "tag.changed",
    ];
    for (const k of all) emit({ kind: k, payload: null, ts: 0 });
    expect(kinds).toEqual(all);
  });

  test("concurrent subscribers don't interfere — unsubscribing one leaves others active", () => {
    const a: number[] = [],
      b: number[] = [];
    const offA = track(ev => a.push(ev.ts));
    track(ev => b.push(ev.ts));
    emit({ kind: "task.added", payload: null, ts: 1 });
    offA();
    unsubs.delete(offA);
    emit({ kind: "task.added", payload: null, ts: 2 });
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });
});

// ---------- sequenced publisher (plan @400 N12) ----------

const LEGACY_KINDS = [
  "task.added",
  "task.updated",
  "task.removed",
  "update.posted",
  "lane.changed",
  "tag.changed",
  "notification.added",
];

describe("event kinds", () => {
  test("keep every legacy name and add the notification-change and blocked-transition events", () => {
    expect([...EVENT_KINDS] as string[]).toEqual([...LEGACY_KINDS, "notification.changed", "task.blocked"]);
  });
});

describe("cursors", () => {
  test("format as <epoch>:<seq> and parse back", () => {
    expect(formatCursor("e-1", 0)).toBe("e-1:0");
    expect(parseCursor("e-1:42")).toEqual({ epoch: "e-1", seq: 42 });
    const epoch = crypto.randomUUID();
    expect(parseCursor(formatCursor(epoch, 7))).toEqual({ epoch, seq: 7 });
  });

  test("reject anything that is not a canonical cursor", () => {
    for (const bad of [
      "",
      "e",
      "e:",
      ":1",
      "e:-1",
      "e:1.5",
      "e:01",
      "e:1e3",
      "e: 1",
      "e f:1",
      "a:b:1",
      "e:9007199254740993",
    ]) {
      expect(parseCursor(bad), bad).toBeNull();
    }
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor(12 as unknown as string)).toBeNull();
    expect(() => formatCursor("", 1)).toThrow();
    expect(() => formatCursor("e", -1)).toThrow();
  });
});

describe("createEventPublisher", () => {
  test("starts at sequence 0 under a fresh epoch per publisher", () => {
    const a = createEventPublisher();
    const b = createEventPublisher();
    expect(a.epoch).not.toBe(b.epoch);
    expect(a.cursor()).toBe(`${a.epoch}:0`);
    expect(createEventPublisher("fixed").cursor()).toBe("fixed:0");
  });

  test("publish assigns strictly increasing sequence numbers and cursors", () => {
    const p = createEventPublisher("ep");
    const first = p.publish("task.added", { id: 1 });
    const second = p.publish("task.updated", { id: 1 });
    expect([first.seq, first.cursor, second.seq, second.cursor]).toEqual([1, "ep:1", 2, "ep:2"]);
    expect(first).toMatchObject({ kind: "task.added", payload: { id: 1 } });
    expect(typeof first.ts).toBe("number");
    expect(p.cursor()).toBe("ep:2");
  });

  test("subscribers see events in order until they unsubscribe", () => {
    const p = createEventPublisher("ep");
    const seen: PublishedEvent[] = [];
    const off = p.subscribe(ev => seen.push(ev));
    expect(p.listenerCount()).toBe(1);
    p.publish("lane.changed", { name: "a" });
    p.publish("tag.changed", { name: "b" });
    off();
    expect(p.listenerCount()).toBe(0);
    p.publish("tag.changed", { name: "c" });
    expect(seen.map(ev => [ev.kind, ev.seq])).toEqual([
      ["lane.changed", 1],
      ["tag.changed", 2],
    ]);
  });

  test("mirrors every event to the legacy bus with its original kind/payload/ts", () => {
    const p = createEventPublisher("ep");
    const legacy: CortexEvent[] = [];
    track(ev => legacy.push(ev));
    const published = p.publish("task.blocked", { id: 3 });
    expect(legacy).toEqual([{ kind: "task.blocked", payload: { id: 3 }, ts: published.ts }]);
  });

  test("a throwing subscriber cannot fail the publish (the write already committed)", () => {
    const p = createEventPublisher("ep");
    const seen: number[] = [];
    const errors: unknown[] = [];
    const errSpy = spyOn(console, "error").mockImplementation(((...args: unknown[]) => {
      errors.push(args);
    }) as never);
    try {
      p.subscribe(() => {
        throw new Error("listener bug");
      });
      p.subscribe(ev => seen.push(ev.seq));
      expect(() => p.publish("task.added", {})).not.toThrow();
    } finally {
      errSpy.mockRestore();
    }
    expect(seen).toEqual([1]);
    expect(errors.length).toBe(1);
  });
});
