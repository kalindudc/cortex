import { describe, expect, test } from "bun:test";
import type { Terminal } from "@earendil-works/pi-tui";
import {
  filterMouseInput,
  MOUSE_OFF,
  MOUSE_ON,
  parseMouse,
  WHEEL_NOTCH_MS,
  WheelNotches,
} from "../../../src/tui/mouse.ts";

// The terminal mouse (N19: optional, on by default, never the only path to an
// action): SGR reports (DECSET 1006) of button-event tracking (1002) are
// parsed strictly; every other mouse report is dropped before the toolkit
// sees it, so an unsupported one can never act as a click.

const sgr = (button: number, x: number, y: number, final: "M" | "m" = "M") => `\x1b[<${button};${x};${y}${final}`;

describe("MOUSE_ON / MOUSE_OFF", () => {
  test("button-event tracking with drag (1002) in SGR encoding (1006), never any-motion (1003)", () => {
    expect(MOUSE_ON).toBe("\x1b[?1002h\x1b[?1006h");
    expect(MOUSE_ON).not.toContain("1003");
    // Off resets what we enabled and what another program may have left on.
    for (const mode of ["1000", "1002", "1003", "1006"]) expect(MOUSE_OFF).toContain(`\x1b[?${mode}l`);
    expect(MOUSE_OFF).not.toContain("h");
  });
});

describe("parseMouse: SGR reports", () => {
  test("press and release of each button, zero-based cells", () => {
    expect(parseMouse(sgr(0, 1, 1))).toEqual({
      kind: "press",
      button: "left",
      x: 0,
      y: 0,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(parseMouse(sgr(1, 10, 5))).toMatchObject({ kind: "press", button: "middle", x: 9, y: 4 });
    expect(parseMouse(sgr(2, 120, 40))).toMatchObject({ kind: "press", button: "right", x: 119, y: 39 });
    expect(parseMouse(sgr(0, 7, 3, "m"))).toMatchObject({ kind: "release", button: "left", x: 6, y: 2 });
    // A release that does not name its button (the X10 code 3) still ends the gesture.
    expect(parseMouse(sgr(3, 7, 3, "m"))).toMatchObject({ kind: "release", button: "none" });
  });

  test("drag: motion with a button held (bit 32)", () => {
    expect(parseMouse(sgr(32, 12, 4))).toMatchObject({ kind: "drag", button: "left", x: 11, y: 3 });
    expect(parseMouse(sgr(34, 12, 4))).toMatchObject({ kind: "drag", button: "right" });
  });

  test("the wheel: 64 up, 65 down", () => {
    expect(parseMouse(sgr(64, 3, 9))).toMatchObject({ kind: "wheel", button: "none", wheel: -1, x: 2, y: 8 });
    expect(parseMouse(sgr(65, 3, 9))).toMatchObject({ kind: "wheel", wheel: 1 });
  });

  test("modifiers: shift 4, alt/meta 8, ctrl 16, in any combination", () => {
    expect(parseMouse(sgr(4, 1, 1))).toMatchObject({
      kind: "press",
      button: "left",
      shift: true,
      alt: false,
      ctrl: false,
    });
    expect(parseMouse(sgr(8, 1, 1))).toMatchObject({ shift: false, alt: true, ctrl: false });
    expect(parseMouse(sgr(16, 1, 1))).toMatchObject({ shift: false, alt: false, ctrl: true });
    expect(parseMouse(sgr(0 + 4 + 8 + 16, 1, 1))).toMatchObject({ kind: "press", shift: true, alt: true, ctrl: true });
    expect(parseMouse(sgr(32 + 16, 5, 5))).toMatchObject({ kind: "drag", button: "left", ctrl: true });
    expect(parseMouse(sgr(64 + 8, 5, 5))).toMatchObject({ kind: "wheel", wheel: -1, alt: true });
  });
});

describe("parseMouse: unsupported reports are ignored, never guessed", () => {
  test.each([
    ["horizontal wheel left", sgr(66, 5, 5)],
    ["horizontal wheel right", sgr(67, 5, 5)],
    ["a wheel 'release'", sgr(64, 5, 5, "m")],
    ["extra buttons 8-11 (back/forward)", sgr(128, 5, 5)],
    ["extra button release", sgr(129, 5, 5, "m")],
    ["motion without a button (any-motion tracking was never asked for)", sgr(35, 5, 5)],
    ["a press of no button", sgr(3, 5, 5)],
    ["a drag 'release'", sgr(32, 5, 5, "m")],
    ["column zero", sgr(0, 0, 5)],
    ["row zero", sgr(0, 5, 0)],
    ["an absurd coordinate", sgr(0, 123456, 5)],
    ["an absurd button code", sgr(1000, 5, 5)],
    ["a missing field", "\x1b[<0;5M"],
    ["an extra field", "\x1b[<0;5;5;5M"],
    ["a wrong final byte", "\x1b[<0;5;5X"],
    ["an empty report", "\x1b[<M"],
    ["colon parameters", "\x1b[<0:1;5;5M"],
    ["the legacy X10 encoding", "\x1b[M #!"],
  ])("%s", (_label, data) => {
    expect(parseMouse(data)).toMatchObject({ kind: "ignored" });
  });

  test("anything that is not a mouse report is not the mouse's (keys, pastes, other replies)", () => {
    for (const data of [
      "j",
      "\x1b",
      "\x1b[A",
      "\x1b[1;5C",
      "\x1b[?997;1n",
      "\x1b[200~\x1b[<0;1;1M\x1b[201~", // a paste that contains report-like text is text
      "\x1b[<0;1;1Mj", // not ONE sequence: left to the key parser
      "<0;1;1M",
      "",
    ]) {
      expect(parseMouse(data)).toBeNull();
    }
  });
});

describe("WheelNotches: one step a notch, however many reports the terminal sends for it", () => {
  /** A notch counter on a clock the test sets. */
  const notches = () => {
    let now = 1_000;
    const wheel = new WheelNotches(() => now);
    return {
      step: (delta: number) => wheel.step(delta),
      at: (ms: number) => {
        now = ms;
      },
    };
  };

  test("a notch's first report steps; its other reports (same direction, inside the window) do not", () => {
    const w = notches();
    // Ghostty's default mouse-scroll-multiplier: three reports for one notch, sent together.
    expect([w.step(1), w.step(1), w.step(1)]).toEqual([1, 0, 0]);
    w.at(1_000 + WHEEL_NOTCH_MS - 1); // a late report of the same notch (a frame rendered between two reads)
    expect(w.step(1)).toBe(0);
    w.at(1_000 + WHEEL_NOTCH_MS); // the next notch
    expect([w.step(1), w.step(1), w.step(1)]).toEqual([1, 0, 0]);
  });

  test("the window runs from the notch's first report, so a steady fast scroll keeps stepping", () => {
    const w = notches();
    const steps: number[] = [];
    // Reports every quarter window for ten windows: one step each window, never a stall.
    for (let t = 1_000; t < 1_000 + 10 * WHEEL_NOTCH_MS; t += WHEEL_NOTCH_MS / 4) {
      w.at(t);
      steps.push(w.step(1));
    }
    expect(steps.filter(s => s !== 0)).toEqual(Array.from({ length: 10 }, () => 1));
  });

  test("the other direction starts a notch at once", () => {
    const w = notches();
    expect([w.step(1), w.step(-1), w.step(-1), w.step(1), w.step(1)]).toEqual([1, -1, 0, 1, 0]);
  });

  test("only the direction counts: a zero is no step and leaves the notch; a larger delta is one step", () => {
    const w = notches();
    expect(w.step(0)).toBe(0);
    expect(w.step(5)).toBe(1); // the toolkit's Alt-wheel delta
    expect(w.step(0)).toBe(0);
    expect(w.step(1)).toBe(0); // still that notch
    expect(w.step(-5)).toBe(-1);
  });

  test("a clock that went back starts a notch rather than stalling the wheel", () => {
    const w = notches();
    expect(w.step(1)).toBe(1);
    w.at(0); // the wall clock was set back
    expect(w.step(1)).toBe(1);
    expect(w.step(1)).toBe(0);
  });
});

/** The smallest Terminal: records its writes and lets the test play the terminal's input. */
class RecordingTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  writes: string[] = [];
  calls: string[] = [];
  #input: ((data: string) => void) | undefined;
  #resize: (() => void) | undefined;
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.#input = onInput;
    this.#resize = onResize;
    this.calls.push("start");
  }
  stop(): void {
    this.calls.push("stop");
  }
  async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    this.calls.push(`drain:${maxMs}:${idleMs}`);
  }
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(lines: number): void {
    this.calls.push(`moveBy:${lines}`);
  }
  hideCursor(): void {
    this.calls.push("hideCursor");
  }
  showCursor(): void {
    this.calls.push("showCursor");
  }
  clearLine(): void {
    this.calls.push("clearLine");
  }
  clearFromCursor(): void {
    this.calls.push("clearFromCursor");
  }
  clearScreen(): void {
    this.calls.push("clearScreen");
  }
  setTitle(title: string): void {
    this.calls.push(`title:${title}`);
  }
  setProgress(active: boolean): void {
    this.calls.push(`progress:${active}`);
  }
  type(data: string): void {
    this.#input?.(data);
  }
  resized(): void {
    this.#resize?.();
  }
}

describe("filterMouseInput: the terminal the toolkit reads through", () => {
  test("supported reports and every other input pass unchanged; ignored reports never arrive", async () => {
    const inner = new RecordingTerminal();
    const seen: string[] = [];
    let resizes = 0;
    const filtered = filterMouseInput(inner);
    filtered.start(
      data => seen.push(data),
      () => resizes++,
    );
    for (const data of [
      sgr(0, 3, 4),
      "j",
      sgr(66, 3, 4),
      sgr(32, 5, 4),
      sgr(128, 1, 1),
      "\x1b[<0;0;0M",
      sgr(0, 5, 4, "m"),
    ]) {
      inner.type(data);
    }
    expect(seen).toEqual([sgr(0, 3, 4), "j", sgr(32, 5, 4), sgr(0, 5, 4, "m")]);
    inner.resized();
    expect(resizes).toBe(1);
  });

  test("everything else is the real terminal's: size, writes, cursor and lifecycle", async () => {
    const inner = new RecordingTerminal();
    const filtered = filterMouseInput(inner);
    expect([filtered.columns, filtered.rows, filtered.kittyProtocolActive]).toEqual([100, 30, false]);
    inner.columns = 80;
    inner.rows = 24;
    inner.kittyProtocolActive = true;
    expect([filtered.columns, filtered.rows, filtered.kittyProtocolActive]).toEqual([80, 24, true]);
    filtered.write("frame");
    expect(inner.writes).toEqual(["frame"]);
    filtered.start(
      () => {},
      () => {},
    );
    await filtered.drainInput(100, 10);
    filtered.moveBy(-2);
    filtered.hideCursor();
    filtered.showCursor();
    filtered.clearLine();
    filtered.clearFromCursor();
    filtered.clearScreen();
    filtered.setTitle("cortex");
    filtered.setProgress(true);
    filtered.stop();
    expect(inner.calls).toEqual([
      "start",
      "drain:100:10",
      "moveBy:-2",
      "hideCursor",
      "showCursor",
      "clearLine",
      "clearFromCursor",
      "clearScreen",
      "title:cortex",
      "progress:true",
      "stop",
    ]);
  });
});
