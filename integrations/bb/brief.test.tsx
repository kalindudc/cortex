// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { briefSegments, BriefStrip } from "./ui/brief-strip";
import { heldReason, KindMark, KnowledgeStateMark, ReasonChip } from "./ui/marks";
import type { DisplayState, Tone } from "./ui/copy";
import type { ContextEntry, ContextNotice, Knowledge, ThreadContext } from "./ui/types";

const now = Date.parse("2026-11-12T12:00:00Z");
const any = { mode: "not-applicable" } as const;
const unknown = { mode: "unknown" } as const;
const targets: Knowledge["applicability"] = {
  environment: { mode: "value", value: "staging" },
  host: { mode: "value", value: "vault-staging.shopify.io" },
};

function knowledge(overrides: Partial<Knowledge> = {}): Knowledge {
  return {
    id: "kn_finding",
    workstreamId: "ws_envoy",
    subject: "redirects",
    title: "Check redirect hosts before moving DNS",
    text: "Check both redirect hosts.",
    kind: "finding",
    state: "approved",
    facet: "orientation",
    applicability: { environment: any, host: any },
    sources: [],
    revision: 1,
    actor: { type: "human", id: "you" },
    createdAt: "2026-11-10T12:00:00Z",
    updatedAt: "2026-11-10T12:00:00Z",
    expiresAt: null,
    approval: { actor: { type: "human", id: "you" }, at: "2026-11-10T12:00:00Z" },
    supersedes: [],
    supersededBy: null,
    conflicts: [],
    ...overrides,
  };
}

function entry(id: string, estimatedTokens: number, kind: Knowledge["kind"] = "finding"): ContextEntry {
  const value = knowledge({ id, title: `Title ${id.slice(3)}`, kind });
  return { knowledge: value, text: value.text, origin: "canonical", overrideActor: null, estimatedTokens };
}

function notice(id: string, estimatedTokens: number, reason = "disputed"): ContextNotice {
  return { id, revision: 1, reason, sources: [], estimatedTokens };
}

function input(budgetTokens = 100) {
  return {
    entries: [entry("kn_first", 40), entry("kn_rule", 60, "directive")],
    notices: [notice("kn_notice", 20), notice("kn_other", 30)],
    budgetTokens,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test.each(["over-budget", "missing-required", "unavailable", "unbound"] as const)("strip never claims delivery when eligibility is %s", status => {
  const slot = renderSlot({ component: () => <BriefStrip data={{ ...input(200), status }} /> }, {});
  const image = slot.getByRole("img");
  expect(image.getAttribute("aria-label")).toContain("Sends nothing:");
  expect(image.getAttribute("aria-label")).not.toMatch(/go in|Within budget/);
  expect(image.textContent).not.toContain("go in");
  expect(image.textContent).toContain("selected");
});

test("segments preserve entry order, then notice order, and cut only after the running total passes budget", () => {
  const result = briefSegments(input());
  expect(result).toEqual({
    segments: [
      { key: "kn_first", kind: "entry", knowledgeKind: "finding", tokens: 40, title: "Title first", cut: false },
      { key: "kn_rule", kind: "entry", knowledgeKind: "directive", tokens: 60, title: "Title rule", cut: false },
      { key: "kn_notice", kind: "notice", tokens: 20, title: "Notice only: Disputed", cut: true },
      { key: "kn_other", kind: "notice", tokens: 30, title: "Notice only: Disputed", cut: true },
    ],
    used: 150,
    budget: 100,
    scale: 150,
    cutCount: 2,
  });
});

test("an entry that crosses the budget is cut along with all later segments", () => {
  const result = briefSegments(input(50));
  expect(result.segments.map(segment => segment.cut)).toEqual([false, true, true, true]);
  expect(result.cutCount).toBe(3);
});

test("under-budget and empty strips retain the whole budget as their scale", () => {
  expect(briefSegments(input(200))).toMatchObject({ used: 150, budget: 200, scale: 200, cutCount: 0 });
  expect(briefSegments({ entries: [], notices: [], budgetTokens: 100 })).toEqual({
    segments: [], used: 0, budget: 100, scale: 100, cutCount: 0,
  });
});

test("zero-token segments are preserved, including after the cut", () => {
  const result = briefSegments({ entries: [entry("kn_zero", 0), entry("kn_large", 101)], notices: [notice("kn_zero_notice", 0)], budgetTokens: 100 });
  expect(result.segments.map(segment => [segment.tokens, segment.cut])).toEqual([[0, false], [101, true], [0, true]]);
  expect(result.cutCount).toBe(2);
});

test("strip exposes the summary, token-proportional widths, cut marker, patterns and held count", () => {
  const slot = renderSlot({ component: () => <BriefStrip data={input()} heldCount={3} /> }, {});
  const image = slot.getByRole("img", { name: "~150 of 100 tokens. 2 entries selected, 2 notices, Sends nothing: over budget" });
  expect(image.hasAttribute("data-cortex")).toBe(true);
  const segments = image.querySelectorAll<HTMLElement>("[data-segment-key]");
  expect(segments).toHaveLength(4);
  expect(parseFloat(segments[0]!.style.width)).toBeCloseTo(100 * 40 / 150);
  expect(segments[0]!.className).toContain("bg-primary");
  expect(segments[1]!.className).toContain("cortex-strip-directive");
  expect(segments[2]!.className).toContain("cortex-hatch-cut");
  expect(segments[2]!.title).toContain("past the budget");
  const markerPosition = image.querySelector<HTMLElement>(".cortex-strip-cut")!.style.left;
  expect(markerPosition).toMatch(/^calc\([\d.]+% - 1px\)$/);
  expect(parseFloat(markerPosition.slice(5))).toBeCloseTo(100 * 100 / 150);
  expect(image.textContent).toContain("~150 / 100 tokens");
  expect(image.textContent).toContain("2 selected");
  expect(image.textContent).toContain("2 notices selected");
  expect(image.textContent).toContain("3 held back");
  expect(image.textContent).toContain("Over budget by ~50: nothing is sent until it fits");
});

test("compact strips accept computed data and keep the accessible summary without a legend", () => {
  const slot = renderSlot({ component: () => <BriefStrip data={briefSegments(input(200))} compact heldCount={0} /> }, {});
  const image = slot.getByRole("img", { name: "~150 of 200 tokens. 2 entries go in, 2 notices, Within budget." });
  expect(image.className).toContain("cortex-strip-compact");
  expect(image.querySelector(".cortex-strip-legend")).toBeNull();
  expect(image.querySelector(".cortex-hatch-notice")).not.toBeNull();
});

test("empty strip renders without invalid widths and omits an unspecified held count", () => {
  const slot = renderSlot({ component: () => <BriefStrip data={{ entries: [], notices: [], budgetTokens: 1000 }} /> }, {});
  const image = slot.getByRole("img", { name: "~0 of 1000 tokens. 0 entries go in, 0 notices, Within budget." });
  expect(image.querySelectorAll("[data-segment-key]")).toHaveLength(0);
  expect(image.textContent).not.toContain("held back");
  expect(image.innerHTML).not.toMatch(/NaN|Infinity/);
});

test("strip formats large token estimates with the existing formatter and shows zero held back", () => {
  const slot = renderSlot({ component: () => <BriefStrip data={{ entries: [entry("kn_long", 1200)], notices: [], budgetTokens: 2000 }} heldCount={0} /> }, {});
  const image = slot.getByRole("img", { name: "~1.2k of 2000 tokens. 1 entries go in, 0 notices, Within budget." });
  expect(image.textContent).toContain("~1.2k / 2000 tokens");
  expect(image.textContent).toContain("0 held back");
});

test("segment hover notifies the caller and external highlighting marks the matching segment", () => {
  const onHover = vi.fn();
  const slot = renderSlot({ component: () => <BriefStrip data={input()} highlightKey="kn_rule" onHover={onHover} /> }, {});
  const image = slot.getByRole("img");
  const first = image.querySelector<HTMLElement>("[data-segment-key='kn_first']")!;
  const highlighted = image.querySelector<HTMLElement>("[data-segment-key='kn_rule']")!;
  expect(highlighted.className).toContain("cortex-strip-highlight");
  expect(first.className).not.toContain("cortex-strip-highlight");
  fireEvent.mouseEnter(first);
  expect(onHover).toHaveBeenLastCalledWith("kn_first");
  fireEvent.mouseLeave(first);
  expect(onHover).toHaveBeenLastCalledWith(null);
  expect(first.title).toBe("Title first · ~40 tokens");
});

test.each<[DisplayState, string]>([
  ["candidate", "Waiting"], ["approved", "Approved"], ["disputed", "Disputed"],
  ["superseded", "Replaced"], ["recheck", "Needs re-check"], ["expired", "Expired"],
  ["archived", "Archived"], ["rejected", "Rejected"], ["forgotten", "Forgotten"],
])("knowledge state %s includes its icon and word", (state, word) => {
  const slot = renderSlot({ component: () => <KnowledgeStateMark state={state} /> }, {});
  const mark = slot.getByText(word).parentElement!;
  expect(mark.getAttribute("data-state")).toBe(state);
  expect(mark.querySelector("[aria-hidden='true']")).not.toBeNull();
});

test("state marks derive expiry from either an entry or explicit state, without expiring non-approved states", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const expiresAt = "2026-11-09T12:00:00Z";
  const slot = renderSlot({ component: () => <><KnowledgeStateMark entry={knowledge({ expiresAt })} /><KnowledgeStateMark state="approved" expiresAt={expiresAt} /><KnowledgeStateMark entry={knowledge({ state: "candidate", expiresAt })} /></> }, {});
  expect(slot.getAllByText("Expired")).toHaveLength(2);
  expect(slot.getByText("Waiting")).toBeDefined();
});

test.each<Knowledge["kind"]>(["finding", "directive"])("kind %s uses its word and icon", kind => {
  const slot = renderSlot({ component: () => <KindMark kind={kind} /> }, {});
  const mark = slot.getByText(kind === "finding" ? "Finding" : "Rule").parentElement!;
  expect(mark.querySelector("[aria-hidden='true']")).not.toBeNull();
});

test.each<[string, string, string, Tone, string | undefined]>([
  ["candidate", "Waiting for review", "BellDot", "attention", "review"],
  ["disputed", "Disputed", "DiffConflict", "warning", "review"],
  ["expired; needs recheck", "Expired", "Clock", "warning", "observe"],
  ["source unavailable; needs recheck", "Source unavailable", "EyeOff", "warning", "observe"],
  ["different topic", "Other topic", "Filter", "muted", "open"],
  ["outside this workstream", "Other workstream", "Layers", "muted", "open"],
  ["left out of this thread", "Left out of this thread", "EyeOff", "muted", "open"],
  ["thread-only change needs review after canonical revision changed", "Thread-only text needs review", "GitBranch", "warning", "review"],
  ["recheck", "Needs re-check", "Clock", "warning", "observe"],
  ["archived", "Archived", "Archive", "muted", "open"],
  ["rejected", "Rejected", "CircleX", "muted", "open"],
  ["forgotten", "Forgotten", "EyeOff", "muted", "open"],
  ["superseded", "Replaced", "RotateCcw", "muted", "open"],
  ["approved", "Approved", "CircleCheck", "success", "review"],
  ["unrecognised backend reason", "unrecognised backend reason", "CircleQuestion", "muted", undefined],
])("heldReason preserves or translates backend reason %s for both exclusions and notices", (reason, label, icon, tone, fix) => {
  const exclusion: ThreadContext["exclusions"][number] = { id: "kn_held", reason };
  const expected = { label, icon, tone, ...(fix ? { fix } : {}) };
  expect(heldReason(exclusion, {})).toEqual(expected);
  expect(heldReason(notice("kn_held", 20, reason), {})).toEqual(expected);
});

test("heldReason uses the existing age helper when an expiry is known", () => {
  expect(heldReason({ id: "kn_held", reason: "expired; needs recheck" }, { entry: knowledge({ expiresAt: "2026-11-09T12:00:00Z" }), now })).toMatchObject({ label: "Expired 3d ago", fix: "observe" });
});

test.each([
  { environment: unknown, host: any },
  { environment: any, host: unknown },
])("an entry whose own environment or host is unknown is fixed on the entry, never by setting targets", applicability => {
  // workstreams.ts#applies: an unknown dimension on the entry never matches any target.
  const label = applicability.environment.mode === "unknown" ? "Environment unknown" : "Host unknown";
  expect(heldReason({ id: "kn_held", reason: "environment or host unknown/mismatched" }, { entry: knowledge({ applicability }), applicability: targets })).toEqual({ label, icon: "CircleQuestion", tone: "warning", fix: "open" });
});

test("CLI notice codes read as words, never as the raw code", () => {
  expect(heldReason({ id: "kn_held", reason: "unknown-applicability" } as never)).toMatchObject({ label: "Environment or host unknown", fix: "open" });
  expect(heldReason({ id: "kn_held", reason: "unknown-applicability" } as never, { entry: knowledge({ applicability: { environment: unknown, host: unknown } }) })).toMatchObject({ label: "Environment and host unknown" });
  expect(heldReason({ id: "kn_held", reason: "source-unreachable" } as never)).toMatchObject({ label: "Source unavailable", fix: "observe" });
  expect(heldReason({ id: "kn_held", reason: "expired" } as never).label).toMatch(/^Expired/);
});

test("an unknown constrained target needs targets, but an unconstrained unknown target does not mask another mismatch", () => {
  const reason = { id: "kn_held", reason: "environment or host unknown/mismatched" };
  expect(heldReason(reason, { entry: knowledge({ applicability: targets }), applicability: { environment: unknown, host: targets.host } })).toMatchObject({ label: "Needs a target", fix: "targets" });
  expect(heldReason(reason, { entry: knowledge({ applicability: { environment: any, host: { mode: "value", value: "other-host" } } }), applicability: { environment: unknown, host: targets.host } })).toMatchObject({ label: "Other host: other-host" });
});

test.each<[Knowledge["applicability"], string, string]>([
  [{ environment: targets.environment, host: { mode: "value", value: "other-host" } }, "Other host: other-host", "ComputerCloud"],
  [{ environment: { mode: "value", value: "production" }, host: targets.host }, "Other environment: production", "Globe"],
])("mismatches name the specific entry target when it is derivable", (applicability, label, icon) => {
  expect(heldReason({ id: "kn_held", reason: "environment or host unknown/mismatched" }, { entry: knowledge({ applicability }), applicability: targets })).toEqual({ label, icon, tone: "muted", fix: "open" });
});

test("mismatches without entry details remain honest and known entry values can be shown without target details", () => {
  const reason = { id: "kn_held", reason: "environment or host unknown/mismatched" };
  expect(heldReason(reason, {})).toEqual({ label: "Other environment or host", icon: "Target", tone: "muted", fix: "open" });
  expect(heldReason(reason, { entry: knowledge({ applicability: { environment: any, host: targets.host } }) })).toMatchObject({ label: "Other host: vault-staging.shopify.io" });
});

test("reason chip has a dashed border, visible label and icon without inventing a control", () => {
  const reason = heldReason({ id: "kn_held", reason: "environment or host unknown/mismatched" }, { entry: knowledge({ applicability: { environment: unknown, host: any } }) });
  const slot = renderSlot({ component: () => <ReasonChip reason={reason} /> }, {});
  const chip = slot.getByText("Environment unknown").parentElement!;
  expect(chip.className).toContain("border-dashed");
  expect(chip.className).toContain("text-warning-text");
  expect(chip.querySelector("[aria-hidden='true']")).not.toBeNull();
  expect(slot.queryByRole("button")).toBeNull();
});

test("a supplied estimatedTokens adds a leading overhead segment for the preamble and scope", () => {
  const result = briefSegments({ entries: [entry("kn_a", 40)], notices: [], budgetTokens: 100, estimatedTokens: 90 });
  expect(result.segments[0]).toMatchObject({ key: "overhead", kind: "overhead", tokens: 50, title: "Preamble and scope" });
  expect(result.used).toBe(90);
  expect(result.cutCount).toBe(0);
  expect(briefSegments({ entries: [entry("kn_a", 40)], notices: [], budgetTokens: 100 }).segments).toHaveLength(1);
});
