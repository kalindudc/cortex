// Removing a tag from a task is a changeTags delta against the real daemon app,
// and the tag's definition survives its last use.

import { describe, expect, mock, test } from "bun:test";

import { buildApp } from "../../../../src/server.ts";
import { createApi } from "../../../../src/api.ts";
import { Store } from "../../../../src/store.ts";

const store = Store.open(":memory:");
const api = createApi(async (path, init) => buildApp(store).fetch(new Request(`http://localhost${path}`, init)));
mock.module("../../../../src/ui/api/client.ts", () => ({ api }));

import { fireEvent, render } from "@testing-library/preact";
import { TagsHeaderChip } from "../../../../src/ui/components/chips/TagsHeaderChip.tsx";

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition not met");
}

describe("tag membership", () => {
  test("removing the last use of a tag leaves the tag defined", async () => {
    const task = store.addTask({ title: "tagged", lane: "now" });
    await api.versioned.changeTags(task.id, { add: ["bug"] });
    const tagged = store.getTask(task.id);
    if (!tagged) throw new Error("task vanished");
    expect(tagged.tags).toEqual(["bug"]);

    const { container } = render(<TagsHeaderChip task={tagged} />);
    fireEvent.click(container.querySelector("button[aria-label='Remove tag bug']") as HTMLButtonElement);

    await until(async () => (await api.tags()).some(t => t.name === "bug" && t.task_count === 0));
    expect(store.getTask(task.id)?.tags).toEqual([]);
    expect(store.listTags().map(t => t.name)).toContain("bug");
  });
});
