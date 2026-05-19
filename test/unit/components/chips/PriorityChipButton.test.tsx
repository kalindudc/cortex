import { describe, test, expect, mock } from "bun:test";

const editTaskMock = mock(() => Promise.resolve({}));
// Full api surface — partial mocks pollute the bun:test module cache for any
// later test file that touches src/ui/state/refresh.ts (which calls api.updates).
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    addTask: mock(() => Promise.resolve({})),
    editTask: editTaskMock,
    setStat: mock(() => Promise.resolve({})),
    moveLane: mock(() => Promise.resolve({})),
    delTask: mock(() => Promise.resolve(undefined)),
    postUpd: mock(() => Promise.resolve({})),
    addLane: mock(() => Promise.resolve({})),
    editLane: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve(undefined)),
    setTags: mock(() => Promise.resolve({})),
    addTag: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delTag: mock(() => Promise.resolve(undefined)),
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { PriorityChipButton } from "../../../../src/ui/components/chips/PriorityChip.tsx";
import type { Task } from "../../../../src/ui/api/types.ts";

const fx: Task = {
  id: 1,
  lane: "todo",
  title: "t",
  body: null,
  status: "open",
  priority: 2,
  created: 0,
  updated: 0,
  tags: [],
};

describe("PriorityChipButton", () => {
  test("renders as a button showing P{n}", () => {
    render(<PriorityChipButton task={fx} />);
    const btn = document.querySelector("button.priority-chip") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe("P2");
  });

  test("clicking morphs into a number input prefilled with the priority", async () => {
    render(<PriorityChipButton task={fx} />);
    const btn = document.querySelector("button.priority-chip") as HTMLButtonElement;
    fireEvent.click(btn);
    await new Promise(r => setTimeout(r, 5));
    const input = document.querySelector("input.priority-chip-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("2");
    expect(input.getAttribute("type")).toBe("number");
  });

  test("Enter on edit input commits new priority via api.editTask", async () => {
    editTaskMock.mockClear();
    render(<PriorityChipButton task={fx} />);
    const btn = document.querySelector("button.priority-chip") as HTMLButtonElement;
    fireEvent.click(btn);
    await new Promise(r => setTimeout(r, 5));
    const input = document.querySelector("input.priority-chip-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise(r => setTimeout(r, 5));
    expect(editTaskMock).toHaveBeenCalledTimes(1);
    expect(editTaskMock).toHaveBeenCalledWith(1, { priority: 0 });
  });

  test("renders the unset affordance (button.priority-chip-unset, title 'Set priority') when task.priority is null", () => {
    const { container } = render(<PriorityChipButton task={{ ...fx, priority: null }} />);
    const btn = container.querySelector("button.priority-chip") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.classList.contains("priority-chip-unset")).toBe(true);
    expect(btn.getAttribute("title")).toBe("Set priority");
    // "+ P?" is the affordance label; collapse whitespace defensively.
    expect(btn.textContent?.replace(/\s+/g, " ").trim()).toBe("+ P?");
  });

  test("clicking the unset affordance morphs into an empty input", async () => {
    const { container } = render(<PriorityChipButton task={{ ...fx, priority: null }} />);
    const btn = container.querySelector("button.priority-chip") as HTMLButtonElement;
    fireEvent.click(btn);
    await new Promise(r => setTimeout(r, 5));
    const input = container.querySelector("input.priority-chip-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("");
  });

  test("empty input + Enter on a priority-set task calls api.editTask with { priority: null }", async () => {
    editTaskMock.mockClear();
    const { container } = render(<PriorityChipButton task={fx} />);
    const btn = container.querySelector("button.priority-chip") as HTMLButtonElement;
    fireEvent.click(btn);
    await new Promise(r => setTimeout(r, 5));
    const input = container.querySelector("input.priority-chip-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise(r => setTimeout(r, 5));
    expect(editTaskMock).toHaveBeenCalledTimes(1);
    expect(editTaskMock).toHaveBeenCalledWith(1, { priority: null });
  });
});
