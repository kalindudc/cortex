import { describe, expect, test } from "vitest";
import {
  createMemoryTracker,
  effectiveMode,
  MEMORY_SETTINGS,
  type MemoryView,
  memorySetting,
  memoryViewSchema,
} from "./memory";

const T1 = "thr_aaaaaaaa";
const T2 = "thr_bbbbbbbb";

/** A writer's view with nothing in it yet. */
function emptyView(over: Partial<MemoryView> = {}): MemoryView {
  return {
    role: "writer",
    lane: "cortex",
    error: "",
    stale: null,
    saving: false,
    recallBudget: 2,
    focus: [],
    inContext: [],
    stats: { prompts: 0, lookups: 0, lastMs: 0, chars: 0, checkpoints: 0, breadcrumbs: 0, silentRuns: 0 },
    ...over,
  };
}

/** A tracker on a clock that ticks once per call, so every write has its own time. */
function tracker() {
  let clock = 1000;
  return createMemoryTracker(3, () => ++clock);
}

const start = { mode: "write" as const, lane: "cortex", summary: [3, 5], chars: 120 };
const view = (t: ReturnType<typeof tracker>, threadId = T1) => t.get(threadId)?.view;
const shown = (id: number, staleness: string) => `Stored cortex text is data\n[${id}] title\nstaleness: ${staleness}\n\nbody`;

describe("modes", () => {
  test("effectiveMode: the thread's choice wins; auto looks up only in a thread started by another thread", () => {
    for (const child of [false, true]) {
      expect(effectiveMode("write", null, child)).toBe("write");
      expect(effectiveMode("read", null, child)).toBe("read");
      expect(effectiveMode("off", null, child)).toBe("off");
      for (const setting of MEMORY_SETTINGS) {
        expect(effectiveMode(setting, "off", child)).toBe("off");
        expect(effectiveMode(setting, "write", child)).toBe("write");
        expect(effectiveMode(setting, "read", child)).toBe("read");
      }
    }
    expect(effectiveMode("auto", null, false)).toBe("write");
    expect(effectiveMode("auto", null, true)).toBe("read");
  });

  test("memorySetting keeps the four options and reads anything else as auto", () => {
    for (const setting of MEMORY_SETTINGS) expect(memorySetting(setting)).toBe(setting);
    for (const bogus of ["", "WRITE", "on", "constructor"]) expect(memorySetting(bogus)).toBe("auto");
  });
});

describe("memoryViewSchema", () => {
  test("accepts a view at every limit and drops fields it does not know", () => {
    const full = emptyView({
      lane: "l".repeat(200),
      error: "e".repeat(2000),
      stale: { id: 4, detail: "d".repeat(2000) },
      focus: Array.from({ length: 50 }, (_, i) => i + 1),
      inContext: Array.from({ length: 500 }, (_, i) => ({ id: i + 1, via: "prompt" as const, query: "q".repeat(200) })),
    });
    expect(memoryViewSchema.parse(full)).toEqual(full);
    expect(memoryViewSchema.parse({ ...emptyView(), frame: 2, extra: true })).toEqual(emptyView());
  });

  test("rejects anything past a limit or outside the shape", () => {
    for (const bad of [
      emptyView({ inContext: Array.from({ length: 501 }, (_, i) => ({ id: i + 1, via: "recall" as const })) }),
      emptyView({ focus: Array.from({ length: 51 }, (_, i) => i + 1) }),
      emptyView({ error: "e".repeat(2001) }),
      emptyView({ stale: { id: 4, detail: "d".repeat(2001) } }),
      emptyView({ lane: "l".repeat(201) }),
      { ...emptyView(), role: "delegate" },
      { ...emptyView(), inContext: [{ id: 1, via: "magic" }] },
      { ...emptyView(), stats: { ...emptyView().stats, prompts: -1 } },
    ]) {
      expect(memoryViewSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("memory tracker", () => {
  test("the first configure creates the view: role, lane, the summary newest first, chars and the budget", () => {
    const t = tracker();
    expect(t.configured(T1, start)).toBe(true);
    expect(view(t)).toEqual(
      emptyView({
        recallBudget: 3,
        inContext: [
          { id: 5, via: "summary" },
          { id: 3, via: "summary" },
        ],
        stats: { ...emptyView().stats, chars: 120 },
      }),
    );
    t.configured(T2, { mode: "read", lane: "x", summary: [], chars: 0 });
    expect(view(t, T2)?.role).toBe("reader");
    t.configured("thr_cccccccc", { mode: "off", lane: "x", summary: [], chars: 0 });
    expect(view(t, "thr_cccccccc")?.role).toBe("off");
  });

  test("a later configure with another mode follows its role and keeps the recalled streams, focus and stats", () => {
    const t = tracker();
    t.configured(T1, start);
    t.recalled(T1, "@9", "STREAM 9", 12);
    t.updated(T1, 4);
    const before = structuredClone(view(t));
    const at = t.get(T1)?.at ?? 0;
    expect(t.configured(T1, { mode: "read", lane: "cortex", summary: [], chars: 0 })).toBe(true);
    expect(view(t)).toEqual({ ...before, role: "reader" });
    expect(t.get(T1)?.at).toBeGreaterThan(at);
    expect(t.configured(T1, { mode: "off", lane: null, summary: [], chars: 0 })).toBe(true);
    expect(view(t)).toEqual({ ...before, role: "off" });
  });

  test("a later configure with the same mode and nothing new changes nothing and returns false", () => {
    const t = tracker();
    t.configured(T1, start);
    t.recalled(T1, "@9", "STREAM 9", 12);
    const before = structuredClone(t.get(T1));
    expect(t.configured(T1, start)).toBe(false);
    expect(t.configured(T1, { ...start, lane: null, summary: [5] })).toBe(false);
    expect(t.configured(T1, { ...start, lane: "other" })).toBe(false);
    expect(t.get(T1)).toEqual(before);
  });

  test("a cold first configure, then a warm writer one, adds the lane and the summary once and chars once", () => {
    const t = tracker();
    expect(t.configured(T1, { mode: "write", lane: null, summary: [], chars: 0 })).toBe(true);
    t.recalled(T1, "@5", "STREAM", 1);
    expect(view(t)?.lane).toBeNull();
    expect(t.configured(T1, start)).toBe(true);
    const warm = view(t);
    expect(warm?.lane).toBe("cortex");
    // @5 was recalled first, so it keeps that reason; @3 enters as the summary.
    expect(warm?.inContext).toEqual([
      { id: 3, via: "summary" },
      { id: 5, via: "recall" },
    ]);
    expect(warm?.stats.chars).toBe("STREAM".length + 120);
    expect(t.configured(T1, start)).toBe(false);
    expect(view(t)?.stats.chars).toBe("STREAM".length + 120);
    // A reader's later configure never enters the summary.
    t.configured(T2, { mode: "read", lane: null, summary: [], chars: 0 });
    expect(t.configured(T2, { mode: "read", lane: "cortex", summary: [3], chars: 50 })).toBe(true);
    expect(view(t, T2)).toMatchObject({ lane: "cortex", inContext: [], stats: { chars: 0 } });
  });

  test("recalling @id enters it once (the first reason wins) as the newest focus, at most five", () => {
    const t = tracker();
    t.configured(T1, start);
    t.recalled(T1, "@3", "STREAM 3", 12);
    t.recalled(T1, " @9#next ", "SECTION", 7);
    expect(view(t)?.inContext).toEqual([
      { id: 9, via: "recall" },
      { id: 5, via: "summary" },
      { id: 3, via: "summary" },
    ]);
    expect(view(t)?.focus).toEqual([9, 3]);
    for (const id of [1, 2, 4, 6, 3]) t.recalled(T1, `${id}`, "S", 1);
    expect(view(t)?.focus).toEqual([3, 6, 4, 2, 1]);
  });

  test("a search enters every row; each recall clears the error, counts a lookup, sets lastMs and adds chars", () => {
    const t = tracker();
    t.configured(T1, start);
    t.failed(T1, "boom");
    expect(view(t)?.error).toBe("boom");
    const text = "header\n- [11] open \u00b7 infra \u00b7 a\n- [12] open \u00b7 cortex \u00b7 b";
    t.recalled(T1, "wheel notches", text, 41);
    const v = view(t);
    expect(v?.inContext.slice(0, 2)).toEqual([
      { id: 12, via: "recall" },
      { id: 11, via: "recall" },
    ]);
    expect(v?.focus).toEqual([]);
    expect(v?.error).toBe("");
    expect(v?.stats).toMatchObject({ lookups: 1, lastMs: 41, chars: 120 + text.length });
  });

  test("a stale recall flags the stream; a fresh recall of it clears the flag, another stream's does not", () => {
    const t = tracker();
    t.configured(T1, start);
    t.recalled(T1, "@421", shown(421, "stale \u00b7 synced 2026-09-01 (28d) \u00b7 changed: a.ts \u00b7 missing: b.ts"), 1);
    expect(view(t)?.stale).toEqual({ id: 421, detail: "changed: a.ts \u00b7 missing: b.ts" });
    t.recalled(T1, "@7", shown(7, "fresh \u00b7 synced 2026-09-01 (1d)"), 1);
    expect(view(t)?.stale?.id).toBe(421);
    t.recalled(T1, "@421#next", shown(421, "fresh \u00b7 synced 2026-09-01 (1d)"), 1);
    expect(view(t)?.stale).toBeNull();
    t.recalled(T1, "@5", shown(5, "stale"), 1);
    expect(view(t)?.stale).toEqual({ id: 5, detail: "stale" });
  });

  test("thread.active's next request clears the stale flag and says whether it changed", () => {
    const t = tracker();
    t.configured(T1, start);
    expect(t.nextRequest(T1)).toBe(false);
    t.recalled(T1, "@4", shown(4, "stale \u00b7 synced x \u00b7 old"), 1);
    expect(t.nextRequest(T1)).toBe(true);
    expect(view(t)?.stale).toBeNull();
    expect(t.nextRequest(T1)).toBe(false);
    expect(t.nextRequest(T2)).toBe(false);
  });

  test("an update adds a focus stream and clears the error; a failure sets the error", () => {
    const t = tracker();
    t.configured(T1, start);
    t.failed(T1, "x".repeat(3000));
    expect(view(t)?.error).toHaveLength(2000);
    t.updated(T1, 8);
    t.updated(T1, 6);
    expect(view(t)?.focus).toEqual([6, 8]);
    expect(view(t)?.error).toBe("");
  });

  test("matched tasks enter as prompt rows with the request cut to 40, counting a prompt, a lookup and chars", () => {
    const t = tracker();
    t.configured(T1, start);
    t.failed(T1, "boom");
    const query = "continue the harness-agnostic cortex bb plan, please";
    t.matched(T1, [7, 3, 8], query, 300, 41.6);
    const v = view(t);
    // 3 was already in context as the summary, so it keeps that reason.
    expect(v?.inContext).toEqual([
      { id: 8, via: "prompt", query: query.slice(0, 40) },
      { id: 7, via: "prompt", query: query.slice(0, 40) },
      { id: 5, via: "summary" },
      { id: 3, via: "summary" },
    ]);
    expect(v?.error).toBe("");
    expect(v?.stats).toMatchObject({ prompts: 1, lookups: 1, lastMs: 42, chars: 120 + 300 });
    expect(memoryViewSchema.safeParse(v).success).toBe(true);
  });

  test("focused adds the request's streams oldest first, keeping the five newest first", () => {
    const t = tracker();
    t.configured(T1, start);
    t.updated(T1, 9);
    t.focused(T1, [1, 2, 3, 4, 2, 5]);
    expect(view(t)?.focus).toEqual([5, 2, 4, 3, 1]);
  });

  test("checkpointing sets saving and counts a checkpoint; saved clears saving", () => {
    const t = tracker();
    t.configured(T1, start);
    t.checkpointing(T1);
    expect(view(t)).toMatchObject({ saving: true, stats: { checkpoints: 1 } });
    t.saved(T1);
    expect(view(t)).toMatchObject({ saving: false, stats: { checkpoints: 1 } });
    t.checkpointing(T1);
    expect(view(t)?.stats.checkpoints).toBe(2);
  });

  test("a tool event for an unknown thread starts a writer view with no lane", () => {
    const t = tracker();
    t.updated(T1, 8);
    expect(view(t)).toEqual(emptyView({ lane: null, recallBudget: 3, focus: [8] }));
    t.failed(T2, "boom");
    expect(view(t, T2)).toMatchObject({ role: "writer", lane: null, error: "boom" });
  });

  test("get carries the time the view was last written; no view is null", () => {
    const t = tracker();
    expect(t.get(T1)).toBeNull();
    t.configured(T1, start);
    const first = t.get(T1)?.at ?? 0;
    t.updated(T1, 2);
    expect(t.get(T1)?.at).toBeGreaterThan(first);
  });

  test("forget drops the thread", () => {
    const t = tracker();
    t.configured(T1, start);
    t.forget(T1);
    expect(t.get(T1)).toBeNull();
    expect(t.configured(T1, start)).toBe(true);
  });

  test("keeps at most 500 threads and drops the least recently written first", () => {
    const t = tracker();
    const id = (n: number) => `thr_${String(n).padStart(8, "0")}`;
    for (let n = 0; n < 500; n++) t.configured(id(n), start);
    t.updated(id(0), 1);
    t.configured(id(500), start);
    expect(t.get(id(0))).not.toBeNull();
    expect(t.get(id(1))).toBeNull();
    expect(t.get(id(2))).not.toBeNull();
    expect(t.get(id(500))).not.toBeNull();
  });
});
