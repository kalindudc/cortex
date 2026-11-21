// @vitest-environment jsdom
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, expect, test } from "vitest";
import type { rpcContract } from "./server";
import type { CortexTaskDetail } from "./state";

const THREAD = "thr_aaaaaaaa";
const OTHER = "thr_bbbbbbbb";
let app: Awaited<ReturnType<typeof loadPluginApp>>;
beforeAll(async () => { app = await loadPluginApp(() => import("./app")); });
afterEach(cleanup);

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const detail = (id: number, author = THREAD): CortexTaskDetail => ({
  task: {
    id, title: `Title ${id}`, status: "open", lane: "cortex", tags: ["research", "notes"], body: null,
    memoryExcluded: false, created: Date.now() - 60_000, updated: Date.now() - 60_000,
  },
  updates: [{ id: 41, author: `bb-${author}`, summary: "created", body: null, kind: "created", created: Date.now() - 60_000 }],
  staleness: { verdict: "fresh" },
  sync: { syncedAt: Date.now(), changed: [], missing: [], old: false, ageDays: 0, notFolded: 0 },
  progress: null,
  authors: { [`bb-${OTHER}`]: { kind: "thread", threadId: OTHER, label: "Other thread" } },
});

function card(attributes: Record<string, string>, rpc: Partial<Handlers>) {
  return renderSlot(app.messageDirectives[0]!, {
    attributes, source: "::cortex{}",
    message: { id: "msg_1", threadId: THREAD, turnId: null, projectId: "proj_1" }, openWorkspaceFile: null,
  }, { rpc: rpc as Handlers, experimental_panel: { openTab: () => true } });
}
const calls = (slot: ReturnType<typeof card>, method: string) => slot.inspection.rpcCalls.filter(c => c.method === method);

test("shows excluded attribution and reason and includes without asking for a reason", async () => {
  const loaded = detail(4);
  const slot = card({ id: "4" }, {
    task: () => ({ ...loaded, task: {
      ...loaded.task, memoryExcluded: true,
      memoryExclusion: { excluded_by: `bb-${THREAD}`, excluded_at: Date.now() - 120_000, reason: "Replaced by a verified summary" },
    } }),
    setMemoryExcluded: () => loaded,
  });
  expect(await slot.findByText("Excluded from memory")).toBeTruthy();
  expect(slot.getByText(/by this thread/)).toBeTruthy();
  expect(slot.getByText("Replaced by a verified summary")).toBeTruthy();
  expect(slot.getByText("Not in memory")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Include in memory again" }));
  expect(await slot.findByText("In memory")).toBeTruthy();
  expect(calls(slot, "setMemoryExcluded")).toHaveLength(1);
  expect(slot.queryByText("Replaced by a verified summary")).toBeNull();
});

test("offers the status menu and preserves the task when exclusion fails", async () => {
  const loaded = detail(4);
  const slot = card({ id: "4" }, {
    task: () => loaded,
    setStatus: ({ status }) => ({ ...loaded, task: { ...loaded.task, status } }),
    setMemoryExcluded: () => { throw new Error("cortex is busy"); },
  });
  const status = await slot.findByRole("button", { name: /Status: Open/ });
  fireEvent.keyDown(status, { key: "Enter" });
  fireEvent.click(within(await slot.findByRole("menu")).getByText("Blocked"));
  expect(await slot.findByRole("button", { name: /Status: Blocked/ })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Exclude from memory" }));
  expect((await slot.findByRole("alert")).textContent).toContain("cortex is busy");
  expect(slot.getByText("In memory")).toBeTruthy();
});

test("shows a done receipt and reopens with the status RPC", async () => {
  const loaded = detail(4);
  const done: CortexTaskDetail = {
    ...loaded, task: { ...loaded.task, status: "done" },
    updates: [...loaded.updates, {
      id: 42, author: `bb-${THREAD}`, summary: "status → done", kind: "status", to: "done",
      body: null, created: Date.now() - 5000,
    }],
  };
  const slot = card({ id: "4" }, { task: () => done, setStatus: () => loaded });
  expect(await slot.findByText("Marked done")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Reopen" }));
  expect(await slot.findByRole("button", { name: /Status: Open/ })).toBeTruthy();
  expect(calls(slot, "setStatus")).toHaveLength(1);
});

test("shows loading, retries failed reads, and updates a cached card if the task is removed", async () => {
  let fail: Error | null = new Error("cortex is down");
  let finish = () => {};
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const slot = card({ id: "4" }, {
    task: async () => { await gate; if (fail) throw fail; return detail(4); },
  });
  expect(slot.getByRole("status").textContent).toContain("Loading");
  finish();
  expect((await slot.findByRole("alert")).textContent).toContain("cortex is down");
  fail = null;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  expect(await slot.findByText("Title 4")).toBeTruthy();
  fail = new Error("task 4 not found");
  await slot.behavior.emitRealtime("task", { taskId: 4 });
  expect(await slot.findByText(/Task #4 no longer exists/)).toBeTruthy();
  expect(slot.queryByText("Title 4")).toBeNull();
});

test("groups a bounded list by receipt and names the actor relative to the message thread", async () => {
  const slot = card({ ids: "3,2,1,4,5,6,7,8,9,10,11,12,13,14,1" }, {
    task: ({ taskId: id }) => {
      const d = detail(id, id === 2 ? OTHER : THREAD);
      if (id === 2 || id === 4) d.updates.push({
        id: 42, author: `bb-${id === 2 ? OTHER : THREAD}`, summary: "Verified again", body: null, kind: "note",
        created: Date.now() - 5000, revision: true,
      });
      if (id === 3) {
        d.task.memoryExcluded = true;
        d.task.memoryExclusion = { excluded_by: `bb-${THREAD}`, reason: "Just a temporary document", excluded_at: Date.now() };
      }
      if (id === 5) {
        d.task.memoryExcluded = true;
        d.task.memoryExclusion = { excluded_by: `bb-${OTHER}`, reason: "Another thread curated this", excluded_at: Date.now() };
      }
      if (id === 6) {
        d.updates[0].author = `bb-${OTHER}`;
        d.updates.push({
          id: 42, author: `bb-${THREAD}`, summary: "Ordinary update", kind: "note", body: null, created: Date.now(),
        });
      }
      return d;
    },
  });
  expect(await slot.findByText("14 tasks")).toBeTruthy();
  expect(await slot.findByText("Saved · 7")).toBeTruthy();
  expect(slot.getByText("Revised · 1")).toBeTruthy();
  expect(slot.getByText("Curated · 1")).toBeTruthy();
  expect(slot.getByText("Excluded · this thread")).toBeTruthy();
  const rows = slot.getAllByRole("listitem");
  expect(rows.slice(-3).map(row => row.textContent)).toEqual([
    expect.stringContaining("Title 2"), expect.stringContaining("Title 5"), expect.stringContaining("Title 6"),
  ]);
  expect(rows.at(-1)?.closest("section")).toBeNull();
  expect(slot.getByText("2 more")).toBeTruthy();
  expect(calls(slot, "task")).toHaveLength(12);
  fireEvent.click(slot.getByRole("button", { name: "Open task 3" }));
  expect(slot.inspection.experimental_panelCalls).toHaveLength(1);
});

test("caps the actor label and keeps the full title and actor available", async () => {
  const actor = "An extremely long thread title that should not fill the whole task row";
  const d = detail(7, OTHER);
  d.authors[`bb-${OTHER}`]!.label = actor;
  d.task.title = "Cortex ships only the cortex and cortex-research skills";
  const slot = card({ ids: "7" }, { task: () => d });
  const row = await slot.findByRole("listitem");
  expect(row.textContent).toContain(d.task.title);
  expect(row.textContent).not.toContain(actor);
  expect(within(row).getByTitle(actor).textContent).toContain("…");
});

test("a task created excluded was saved, not curated", async () => {
  const d = detail(7);
  d.task.memoryExcluded = true;
  d.task.memoryExclusion = { excluded_by: `bb-${THREAD}`, excluded_at: d.task.created, reason: "Saved excluded by its author" };
  const slot = card({ ids: "7" }, { task: () => d });
  expect(await slot.findByText("Saved · 1")).toBeTruthy();
  expect(slot.queryByText(/Curated/)).toBeNull();
});
