import { describe, expect, test } from "bun:test";
import { matchModeShortcut, modeShortcutHint, modeShortcutAria } from "../../../src/ui/lib/keys.ts";

function event(init: KeyboardEventInit = {}, altGraph = false): KeyboardEvent {
  const key = new KeyboardEvent("keydown", { key: "1", code: "Digit1", cancelable: true, ...init });
  if (altGraph) Object.defineProperty(key, "getModifierState", { value: (name: string) => name === "AltGraph" });
  return key;
}

describe("mode shortcuts", () => {
  const heldLeftAlt = new Set(["AltLeft"]);
  for (const [digit, mode] of [
    ["1", "read"],
    ["2", "edit"],
    ["3", "split"],
  ] as const) {
    test(`${digit} selects ${mode} with the platform's primary modifier plus Alt/Option`, () => {
      expect(matchModeShortcut(event({ key: digit, code: `Digit${digit}`, metaKey: true, altKey: true }), true)).toBe(
        mode,
      );
      expect(
        matchModeShortcut(
          event({ key: digit, code: `Digit${digit}`, ctrlKey: true, altKey: true }),
          false,
          heldLeftAlt,
        ),
      ).toBe(mode);
      expect(modeShortcutHint(mode, true)).toBe(`⌘ + ⌥ + ${digit}`);
      expect(modeShortcutHint(mode, false)).toBe(`Ctrl + Alt + ${digit}`);
      expect(modeShortcutAria(mode, true)).toBe(`Meta+Alt+${digit}`);
      expect(modeShortcutAria(mode, false)).toBe(`Control+Alt+${digit}`);
    });
  }
  test("ordinary browser tab/reload/save shortcuts and extra modifiers do not match", () => {
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true, altKey: true, shiftKey: true },
      { metaKey: true, altKey: true, ctrlKey: true },
      { key: "r", code: "KeyR", metaKey: true, shiftKey: true },
      { key: "s", code: "KeyS", ctrlKey: true },
    ]) {
      expect(matchModeShortcut(event(init), true, heldLeftAlt)).toBeNull();
      expect(matchModeShortcut(event(init), false, heldLeftAlt)).toBeNull();
    }
  });
  test("physical number keys work when Option changes the reported character", () => {
    expect(matchModeShortcut(event({ key: "™", code: "Digit2", metaKey: true, altKey: true }, true), true)).toBe(
      "edit",
    );
  });
  test("AltGr text input is not mistaken for a Windows/Linux shortcut", () => {
    const altGr = event({ key: "@", code: "Digit2", ctrlKey: true, altKey: true }, true);
    expect(matchModeShortcut(altGr, false, new Set(["AltRight"]))).toBeNull();
    expect(matchModeShortcut(altGr, false)).toBeNull();
    // Firefox also reports AltGraph for genuine Ctrl+Alt. A tracked LEFT
    // Alt distinguishes the intentional shortcut from right-Alt typing.
    expect(matchModeShortcut(altGr, false, heldLeftAlt)).toBe("edit");
  });
  test("handled and composing events never match", () => {
    const handled = event({ metaKey: true, altKey: true });
    handled.preventDefault();
    expect(matchModeShortcut(handled, true)).toBeNull();
    expect(matchModeShortcut(event({ metaKey: true, altKey: true, isComposing: true }), true)).toBeNull();
  });
});
