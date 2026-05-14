import { test, expect, describe, afterEach } from "bun:test";
import { subscribe, emit, type CortexEvent } from "../../src/events.ts";

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
