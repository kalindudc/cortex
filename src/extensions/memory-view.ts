/**
 * cortex pi extension — the memory footer status and the `/memory` panel
 * (embedded asset).
 *
 * Installed by `cortex agents install` beside the extension's `index.ts`
 * under this same name, so pi.ts's `./memory-view.ts` import resolves both
 * here and installed (a Bun `mock.module` of a missing path would leak later
 * mocks into `?query` imports); pi loads only `<dir>/index.ts`, so this
 * file is never a second extension. It holds pure
 * functions of a plain state object and a theme (no pi runtime, no I/O), so
 * it is unit-testable without pi. Its one import, `@earendil-works/pi-tui`,
 * is a pi virtual module at runtime and a cortex dependency at the same pin
 * for type-checking and tests, so unlike pi.ts it needs no `@ts-nocheck`.
 *
 * The footer speaks up only for what needs attention (a failure, stale
 * memory in use, the automatic save turn) and is otherwise a quiet marker;
 * counts, focus streams and the role live only in `/memory`.
 *
 * Stored text (titles, prompts, errors) is untrusted: every piece passes
 * clean() before it is themed, and every line is truncated to the width.
 */

import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** One symbol per state (one circle family: the shape alone tells them apart); a font gap is a one-line swap. */
export const MEMORY_SYMBOLS = {
  loaded: "\u25cf",
  empty: "\u25cb",
  stale: "\u25d0",
  error: "\u2298",
  saving: ["\u25dc", "\u25dd", "\u25de", "\u25df"],
} as const;

/**
 * Light blue for the healthy and saving symbols: pi has no dedicated blue
 * token, but `mdLink` is a blue in every bundled theme (dark `#81a2be`,
 * light and gruvbox `blue`), follows the user's theme and stays darker on
 * light ones.
 */
const LIGHT_BLUE = "mdLink";
/** In-context rows listed before `+N more`. */
const CONTEXT_ROWS = 12;
/** Focus rows listed under "Working on" (the extension keeps at most 5). */
const FOCUS_ROWS = 5;
/** The prompt text quoted in a `matched “…”` reason. */
const QUERY_WIDTH = 40;
/** Title width in the plain-text view (no terminal width to fit). */
const TEXT_TITLE_WIDTH = 80;
/** Title columns kept before the lane and reason on a narrow line (the line end is cut instead). */
const TITLE_MIN_WIDTH = 24;
/** "blocked", the longest status. */
const STATUS_WIDTH = 7;
const STATUS_COLORS: Record<string, string> = {
  open: "text",
  review: "warning",
  blocked: "error",
  draft: "muted",
  done: "dim",
};

export type MemoryViewState = {
  role: "writer" | "reader" | "off";
  lane: string | null;
  /** The last memory call's failure; "" = healthy. */
  error: string;
  /** A stale stream in use this request. */
  stale: { id: number; detail: string } | null;
  /** The checkpoint turn is running; `frame` is the spinner frame. */
  saving: boolean;
  frame: number;
  /** A reader's cortex_recall budget per request. */
  recallBudget: number;
  /** Focus streams, newest first. */
  focus: number[];
  /** Every stream shown to the agent since the session start or the last compaction, newest first. */
  inContext: { id: number; via: "summary" | "prompt" | "recall"; query?: string }[];
  stats: {
    prompts: number;
    lookups: number;
    lastMs: number;
    /** Characters memory put into context: the primer, injected hits and recall outputs. */
    chars: number;
    checkpoints: number;
    breadcrumbs: number;
    silentRuns: number;
  };
};

/** A stream's current title, status and lane (from `cortex ls --json`). */
export type StreamInfo = { title: string; status: string; lane: string };

type ThemeLike = { fg(color: string, text: string): string; bold(text: string): string };

const PLAIN: ThemeLike = { fg: (_color, text) => text, bold: text => text };

/** Control characters (ESC included) become spaces: stored text never drives the terminal. */
export function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/**
 * Stored text cleaned and cut to `width` columns before it is themed:
 * truncateToWidth measures wide characters, and its SGR resets around the
 * ellipsis are dropped (the text is plain, and a reset inside a themed span
 * would end that span's colour early).
 */
function cut(text: string, width: number): string {
  return stripTerminalSequences(truncateToWidth(clean(text), Math.max(0, width), "\u2026"));
}

/** The state's symbol ("" when off); the saving arc spins with `frame`. */
export function memorySymbol(s: MemoryViewState): string {
  if (s.role === "off") return "";
  if (s.error) return MEMORY_SYMBOLS.error;
  if (s.stale) return MEMORY_SYMBOLS.stale;
  if (s.saving) return MEMORY_SYMBOLS.saving[s.frame % MEMORY_SYMBOLS.saving.length] ?? MEMORY_SYMBOLS.saving[0];
  return s.inContext.length > 0 ? MEMORY_SYMBOLS.loaded : MEMORY_SYMBOLS.empty;
}

function symbolColor(s: MemoryViewState): string {
  if (s.error) return "error";
  if (s.stale) return "warning";
  return LIGHT_BLUE;
}

/**
 * The footer status: ONLY the highest-priority state (error > stale in use >
 * saving > loaded > nothing loaded), one short line; undefined when off.
 */
export function memoryStatus(s: MemoryViewState, theme: ThemeLike): string | undefined {
  if (s.role === "off") return undefined;
  const symbol = memorySymbol(s);
  const dot = theme.fg("dim", "\u00b7");
  if (s.error) return `${theme.fg("error", `${symbol} memory error`)} ${theme.fg("dim", "\u00b7 /memory")}`;
  if (s.stale) {
    return `${theme.fg("warning", symbol)} ${theme.fg("text", "memory")} ${dot} ${theme.fg("warning", `@${s.stale.id} stale`)}`;
  }
  const mark = theme.fg(LIGHT_BLUE, symbol);
  if (s.saving) return `${mark} ${theme.fg("dim", "memory")} ${dot} ${theme.fg("accent", "saving\u2026")}`;
  return `${mark} ${theme.fg("dim", "memory")}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `~350`, `~1.4k`: characters / 4, the usual token estimate. */
function tokens(chars: number): string {
  const n = Math.round(chars / 4);
  return n < 1000 ? `~${n}` : `~${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** A line fitted to the width (the plain-text view has none). */
const fit = (line: string, width: number | null): string =>
  width === null ? line : truncateToWidth(line, width, "\u2026");

function healthLine(s: MemoryViewState, theme: ThemeLike): string {
  if (s.role === "off") return theme.fg("dim", "off \u2014 CORTEX_MEMORY=off");
  // The panel is a snapshot: the saving arc is static.
  const symbol = theme.fg(symbolColor(s), memorySymbol({ ...s, frame: 0 }));
  if (s.error) return `${symbol} ${theme.fg("error", "error")} \u2014 ${clean(s.error)}`;
  if (s.stale) return `${symbol} ${theme.fg("warning", "stale")} \u2014 @${s.stale.id}: ${clean(s.stale.detail)}`;
  if (s.saving) return `${symbol} ${theme.fg("accent", "saving")} \u2014 the memory checkpoint turn is running`;
  if (s.role === "reader") {
    return `${symbol} read-only session (delegate): prompt hits and ${plural(s.recallBudget, "recall")} a request, never writes`;
  }
  if (s.inContext.length === 0) return `${symbol} ready \u2014 nothing loaded yet`;
  const lookups = s.stats.lookups > 0 ? `${plural(s.stats.lookups, "lookup")}, last ${s.stats.lastMs} ms` : "0 lookups";
  return `${symbol} ${theme.fg("success", "working")} \u2014 ${lookups} \u00b7 ${tokens(s.stats.chars)} tokens of memory added`;
}

function reason(entry: MemoryViewState["inContext"][number]): string {
  if (entry.via === "summary") return "session summary";
  if (entry.via === "recall") return "recalled by the agent";
  return `matched \u201c${cut(entry.query ?? "", QUERY_WIDTH)}\u201d`;
}

/** `@id  status  title` (+ the lane when not the session lane, + a reason), the title cut to fit. */
function streamRow(
  id: number,
  s: MemoryViewState,
  info: Map<number, StreamInfo> | null,
  theme: ThemeLike,
  width: number | null,
  idWidth: number,
  why = "",
): string {
  const ref = theme.fg("accent", `@${id}`);
  const pad = " ".repeat(Math.max(0, idWidth - `@${id}`.length));
  const stream = info?.get(id);
  const tail: string[] = [];
  if (stream && s.lane !== null && stream.lane !== s.lane) tail.push(clean(stream.lane));
  if (why) tail.push(why);
  const dimTail = tail.length > 0 ? theme.fg("dim", ` \u00b7 ${tail.join(" \u00b7 ")}`) : "";
  if (!stream) return fit(`    ${ref}${dimTail ? `${pad}${dimTail}` : ""}`, width);
  const status = clean(stream.status);
  const head = `    ${ref}${pad}  ${theme.fg(STATUS_COLORS[status] ?? "text", status.padEnd(STATUS_WIDTH))}  `;
  const room = width === null ? 0 : width - visibleWidth(head);
  const titleWidth =
    width === null ? TEXT_TITLE_WIDTH : Math.max(Math.min(room, TITLE_MIN_WIDTH), room - visibleWidth(dimTail));
  const title = cut(stream.title, titleWidth);
  return fit(`${head}${title}${dimTail}`, width);
}

/** The panel's sections below the header: health, Working on, In context, This session, legend. */
function sections(
  s: MemoryViewState,
  info: Map<number, StreamInfo> | null,
  theme: ThemeLike,
  width: number | null,
): string[] {
  const lines: string[] = [];
  const push = (line: string): void => {
    lines.push(fit(line, width));
  };
  push(`  ${healthLine(s, theme)}`);
  if (s.role === "off") return lines;

  const focus = s.role === "writer" ? s.focus.slice(0, FOCUS_ROWS) : [];
  const listed = s.inContext.slice(0, CONTEXT_ROWS);
  const idWidth = Math.max(0, ...[...focus, ...listed.map(entry => entry.id)].map(id => `@${id}`.length));
  const none = `    ${theme.fg("dim", "none yet")}`;
  if (s.role === "writer") {
    lines.push("");
    push(`  ${theme.bold("Working on")}`);
    if (focus.length === 0) push(none);
    for (const id of focus) lines.push(streamRow(id, s, info, theme, width, idWidth));
  }
  lines.push("");
  push(`  ${theme.bold(`In context (${s.inContext.length})`)}`);
  if (listed.length === 0) push(none);
  for (const entry of listed) lines.push(streamRow(entry.id, s, info, theme, width, idWidth, reason(entry)));
  const more = s.inContext.length - listed.length;
  if (more > 0) push(`    ${theme.fg("dim", `+${more} more`)}`);
  if (info === null && (focus.length > 0 || listed.length > 0)) {
    push(`  ${theme.fg("dim", "titles unavailable: cortex ls --json failed")}`);
  }

  const st = s.stats;
  const totals: string[] = [];
  if (st.prompts > 0) totals.push(plural(st.prompts, "prompt"));
  if (st.checkpoints > 0) totals.push(plural(st.checkpoints, "checkpoint"));
  if (st.breadcrumbs > 0) totals.push(plural(st.breadcrumbs, "compaction snapshot"));
  if (st.silentRuns > 0) totals.push(`${plural(st.silentRuns, "agent run")} without memory`);
  if (totals.length > 0) {
    lines.push("");
    push(`  ${theme.bold("This session")}`);
    push(`    ${theme.fg("dim", totals.join(" \u00b7 "))}`);
  }
  lines.push("");
  const m = MEMORY_SYMBOLS;
  push(
    `  ${theme.fg("dim", `${m.loaded} loaded  ${m.empty} nothing loaded  ${m.saving[0]} saving  ${m.stale} stale  ${m.error} error`)}`,
  );
  return lines;
}

function roleText(s: MemoryViewState): string {
  return s.lane === null ? s.role : `${s.role} \u00b7 lane ${clean(s.lane)}`;
}

/** The `/memory` panel (the `/quests` style): accent rules, bold title, right-aligned role and lane, dim hints. */
export function memoryViewLines(
  s: MemoryViewState,
  info: Map<number, StreamInfo> | null,
  theme: ThemeLike,
  width: number,
): string[] {
  const rule = theme.fg("accent", "\u2500".repeat(Math.max(0, width)));
  const symbol = memorySymbol({ ...s, frame: 0 });
  const mark = symbol ? `${theme.fg(symbolColor(s), symbol)} ` : "";
  const title = `  ${mark}${theme.fg("accent", theme.bold("Memory"))}`;
  const right = theme.fg("muted", `${roleText(s)}  `);
  const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(right));
  return [
    rule,
    truncateToWidth(`${title}${" ".repeat(gap)}${right}`, width),
    "",
    ...sections(s, info, theme, width),
    "",
    truncateToWidth(`  ${theme.fg("dim", "r  re-read memory on the next prompt     q / Esc  close")}`, width),
    rule,
  ];
}

/** The same sections as plain text (no colour, no rules, no escape sequences) for RPC and print mode. */
export function memoryViewText(s: MemoryViewState, info: Map<number, StreamInfo> | null): string {
  const symbol = memorySymbol({ ...s, frame: 0 });
  return [
    `${symbol ? `${symbol} ` : ""}Memory \u2014 ${roleText(s)}`,
    "",
    ...sections(s, info, PLAIN, null),
    "",
    "/memory refresh  re-read memory on the next prompt",
  ].join("\n");
}

/** The focused `/memory` component: q, Q or Esc closes; r re-reads memory on the next prompt, then closes. */
export class MemoryPanel {
  private cached: { width: number; lines: string[] } | null = null;

  constructor(
    private readonly state: MemoryViewState,
    private readonly info: Map<number, StreamInfo> | null,
    private readonly theme: ThemeLike,
    private readonly onClose: () => void,
    private readonly onRefresh: () => void,
  ) {}

  render(width: number): string[] {
    if (this.cached?.width === width) return this.cached.lines;
    const lines = memoryViewLines(this.state, this.info, this.theme, width);
    this.cached = { width, lines };
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
      this.onClose();
    } else if (data === "r") {
      this.onRefresh();
      this.onClose();
    }
  }

  invalidate(): void {
    this.cached = null;
  }
}
