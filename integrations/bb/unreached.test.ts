import { expect, test } from "vitest";
import { unreachedProblem } from "./problems";
import type { Knowledge } from "./workstream-contract";
import type { Section, SectionEligibility } from "./section-contract";
const any = { mode: "not-applicable" } as const;
export const section = { id: "sec_one", canonicalName: "Envoy", binding: { revision: 1, binding: { workstreamId: "ws_one", topic: null, applicability: { environment: any, host: any }, requiredKnowledgeIds: [], budgetTokens: 3000 } } } as unknown as Section;
export const entry = (id: string, extra: Partial<Knowledge> = {}) => ({ id, revision: 1, title: id, text: id, state: "approved", facet: "orientation", applicability: { environment: any, host: any }, ...extra }) as Knowledge;
export const delivered = entry("kn_delivered", { title: "Certificate", text: " A Certificate that a PR keeps " });
export const preview = { entries: [{ knowledge: delivered }], notices: [], exclusions: [] } as unknown as SectionEligibility;
test("unreached rows classify normalized text and title before topic, then topic before scope", () => {
  const entries = [entry("kn_text", { text: "a certificate  THAT a PR keeps", facet: "protocol" }), entry("kn_title", { title: " certificate ", facet: "protocol" }), entry("kn_topic", { facet: "operating rule", applicability: { environment: any, host: { mode: "value", value: "vault-staging.shopify.io" } } }), entry("kn_scope", { applicability: { environment: any, host: { mode: "value", value: "vault-staging.shopify.io" } } })];
  const problem = unreachedProblem([{ section, preview }], entries)!;
  expect(problem.entries?.map(row => row.reason)).toEqual(["duplicate", "duplicate", "topic", "scope"]);
  expect(problem.entries?.[0]).toMatchObject({ id: "kn_text", revision: 1, duplicateOf: delivered.id, match: "text", detail: 'Same text as "Certificate", which is already in the brief' });
  // Same title, different wording: either copy may hold detail the other lacks, so the row never calls it a plain duplicate.
  expect(problem.entries?.[1]).toMatchObject({ duplicateOf: delivered.id, match: "title", detail: "Same title as an entry in the brief, but worded differently. Read both before archiving either." });
  expect(problem.entries?.[2]?.detail).toContain('Filed under the topic "operating rule"');
  expect(problem.entries?.[3]?.detail).toBe("Only for host vault-staging.shopify.io, which this section doesn't target");
  expect(problem.consequence).toBe("No thread gets them. Fix each one below.");
  expect(problem.actions).toEqual([]);
});
