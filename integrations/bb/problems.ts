import type { Section, SectionEligibility } from "./section-contract";
import type { Knowledge } from "./workstream-contract";
import type { CaptureJob } from "./section-contract";
import type { DraftJob } from "./draft-contract";
import type { Problem, ProblemAction, ProblemEntry } from "./problem-contract";
const open: ProblemAction = { kind: "open-section", label: "Open the brief" };
const briefConsequence = "New threads in this section start without the shared brief.";
export function sectionProblems(section: Section, preview: SectionEligibility | null, knowledge: Knowledge[]): Problem[] {
  const rows: Problem[] = [];
  const add = (kind: string, severity: Problem["severity"], title: string, consequence: string, details: string, actions: ProblemAction[], suffix = "") => rows.push({
    id: `${section.id}:${kind}${suffix}`, kind, sectionId: section.id, sectionName: section.canonicalName,
    severity, blocking: severity === "Blocks", title: `${title} in ${section.canonicalName}`, consequence, details, actions,
  });
  const connection = section.connectionJob;
  if (connection?.status === "failed") {
    const conflict = /conflict|occupied|revision/i.test(connection.error ?? "");
    add("connection", "Failed", "The section could not connect", conflict ? "Choose the shared knowledge again in this section; retrying cannot resolve the changed choice." : briefConsequence,
      connection.error ?? "", conflict ? [{ kind: "open-section", label: "Choose what to share", id: "connect" }] : [{ kind: "retry-connection", label: "Retry connection", id: connection.requestId }, open]);
  }
  if (!preview) return rows;
  if (preview.startingProblem) add("starting-delivery", "Held back", "Some entries cannot fit the starting brief",
    "Agents other than Pi, Claude Code and Codex start without these entries because they have no first-message brief delivery.",
    preview.startingProblem, [open]);
  const details = `${preview.estimatedTokens} tokens selected · ${preview.budgetTokens} tokens available\n${preview.error ?? ""}`;
  if (preview.status === "over-budget") {
    const largest = [...preview.entries].sort((a, b) => b.estimatedTokens - a.estimatedTokens)[0];
    add("over-budget", "Held back", "The brief is too big", briefConsequence, details,
      largest ? [{ kind: "archive-entry", label: "Archive the largest entry", id: largest.knowledge.id, revision: largest.knowledge.revision }, { kind: "edit-entry", label: "Edit it", id: largest.knowledge.id }, open] : [open]);
  } else if (preview.status === "missing-required") {
    const missing = section.binding.binding?.requiredKnowledgeIds.filter(id => !preview.entries.some(row => row.knowledge.id === id)) ?? [];
    add("missing-required", "Held back", "The brief is missing a required entry", briefConsequence, details,
      [open, ...(missing[0] ? [{ kind: "remove-required" as const, label: "Remove from required", id: missing[0], revision: section.binding.revision }] : [])]);
  } else if (preview.status === "unavailable") add("unavailable", "Held back", "The brief cannot be read", briefConsequence, details, [open]);
  const byId = new Map(knowledge.map(entry => [entry.id, entry]));
  const extra = knowledge.filter(entry => entry.state === "approved" && (entry.facet === "orientation" || entry.facet === section.binding.binding?.topic) &&
    (["environment", "host"] as const).some(name => entry.applicability[name].mode === "value" && (section.binding.binding?.applicability?.[name].mode ?? "unknown") === "unknown"))
    .map(entry => ({ id: entry.id, reason: "environment or host unknown/mismatched" }));
  const groups = new Map<string, Set<string>>();
  for (const held of [...preview.exclusions, ...preview.notices, ...extra]) {
    let reason = held.reason;
    if (reason === "environment or host unknown/mismatched" || reason === "unknown-applicability" || reason === "applicability-mismatch") {
      const entry = byId.get(held.id);
      const unknown = entry ? Object.values(entry.applicability).some(d => d.mode === "unknown") : reason === "unknown-applicability";
      const needsTarget = entry && (["environment", "host"] as const).some(name => entry.applicability[name].mode === "value" && (section.binding.binding?.applicability?.[name].mode ?? "unknown") === "unknown");
      reason = unknown ? "unknown" : needsTarget || reason === "applicability-mismatch" ? "target" : "other-target";
    }
    if (reason === "expired") reason = "expired; needs recheck";
    if (reason === "source-unreachable") reason = "source unavailable; needs recheck";
    const ids = groups.get(reason) ?? new Set<string>(); ids.add(held.id); groups.set(reason, ids);
  }
  const titles: Record<string, string> = {
    unknown: "Entries have no known environment or host", target: "Entries need a target this section has not chosen",
    disputed: "Entries disagree", recheck: "Entries need re-checking", "expired; needs recheck": "Entries have expired",
    "source unavailable; needs recheck": "Entry sources cannot be reached",
  };
  for (const [reason, ids] of groups) {
    if (!titles[reason]) continue;
    add(reason, "Held back", titles[reason], "New threads in this section start without these entries.", `${ids.size} entries\n${[...ids].join(", ")}\n${reason}`, [{ kind: "open-section", label: "Open them", id: [...ids][0] }]);
  }
  return rows;
}
export function catalogProblem(section: Section, raw: string): Problem {
  return { id: `${section.id}:catalog-read`, kind: "catalog-read", sectionId: section.id, sectionName: section.canonicalName, severity: "Needs attention", blocking: false,
    title: `Entries waiting for a target cannot be checked in ${section.canonicalName}`, consequence: "The shared brief is unchanged, but Cortex cannot list entries waiting for a target.", details: raw, actions: [open] };
}
export function captureProblem(section: Section, job: Pick<CaptureJob, "requestId" | "error">): Problem {
  return { id: `capture:${job.requestId}`, kind: "capture", sectionId: section.id, sectionName: section.canonicalName, severity: "Failed", blocking: false,
    title: `A takeaway could not be saved in ${section.canonicalName}`, consequence: "This takeaway is not available to new threads.", details: job.error ?? "",
    actions: [{ kind: "retry-capture", label: "Retry", id: job.requestId }, { kind: "dismiss-capture", label: "Dismiss", id: job.requestId }] };
}
export function draftProblem(section: Section, job: Pick<DraftJob, "requestId" | "revision" | "status" | "retry" | "worker" | "cancellation" | "candidateResults" | "error" | "progress">): Problem | null {
  if (!["failed", "needs-recovery", "setup-uncertain", "stopped", "cancel-requested"].includes(job.status) || job.status === "stopped" && job.cancellation.state === "confirmed" && job.retry === "none") return null;
  const canRecover = job.retry !== "none";
  return { id: `draft:${job.requestId}`, kind: "draft", sectionId: section.id, sectionName: section.canonicalName, severity: "Failed", blocking: false,
    title: `A draft needs attention in ${section.canonicalName}`,
    consequence: canRecover ? "Check the original helper or recover its saved result; retrying never sends the source again." : "This draft has stopped. Open it to review any partial results.",
    details: `${job.candidateResults.filter(r => r.status === "saved").length} entries saved\n${job.error ?? job.progress ?? ""}`,
    actions: [...(canRecover ? [{ kind: job.retry === "lookup-save" ? "recover-draft" as const : "stop-draft" as const, label: job.retry === "lookup-save" ? "Retry saving" : "Recover and stop", id: job.requestId, revision: job.revision }] : []),
      ...(job.worker.state === "stopped" || job.worker.state === "not-requested" ? [{ kind: "dismiss-draft" as const, label: "Dismiss", id: job.requestId, revision: job.revision }] : []),
      { kind: "open-section", label: "Open the draft", id: "drafts" }] };
}
export function authorProblem(): Problem {
  return { id: "human-author", kind: "human-author", sectionId: null, sectionName: null, severity: "Blocks", blocking: true,
    title: "Cortex cannot identify you", consequence: "Approvals and shared changes cannot be saved as you. Needs a Cortex author setting.",
    details: "The Cortex doctor read did not identify a human author. Configure your author in Cortex, then restart this plugin through bb.", actions: [] };
}
/** Approved entries of one shared knowledge set that no connected section sends or already has a card for. */
export function unreachedProblem(sections: { section: Section; preview: SectionEligibility | null }[], catalog: Knowledge[], dismissed: (sectionId: string, id: string, revision: number) => boolean = () => false): Problem | null {
  const first = sections[0]?.section;
  if (!first) return null;
  const dims = ["environment", "host"] as const;
  const covered = new Set<string>();
  for (const { preview } of sections) {
    for (const row of preview?.entries ?? []) covered.add(row.knowledge.id);
    for (const row of [...(preview?.notices ?? []), ...(preview?.exclusions ?? [])]) covered.add(row.id);
  }
  const bindings = sections.flatMap(({ section }) => (section.binding.binding ? [section.binding.binding] : []));
  // A scoped entry in a section with no target chosen already has the "needs a target" card.
  const targetCard = (entry: Knowledge) =>
    bindings.some(binding => dims.some(name => entry.applicability[name].mode === "value" && (binding.applicability?.[name].mode ?? "unknown") === "unknown"));
  const missed = catalog.filter(entry => entry.state === "approved" && !covered.has(entry.id) && !targetCard(entry) && !dismissed(first.id, entry.id, entry.revision));
  if (!missed.length) return null;
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  const delivered = sections[0]?.preview?.entries.map(row => row.knowledge) ?? [];
  const entries: ProblemEntry[] = missed.map(entry => {
    const base = { id: entry.id, revision: entry.revision, title: entry.title };
    const duplicate = delivered.find(other => normalize(other.text) === normalize(entry.text) || normalize(other.title) === normalize(entry.title));
    if (duplicate) {
      if (normalize(duplicate.text) === normalize(entry.text))
        return { ...base, reason: "duplicate", duplicateOf: duplicate.id, match: "text", detail: `Same text as "${duplicate.title}", which is already in the brief` };
      return { ...base, reason: "duplicate", duplicateOf: duplicate.id, match: "title", detail: "Same title as an entry in the brief, but worded differently. Read both before archiving either." };
    }
    if (entry.facet !== "orientation" && first.binding.binding?.topic !== entry.facet)
      return { ...base, reason: "topic", detail: `Filed under the topic "${entry.facet}", which this section doesn't share` };
    for (const name of dims) {
      const dimension = entry.applicability[name];
      const wanted = first.binding.binding?.applicability?.[name];
      if (dimension.mode === "value" && !(wanted?.mode === "value" && wanted.value === dimension.value))
        return { ...base, reason: "scope", detail: `Only for ${name} ${dimension.value}, which this section doesn't target` };
    }
    return { ...base, reason: "scope", detail: "Not selected for this section's brief" };
  });
  const count = missed.length === 1 ? "1 approved entry never reaches" : `${missed.length} approved entries never reach`;
  return {
    id: `${first.id}:unreached`, kind: "unreached", sectionId: first.id, sectionName: first.canonicalName, severity: "Held back", blocking: false,
    title: `${count} a thread in ${first.canonicalName}`,
    consequence: "No thread gets them. Fix each one below.",
    details: entries.map(entry => `${entry.id} · revision ${entry.revision}${entry.duplicateOf ? ` · duplicate of ${entry.duplicateOf}` : ""}`).join("\n"),
    entries, actions: [],
  };
}
