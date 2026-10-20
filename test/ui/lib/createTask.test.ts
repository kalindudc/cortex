// createUntitledTask — the task creation flow shared by the SidebarPane
// "+" button and the command-palette "New task" entry. ONE atomic create
// (`untitled: true`): the daemon names the task
// `untitled-<id>` inside the create transaction, so there is no follow-up
// PATCH and never an intermediate "untitled" row. Verifies the request plus
// the focus / selection signals it flips. Errors are surfaced via tryApi
// (api/errors.ts), so we stub that layer out to keep this unit purely about
// the orchestration.

import { describe, test, expect, mock, beforeEach } from "bun:test";

// api.* is the wire surface; spy on the two methods this module touches.
const addTask = mock((_b: unknown) => Promise.resolve({ id: 7 } as { id: number }));
const editTask = mock((_id: number, _b: unknown) => Promise.resolve({}));
mock.module("../../../src/ui/api/client.ts", () => ({
  api: {
    addTask,
    editTask,
    // refresh.ts (loaded transitively by signals → computed) registers a
    // top-level effect over activeTask that calls api.updates(); include
    // a no-op so the effect never crashes the unrelated tests in this
    // process.
    updates: mock(() => Promise.resolve([])),
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
  },
}));

// tryApi normally surfaces errors via pushNotification — for this unit
// we just want it to await its inner thunk transparently. Re-export the
// thunk's resolved value so the SUT sees the same shape it would in prod.
mock.module("../../../src/ui/api/errors.ts", () => ({
  tryApi: <T>(fn: () => Promise<T>) => fn(),
  showError: mock(() => {}),
}));

import { createUntitledTask } from "../../../src/ui/lib/createTask.ts";
import { pendingTitleFocus, selectedId } from "../../../src/ui/state/signals.ts";

describe("createUntitledTask", () => {
  beforeEach(() => {
    pendingTitleFocus.value = null;
    selectedId.value = null;
    addTask.mockClear();
    editTask.mockClear();
    // Restore the default success path; individual tests override as needed.
    addTask.mockImplementation(() => Promise.resolve({ id: 7 }));
    editTask.mockImplementation(() => Promise.resolve({}));
  });

  test("creates atomically: api.addTask({ untitled: true, lane }) with no title of its own", async () => {
    await createUntitledTask("next");
    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith({ untitled: true, lane: "next" });
  });

  test("sends no follow-up PATCH: the daemon names the task untitled-<id> in the create transaction", async () => {
    addTask.mockImplementationOnce(() => Promise.resolve({ id: 42 }));
    await createUntitledTask("now");
    expect(editTask).not.toHaveBeenCalled();
  });

  test("sets pendingTitleFocus.value and selectedId.value to the new id", async () => {
    addTask.mockImplementationOnce(() => Promise.resolve({ id: 99 }));
    await createUntitledTask("now");
    expect(pendingTitleFocus.value).toBe(99);
    expect(selectedId.value).toBe(99);
  });

  test("returns early without PATCHing if addTask returns null/no id", async () => {
    addTask.mockImplementationOnce(() => Promise.resolve(null as unknown as { id: number }));
    await createUntitledTask("now");
    expect(editTask).not.toHaveBeenCalled();
    expect(pendingTitleFocus.value).toBeNull();
    expect(selectedId.value).toBeNull();

    // Also covers the "no id field at all" branch.
    addTask.mockImplementationOnce(() => Promise.resolve({} as { id: number }));
    await createUntitledTask("now");
    expect(editTask).not.toHaveBeenCalled();
    expect(selectedId.value).toBeNull();
  });
});
