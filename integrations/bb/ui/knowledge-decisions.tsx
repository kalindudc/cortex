import { toast } from "sonner";
import { failureOf, type RpcFailure, type Writes } from "./data";
import { FailureNotice } from "./parts";
import type { Knowledge } from "./types";

export const isHistorical = (entry: Knowledge) => ["archived", "rejected", "superseded", "forgotten"].includes(entry.state);

export function knowledgeDecisionMessage(cause: unknown): string {
  const { message } = failureOf(cause);
  if (message.includes("Historical entries cannot acquire active relations"))
    return "The other entry is already in history and cannot be replaced. Review the refreshed choices; choose Approve this if no live conflicts remain.";
  if (message.includes("Resolve conflicts through explicit supersession"))
    return "A live entry still disputes this. Compare the entries and choose which one replaces the other.";
  if (message.includes("Additional conflicts require separate resolution"))
    return "More live conflicts remain, so nothing was approved. Compare the remaining entries and resolve those conflicts separately before approving.";
  if (message.includes("revision conflict"))
    return "This entry changed before the decision was saved. Review the refreshed choices and choose again.";
  return "Cortex could not save this decision. Review the entry and try again; the technical details are available below.";
}

export function KnowledgeDecisionFailure({ failure }: { failure: RpcFailure }) {
  return <div className="flex flex-col gap-1">
    <FailureNotice failure={{ ...failure, message: knowledgeDecisionMessage(failure) }} title="Decision not saved." />
    <details className="text-[12px] text-muted-foreground"><summary>Technical details</summary><p className="break-words">{failure.message}</p></details>
  </div>;
}

export function knowledgeDecisionToast(message: string, before: Knowledge, after: Knowledge | undefined, writes: Writes) {
  if (!after || !["archived", "rejected"].includes(after.state) || ["superseded", "forgotten"].includes(before.state)) {
    toast(message);
    return;
  }
  let running = false;
  toast(message, { action: { label: "Undo", onClick: async () => {
    if (running) return;
    running = true;
    try {
      const input = { id: before.id, expectedRevision: after.revision, reason: "Undid knowledge decision in Cortex" };
      if (before.state === "candidate" || before.state === "disputed") {
        await writes.edit(input);
        toast("Restored to review. Not approved; threads will not receive it yet.");
      } else {
        await writes.transition({ ...input, state: before.state as "approved" | "recheck" | "archived" | "rejected" });
        toast(before.state === "approved" ? "Approval restored for future sessions. Running sessions were not changed." : `Restored to ${before.state}.`);
      }
    } catch (cause) {
      writes.refreshKnowledge();
      toast.error(`Could not undo. ${knowledgeDecisionMessage(cause)}`, { description: failureOf(cause).message });
      running = false;
    }
  } } });
}
