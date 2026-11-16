import { expect, test } from "vitest";
import { captureProblem, draftProblem, sectionProblems, unreachedProblem } from "./problems";
import type { DraftJob } from "./draft-contract";
import type { Section, SectionEligibility } from "./section-contract";
import type { Knowledge } from "./workstream-contract";
const section = { id: "sec_one", canonicalName: "Payments", binding: { revision: 3, binding: { workstreamId: "ws_one", topic: null, budgetTokens: 800, requiredKnowledgeIds: ["kn_missing"] } }, connectionJob: null } as Section;
const preview: SectionEligibility = { computedAt: new Date().toISOString(), status: "ready", error: null, entries: [], exclusions: [], notices: [], exactText: "", estimatedTokens: 20, budgetTokens: 800 };
test.each(["over-budget", "missing-required", "unavailable"] as const)("lists %s using delivery status, not character length", status => {
  const rows = sectionProblems(section, { ...preview, status, error: "raw failure" }, []);
  expect(rows[0]?.kind).toBe(status);
  expect(rows[0]?.details).toContain("raw failure");
  expect(rows[0]?.consequence).toBe("New threads in this section start without the shared brief.");
});
test("starting delivery limitations are listed even when the full brief is ready", () => {
  const rows = sectionProblems(section, { ...preview, startingProblem: "Required entry cannot fit starting instructions." }, []);
  expect(rows[0]?.kind).toBe("starting-delivery");
  expect(rows[0]?.blocking).toBe(false);
  expect(rows[0]?.consequence).toContain("Agents other than Pi, Claude Code and Codex");
});
test("a ready multi-part brief is not a character-limit problem", () => {
  expect(sectionProblems(section, { ...preview, exactText: "x".repeat(9000) }, [])).toEqual([]);
});
test.each(["disputed", "recheck", "expired; needs recheck", "source unavailable; needs recheck", "unknown-applicability", "applicability-mismatch"])("groups held entries once for %s", reason => {
  const rows = sectionProblems(section, { ...preview, exclusions: [{ id: "kn_a", reason }, { id: "kn_b", reason }], notices: [{ id: "kn_a", revision: 1, reason, sources: [], estimatedTokens: 4 }] }, []);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.details).toContain("2 entries");
});
test("takeaway failures offer Retry and Dismiss", () => {
  expect(captureProblem(section, { requestId: "capture", error: "failed" }).actions.map(action => action.kind)).toEqual(["retry-capture", "dismiss-capture"]);
});
test.each(["none", "lookup-save", "discover-stop"] as const)("draft recovery uses the safe existing action: %s", retry => {
  const job = { requestId: "draft", revision: 3, status: "failed", retry, worker: { state: "stopped", threadId: null }, cancellation: { state: "none", requestedAt: null, confirmedAt: null }, candidateResults: [], error: "failed", progress: null } satisfies Pick<DraftJob, "requestId" | "revision" | "status" | "retry" | "worker" | "cancellation" | "candidateResults" | "error" | "progress">;
  const row = draftProblem(section, job)!;
  expect(row.actions.some(action => action.kind === "dismiss-draft")).toBe(true);
  expect(row.actions[0]?.kind).toBe(retry === "none" ? "dismiss-draft" : retry === "lookup-save" ? "recover-draft" : "stop-draft");
  expect(draftProblem(section, { ...job, status: "stopped", retry: "none", cancellation: { state: "confirmed", requestedAt: null, confirmedAt: null } })).toBeNull();
  expect(draftProblem(section, { ...job, worker: { state: "unknown", threadId: null } })?.actions.some(action => action.kind === "dismiss-draft")).toBe(false);
});
test("a connection conflict opens its exact section instead of retrying", () => {
  const rows = sectionProblems({ ...section, connectionJob: { status: "failed", error: "revision conflict", requestId: "request" } as Section["connectionJob"] }, preview, []);
  expect(rows[0]?.actions.map(a => a.kind)).toEqual(["open-section"]);
  expect(rows[0]?.consequence).toContain("Choose");
});

const any = { mode: "not-applicable" as const };
const approved = (id: string, extra: Partial<Knowledge> = {}) => ({ id, workstreamId: "ws_one", subject: id, title: `Title ${id}`, text: id, kind: "finding", state: "approved", facet: "orientation", applicability: { environment: any, host: any }, sources: [], revision: 1, actor: { id: "you", type: "human" }, createdAt: "", updatedAt: "", expiresAt: null, approval: null, supersedes: [], supersededBy: null, conflicts: [], ...extra }) as Knowledge;
const anyTargets = { ...section, binding: { ...section.binding, binding: { ...section.binding.binding!, requiredKnowledgeIds: [], applicability: { environment: any, host: any } } } } as Section;
test("approved entries no connected section receives get one card naming why", () => {
  const reached = approved("kn_in");
  const catalog = [reached, approved("kn_topic", { facet: "operating rule" }), approved("kn_host", { applicability: { environment: any, host: { mode: "value", value: "vault-staging" } } })];
  const row = unreachedProblem([{ section: anyTargets, preview: { ...preview, entries: [{ knowledge: reached, text: "t", origin: "canonical", overrideActor: null, estimatedTokens: 5 }] } as SectionEligibility }], catalog);
  expect(row).toMatchObject({ id: "sec_one:unreached", severity: "Held back", title: "2 approved entries never reach a thread in Payments", actions: [] });
  expect(row?.entries?.[0]?.detail).toBe("Filed under the topic \"operating rule\", which this section doesn't share");
  expect(row?.entries?.[1]?.detail).toBe("Only for host vault-staging, which this section doesn't target");
});
test("an entry another section of the same knowledge receives, or that already has a card, is not listed", () => {
  const host = approved("kn_host", { applicability: { environment: any, host: { mode: "value", value: "vault-staging" } } });
  const other = { ...anyTargets, id: "sec_two", canonicalName: "Staging", binding: { ...anyTargets.binding, binding: { ...anyTargets.binding.binding!, applicability: { environment: any, host: { mode: "value", value: "vault-staging" } } } } } as Section;
  const held = approved("kn_held");
  expect(unreachedProblem([
    { section: anyTargets, preview: { ...preview, notices: [{ id: "kn_held", revision: 1, reason: "disputed", sources: [], estimatedTokens: 3 }] } as SectionEligibility },
    { section: other, preview: { ...preview, entries: [{ knowledge: host, text: "t", origin: "canonical", overrideActor: null, estimatedTokens: 5 }] } as SectionEligibility },
  ], [host, held])).toBeNull();
});
