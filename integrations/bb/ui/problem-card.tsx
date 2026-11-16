import { useState } from "react";
import { ProblemEntryRow } from "./problem-entry";
import { sectionProblems } from "../problems";
import type { Section, SectionEligibility } from "../section-contract";
import type { Knowledge } from "./types";
import { experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { useCortexRpc, useProblems, useSections, useKnowledgeEntries, useWorkstreamWrites, failureOf } from "./data";
import { EditKnowledgeDialog } from "./dialogs";
import { knowledgeDecisionToast } from "./knowledge-decisions";
import { ApplicabilityCorrectionDialog } from "./problem-dialog";
import type { Problem, ProblemAction, ProblemEntry } from "../problem-contract";

/** One row per thing to decide: each unreached entry is its own row, blocking problems first. */
export type ProblemRow = { key: string; problem: Problem; entry?: ProblemEntry };
export function problemRows(problems: readonly Problem[]): ProblemRow[] {
  return [...problems].sort((a, b) => Number(b.blocking) - Number(a.blocking)).flatMap(problem =>
    problem.entries?.length && problem.sectionId ? problem.entries.map(entry => ({ key: `problem:${problem.id}:${entry.id}`, problem, entry })) : [{ key: `problem:${problem.id}`, problem }]);
}

export function ProblemCard({ problem, compact = false, flat = false, onCaptured }: { problem: Problem; compact?: boolean; flat?: boolean; onCaptured?: (entry: Knowledge) => void }) {
  const navigate = useBbNavigate();
  const rpc = useCortexRpc();
  const writes = useWorkstreamWrites();
  const sections = useSections();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const reads = useKnowledgeEntries(editing ? [editing] : []);
  const entry = reads[0]?.data;
  const run = async (action: ProblemAction) => {
    setFailure(null);
    if (action.kind === "open-section") {
      const suffix = action.id === "connect" ? "/connect" : action.id === "drafts" ? "/drafts" : action.id ? `/knowledge/${action.id}` : "/brief";
      navigate.toPluginPanel("cortex", { subPath: problem.sectionId ? `sections/${problem.sectionId}${suffix}` : "review" });
      return;
    }
    if (action.kind === "open-entry") { navigate.toPluginPanel("cortex", { subPath: `sections/${problem.sectionId}/knowledge/${action.id}` }); return; }
    if (action.kind === "edit-entry" || action.kind === "set-applicability") { setEditing(action.id!); return; }
    setBusy(true);
    try {
      if (action.kind === "retry-connection") await writes.retrySection(action.id!);
      else if (action.kind === "retry-capture") {
        const result = await writes.retryCapture(action.id!);
        if (result.status === "saved" && result.entry) onCaptured?.(result.entry);
      }
      else if (action.kind === "dismiss-capture") await writes.dismissCapture(problem.sectionId!, action.id!);
      else if (action.kind === "remove-required") {
        const section = sections.data?.sections.find(row => row.id === problem.sectionId);
        if (!section?.binding.binding || section.binding.revision !== action.revision) throw new Error("This section changed. Open the brief and review the current required entries.");
        await writes.setSectionBinding({ sectionId: section.id, expectedRevision: action.revision!, binding: { ...section.binding.binding, requiredKnowledgeIds: section.binding.binding.requiredKnowledgeIds.filter(id => id !== action.id) } });
      } else if (action.kind === "archive-entry") {
        const current = await rpc.call("knowledgeShow", { id: action.id! });
        const out = await writes.transition({ id: action.id!, expectedRevision: action.revision!, state: "archived", reason: "Made room in the shared brief" });
        knowledgeDecisionToast("Archived for future threads.", current.entry, out.entry, writes);
      } else if (action.kind === "recover-draft" || action.kind === "stop-draft" || action.kind === "dismiss-draft") {
        await rpc.call(action.kind === "recover-draft" ? "draftResumeSave" : "draftCancel", { sectionId: problem.sectionId!, requestId: action.id!, expectedRevision: action.revision! });
      }
      writes.refreshKnowledge();
    } catch (cause) {
      setFailure(failureOf(cause).message);
      writes.refreshKnowledge();
    } finally { setBusy(false); }
  };
  const title = compact && problem.sectionName ? problem.title.replace(` in ${problem.sectionName}`, "") : problem.title;
  return <article data-cortex data-part="ProblemCard" aria-label={title} className={flat ? "flex min-w-0 flex-col" : "my-2 rounded-md border border-border-seam bg-surface-attention p-3"}>
    <span className="text-[11px] font-semibold text-warning-text">{problem.severity}</span>
    <h3 className="break-words text-[13px] font-semibold">{title}</h3>
    <p className="mt-1 text-[13px]">{problem.consequence}</p>
    {problem.sectionId ? problem.entries?.map(entry => <ProblemEntryRow key={entry.id} sectionId={problem.sectionId!} entry={entry} />) : null}
    <div className="my-2 flex flex-wrap gap-2">{problem.actions.map((action, index) => <Button key={action.kind} size="sm" variant={index === 0 ? "default" : "outline"} disabled={busy} onClick={() => void run(action)}>{action.label}</Button>)}</div>
    {failure ? <p role="alert" className="text-[12px]">The action could not finish. Open the brief and review the current state.<details><summary>Details</summary>{failure}</details></p> : null}
    <details className="text-[12px] text-muted-foreground"><summary>Details</summary><pre className="whitespace-pre-wrap break-words font-sans">{problem.details}</pre></details>
    {entry && editing ? problem.actions.some(a => a.kind === "set-applicability" && a.id === editing) ? <ApplicabilityCorrectionDialog entry={entry.entry} open onOpenChange={() => setEditing(null)} /> : <EditKnowledgeDialog entry={entry.entry} workstream={entry.workstream} open onOpenChange={() => setEditing(null)} /> : null}
  </article>;
}
export function SectionProblems({ sectionId, section, preview, knowledge = [] }: { sectionId: string; section?: Section; preview?: SectionEligibility; knowledge?: Knowledge[] }) {
  const read = useProblems();
  const rows = read.data?.problems.filter(problem => (problem.sectionId === sectionId || problem.sectionId === null) && problem.kind !== "capture") ?? (section ? sectionProblems(section, preview ?? null, knowledge) : []);
  return <>{rows.map(problem => <ProblemCard key={problem.id} problem={problem} compact />)}</>;
}
export function ProblemLink({ sectionId, threadId }: { sectionId?: string | null; threadId?: string }) {
  const navigate = useBbNavigate();
  const sidebar = experimental_useSidebarThreads();
  const target = sectionId ?? sidebar.threads.find(thread => thread.id === threadId)?.sectionId;
  return <Button size="sm" variant="link" onClick={() => navigate.toPluginPanel("cortex", { subPath: target ? `sections/${target}/brief` : "review" })}>Open the problem</Button>;
}
