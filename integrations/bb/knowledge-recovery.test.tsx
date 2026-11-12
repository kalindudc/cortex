// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { type Action, toast } from "sonner";
import { afterEach, expect, test, vi } from "vitest";
import { workstreamRpcContract as contract } from "./workstream-contract";
import { KnowledgeActions } from "./ui/knowledge";
import { NeedsYou } from "./ui/review";
import { knowledgeDecisionMessage } from "./ui/knowledge-decisions";
import type { Knowledge, Workstream } from "./ui/types";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const at = "2026-11-11T12:00:00.000Z";
const actor = { id: "person", type: "human" } as const;
const ws: Workstream = { id: "ws_envoy", name: "Envoy cluster-service", description: "", revision: 1, archived: false, actor, createdAt: at, updatedAt: at };
const entry: Knowledge = { id: "kn_current", workstreamId: ws.id, subject: "current", title: "Current rule", text: "Current rule text", kind: "directive", state: "disputed", facet: "orientation", applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } }, sources: [{ ref: "test:source", authorType: "human", observedAt: at }], revision: 2, actor, createdAt: at, updatedAt: at, expiresAt: null, approval: { actor, at }, supersedes: [], conflicts: ["kn_old"], supersededBy: null };
const old: Knowledge = { ...entry, id: "kn_old", subject: "old", title: "Never write to production Kubernetes clusters by hand", state: "archived", conflicts: [entry.id, "kn_older"] };
function setup(initial = entry, partners = [old], queue = true, fail?: (input: { state: string }) => string | null) {
  const entries = new Map([initial, ...partners].map(row => [row.id, row]));
  const rpc: Partial<PluginRpcTestHandlers<typeof contract>> = {
    reviewQueue: () => ({ items: [entries.get(initial.id)!].filter(row => ["candidate", "disputed", "recheck"].includes(row.state)).map(row => ({ entry: row, workstream: ws, hints: [] })), total: 1, limit: 100, offset: 0 }),
    knowledgeShow: ({ id }) => ({ entry: entries.get(id)!, workstream: ws }),
    knowledgeTransition: input => {
      const message = fail?.(input);
      if (message) throw new Error(message);
      const changed = { ...entries.get(input.id)!, state: input.state, revision: entries.get(input.id)!.revision + 1 };
      entries.set(input.id, changed);
      return { outcome: "updated", entry: changed };
    },
    knowledgeEdit: input => {
      const changed = { ...entries.get(input.id)!, state: "candidate" as const, approval: null, revision: entries.get(input.id)!.revision + 1 };
      entries.set(input.id, changed);
      return { outcome: "updated", entry: changed };
    },
  };
  const component = queue ? NeedsYou : () => <KnowledgeActions entry={initial} workstream={ws} />;
  const slot = renderSlot({ component }, {}, { rpc: rpc as PluginRpcTestHandlers<typeof contract>, experimental_rpcContract: contract, sidebarThreads: { sections: [], threads: [] } });
  return { slot, entries };
}
async function menu(slot: ReturnType<typeof setup>["slot"], title: string) {
  fireEvent.keyDown(slot.getByRole("button", { name: `More actions for ${title}` }), { key: "ArrowDown" });
  return slot.findByRole("menu");
}
async function undo() {
  const action = vi.mocked(toast).mock.calls.map(call => call[1]?.action).find(Boolean) as Action;
  expect(action?.label).toBe("Undo");
  await act(async () => { await action.onClick({} as React.MouseEvent<HTMLButtonElement>); });
}

test.each([
  ["Historical entries cannot acquire active relations", "The other entry is already in history and cannot be replaced. Review the refreshed choices; choose Approve this if no live conflicts remain."],
  ["Resolve conflicts through explicit supersession before approving", "A live entry still disputes this. Compare the entries and choose which one replaces the other."],
  ["Additional conflicts require separate resolution; no partial approval", "More live conflicts remain, so nothing was approved. Compare the remaining entries and resolve those conflicts separately before approving."],
  ["revision conflict for kn_current", "This entry changed before the decision was saved. Review the refreshed choices and choose again."],
])("maps guard failure %s to a next step", (raw, plain) => {
  expect(knowledgeDecisionMessage(new Error(`cortex workstream mutate failed: ${raw}`))).toBe(plain);
});

test("candidate with a disputed live partner offers replacement, not plain approval", async () => {
  const { slot } = setup({ ...entry, state: "candidate" }, [{ ...old, state: "disputed" }]);
  await slot.findByRole("radio", { name: /Approve and replace/ });
  expect(slot.queryByRole("radio", { name: /^Approve Threads/ })).toBeNull();
});

test.each(["candidate", "recheck"] as const)("review %s Archive Undo uses the previous state's operation", async state => {
  const saved = { ...entry, state, conflicts: [] };
  const { slot } = setup(saved, [], state !== "candidate");
  if (state === "candidate") {
    fireEvent.click(within(await menu(slot, saved.title)).getByText("Archive…"));
    fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Archive" }));
  } else {
    fireEvent.click(await slot.findByRole("radio", { name: /Archive this/ }));
    fireEvent.click(slot.getByRole("button", { name: "Confirm: Archive this" }));
  }
  await waitFor(() => expect(toast).toHaveBeenCalled());
  await undo();
  expect(slot.rpcCalls.filter(call => call.method === (state === "candidate" ? "knowledgeEdit" : "knowledgeTransition")).at(-1)?.input).toMatchObject({ id: saved.id, expectedRevision: 3, ...(state === "recheck" ? { state: "recheck" } : {}) });
});

test("review Reject Undo restores a candidate using edit", async () => {
  const { slot } = setup({ ...entry, state: "candidate", conflicts: [] }, []);
  fireEvent.click(await slot.findByRole("radio", { name: /Reject/ }));
  fireEvent.click(slot.getByRole("button", { name: "Confirm: Reject" }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  await undo();
  expect(slot.rpcCalls.find(call => call.method === "knowledgeEdit")?.input).toMatchObject({ id: entry.id, expectedRevision: 3 });
});

test("reported archived conflict offers approval, historical labels and no impossible replacement", async () => {
  const { slot } = setup();
  const option = await slot.findByRole("radio", { name: /Approve this/ });
  expect(option.textContent).toContain(`${old.title} is archived`);
  expect(slot.queryByRole("radio", { name: /replace/i })).toBeNull();
  expect(slot.getByText("Archived, disputed this")).toBeTruthy();
  fireEvent.click(option);
  fireEvent.click(slot.getByRole("button", { name: "Confirm: Approve this" }));
  await waitFor(() => expect(slot.rpcCalls.find(call => call.method === "knowledgeTransition")?.input).toMatchObject({ state: "approved", expectedRevision: 2 }));
});

test("all conflict partners load before options, including a live fourth partner on a candidate", async () => {
  const partners = Array.from({ length: 4 }, (_, index): Knowledge => ({ ...old, id: `kn_partner${index}`, title: `Partner ${index}`, state: index === 3 ? "approved" : "archived" }));
  const { slot } = setup({ ...entry, state: "candidate", conflicts: partners.map(row => row.id) }, partners);
  await slot.findByRole("radio", { name: /Approve and replace Partner 3/ });
  expect(slot.queryByRole("radio", { name: /^Approve Threads/ })).toBeNull();
  expect(slot.rpcCalls.filter(call => call.method === "knowledgeShow").map(call => call.input)).toContainEqual({ id: partners[3]!.id });
});

test("failed decision explains the refusal and refetches the queue and partners to recompute options", async () => {
  let change = () => {};
  const message = "cortex workstream mutate failed: Resolve conflicts through explicit supersession before approving";
  const { slot, entries } = setup(entry, [old], true, () => { change(); return message; });
  change = () => { entries.set(old.id, { ...old, state: "approved", revision: 4 }); entries.set(entry.id, { ...entry, revision: 3 }); };
  fireEvent.click(await slot.findByRole("radio", { name: /Approve this/ }));
  const queueReads = slot.rpcCalls.filter(call => call.method === "reviewQueue").length;
  const partnerReads = slot.rpcCalls.filter(call => call.method === "knowledgeShow").length;
  fireEvent.click(slot.getByRole("button", { name: "Confirm: Approve this" }));
  await slot.findByText(/A live entry still disputes this\. Compare the entries and choose which one replaces the other\./);
  expect(slot.getByText(message)).toBeTruthy();
  await slot.findByRole("radio", { name: /Keep this, replace/ });
  expect(slot.queryByRole("radio", { name: /Approve this/ })).toBeNull();
  expect(slot.rpcCalls.filter(call => call.method === "reviewQueue").length).toBeGreaterThan(queueReads);
  expect(slot.rpcCalls.filter(call => call.method === "knowledgeShow").length).toBeGreaterThan(partnerReads);
});

for (const state of ["archived", "rejected"] as const) {
  test(`${state} can restore to review with a confirmed reason-only edit`, async () => {
    const saved = { ...entry, state, conflicts: [] };
    const { slot } = setup(saved, [], false);
    fireEvent.click(within(await menu(slot, saved.title)).getByText("Restore to review"));
    const dialog = await slot.findByRole("dialog", { name: `Restore ${saved.title} to review?` });
    expect(dialog.textContent).toContain("Not approved");
    expect(slot.rpcCalls.filter(call => call.method === "knowledgeEdit")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore to review" }));
    await waitFor(() => expect(slot.rpcCalls.find(call => call.method === "knowledgeEdit")?.input).toEqual({ id: saved.id, expectedRevision: saved.revision, reason: "Restored to review in Cortex" }));
  });
}

test.each([
  ["archived", true, false, true], ["archived", false, false, false], ["archived", true, true, false], ["rejected", true, false, false],
] as const)("restore approval gate: %s approvedBefore=%s liveConflict=%s offered=%s", async (state, approvedBefore, liveConflict, offered) => {
  const saved = { ...entry, state, approval: approvedBefore ? entry.approval : null, conflicts: liveConflict ? [old.id] : [] };
  const { slot } = setup(saved, liveConflict ? [{ ...old, state: "approved" }] : [], false);
  const popup = await menu(slot, saved.title);
  await waitFor(() => expect(Boolean(within(popup).queryByText("Restore and approve"))).toBe(offered));
  if (offered) {
    fireEvent.click(within(popup).getByText("Restore and approve"));
    const dialog = await slot.findByRole("dialog", { name: `Restore and approve ${saved.title}?` });
    expect(dialog.textContent).toContain("next session");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore and approve" }));
    await waitFor(() => expect(slot.rpcCalls.find(call => call.method === "knowledgeTransition")?.input).toMatchObject({ state: "approved" }));
  }
});

for (const state of ["superseded", "forgotten"] as const) {
  test(`${state} has no restore and explains why`, async () => {
    const { slot } = setup({ ...entry, state }, [], false);
    expect(slot.getByText(state === "forgotten" ? "Forgotten text is gone and cannot be restored." : "Superseded knowledge needs a separate replacement decision, not restore.")).toBeTruthy();
    if (state !== "forgotten") expect(within(await menu(slot, entry.title)).queryByText(/Restore/)).toBeNull();
  });
}

test("review Archive Undo returns disputed knowledge to review via edit", async () => {
  const { slot } = setup();
  fireEvent.click(await slot.findByRole("radio", { name: /Archive this/ }));
  fireEvent.click(slot.getByRole("button", { name: "Confirm: Archive this" }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  await undo();
  expect(slot.rpcCalls.find(call => call.method === "knowledgeEdit")?.input).toMatchObject({ id: entry.id, expectedRevision: 3 });
});

test("knowledge Archive Undo restores approved with the returned revision", async () => {
  const saved = { ...entry, state: "approved" as const, conflicts: [] };
  const { slot } = setup(saved, [], false);
  fireEvent.click(within(await menu(slot, saved.title)).getByText("Archive…"));
  const dialog = await slot.findByRole("dialog", { name: `Archive ${saved.title}?` });
  fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  await undo();
  expect(slot.rpcCalls.filter(call => call.method === "knowledgeTransition").at(-1)?.input).toMatchObject({ state: "approved", expectedRevision: 3 });
});

test("failed restore confirmation shows a plain next step rather than the CLI wrapper", async () => {
  const saved = { ...entry, state: "archived" as const, conflicts: [] };
  const raw = "cortex workstream mutate failed: Resolve conflicts through explicit supersession before approving";
  const { slot } = setup(saved, [], false, () => raw);
  fireEvent.click(within(await menu(slot, saved.title)).getByText("Restore and approve"));
  const dialog = await slot.findByRole("dialog", { name: `Restore and approve ${saved.title}?` });
  fireEvent.click(within(dialog).getByRole("button", { name: "Restore and approve" }));
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("A live entry still disputes this.");
  expect(alert.textContent).not.toContain("cortex workstream mutate failed");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(slot.getByText(raw)).toBeTruthy();
});

test("failed Undo explains a revision mismatch and keeps the raw detail", async () => {
  const saved = { ...entry, state: "approved" as const, conflicts: [] };
  const { slot } = setup(saved, [], false, input => input.state === "approved" ? "revision conflict; input was not applied" : null);
  fireEvent.click(within(await menu(slot, saved.title)).getByText("Archive…"));
  fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  await undo();
  expect(toast.error).toHaveBeenCalledWith("Could not undo. This entry changed before the decision was saved. Review the refreshed choices and choose again.", expect.objectContaining({ description: "revision conflict; input was not applied" }));
});
