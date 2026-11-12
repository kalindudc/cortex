// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, test, vi } from "vitest";
import type { CortexRunner } from "./cli";
import { createWorkstreams } from "./workstreams";
import { createSections } from "./sections";
import { workstreamHandlers } from "./workstream-rpc";
import { sectionHandlers } from "./section-rpc";
import { sectionRpcContract } from "./section-contract";
import { workstreamRpcContract } from "./workstream-contract";
import { SectionPage } from "./ui/sections";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const dispose of disposers.splice(0)) await dispose(); });
const contract = { ...workstreamRpcContract, ...sectionRpcContract };
const now = "2026-11-11T12:00:00.000Z";
const workstream = { id: "ws_one", name: "One", description: "", revision: 1, archived: false, actor: { id: "person", type: "human" }, createdAt: now, updatedAt: now };
function setup({ owned = true, title = "🧠 One", bound = true }: { owned?: boolean; title?: string; bound?: boolean } = {}) {
  let nativeTitle = title;
  let failRename = false;
  const update = vi.fn(async ({ id, name }: { id: string; name: string }) => {
    if (failRename) throw new Error("Sample title cleanup failure");
    nativeTitle = name;
    return { id, name, updatedThreadCount: 0 };
  });
  const host = createFakePluginHost({ pluginId: "cortex", sdk: {
    subscribe: () => () => {},
    threadSections: { list: async () => [{ id: "sec_one", name: nativeTitle, createdAt: 0, updatedAt: 0 }], update },
    threads: { list: async () => [] },
  } });
  disposers.push(() => host.harness.lifecycle.dispose());
  const runner: CortexRunner = { binary: "fake", async run(args, schema) {
    if (args[1] === "read") return schema.parse({ workstream, entries: [], notices: [], applicability: { environment: { mode: "unknown" }, host: { mode: "unknown" } }, topic: null });
    if (args[1] === "show") return schema.parse({ workstream, entries: [], total: 0, limit: 1, offset: 0 });
    if (args[1] === "list") return schema.parse({ workstreams: [workstream], total: 1, limit: 100, offset: 0 });
    if (args[1] === "knowledge") return schema.parse({ items: [], total: 0, limit: 50, offset: 0 });
    throw new Error(`Unexpected fake read: ${args.join(" ")}`);
  }, async text() { throw new Error("Legacy read forbidden"); } };
  const service = createWorkstreams(host.bb, runner, { userAuthor: "person", widgetDefault: () => true });
  if (bound) service.store.setSection("sec_one", 0, { workstreamId: workstream.id, topic: null, budgetTokens: 400, requiredKnowledgeIds: [] });
  if (owned) service.store.jobs.setMarker("sec_one", { status: "owned", originalTitle: "One", decoratedTitle: nativeTitle, error: null });
  const sections = createSections(host.bb, service);
  host.bb.rpc.register(contract, { ...workstreamHandlers(service, sections), ...sectionHandlers(sections) });
  const rpc = Object.fromEntries(Object.keys(contract).map(method => [method, (input: unknown) => host.harness.behavior.callRpc(method, input)])) as PluginRpcTestHandlers<typeof contract>;
  const slot = renderSlot({ component: SectionPage }, { id: "sec_one" }, { rpc, experimental_rpcContract: contract, sidebarThreads: { sections: [], threads: [] } });
  return { slot, service, update, title: () => nativeTitle, fail: (value: boolean) => { failRename = value; } };
}
const calls = (slot: ReturnType<typeof renderSlot>, method: string) => slot.inspection.rpcCalls.filter(call => call.method === method);
async function advanced(slot: ReturnType<typeof renderSlot>, action: string) {
  const opener = await slot.findByRole("button", { name: action === "Stop sharing…" ? "Sharing One" : "Advanced section actions" });
  fireEvent.keyDown(opener, { key: "Enter" });
  fireEvent.click(await slot.findByRole("menuitem", { name: action }));
}
async function stop(slot: ReturnType<typeof renderSlot>) {
  await advanced(slot, "Stop sharing…");
  const dialog = await slot.findByRole("dialog", { name: "Stop sharing context in this section?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop sharing" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  await slot.findByRole("button", { name: /^Share context in / });
}
test("SectionPage Stop keeps the native title and owned history until an explicit legacy Remove", async () => {
  const { slot, service, update, title } = setup();
  const owned = service.store.jobs.marker("sec_one");
  await stop(slot);
  expect(service.store.section("sec_one").binding).toBeNull();
  expect(title()).toBe("🧠 One");
  expect(service.store.jobs.marker("sec_one")).toEqual(owned);
  expect(calls(slot, "setSectionBinding")).toHaveLength(1);
  expect(calls(slot, "sectionTitleMark")).toHaveLength(0);
  expect(update).not.toHaveBeenCalled();
  expect(slot.queryByText(/Section title changed before the rename/)).toBeNull();
  await advanced(slot, "Remove title mark");
  await waitFor(() => expect(service.store.jobs.marker("sec_one").status).toBe("unmarked"));
  expect(title()).toBe("One");
  expect(service.store.section("sec_one").binding).toBeNull();
  expect(update).toHaveBeenCalledTimes(1);
  expect(calls(slot, "sectionTitleMark")[0]!.input).toEqual({ sectionId: "sec_one", expectedTitle: "🧠 One", action: "remove" });
  expect(calls(slot, "setSectionBinding")).toHaveLength(1);
});
test("an explicit Remove failure remains visible after Stop without automatic retry", async () => {
  const { slot, service, update, title, fail } = setup();
  fail(true);
  await advanced(slot, "Remove title mark");
  await slot.findByText(/Sharing and section titles are separate\. Sample title cleanup failure/);
  const failed = service.store.jobs.marker("sec_one");
  expect(failed.status).toBe("failed");
  expect(update).toHaveBeenCalledTimes(1);
  expect(calls(slot, "sectionTitleMark")).toHaveLength(1);
  fail(false);
  await stop(slot);
  expect(service.store.section("sec_one").binding).toBeNull();
  expect(title()).toBe("🧠 One");
  expect(service.store.jobs.marker("sec_one")).toEqual(failed);
  expect(update).toHaveBeenCalledTimes(1);
  expect(calls(slot, "sectionTitleMark")).toHaveLength(1);
  await slot.findByText(/Sharing and section titles are separate\. Sample title cleanup failure/);
  await advanced(slot, "Retry title cleanup");
  await waitFor(() => expect(service.store.jobs.marker("sec_one").status).toBe("unmarked"));
  await waitFor(() => expect(slot.queryByText(/Sample title cleanup failure/)).toBeNull());
  expect(title()).toBe("One");
  expect(update).toHaveBeenCalledTimes(2);
  expect(calls(slot, "sectionTitleMark")).toHaveLength(2);
  expect(calls(slot, "sectionTitleMark")[1]!.input).toEqual({ sectionId: "sec_one", expectedTitle: "🧠 One", action: "remove" });
});
test("SectionPage connects through public SDK and real backend without any native rename", async () => {
  const { slot, service, update, title } = setup({ owned: false, title: "One", bound: false });
  fireEvent.click(await slot.findByRole("button", { name: "Share context in One" }));
  const dialog = await slot.findByRole("dialog");
  expect(dialog.querySelector('[data-icon="Brain"]')).toBeTruthy();
  expect(dialog.textContent).not.toContain("🧠");
  fireEvent.click(within(dialog).getByRole("radio", { name: "Use One" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Share context" }));
  await waitFor(() => expect(service.store.section("sec_one").binding?.workstreamId).toBe(workstream.id));
  await slot.findByText("Sharing One");
  expect(title()).toBe("One");
  expect(update).not.toHaveBeenCalled();
  expect(calls(slot, "sectionTitleMark")).toHaveLength(0);
  expect(calls(slot, "sectionConnect")[0]!.input).toMatchObject({ markTitle: false });
});

test("stopping sharing never strips or renames an unowned user-authored title", async () => {
  const { slot, service, update, title } = setup({ owned: false, title: "🧠 My own name" });
  const root = await slot.findByLabelText("Cortex section: 🧠 My own name");
  expect(root.querySelector('[data-icon="Brain"]')).toBeTruthy();
  await stop(slot);
  expect(service.store.section("sec_one").binding).toBeNull();
  expect(title()).toBe("🧠 My own name");
  expect(update).not.toHaveBeenCalled();
  expect(calls(slot, "sectionTitleMark")).toHaveLength(0);
});

test("an unbound section retains an explicit ownership-safe legacy Remove action", async () => {
  const { slot, service, update, title } = setup({ bound: false });
  await advanced(slot, "Remove title mark");
  await waitFor(() => expect(service.store.jobs.marker("sec_one").status).toBe("unmarked"));
  expect(title()).toBe("One");
  expect(service.store.section("sec_one").binding).toBeNull();
  expect(update).toHaveBeenCalledTimes(1);
  expect(calls(slot, "sectionTitleMark")[0]!.input).toEqual({ sectionId: "sec_one", expectedTitle: "🧠 One", action: "remove" });
  expect(calls(slot, "setSectionBinding")).toHaveLength(0);
});

test("standalone title removal remains a separate explicit action while sharing continues", async () => {
  const { slot, service, title } = setup();
  await advanced(slot, "Remove title mark");
  await waitFor(() => expect(service.store.jobs.marker("sec_one").status).toBe("unmarked"));
  expect(title()).toBe("One");
  expect(service.store.section("sec_one").binding?.workstreamId).toBe(workstream.id);
  expect(calls(slot, "sectionTitleMark")).toHaveLength(1);
  expect(calls(slot, "setSectionBinding")).toHaveLength(0);
});
