// The one-line prompt (plan @400 N17): ONE component serves the `:` command
// line and `/` search.
//
// - Text and a grapheme-aligned cursor; the usual line-editing keys, plus
//   the Alt word motions keys.ts keeps intact inside text fields (Alt-b/f,
//   Alt/Ctrl-arrows) and word deletion (Ctrl-w to the previous blank,
//   Alt-Backspace to the previous word start).
// - Tab / Shift-Tab cycle through the completer's candidates for the TYPED
//   text: the first Tab computes them, further Tabs step through them, and
//   any other key makes the (new) text the prefix again.
// - Up / Down walk the history of this prompt kind, newest first, restricted
//   to entries starting with the text typed before the walk; walking past the
//   newest entry restores that unfinished line. Ctrl-P / Ctrl-N walk without
//   the prefix. Editing a recalled entry starts over.
// - Only the caller submits (Enter in keys.ts), so a pasted newline can never
//   run anything: pasted line breaks become spaces.
// Keys arrive as keys.ts key ids ("tab", "alt+b", "ctrl+w" ...).

export type CommandLineKind = ":" | "/";

export interface CommandLineOptions {
  /** This kind's history, oldest first; `submit()` appends (shared across openings). */
  readonly history: string[];
  /** Full-line candidates for the typed text; without one, Tab is inert. */
  readonly complete?: (line: string) => readonly string[];
  /** Initial text (the cursor starts at its end). */
  readonly initial?: string;
  /** Called after every change. */
  readonly onChange?: () => void;
  /** History length cap (default MAX_HISTORY). */
  readonly maxHistory?: number;
}

/** The candidates of the current completion cycle and the one shown. */
export interface Completion {
  readonly candidates: readonly string[];
  readonly index: number;
}

export interface CommandLine {
  readonly kind: CommandLineKind;
  readonly text: string;
  /** UTF-16 offset into `text`, always on a grapheme boundary. */
  readonly cursor: number;
  /** The active completion cycle, or null. */
  readonly completion: Completion | null;
  insert(text: string): void;
  /** A bracketed paste: inserted with line breaks as spaces, so it can never submit. */
  paste(text: string): void;
  /** Editing, completion and history keys; `cancel` when Backspace on an empty line closes the prompt. */
  key(key: string | null): "handled" | "cancel" | "ignored";
  /** Enter: remember the line (non-blank, not a repeat of the newest entry) and return it. */
  submit(): string;
}

export const MAX_HISTORY = 100;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });

const WORD_LEFT = new Set(["alt+b", "alt+shift+b", "alt+left", "ctrl+left"]);
const WORD_RIGHT = new Set(["alt+f", "alt+shift+f", "alt+right", "ctrl+right"]);

function previousBoundary(text: string, at: number): number {
  let last = 0;
  for (const { index } of graphemes.segment(text)) {
    if (index >= at) break;
    last = index;
  }
  return last;
}

function nextBoundary(text: string, at: number): number {
  for (const { index, segment } of graphemes.segment(text)) {
    if (index >= at) return index + segment.length;
  }
  return text.length;
}

/** Start of the word before `at` (or containing it). Word boundaries never split graphemes. */
function wordStart(text: string, at: number): number {
  let target = 0;
  for (const { index, isWordLike } of words.segment(text)) {
    if (index >= at) break;
    if (isWordLike) target = index;
  }
  return target;
}

/** End of the word after `at` (or containing it). */
function wordEnd(text: string, at: number): number {
  for (const { index, segment, isWordLike } of words.segment(text)) {
    const end = index + segment.length;
    if (isWordLike && end > at) return end;
  }
  return text.length;
}

class Line implements CommandLine {
  readonly kind: CommandLineKind;
  #text: string;
  #cursor: number;
  #completion: Completion | null = null;
  /** The history walk: position (history.length = the unfinished line) and that line. */
  #walk: { index: number; draft: string } | null = null;
  readonly #options: CommandLineOptions;

  constructor(kind: CommandLineKind, options: CommandLineOptions) {
    this.kind = kind;
    this.#options = options;
    this.#text = options.initial ?? "";
    this.#cursor = this.#text.length;
  }

  get text(): string {
    return this.#text;
  }

  get cursor(): number {
    return this.#cursor;
  }

  get completion(): Completion | null {
    return this.#completion;
  }

  insert(text: string): void {
    if (text === "") return;
    this.#edit(this.#text.slice(0, this.#cursor) + text + this.#text.slice(this.#cursor), this.#cursor + text.length);
  }

  paste(text: string): void {
    this.insert(text.replace(/\r\n|\r|\n/g, " "));
  }

  key(key: string | null): "handled" | "cancel" | "ignored" {
    const text = this.#text;
    const at = this.#cursor;
    if (key === "tab" || key === "shift+tab") {
      this.#complete(key === "tab" ? 1 : -1);
      return "handled";
    }
    if (key !== null && WORD_LEFT.has(key)) return this.#move(wordStart(text, at));
    if (key !== null && WORD_RIGHT.has(key)) return this.#move(wordEnd(text, at));
    switch (key) {
      case "up":
        return this.#older(true);
      case "ctrl+p":
        return this.#older(false);
      case "down":
        return this.#newer(true);
      case "ctrl+n":
        return this.#newer(false);
      case "backspace": {
        if (text === "") return "cancel";
        if (at === 0) return "handled";
        const from = previousBoundary(text, at);
        return this.#edit(text.slice(0, from) + text.slice(at), from);
      }
      case "delete":
        if (at >= text.length) return "handled";
        return this.#edit(text.slice(0, at) + text.slice(nextBoundary(text, at)), at);
      case "left":
      case "ctrl+b":
        return this.#move(at === 0 ? 0 : previousBoundary(text, at));
      case "right":
      case "ctrl+f":
        return this.#move(nextBoundary(text, at));
      case "home":
      case "ctrl+a":
        return this.#move(0);
      case "end":
      case "ctrl+e":
        return this.#move(text.length);
      case "ctrl+u":
        return this.#edit(text.slice(at), 0);
      case "ctrl+k":
        return this.#edit(text.slice(0, at), at);
      case "ctrl+w": {
        const before = text.slice(0, at).replace(/\S+\s*$/, "");
        return this.#edit(before + text.slice(at), before.length);
      }
      case "alt+backspace": {
        const from = wordStart(text, at);
        return this.#edit(text.slice(0, from) + text.slice(at), from);
      }
      default:
        return "ignored";
    }
  }

  submit(): string {
    const text = this.#text;
    const entry = text.trim();
    const history = this.#options.history;
    if (entry !== "" && history[history.length - 1] !== entry) {
      history.push(entry);
      const max = this.#options.maxHistory ?? MAX_HISTORY;
      if (history.length > max) history.splice(0, history.length - max);
    }
    return text;
  }

  /** A text change: the new text is the completion prefix again and ends any history walk. */
  #edit(text: string, cursor: number): "handled" {
    this.#completion = null;
    this.#walk = null;
    this.#set(text, cursor);
    return "handled";
  }

  #move(cursor: number): "handled" {
    this.#completion = null;
    this.#set(this.#text, cursor);
    return "handled";
  }

  #set(text: string, cursor: number): void {
    if (text === this.#text && cursor === this.#cursor) return;
    this.#text = text;
    this.#cursor = cursor;
    this.#options.onChange?.();
  }

  #complete(step: 1 | -1): void {
    const complete = this.#options.complete;
    if (complete === undefined) return;
    let completion = this.#completion;
    if (completion === null) {
      const candidates = [...complete(this.#text)];
      if (candidates.length === 0) return;
      completion = { candidates, index: step === 1 ? 0 : candidates.length - 1 };
    } else {
      const n = completion.candidates.length;
      completion = { candidates: completion.candidates, index: (completion.index + step + n) % n };
    }
    const chosen = completion.candidates[completion.index] ?? this.#text;
    this.#walk = null;
    this.#completion = completion;
    // Reported even when the text is unchanged: the shown candidate moved.
    this.#text = chosen;
    this.#cursor = chosen.length;
    this.#options.onChange?.();
  }

  #older(filtered: boolean): "handled" {
    const history = this.#options.history;
    const walk = (this.#walk ??= { index: history.length, draft: this.#text });
    const prefix = filtered ? walk.draft : "";
    for (let i = walk.index - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry?.startsWith(prefix)) {
        walk.index = i;
        this.#recall(entry);
        break;
      }
    }
    return "handled";
  }

  #newer(filtered: boolean): "handled" {
    const walk = this.#walk;
    if (walk === null) return "handled";
    const history = this.#options.history;
    const prefix = filtered ? walk.draft : "";
    for (let i = walk.index + 1; i < history.length; i++) {
      const entry = history[i];
      if (entry?.startsWith(prefix)) {
        walk.index = i;
        this.#recall(entry);
        return "handled";
      }
    }
    walk.index = history.length;
    this.#recall(walk.draft);
    return "handled";
  }

  #recall(text: string): void {
    this.#completion = null;
    this.#set(text, text.length);
  }
}

/** A `:` command line or `/` search prompt over `options.history`. */
export function createCommandLine(kind: CommandLineKind, options: CommandLineOptions): CommandLine {
  return new Line(kind, options);
}
