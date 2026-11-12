import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import type { Section } from "../section-contract";
import { useSections, useWorkstream, useWorkstreams, useWorkstreamWrites } from "./data";
import { ConfirmDialog } from "./dialogs";
import { relativeAge } from "./model";
import { EmptyNote, FailureNotice } from "./parts";
import { CORTEX_PAGE_PATH } from "./thread-context";
import type { Knowledge, Workstream } from "./types";
import { WorkstreamDialog } from "./workstreams";

function countsOf(entries: Knowledge[]) {
  return { approved: entries.filter(entry => entry.state === "approved").length, waiting: entries.filter(entry => entry.state === "candidate").length };
}

function useWorkstreamCounts(id: string) {
  const [requested, setRequested] = useState(false);
  const read = useWorkstream(requested ? id : null);
  return {
    counts: read.data ? countsOf(read.data.entries) : undefined,
    partial: !!read.data && read.data.entries.length < read.data.total,
    error: read.error,
    retry: read.refetch,
    requested,
    load: () => setRequested(true),
  };
}

function WorkstreamListRow({ workstream, sections }: { workstream: Workstream; sections: Section[] | undefined }) {
  const navigate = useBbNavigate();
  const counts = useWorkstreamCounts(workstream.id);
  const writes = useWorkstreamWrites();
  const [dialog, setDialog] = useState<"edit" | "archive" | null>(null);
  const usedBy = (sections ?? []).filter(section => section.binding.binding?.workstreamId === workstream.id);
  const go = () => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: usedBy.length === 1 ? `sections/${usedBy[0]!.id}/knowledge` : `workstreams/${workstream.id}` });
  return <tr onClick={event => { if (!(event.target as HTMLElement).closest("button")) go(); }} className="grid min-w-0 cursor-pointer grid-cols-2 items-start gap-x-3 gap-y-2 border-b border-border-seam px-2 py-3 hover:bg-state-hover @min-[820px]:table-row @min-[820px]:p-0">
    <td className="col-span-2 min-w-0 pr-12 @min-[820px]:px-2 @min-[820px]:py-3">
      <button type="button" aria-label={`Open ${workstream.name} knowledge`} onClick={go} className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><span className="min-w-0 truncate" title={workstream.name}>{workstream.name}</span>{workstream.archived ? <span className="shrink-0 text-[11px] font-normal text-muted-foreground">Archived</span> : null}</button>
      {workstream.description ? <div className="line-clamp-2 break-words text-[12px] text-muted-foreground [overflow-wrap:anywhere]" title={workstream.description}>{workstream.description}</div> : null}
    </td>
    <td className="col-span-2 min-w-0 @min-[820px]:px-2 @min-[820px]:py-3">
      <span className="mr-2 text-[11px] text-muted-foreground @min-[820px]:hidden">Used by</span>
      <span className="inline-flex max-w-full flex-wrap gap-1">{!sections ? <span className="text-[12px] text-muted-foreground">Connections unavailable</span> : usedBy.length === 0 ? <span className="text-[12px] text-muted-foreground">No sections</span> : usedBy.map(section => <button key={section.id} type="button" title={section.name} onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `sections/${section.id}` })} className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-sm border border-border-seam px-1.5 text-[11px] hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><Icon name="Brain" className="size-3.5 shrink-0 text-primary" aria-hidden /><span className="min-w-0 truncate">{section.name}</span></button>)}</span>
    </td>
    <td className="text-[12px] tabular-nums @min-[820px]:px-2 @min-[820px]:py-3 @min-[820px]:text-right"><span className="mr-2 text-muted-foreground @min-[820px]:hidden">Approved</span>{counts.counts ? `${counts.partial ? "At least " : ""}${counts.counts.approved}` : <><span aria-label="Approved count unavailable">—</span>{!counts.requested ? <Button variant="ghost" size="sm" aria-label={`Load counts for ${workstream.name}`} onClick={counts.load}>Load counts</Button> : null}</>}</td>
    <td className="text-[12px] tabular-nums @min-[820px]:px-2 @min-[820px]:py-3 @min-[820px]:text-right"><span className="mr-2 text-muted-foreground @min-[820px]:hidden">Waiting</span>{counts.counts ? <span className={counts.counts.waiting > 0 ? "rounded-sm bg-surface-attention px-1.5" : "text-muted-foreground"}>{counts.partial ? "At least " : ""}{counts.counts.waiting}</span> : <span aria-label="Waiting count unavailable">—</span>}</td>
    <td className="col-span-2 text-[12px] text-muted-foreground tabular-nums @min-[820px]:px-2 @min-[820px]:py-3 @min-[820px]:text-right"><span className="mr-2 @min-[820px]:hidden">Updated</span><time dateTime={workstream.updatedAt} title={new Date(workstream.updatedAt).toLocaleString()}>{relativeAge(workstream.updatedAt, Date.now())}</time>{counts.error ? <FailureNotice failure={counts.error} onRetry={counts.retry} /> : null}</td>
    <td className="col-start-2 row-start-1 justify-self-end @min-[820px]:px-2 @min-[820px]:py-3 @min-[820px]:text-right">
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" aria-label={`Actions for ${workstream.name}`} className="px-2 max-[480px]:min-w-11 [@media(pointer:coarse)]:min-w-11"><Icon name="MoreHorizontal" className="size-4" aria-hidden /></Button></DropdownMenuTrigger>
        <DropdownMenuContent data-cortex align="end" mobileTitle={workstream.name}>
          <DropdownMenuItem onSelect={() => setDialog("edit")}><Icon name="Edit" aria-hidden />Edit…</DropdownMenuItem>
          {workstream.archived ? null : <DropdownMenuItem onSelect={() => setDialog("archive")}><Icon name="Archive" aria-hidden />Archive…</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <WorkstreamDialog workstream={workstream} open={dialog === "edit"} onOpenChange={open => setDialog(open ? "edit" : null)} />
      <ConfirmDialog title={`Archive ${workstream.name}?`} facts={[
        { icon: "Minus", text: "Connected threads stop getting its knowledge from their next session." },
        { icon: "Archive", text: "Its knowledge and history stay readable." },
        { icon: "SideChat", text: "Sessions already running keep what they received." },
      ]} confirm="Archive" open={dialog === "archive"} onOpenChange={open => setDialog(open ? "archive" : null)} onConfirm={async () => {
        await writes.editWorkstream({ id: workstream.id, expectedRevision: workstream.revision, archived: true, reason: "Archived in Cortex" });
        toast(`Archived ${workstream.name}`);
      }} />
    </td>
  </tr>;
}

export function WorkstreamList() {
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const workstreams = useWorkstreams(showArchived);
  const sections = useSections();
  return <div data-cortex data-part="WorkstreamList" className="@container h-full min-w-0 overflow-y-auto p-4 @min-[900px]:px-5">
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">A workstream is the knowledge one or more sections share.</p>
      <Button size="sm" variant="outline" aria-pressed={showArchived} onClick={() => setShowArchived(value => !value)} className="aria-pressed:bg-surface-selected">Show archived</Button>
      <Button variant="outline" size="sm" onClick={() => setCreating(true)}><Icon name="Plus" className="size-3.5" aria-hidden />New workstream</Button>
    </div>
    {workstreams.error ? <FailureNotice failure={workstreams.error} onRetry={workstreams.refetch} title={workstreams.data ? "Showing the last loaded workstreams." : undefined} /> : null}
    {sections.error ? <FailureNotice failure={sections.error} onRetry={sections.refetch} title="Connections could not be refreshed." /> : null}
    {workstreams.isLoading ? <div role="status" aria-label="Loading workstreams" aria-busy="true" className="space-y-3"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-4/5" /></div> : null}
    {workstreams.data?.workstreams.length === 0 ? <EmptyNote icon="Layers">{showArchived ? "No workstreams yet." : "No active workstreams yet."}</EmptyNote> : null}
    {workstreams.data && workstreams.data.workstreams.length > 0 ? <table aria-label="Workstreams" className="block w-full min-w-0 text-left @min-[820px]:table @min-[820px]:table-fixed">
      <thead className="hidden border-b border-border-seam text-[11px] text-muted-foreground @min-[820px]:table-header-group"><tr><th scope="col" className="w-[40%] px-2 py-2 font-medium">Workstream</th><th scope="col" className="px-2 py-2 font-medium">Used by</th><th scope="col" className="w-20 px-2 py-2 text-right font-medium">Approved</th><th scope="col" className="w-20 px-2 py-2 text-right font-medium">Waiting</th><th scope="col" className="w-28 px-2 py-2 text-right font-medium">Updated</th><th scope="col" className="w-12 px-2 py-2"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody className="block @min-[820px]:table-row-group">{workstreams.data.workstreams.map(workstream => <WorkstreamListRow key={workstream.id} workstream={workstream} sections={sections.data?.sections} />)}</tbody>
    </table> : null}
    {workstreams.data && workstreams.data.total > workstreams.data.workstreams.length ? <p role="status" className="mt-3 text-[12px] text-muted-foreground">Showing {workstreams.data.workstreams.length} of {workstreams.data.total} workstreams.</p> : null}
    <WorkstreamDialog workstream={null} open={creating} onOpenChange={setCreating} />
  </div>;
}
