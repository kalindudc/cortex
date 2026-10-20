import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/preact";
import { Icon } from "../../../src/ui/components/Icon.tsx";

describe("Icon", () => {
  test("renders an inline SVG with the chosen icon path", () => {
    render(<Icon name="plus" size={16} />);
    const svg = document.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("width")).toBe("16");
    expect(svg?.getAttribute("height")).toBe("16");
    expect(svg?.innerHTML).toContain("<line");
  });

  test("falls back to empty inner HTML for unknown icons", () => {
    render(<Icon name="not-a-real-icon" />);
    const svg = document.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.innerHTML).toBe("");
  });
});
