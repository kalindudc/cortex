import { isFlag, isPageCount, usePlaceState } from "./place";
import { type ReactNode, useState } from "react";
import { experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { actorWord, AUTHOR_WORD, facetWord, SOURCE_STATUS_WORD } from "./copy";
import { failureOf, type RpcFailure, useHistory, useKnowledgeEntries, useWorkstreamWrites } from "./data";
import { ConfirmDialog, EditKnowledgeDialog, ObserveDialog } from "./dialogs";
import { displayState, isExpired, relativeAge, shortTime } from "./model";
import { isHistorical, KnowledgeDecisionFailure, knowledgeDecisionMessage, knowledgeDecisionToast } from "./knowledge-decisions";
import { Applicability, FailureNotice, Hint, KnowledgeText, LoadingRows, PagedFooter } from "./parts";
import { type HeldReason, KindMark, KnowledgeStateMark, ReasonChip } from "./marks";
import { CORTEX_PAGE_PATH } from "./thread-context";
import type { Knowledge, KnowledgeSource, Workstream } from "./types";
import "./review.css";

function Pointers({ entry, onOpen }: { entry: Knowledge; onOpen?: (id: string) => void }) {
  const rows: Array<[string, string, string[]]> = [
    ["RotateCcw", "Replaces", entry.supersedes],
    ["AlertTriangle", "Disputes", entry.conflicts],
    ...(entry.supersededBy ? ([["ArrowUpRight", "Replaced by", [entry.supersededBy]]] as Array<[string, string, string[]]>) : []),
  ];
  const shown = rows.filter(([, , ids]) => ids.length > 0);
  const ids = [...new Set(shown.flatMap(([, , values]) => values))];
  const reads = useKnowledgeEntries(ids);
  const navigate = useBbNavigate();
  const open = (id: string) => {
    if (onOpen) onOpen(id);
    else navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `workstreams/${entry.workstreamId}/${id}` });
  };
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-[12px]">
      {shown.map(([icon, label, ids]) => (
        <p key={label} className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
          <Icon name={icon} className="size-3.5" aria-hidden />
          {label}
          {ids.map((id, index) => {
            const related = reads.find(read => read.data?.entry.id === id)?.data?.entry;
            return <button key={id} type="button" title={id} onClick={() => open(id)} className="min-w-0 rounded-sm text-left text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              {related?.title || `${label} entry ${index + 1}`}
            </button>;
          })}
        </p>
      ))}
    </div>
  );
}

function ExpiryLine({ entry, now }: { entry: Knowledge; now: number }) {
  if (entry.expiresAt === null) return null;
  const expired = isExpired(entry, now);
  return (
    <p className={cn("flex items-center gap-1.5 text-[12px]", expired ? "text-warning-text" : "text-muted-foreground")}>
      <Icon name="Clock" className="size-3.5" aria-hidden />
      {expired ? `Expired ${relativeAge(entry.expiresAt, now)}; held back until someone re-checks it` : `Re-check by ${shortTime(entry.expiresAt)}`}
    </p>
  );
}

export function KnowledgeHistory({ id }: { id: string }) {
  const [pages, setPages] = usePlaceState(`knowledge-history-pages:${id}`, 1, isPageCount);
  const read = useHistory(id, pages);
  if (read.error) return <FailureNotice failure={read.error} onRetry={read.refetch} />;
  if (read.data === undefined) return <LoadingRows rows={2} label="Loading history" />;
  if (read.data.revisions.length === 0) return <p className="text-[12px] text-muted-foreground">No earlier revisions.</p>;
  return (
    <div>
      <ol className="flex flex-col gap-1.5">
        {read.data.revisions.map(revision => (
          <li key={`${revision.id}-${revision.revision}`} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
            <span className="font-mono text-muted-foreground tabular-nums">rev {revision.revision}</span>
            <span className="font-semibold text-foreground">{revision.action}</span>
            <span className="text-muted-foreground">by {actorWord(revision.actor)}</span>
            <span className="text-muted-foreground">{shortTime(revision.at)}</span>
            {revision.reason ? (
              <span data-content className="basis-full text-foreground">
                {revision.reason}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <PagedFooter
        shown={read.data.revisions.length}
        total={read.data.total}
        noun="revisions"
        onMore={() => setPages(pages + 1)}
        changedWhileReading={read.data.changedWhileReading}
        onRetry={read.refetch}
      />
    </div>
  );
}

type Dialog = "edit" | "observe" | "evidence" | "archive" | "forget" | "restore-review" | "restore-approve" | null;

/** The actions a person can take on one entry, by state; approval is always its own explicit step. */
export function KnowledgeActions({ entry, workstream }: { entry: Knowledge; workstream: Workstream | null }) {
  const writes = useWorkstreamWrites();
  const conflicts = useKnowledgeEntries(entry.conflicts);
  const noLiveConflicts = conflicts.every(read => read.data !== undefined && !read.error && isHistorical(read.data.entry));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  const now = Date.now();
  const state = displayState(entry, now);
  const transition = async (to: "approved" | "recheck" | "archived" | "rejected" | "forgotten", reason: string, done: string) => {
    setFailure(null);
    try {
      const out = await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: to, reason });
      knowledgeDecisionToast(done, entry, out.entry, writes);
    } catch (cause) {
      setFailure(failureOf(cause));
      writes.refreshKnowledge();
      throw { ...failureOf(cause), message: knowledgeDecisionMessage(cause) };
    }
  };
  const restoreReview = async () => {
    setFailure(null);
    try {
      await writes.edit({ id: entry.id, expectedRevision: entry.revision, reason: "Restored to review in Cortex" });
      toast("Restored to review. Not approved; threads will not receive it yet.");
    } catch (cause) {
      setFailure(failureOf(cause));
      writes.refreshKnowledge();
      throw { ...failureOf(cause), message: knowledgeDecisionMessage(cause) };
    }
  };
  const quiet = (run: () => Promise<void>) => () => void run().catch(() => {});
  const open = (next: Dialog) => () => setDialog(next);
  const close = (isOpen: boolean) => {
    if (!isOpen) setDialog(null);
  };
  const live = entry.state !== "forgotten";
  return (
    <div data-cortex className="cortex-knowledge flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.state === "candidate" && noLiveConflicts ? (
          <Button size="sm" onClick={quiet(() => transition("approved", "Approved in Cortex", `Approved. Threads in ${workstream?.name ?? "the workstream"} get it from their next session.`))}>
            Approve
          </Button>
        ) : null}
        {state === "expired" || entry.state === "recheck" ? (
          <Button size="sm" onClick={open("observe")}>
            Record what you see now…
          </Button>
        ) : null}
        {live ? (
          <Button size="sm" variant="outline" onClick={open("edit")}>
            <Icon name="Edit" aria-hidden />Edit
          </Button>
        ) : null}
        {live ? (
          <Button size="sm" variant="outline" onClick={open("evidence")}>
            <Icon name="Link" aria-hidden />Add source
          </Button>
        ) : null}
        {live ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label={`More actions for ${entry.title}`} className="px-2">
                <Icon name="MoreHorizontal" className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent data-cortex className="cortex-knowledge w-60" align="end" mobileTitle={entry.title}>
              {entry.state === "archived" || entry.state === "rejected" ? (
                <DropdownMenuItem onSelect={open("restore-review")}>
                  <Icon name="RotateCcw" aria-hidden />Restore to review
                </DropdownMenuItem>
              ) : null}
              {entry.state === "archived" && entry.approval !== null && noLiveConflicts ? (
                <DropdownMenuItem onSelect={open("restore-approve")}>
                  <Icon name="Check" aria-hidden />Restore and approve
                </DropdownMenuItem>
              ) : null}
              {entry.state === "approved" ? (
                <DropdownMenuItem onSelect={quiet(() => transition("recheck", "Sent for re-check in Cortex", "Held back until someone re-checks it"))}>
                  <Icon name="Clock" aria-hidden />
                  Hold back for re-check
                </DropdownMenuItem>
              ) : null}
              {entry.state === "candidate" ? (
                <DropdownMenuItem onSelect={quiet(() => transition("rejected", "Rejected in Cortex", "Rejected. Threads never get it."))}>
                  <Icon name="CircleX" aria-hidden />
                  Reject
                </DropdownMenuItem>
              ) : null}
              {entry.state !== "archived" && entry.state !== "superseded" ? (
                <DropdownMenuItem onSelect={open("archive")}>
                  <Icon name="Archive" aria-hidden />
                  Archive…
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={open("forget")}>
                <Icon name="Trash2" aria-hidden />
                Forget…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void copyKnowledgeId(entry.id)}><Icon name="Copy" aria-hidden />Copy id</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {entry.state === "forgotten" ? <p className="text-[12px] text-muted-foreground">Forgotten text is gone and cannot be restored.</p> : null}
      {entry.state === "superseded" ? <p className="text-[12px] text-muted-foreground">Superseded knowledge needs a separate replacement decision, not restore.</p> : null}
      {failure ? <KnowledgeDecisionFailure failure={failure} /> : null}
      <ConfirmDialog
        title={`Restore ${entry.title} to review?`}
        facts={[
          { icon: "RotateCcw", text: "Returns as a candidate with its wording and sources unchanged." },
          { icon: "Clock", text: "Not approved. Threads will not receive it until you approve it." },
        ]}
        confirm="Restore to review"
        open={dialog === "restore-review"}
        onOpenChange={close}
        onConfirm={restoreReview}
      />
      <ConfirmDialog
        title={`Restore and approve ${entry.title}?`}
        facts={[
          { icon: "Check", text: "Previously approved, with no live conflicts. Threads get it from their next session if its scope and expiry allow it." },
          { icon: "SideChat", text: "Sessions already running keep what they received." },
        ]}
        confirm="Restore and approve"
        open={dialog === "restore-approve"}
        onOpenChange={close}
        onConfirm={() => transition("approved", "Restored and approved in Cortex", "Restored and approved for future sessions")}
      />
      <EditKnowledgeDialog entry={entry} workstream={workstream} open={dialog === "edit"} onOpenChange={close} />
      <ObserveDialog entry={entry} mode="observe" open={dialog === "observe"} onOpenChange={close} />
      <ObserveDialog entry={entry} mode="evidence" open={dialog === "evidence"} onOpenChange={close} />
      <ConfirmDialog
        title={`Archive ${entry.title}?`}
        facts={[
          { icon: "Minus", text: "Leaves every thread's next context." },
          { icon: "Archive", text: "Kept for history; you can read it later." },
          { icon: "SideChat", text: "Sessions already running keep what they received." },
        ]}
        confirm="Archive"
        open={dialog === "archive"}
        onOpenChange={close}
        onConfirm={() => transition("archived", "Archived in Cortex", "Archived")}
      />
      <ConfirmDialog
        title={`Forget ${entry.title}?`}
        facts={[
          { icon: "Trash2", text: "Removes its text from Cortex and from history reads. Who and when stay." },
          { icon: "SideChat", text: "Does not erase text already sent to running sessions." },
          { icon: "Archive", text: "Cannot be undone. Archive instead keeps the text for history." },
          { icon: "Copy", text: "Exports and backups are not erased." },
        ]}
        confirm="Forget"
        destructive
        open={dialog === "forget"}
        onOpenChange={close}
        onConfirm={() => transition("forgotten", "Forgotten in Cortex", "Forgotten")}
        secondaryAction={{ label: "Archive instead", onClick: open("archive") }}
      />
    </div>
  );
}

async function copyKnowledgeId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    toast("Copied id");
  } catch {
    toast.error("Could not copy the id.");
  }
}

function KnowledgeSourceQuote({ source, entryId }: { source: KnowledgeSource; entryId: string }) {
  const navigate = useBbNavigate();
  const sidebar = experimental_useSidebarThreads();
  const [expanded, setExpanded] = usePlaceState(`source-expanded:${entryId}:${source.ref}`, false, isFlag);
  const thread = /^@thread:([^#]+)#msg=(\d+)$/.exec(source.ref);
  const web = /^https?:\/\/\S+$/.test(source.ref);
  const long = !!source.excerpt && (source.excerpt.length > 280 || source.excerpt.split("\n").length > 3);
  const label = thread ? `${sidebar.threads.find(row => row.id === thread[1])?.displayTitle ?? "Source thread"} · msg ${thread[2]}` : source.ref.startsWith("bb:manual:") ? "Written by you" : web ? source.ref : "Source reference";
  return (
    <li className="min-w-0 border-l-2 border-border-seam bg-surface-recessed px-3 py-2" data-part="SourceExcerpt">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Icon name={source.authorType === "agent" ? "Bot" : source.authorType === "human" ? "UserRound" : "Info"} className="size-3.5 shrink-0" aria-hidden />{AUTHOR_WORD[source.authorType]}</span>
        {thread || web ? <button type="button" title={source.ref} aria-label={label} className="min-w-0 break-words rounded-sm text-left underline decoration-border underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => {
          if (thread) navigate.toThread(thread[1]!);
          else if (!navigate.openUrl(source.ref)) toast.error("bb could not open this link here.");
        }}>{label}</button> : <span title={source.ref}>{label}</span>}
        <time dateTime={source.observedAt}>{shortTime(source.observedAt)}</time>
        {source.status ? <Hint text="Reported by whoever added the source; Cortex did not check it."><span className={source.status === "available" ? "" : "text-warning-text"}>{SOURCE_STATUS_WORD[source.status] ?? "available"}</span></Hint> : null}
      </div>
      {source.excerpt ? <blockquote data-content className={cn("mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-foreground", long && !expanded && "line-clamp-3")}>{source.excerpt}</blockquote> : null}
      {long ? <Button variant="ghost" size="sm" className="mt-1 h-auto px-0 text-[11.5px]" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : `Show all ${source.excerpt!.length.toLocaleString()} characters`}</Button> : null}
    </li>
  );
}

/** One entry in full: its words, where it applies, who approved it, what it rests on, and its history. */
export function KnowledgeDetail({
  entry,
  workstream,
  actions,
  onOpen,
  children,
  onClose,
  reason,
  facts,
}: {
  entry: Knowledge;
  workstream: Workstream | null;
  actions?: ReactNode;
  onOpen?: (id: string) => void;
  children?: ReactNode;
  onClose?: () => void;
  reason?: HeldReason;
  facts?: ReactNode;
}) {
  const now = Date.now();
  const sidebar = experimental_useSidebarThreads();
  const author = (actor: Knowledge["actor"]) => {
    if (actor.type !== "agent") return actorWord(actor);
    const thread = sidebar.threads.find(row => `bb-${row.id}` === actor.id);
    return thread ? `Agent in ${thread.displayTitle}` : "Agent";
  };
  const [showHistory, setShowHistory] = usePlaceState(`knowledge-history:${entry.id}`, false, isFlag);
  return (
    <section data-cortex data-part="KnowledgeSheet" aria-label={entry.title} className="cortex-knowledge flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <KnowledgeStateMark entry={entry} />
        <KindMark kind={entry.kind} />
        {workstream ? <span className="text-[11.5px] text-muted-foreground">{workstream.name}</span> : null}
        <span className="text-[11.5px] text-muted-foreground">{facetWord(entry.facet)}</span>
        <span className="text-[11px] text-muted-foreground">rev {entry.revision}</span>
        {facts}
        <span className="flex-1" />
        <Hint text={`Copy id ${entry.id}`}><Button variant="ghost" size="sm" className="size-7 p-0" aria-label="Copy id" onClick={() => void copyKnowledgeId(entry.id)}><Icon name="Copy" className="size-3.5" aria-hidden /></Button></Hint>
        {onClose ? <Button variant="ghost" size="sm" className="size-7 p-0" aria-label="Close" onClick={onClose}><Icon name="X" className="size-3.5" aria-hidden /></Button> : null}
      </div>
      <h3 data-content className="text-[17px] leading-snug font-semibold text-foreground">{entry.title}</h3>
      {entry.state === "forgotten" ? (
        <p className="text-[12.5px] text-muted-foreground">Its text was forgotten. Who changed it and when stay in history.</p>
      ) : <KnowledgeText text={entry.text} />}
      <dl className="cortex-knowledge-values">
        <dt>Applies to</dt><dd className="min-w-0"><Applicability value={entry.applicability} /></dd>
        {reason ? <><dt>In this brief</dt><dd><ReasonChip reason={reason} /></dd></> : null}
        <dt>Approved</dt><dd>{entry.approval ? `Approved by ${author(entry.approval.actor)} · ${shortTime(entry.approval.at)}` : "Not approved"}</dd>
        <dt>Last change</dt><dd>{author(entry.actor)} · {relativeAge(entry.updatedAt, now)}</dd>
        {entry.expiresAt ? <><dt>Re-check</dt><dd><ExpiryLine entry={entry} now={now} /></dd></> : null}
      </dl>
      <Pointers entry={entry} onOpen={onOpen} />
      <div className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold">Sources <span className="text-[11.5px] font-normal text-muted-foreground">{entry.sources.length}</span></h3>
        {entry.sources.length === 0 ? <p className="text-[12px] text-muted-foreground">No sources.</p> : <ul className="flex min-w-0 flex-col gap-2">{entry.sources.map((source, index) => <KnowledgeSourceQuote key={`${entry.id}-${index}-${source.ref}`} source={source} entryId={entry.id} />)}</ul>}
      </div>
      {children}
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">{actions}</div>
        <Button variant="ghost" size="sm" className="h-auto min-h-7 px-2 text-[12px]" aria-label={showHistory ? "Hide history" : "Show history"} aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
          <Icon name="TimeSchedule" className="size-3.5" aria-hidden />History · {entry.revision}
        </Button>
      </div>
      {showHistory ? <KnowledgeHistory key={entry.id} id={entry.id} /> : null}
    </section>
  );
}
