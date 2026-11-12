import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import type { Section } from "../section-contract";
import { BriefStrip } from "./brief-strip";
import { deliverySummary, plural } from "./copy";
import { type OutputOf, useReviewQueue, useSectionDetail, useSections, useWorkstreams } from "./data";
import { displayState, oldestFirst, relativeAge } from "./model";
import { EmptyNote, FailureNotice } from "./parts";
import { CORTEX_PAGE_PATH } from "./thread-context";

function OverviewLoading({ label }: { label: string }) {
  return <div role="status" aria-label={label} aria-busy="true" className="space-y-3 py-3"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-4/5" /><Skeleton className="h-6 w-3/5" /></div>;
}

function ReviewSummary({ queue }: { queue: OutputOf<"reviewQueue"> }) {
  const navigate = useBbNavigate();
  if (queue.total === 0) return <div role="status" className="flex items-center gap-2 rounded-md border border-border-seam px-3 py-3 text-[13px]"><Icon name="CircleCheck" className="size-4 shrink-0 text-success" aria-hidden />Nothing waits for your review.</div>;
  const now = Date.now();
  const oldest = oldestFirst(queue.items)[0];
  const kinds = new Map<string, number>();
  for (const { entry } of queue.items) {
    const state = displayState(entry, now);
    const label = state === "candidate" ? entry.kind === "directive" ? "new rule" : "new finding" : state === "recheck" ? "needing re-check" : state;
    kinds.set(label, (kinds.get(label) ?? 0) + 1);
  }
  const summary = [...kinds].map(([label, count]) => label === "new rule" || label === "new finding" ? plural(count, label) : `${count} ${label}`).join(" · ");
  return <div data-part="ReviewSummary" className="flex flex-wrap items-center gap-3 rounded-md border border-border-seam bg-surface-attention px-3 py-3">
    <span className="text-3xl font-semibold tabular-nums">{queue.total}</span>
    <div className="min-w-0 flex-1 text-[13px]">
      <div className="flex flex-wrap gap-x-2"><b className="font-semibold">waiting for your review</b>{oldest ? <span className="text-muted-foreground">· oldest {relativeAge(oldest.entry.updatedAt, now)}</span> : null}</div>
      <div className="break-words text-[12px] text-muted-foreground">{summary}{queue.total > queue.items.length ? ` · showing ${queue.items.length} of ${queue.total}` : ""}</div>
    </div>
    <Button size="sm" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: "review" })}>Review</Button>
  </div>;
}

function SectionOverviewRow({ section, workstreamName, waiting }: { section: Section; workstreamName?: string; waiting: number }) {
  const navigate = useBbNavigate();
  const binding = section.binding.binding;
  const detail = useSectionDetail(binding ? section.id : null);
  const brief = detail.data?.eligibility;
  const go = (connect = false) => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `sections/${section.id}${connect ? "/connect" : ""}` });
  return <tr onClick={event => { if (!(event.target as HTMLElement).closest("button")) go(); }} className="group grid cursor-pointer min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b border-border-seam px-2 py-3 hover:bg-state-hover @min-[820px]:table-row @min-[820px]:p-0">
    <td className="min-w-0 @min-[820px]:px-2 @min-[820px]:py-3">
      <button type="button" aria-label={`Open ${section.name}`} onClick={() => go()} className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Icon name={binding ? "Brain" : "Folder"} className={`size-4 shrink-0 ${binding ? "text-primary" : "text-muted-foreground"}`} aria-hidden />
        <span className={`min-w-0 truncate ${binding ? "font-semibold" : "text-muted-foreground"}`} title={section.name}>{section.name}</span>
      </button>
    </td>
    <td className={`order-3 col-span-2 min-w-0 @min-[820px]:px-2 @min-[820px]:py-3 ${binding ? "" : "hidden @min-[820px]:table-cell"}`}>
      {binding ? <div className="flex min-w-0 flex-wrap items-center gap-2">
        {brief ? <><div className="w-32 max-w-full"><BriefStrip data={brief} compact /></div><span className="text-[12px] whitespace-nowrap text-muted-foreground tabular-nums">{deliverySummary(brief.status, `${brief.entries.length} in`)} · {brief.exclusions.length + brief.notices.length} held</span></> : detail.isLoading ? <Skeleton aria-label="Loading brief" className="h-2 w-32" /> : null}
        {detail.error ? <FailureNotice failure={detail.error} onRetry={detail.refetch} title={brief ? "Showing the last loaded brief." : undefined} /> : null}
        {brief?.error ? <span role="alert" className="break-words text-[12px] text-destructive-text">{brief.error}</span> : null}
      </div> : null}
    </td>
    <td className={`order-4 col-span-2 min-w-0 break-words text-[12px] [overflow-wrap:anywhere] @min-[820px]:px-2 @min-[820px]:py-3 ${binding ? "" : "hidden @min-[820px]:table-cell"}`}>
      {binding ? <>{workstreamName ?? "Connected workstream"}<span className="text-muted-foreground"> · {binding.topic || "Shared basics"}</span></> : null}
    </td>
    <td className="order-5 text-[12px] text-muted-foreground tabular-nums @min-[820px]:px-2 @min-[820px]:py-3 @min-[820px]:text-right"><span className="@min-[820px]:hidden">Threads · </span>{section.threadCount}</td>
    <td className="order-2 @min-[820px]:px-2 @min-[820px]:py-3 @min-[820px]:text-right">
      {binding ? waiting > 0 ? <button type="button" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: "review" })} aria-label={`Review ${waiting} waiting in ${section.name}`} className="min-h-8 rounded-sm bg-surface-attention px-2 text-[11px] whitespace-nowrap tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{waiting} waiting</button> : null : <Button size="sm" variant="ghost" aria-label={`Connect ${section.name}`} onClick={() => go(true)}>Connect</Button>}
    </td>
  </tr>;
}

export function OverviewPage() {
  const sections = useSections();
  const queue = useReviewQueue();
  const workstreams = useWorkstreams();
  const rows = sections.data?.sections ?? [];
  const bound = rows.filter(section => section.binding.binding !== null);
  const unbound = rows.filter(section => section.binding.binding === null);
  const waiting = new Map<string, number>();
  for (const item of queue.data?.items ?? []) if (item.entry.state === "candidate") waiting.set(item.workstream.id, (waiting.get(item.workstream.id) ?? 0) + 1);
  return <div data-cortex data-part="OverviewPage" className="@container h-full min-w-0 overflow-y-auto px-4 py-4 @min-[900px]:px-5">
    <div className="space-y-3">
      {sections.error ? <FailureNotice failure={sections.error} onRetry={sections.refetch} title={sections.data ? "Showing the last loaded sections." : undefined} /> : null}
      {queue.error ? <FailureNotice failure={queue.error} onRetry={queue.refetch} title={queue.data ? "Showing the last loaded review." : undefined} /> : null}
      {workstreams.error ? <FailureNotice failure={workstreams.error} onRetry={workstreams.refetch} /> : null}
      {queue.data ? <ReviewSummary queue={queue.data} /> : queue.isLoading ? <OverviewLoading label="Loading review" /> : null}
    </div>
    <div className="mt-5 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"><h2 className="font-semibold">Sections</h2>{sections.data ? <span className="text-muted-foreground">{bound.length} of {rows.length} sharing</span> : null}</div>
    {sections.isLoading ? <OverviewLoading label="Loading sections" /> : null}
    {sections.data && rows.length === 0 ? <EmptyNote icon="Folder">No bb sections yet.</EmptyNote> : null}
    {rows.length > 0 ? <table aria-label="Sections" data-part="SectionTable" className="block w-full min-w-0 text-left @min-[820px]:table @min-[820px]:table-fixed">
      <thead className="hidden border-b border-border-seam text-[11px] text-muted-foreground @min-[820px]:table-header-group"><tr><th scope="col" className="w-[28%] px-2 py-2 font-medium">Section</th><th scope="col" className="w-[26%] px-2 py-2 font-medium">Brief for new threads</th><th scope="col" className="px-2 py-2 font-medium">Workstream · topic</th><th scope="col" className="w-20 px-2 py-2 text-right font-medium">Threads</th><th scope="col" className="w-28 px-2 py-2"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody className="block @min-[820px]:table-row-group">
        {bound.map(section => <SectionOverviewRow key={section.id} section={section} workstreamName={workstreams.data?.workstreams.find(ws => ws.id === section.binding.binding?.workstreamId)?.name} waiting={waiting.get(section.binding.binding!.workstreamId) ?? 0} />)}
        {unbound.length > 0 ? <tr className="block border-b border-border-seam @min-[820px]:table-row"><td colSpan={5} className="block px-2 pt-5 pb-2 text-[11px] font-semibold text-muted-foreground @min-[820px]:table-cell">Not shared · {unbound.length}</td></tr> : null}
        {unbound.map(section => <SectionOverviewRow key={section.id} section={section} waiting={0} />)}
      </tbody>
    </table> : null}
  </div>;
}
