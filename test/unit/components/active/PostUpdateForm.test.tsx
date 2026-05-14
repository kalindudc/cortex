import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/preact";

// Capture the postUpd mock so each test can introspect calls. We re-assign
// .mockClear() per test because mock.module is hoisted and shared.
const postUpd = mock((_id: number, _body: { author: string; summary: string }) => Promise.resolve({}));
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    postUpd,
    // Minimal fillers — PostUpdateForm only calls postUpd, but errors.ts
    // imports the api module so unrelated methods must exist.
    editTask: mock(() => Promise.resolve({})),
    setStat: mock(() => Promise.resolve({})),
  },
}));

import { PostUpdateForm } from "../../../../src/ui/components/active/PostUpdateForm.tsx";
import { meAuthor } from "../../../../src/ui/state/signals.ts";

const makeTask = () => ({
  id: 7,
  lane: "inbox",
  title: "t",
  body: "",
  status: "open" as const,
  priority: 50,
  created: 1,
  updated: 1,
  tags: [],
});

describe("PostUpdateForm", () => {
  beforeEach(() => {
    postUpd.mockClear();
    meAuthor.value = "tester";
  });

  test("typing into the textarea updates the char counter", () => {
    const { container } = render(<PostUpdateForm task={makeTask()} />);
    const ta = container.querySelector("textarea.autosize") as HTMLTextAreaElement;
    const counter = container.querySelector(".char-counter") as HTMLElement;
    expect(ta).toBeTruthy();
    expect(counter.textContent).toBe("0/1024");
    fireEvent.input(ta, { target: { value: "hello world" } });
    expect(counter.textContent).toBe("11/1024");
  });

  test("Cmd+Enter (metaKey) submits via api.postUpd", async () => {
    const { container } = render(<PostUpdateForm task={makeTask()} />);
    const ta = container.querySelector("textarea.autosize") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "looks good" } });
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    // Allow the submit microtask to drain.
    await Promise.resolve();
    expect(postUpd).toHaveBeenCalledTimes(1);
    expect(postUpd.mock.calls[0][0]).toBe(7);
    expect(postUpd.mock.calls[0][1]).toEqual({ author: "tester", summary: "looks good" });
  });

  test("Ctrl+Enter (ctrlKey) also submits via api.postUpd", async () => {
    const { container } = render(<PostUpdateForm task={makeTask()} />);
    const ta = container.querySelector("textarea.autosize") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "ship it" } });
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    await Promise.resolve();
    expect(postUpd).toHaveBeenCalledTimes(1);
    expect(postUpd.mock.calls[0][1].summary).toBe("ship it");
  });

  test("empty / whitespace summary is a no-op (submit guarded)", async () => {
    const { container } = render(<PostUpdateForm task={makeTask()} />);
    const ta = container.querySelector("textarea.autosize") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "   " } });
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    await Promise.resolve();
    expect(postUpd).not.toHaveBeenCalled();
  });

  test("plain Enter (no modifier) does NOT submit", async () => {
    const { container } = render(<PostUpdateForm task={makeTask()} />);
    const ta = container.querySelector("textarea.autosize") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "draft" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await Promise.resolve();
    expect(postUpd).not.toHaveBeenCalled();
  });
});
