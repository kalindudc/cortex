import { describe, test, expect, beforeEach } from "bun:test";
import { render } from "@testing-library/preact";
import { Tooltip } from "../../../src/ui/components/Tooltip.tsx";
import { tooltipState } from "../../../src/ui/state/tooltip.ts";

const anchor = { top: 100, left: 100, right: 200, bottom: 120, width: 100, height: 20 };

describe("Tooltip", () => {
  beforeEach(() => {
    tooltipState.value = { visible: false, text: "", anchor: null, placement: "right" };
  });

  test("mounts hidden by default", () => {
    render(<Tooltip />);
    const el = document.querySelector(".tooltip");
    expect(el).toBeTruthy();
    expect(el?.classList.contains("tooltip-visible")).toBe(false);
    expect(el?.getAttribute("aria-hidden")).toBe("true");
  });

  test("renders text and placement when state is visible", async () => {
    render(<Tooltip />);
    tooltipState.value = { visible: true, text: "hello", anchor, placement: "right" };
    // Wait for signal-driven re-render + useEffect microtask.
    await new Promise(r => setTimeout(r, 10));
    const node = document.querySelector(".tooltip") as HTMLElement;
    expect(node).toBeTruthy();
    expect(node.textContent).toBe("hello");
    expect(node.classList.contains("tooltip-visible")).toBe(true);
    expect(node.getAttribute("aria-hidden")).toBe("false");
  });
});
