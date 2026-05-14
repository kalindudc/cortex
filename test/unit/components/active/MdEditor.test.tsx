// SMOKE-ONLY: CodeMirror editor is too coupled to DOM measurement APIs to
// test interaction in happy-dom; cardinal flow covers it via e2e.
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/preact";

import { MdEditor } from "../../../../src/ui/components/active/MdEditor.tsx";

describe("MdEditor (smoke)", () => {
  test("mounts a .md-editor host element without crashing", () => {
    const { container } = render(<MdEditor value="hello" onChange={() => {}} />);
    const host = container.querySelector(".md-editor");
    expect(host).toBeTruthy();
  });

  test("accepts an initial value + placeholder prop without throwing", () => {
    const { container } = render(
      <MdEditor value="# Title\n\nbody" placeholder="Add a description…" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(container.querySelector(".md-editor")).toBeTruthy();
  });

  test("accepts an empty string value", () => {
    const { container } = render(<MdEditor value="" onChange={() => {}} />);
    expect(container.querySelector(".md-editor")).toBeTruthy();
  });
});
