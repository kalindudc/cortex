// The terminal mouse (optional, on by default, `mouse = false` in tui.toml
// turns it off, and never the only path to an action).
//
// - The shell enables button-event tracking (DECSET 1002: presses, releases
//   and motion while a button is held, so drags) in SGR encoding (1006) after
//   the toolkit took the terminal, and disables it on EVERY path that gives
//   the terminal back (quit, signals, crash, suspend, a handed-off program);
//   TERMINAL_RESET repeats MOUSE_OFF. Any-motion tracking (1003) is never
//   asked for: nothing here follows a hovering pointer.
// - parseMouse is the ONE parser of what the terminal reports: SGR press,
//   release, drag and wheel with the shift/alt/ctrl modifiers. Every other
//   mouse report (horizontal wheel, the extra buttons 8-11, motion without a
//   button, zero or absurd cells, malformed reports, the legacy X10
//   encoding) is ignored: filterMouseInput drops it before the toolkit reads
//   it, so an unsupported report can never be guessed into a click.
// - Routing (which pane is under the pointer, clicks and their counts,
//   drags) is the shell's (src/tui/app.ts) over the toolkit's dispatch.
// - One wheel notch may arrive as several reports (WheelNotches): every pane
//   steps once a notch, and a step moves tui.toml's `scroll` rows or items
//   (a form, one field).

import type { Terminal } from "@earendil-works/pi-tui";

/** Button-event tracking with drag (1002) in SGR encoding (1006). */
export const MOUSE_ON = "\x1b[?1002h\x1b[?1006h";
/** Off: the SGR encoding, then every tracking mode (also those another program may have left on). */
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

export type MouseButton = "left" | "middle" | "right" | "none";

/** One supported report; cells are zero-based. */
export interface MouseReport {
  readonly kind: "press" | "release" | "drag" | "wheel";
  readonly button: MouseButton;
  readonly x: number;
  readonly y: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  /** The wheel: -1 up, 1 down. */
  readonly wheel?: -1 | 1;
}

/** A mouse report this terminal UI does not support: dropped, with why. */
export interface IgnoredMouse {
  readonly kind: "ignored";
  readonly reason: string;
}

const BUTTONS: readonly MouseButton[] = ["left", "middle", "right", "none"];
/** One CSI sequence with the `<` marker: only SGR mouse reports use it in input. */
const SGR_LIKE = /^\x1b\[<[\x30-\x3f]*[\x40-\x7e]$/;
const SGR = /^\x1b\[<(\d{1,3});(\d{1,5});(\d{1,5})([Mm])$/;
/** The legacy X10/1000 encoding: CSI M and three bytes. */
const X10 = /^\x1b\[M[\s\S]{3}$/;
/** Larger than any terminal: a report beyond it is garbage. */
const MAX_CELL = 10_000;
/**
 * How long one wheel notch's reports keep arriving (see WheelNotches). They
 * are sent together, so they land well inside this even with a 16 ms frame
 * drawn between two reads of them; a person turns notches further apart.
 */
export const WHEEL_NOTCH_MS = 40;

const ignored = (reason: string): IgnoredMouse => ({ kind: "ignored", reason });

/**
 * Classify ONE input sequence: a supported report, an ignored mouse report,
 * or null when it is not a mouse report at all (keys, pastes, replies).
 */
export function parseMouse(data: string): MouseReport | IgnoredMouse | null {
  if (X10.test(data)) return ignored("the legacy X10 encoding (SGR 1006 is required)");
  if (!SGR_LIKE.test(data)) return null;
  const match = SGR.exec(data);
  if (match === null) return ignored("a malformed SGR report");
  const code = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  const release = match[4] === "m";
  if (code > 255) return ignored("an unknown button code");
  if (column < 1 || row < 1 || column > MAX_CELL || row > MAX_CELL) return ignored("a cell outside the terminal");
  if ((code & 128) !== 0) return ignored("an extra button (8-11)");
  const low = code & 3;
  const motion = (code & 32) !== 0;
  const base = {
    x: column - 1,
    y: row - 1,
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
  if ((code & 64) !== 0) {
    if (release || motion) return ignored("a wheel release or wheel motion");
    if (low > 1) return ignored("a horizontal wheel");
    return { kind: "wheel", button: "none", wheel: low === 0 ? -1 : 1, ...base };
  }
  if (motion) {
    if (low === 3) return ignored("motion without a button");
    if (release) return ignored("a drag release");
    return { kind: "drag", button: BUTTONS[low] ?? "none", ...base };
  }
  if (release) return { kind: "release", button: BUTTONS[low] ?? "none", ...base };
  if (low === 3) return ignored("a press of no button");
  return { kind: "press", button: BUTTONS[low] ?? "none", ...base };
}

/**
 * The wheel in notches, for every pane (each moves `scroll` rows or items a
 * notch: the task list, dialogs, the document, the reader, the editor, the
 * panels, help and messages). A terminal may report ONE
 * notch as several wheel reports: Ghostty sends one per row its
 * mouse-scroll-multiplier (3 by default) makes of the notch, more while macOS
 * speeds a fast scroll up, and a multiplexer (Herdr, tmux) forwards each. So
 * a report starts a notch (its direction is the step) unless it follows the
 * notch's first report in the same direction within WHEEL_NOTCH_MS (no step).
 * The window runs from that first report, so a steady fast scroll still steps
 * once a window; the other direction starts a notch at once.
 */
export class WheelNotches {
  #direction = 0;
  #start = 0;
  constructor(private readonly now: () => number) {}

  /** The step for one report's `delta` (only its sign counts): its direction when it starts a notch, else 0. */
  step(delta: number): number {
    const direction = Math.sign(delta);
    if (direction === 0) return 0;
    const now = this.now();
    const elapsed = now - this.#start;
    // A clock that went back (the wall clock was set back) starts a notch: it never stalls the wheel.
    if (direction === this.#direction && elapsed >= 0 && elapsed < WHEEL_NOTCH_MS) return 0;
    this.#direction = direction;
    this.#start = now;
    return direction;
  }
}

/**
 * `terminal` as the toolkit reads it: every input sequence goes through
 * parseMouse first and an ignored mouse report is dropped; everything else
 * (supported reports included) arrives unchanged. Output, size and the
 * lifecycle are the real terminal's.
 */
export function filterMouseInput(terminal: Terminal): Terminal {
  return {
    start: (onInput, onResize) =>
      terminal.start(data => {
        if (parseMouse(data)?.kind !== "ignored") onInput(data);
      }, onResize),
    stop: () => terminal.stop(),
    drainInput: (maxMs, idleMs) => terminal.drainInput(maxMs, idleMs),
    write: data => terminal.write(data),
    get columns() {
      return terminal.columns;
    },
    get rows() {
      return terminal.rows;
    },
    get kittyProtocolActive() {
      return terminal.kittyProtocolActive;
    },
    moveBy: lines => terminal.moveBy(lines),
    hideCursor: () => terminal.hideCursor(),
    showCursor: () => terminal.showCursor(),
    clearLine: () => terminal.clearLine(),
    clearFromCursor: () => terminal.clearFromCursor(),
    clearScreen: () => terminal.clearScreen(),
    setTitle: title => terminal.setTitle(title),
    setProgress: active => terminal.setProgress(active),
  };
}
