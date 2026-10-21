import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/preact";
import type { VNode } from "preact";
import { PaperLayer } from "../../../src/ui/components/PaperLayer.tsx";

function layer(ui: VNode): Element {
  const { container } = render(ui);
  expect(container.children).toHaveLength(1);
  const el = container.children[0] as Element;
  expect(el.getAttribute("aria-hidden")).toBe("true");
  expect(el.childNodes).toHaveLength(0);
  return el;
}

describe("PaperLayer", () => {
  test("renders one empty aria-hidden paper layer", () => {
    const el = layer(<PaperLayer />);
    expect(el.tagName).toBe("DIV");
    expect(el.getAttribute("class")).toBe("paper-layer");
  });

  test("card adds the smaller lift", () => {
    expect(layer(<PaperLayer card />).getAttribute("class")).toBe("paper-layer is-card");
  });

  test("dots adds the dot grid", () => {
    expect(layer(<PaperLayer dots />).getAttribute("class")).toBe("paper-layer is-dotted");
  });

  test("card and dots combine", () => {
    const el = layer(<PaperLayer card dots />);
    expect(el.classList.contains("is-card")).toBe(true);
    expect(el.classList.contains("is-dotted")).toBe(true);
  });
});
