// SettingRow — every control kind renders its role, its id="setting-<key>"
// and its checked state, and changes the value only through spec.set; the
// row carries data-setting and data-value and shows no Default button or
// help line.

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/preact";
import { signal } from "@preact/signals";

import { SettingRow } from "../../../../src/ui/components/panels/SettingRow.tsx";
import type { SettingSpec } from "../../../../src/ui/state/settings.ts";

function fakeSpec(
  key: SettingSpec["key"],
  control: SettingSpec["control"],
  values: string[],
  start: string,
): { spec: SettingSpec; set: ReturnType<typeof mock> } {
  const value = signal(start);
  const set = mock((v: string) => {
    value.value = v;
  });
  const spec: SettingSpec = {
    key,
    section: "Task list",
    control,
    label: `Label ${key}`,
    meaning: `the meaning of ${key}`,
    defaultValue: values[0] ?? "",
    choices: values.map(v => ({ value: v, label: v.toUpperCase(), help: `help for ${v}` })),
    current: () => value.value,
    set,
  };
  return { spec, set };
}

const row = (container: Element): HTMLElement => container.querySelector(".setting-row") as HTMLElement;

describe("SettingRow", () => {
  test("select: a labelled select with the current value; a change goes through spec.set", () => {
    const { spec, set } = fakeSpec("sort", "select", ["id", "title", "lane"], "title");
    const { container } = render(<SettingRow spec={spec} />);
    const select = container.querySelector("select#setting-sort") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe("title");
    expect(container.querySelector("label[for='setting-sort']")?.textContent).toBe("Label sort");
    expect(row(container).dataset.setting).toBe("sort");
    expect(row(container).dataset.value).toBe("title");

    select.value = "lane";
    fireEvent.change(select);
    expect(set).toHaveBeenCalledWith("lane");
    expect(row(container).dataset.value).toBe("lane");
  });

  test("segmented: a named radiogroup of native radios, the current one checked", () => {
    const { spec, set } = fakeSpec("mode", "segmented", ["read", "edit", "split"], "read");
    const { container } = render(<SettingRow spec={spec} />);
    const group = container.querySelector("#setting-mode") as HTMLElement;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Label mode");
    const radios = Array.from(group.querySelectorAll<HTMLInputElement>("label.seg-option input[type='radio']"));
    expect(radios.map(r => r.value)).toEqual(["read", "edit", "split"]);
    expect(radios.map(r => r.checked)).toEqual([true, false, false]);
    expect(new Set(radios.map(r => r.name))).toEqual(new Set(["setting-mode"]));
    expect(Array.from(group.querySelectorAll(".seg-option span")).map(s => s.textContent)).toEqual([
      "READ",
      "EDIT",
      "SPLIT",
    ]);

    fireEvent.click(radios[2] as HTMLInputElement);
    expect(set).toHaveBeenCalledWith("split");
    expect(row(container).dataset.value).toBe("split");
    expect((container.querySelector("#setting-mode input[value='split']") as HTMLInputElement).checked).toBe(true);
  });

  test("switch: a named switch, off at choices[0] and on at choices[1]", () => {
    const { spec, set } = fakeSpec("done", "switch", ["hide", "show"], "hide");
    const { container } = render(<SettingRow spec={spec} />);
    const sw = container.querySelector("button#setting-done") as HTMLButtonElement;
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-label")).toBe("Label done");
    expect(sw.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(sw);
    expect(set).toHaveBeenLastCalledWith("show");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(row(container).dataset.value).toBe("show");

    fireEvent.click(sw);
    expect(set).toHaveBeenLastCalledWith("hide");
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  test("cards: one preview card per choice with a hidden radio, the current card checked and marked", () => {
    const { spec, set } = fakeSpec("appearance", "cards", ["system", "light", "dark"], "dark");
    const { container } = render(<SettingRow spec={spec} />);
    const group = container.querySelector("#setting-appearance") as HTMLElement;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Label appearance");
    const cards = Array.from(group.querySelectorAll<HTMLElement>("label.theme-card"));
    expect(cards.map(c => c.dataset.value)).toEqual(["system", "light", "dark"]);
    for (const card of cards) expect(card.querySelector(".theme-preview")).not.toBeNull();
    expect((group.querySelector("input[value='dark']") as HTMLInputElement).checked).toBe(true);
    expect(cards.map(c => c.querySelector(".theme-name svg") !== null)).toEqual([false, false, true]);

    fireEvent.click(group.querySelector("input[value='light']") as HTMLInputElement);
    expect(set).toHaveBeenCalledWith("light");
    expect(row(container).dataset.value).toBe("light");
    expect(
      Array.from(group.querySelectorAll<HTMLElement>("label.theme-card")).map(
        c => c.querySelector(".theme-name svg") !== null,
      ),
    ).toEqual([false, true, false]);
  });

  test("every kind shows the label and the meaning, and no Default button or help line", () => {
    const kinds: SettingSpec["control"][] = ["select", "segmented", "switch", "cards"];
    for (const kind of kinds) {
      const { spec } = fakeSpec("group", kind, ["none", "lane"], "lane");
      const { container, unmount } = render(<SettingRow spec={spec} />);
      expect(container.querySelector(".setting-name")?.textContent).toBe("Label group");
      expect(container.querySelector(".setting-meaning")?.textContent).toBe("the meaning of group");
      expect(container.querySelector("#setting-group")).not.toBeNull();
      expect(container.textContent).not.toContain("Default");
      expect(container.textContent).not.toContain("help for");
      expect(container.querySelector(".setting-help")).toBeNull();
      expect(container.querySelector("button[aria-label$='to its default']")).toBeNull();
      unmount();
    }
  });
});
