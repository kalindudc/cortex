// The shape every full panel shares: its head on the desk, then one dotted
// sheet (PanelSheet) whose paper layer holds nothing and whose only other
// child, .panel-body, holds and scrolls the content.

import { expect } from "bun:test";

/** Assert the panel in `container` lies on one sheet, and return the sheet's scrolling body. */
export function sheetBody(container: ParentNode): HTMLElement {
  const view = container.querySelector<HTMLElement>("section.pane.panel-view");
  if (!view) throw new Error("expected a panel view");
  expect(Array.from(view.children).map(el => el.className)).toEqual(["panel-head", "panel-sheet paper-host"]);
  expect(view.querySelectorAll(".paper-layer")).toHaveLength(1);
  const sheet = view.children[1] as HTMLElement;
  const [layer, body] = Array.from(sheet.children);
  expect(sheet.children).toHaveLength(2);
  expect(layer?.className).toBe("paper-layer is-dotted");
  expect(layer?.getAttribute("aria-hidden")).toBe("true");
  expect(layer?.childNodes).toHaveLength(0);
  expect(body?.className).toBe("panel-body");
  return body as HTMLElement;
}
