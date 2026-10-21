import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/preact";
import { PanelSheet } from "../../../../src/ui/components/panels/PanelSheet.tsx";

describe("PanelSheet", () => {
  test("a sheet frame: a content-free dotted paper layer, then the scrolling body holding the content", () => {
    const { container } = render(
      <PanelSheet>
        <h1 class="panel-title">Backup</h1>
        <p>one</p>
      </PanelSheet>,
    );
    expect(container.children).toHaveLength(1);
    const sheet = container.children[0] as HTMLElement;
    expect(sheet.className).toBe("panel-sheet paper-host");
    const [layer, body] = Array.from(sheet.children);
    expect(sheet.children).toHaveLength(2);
    expect(layer?.className).toBe("paper-layer is-dotted");
    expect(layer?.getAttribute("aria-hidden")).toBe("true");
    expect(layer?.childNodes).toHaveLength(0);
    expect(body?.className).toBe("panel-body");
    expect(Array.from(body?.children ?? []).map(el => el.tagName)).toEqual(["H1", "P"]);
  });
});
