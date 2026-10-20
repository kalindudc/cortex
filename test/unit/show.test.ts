import { test, expect, describe } from "bun:test";
import type { Task, Update } from "../../src/store.ts";
import { renderTaskView } from "../../src/commands/show.ts";

// Pins the exact `cortex show` text format. `cortex search` prints the
// selected task through the same renderTaskView, so this snapshot guards
// BOTH commands' stdout contract.

const CREATED = Date.UTC(2024, 0, 2, 3, 4, 5); // 2024-01-02T03:04:05.000Z
const UPDATED = Date.UTC(2024, 0, 3, 6, 7, 8); // 2024-01-03T06:07:08.000Z

function mkTask(overrides: Partial<Task>): Task {
  return {
    id: 42,
    lane: "now",
    title: "ship the thing",
    body: null,
    status: "open",
    priority: null,
    created: CREATED,
    updated: UPDATED,
    tags: [],
    memory_excluded: false,
    ...overrides,
  };
}

describe("renderTaskView", () => {
  test("minimal task: no priority, tags, body, or updates", () => {
    expect(renderTaskView(mkTask({}), [])).toBe(
      [
        "[42] ship the thing",
        "  lane:     now",
        "  status:   open",
        "  created:  2024-01-02T03:04:05.000Z",
        "  updated:  2024-01-03T06:07:08.000Z",
      ].join("\n"),
    );
  });

  test("full task: priority, tags, body, updates with multi-line body", () => {
    const task = mkTask({ priority: 0, tags: ["api", "infra"], body: "line one\nline two" });
    const updates: Update[] = [
      {
        id: 1,
        task_id: 42,
        author: "pi-abc",
        summary: "started",
        body: null,
        severity: "progress",
        created: CREATED,
      },
      {
        id: 2,
        task_id: 42,
        author: "impl-12345678",
        summary: "stuck",
        body: "detail A\ndetail B",
        severity: "blocked",
        created: UPDATED,
      },
    ];
    expect(renderTaskView(task, updates)).toBe(
      [
        "[42] ship the thing",
        "  lane:     now",
        "  status:   open",
        "  priority: 0",
        "  tags:     #api #infra",
        "  created:  2024-01-02T03:04:05.000Z",
        "  updated:  2024-01-03T06:07:08.000Z",
        "",
        "line one",
        "line two",
        "",
        "updates:",
        "  [progress] 2024-01-02T03:04:05.000Z pi-abc: started",
        "  [blocked] 2024-01-03T06:07:08.000Z impl-12345678: stuck",
        "    detail A",
        "    detail B",
      ].join("\n"),
    );
  });
});
