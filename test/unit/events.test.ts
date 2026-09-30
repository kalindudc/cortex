import { test, expect, describe, spyOn } from "bun:test";
import { EVENT_KINDS, createEventPublisher, formatCursor, parseCursor, type PublishedEvent } from "../../src/events.ts";

// ---------- sequenced publisher ----------

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
