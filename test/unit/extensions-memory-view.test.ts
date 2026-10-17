import { describe, expect, test } from "bun:test";
// The REAL pi-tui (a cortex dependency at pi's pin): a mock.module of it would
// leak into every later test file in the same `bun test` run (src/tui uses it).
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  clean,
  MEMORY_SYMBOLS,
  MemoryPanel,
  type MemoryViewState,
  memoryReport,
  memoryStatus,
  memorySymbol,
  memoryViewLines,
  memoryViewText,
  REPORT_LIMITS,
  type StreamInfo,
} from "../../src/extensions/memory-view.ts";

/** Colours as visible tags, so assertions name the token each piece uses. */
const tags = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};
/** Real escape sequences, so widths are measured as the terminal sees them. */
const ansi = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

function state(over: Partial<MemoryViewState> = {}): MemoryViewState {
  return {
    role: "writer",
    lane: "cortex",
    error: "",
    stale: null,
    saving: false,
    frame: 0,
    recallBudget: 2,
    focus: [],
    inContext: [],
    stats: { prompts: 0, lookups: 0, lastMs: 0, chars: 0, checkpoints: 0, breadcrumbs: 0, silentRuns: 0 },
    ...over,
  };
}

const loaded = (over: Partial<MemoryViewState> = {}) => state({ inContext: [{ id: 7, via: "summary" }], ...over });

const info = (entries: [number, Partial<StreamInfo>][]): Map<number, StreamInfo> =>
  new Map(entries.map(([id, s]) => [id, { title: `stream ${id}`, status: "open", lane: "cortex", ...s }]));

describe("memorySymbol / memoryStatus", () => {
  test("each state has its own symbol and colours", () => {
    expect(memoryStatus(state(), tags)).toBe("<mdLink>\u25cb</mdLink> <dim>memory</dim>");
    expect(memoryStatus(loaded(), tags)).toBe("<mdLink>\u25cf</mdLink> <dim>memory</dim>");
    expect(memoryStatus(loaded({ saving: true, frame: 1 }), tags)).toBe(
      "<mdLink>\u25dd</mdLink> <dim>memory</dim> <dim>\u00b7</dim> <accent>saving\u2026</accent>",
    );
    expect(memoryStatus(loaded({ stale: { id: 421, detail: "changed: a.ts" } }), tags)).toBe(
      "<warning>\u25d0</warning> <text>memory</text> <dim>\u00b7</dim> <warning>@421 stale</warning>",
    );
    expect(memoryStatus(loaded({ error: "boom" }), tags)).toBe(
      "<error>\u2298 memory error</error> <dim>\u00b7 /memory</dim>",
    );
  });

  test("precedence: error > stale > saving > loaded > nothing loaded", () => {
    const stale = { id: 3, detail: "old" };
    expect(memorySymbol(loaded({ error: "x", stale, saving: true }))).toBe(MEMORY_SYMBOLS.error);
    expect(memorySymbol(loaded({ stale, saving: true }))).toBe(MEMORY_SYMBOLS.stale);
    expect(memorySymbol(loaded({ saving: true }))).toBe(MEMORY_SYMBOLS.saving[0]);
    expect(memorySymbol(loaded())).toBe(MEMORY_SYMBOLS.loaded);
    expect(memorySymbol(state())).toBe(MEMORY_SYMBOLS.empty);
    expect(memorySymbol(state({ saving: true }))).toBe(MEMORY_SYMBOLS.saving[0]);
  });

  test("the saving arc cycles \u25dc\u25dd\u25de\u25df by frame", () => {
    const frames = [0, 1, 2, 3, 4, 5].map(frame => memorySymbol(state({ saving: true, frame })));
    expect(frames.join("")).toBe("\u25dc\u25dd\u25de\u25df\u25dc\u25dd");
  });

  test("off has no symbol and no status", () => {
    expect(memorySymbol(loaded({ role: "off" }))).toBe("");
    expect(memoryStatus(loaded({ role: "off", error: "x" }), tags)).toBeUndefined();
  });

  test("the status is one line without counts, focus ids or the role; only a stale id", () => {
    const busy = {
      focus: [99],
      inContext: [{ id: 55, via: "recall" as const }],
      stats: { prompts: 6, lookups: 4, lastMs: 38, chars: 5600, checkpoints: 1, breadcrumbs: 2, silentRuns: 3 },
    };
    const variants = [
      state(busy),
      state({ ...busy, saving: true, frame: 2 }),
      state({ ...busy, error: "exit 12 at line 3" }),
      state({ ...busy, role: "reader" }),
    ];
    for (const s of variants) {
      const text = memoryStatus(s, tags) ?? "";
      expect(text).not.toContain("\n");
      expect(text).not.toMatch(/\d/);
      expect(text).not.toContain("writer");
      expect(text).not.toContain("reader");
    }
    const stale = memoryStatus(state({ ...busy, stale: { id: 421, detail: "changed: 1.ts" } }), tags) ?? "";
    expect(stale.match(/\d+/g)).toEqual(["421"]);
  });

  test("every symbol is one terminal column", () => {
    const all = [MEMORY_SYMBOLS.loaded, MEMORY_SYMBOLS.empty, MEMORY_SYMBOLS.stale, MEMORY_SYMBOLS.error];
    for (const symbol of [...all, ...MEMORY_SYMBOLS.saving]) expect(visibleWidth(symbol)).toBe(1);
  });
});

describe("memoryViewLines", () => {
  const wide = 200;
  const text = (lines: string[]) => lines.join("\n");

  test("accent rules, the state symbol + bold title, role \u00b7 lane right-aligned within the width", () => {
    const lines = memoryViewLines(loaded(), info([]), ansi, 80);
    expect(visibleWidth(lines[0] ?? "")).toBe(80);
    expect(visibleWidth(lines[1] ?? "")).toBe(80);
    expect(lines[1]).toEndWith("writer \u00b7 lane cortex  \x1b[39m");
    expect(lines.at(-1)).toBe(lines[0]);
    const tagged = memoryViewLines(loaded({ saving: true, frame: 3 }), info([]), tags, wide);
    expect(tagged[0]).toStartWith("<accent>\u2500\u2500");
    // The panel is a snapshot: the saving arc is static.
    expect(tagged[1]).toStartWith("  <mdLink>\u25dc</mdLink> <accent><b>Memory</b></accent>");
    expect(tagged[1]).toContain("<muted>writer \u00b7 lane cortex  </muted>");
    expect(text(tagged)).toContain("<dim>r  re-read memory on the next prompt     q / Esc  close</dim>");
  });

  test("health variants", () => {
    const health = (s: MemoryViewState) => memoryViewLines(s, info([]), tags, wide)[3];
    const stats = { prompts: 6, lookups: 4, lastMs: 38, chars: 5600, checkpoints: 0, breadcrumbs: 0, silentRuns: 0 };
    expect(health(loaded({ stats }))).toBe(
      "  <mdLink>\u25cf</mdLink> <success>working</success> \u2014 4 lookups, last 38 ms \u00b7 ~1.4k tokens of memory added",
    );
    expect(health(state())).toBe("  <mdLink>\u25cb</mdLink> ready \u2014 nothing loaded yet");
    expect(health(loaded({ error: "cortex: not found" }))).toBe(
      "  <error>\u2298</error> <error>error</error> \u2014 cortex: not found",
    );
    expect(health(loaded({ stale: { id: 421, detail: "changed: src/a.ts" } }))).toBe(
      "  <warning>\u25d0</warning> <warning>stale</warning> \u2014 @421: changed: src/a.ts",
    );
    expect(health(loaded({ saving: true }))).toBe(
      "  <mdLink>\u25dc</mdLink> <accent>saving</accent> \u2014 the memory checkpoint turn is running",
    );
    expect(health(loaded({ role: "reader" }))).toBe(
      "  <mdLink>\u25cf</mdLink> read-only session (delegate): prompt hits and 2 recalls a request, never writes",
    );
    expect(health(state({ role: "off" }))).toBe("  <dim>off \u2014 CORTEX_MEMORY=off</dim>");
    expect(text(memoryViewLines(state({ role: "off" }), null, tags, wide))).not.toContain("In context");
  });

  test("Working on is for writers only, newest first", () => {
    const s = loaded({ focus: [12, 10] });
    const writer = text(
      memoryViewLines(
        s,
        info([
          [12, {}],
          [10, {}],
        ]),
        tags,
        wide,
      ),
    );
    expect(writer).toContain("<b>Working on</b>");
    expect(writer.indexOf("@12")).toBeLessThan(writer.indexOf("@10"));
    expect(text(memoryViewLines({ ...s, role: "reader" }, info([]), tags, wide))).not.toContain("Working on");
    expect(text(memoryViewLines(loaded(), info([]), tags, wide))).toContain(
      "<b>Working on</b>\n    <dim>none yet</dim>",
    );
  });

  test("In context: newest first with its reason, at most 12 rows then +N more", () => {
    const s = state({
      inContext: [
        { id: 3, via: "recall" },
        { id: 2, via: "prompt", query: "a very long prompt that goes on and on about routing events" },
        { id: 1, via: "summary" },
      ],
    });
    const lines = memoryViewLines(
      s,
      info([
        [1, {}],
        [2, {}],
        [3, {}],
      ]),
      tags,
      wide,
    );
    const all = text(lines);
    expect(all).toContain("<b>In context (3)</b>");
    expect(all.indexOf("@3")).toBeLessThan(all.indexOf("@2"));
    expect(all.indexOf("@2")).toBeLessThan(all.indexOf("@1"));
    expect(all).toContain("stream 3<dim> \u00b7 recalled by the agent</dim>");
    expect(all).toContain("stream 1<dim> \u00b7 session summary</dim>");
    const matched = lines.find(line => line.includes("@2")) ?? "";
    // The prompt is cut to 40 columns, and no reset ends the dim span early.
    expect(matched).toContain("<dim> \u00b7 matched \u201ca very long prompt that goes on and on \u2026\u201d</dim>");

    const many = state({ inContext: Array.from({ length: 15 }, (_, i) => ({ id: 100 + i, via: "recall" as const })) });
    const rows = memoryViewLines(many, info([]), tags, wide).filter(line => /^ {4}<accent>@1\d\d/.test(line));
    expect(rows).toHaveLength(12);
    expect(text(memoryViewLines(many, info([]), tags, wide))).toContain("<dim>+3 more</dim>");
  });

  test("rows name the lane only when it is not the session lane, and colour the status", () => {
    const s = loaded({
      focus: [1, 2, 3, 4, 5],
      inContext: [{ id: 6, via: "recall" }],
    });
    const streams = info([
      [1, { status: "open" }],
      [2, { status: "review" }],
      [3, { status: "blocked" }],
      [4, { status: "draft" }],
      [5, { status: "done" }],
      [6, { status: "open", lane: "infra-central" }],
    ]);
    const all = text(memoryViewLines(s, streams, tags, wide));
    expect(all).toContain("<text>open   </text>  stream 1\n");
    expect(all).toContain("<warning>review </warning>");
    expect(all).toContain("<error>blocked</error>");
    expect(all).toContain("<muted>draft  </muted>");
    expect(all).toContain("<dim>done   </dim>");
    expect(all).toContain("stream 6<dim> \u00b7 infra-central \u00b7 recalled by the agent</dim>");
    expect(all).not.toContain("\u00b7 cortex \u00b7");
  });

  test("This session lists only non-zero parts; the legend is always there", () => {
    const none = text(memoryViewLines(loaded(), info([]), tags, wide));
    expect(none).not.toContain("This session");
    expect(none).toContain(
      "<dim>\u25cf loaded  \u25cb nothing loaded  \u25dc saving  \u25d0 stale  \u2298 error</dim>",
    );
    const stats = { prompts: 6, lookups: 0, lastMs: 0, chars: 0, checkpoints: 1, breadcrumbs: 0, silentRuns: 2 };
    const some = text(memoryViewLines(loaded({ stats }), info([]), tags, wide));
    expect(some).toContain(
      "<b>This session</b>\n    <dim>6 prompts \u00b7 1 checkpoint \u00b7 2 agent runs without memory</dim>",
    );
    expect(some).not.toContain("compaction");
  });

  test("every line fits the width", () => {
    const s = loaded({
      error: "",
      focus: [423, 422],
      inContext: [
        { id: 421, via: "prompt", query: "routing events staging validation for the google edge" },
        { id: 423, via: "summary" },
      ],
      stats: { prompts: 16, lookups: 14, lastMs: 380, chars: 56000, checkpoints: 11, breadcrumbs: 12, silentRuns: 13 },
    });
    const streams = info([
      [423, { title: "05: A readable memory status and /memory panel in pi with a much longer title" }],
      [422, { title: "04: Memory recall in one call \u2014 cross-lane search, recency intent", status: "review" }],
      [421, { title: "Routing-events: validate staging DUX + FEC via Google edge", lane: "infra-central" }],
    ]);
    for (const width of [30, 40, 80, 120]) {
      for (const line of memoryViewLines(s, streams, ansi, width))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    // Titles keep their room before a long lane + reason tail on an 80-column terminal.
    const row = memoryViewLines(s, streams, tags, 80).find(line => line.includes("@421")) ?? "";
    expect(row).toContain("Routing-events");
  });

  test("without stream info the rows show ids only and say titles are unavailable", () => {
    const all = text(memoryViewLines(loaded({ focus: [7] }), null, tags, wide));
    expect(all).toContain("    <accent>@7</accent>\n");
    expect(all).toContain("<dim>titles unavailable: cortex ls --json failed</dim>");
    expect(text(memoryViewLines(loaded(), info([[7, {}]]), tags, wide))).not.toContain("titles unavailable");
  });

  test("clean() strips ESC and other control characters from titles, queries and errors", () => {
    expect(clean("a\x1b[31mb\u0007c\u009bd\ne")).toBe("a [31mb c d e");
    const hostile = "\x1b]8;;https://evil\x07click\x1b]8;;\x07\x1b[2J";
    const s = state({ error: `boom${hostile}`, inContext: [{ id: 9, via: "prompt", query: `q${hostile}` }] });
    const lines = memoryViewLines(s, info([[9, { title: `t${hostile}`, lane: `l${hostile}` }]]), tags, 400);
    expect(text(lines)).not.toContain("\x1b");
    expect(text(lines)).not.toContain("\x07");
    const panel = memoryViewLines(
      state({ inContext: [{ id: 9, via: "recall" }] }),
      info([[9, { title: hostile }]]),
      tags,
      400,
    );
    expect(text(panel)).not.toContain("\x1b");
  });
});

describe("memoryViewText", () => {
  test("the same sections without colour, rules or escape sequences", () => {
    const s = loaded({
      focus: [7],
      inContext: [
        { id: 8, via: "prompt", query: "a prompt" },
        { id: 7, via: "summary" },
      ],
      stats: { prompts: 2, lookups: 1, lastMs: 12, chars: 400, checkpoints: 0, breadcrumbs: 1, silentRuns: 0 },
    });
    const long = "x".repeat(200);
    const out = memoryViewText(
      s,
      info([
        [7, { title: long }],
        [8, { title: "eight\x1b[31m", lane: "infra" }],
      ]),
    );
    expect(out).toStartWith("\u25cf Memory \u2014 writer \u00b7 lane cortex\n");
    for (const section of ["working", "Working on", "In context (2)", "This session", "1 compaction snapshot"]) {
      expect(out).toContain(section);
    }
    expect(out).toContain("@8  open     eight [31m \u00b7 infra \u00b7 matched \u201ca prompt\u201d");
    expect(out).toContain(`${"x".repeat(79)}\u2026`);
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("<");
    expect(out).not.toContain("\u2500");
    expect(out).toEndWith("/memory refresh  re-read memory on the next prompt");
  });
});

describe("memoryReport", () => {
  test("carries every field but the spinner frame", () => {
    const s = loaded({ saving: true, frame: 3, focus: [4], stale: { id: 4, detail: "old" } });
    const report = memoryReport(s);
    expect(Object.keys(report).sort()).toEqual([
      "error",
      "focus",
      "inContext",
      "lane",
      "recallBudget",
      "role",
      "saving",
      "stale",
      "stats",
    ]);
    const { frame: _frame, ...rest } = s;
    expect(report).toEqual(rest);
  });

  test("keeps the newest rows and focus streams and cuts long text to the limits", () => {
    const long = "x".repeat(REPORT_LIMITS.text + 50);
    const s = state({
      error: long,
      stale: { id: 9, detail: long },
      focus: Array.from({ length: REPORT_LIMITS.focus + 5 }, (_, i) => i + 1),
      inContext: Array.from({ length: REPORT_LIMITS.rows + 5 }, (_, i) => ({ id: i + 1, via: "recall" as const })),
    });
    const report = memoryReport(s);
    expect(report.inContext).toHaveLength(REPORT_LIMITS.rows);
    expect(report.inContext[0]).toEqual({ id: 1, via: "recall" });
    expect(report.focus).toHaveLength(REPORT_LIMITS.focus);
    expect(report.focus[0]).toBe(1);
    expect(report.error).toHaveLength(REPORT_LIMITS.text);
    expect(report.stale?.detail).toHaveLength(REPORT_LIMITS.text);
  });

  test("builds a new object and leaves its input unchanged", () => {
    const s = loaded({ focus: [2, 1], stale: { id: 2, detail: "old" } });
    const before = structuredClone(s);
    const report = memoryReport(s);
    report.focus.push(99);
    report.inContext.push({ id: 99, via: "summary" });
    report.stats.prompts = 42;
    expect(s).toEqual(before);
    expect(report.stale).not.toBe(s.stale);
  });
});

describe("MemoryPanel", () => {
  function panel() {
    const calls: string[] = [];
    const p = new MemoryPanel(
      loaded(),
      info([]),
      tags,
      () => calls.push("close"),
      () => calls.push("refresh"),
    );
    return { p, calls };
  }

  test("q, Q and Esc close", () => {
    for (const key of ["q", "Q", "\x1b"]) {
      const { p, calls } = panel();
      p.handleInput(key);
      expect(calls).toEqual(["close"]);
    }
  });

  test("r refreshes, then closes; other keys do nothing", () => {
    const { p, calls } = panel();
    p.handleInput("x");
    expect(calls).toEqual([]);
    p.handleInput("r");
    expect(calls).toEqual(["refresh", "close"]);
  });

  test("render is cached per width; invalidate clears it", () => {
    const { p } = panel();
    const first = p.render(80);
    expect(p.render(80)).toBe(first);
    expect(p.render(60)).not.toBe(first);
    const again = p.render(60);
    p.invalidate();
    expect(p.render(60)).not.toBe(again);
    expect(p.render(60)).toEqual(again);
  });
});
