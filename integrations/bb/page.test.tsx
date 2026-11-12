// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { sectionRpcContract, type Section, type SectionEligibility } from "./section-contract";
import { workstreamRpcContract } from "./workstream-contract";
import { CortexSidebar, parseRoute, useCortexPageTitle } from "./ui/page";
import type { Knowledge, Workstream } from "./ui/types";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
const contract = { ...workstreamRpcContract, ...sectionRpcContract };
const now = "2026-11-11T12:00:00.000Z";
const actor = { id: "kal", type: "human" } as const;
const ws: Workstream = { id: "ws_envoy", name: "Envoy cluster-service", description: "Replacing the ingress controller", revision: 1, archived: false, actor, createdAt: now, updatedAt: now };
const entry: Knowledge = { id: "kn_bootstrap", workstreamId: ws.id, subject: "bootstrap", title: "Staging uses the new bootstrap", text: "Staging is on the new bootstrap.", kind: "finding", state: "candidate", facet: "orientation", applicability: { environment: { mode: "unknown" }, host: { mode: "unknown" } }, sources: [], revision: 1, actor, createdAt: now, updatedAt: now, expiresAt: null, approval: null, supersedes: [], conflicts: [], supersededBy: null };
const sidebarThread: PluginSidebarThread = { id: "thr_aaaaaaaa", sectionId: "sec_envoy", displayTitle: "Inspect staging", projectId: "proj_sample", title: "Inspect staging", titleFallback: null, parentThreadId: null, lifecycleOwnerThreadId: null, parentNotifications: "auto", sourceThreadId: null, originKind: null, originPluginId: null, providerId: "pi", status: "idle", runtimeStatus: "idle", queuedWork: "none", hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 }, indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false, pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null, href: "/projects/proj_sample/threads/thr_aaaaaaaa", isHidden: false, environment: null, host: null, createdAt: 0, updatedAt: 0, lastReadAt: null, latestAttentionAt: 0 };
const marker = { status: "unmarked", originalTitle: null, decoratedTitle: null, error: null } as const;
function section(id: string, name: string, bound: boolean): Section {
  return { id, name, canonicalName: name, threadCount: bound ? 16 : 203, marker, connectionJob: null, binding: { key: id, revision: bound ? 1 : 0, binding: bound ? { workstreamId: ws.id, topic: null, budgetTokens: 1000, requiredKnowledgeIds: [] } : null } };
}
const shared = section("sec_envoy", "Envoy cluster-service", true);
const unshared = section("sec_local", "local-dev", false);
let app: Awaited<ReturnType<typeof loadPluginApp>>;
beforeAll(async () => { app = await loadPluginApp(() => import("./app")); });
afterEach(cleanup);

function fixture(sections = [unshared, shared]) {
  let fail = false;
  let items = [{ entry, workstream: ws, hints: [] }, { entry: { ...entry, id: "kn_disputed", state: "disputed" as const }, workstream: ws, hints: [] }];
  const eligibility: SectionEligibility = { computedAt: now, status: "ready", error: null, entries: [{ knowledge: { ...entry, state: "approved", approval: { actor, at: now } }, text: entry.text, estimatedTokens: 100, overrideActor: null, origin: "canonical" }], notices: [], exclusions: [{ id: "kn_held", reason: "candidate" }], exactText: entry.text, estimatedTokens: 100, budgetTokens: 1000 };
  const rpc: Partial<PluginRpcTestHandlers<typeof contract>> = {
    sectionList: () => { if (fail) throw new Error("Refresh unavailable"); return { sections }; },
    sectionBindings: () => ({ bindings: sections.map(s => s.binding) }),
    sectionDetail: ({ sectionId }) => ({ section: sections.find(s => s.id === sectionId)!, threads: [], eligibility, review: { items, total: items.length, limit: 50, offset: 0 } }),
    workstreamList: ({ archived }) => ({ workstreams: archived ? [ws, { ...ws, id: "ws_archived", name: "Archived brief", archived: true }] : [ws], total: archived ? 2 : 1, limit: 100, offset: 0 }),
    workstreamShow: ({ id, limit = 100, offset = 0 }) => ({ workstream: { ...ws, id }, entries: [{ ...entry, state: "approved", approval: { actor, at: now } }, { ...entry, id: "kn_waiting" }], total: 2, limit, offset }),
    reviewQueue: () => ({ items, total: items.length, limit: 100, offset: 0 }),
  };
  const options = { rpc: rpc as PluginRpcTestHandlers<typeof contract>, experimental_rpcContract: contract, sidebarThreads: { sections: sections.map(s => ({ id: s.id, name: s.name, createdAt: Date.parse(now), updatedAt: Date.parse(now) })), threads: [sidebarThread] } };
  return { options, eligibility, fail: () => { fail = true; }, emptyReview: () => { items = []; } };
}
const lastNavigation = (slot: ReturnType<typeof renderSlot>) => slot.inspection.navigateCalls.at(-1);

test.each(["over-budget", "missing-required", "unavailable", "unbound"] as const)("overview and sidebar say nothing is sent for %s", async status => {
  const backend = fixture([shared]);
  backend.eligibility.status = status;
  const overview = renderSlot(app.navPanels[0]!, { subPath: "" }, backend.options);
  await overview.findByText(/Sends nothing:/);
  expect(overview.container.textContent).not.toMatch(/1 in/);
  overview.unmount();
  const sidebar = renderSlot({ component: CortexSidebar }, { subPath: "" }, backend.options);
  await sidebar.findByText(/Sends nothing:/);
  expect(sidebar.container.textContent).not.toMatch(/1 in/);
});

describe("page route contract", () => {
  test.each([
    ["", { kind: "overview" }],
    ["review", { kind: "review" }],
    ["workstreams", { kind: "workstreams" }],
    ["library", { kind: "library" }],
    ["bindings", { kind: "bindings" }],
    ["threads/thr_aaaaaaaa", { kind: "thread", threadId: "thr_aaaaaaaa" }],
    ["workstreams/ws_envoy", { kind: "workstream", id: "ws_envoy", entryId: null }],
    ["workstreams/ws_envoy/kn_bootstrap", { kind: "workstream", id: "ws_envoy", entryId: "kn_bootstrap" }],
    ["sections/sec_envoy", { kind: "section", id: "sec_envoy", tab: "brief", entryId: null, connect: false }],
    ["sections/sec_envoy/knowledge/kn_bootstrap", { kind: "section", id: "sec_envoy", tab: "knowledge", entryId: "kn_bootstrap", connect: false }],
    ["sections/sec_envoy/brief/kn_bootstrap", { kind: "section", id: "sec_envoy", tab: "brief", entryId: "kn_bootstrap", connect: false }],
    ["sections/sec_envoy/drafts", { kind: "section", id: "sec_envoy", tab: "drafts", entryId: null, connect: false }],
    ["sections/sec_envoy/edits", { kind: "section", id: "sec_envoy", tab: "edits", entryId: null, connect: false }],
    ["sections/sec_envoy?connect=1", { kind: "section", id: "sec_envoy", tab: "brief", entryId: null, connect: true }],
    ["sections/sec_envoy/connect", { kind: "section", id: "sec_envoy", tab: "brief", entryId: null, connect: true }],
    ["sections/%73ec_envoy/knowledge/%6Bn_bootstrap", { kind: "section", id: "sec_envoy", tab: "knowledge", entryId: "kn_bootstrap", connect: false }],
  ])("parses %s", (path, expected) => expect(parseRoute(path as string)).toEqual(expected));
  test.each(["unknown", "sections", "sections/%zz", "sections/sec_envoy/nope", "sections/sec_envoy/knowledge/nope", "workstreams/nope", "threads/nope", "library/extra"]) ("unknown route %s lands on Overview", path => expect(parseRoute(path)).toEqual({ kind: "overview" }));

  test.each(["", "/kn_bootstrap"]) ("a single-bound workstream deep link redirects with replace%s", async suffix => {
    const backend = fixture();
    const slot = renderSlot(app.navPanels[0]!, { subPath: `workstreams/ws_envoy${suffix}` }, backend.options);
    await waitFor(() => expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: `sections/sec_envoy/knowledge${suffix}`, replace: true } }));
  });
  test.each([{ sections: [] }, { sections: [shared, section("sec_second", "Other section", true)] }])("zero or multiple bindings keep the workstream page", async ({ sections }) => {
    const backend = fixture(sections);
    const slot = renderSlot(app.navPanels[0]!, { subPath: "workstreams/ws_envoy" }, backend.options);
    expect((await slot.findAllByRole("button", { name: "Edit" })).length).toBeGreaterThan(0);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });
  test("a failed bindings read does not redirect from stale connection data", async () => {
    const backend = fixture();
    backend.options.rpc.sectionBindings = () => { throw new Error("Connections unavailable"); };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "workstreams/ws_envoy/kn_bootstrap" }, backend.options);
    await slot.findByText(/Connections unavailable/);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  test("bindings redirects to Overview with replace", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "bindings" }, fixture().options);
    await waitFor(() => expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: "", replace: true } }));
  });
});

describe("sidebar", () => {
  afterEach(() => localStorage.clear());
  test("Review counts every review item, while section badges count candidates only", async () => {
    const slot = renderSlot({ component: CortexSidebar }, { subPath: "" }, fixture().options);
    const review = await slot.findByRole("button", { name: "Review 2 waiting" });
    expect(slot.getByRole("button", { name: "Envoy cluster-service 1 waiting" }).querySelector('[data-icon="Brain"]')?.getAttribute("class")).toContain("text-primary");
    fireEvent.click(slot.getByRole("button", { name: "Not shared 1 section" }));
    expect(slot.getByRole("button", { name: "local-dev" }).textContent).toBe("local-dev");
    expect(slot.getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    expect(slot.getByRole("button", { name: "Workstreams 1 workstream" })).toBeTruthy();
    expect(slot.queryByText("Advanced workstreams")).toBeNull();
    expect(slot.queryByRole("button", { name: "Connections" })).toBeNull();
    fireEvent.click(review);
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "review" } });
    fireEvent.click(slot.getByRole("button", { name: "Workstreams 1 workstream" }));
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "workstreams" } });
  });
  test.each([["review", "Review 2 waiting"], ["library", "Library"], ["workstreams", "Workstreams 1 workstream"]])("%s marks its navigation row current", async (subPath, name) => {
    const slot = renderSlot({ component: CortexSidebar }, { subPath }, fixture().options);
    expect((await slot.findByRole("button", { name })).getAttribute("aria-current")).toBe("page");
    fireEvent.click(slot.getByRole("button", { name: "Not shared 1 section" }));
    fireEvent.click(slot.getByRole("button", { name: "local-dev" }));
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "sections/sec_local" } });
  });
  test("sections that are not shared fold away, remember the fold and keep the open one", async () => {
    const slot = renderSlot({ component: CortexSidebar }, { subPath: "" }, fixture().options);
    const fold = await slot.findByRole("button", { name: "Not shared 1 section" });
    expect(slot.queryByRole("button", { name: "local-dev" })).toBeNull();
    fireEvent.click(fold);
    expect(slot.getByRole("button", { name: "local-dev" })).toBeTruthy();
    slot.lifecycle.unmount();
    const again = renderSlot({ component: CortexSidebar }, { subPath: "" }, fixture().options);
    expect(await again.findByRole("button", { name: "local-dev" })).toBeTruthy();
    again.lifecycle.unmount();
    localStorage.clear();
    const open = renderSlot({ component: CortexSidebar }, { subPath: "sections/sec_local" }, fixture().options);
    expect((await open.findByRole("button", { name: "local-dev" })).getAttribute("aria-current")).toBe("page");
  });
  test("with nothing shared every section shows without a fold", async () => {
    const slot = renderSlot({ component: CortexSidebar }, { subPath: "" }, fixture([unshared]).options);
    expect(await slot.findByRole("button", { name: "local-dev" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: /Not shared/ })).toBeNull();
  });
  test("a shared section shows its brief under its name", async () => {
    const slot = renderSlot({ component: CortexSidebar }, { subPath: "" }, fixture().options);
    const row = await slot.findByRole("button", { name: "Envoy cluster-service 1 waiting" });
    await waitFor(() => expect(within(row).getByRole("img", { name: /100 of 1000 tokens/ })).toBeTruthy());
    expect(row.textContent).toContain("1 in · 1 held");
  });
  test("rows stay compact on a wide pointer screen and grow only for touch or a narrow viewport", async () => {
    const slot = renderSlot({ component: CortexSidebar }, { subPath: "" }, fixture().options);
    const className = (await slot.findByRole("button", { name: "Overview" })).getAttribute("class") ?? "";
    expect(className).toContain("min-h-8");
    expect(className).not.toMatch(/@max-\[/);
    expect(className).toContain("max-[576px]:min-h-11");
    expect(className).toContain("[@media(pointer:coarse)]:min-h-11");
  });
  test.each(["sections/sec_envoy/knowledge/kn_bootstrap", "threads/thr_aaaaaaaa"]) ("%s marks its section current", async subPath => {
    const slot = renderSlot({ component: CortexSidebar }, { subPath }, fixture().options);
    expect((await slot.findByRole("button", { name: "Envoy cluster-service 1 waiting" })).getAttribute("aria-current")).toBe("page");
  });
});

describe("Overview", () => {
  test("shows review, bound briefs first and a separate Connect intent", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, fixture().options);
    await slot.findByText("waiting for your review");
    expect(slot.getByText(/oldest/)).toBeTruthy();
    expect(slot.getByText(/1 new finding/)).toBeTruthy();
    expect(slot.getByText(/1 disputed/)).toBeTruthy();
    await slot.findByRole("img", { name: /100 of 1000 tokens/ });
    expect(slot.getByText("1 in · 1 held")).toBeTruthy();
    expect(slot.getByText("Not shared · 1")).toBeTruthy();
    const rows = slot.getAllByRole("row");
    expect(rows[1]!.textContent).toContain("Envoy cluster-service");
    fireEvent.click(slot.getByRole("button", { name: "Connect local-dev" }));
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "sections/sec_local/connect" } });
    fireEvent.click(slot.getByRole("button", { name: "Open Envoy cluster-service" }));
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "sections/sec_envoy" } });
  });
  test("empty review and sections have explicit statuses", async () => {
    const backend = fixture([]); backend.emptyReview();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, backend.options);
    await slot.findByText("Nothing waits for your review.");
    expect(slot.getByText("No bb sections yet.")).toBeTruthy();
  });
  test("an initial failure has a retry, never a fabricated empty review", async () => {
    const backend = fixture();
    backend.options.rpc.reviewQueue = () => { throw new Error("Review unavailable"); };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, backend.options);
    await slot.findByText(/Review unavailable/);
    expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(slot.queryByText("Nothing waits for your review.")).toBeNull();
  });
  test("waiting chips and the summary open Review; section row facts open the section", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, fixture().options);
    fireEvent.click(await slot.findByRole("button", { name: "Review 1 waiting in Envoy cluster-service" }));
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "review" } });
    fireEvent.click(slot.getByRole("button", { name: "Review" }));
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "review" } });
    fireEvent.click(slot.getByText("203"));
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "sections/sec_local" } });
  });
  test("loading is not reported as an empty review", async () => {
    const backend = fixture();
    backend.options.rpc.sectionList = () => new Promise(() => {});
    backend.options.rpc.reviewQueue = () => new Promise(() => {});
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, backend.options);
    expect(slot.getByRole("status", { name: "Loading sections" })).toBeTruthy();
    expect(slot.queryByText("Nothing waits for your review.")).toBeNull();
  });
  test("refresh failures preserve loaded sections with a retry", async () => {
    const backend = fixture();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, backend.options);
    await slot.findByText("Not shared · 1"); backend.fail();
    await act(async () => { await slot.behavior.emitRealtime("workstreams", { sectionId: shared.id }); });
    await slot.findByText(/Refresh unavailable/);
    expect(slot.getByRole("button", { name: "Open local-dev" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("Workstreams list", () => {
  test("row menu edits the existing workstream with its revision guard", async () => {
    const backend = fixture();
    backend.options.rpc.workstreamEdit = input => ({ outcome: "updated", workstream: { ...ws, name: input.name ?? ws.name, revision: 2 } });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "workstreams" }, backend.options);
    await act(async () => { fireEvent.keyDown(await slot.findByRole("button", { name: "Actions for Envoy cluster-service" }), { key: "Enter" }); });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Edit…" }));
    const dialog = await slot.findByRole("dialog", { name: "Edit Envoy cluster-service" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Envoy rollout" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter(call => call.method === "workstreamEdit").map(call => call.input)).toEqual([{ id: ws.id, expectedRevision: 1, name: "Envoy rollout", reason: "Edited in Cortex" }]));
  });
  test("row archive retains confirmation, consequence facts and its revision guard", async () => {
    const backend = fixture();
    backend.options.rpc.workstreamEdit = () => ({ outcome: "updated", workstream: { ...ws, archived: true, revision: 2 } });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "workstreams" }, backend.options);
    await act(async () => { fireEvent.keyDown(await slot.findByRole("button", { name: "Actions for Envoy cluster-service" }), { key: "Enter" }); });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Archive…" }));
    const dialog = await slot.findByRole("dialog", { name: "Archive Envoy cluster-service?" });
    for (const fact of ["Connected threads stop getting its knowledge from their next session.", "Its knowledge and history stay readable.", "Sessions already running keep what they received."]) expect(within(dialog).getAllByText(fact).length).toBeGreaterThan(0);
    expect(slot.inspection.rpcCalls.filter(call => call.method === "workstreamEdit")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter(call => call.method === "workstreamEdit").map(call => call.input)).toEqual([{ id: ws.id, expectedRevision: 1, archived: true, reason: "Archived in Cortex" }]));
  });
  test("counts load lazily and stop at one page with honest lower bounds", async () => {
    const backend = fixture();
    const entries = Array.from({ length: 101 }, (_, i) => ({ ...entry, id: `kn_count_${i}`, state: i < 100 ? "approved" as const : "candidate" as const }));
    backend.options.rpc.workstreamShow = ({ limit = 100, offset = 0 }) => ({ workstream: ws, entries: entries.slice(offset, offset + limit), total: entries.length, limit, offset });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "workstreams" }, backend.options);
    const load = await slot.findByRole("button", { name: "Load counts for Envoy cluster-service" });
    expect(slot.inspection.rpcCalls.filter(call => call.method === "workstreamShow")).toHaveLength(0);
    fireEvent.click(load);
    expect(await slot.findByText("At least 100")).toBeTruthy();
    expect(slot.getByText("At least 0")).toBeTruthy();
    expect(slot.inspection.rpcCalls.filter(call => call.method === "workstreamShow").map(call => call.input)).toEqual([{ id: ws.id, limit: 100, offset: 0 }]);
    await act(() => slot.behavior.emitRealtime("workstreams", { workstreamId: ws.id }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter(call => call.method === "workstreamShow")).toHaveLength(2));
    expect(slot.inspection.rpcCalls.filter(call => call.method === "workstreamShow").every(call => (call.input as { offset: number }).offset === 0)).toBe(true);
  });
  test("a failed count keeps the workstream reachable and never claims zero", async () => {
    const backend = fixture();
    backend.options.rpc.workstreamShow = () => { throw new Error("Counts unavailable"); };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "workstreams" }, backend.options);
    fireEvent.click(await slot.findByRole("button", { name: "Load counts for Envoy cluster-service" }));
    await slot.findByText(/Counts unavailable/);
    expect(slot.getByRole("button", { name: "Open Envoy cluster-service knowledge" })).toBeTruthy();
    expect(slot.getByLabelText("Approved count unavailable")).toBeTruthy();
    expect(slot.getByLabelText("Waiting count unavailable")).toBeTruthy();
  });
  test("multiple sections keep a row pointed at the workstream and chips open each section", async () => {
    const backend = fixture([shared, section("sec_second", "Other section", true)]);
    const slot = renderSlot(app.navPanels[0]!, { subPath: "workstreams" }, backend.options);
    await slot.findByRole("button", { name: "Other section" });
    fireEvent.click(slot.getByRole("button", { name: "Open Envoy cluster-service knowledge" }));
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "workstreams/ws_envoy" } });
    fireEvent.click(slot.getByRole("button", { name: "Other section" }));
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "sections/sec_second" } });
  });
  test("an empty list retains creation", async () => {
    const backend = fixture();
    backend.options.rpc.workstreamList = () => ({ workstreams: [], total: 0, limit: 100, offset: 0 });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "workstreams" }, backend.options);
    await slot.findByText("No active workstreams yet.");
    expect(slot.getByRole("button", { name: "New workstream" })).toBeTruthy();
  });
  test("has counts, Used by chips, archived toggle and creation", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "workstreams" }, fixture().options);
    await slot.findByRole("button", { name: "Open Envoy cluster-service knowledge" });
    const table = slot.getByRole("table", { name: "Workstreams" });
    expect(within(table).getByText("Replacing the ingress controller")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Load counts for Envoy cluster-service" }));
    await waitFor(() => expect(within(table).getAllByText("1")).toHaveLength(2));
    fireEvent.click(slot.getByRole("button", { name: "Open Envoy cluster-service knowledge" }));
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "sections/sec_envoy/knowledge" } });
    fireEvent.click(slot.getByRole("button", { name: "Show archived" }));
    expect(slot.getByRole("button", { name: "Show archived" }).getAttribute("aria-pressed")).toBe("true");
    await slot.findByText("Archived brief");
    fireEvent.click(slot.getByRole("button", { name: "New workstream" }));
    expect(await slot.findByRole("dialog", { name: "New workstream" })).toBeTruthy();
  });
});

function PageTitle({ subPath }: { subPath: string }) { return <span>{useCortexPageTitle({ subPath })?.title}</span>; }
test.each([["", "Overview"], ["review", "Review"], ["bindings", "Overview"], ["workstreams", "Workstreams"], ["library", "Library"], ["sections/sec_envoy/knowledge", ws.name], ["workstreams/ws_envoy", ws.name], ["threads/thr_aaaaaaaa", "Inspect staging"]])("page title for %s is %s", async (subPath, title) => {
  const slot = renderSlot({ component: PageTitle }, { subPath }, fixture().options);
  expect(await slot.findByText(title)).toBeTruthy();
});
