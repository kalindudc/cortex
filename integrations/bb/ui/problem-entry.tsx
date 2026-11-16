import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ProblemEntry } from "../problem-contract";
import { useCortexRpc, useProblems, useWorkstreamWrites, failureOf } from "./data";
import { knowledgeDecisionMessage, knowledgeDecisionToast } from "./knowledge-decisions";

export const reasonWord = (entry: ProblemEntry) => entry.reason === "duplicate" ? entry.match === "title" ? "Same title" : "Duplicate" : entry.reason === "topic" ? "Topic not shared" : "Different target";

export function ProblemEntryBadge({ entry }: { entry: ProblemEntry }) {
  return <span className="flex flex-wrap items-center gap-1 text-[11.5px] text-warning-text"><span>Never reaches a thread</span><span className="rounded border border-border-seam px-1.5 py-0.5">{reasonWord(entry)}</span></span>;
}

export function useProblemEntry(id: string, sectionId?: string) {
  const read = useProblems();
  for (const problem of read.data?.problems ?? []) {
    if (sectionId && problem.sectionId !== sectionId) continue;
    const entry = problem.entries?.find(row => row.id === id);
    if (entry && problem.sectionId) return { entry, sectionId: problem.sectionId };
  }
  return null;
}

export function ProblemEntryNotice({ id, sectionId }: { id: string; sectionId?: string }) {
  const problem = useProblemEntry(id, sectionId);
  return problem ? <ProblemEntryRow {...problem} /> : null;
}

export function ProblemEntryRow({ entry, sectionId, showTitle = true }: { entry: ProblemEntry; sectionId: string; showTitle?: boolean }) {
  const navigate = useBbNavigate();
  const rpc = useCortexRpc();
  const writes = useWorkstreamWrites();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = { sectionId, id: entry.id, expectedRevision: entry.revision };
  const open = (id = entry.id) => navigate.toPluginPanel("cortex", { subPath: `sections/${sectionId}/knowledge/${id}` });
  const run = async (action: "archive" | "move" | "ignore") => {
    setBusy(true); setFailure(null);
    try {
      if (action === "archive") {
        const before = await rpc.call("knowledgeShow", { id: entry.id });
        const out = await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "archived", reason: entry.reason === "duplicate" ? "Human archived duplicate" : "Human archived unreached entry" });
        knowledgeDecisionToast("Archived for future threads.", before.entry, out.entry, writes);
      } else if (action === "move") {
        const out = await writes.moveToBasics(input);
        if (out.waitingInReview) toast.error(`Waiting in Review. ${knowledgeDecisionMessage(out.refusal)}`, { description: out.refusal ?? undefined });
        else toast("Moved to shared basics and approved for future threads.");
      } else {
        await writes.dismissProblem(input);
        toast("Ignored here for this revision. The entry is unchanged.", { action: { label: "Undo", onClick: async () => {
          try { await writes.undoProblem(input); toast("Warning restored."); }
          catch (cause) { writes.refreshKnowledge(); toast.error(knowledgeDecisionMessage(cause)); }
        } } });
      }
    } catch (cause) { setFailure(knowledgeDecisionMessage(cause)); toast.error(knowledgeDecisionMessage(cause), { description: failureOf(cause).message }); }
    finally { setBusy(false); writes.refreshKnowledge(); }
  };
  const actions = entry.reason === "duplicate"
    ? entry.match === "title" ? [["brief", "Open the brief's copy"], ["archive", "Archive this one"], ["ignore", "Ignore here"]] : [["archive", "Archive duplicate"], ["brief", "Open the brief's copy"]]
    : entry.reason === "topic" ? [["move", "Move to shared basics"], ["ignore", "Ignore here"]] : [["ignore", "Ignore here"], ["archive", "Archive"]];
  return <div data-part="ProblemEntry" className={showTitle ? "my-2 grid gap-2 border-t border-border-seam py-2" : "grid gap-2"}>
    {showTitle ? <button type="button" className="break-words text-left text-[13px] font-semibold underline" onClick={() => open()}>{entry.title}</button> : null}
    <ProblemEntryBadge entry={entry} />
    <p className="text-[12px]">{entry.detail}</p>
    <div className="flex flex-wrap gap-2">{actions.map(([action, label], index) => <Button key={action} size="sm" variant={index === 0 ? "default" : "outline"} disabled={busy} onClick={() => action === "brief" ? open(entry.duplicateOf) : void run(action as "archive" | "move" | "ignore")}>{label}</Button>)}</div>
    {failure ? <p role="alert" className="text-[12px]">{failure}</p> : null}
  </div>;
}
