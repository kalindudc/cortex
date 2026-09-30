// The terminal reader (plan @400 Task 10 part A: P6, N17, N19-N22).
//
// Read mode and the Split preview show the task's CURRENT text (its local
// draft when there is one, else the saved body; the preview follows every
// keystroke without touching the editor) as safe GFM: headings, lists and
// task checkboxes, tables, code blocks (numbered for :copy), block quotes,
// rules and links. It ports the browser's tested reading semantics
// (src/ui/components/active/MarkdownView.tsx, src/ui/lib/refs.ts).
//
// - Parsing uses the SAME Markdown parser and options as the web (marked,
//   gfm, no breaks; src/ui/lib/markdown.ts) on a private instance. It is a
//   renderer, NOT a security boundary: every untrusted string (text, code,
//   link text and destinations, table cells, raw HTML) crosses
//   src/tui/safety.ts before theme.ts styles it, raw HTML is shown as text,
//   images are never fetched, and only destinations safeUrl() accepts become
//   OSC 8 hyperlinks (built by safety.ts hyperlink() around escaped text).
// - Headings get the web's anchors: `task-<id>-<slug>` from the same slugger
//   over the heading's textContent, `-2`, `-3` for repeats, in document order
//   (setext and nested headings included). :heading, `{`/`}`, the outline,
//   heading links and `cortex tui <id> --heading <slug>` all use them.
// - @id / #tag references are recognized in PROSE only (never inside code,
//   link text, images or raw HTML), with the web's grammar
//   (src/ui/lib/refGrammar.ts). Following @id clears every filter and the
//   search and selects the task; #tag replaces the tag filter; a heading link
//   (`#task-<id>-<slug>` as in the web, or a bare `#<slug>`) jumps.
// - `/` (while the reader has the focus) searches the RENDERED text of each
//   paragraph, cell or code line, so a phrase broken by a soft wrap still
//   matches; n/N step with wrap-around. Matches use the theme's search pair
//   plus underline (a non-color marker); the current one is bold and marked
//   `▸` in the margin.
// - Position: per task (the session's document scroll), anchored to the
//   block or heading above the top row, so a re-wrap, an edit above it or
//   :source keeps the place. `{`/`}` and heading jumps are recorded in the
//   session's :back/:forward history.
// - :source shows the raw source (escaped) instead. Mermaid blocks show their
//   source with a rich-preview hint (this is NOT diagram parity). Copying is
//   an explicit :copy (OSC 52 through the session), never a rendering effect.
// - VISUAL (the shell's vi `v`/`V`) selects the RENDERED rows: `V` whole
//   rows, `v` grapheme clusters of their visible text (decoration included,
//   as shown), from the top row on screen. The motions move its cursor (the
//   view follows); selectedText() is the visible characters only (already
//   escaped: no SGR, OSC 8 or other control byte), rows joined by line
//   breaks. A re-wrap, another task or a click ends it. Read never edits.
// - The look: no Markdown markers; H1/H2 in md.heading over a heavy/light
//   rule, H3+ bold accent; one blank row between blocks (never two); code
//   (and inline code) on the raised surface with a caption; quotes behind an
//   accent bar in muted italics; ☐/☑ task boxes (a done item muted). A live
//   link shows only its text (OSC 8; :links lists its destination); a link
//   cortex does not follow says where it points. Without color the structure
//   stays in bold, dim, underline and the rules/bars themselves.
// - `:set number` adds a gutter with each block's source line (every code
//   line and table row its own). The same map (rowOfSourceLine) lets the
//   Split preview follow the editor's cursor (`Reader.editorCursor`): a
//   scroll or jump in the preview detaches it until the cursor moves.
//
// Known approximations: raw HTML headings (`<h2>`) are text here, while the
// web counts them in its heading numbering; named HTML entities outside the
// common set below stay literal.

import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Marked, type MarkedToken, type Token, type Tokens } from "marked";
import { parseRefs } from "../ui/lib/refGrammar.ts";
import { slugify } from "../ui/lib/slug.ts";
import { type ClusterLines, gutterWidth, type VisualKind, wordAt, wordEnd, wordNext, wordPrev } from "./editor.ts";
import { displayWidth, escapeTerminalLines, escapeTerminalText, hyperlink, type SafeUrl, safeUrl } from "./safety.ts";
import type { ScrollPosition } from "./scrollbar.ts";
import type { DocumentPlace, TuiSession } from "./session.ts";
import { type ContrastPair, type ResolvedTheme, type Seg, type StyleAttributes, seg, style } from "./theme.ts";

// ---------- the web's slugger ----------

/** The web's heading anchor slug, shared with MarkdownView and memory (src/ui/lib/slug.ts). */
export { slugify };

// ---------- the parsed document ----------

export interface ReaderHeading {
  /** The web's anchor (MarkdownView): `task-<id>-<slug>`. */
  readonly id: string;
  /** The anchor without its `task-<id>-` prefix, with the repeat number (`steps-2`). */
  readonly slug: string;
  /** The heading's text as the web's textContent (raw: escape it before rendering). */
  readonly text: string;
  readonly level: number;
  /** The top-level block that holds it. */
  readonly top: number;
}

export type ReaderTarget =
  | { readonly kind: "task"; readonly id: number }
  | { readonly kind: "tag"; readonly name: string }
  /** A `#fragment` link: the heading it names in this document, or null. */
  | { readonly kind: "heading"; readonly id: string | null; readonly fragment: string }
  | { readonly kind: "url"; readonly url: SafeUrl }
  /** A destination cortex does not open (another scheme, relative, malformed). */
  | { readonly kind: "inert"; readonly destination: string };

export interface ReaderLink {
  readonly target: ReaderTarget;
  /** What the document shows for it (raw). */
  readonly label: string;
}

export interface ReaderCodeBlock {
  /** 1-based, in document order (the `:copy <n>` number its caption shows). */
  readonly index: number;
  /** A validated language label, or null. */
  readonly language: string | null;
  /** What :copy copies: the code as the web's copy button copies it (text plus a final newline). */
  readonly text: string;
  readonly mermaid: boolean;
}

/** One styled run of ESCAPED text, mapped into its search unit (-1: interface text, never searched). */
interface Run {
  readonly text: string;
  readonly pair: ContrastPair;
  readonly attrs?: StyleAttributes;
  /** Index into the document's links (a click follows it). */
  readonly link?: number;
  /** A validated destination: the run is an OSC 8 hyperlink. */
  readonly url?: SafeUrl;
  readonly unit: number;
  /** Where `text` starts in its unit's text. */
  readonly offset: number;
  /** A hard line break (no text). */
  readonly hard?: boolean;
}

/** A container decoration: the first row under it shows `first` (a list marker), later rows `rest`. */
interface PrefixPart {
  readonly id: number;
  readonly first: Seg;
  readonly rest: Seg;
}

/** Where a block is in the source: its first line (1-based; 0 when unknown) and how many lines it spans. */
interface SourceSpan {
  readonly line: number;
  readonly lines: number;
}

type Block =
  | { readonly kind: "gap"; readonly prefix: readonly PrefixPart[]; readonly top: number }
  | ({ readonly kind: "rule"; readonly prefix: readonly PrefixPart[]; readonly top: number } & SourceSpan)
  | ({
      readonly kind: "text";
      readonly prefix: readonly PrefixPart[];
      readonly runs: readonly Run[];
      /** Index into the headings, or -1. */
      readonly heading: number;
      /** The rule under an H1 (heavy) or H2 (light). */
      readonly rule?: "heavy" | "light";
      readonly top: number;
    } & SourceSpan)
  | ({
      readonly kind: "code";
      readonly prefix: readonly PrefixPart[];
      /** Index into the code blocks. */
      readonly code: number;
      readonly caption: readonly Run[];
      /** Each escaped code line and its search unit. */
      readonly lines: readonly { readonly text: string; readonly unit: number }[];
      /** The source line of the first code line (after a fence), or 0. */
      readonly firstLine: number;
      /** A fenced block: its caption stands for the opening fence's line. */
      readonly fenced: boolean;
      readonly top: number;
    } & Omit<SourceSpan, "lines">)
  | ({
      readonly kind: "table";
      readonly prefix: readonly PrefixPart[];
      readonly header: readonly (readonly Run[])[];
      readonly rows: readonly (readonly (readonly Run[])[])[];
      readonly align: readonly ("center" | "left" | "right" | null)[];
      readonly top: number;
    } & Omit<SourceSpan, "lines">);

export interface ParsedDocument {
  readonly taskId: number;
  readonly source: string;
  readonly headings: readonly ReaderHeading[];
  /** Every link and prose reference, in document order. */
  readonly links: readonly ReaderLink[];
  readonly codeBlocks: readonly ReaderCodeBlock[];
  /** @internal The width-independent blocks. */
  readonly blocks: readonly Block[];
  /** @internal The rendered text of each search unit (escaped). */
  readonly units: readonly string[];
  /** @internal The source line each top-level block starts on (0-based). */
  readonly topLines: readonly number[];
  /** @internal How many lines the source has (the line-number gutter's width). */
  readonly lineCount: number;
}

// The web's configuration (src/ui/lib/markdown.ts), on a private instance: never the global one.
const markdown = new Marked({ gfm: true, breaks: false });

const BULLETS = ["•", "◦", "▪"] as const;
// Fence info the web shows as a caption (MarkdownView); anything else is "code".
const LANGUAGE = /^[a-z0-9_+#.-]{1,24}$/i;

// ---------- HTML entities (the browser decodes them in prose; code stays literal) ----------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  bull: "•",
  middot: "·",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  micro: "µ",
  para: "¶",
  sect: "§",
  cent: "¢",
  pound: "£",
  yen: "¥",
  euro: "€",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  lArr: "⇐",
  rArr: "⇒",
  hArr: "⇔",
  le: "≤",
  ge: "≥",
  ne: "≠",
  asymp: "≈",
  infin: "∞",
  minus: "−",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  iexcl: "¡",
  iquest: "¿",
  dagger: "†",
  Dagger: "‡",
  permil: "‰",
  prime: "′",
  Prime: "″",
  check: "✓",
  hearts: "♥",
  star: "☆",
};

// HTML maps numeric references 0x80-0x9F through windows-1252; unmapped ones stay C1 (escaped later).
const CP1252: readonly (number | undefined)[] = [
  0x20ac,
  undefined,
  0x201a,
  0x0192,
  0x201e,
  0x2026,
  0x2020,
  0x2021,
  0x02c6,
  0x2030,
  0x0160,
  0x2039,
  0x0152,
  undefined,
  0x017d,
  undefined,
  undefined,
  0x2018,
  0x2019,
  0x201c,
  0x201d,
  0x2022,
  0x2013,
  0x2014,
  0x02dc,
  0x2122,
  0x0161,
  0x203a,
  0x0153,
  undefined,
  0x017e,
  0x0178,
];

function codePoint(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
  if (code >= 0x80 && code <= 0x9f) return String.fromCodePoint(CP1252[code - 0x80] ?? code);
  return String.fromCodePoint(code);
}

/** Decode the character references the browser would (decoded text is escaped afterwards, never before). */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
      return codePoint(dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "0", 16));
    },
  );
}

/** The web's textContent of inline tokens: text (entities decoded) and code; no image alt, tags or breaks. */
function textContent(tokens: readonly Token[] | undefined): string {
  let out = "";
  for (const token of tokens ?? []) {
    const t = token as MarkedToken;
    switch (t.type) {
      case "text":
        out += t.tokens && t.tokens.length > 0 ? textContent(t.tokens) : decodeEntities(t.text);
        break;
      case "escape":
      case "codespan":
        out += t.text;
        break;
      case "image":
      case "html":
      case "br":
        break;
      default: {
        const children = childTokens(token);
        out += children !== undefined ? textContent(children) : decodeEntities(ownText(token));
      }
    }
  }
  return out;
}

/** A token's inline children, when it has them (the generic fallback). */
function childTokens(token: Token): readonly Token[] | undefined {
  const children = (token as { tokens?: unknown }).tokens;
  return Array.isArray(children) ? (children as Token[]) : undefined;
}

/** A token's own text (else its raw source; the generic fallback). */
function ownText(token: Token): string {
  const { text, raw } = token as { text?: unknown; raw?: unknown };
  return typeof text === "string" ? text : typeof raw === "string" ? raw : "";
}

/** Headings in document order with the web's anchors (MarkdownView processHost). */
function collectHeadings(tokens: readonly Token[], taskId: number): ReaderHeading[] {
  const out: ReaderHeading[] = [];
  const seen = new Map<string, number>();
  const walk = (list: readonly Token[], top: number | null): void => {
    list.forEach((token, i) => {
      const at = top ?? i;
      const t = token as MarkedToken;
      if (t.type === "heading") {
        const text = textContent(t.tokens);
        const base = slugify(text);
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        const slug = count === 1 ? base : `${base}-${count}`;
        out.push({ id: `task-${taskId}-${slug}`, slug, text, level: t.depth, top: at });
      } else if (t.type === "blockquote") walk(t.tokens, at);
      else if (t.type === "list") for (const item of t.items) walk(item.tokens, at);
    });
  };
  walk(tokens, null);
  return out;
}

/**
 * A heading of the document by the bare slug (`steps-2`), the web anchor
 * (`task-<id>-steps-2`) or either as a `#fragment`, case-insensitively; null
 * when there is none.
 */
export function findHeading(doc: Pick<ParsedDocument, "headings">, input: string): ReaderHeading | null {
  const wanted = input.trim().replace(/^#/, "").toLowerCase();
  if (wanted === "") return null;
  return doc.headings.find(h => h.id === wanted) ?? doc.headings.find(h => h.slug === wanted) ?? null;
}

interface InlineStyle {
  readonly pair: ContrastPair;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
}

interface Context {
  readonly prefix: readonly PrefixPart[];
  readonly depth: number;
  readonly quote: boolean;
  /** Inside a checked task item: its text is muted. */
  readonly done: boolean;
}

const attrsOf = (s: InlineStyle): StyleAttributes | undefined =>
  s.bold || s.italic || s.underline || s.strikethrough
    ? { bold: s.bold, italic: s.italic, underline: s.underline, strikethrough: s.strikethrough }
    : undefined;

/** The code pair under a style: tinted like a code block (headings, quotes and links keep their emphasis). */
const codeStyle = (s: InlineStyle): InlineStyle => ({ ...s, pair: "md.code@raised", underline: false });

/** Blocks a blank row always sets apart, even inside a tight list item. */
const SPACED = new Set(["code", "table", "blockquote", "heading", "hr", "html"]);
const spaced = (token: Token): boolean => SPACED.has(token.type);
/** How many source lines a token's raw text spans (trailing blank lines excluded). */
const spanOf = (raw: unknown): number => (typeof raw === "string" ? raw.replace(/\s+$/, "").split("\n").length : 1);

/** Source positions to 1-based line numbers. */
class SourceLines {
  readonly #starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.#starts.push(i + 1);
  }

  get count(): number {
    return this.#starts.length;
  }

  lineAt(pos: number): number {
    let lo = 0;
    let hi = this.#starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.#starts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Where 1-based line `line` starts (the end of the text past the last line). */
  startOf(line: number): number {
    return this.#starts[line - 1] ?? this.text.length;
  }
}

class Parser {
  readonly blocks: Block[] = [];
  readonly units: string[] = [];
  readonly links: ReaderLink[] = [];
  readonly codeBlocks: ReaderCodeBlock[] = [];
  #partId = 0;
  #heading = 0;
  #top = 0;
  /** The source search: where the next block may start, and the end of the current top-level block. */
  #cursor = 0;
  #end = 0;

  constructor(
    readonly taskId: number,
    readonly headings: readonly ReaderHeading[],
    readonly source: SourceLines,
  ) {}

  document(tokens: readonly Token[], ranges: readonly (readonly [number, number])[]): void {
    tokens.forEach((token, i) => {
      if (token.type === "space" || token.type === "def") return;
      this.#top = i;
      const range = ranges[i];
      if (range !== undefined) [this.#cursor, this.#end] = range;
      this.#gap([]);
      this.#block(token, { prefix: [], depth: 0, quote: false, done: false });
    });
  }

  /** One blank row between blocks: never first, never two in a row. */
  #gap(prefix: readonly PrefixPart[]): void {
    const last = this.blocks[this.blocks.length - 1];
    if (last !== undefined && last.kind !== "gap") this.blocks.push({ kind: "gap", prefix, top: this.#top });
  }

  /**
   * The 1-based source line where a block starts. Nested blocks lose their
   * indentation and `>` markers in their raw text, so its first line is
   * searched forward from the cursor inside the current top-level block. A
   * container keeps the cursor at its start (its first child starts on its
   * line); a leaf moves it past its lines.
   */
  #locate(token: { readonly raw?: unknown }, container: boolean): number {
    const raw = typeof token.raw === "string" ? token.raw : "";
    const first =
      raw
        .split("\n")
        .find(l => l.trim() !== "")
        ?.trim() ?? "";
    const found = first === "" ? -1 : this.source.text.indexOf(first, this.#cursor);
    const at = found < 0 || found >= this.#end ? this.#cursor : found;
    const line = this.source.lineAt(at);
    this.#cursor = container ? at : Math.max(at + first.length, this.source.startOf(line + spanOf(raw)));
    return line;
  }

  #unit(): number {
    this.units.push("");
    return this.units.length - 1;
  }

  #part(first: string, rest: string, pair: ContrastPair): PrefixPart {
    return { id: ++this.#partId, first: seg(pair, first), rest: seg(pair, rest) };
  }

  /** Child blocks of a container; `loose` (or a spaced block) puts a blank row between two of them. */
  #children(tokens: readonly Token[], ctx: Context, loose: boolean, line: number): void {
    let previous: Token | null = null;
    for (const token of tokens) {
      if (token.type === "space" || token.type === "def") continue;
      if (previous !== null && (loose || spaced(previous) || spaced(token))) this.#gap(ctx.prefix);
      previous = token;
      this.#block(token, ctx);
    }
    // An empty item still shows its marker.
    if (previous === null) this.#text([], ctx, { pair: "text@bg" }, -1, { line, lines: 1 });
  }

  #block(block: Token, ctx: Context): void {
    const base: InlineStyle = ctx.quote
      ? { pair: "md.quote@bg", italic: true }
      : { pair: ctx.done ? "muted@bg" : "text@bg" };
    const token = block as MarkedToken;
    const container = token.type === "blockquote" || token.type === "list";
    const span: SourceSpan = { line: this.#locate(token, container), lines: spanOf(token.raw) };
    switch (token.type) {
      case "heading": {
        const heading = this.#heading++;
        // H1 and H2 in the heading color over a rule, H3 and deeper in the accent; never a `#` marker.
        const style: InlineStyle = { pair: token.depth <= 2 ? "md.heading@bg" : "accent@bg", bold: true };
        const unit = this.#unit();
        const runs: Run[] = [];
        this.#inlines(token.tokens, style, true, unit, runs);
        const rule = token.depth === 1 ? "heavy" : token.depth === 2 ? "light" : undefined;
        this.blocks.push({ kind: "text", prefix: ctx.prefix, runs, heading, rule, top: this.#top, ...span });
        return;
      }
      case "paragraph":
        this.#text(token.tokens, ctx, base, -1, span);
        return;
      case "text":
        this.#text(
          token.tokens && token.tokens.length > 0 ? token.tokens : [{ type: "text", raw: token.raw, text: token.text }],
          ctx,
          base,
          -1,
          span,
        );
        return;
      case "code":
        this.#code(token, ctx, span.line);
        return;
      case "blockquote":
        this.#children(
          token.tokens,
          { ...ctx, prefix: [...ctx.prefix, this.#part("┃ ", "┃ ", "accent@bg")], quote: true },
          true,
          span.line,
        );
        return;
      case "list":
        this.#list(token, ctx);
        return;
      case "table":
        this.#table(token, ctx, base, span.line);
        return;
      case "hr":
        this.blocks.push({ kind: "rule", prefix: ctx.prefix, top: this.#top, ...span });
        return;
      case "html": {
        // Raw HTML is text: each source line as written.
        const unit = this.#unit();
        const runs: Run[] = [];
        const lines = token.text.replace(/\n+$/, "").split("\n");
        lines.forEach((line: string, i: number) => {
          if (i > 0) this.#hard(runs, unit);
          this.#run(runs, unit, line.replace(/\t/g, "    "), base);
        });
        this.blocks.push({ kind: "text", prefix: ctx.prefix, runs, heading: -1, top: this.#top, ...span });
        return;
      }
      default: {
        const raw = ownText(block).trim();
        if (raw !== "") this.#text([{ type: "text", raw, text: raw }], ctx, base, -1, span);
      }
    }
  }

  #text(tokens: readonly Token[], ctx: Context, style: InlineStyle, heading: number, span: SourceSpan): void {
    const unit = this.#unit();
    const runs: Run[] = [];
    this.#inlines(tokens, style, true, unit, runs);
    this.blocks.push({ kind: "text", prefix: ctx.prefix, runs, heading, top: this.#top, ...span });
  }

  #list(token: Tokens.List, ctx: Context): void {
    const start = typeof token.start === "number" ? token.start : 1;
    const bullet = BULLETS[ctx.depth % BULLETS.length] ?? "•";
    let previous: Tokens.ListItem | null = null;
    token.items.forEach((item, i) => {
      const line = this.#locate(item, true);
      // Items are set apart in a loose list, or when either holds a spaced block (code, a table ...).
      if (previous !== null && (token.loose || previous.tokens.some(spaced) || item.tokens.some(spaced))) {
        this.#gap(ctx.prefix);
      }
      previous = item;
      const number = token.ordered ? `${start + i}. ` : "";
      const done = item.task && item.checked === true;
      const marker = item.task ? `${number}${done ? "☑" : "☐"} ` : token.ordered ? number : `${bullet} `;
      const part = this.#part(marker, " ".repeat(displayWidth(marker)), done ? "status.done@bg" : "md.bullet@bg");
      this.#children(
        item.tokens,
        { prefix: [...ctx.prefix, part], depth: ctx.depth + 1, quote: ctx.quote, done: ctx.done || done },
        item.loose,
        line,
      );
    });
  }

  #code(token: Tokens.Code, ctx: Context, line: number): void {
    const code = this.codeBlocks.length;
    const word = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
    const language = LANGUAGE.test(word) ? word : null;
    const mermaid = token.lang === "mermaid";
    this.codeBlocks.push({ index: code + 1, language, text: `${token.text.replace(/\n$/, "")}\n`, mermaid });
    // The caption heads the code panel: the language (or what the block is) and its :copy number.
    const caption: Run[] = [
      ...(mermaid
        ? [ui("mermaid source", "muted@raised"), ui(" · ", "dim@raised"), ui("rich preview: :preview", "info@raised")]
        : [ui(language ?? "code", "muted@raised")]),
      ui(" · ", "dim@raised"),
      ui(`:copy ${code + 1}`, "dim@raised"),
    ];
    const lines = escapeTerminalLines(token.text).map(text => {
      const unit = this.#unit();
      this.units[unit] = text;
      return { text, unit };
    });
    const fenced = /^ {0,3}(?:`{3,}|~{3,})/.test(token.raw);
    const firstLine = line > 0 ? line + (fenced ? 1 : 0) : 0;
    this.blocks.push({
      kind: "code",
      prefix: ctx.prefix,
      code,
      caption,
      lines,
      firstLine,
      fenced,
      top: this.#top,
      line,
    });
  }

  #table(token: Tokens.Table, ctx: Context, base: InlineStyle, line: number): void {
    const cell = (c: Tokens.TableCell, header: boolean): Run[] => {
      const unit = this.#unit();
      const runs: Run[] = [];
      this.#inlines(c.tokens, header ? { ...base, bold: true } : base, true, unit, runs);
      return runs;
    };
    const header = token.header.map(c => cell(c, true));
    const rows = token.rows.map(r => r.map(c => cell(c, false)));
    this.blocks.push({ kind: "table", prefix: ctx.prefix, header, rows, align: token.align, top: this.#top, line });
  }

  #run(runs: Run[], unit: number, raw: string, style: InlineStyle, link?: { index: number; url?: SafeUrl }): void {
    const text = escapeTerminalText(raw);
    if (text === "") return;
    const offset = unit >= 0 ? (this.units[unit]?.length ?? 0) : 0;
    if (unit >= 0) this.units[unit] += text;
    runs.push({
      text,
      pair: style.pair,
      attrs: attrsOf(style),
      ...(link === undefined ? {} : { link: link.index, ...(link.url === undefined ? {} : { url: link.url }) }),
      unit,
      offset,
    });
  }

  #hard(runs: Run[], unit: number): void {
    const offset = this.units[unit]?.length ?? 0;
    this.units[unit] += "\n"; // never rendered; keeps matches from spanning the break
    runs.push({ text: "", pair: "text@bg", unit, offset, hard: true });
  }

  /** Inline tokens into runs; adjacent prose text is joined first so @id/#tag match as in the DOM's text nodes. */
  #inlines(
    tokens: readonly Token[],
    style: InlineStyle,
    prose: boolean,
    unit: number,
    runs: Run[],
    link?: { index: number; url?: SafeUrl },
  ): void {
    let buffer = "";
    const flush = (): void => {
      if (buffer === "") return;
      // HTML collapses whitespace (soft line breaks included) to one space.
      const text = buffer.replace(/[ \t\n\r\f]+/g, " ");
      buffer = "";
      if (!prose || link !== undefined) {
        this.#run(runs, unit, text, style, link);
        return;
      }
      for (const part of parseRefs(text)) {
        if (part.kind === "text") {
          this.#run(runs, unit, part.text, style);
          continue;
        }
        const target: ReaderTarget =
          part.kind === "task" ? { kind: "task", id: part.id } : { kind: "tag", name: part.name };
        const label = part.kind === "task" ? `@${part.id}` : `#${part.name}`;
        const index = this.links.push({ target, label }) - 1;
        this.#run(runs, unit, label, { ...style, pair: "md.link@bg", underline: true }, { index });
      }
    };
    for (const token of tokens) {
      const t = token as MarkedToken;
      switch (t.type) {
        case "text":
          if (t.tokens && t.tokens.length > 0) {
            flush();
            this.#inlines(t.tokens, style, prose, unit, runs, link);
          } else buffer += decodeEntities(t.text);
          break;
        case "escape":
          buffer += t.text;
          break;
        case "strong":
          flush();
          this.#inlines(t.tokens, { ...style, bold: true }, prose, unit, runs, link);
          break;
        case "em":
          flush();
          this.#inlines(t.tokens, { ...style, italic: true }, prose, unit, runs, link);
          break;
        case "del":
          flush();
          this.#inlines(t.tokens, { ...style, strikethrough: true }, prose, unit, runs, link);
          break;
        case "codespan":
          flush();
          this.#run(runs, unit, t.text.replace(/\t/g, " "), codeStyle(style), link);
          break;
        case "br":
          flush();
          this.#hard(runs, unit);
          break;
        case "link":
          flush();
          this.#link(t, style, unit, runs, link);
          break;
        case "image": {
          flush();
          const image = t;
          const alt = textContent(image.tokens) || image.text;
          this.#run(runs, unit, `[image: ${alt}]`, link === undefined ? { ...style, pair: "muted@bg" } : style, link);
          if (image.href) this.#run(runs, unit, ` (${image.href})`, { pair: "dim@bg" });
          break;
        }
        case "html":
          flush();
          this.#run(runs, unit, t.text.replace(/[\t\n\r]+/g, " "), style, link);
          break;
        default:
          buffer += decodeEntities(ownText(token));
      }
    }
    flush();
  }

  #link(t: Tokens.Link, style: InlineStyle, unit: number, runs: Run[], outer?: { index: number; url?: SafeUrl }): void {
    if (outer !== undefined) {
      // A link inside a link cannot happen in CommonMark; show its text under the outer one.
      this.#inlines(t.tokens, style, false, unit, runs, outer);
      return;
    }
    const href = t.href ?? "";
    const label = textContent(t.tokens);
    let target: ReaderTarget;
    if (href.startsWith("#")) {
      const fragment = href.slice(1);
      target = { kind: "heading", id: findHeading(this, fragment)?.id ?? null, fragment };
    } else {
      const url = safeUrl(href);
      target = url === null ? { kind: "inert", destination: href } : { kind: "url", url };
    }
    const index = this.links.push({ target, label }) - 1;
    const live = target.kind === "url" || (target.kind === "heading" && target.id !== null);
    const linkStyle: InlineStyle = live ? { ...style, pair: "md.link@bg", underline: true } : style;
    this.#inlines(t.tokens, linkStyle, false, unit, runs, {
      index,
      ...(target.kind === "url" ? { url: target.url } : {}),
    });
    const suffix = live ? null : describeDestination(target);
    if (suffix !== null) this.#run(runs, unit, ` (${suffix})`, { pair: "dim@bg" });
  }
}

/**
 * What a link cortex does not follow says after its text: where it points.
 * A live link shows its text only: a web link is an OSC 8 hyperlink (its
 * destination is also listed by :links, which copies it), a heading link
 * jumps.
 */
function describeDestination(target: ReaderTarget): string | null {
  switch (target.kind) {
    case "heading":
      return target.id === null ? `#${target.fragment} · no such heading` : null;
    case "inert":
      return target.destination === "" ? "no destination" : `${target.destination} · not a web link`;
    default:
      return null;
  }
}

/** Where each top-level token starts and ends in the (line-ending normalized) source text. */
function topRanges(text: string, tokens: readonly Token[]): [number, number][] {
  const out: [number, number][] = [];
  let cursor = 0;
  for (const token of tokens) {
    const raw = typeof token.raw === "string" ? token.raw : "";
    const at = raw === "" ? -1 : text.indexOf(raw, cursor);
    const start = at < 0 ? cursor : at;
    const end = start + raw.length;
    out.push([start, end]);
    cursor = Math.max(cursor, end);
  }
  return out;
}

/** Parse one task's Markdown into width-independent blocks, headings, links and code blocks. */
export function parseDocument(source: string, taskId: number): ParsedDocument {
  const tokens = markdown.lexer(source);
  const headings = collectHeadings(tokens, taskId);
  const lines = new SourceLines(source.replace(/\r\n|\r/g, "\n"));
  const ranges = topRanges(lines.text, tokens);
  const parser = new Parser(taskId, headings, lines);
  parser.document(tokens, ranges);
  return {
    taskId,
    source,
    headings,
    links: parser.links,
    codeBlocks: parser.codeBlocks,
    blocks: parser.blocks,
    units: parser.units,
    topLines: ranges.map(([start]) => lines.lineAt(start) - 1),
    lineCount: lines.count,
  };
}

// ---------- layout (width-dependent) ----------

/** One rendered row: decoration, content runs and the surface its padding uses. */
interface Row {
  readonly prefix: readonly Seg[];
  readonly runs: readonly Run[];
  readonly fill: ContrastPair;
  /** The top-level block it belongs to. */
  readonly top: number;
  /** The 1-based source line the line-number gutter shows on it (a block's first row, each code line). */
  readonly line?: number;
}

/** Where a source line is rendered: the first row of its block, its rows and the source lines they show. */
interface LineEntry {
  readonly line: number;
  readonly row: number;
  readonly rows: number;
  readonly lines: number;
}

export interface DocumentLayout {
  readonly doc: ParsedDocument;
  readonly width: number;
  /** The raw-source view (:source). */
  readonly source: boolean;
  /** Cells of the line-number gutter (:set number), 0 without it. */
  readonly gutter: number;
  /** @internal */
  readonly rows: readonly Row[];
  /** @internal Rendered places of source lines, in row order with nondecreasing lines. */
  readonly lineIndex: readonly LineEntry[];
  /** @internal The search units of this view (rendered text, or source lines). */
  readonly units: readonly string[];
  /** Rendered: the first row of each heading (aligned with doc.headings). Source: the rows of `#` heading lines. */
  readonly headingRows: readonly number[];
  /** Rendered: the rows of each code block (caption to last line). */
  readonly codeSpans: readonly (readonly [number, number])[];
  /** @internal */
  readonly rowsByUnit: ReadonlyMap<number, readonly number[]>;
  /** @internal First and last row of each top-level block. */
  readonly topSpans: ReadonlyMap<number, readonly [number, number]>;
}

/** Left margin (the current-match marker) and right margin. */
const MARGIN = 1;
const RIGHT = 1;
/** Narrower content than this drops the container decoration (very deep nesting). */
const MIN_INNER = 12;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Word-wrap runs to `width` cells; a word longer than a row breaks at graphemes; wrap points drop their space. */
function wrapRuns(runs: readonly Run[], width: number): Run[][] {
  const rows: Run[][] = [];
  let row: Run[] = [];
  let used = 0;
  const trimEnd = (): void => {
    for (;;) {
      const last = row[row.length - 1];
      if (last === undefined || !last.text.endsWith(" ")) return;
      const text = last.text.replace(/ +$/, "");
      if (text === "") row.pop();
      else row[row.length - 1] = { ...last, text };
    }
  };
  const newRow = (): void => {
    trimEnd();
    rows.push(row);
    row = [];
    used = 0;
  };
  const append = (run: Run, text: string, offset: number): void => {
    const last = row[row.length - 1];
    if (
      last !== undefined &&
      last.pair === run.pair &&
      last.attrs === run.attrs &&
      last.link === run.link &&
      last.url === run.url &&
      last.unit === run.unit &&
      last.offset + last.text.length === offset
    ) {
      row[row.length - 1] = { ...last, text: last.text + text };
    } else row.push({ ...run, text, offset });
    used += displayWidth(text);
  };
  for (const run of runs) {
    if (run.hard) {
      newRow();
      continue;
    }
    for (const m of run.text.matchAll(/ +|[^ ]+/g)) {
      const piece = m[0];
      const offset = run.offset + (m.index ?? 0);
      const w = displayWidth(piece);
      if (piece.startsWith(" ")) {
        if (used === 0) continue;
        if (used + w > width) {
          newRow();
          continue;
        }
        append(run, piece, offset);
        continue;
      }
      if (used + w <= width) {
        append(run, piece, offset);
        continue;
      }
      if (used > 0 && w <= width) {
        newRow();
        append(run, piece, offset);
        continue;
      }
      for (const { segment, index } of graphemes.segment(piece)) {
        if (used > 0 && used + displayWidth(segment) > width) newRow();
        append(run, segment, offset + index);
      }
    }
  }
  if (row.length > 0 || rows.length === 0) newRow();
  return rows;
}

/** Cut escaped text into chunks of at most `width` cells at grapheme boundaries. */
function hardWrap(text: string, width: number): { text: string; offset: number }[] {
  if (displayWidth(text) <= width) return [{ text, offset: 0 }];
  const out: { text: string; offset: number }[] = [];
  let chunk = "";
  let start = 0;
  let used = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    const w = displayWidth(segment);
    if (used + w > width && chunk !== "") {
      out.push({ text: chunk, offset: start });
      chunk = "";
      used = 0;
      start = index;
    }
    chunk += segment;
    used += w;
  }
  if (chunk !== "") out.push({ text: chunk, offset: start });
  return out;
}

const pad = (n: number, pair: ContrastPair = "text@bg"): Run => ({
  text: " ".repeat(Math.max(0, n)),
  pair,
  unit: -1,
  offset: 0,
});
const ui = (text: string, pair: ContrastPair, attrs?: StyleAttributes): Run => ({
  text,
  pair,
  attrs,
  unit: -1,
  offset: 0,
});
const runsWidth = (runs: readonly Run[]): number => runs.reduce((n, r) => n + displayWidth(r.text), 0);

class LayoutBuilder {
  readonly rows: Row[] = [];
  readonly rowsByUnit = new Map<number, number[]>();
  readonly topSpans = new Map<number, [number, number]>();
  readonly lineIndex: LineEntry[] = [];
  readonly #used = new Set<number>();

  constructor(readonly width: number) {}

  /** The content width under `prefix`, and the decoration actually drawn (dropped when too deep). */
  frame(prefix: readonly PrefixPart[]): { parts: readonly PrefixPart[]; inner: number } {
    const decoration = prefix.reduce((n, p) => n + displayWidth(p.first.text), 0);
    const inner = this.width - MARGIN - RIGHT - decoration;
    if (inner >= MIN_INNER || prefix.length === 0) return { parts: prefix, inner: Math.max(1, inner) };
    return { parts: [], inner: Math.max(1, this.width - MARGIN - RIGHT) };
  }

  /** One row; `line` (> 0) is the source line its gutter shows. */
  emit(
    parts: readonly PrefixPart[],
    runs: readonly Run[],
    top: number,
    fill: ContrastPair = "text@bg",
    line = 0,
  ): number {
    const prefix = parts.map(p => (this.#used.has(p.id) ? p.rest : p.first));
    for (const p of parts) this.#used.add(p.id);
    return this.#push({ prefix, runs, fill, top, ...(line > 0 ? { line } : {}) });
  }

  gap(parts: readonly PrefixPart[], top: number): void {
    this.#push({ prefix: parts.map(p => p.rest), runs: [], fill: "text@bg", top });
  }

  /** Record that source lines [line, line + lines) show on `rows` rows from `row` (for rowOfSourceLine). */
  place(line: number, lines: number, row: number, rows: number): void {
    const last = this.lineIndex[this.lineIndex.length - 1];
    if (line <= 0 || rows <= 0 || (last !== undefined && line < last.line)) return;
    this.lineIndex.push({ line, lines: Math.max(1, lines), row, rows });
  }

  #push(row: Row): number {
    const at = this.rows.length;
    this.rows.push(row);
    for (const run of row.runs) {
      if (run.unit < 0) continue;
      const list = this.rowsByUnit.get(run.unit);
      if (list === undefined) this.rowsByUnit.set(run.unit, [at]);
      else if (list[list.length - 1] !== at) list.push(at);
    }
    const span = this.topSpans.get(row.top);
    if (span === undefined) this.topSpans.set(row.top, [at, at]);
    else span[1] = at;
    return at;
  }
}

function layoutTable(b: LayoutBuilder, block: Extract<Block, { kind: "table" }>): void {
  const { parts, inner } = b.frame(block.prefix);
  const all = [block.header, ...block.rows];
  const cols = Math.max(block.header.length, ...block.rows.map(r => r.length));
  const available = inner - (cols + 1) - 2 * cols;
  if (cols === 0) return;
  // The header is on the block's line, the delimiter row next, then one line per row.
  const lineOf = (r: number): number => (block.line > 0 ? block.line + (r === 0 ? 0 : r + 1) : 0);
  if (available < cols) {
    // Too narrow for columns: one wrapped line per row, cells separated by │.
    all.forEach((cells, r) => {
      const runs: Run[] = [];
      cells.forEach((cell, i) => {
        if (i > 0) runs.push(ui(" │ ", "border@bg"));
        runs.push(...cell);
      });
      const lines = wrapRuns(runs, inner);
      const first = b.rows.length;
      lines.forEach((line, i) => {
        b.emit(parts, line, block.top, "text@bg", i === 0 ? lineOf(r) : 0);
      });
      b.place(lineOf(r), 1, first, lines.length);
    });
    return;
  }
  const widths = Array.from({ length: cols }, (_, c) => Math.max(1, ...all.map(r => runsWidth(r[c] ?? []))));
  let total = widths.reduce((a, w) => a + w, 0);
  while (total > available) {
    let widest = 0;
    for (let c = 1; c < cols; c++) if ((widths[c] ?? 0) >= (widths[widest] ?? 0)) widest = c;
    if ((widths[widest] ?? 1) <= 1) break;
    widths[widest] = (widths[widest] ?? 1) - 1;
    total--;
  }
  const rule = (left: string, mid: string, right: string): Run[] => [
    ui(left + widths.map(w => "─".repeat(w + 2)).join(mid) + right, "border@bg"),
  ];
  const physical = (cells: readonly (readonly Run[])[], line: number): void => {
    const wrapped = widths.map((w, c) => wrapRuns(cells[c] ?? [], w));
    const height = Math.max(1, ...wrapped.map(w => w.length));
    const first = b.rows.length;
    for (let i = 0; i < height; i++) {
      const runs: Run[] = [ui("│", "border@bg")];
      widths.forEach((w, c) => {
        const line = wrapped[c]?.[i] ?? [];
        const room = w - runsWidth(line);
        const align = block.align[c] ?? null;
        const left = align === "right" ? room : align === "center" ? Math.floor(room / 2) : 0;
        runs.push(pad(1 + left), ...line, pad(room - left + 1), ui("│", "border@bg"));
      });
      b.emit(parts, runs, block.top, "text@bg", i === 0 ? line : 0);
    }
    b.place(line, 1, first, height);
  };
  b.emit(parts, rule("┌", "┬", "┐"), block.top);
  physical(block.header, lineOf(0));
  b.emit(parts, rule("├", "┼", "┤"), block.top);
  block.rows.forEach((cells, r) => {
    physical(cells, lineOf(r + 1));
  });
  b.emit(parts, rule("└", "┴", "┘"), block.top);
}

/** A thematic break: a rule with a centered ornament. */
function ruleRuns(inner: number): Run[] {
  if (inner < 7) return [ui("─".repeat(inner), "border@bg")];
  const left = Math.floor((inner - 3) / 2);
  return [ui("─".repeat(left), "border@bg"), ui(" ◆ ", "md.bullet@bg"), ui("─".repeat(inner - 3 - left), "border@bg")];
}

/** Runs padded with `pair` to exactly `width` cells (a panel row). */
const panel = (runs: readonly Run[], width: number, pair: ContrastPair): Run[] => [
  ...runs,
  pad(width - runsWidth(runs), pair),
];

const EMPTY_ROW: Row = {
  prefix: [],
  runs: [ui("No description yet · i adds one", "muted@bg")],
  fill: "text@bg",
  top: -1,
};

/** The gutter for `numbers`: at least three digits and a space, like the editor's. */
const gutterOf = (doc: ParsedDocument, numbers: boolean): number => (numbers ? gutterWidth(doc.lineCount) : 0);

function layoutRendered(doc: ParsedDocument, width: number, numbers: boolean): DocumentLayout {
  const gutter = gutterOf(doc, numbers);
  const b = new LayoutBuilder(Math.max(1, width - gutter));
  const headingRows: number[] = [];
  const codeSpans: [number, number][] = [];
  for (const block of doc.blocks) {
    const { parts, inner } = b.frame(block.prefix);
    switch (block.kind) {
      case "gap":
        b.gap(parts, block.top);
        break;
      case "rule":
        b.place(block.line, block.lines, b.emit(parts, ruleRuns(inner), block.top, "text@bg", block.line), 1);
        break;
      case "text": {
        const lines = wrapRuns(block.runs, inner);
        const first = b.rows.length;
        lines.forEach((line, i) => {
          const at = b.emit(parts, line, block.top, "text@bg", i === 0 ? block.line : 0);
          if (i === 0 && block.heading >= 0) headingRows[block.heading] = at;
        });
        b.place(block.line, block.lines, first, lines.length);
        // H1 sits over a heavy rule in its own color, H2 over a light one: the full content width.
        if (block.rule === "heavy") b.emit(parts, [ui("━".repeat(inner), "md.heading@bg")], block.top);
        else if (block.rule === "light") b.emit(parts, [ui("─".repeat(inner), "border@bg")], block.top);
        break;
      }
      case "code": {
        // A raised panel over the content width: a caption (the language and the :copy number; a narrow
        // pane wraps it, never drops it), then each line behind a bar (↪ where a long one continues).
        const start = b.rows.length;
        const text = Math.max(1, inner - 2);
        wrapRuns(block.caption, text).forEach((row, i) => {
          const line = i === 0 && block.fenced ? block.line : 0;
          b.place(
            line,
            1,
            b.emit(parts, panel([ui("  ", "text@raised"), ...row], inner, "text@raised"), block.top, "text@bg", line),
            1,
          );
        });
        block.lines.forEach((line, n) => {
          const source = block.firstLine > 0 ? block.firstLine + n : 0;
          const chunks = hardWrap(line.text, text);
          const first = b.rows.length;
          chunks.forEach((chunk, i) => {
            const runs: Run[] = [
              ui(i === 0 ? "│ " : "↪ ", i === 0 ? "border@raised" : "dim@raised"),
              { text: chunk.text, pair: "md.code@raised", unit: line.unit, offset: chunk.offset },
            ];
            b.emit(parts, panel(runs, inner, "text@raised"), block.top, "text@bg", i === 0 ? source : 0);
          });
          b.place(source, 1, first, chunks.length);
        });
        codeSpans[block.code] = [start, b.rows.length - 1];
        break;
      }
      case "table":
        layoutTable(b, block);
        break;
    }
  }
  if (b.rows.length === 0) b.rows.push(EMPTY_ROW);
  return {
    doc,
    width,
    source: false,
    gutter,
    rows: b.rows,
    lineIndex: b.lineIndex,
    units: doc.units,
    headingRows,
    codeSpans,
    rowsByUnit: b.rowsByUnit,
    topSpans: b.topSpans,
  };
}

/** The raw source, escaped, one search unit per line; `#` heading lines (outside fences) for {/}. */
function layoutSource(doc: ParsedDocument, width: number, numbers: boolean): DocumentLayout {
  const gutter = gutterOf(doc, numbers);
  const b = new LayoutBuilder(Math.max(1, width - gutter));
  const inner = Math.max(1, b.width - MARGIN - RIGHT);
  const lines = doc.source === "" ? [] : escapeTerminalLines(doc.source);
  const raw = doc.source.split(/\r\n|\n|\r/);
  const headingRows: number[] = [];
  let fence: string | null = null;
  let top = 0;
  lines.forEach((line, i) => {
    while (top + 1 < doc.topLines.length && (doc.topLines[top + 1] ?? 0) <= i) top++;
    const source = raw[i] ?? "";
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(source)?.[1];
    let heading = false;
    if (fence !== null) {
      if (opener?.startsWith(fence)) fence = null;
    } else if (opener !== undefined) fence = opener.slice(0, 3);
    else heading = /^ {0,3}#{1,6}(?:[ \t]|$)/.test(source);
    const first = b.rows.length;
    const chunks = hardWrap(line, inner);
    chunks.forEach((chunk, j) => {
      const runs = [{ text: chunk.text, pair: "text@bg" as const, unit: i, offset: chunk.offset }];
      const at = b.emit([], runs, top, "text@bg", j === 0 ? i + 1 : 0);
      if (j === 0 && heading) headingRows.push(at);
    });
    b.place(i + 1, 1, first, chunks.length);
  });
  if (b.rows.length === 0) b.rows.push(EMPTY_ROW);
  return {
    doc,
    width,
    source: true,
    gutter,
    rows: b.rows,
    lineIndex: b.lineIndex,
    units: lines,
    headingRows,
    codeSpans: [],
    rowsByUnit: b.rowsByUnit,
    topSpans: b.topSpans,
  };
}

/** Lay a parsed document out at `width` cells: the rendered view, or the raw source (`source`); `numbers` adds the gutter. */
export function layoutDocument(doc: ParsedDocument, width: number, source = false, numbers = false): DocumentLayout {
  return source ? layoutSource(doc, width, numbers) : layoutRendered(doc, width, numbers);
}

/**
 * The rendered row that shows 1-based source line `line`: the first row of
 * its block (each code line and table row has its own), proportionally
 * further down a block that spans many source lines (a long paragraph); a
 * blank line belongs to the block above it. Before the first block: 0.
 */
export function rowOfSourceLine(layout: DocumentLayout, line: number): number {
  const index = layout.lineIndex;
  let lo = 0;
  let hi = index.length - 1;
  let found: LineEntry | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = index[mid] as LineEntry;
    if (entry.line <= line) {
      found = entry;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found === undefined) return 0;
  const offset = line - found.line;
  if (offset >= found.lines) return found.row + found.rows - 1;
  return found.row + Math.min(found.rows - 1, Math.floor((offset * found.rows) / found.lines));
}

// ---------- painting ----------

interface Match {
  readonly unit: number;
  readonly start: number;
  readonly end: number;
}

interface Hit {
  readonly x: number;
  readonly width: number;
  readonly link: number;
}

const NO_MATCHES: ReadonlyMap<number, readonly Match[]> = new Map();

const overlaps = (run: Run, m: Match): boolean =>
  run.unit === m.unit && m.start < run.offset + run.text.length && m.end > run.offset;

/**
 * One row, exactly `width` cells: the margin (`▸` on the current match's
 * row), the decoration, the runs (matches in the search pair, underlined;
 * the current one bold; validated URLs as OSC 8), then padding.
 */
function paintRow(
  theme: ResolvedTheme,
  row: Row,
  width: number,
  matches: ReadonlyMap<number, readonly Match[]>,
  current: Match | null,
  marked: boolean,
  gutter: number,
): { text: string; hits: Hit[] } {
  const hits: Hit[] = [];
  let out = "";
  if (gutter > 0) {
    // The source line (dim, like the editor's gutter) on a block's first row; continuation rows stay blank.
    const label = row.line === undefined ? " ".repeat(gutter - 1) : String(row.line).padStart(gutter - 1);
    out += style(theme, "dim@bg", label) + style(theme, "text@bg", " ");
  }
  out += marked ? style(theme, "accent@bg", "▸") : style(theme, "text@bg", " ");
  let used = gutter + MARGIN;
  for (const part of row.prefix) {
    out += style(theme, part.pair, part.text, part.attrs);
    used += displayWidth(part.text);
  }
  let openUrl: SafeUrl | null = null;
  let linked = "";
  const emit = (styled: string, url: SafeUrl | null): void => {
    if (url !== openUrl) {
      if (openUrl !== null && linked !== "") out += hyperlink(openUrl, linked);
      linked = "";
      openUrl = url;
    }
    if (url === null) out += styled;
    else linked += styled;
  };
  for (const run of row.runs) {
    if (run.text === "") continue;
    const w = displayWidth(run.text);
    const url = run.url ?? null;
    const found = run.unit >= 0 ? (matches.get(run.unit) ?? []).filter(m => overlaps(run, m)) : [];
    if (found.length === 0) emit(style(theme, run.pair, run.text, run.attrs), url);
    else {
      let at = 0;
      for (const m of found) {
        const from = Math.max(0, m.start - run.offset);
        const to = Math.min(run.text.length, m.end - run.offset);
        if (from > at) emit(style(theme, run.pair, run.text.slice(at, from), run.attrs), url);
        const isCurrent = current !== null && current.unit === m.unit && current.start === m.start;
        emit(style(theme, "text@search", run.text.slice(from, to), { underline: true, bold: isCurrent }), url);
        at = to;
      }
      if (at < run.text.length) emit(style(theme, run.pair, run.text.slice(at), run.attrs), url);
    }
    if (run.link !== undefined) hits.push({ x: used, width: w, link: run.link });
    used += w;
  }
  emit("", null);
  if (used < width) out += style(theme, row.fill, " ".repeat(width - used));
  return { text: out, hits };
}

/** A row under a VISUAL selection: clusters [from, to) are selected; `cursor` is the cursor's cluster (or null). */
interface RowSelection {
  readonly from: number;
  readonly to: number;
  readonly cursor: number | null;
}

/** A row's visible content (decoration, then runs) as grapheme clusters, segmented piece by piece. */
function rowClusters(row: Row): string[] {
  const out: string[] = [];
  for (const text of [...row.prefix.map(p => p.text), ...row.runs.map(r => r.text)]) {
    for (const { segment } of graphemes.segment(text)) out.push(segment);
  }
  return out;
}

/**
 * paintRow for a row under a VISUAL selection: the selected clusters in the
 * selection pair PLUS inverse (visible without color), the cursor as an
 * underlined hole in it, an empty row as one selected cell. Search matches
 * give way to the selection on these rows; links stay links.
 */
function paintSelectedRow(
  theme: ResolvedTheme,
  row: Row,
  width: number,
  marked: boolean,
  gutter: number,
  selection: RowSelection,
): { text: string; hits: Hit[] } {
  const hits: Hit[] = [];
  let out = "";
  if (gutter > 0) {
    const label = row.line === undefined ? " ".repeat(gutter - 1) : String(row.line).padStart(gutter - 1);
    out += style(theme, "dim@bg", label) + style(theme, "text@bg", " ");
  }
  out += marked ? style(theme, "accent@bg", "▸") : style(theme, "text@bg", " ");
  let used = gutter + MARGIN;
  let index = 0;
  let openUrl: SafeUrl | null = null;
  let linked = "";
  const emit = (styled: string, url: SafeUrl | null): void => {
    if (url !== openUrl) {
      if (openUrl !== null && linked !== "") out += hyperlink(openUrl, linked);
      linked = "";
      openUrl = url;
    }
    if (url === null) out += styled;
    else linked += styled;
  };
  const stateOf = (i: number): 0 | 1 | 2 =>
    i === selection.cursor ? 2 : i >= selection.from && i < selection.to ? 1 : 0;
  const piece = (text: string, pair: ContrastPair, attrs: StyleAttributes | undefined, url: SafeUrl | null): void => {
    let chunk = "";
    let state: 0 | 1 | 2 = 0;
    const flush = (): void => {
      if (chunk === "") return;
      const styled =
        state === 0
          ? style(theme, pair, chunk, attrs)
          : state === 1
            ? style(theme, "text@selection", chunk, { ...attrs, inverse: true })
            : style(theme, pair, chunk, { ...attrs, inverse: false, underline: true });
      emit(styled, url);
      chunk = "";
    };
    for (const { segment } of graphemes.segment(text)) {
      const next = stateOf(index);
      if (next !== state) flush();
      state = next;
      chunk += segment;
      index++;
    }
    flush();
  };
  for (const part of row.prefix) {
    piece(part.text, part.pair, part.attrs, null);
    used += displayWidth(part.text);
  }
  for (const run of row.runs) {
    if (run.text === "") continue;
    const w = displayWidth(run.text);
    piece(run.text, run.pair, run.attrs, run.url ?? null);
    if (run.link !== undefined) hits.push({ x: used, width: w, link: run.link });
    used += w;
  }
  emit("", null);
  if (index === 0 && used < width) {
    out +=
      selection.cursor === 0
        ? style(theme, "text@bg", " ", { underline: true })
        : style(theme, "text@selection", " ", { inverse: true });
    used++;
  }
  if (used < width) out += style(theme, row.fill, " ".repeat(width - used));
  return { text: out, hits };
}

/** Every row of a document (no viewport, no search): for tests and one-off renders. */
export function renderDocument(
  source: string,
  options: { taskId: number; width: number; theme: ResolvedTheme; sourceView?: boolean; numbers?: boolean },
): string[] {
  const doc = parseDocument(source, options.taskId);
  const layout = layoutDocument(doc, options.width, options.sourceView ?? false, options.numbers ?? false);
  return layout.rows.map(
    row => paintRow(options.theme, row, options.width, NO_MATCHES, null, false, layout.gutter).text,
  );
}

// ---------- places: where a document is read ----------

/** The farthest top row: the natural end, or the last heading at the top. */
function maxScroll(layout: DocumentLayout, height: number): number {
  const lastHeading = layout.headingRows.reduce((m, r) => Math.max(m, r), 0);
  return Math.max(0, layout.rows.length - height, lastHeading);
}

function placeIn(layout: DocumentLayout, top: number): DocumentPlace {
  let heading: string | null = null;
  let delta = 0;
  if (!layout.source) {
    for (let i = layout.headingRows.length - 1; i >= 0; i--) {
      const row = layout.headingRows[i];
      if (row !== undefined && row <= top) {
        heading = layout.doc.headings[i]?.id ?? null;
        delta = top - row;
        break;
      }
    }
  }
  const block = layout.rows[Math.min(top, layout.rows.length - 1)]?.top ?? -1;
  const span = layout.topSpans.get(block);
  return {
    heading,
    delta,
    top,
    block,
    blockDelta: span === undefined ? 0 : Math.max(0, top - span[0]),
    blockRows: span === undefined ? 1 : span[1] - span[0] + 1,
  };
}

/** The top row for a place: its heading (preferred when the text may have changed), else its block, else its row. */
function resolvePlace(layout: DocumentLayout, place: DocumentPlace, preferBlock: boolean): number {
  const byHeading = (): number | null => {
    if (layout.source || place.heading === null) return null;
    const i = layout.doc.headings.findIndex(h => h.id === place.heading);
    const row = i < 0 ? undefined : layout.headingRows[i];
    return row === undefined ? null : row + place.delta;
  };
  const byBlock = (): number | null => {
    const span = place.block < 0 ? undefined : layout.topSpans.get(place.block);
    if (span === undefined) return null;
    const rows = span[1] - span[0] + 1;
    return span[0] + Math.min(rows - 1, Math.round((place.blockDelta * rows) / Math.max(1, place.blockRows)));
  };
  const first = preferBlock ? (byBlock() ?? byHeading()) : (byHeading() ?? byBlock());
  return Math.max(0, first ?? place.top);
}

// ---------- the reader component ----------

interface TaskView {
  doc: ParsedDocument;
  layout: DocumentLayout | null;
  pending: { readonly heading: string } | { readonly place: DocumentPlace } | null;
}

/** The first row showing a match. */
function matchRow(layout: DocumentLayout, m: Match): number {
  for (const r of layout.rowsByUnit.get(m.unit) ?? []) {
    if (layout.rows[r]?.runs.some(run => overlaps(run, m))) return r;
  }
  return layout.rowsByUnit.get(m.unit)?.[0] ?? 0;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The motions of a VISUAL selection in the rendered document (the shell maps keys to them). */
export type SelectionMotion =
  | "down"
  | "up"
  | "left"
  | "right"
  | "half-down"
  | "half-up"
  | "page-down"
  | "page-up"
  | "top"
  | "bottom"
  | "line-start"
  | "line-end"
  | "word-next"
  | "word-prev"
  | "word-end";

interface Place {
  readonly row: number;
  readonly col: number;
}

/** A place in the rendered document (the mouse's): a layout row and a cluster of its visible text. */
export type ReaderPoint = Place;

/** A VISUAL selection over one layout's rows: `col` is a cluster of the row's visible text. */
interface ReaderSelection {
  readonly taskId: number;
  readonly layout: DocumentLayout;
  kind: VisualKind;
  anchor: Place;
  cursor: Place;
  /** The display column vertical motions aim for. */
  goal: number | null;
}

const ordered = (a: Place, b: Place): [Place, Place] =>
  a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
const MAX_VIEWS = 64;
const DEFAULT_WIDTH = 80;

/** The editor cursor the Split preview follows (the shell sets `Reader.editorCursor` before each preview render). */
export interface EditorCursor {
  /** The cursor's 1-based source line. */
  readonly line: number;
  /** The cursor's row on the editor's screen: the preview puts that line's block on the same row. */
  readonly row: number;
  /** The editor state: a new value after every cursor move or edit. */
  readonly anchor: unknown;
}

/** The document pane's reader for one session (the shell sets `height` before each render). */
export class Reader implements Component {
  /** Rows to fill. */
  height = 0;
  /**
   * Split: the editor cursor to follow (null in Read). The preview scrolls so
   * the cursor line's block sits beside the editor's cursor row; a scroll or
   * a jump in the preview detaches it until the cursor moves (a new anchor).
   */
  editorCursor: EditorCursor | null = null;
  /** The task the preview follows for, the scroll it last set, and the anchor it was detached at. */
  #tracking: { taskId: number; top: number; detached: { anchor: unknown } | null } | null = null;
  readonly #session: TuiSession;
  readonly #views = new Map<number, TaskView>();
  #width = DEFAULT_WIDTH;
  #shown = 10;
  #source = false;
  #query = "";
  #current: { taskId: number; source: boolean; match: Match } | null = null;
  #matchMemo: { units: readonly string[]; query: string; list: Match[]; byUnit: Map<number, Match[]> } | null = null;
  #hits: (Hit & { y: number })[] = [];
  #hitDoc: ParsedDocument | null = null;
  #selection: ReaderSelection | null = null;
  #clusters = new WeakMap<Row, readonly string[]>();
  /** The last render's scroll position (the shell paints the body's scrollbar from it). */
  #position: ScrollPosition = { top: 0, total: 0 };

  constructor(session: TuiSession) {
    this.#session = session;
  }

  invalidate(): void {}

  // ---------- rendering ----------

  render(width: number): string[] {
    const s = this.#session;
    const theme = s.theme;
    const height = Math.max(0, Math.floor(this.height));
    this.#hits = [];
    this.#position = { top: 0, total: 0 };
    if (theme === null) return Array.from({ length: height }, () => "");
    const blank = (): string => style(theme, "text@bg", " ".repeat(Math.max(0, width)));
    const task = s.selectedTask();
    if (task === null || height === 0) return Array.from({ length: height }, blank);
    this.#width = width;
    this.#shown = height;
    const view = this.#view(task.id);
    const follow = this.#track(task.id, view);
    const layout = this.#layout(view, width);
    this.#settle(view, layout, height);
    if (follow !== null) this.#follow(task.id, layout, follow, height);
    const top = s.docScroll(task.id);
    this.#position = { top, total: layout.rows.length };
    const { byUnit } = this.#matches(layout);
    const current = this.#currentMatch(task.id, layout);
    const marked = current === null ? -1 : matchRow(layout, current);
    const out: string[] = [];
    this.#hitDoc = view.doc;
    const selection = this.#live();
    for (let i = 0; i < height; i++) {
      const row = layout.rows[top + i];
      if (row === undefined) {
        out.push(blank());
        continue;
      }
      const selected = selection === null ? null : this.#rowSelection(selection, top + i);
      const painted =
        selected === null
          ? paintRow(theme, row, width, byUnit, current, top + i === marked, layout.gutter)
          : paintSelectedRow(theme, row, width, top + i === marked, layout.gutter, selected);
      for (const hit of painted.hits) this.#hits.push({ ...hit, y: i });
      out.push(painted.text);
    }
    return out;
  }

  /** The last render's first row and the rendered document's rows ({0, 0} without a task). */
  scrollPosition(): ScrollPosition {
    return this.#position;
  }

  /** A click on a link or reference follows it; anything else is the caller's (coordinates relative to the pane). */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "click") this.#selection = null; // a click ends VISUAL
    if (event.type !== "click" || event.button !== "left") return undefined;
    const hit = this.#hits.find(h => h.y === event.y && event.x >= h.x && event.x < h.x + h.width);
    const link = hit === undefined ? undefined : this.#hitDoc?.links[hit.link];
    if (link === undefined) return undefined;
    this.follow(link.target);
    return { handled: true };
  }

  // ---------- the current document ----------

  /** The current task's headings (web anchors), in order. */
  headings(): readonly ReaderHeading[] {
    const task = this.#session.selectedTask();
    return task === null ? [] : this.#view(task.id).doc.headings;
  }

  /** The current task's links and prose references, in order. */
  links(): readonly ReaderLink[] {
    const task = this.#session.selectedTask();
    return task === null ? [] : this.#view(task.id).doc.links;
  }

  /** The current task's code blocks, numbered as their captions show. */
  codeBlocks(): readonly ReaderCodeBlock[] {
    const task = this.#session.selectedTask();
    return task === null ? [] : this.#view(task.id).doc.codeBlocks;
  }

  /** The first code block on screen (rendered view), or null. */
  codeBlockInView(): ReaderCodeBlock | null {
    const task = this.#session.selectedTask();
    if (task === null) return null;
    const { view, layout } = this.#ensure(task.id);
    if (layout.source) return null;
    const top = this.#session.docScroll(task.id);
    const at = layout.codeSpans.findIndex(span => span !== undefined && span[1] >= top && span[0] < top + this.#shown);
    return at < 0 ? null : (view.doc.codeBlocks[at] ?? null);
  }

  /** The heading of the section at the top of the view (rendered view), with its position among the headings. */
  section(): { readonly heading: ReaderHeading | null; readonly index: number; readonly count: number } | null {
    const task = this.#session.selectedTask();
    if (task === null) return null;
    const view = this.#views.get(task.id);
    const layout = view?.layout ?? null;
    if (view === undefined || layout === null || layout.source || view.doc.headings.length === 0) return null;
    const top = this.#session.docScroll(task.id);
    let index = -1;
    layout.headingRows.forEach((row, i) => {
      if (row <= top) index = i;
    });
    return { heading: index < 0 ? null : (view.doc.headings[index] ?? null), index, count: view.doc.headings.length };
  }

  // ---------- navigation ----------

  /** `}` (delta > 0) / `{`: the next or previous heading, `|delta|` of them (a jump :back returns from). */
  stepHeading(delta: number): void {
    const s = this.#session;
    const task = s.selectedTask();
    if (task === null || delta === 0) return;
    const { layout } = this.#ensure(task.id);
    const rows = [...layout.headingRows].sort((a, b) => a - b);
    if (rows.length === 0) {
      s.notify("info", `@${task.id} has no headings`);
      return;
    }
    const top = Math.min(s.docScroll(task.id), maxScroll(layout, this.#shown));
    let target: number | undefined;
    if (delta > 0) {
      const after = rows.filter(r => r > top);
      target = after[Math.min(delta, after.length) - 1];
      if (target === undefined) {
        s.notify("info", "No next heading");
        return;
      }
    } else {
      const before = rows.filter(r => r < top);
      target = before[Math.max(0, before.length + delta)];
      if (target === undefined) {
        s.notify("info", "No previous heading");
        return;
      }
    }
    s.recordJump();
    s.setDocScroll(task.id, target);
    s.redraw();
  }

  /**
   * `:heading <slug>`, a heading link, the outline: scroll the current task's
   * reader to that heading (a jump :back returns from), showing the rendered
   * document (from Edit, Read for this task only). False when there is none.
   */
  goToHeading(slug: string): boolean {
    const s = this.#session;
    const task = s.selectedTask();
    if (task === null) return false;
    const view = this.#view(task.id);
    const heading = findHeading(view.doc, slug);
    if (heading === null) return false;
    s.recordJump();
    s.revealReader();
    if (this.#source) {
      this.#source = false;
      this.#current = null;
    }
    view.pending = { heading: heading.id };
    const layout = view.layout;
    if (layout !== null && !layout.source && layout.width === this.#width) this.#settle(view, layout, this.#shown);
    s.redraw();
    return true;
  }

  /** Follow a link or reference: @id jumps (clearing the filters), #tag filters, a heading link jumps, a web link is copied. */
  follow(target: ReaderTarget): void {
    const s = this.#session;
    try {
      switch (target.kind) {
        case "task":
          if (!s.tasks.some(t => t.id === target.id)) {
            s.notify("warn", `No task @${target.id}: that reference points to nothing`);
            return;
          }
          s.followTaskRef(target.id);
          return;
        case "tag":
          s.followTagRef(target.name);
          s.notify("info", `The tag filter is #${target.name} now (:clear clears it)`);
          return;
        case "heading": {
          const task = s.selectedTask();
          if (target.id === null || !this.goToHeading(target.id)) {
            s.notify("warn", `No heading #${target.fragment} in @${task?.id ?? "?"}`);
          }
          return;
        }
        case "url":
          s.copyText(target.url, `the link ${target.url}`);
          return;
        case "inert":
          s.notify(
            "info",
            `Not followed: ${target.destination === "" ? "the link has no destination" : `${target.destination} is not an http, https or mailto link`}`,
          );
          return;
      }
    } catch (err) {
      s.notify("error", err instanceof Error ? err.message : String(err));
    }
  }

  // ---------- search ----------

  /** The document search (`/` while the reader has the focus); "" when there is none. */
  get query(): string {
    return this.#query;
  }

  /** The search's state for the current task: the match shown (1-based, 0: none yet) and how many there are. */
  searchStatus(): { readonly query: string; readonly index: number; readonly count: number } | null {
    const task = this.#session.selectedTask();
    if (this.#query === "" || task === null) return null;
    const view = this.#views.get(task.id);
    if (view?.layout == null) return null;
    const { list } = this.#matches(view.layout);
    const current = this.#currentMatch(task.id, view.layout);
    const index = current === null ? 0 : list.findIndex(m => m.unit === current.unit && m.start === current.start) + 1;
    return { query: this.#query, index, count: list.length };
  }

  /** Search the rendered text (case-insensitive) from the top of the view; an empty search clears it. */
  search(text: string): void {
    const s = this.#session;
    this.#query = escapeTerminalText(text.replace(/[\r\n]+/g, " ").trim());
    this.#current = null;
    if (this.#query === "") {
      s.notify("info", "Document search cleared");
      s.redraw();
      return;
    }
    const task = s.selectedTask();
    if (task === null) return;
    const { layout } = this.#ensure(task.id);
    const { list } = this.#matches(layout);
    if (list.length === 0) {
      s.notify("info", `No match for /${this.#query} in @${task.id}`);
      s.redraw();
      return;
    }
    const top = s.docScroll(task.id);
    const index = list.findIndex(m => matchRow(layout, m) >= top);
    this.#goto(task.id, layout, list, index < 0 ? 0 : index, index < 0 ? " (from the top)" : "");
  }

  /** n / N: the next or previous match, `|delta|` of them, wrapping at the ends. */
  step(delta: number): void {
    const s = this.#session;
    if (this.#query === "") {
      s.notify("info", "No search in the document: / searches it, then n and N step through the matches");
      return;
    }
    const task = s.selectedTask();
    if (task === null || delta === 0) return;
    const { layout } = this.#ensure(task.id);
    const { list } = this.#matches(layout);
    const n = list.length;
    if (n === 0) {
      s.notify("info", `No match for /${this.#query} in @${task.id}`);
      return;
    }
    const current = this.#currentMatch(task.id, layout);
    let at = current === null ? -1 : list.findIndex(m => m.unit === current.unit && m.start === current.start);
    let steps = delta;
    if (at < 0) {
      // No match shown yet: the first step lands on the nearest one in that direction from the top.
      const top = s.docScroll(task.id);
      const after = list.findIndex(m => matchRow(layout, m) >= top);
      at = delta > 0 ? (after < 0 ? n : after) - 1 : after < 0 ? n : after;
    }
    const raw = at + steps;
    steps = ((raw % n) + n) % n;
    const note = raw >= n ? " (wrapped to the first)" : raw < 0 ? " (wrapped to the last)" : "";
    this.#goto(task.id, layout, list, steps, note);
  }

  #goto(taskId: number, layout: DocumentLayout, list: readonly Match[], index: number, note: string): void {
    const s = this.#session;
    const match = list[index];
    if (match === undefined) return;
    this.#current = { taskId, source: layout.source, match };
    const row = matchRow(layout, match);
    const top = s.docScroll(taskId);
    if (row < top || row >= top + this.#shown) {
      s.setDocScroll(taskId, Math.max(0, row - Math.min(2, Math.floor(this.#shown / 3))));
    }
    s.notify("info", `/${this.#query}: match ${index + 1} of ${list.length}${note}`);
    s.redraw();
  }

  #currentMatch(taskId: number, layout: DocumentLayout): Match | null {
    const c = this.#current;
    return c !== null && c.taskId === taskId && c.source === layout.source ? c.match : null;
  }

  #matches(layout: DocumentLayout): { list: Match[]; byUnit: Map<number, Match[]> } {
    const memo = this.#matchMemo;
    if (memo !== null && memo.units === layout.units && memo.query === this.#query) return memo;
    const list: Match[] = [];
    const byUnit = new Map<number, Match[]>();
    if (this.#query !== "") {
      const re = new RegExp(escapeRegExp(this.#query), "giu");
      layout.units.forEach((text, unit) => {
        for (const m of text.matchAll(re)) {
          const match = { unit, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
          list.push(match);
          const entry = byUnit.get(unit);
          if (entry === undefined) byUnit.set(unit, [match]);
          else entry.push(match);
        }
      });
    }
    this.#matchMemo = { units: layout.units, query: this.#query, list, byUnit };
    return this.#matchMemo;
  }

  // ---------- VISUAL: selecting the rendered text ----------

  /** VISUAL `v`/`V`: select from the top row on screen, or change a live selection's kind. False without a task. */
  select(kind: VisualKind): boolean {
    const s = this.#session;
    const task = s.selectedTask();
    if (task === null) return false;
    const live = this.#live();
    if (live !== null) live.kind = kind;
    else {
      const { layout } = this.#ensure(task.id);
      const top = Math.max(0, Math.min(s.docScroll(task.id), layout.rows.length - 1));
      const at = { row: top, col: 0 };
      this.#selection = { taskId: task.id, layout, kind, anchor: at, cursor: at, goal: null };
    }
    s.redraw();
    return true;
  }

  /**
   * The rendered place at cell (x, y) of the pane as the last render drew it:
   * a cell above or below the rows on screen takes the first or last of them,
   * one left of the text its first cluster, one past it its last. Null
   * without a task or rows.
   */
  pointAt(x: number, y: number): ReaderPoint | null {
    const s = this.#session;
    const task = s.selectedTask();
    if (task === null) return null;
    const layout = this.#views.get(task.id)?.layout ?? null;
    if (layout === null || layout.rows.length === 0) return null;
    const top = s.docScroll(task.id);
    const last = Math.max(0, Math.min(layout.rows.length - 1, top + Math.max(1, this.#shown) - 1));
    const row = Math.max(Math.min(top, last), Math.min(last, top + y));
    const probe: ReaderSelection = {
      taskId: task.id,
      layout,
      kind: "char",
      anchor: { row, col: 0 },
      cursor: { row, col: 0 },
      goal: null,
    };
    return { row, col: this.#colAt(probe, row, Math.max(0, x - layout.gutter - MARGIN)) };
  }

  /** A mouse selection: VISUAL of `kind` from `anchor` to `cursor` (both included). False without the current layout. */
  selectRange(kind: VisualKind, anchor: ReaderPoint, cursor: ReaderPoint): boolean {
    const task = this.#session.selectedTask();
    const layout = task === null ? null : (this.#views.get(task.id)?.layout ?? null);
    if (task === null || layout === null) return false;
    this.#selection = { taskId: task.id, layout, kind, anchor, cursor, goal: null };
    this.#session.redraw();
    return true;
  }

  /** A double click: VISUAL over the word (or the run of blanks or punctuation) at `point`. */
  selectWord(point: ReaderPoint): boolean {
    if (!this.selectRange("char", point, point)) return false;
    const selection = this.#selection as ReaderSelection;
    const { first, last } = wordAt(this.#rowClusters(point.row, selection), point.col);
    selection.anchor = { row: point.row, col: first };
    selection.cursor = { row: point.row, col: last };
    return true;
  }

  /** The live selection's kind: the current task's, on the layout it was made on; else null. */
  selecting(): VisualKind | null {
    return this.#live()?.kind ?? null;
  }

  endSelection(): void {
    if (this.#selection === null) return;
    this.#selection = null;
    this.#session.redraw();
  }

  moveSelection(motion: SelectionMotion, count = 1): void {
    const selection = this.#live();
    if (selection === null) return;
    const rows = selection.layout.rows;
    const n = Math.max(1, count);
    const lastRow = Math.max(0, rows.length - 1);
    const lastCol = (row: number): number => Math.max(0, this.#rowClusters(row, selection).length - 1);
    let { row, col } = selection.cursor;
    let goal: number | null = null;
    const vertically = (delta: number): void => {
      goal = selection.goal ?? this.#cellsBefore(selection, row, col);
      row = Math.max(0, Math.min(lastRow, row + delta));
      col = this.#colAt(selection, row, goal);
    };
    const half = Math.max(1, Math.floor(this.#shown / 2));
    switch (motion) {
      case "down":
        vertically(n);
        break;
      case "up":
        vertically(-n);
        break;
      case "half-down":
        vertically(half * n);
        break;
      case "half-up":
        vertically(-half * n);
        break;
      case "page-down":
        vertically(Math.max(1, this.#shown) * n);
        break;
      case "page-up":
        vertically(-Math.max(1, this.#shown) * n);
        break;
      case "left":
        col = Math.max(0, col - n);
        break;
      case "right":
        col = Math.min(lastCol(row), col + n);
        break;
      case "top":
        row = 0;
        col = 0;
        break;
      case "bottom":
        row = lastRow;
        col = 0;
        break;
      case "line-start":
        col = 0;
        break;
      case "line-end":
        col = lastCol(row);
        break;
      case "word-next":
      case "word-prev":
      case "word-end": {
        const lines: ClusterLines = { count: rows.length, clusters: r => this.#rowClusters(r, selection) };
        const step = motion === "word-next" ? wordNext : motion === "word-prev" ? wordPrev : wordEnd;
        let place = { line: row, col };
        for (let i = 0; i < n; i++) place = step(lines, place);
        row = place.line;
        col = Math.min(place.col, lastCol(row));
        break;
      }
    }
    selection.cursor = { row, col };
    selection.goal = goal;
    this.#reveal(selection);
    this.#session.redraw();
  }

  /** VISUAL `o`: the cursor goes to the other end. */
  swapSelectionEnds(): void {
    const selection = this.#live();
    if (selection === null) return;
    [selection.anchor, selection.cursor] = [selection.cursor, selection.anchor];
    selection.goal = null;
    this.#reveal(selection);
    this.#session.redraw();
  }

  /**
   * The selected text as shown: the visible characters of the rendered rows
   * (escaped already, so no SGR, OSC 8 or other control byte), each row's
   * trailing padding trimmed, rows joined by line breaks; VISUAL LINE ends
   * with one. Null without a live selection.
   */
  selectedText(): { text: string; linewise: boolean; rows: number } | null {
    const selection = this.#live();
    if (selection === null) return null;
    const [start, end] = ordered(selection.anchor, selection.cursor);
    const lines: string[] = [];
    for (let row = start.row; row <= end.row; row++) {
      const clusters = this.#rowClusters(row, selection);
      const part = this.#rowSelection(selection, row) ?? { from: 0, to: 0 };
      const text = clusters.slice(part.from, part.to).join("");
      lines.push(part.to >= clusters.length ? text.trimEnd() : text);
    }
    const linewise = selection.kind === "line";
    return { text: lines.join("\n") + (linewise ? "\n" : ""), linewise, rows: end.row - start.row + 1 };
  }

  /** The selection when it is still the current task's, on its current layout; a stale one is dropped. */
  #live(): ReaderSelection | null {
    const selection = this.#selection;
    if (selection === null) return null;
    const task = this.#session.selectedTask();
    if (task?.id === selection.taskId && this.#views.get(task.id)?.layout === selection.layout) return selection;
    this.#selection = null;
    return null;
  }

  #rowClusters(row: number, selection: ReaderSelection): readonly string[] {
    const found = selection.layout.rows[row];
    if (found === undefined) return [];
    let clusters = this.#clusters.get(found);
    if (clusters === undefined) {
      clusters = rowClusters(found);
      this.#clusters.set(found, clusters);
    }
    return clusters;
  }

  /** What of row `row` the selection covers (null: nothing), and the cursor's cluster on it. */
  #rowSelection(selection: ReaderSelection, row: number): RowSelection | null {
    const [start, end] = ordered(selection.anchor, selection.cursor);
    if (row < start.row || row > end.row) return null;
    const count = this.#rowClusters(row, selection).length;
    const line = selection.kind === "line";
    return {
      from: line || row > start.row ? 0 : start.col,
      to: line || row < end.row ? count : end.col + 1,
      cursor: row === selection.cursor.row ? selection.cursor.col : null,
    };
  }

  #cellsBefore(selection: ReaderSelection, row: number, col: number): number {
    let cells = 0;
    for (const cluster of this.#rowClusters(row, selection).slice(0, col)) cells += displayWidth(cluster);
    return cells;
  }

  /** The cluster of `row` at display column `cells` (its last one when the row is shorter). */
  #colAt(selection: ReaderSelection, row: number, cells: number): number {
    const clusters = this.#rowClusters(row, selection);
    let used = 0;
    for (let i = 0; i < clusters.length; i++) {
      const w = displayWidth(clusters[i] as string);
      if (cells < used + Math.max(1, w)) return i;
      used += w;
    }
    return Math.max(0, clusters.length - 1);
  }

  /** Scroll so the selection's cursor row is on screen. */
  #reveal(selection: ReaderSelection): void {
    const s = this.#session;
    const top = s.docScroll(selection.taskId);
    const row = selection.cursor.row;
    if (row < top) s.setDocScroll(selection.taskId, row);
    else if (row >= top + this.#shown) s.setDocScroll(selection.taskId, row - Math.max(1, this.#shown) + 1);
  }

  // ---------- source disclosure ----------

  /** :source is on: Read and the preview show the raw source. */
  get sourceView(): boolean {
    return this.#source;
  }

  toggleSource(): void {
    this.#source = !this.#source;
    this.#current = null;
    this.#session.redraw();
  }

  // ---------- places for the session's jump history ----------

  /** Where the task's document is read now (its last layout), for :back/:forward. */
  place(taskId: number): DocumentPlace {
    const layout = this.#views.get(taskId)?.layout ?? null;
    const top = this.#session.docScroll(taskId);
    return layout === null
      ? { heading: null, delta: 0, top, block: -1, blockDelta: 0, blockRows: 1 }
      : placeIn(layout, Math.min(top, Math.max(0, layout.rows.length - 1)));
  }

  /** Return the task's document to a remembered place (resolved against its layout when it is next shown). */
  restore(taskId: number, place: DocumentPlace): void {
    this.#session.setDocScroll(taskId, place.top);
    const view = this.#views.get(taskId);
    if (view !== undefined) view.pending = { place };
  }

  // ---------- internals ----------

  /** The task's parsed current text (its draft, else the saved body), reparsed only when it changed. */
  #view(taskId: number): TaskView {
    const s = this.#session;
    const task = s.tasks.find(t => t.id === taskId);
    const text = s.documentOf(taskId)?.draft?.text("body") ?? task?.body ?? "";
    let view = this.#views.get(taskId);
    if (view === undefined) {
      view = { doc: parseDocument(text, taskId), layout: null, pending: null };
      this.#views.set(taskId, view);
      if (this.#views.size > MAX_VIEWS) {
        const oldest = this.#views.keys().next().value;
        if (oldest !== undefined && oldest !== taskId) this.#views.delete(oldest);
      }
    } else if (view.doc.source !== text) view.doc = parseDocument(text, taskId);
    return view;
  }

  #ensure(taskId: number): { view: TaskView; layout: DocumentLayout } {
    const view = this.#view(taskId);
    return { view, layout: this.#layout(view, this.#width) };
  }

  /**
   * Split: whether the preview follows the editor this frame. A scroll or a
   * jump since the last frame (the scroll is not the one it set, or a jump
   * is pending) detaches it at the editor's current state; a new state (the
   * cursor moved, an edit) attaches it again. Read forgets it, so the next
   * Split starts by following.
   */
  #track(taskId: number, view: TaskView): EditorCursor | null {
    const follow = this.editorCursor;
    if (follow === null) {
      this.#tracking = null;
      return null;
    }
    const jumped = view.pending !== null || this.#session.pendingHeading()?.taskId === taskId;
    const t = this.#tracking;
    if (t === null || t.taskId !== taskId) {
      this.#tracking = { taskId, top: -1, detached: jumped ? { anchor: follow.anchor } : null };
    } else if (t.detached === null) {
      if (jumped || this.#session.docScroll(taskId) !== t.top) t.detached = { anchor: follow.anchor };
    } else if (t.detached.anchor !== follow.anchor) t.detached = null;
    return this.#tracking?.detached === null ? follow : null;
  }

  /** Scroll the preview so the cursor line's block is on the editor's cursor row (clamped to the content). */
  #follow(taskId: number, layout: DocumentLayout, follow: EditorCursor, height: number): void {
    const row = rowOfSourceLine(layout, follow.line);
    const aligned = row - Math.max(0, Math.min(follow.row, height - 1));
    const top = Math.max(0, Math.min(aligned, maxScroll(layout, height)));
    this.#session.setDocScroll(taskId, top);
    if (this.#tracking !== null) this.#tracking.top = top;
  }

  /** The layout for this width and view; a new one keeps the place the old one showed. */
  #layout(view: TaskView, width: number): DocumentLayout {
    const old = view.layout;
    const numbers = this.#session.lineNumbers;
    if (
      old !== null &&
      old.doc === view.doc &&
      old.width === width &&
      old.source === this.#source &&
      old.gutter > 0 === numbers
    ) {
      return old;
    }
    const next = layoutDocument(view.doc, width, this.#source, numbers);
    if (old !== null && view.pending === null) {
      const taskId = view.doc.taskId;
      const place = placeIn(old, this.#session.docScroll(taskId));
      this.#session.setDocScroll(taskId, resolvePlace(next, place, old.doc === view.doc));
    }
    view.layout = next;
    return next;
  }

  /** Apply the launch --heading, a pending jump or restore, and clamp the scroll to the content. */
  #settle(view: TaskView, layout: DocumentLayout, height: number): void {
    const s = this.#session;
    const taskId = view.doc.taskId;
    const launch = s.pendingHeading();
    if (launch !== null && launch.taskId === taskId) {
      s.takeHeading();
      const heading = findHeading(view.doc, launch.slug);
      if (heading === null) s.notify("warn", `No heading #${launch.slug} in @${taskId}`);
      else view.pending = { heading: heading.id };
    }
    const pending = view.pending;
    if (pending !== null) {
      view.pending = null;
      if ("heading" in pending) {
        const i = view.doc.headings.findIndex(h => h.id === pending.heading);
        const row = layout.source
          ? (layout.topSpans.get(view.doc.headings[i]?.top ?? -1)?.[0] ?? 0)
          : (layout.headingRows[i] ?? 0);
        s.setDocScroll(taskId, row);
      } else s.setDocScroll(taskId, resolvePlace(layout, pending.place, false));
    }
    s.setDocScroll(taskId, Math.min(s.docScroll(taskId), maxScroll(layout, height)));
  }
}

/** The reader of one session: registered with it (`:heading`, `/`, n/N, :back/:forward places). */
export function createReader(session: TuiSession): Reader {
  const reader = new Reader(session);
  session.attachReader(reader);
  return reader;
}
