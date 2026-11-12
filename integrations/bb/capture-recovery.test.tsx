// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "sonner";
import { sectionRpcContract, type CaptureInput, type CaptureJob, type Section } from "./section-contract";
import { SOURCE_EXCERPT_LIMIT_MESSAGE } from "./workstream-contract";
import { failureOf } from "./ui/data";
import { CompactViewportOverrideProvider } from "./components/ui/hooks/use-compact-viewport";
import { CaptureDialog, type CaptureSeed } from "./ui/takeaway";
import type { Knowledge } from "./ui/types";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const threadId = "thr_aaaaaaaa";
const uuid1 = "aeb54512-b67f-44d8-9a7e-024b033c9011";
const uuid2 = "aeb54512-b67f-44d8-9a7e-024b033c9012";
const now = "2026-11-11T12:00:00.000Z";
const where = { environment: { mode: "unknown" }, host: { mode: "unknown" } } as const;
const section: Section = { id: "sec_envoy", name: "Envoy", canonicalName: "Envoy", threadCount: 1, marker: { status: "unmarked", originalTitle: null, decoratedTitle: null, error: null }, connectionJob: null, binding: { key: "sec_envoy", revision: 1, binding: { workstreamId: "ws_envoy", topic: null, budgetTokens: 400, requiredKnowledgeIds: [] } } };
const entry: Knowledge = { id: "kn_capture", workstreamId: "ws_envoy", subject: "capture", title: "Captured", text: "Captured text", kind: "finding", state: "candidate", facet: "orientation", applicability: where, sources: [], revision: 1, actor: { id: "person", type: "human" }, createdAt: now, updatedAt: now, expiresAt: null, approval: null, supersedes: [], conflicts: [], supersededBy: null };
const messageSource = { kind: "message", threadId, messageId: "msg_source", messageSeq: 31 } as const;
const saved = (input: Pick<CaptureInput, "requestId" | "sectionId">): CaptureJob => ({ requestId: input.requestId, sectionId: input.sectionId, intendedKnowledgeId: entry.id, knowledgeId: entry.id, status: "saved", entry, error: null });
const refusal = (code = "invalid", path: Array<string | number> = ["source"]) => Object.assign(new Error(code === "invalid_input" ? "rpc input validation failed" : SOURCE_EXCERPT_LIMIT_MESSAGE), { code, issues: [{ path, message: SOURCE_EXCERPT_LIMIT_MESSAGE }] });
function renderCapture(seed: CaptureSeed, handlers: Partial<PluginRpcTestHandlers<typeof sectionRpcContract>> = {}) {
  const rpc = { sectionCapture: saved, ...handlers } as PluginRpcTestHandlers<typeof sectionRpcContract>;
  const onClose = vi.fn();
  const slot = renderSlot({ component: CaptureDialog }, { section, seed, onClose }, { rpc, experimental_rpcContract: sectionRpcContract });
  return { slot, onClose };
}
const calls = (slot: ReturnType<typeof renderSlot>, method: string) => slot.inspection.rpcCalls.filter(call => call.method === method);
function editDraft(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "My edited title" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Text" }), { target: { value: "My edited takeaway stays here." } });
}

test("invalid_input shows and retains typed actionable issues without rewriting conflicts", () => {
  const out = failureOf(refusal("invalid_input", ["source", "quote"]));
  expect(out.message).toBe(SOURCE_EXCERPT_LIMIT_MESSAGE);
  expect(out.issues).toEqual([{ path: ["source", "quote"], message: SOURCE_EXCERPT_LIMIT_MESSAGE }]);
  expect(failureOf(Object.assign(refusal("conflict"), { message: "Revision changed" })).message).toBe("Revision changed");
});

test("issue metadata is bounded and incomplete source metadata cannot prove preflight", () => {
  const out = failureOf({ code: "invalid", message: "Unknown outcome", issues: Array.from({ length: 20 }, () => ({ path: ["source"], message: "Invalid source" })) });
  expect(out.issues).toHaveLength(8);
  expect(out.issuesComplete).toBe(false);
});

const sourceIssue = { path: ["source", "quote"], message: "Source needs checking" };
const incompleteIssues: Array<[string, unknown[]]> = [
  ["truncated mixed issues", [...Array(8).fill(sourceIssue), { path: ["save"], message: "Write outcome uncertain" }]],
  ["filtered empty message", [sourceIssue, { path: ["save"], message: "" }]],
  ["filtered oversized path", [sourceIssue, { path: ["save", "x".repeat(257)], message: "Write outcome uncertain" }]],
];

const malformedIssues: Array<[string, unknown]> = [
  ...incompleteIssues,
  ["malformed issue", [sourceIssue, null]],
  ["malformed path", [sourceIssue, { path: "save", message: "Write outcome uncertain" }]],
  ["all issues filtered", [{ path: [], message: "" }]],
  ["non-array metadata", "untrusted issues"],
];
test.each(malformedIssues)("%s never regains completeness after repeated normalization", (_name, issues) => {
  let out = failureOf({ code: "invalid", message: "Outcome uncertain", issues });
  for (let pass = 0; pass < 5; pass++) {
    expect(out.issuesComplete).toBe(false);
    out = failureOf(out);
  }
});

test.each(incompleteIssues)("%s stays frozen through public RPC, writes wrapper and dialog", async (_name, issues) => {
  vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(uuid1).mockReturnValueOnce(uuid2);
  let attempts = 0;
  const original = "Original message evidence";
  const { slot, onClose } = renderCapture({ source: messageSource, text: original }, { sectionCapture: input => {
    if (++attempts === 1) throw Object.assign(new Error("Outcome uncertain"), { code: "invalid", issues });
    return saved(input);
  } });
  const dialog = await slot.findByRole("dialog");
  editDraft(dialog);
  const field = within(dialog).getByRole("textbox", { name: "Text" }) as HTMLTextAreaElement;
  field.focus(); field.setSelectionRange(3, 8);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
  await within(dialog).findByText("Outcome uncertain");
  expect(slot.getByRole("dialog")).toBe(dialog);
  expect(within(dialog).getByRole("textbox", { name: "Text" })).toBe(field);
  expect(field.value).toBe("My edited takeaway stays here.");
  expect([field.selectionStart, field.selectionEnd]).toEqual([3, 8]);
  expect(field.matches(":disabled")).toBe(true);
  expect(dialog.querySelector("blockquote")!.textContent).toBe(original);
  expect(within(dialog).queryByText(/refused before a save job was created/)).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Use a manual note instead" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Use a shorter exact quote" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(calls(slot, "sectionCapture")).toHaveLength(2);
  expect(calls(slot, "sectionCapture")[1]!.input).toEqual(calls(slot, "sectionCapture")[0]!.input);
  expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
});

test.each([false, true])("expanded recovery preserves viewport scrolling contract (compact=%s)", async compact => {
  const original = "staging is on the new bootstrap. ".repeat(330);
  const component = () => <CompactViewportOverrideProvider isCompactViewport={compact}><CaptureDialog section={section} seed={{ source: messageSource, text: original }} onClose={vi.fn()} /></CompactViewportOverrideProvider>;
  const slot = renderSlot({ component }, {}, { rpc: { sectionCapture: () => { throw refusal("invalid", ["source", "quote"]); } }, experimental_rpcContract: sectionRpcContract });
  const dialog = await slot.findByRole("dialog");
  await within(dialog).findByRole("textbox", { name: "Title" });
  editDraft(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
  await within(dialog).findByText(SOURCE_EXCERPT_LIMIT_MESSAGE);
  fireEvent.click(within(dialog).getByRole("button", { name: "Use a shorter exact quote" }));
  const quote = within(dialog).getByRole("textbox", { name: "Exact source quote" });
  const content = quote.closest<HTMLElement>("[data-cortex-capture-scroll]")!;
  expect(content).not.toBeNull();
  expect(content.contains(dialog.querySelector("blockquote"))).toBe(true);
  expect(dialog.querySelector("blockquote")!.textContent).toBe(original);
  expect(content.contains(within(dialog).getByRole("button", { name: "Save for review" }))).toBe(false);
  if (compact) {
    expect(content.classList.contains("contents")).toBe(true);
  } else {
    expect(dialog.style.maxHeight).toBe("calc(100dvh - 2rem)");
    expect(content.classList.contains("overflow-y-auto")).toBe(true);
    expect(content.classList.contains("min-h-0")).toBe(true);
  }
});

test.each(["above", "below", "visible"])("desktop capture body reveals only %s programmatic focus after scrolling", async placement => {
  const original = "staging is on the new bootstrap. ".repeat(330);
  const { slot } = renderCapture({ source: messageSource, text: original }, { sectionCapture: () => { throw refusal("invalid", ["source", "quote"]); } });
  const dialog = await slot.findByRole("dialog");
  editDraft(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
  await within(dialog).findByText(SOURCE_EXCERPT_LIMIT_MESSAGE);
  fireEvent.click(within(dialog).getByRole("button", { name: "Use a shorter exact quote" }));
  const pane = dialog.querySelector<HTMLElement>("[data-cortex-capture-scroll]")!;
  const title = within(dialog).getByRole("textbox", { name: "Title" }) as HTMLInputElement;
  const text = within(dialog).getByRole("textbox", { name: "Text" });
  pane.scrollTop = 92;
  Object.defineProperty(pane, "clientHeight", { configurable: true, value: 692 });
  Object.defineProperty(pane, "clientTop", { configurable: true, value: 0 });
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({ top: 115.1, bottom: 807.1 } as DOMRect);
  vi.spyOn(title, "getBoundingClientRect").mockImplementation(() => {
    const top = (placement === "above" ? 46.6 : placement === "below" ? 850 : 200) + 92 - pane.scrollTop;
    return { top, bottom: top + 36 } as DOMRect;
  });
  const windowScroll = document.documentElement.scrollTop;
  within(dialog).getByRole("button", { name: "Cancel" }).focus();
  title.focus({ preventScroll: true });
  expect(document.activeElement).toBe(title);
  expect(pane.scrollTop).toBeCloseTo(placement === "above" ? 23 : placement === "below" ? 171 : 92);
  expect(title.getBoundingClientRect().top).toBeGreaterThanOrEqual(115.1 - .01);
  expect(title.getBoundingClientRect().bottom).toBeLessThanOrEqual(807.1 + .01);
  expect(document.documentElement.scrollTop).toBe(windowScroll);
  expect(slot.getByRole("dialog")).toBe(dialog);
  expect(within(dialog).getByRole("textbox", { name: "Text" })).toBe(text);
  expect(title.value).toBe("My edited title");
  expect((text as HTMLTextAreaElement).value).toBe("My edited takeaway stays here.");
  expect(dialog.querySelector("blockquote")!.textContent).toBe(original);
});

test("a first selected-quote invalid_input keeps the same editor and allows an exact shorter quote with a fresh intent", async () => {
  const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(uuid1).mockReturnValueOnce(uuid2);
  const short = "The exact shorter passage.";
  const original = `${short} ${"x".repeat(8500)}`;
  const { slot, onClose } = renderCapture({ source: { ...messageSource, quote: original }, text: "Starting draft" });
  const dialog = await slot.findByRole("dialog");
  editDraft(dialog);
  const field = within(dialog).getByRole("textbox", { name: "Text" }) as HTMLTextAreaElement;
  field.focus(); field.setSelectionRange(3, 8);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
  expect(await within(dialog).findByText(SOURCE_EXCERPT_LIMIT_MESSAGE)).toBeTruthy();
  expect(slot.getByRole("dialog")).toBe(dialog);
  expect(within(dialog).getByRole("textbox", { name: "Text" })).toBe(field);
  expect(field.value).toBe("My edited takeaway stays here.");
  expect([field.selectionStart, field.selectionEnd]).toEqual([3, 8]);
  expect(field.matches(":disabled")).toBe(false);
  expect(dialog.querySelector("blockquote")!.textContent).toBe(original);
  expect(within(dialog).queryByRole("button", { name: "Retry save" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Use a shorter exact quote" }));
  const quote = within(dialog).getByRole("textbox", { name: "Exact source quote" }) as HTMLTextAreaElement;
  expect(quote.value).toBe(original);
  await waitFor(() => expect(document.activeElement).toBe(quote));
  fireEvent.change(quote, { target: { value: "Not in the original source" } });
  expect(within(dialog).getByRole("button", { name: "Save for review" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(quote, { target: { value: short } });
  expect(uuid).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(calls(slot, "sectionCapture").at(-1)!.input).toMatchObject({ requestId: uuid2, source: { ...messageSource, quote: short }, title: "My edited title", text: "My edited takeaway stays here." });
  expect(uuid).toHaveBeenCalledTimes(2);
});

test("a typed whole-source preflight refusal permits explicit manual conversion without importing or resetting text, kind or Where", async () => {
  const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(uuid1).mockReturnValueOnce(uuid2);
  let first = true;
  const original = "Original whole message. ".repeat(400);
  const { slot, onClose } = renderCapture({ source: messageSource, text: original }, { sectionCapture: input => { if (first) { first = false; throw refusal(); } return saved(input); } });
  const dialog = await slot.findByRole("dialog");
  editDraft(dialog);
  fireEvent.click(within(dialog).getByRole("radio", { name: "Everywhere" }));
  fireEvent.click(within(dialog).getByRole("radio", { name: "Rule to follow" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
  await within(dialog).findByText(SOURCE_EXCERPT_LIMIT_MESSAGE);
  expect(dialog.querySelector("blockquote")!.textContent).toBe(original);
  expect(within(dialog).queryByRole("button", { name: "Retry save" })).toBeNull();
  const field = within(dialog).getByRole("textbox", { name: "Text" });
  const manual = within(dialog).getByRole("button", { name: "Use a manual note instead" });
  manual.focus();
  fireEvent.click(manual);
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect(within(dialog).getByRole("textbox", { name: "Text" })).toBe(field);
  expect((field as HTMLTextAreaElement).value).toBe("My edited takeaway stays here.");
  expect(dialog.querySelector("blockquote")).toBeNull();
  expect(await within(dialog).findByText(/No message source claimed/)).toBeTruthy();
  expect(within(dialog).getByRole("radio", { name: "Everywhere" }).getAttribute("aria-checked")).toBe("true");
  expect(within(dialog).getByRole("radio", { name: "Rule to follow" }).getAttribute("aria-checked")).toBe("true");
  expect(calls(slot, "sectionCapture")).toHaveLength(1);
  expect(uuid).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save and adopt rule" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(calls(slot, "sectionCapture")[1]!.input).toMatchObject({ requestId: uuid2, source: { kind: "manual", threadId }, text: "My edited takeaway stays here.", title: "My edited title", kind: "directive", mode: "accept", applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } } });
  expect(toast).toHaveBeenLastCalledWith("Saved as a manual note. No message source claimed. Running sessions were not changed.");
});

test.each(["invalid", "transport_error", "handler_error", "invalid_output"])("ambiguous %s preserves frozen identical-ID and identical-payload retry", async code => {
  let first = true;
  const { slot } = renderCapture({ source: messageSource, text: "Original source and draft" }, { sectionCapture: input => { if (first) { first = false; throw Object.assign(new Error("Outcome uncertain"), { code }); } return saved(input); } });
  const dialog = await slot.findByRole("dialog");
  editDraft(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
  await within(dialog).findByText("Outcome uncertain");
  expect(within(dialog).getByRole("textbox", { name: "Text" }).matches(":disabled")).toBe(true);
  expect(within(dialog).queryByRole("button", { name: "Use a manual note instead" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(calls(slot, "sectionCapture")).toHaveLength(2));
  expect(calls(slot, "sectionCapture")[1]!.input).toEqual(calls(slot, "sectionCapture")[0]!.input);
});

test.each(["invalid_input", "invalid"])("a prior uncertain attempt followed by typed %s cannot unlock editing or replace the intent", async code => {
  let count = 0;
  const { slot } = renderCapture({ source: messageSource, text: "Original source and draft" }, { sectionCapture: input => { count++; if (count === 1) throw Object.assign(new Error("Outcome uncertain"), { code: "transport_error" }); if (count === 2) throw refusal(code, ["source", "quote"]); return saved(input); } });
  const dialog = await slot.findByRole("dialog");
  editDraft(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
  await within(dialog).findByText("Outcome uncertain");
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry save" }));
  await within(dialog).findByText(SOURCE_EXCERPT_LIMIT_MESSAGE);
  expect(within(dialog).getByRole("textbox", { name: "Text" }).matches(":disabled")).toBe(true);
  expect(within(dialog).queryByRole("button", { name: "Use a manual note instead" })).toBeNull();
  expect(await within(dialog).findByText("This refusal does not settle the earlier save outcome. Retry keeps its original request and source.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(calls(slot, "sectionCapture")).toHaveLength(3));
  expect(calls(slot, "sectionCapture").map(call => call.input)).toEqual(Array(3).fill(calls(slot, "sectionCapture")[0]!.input));
});

test("a known failed job stays frozen after a validation refusal and retries only its original ID", async () => {
  let attempts = 0;
  const { slot } = renderCapture({ source: messageSource, text: "Original source and draft" }, { sectionCapture: input => ({ ...saved(input), status: "failed", error: "Known job needs recovery" }), sectionCaptureRetry: ({ requestId }) => { attempts++; if (attempts === 1) throw refusal("invalid_input", ["source", "quote"]); return saved({ requestId, sectionId: section.id }); } });
  const dialog = await slot.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
  await within(dialog).findByText("Known job needs recovery");
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry save" }));
  await within(dialog).findByText(SOURCE_EXCERPT_LIMIT_MESSAGE);
  expect(within(dialog).getByRole("textbox", { name: "Text" }).matches(":disabled")).toBe(true);
  expect(within(dialog).queryByRole("button", { name: "Use a manual note instead" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(calls(slot, "sectionCaptureRetry")).toHaveLength(2));
  expect(calls(slot, "sectionCapture")).toHaveLength(1);
  expect(calls(slot, "sectionCaptureRetry")[1]!.input).toEqual(calls(slot, "sectionCaptureRetry")[0]!.input);
});
