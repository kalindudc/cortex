import { type ReactNode, useState } from "react";
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
import { actorWord, facetWord, plural } from "./copy";
import { type RpcFailure, useHistory, useWorkstreamWrites } from "./data";
import { ConfirmDialog, EditKnowledgeDialog, ObserveDialog } from "./dialogs";
import { displayState, isExpired, relativeAge, shortTime } from "./model";
import { Applicability, ApprovalLine, FailureNotice, Heading, KindMark, KnowledgeText, LoadingRows, PagedFooter, SourceList, StateMark } from "./parts";
import type { Knowledge, Workstream } from "./types";

function Pointers({ entry, onOpen }: { entry: Knowledge; onOpen?: (id: string) => void }) {
  const rows: Array<[string, string, string[]]> = [
    ["RotateCcw", "Replaces", entry.supersedes],
    ["TriangleAlert", "Disputes", entry.conflicts],
    ...(entry.supersededBy ? ([["ArrowUpRight", "Replaced by", [entry.supersededBy]]] as Array<[string, string, string[]]>) : []),
  ];
  const shown = rows.filter(([, , ids]) => ids.length > 0);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-[12px]">
      {shown.map(([icon, label, ids]) => (
        <p key={label} className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
          <Icon name={icon} className="size-3.5" aria-hidden />
          {label}
          {ids.map(id =>
            onOpen ? (
              <button
                key={id}
                type="button"
                onClick={() => onOpen(id)}
                className="rounded-sm font-mono text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {id}
              </button>
            ) : (
              <span key={id} className="font-mono text-foreground">
                {id}
              </span>
            ),
          )}
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
  const [pages, setPages] = useState(1);
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

type Dialog = "edit" | "observe" | "evidence" | "archive" | "forget" | null;

/** The actions a person can take on one entry, by state; approval is always its own explicit step. */
export function KnowledgeActions({ entry, workstream }: { entry: Knowledge; workstream: Workstream | null }) {
  const writes = useWorkstreamWrites();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  const now = Date.now();
  const state = displayState(entry, now);
  const transition = async (to: "approved" | "recheck" | "archived" | "rejected" | "forgotten", reason: string, done: string) => {
    setFailure(null);
    try {
      await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: to, reason });
      toast(done);
    } catch (cause) {
      setFailure(cause as RpcFailure);
      throw cause;
    }
  };
  const quiet = (run: () => Promise<void>) => () => void run().catch(() => {});
  const open = (next: Dialog) => () => setDialog(next);
  const close = (isOpen: boolean) => {
    if (!isOpen) setDialog(null);
  };
  const live = entry.state !== "forgotten";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.state === "candidate" ? (
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
            Edit…
          </Button>
        ) : null}
        {live ? (
          <Button size="sm" variant="outline" onClick={open("evidence")}>
            Add source…
          </Button>
        ) : null}
        {live ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label={`More actions for ${entry.title}`} className="px-2">
                <Icon name="MoreHorizontal" className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" mobileTitle={entry.title} className="w-60">
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
              {entry.state !== "archived" ? (
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
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {failure ? <FailureNotice failure={failure} /> : null}
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
          { icon: "Archive", text: "Archive instead keeps the text for history." },
        ]}
        confirm="Forget"
        destructive
        open={dialog === "forget"}
        onOpenChange={close}
        onConfirm={() => transition("forgotten", "Forgotten in Cortex", "Forgotten")}
      />
    </div>
  );
}

/** One entry in full: its words, where it applies, who approved it, what it rests on, and its history. */
export function KnowledgeDetail({
  entry,
  workstream,
  actions,
  onOpen,
  children,
}: {
  entry: Knowledge;
  workstream: Workstream | null;
  actions?: ReactNode;
  onOpen?: (id: string) => void;
  children?: ReactNode;
}) {
  const now = Date.now();
  const [showHistory, setShowHistory] = useState(false);
  return (
    <section aria-label={entry.title} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StateMark state={displayState(entry, now)} />
        <KindMark kind={entry.kind} />
        <span className="text-[11.5px] text-muted-foreground">{facetWord(entry.facet)}</span>
        {workstream ? <span className="text-[11.5px] text-muted-foreground">{workstream.name}</span> : null}
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-muted-foreground">
          {entry.id} · rev {entry.revision}
        </span>
      </div>
      <h3 className="text-[15px] leading-snug font-semibold text-foreground">{entry.title}</h3>
      {entry.state === "forgotten" ? (
        <p className="text-[12.5px] text-muted-foreground">Its text was forgotten. Who changed it and when stay in history.</p>
      ) : (
        <KnowledgeText text={entry.text} />
      )}
      <div className="flex flex-col gap-1.5">
        <Applicability value={entry.applicability} />
        <ApprovalLine entry={entry} />
        <ExpiryLine entry={entry} now={now} />
        <p className="text-[11.5px] text-muted-foreground">
          Last change by {actorWord(entry.actor)} · {relativeAge(entry.updatedAt, now)}
        </p>
        <Pointers entry={entry} onOpen={onOpen} />
      </div>
      {children}
      {actions}
      <div>
        <Heading count={entry.sources.length}>Sources</Heading>
        <SourceList sources={entry.sources} />
      </div>
      <div>
        <Heading
          trailing={
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
              {showHistory ? "Hide" : "Show"}
            </Button>
          }
        >
          History
        </Heading>
        {showHistory ? <KnowledgeHistory id={entry.id} /> : null}
      </div>
    </section>
  );
}
