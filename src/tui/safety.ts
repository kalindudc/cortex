// The ONE terminal rendering boundary for untrusted text.
//
// Every title, body, update, catalog name, author and error string passes
// through here before it reaches the terminal: C0/DEL (caret notation, e.g.
// ESC → `^[`), C1 and bidi controls (`<U+009B>`) become visible text, so no
// CSI/OSC/DCS/APC sequence (clipboard, hyperlink, title, graphics) can ever
// execute. Printable Unicode, graphemes and widths are preserved. Callers
// keep the raw source separately; theme styles (src/tui/theme.ts) and links
// are applied only to escaped text. URLs are validated before any OSC 8 or
// opener; OSC 52 clipboard writes are explicit and never reported as confirmed.

import { visibleWidth } from "@earendil-works/pi-tui";

// C0, DEL, C1, bidi embedding/override/isolate controls and lone surrogates.
const UNSAFE =
  /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function visible(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code < 0x20) return `^${String.fromCharCode(code + 0x40)}`;
  if (code === 0x7f) return "^?";
  if (code >= 0xd800 && code <= 0xdfff) return "\ufffd";
  return `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
}

/**
 * Escape untrusted text for one terminal line. Every control character,
 * including tab and line breaks, becomes visible text; printable Unicode is
 * unchanged. The result is safe to style and to measure with displayWidth.
 */
export function escapeTerminalText(text: string): string {
  return text.replace(UNSAFE, visible);
}

/**
 * Escape an untrusted multi-line body: split on CRLF, LF or a lone CR
 * (CommonMark line endings), expand tabs to `tabWidth` stops by display
 * width, then escape each line.
 */
export function escapeTerminalLines(text: string, tabWidth = 4): string[] {
  return text.split(/\r\n|\n|\r/).map(line => {
    if (!line.includes("\t")) return escapeTerminalText(line);
    let out = "";
    for (const part of line.split(/(\t)/)) {
      if (part === "\t") out += " ".repeat(tabWidth - (displayWidth(out) % tabWidth));
      else out += escapeTerminalText(part);
    }
    return out;
  });
}

/** Terminal cells occupied by already-escaped text (graphemes, East Asian width, emoji). */
export function displayWidth(text: string): number {
  return visibleWidth(text);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Already-escaped text cut to `width` cells at a grapheme boundary, ending in "\u2026" when it had to be cut. */
export function fitWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const w = displayWidth(segment);
    if (used + w > width - 1) break;
    out += segment;
    used += w;
  }
  return `${out}\u2026`;
}

// ---------- URLs ----------

/** A URL that passed `safeUrl`: http(s) or mailto, no credentials, printable ASCII. */
export type SafeUrl = string & { readonly __safeUrl: unique symbol };

const MAX_URL_LENGTH = 2048;
// Controls, bidi controls and invisible characters that URL parsers strip,
// ignore or map away (so the shown URL would differ from the opened one).
const URL_FORBIDDEN = /[\x00-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/**
 * Validate a URL before any OSC 8 hyperlink or opener: http, https or
 * mailto only; absolute; no username or password; no control, bidi or
 * invisible characters and no surrounding whitespace in the raw text.
 * Returns the normalized href (IDN hosts in punycode, other non-ASCII
 * percent-encoded), or null.
 */
export function safeUrl(raw: string): SafeUrl | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  if (URL_FORBIDDEN.test(raw) || raw.trim() !== raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "mailto:" ? url.pathname === "" : url.hostname === "") return null;
  const href = url.href;
  if (href.length > MAX_URL_LENGTH || !/^[\x21-\x7e]+$/.test(href)) return null;
  return href as SafeUrl;
}

// Content may only carry SGR styling produced by src/tui/theme.ts.
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * OSC 8 hyperlink around content that is already escaped (and optionally
 * styled). Throws for a URL that `safeUrl` did not produce, or for content
 * holding any control other than SGR.
 */
export function hyperlink(url: SafeUrl, content: string): string {
  if (safeUrl(url) !== url) throw new Error("hyperlink() needs a URL validated by safeUrl()");
  if (/[\x00-\x1f\x7f-\x9f]/.test(content.replace(SGR, ""))) {
    throw new Error("hyperlink() needs content escaped by escapeTerminalText() first");
  }
  return `\x1b]8;;${url}\x1b\\${content}\x1b]8;;\x1b\\`;
}

// ---------- clipboard ----------

export type ClipboardResult =
  /** Written; terminals never acknowledge OSC 52, so the copy is unconfirmed. */
  { status: "unconfirmed"; bytes: number } | { status: "failed"; reason: string };

const DEFAULT_MAX_CLIPBOARD_BYTES = 75_000;

/**
 * Explicit clipboard write via OSC 52 (an opt-in user action, never a
 * rendering effect). The text is base64-encoded, so it cannot break out of
 * the sequence; nothing ever queries the clipboard. The result is
 * "unconfirmed" at best: the terminal may ignore or cap OSC 52 silently.
 */
export function osc52Copy(
  text: string,
  write: (data: string) => void,
  options: { maxBytes?: number } = {},
): ClipboardResult {
  const bytes = Buffer.byteLength(text, "utf8");
  const max = options.maxBytes ?? DEFAULT_MAX_CLIPBOARD_BYTES;
  if (bytes > max)
    return { status: "failed", reason: `too large for a terminal clipboard write (${bytes} > ${max} bytes)` };
  try {
    write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x1b\\`);
  } catch (err) {
    return { status: "failed", reason: `clipboard write failed: ${(err as Error).message}` };
  }
  return { status: "unconfirmed", bytes };
}
