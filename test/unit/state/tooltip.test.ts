import { describe, test, expect, beforeEach } from "bun:test";
import { tip, tooltipState } from "../../../src/ui/state/tooltip.ts";

describe("state/tooltip", () => {
  beforeEach(() => {
    tooltipState.value = { visible: false, text: "", anchor: null, placement: "right" };
    document.body.innerHTML = "";
  });

  test("tip() returns empty spread for null/empty text", () => {
    expect(tip(null)).toEqual({});
    expect(tip("")).toEqual({});
  });

  test("tip() with text returns the hover/focus handlers", () => {
    const spread = tip("hello");
    expect(typeof spread.onMouseEnter).toBe("function");
    expect(typeof spread.onMouseLeave).toBe("function");
    expect(typeof spread.onFocus).toBe("function");
    expect(typeof spread.onBlur).toBe("function");
  });

  test("mouseenter then 200ms delay shows tooltip; mouseleave hides", async () => {
    const btn = document.createElement("button");
    btn.textContent = "x";
    document.body.appendChild(btn);
    const spread = tip("hello", { placement: "top" });
    btn.addEventListener("mouseenter", spread.onMouseEnter as EventListener);
    btn.addEventListener("mouseleave", spread.onMouseLeave as EventListener);

    btn.dispatchEvent(new Event("mouseenter"));
    // before delay it's still hidden
    expect(tooltipState.value.visible).toBe(false);
    await new Promise(r => setTimeout(r, 250));
    expect(tooltipState.value.visible).toBe(true);
    expect(tooltipState.value.text).toBe("hello");
    expect(tooltipState.value.placement).toBe("top");

    btn.dispatchEvent(new Event("mouseleave"));
    expect(tooltipState.value.visible).toBe(false);
  });

  test("focus opens immediately (delay:0)", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    const spread = tip("focus-text");
    btn.addEventListener("focus", spread.onFocus as EventListener);
    btn.dispatchEvent(new Event("focus"));
    expect(tooltipState.value.visible).toBe(true);
    expect(tooltipState.value.text).toBe("focus-text");
  });

  test("Escape keydown hides the tip", () => {
    // Seed visible state directly so we don't have to wait on the delay.
    tooltipState.value = {
      visible: true,
      text: "x",
      anchor: { top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 },
      placement: "right",
    };
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tooltipState.value.visible).toBe(false);
  });
});
