import { useEffect, useRef, useState, type JSX } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { DraftJob } from "../draft-contract";
import type { Section } from "../section-contract";
import { useDraftJobs, useSectionDetail } from "./data";
import { DraftDialog, DraftJobView, terminal } from "./drafting";
import { relativeAge } from "./model";
import { FailureNotice, LoadingRows } from "./parts";
import { CORTEX_PAGE_PATH } from "./thread-context";

const RECENT_FINISHED_MS = 24 * 60 * 60 * 1000;

function RailJob({ section, job }: { section: Section; job: DraftJob }): JSX.Element | null {
  const navigate = useBbNavigate();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!terminal(job)) return;
    const remaining = Date.parse(job.updatedAt) + RECENT_FINISHED_MS - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [job.status, job.updatedAt]);
  if (terminal(job) && Date.parse(job.updatedAt) + RECENT_FINISHED_MS <= now) return null;
  return <section data-cortex data-part="DraftJobCard" aria-label="Drafting" className="min-w-0 overflow-hidden rounded-lg border border-border-seam bg-card">
    <header className="flex items-center gap-2 border-b border-border-seam px-3 py-2"><Icon name="AiContentGenerator01" className="size-4 shrink-0 text-primary" aria-hidden /><h3 className="grow text-[13px] font-semibold">Drafting</h3><time dateTime={job.updatedAt} title={new Date(job.updatedAt).toLocaleString()} className="text-[12px] text-muted-foreground">{relativeAge(job.updatedAt, Date.now())}</time></header>
    <DraftJobView job={job} section={section} compact onDetails={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `sections/${section.id}/drafts` })} />
  </section>;
}

function RailPage({ section, offset }: { section: Section; offset: number }): JSX.Element | null {
  const read = useDraftJobs(section.id, offset);
  if (!read.data) return read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : <LoadingRows label="Loading drafting jobs" />;
  return <>
    {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
    <RailResult section={section} jobs={read.data.jobs} />
  </>;
}

function RailResult({ section, jobs }: { section: Section; jobs: DraftJob[] }): JSX.Element | null {
  const latest = jobs.at(-1);
  return latest ? <RailJob section={section} job={latest} /> : null;
}

export function DraftRailCard({ section }: { section: Section }): JSX.Element | null {
  const first = useDraftJobs(section.id);
  if (!first.data) return first.error ? <FailureNotice failure={first.error} onRetry={first.refetch} /> : <LoadingRows label="Loading drafting jobs" />;
  if (first.data.total === 0 && !first.error) return null;
  const offset = Math.floor(Math.max(0, first.data.total - 1) / 20) * 20;
  return <>{first.error ? <FailureNotice failure={first.error} onRetry={first.refetch} /> : null}{offset === 0 ? <RailResult section={section} jobs={first.data.jobs} /> : <RailPage section={section} offset={offset} />}</>;
}

export function DraftsTab({ section }: { section: Section }): JSX.Element | null {
  const [chosenPage, setPage] = useState<{ sectionId: string; offset: number } | null>(null);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useDraftJobs(section.id);
  const offset = chosenPage?.sectionId === section.id ? chosenPage.offset : Math.floor(Math.max(0, (first.data?.total ?? 0) - 1) / 20) * 20;
  const page = useDraftJobs(section.id, offset, offset !== 0);
  const read = offset === 0 ? first : page;
  const detail = useSectionDetail(section.id);
  const error = first.error ?? read.error;
  const retry = () => { first.refetch(); if (offset !== 0) page.refetch(); };
  return <section data-cortex data-part="DraftJobs" aria-label="Drafting jobs" className="grid min-w-0 max-w-4xl gap-3 text-[13px] [container-type:inline-size] [&_button]:min-h-11">
    <header className="flex flex-wrap items-center gap-2"><h2 className="grow font-semibold">Drafts{first.data ? ` (${first.data.total})` : ""}</h2><Button ref={trigger} disabled={!section.binding.binding || !detail.data || Boolean(detail.error)} onClick={() => setOpen(true)}><Icon name="AiContentGenerator01" className="mr-1 size-4" aria-hidden />Draft from a thread</Button></header>
    {error ? <FailureNotice failure={error} onRetry={retry} /> : null}
    {detail.error ? <FailureNotice failure={detail.error} onRetry={detail.refetch} /> : null}
    {read.isLoading ? <LoadingRows label="Loading drafting jobs" /> : null}
    {read.data?.total === 0 ? <p className="rounded-lg border border-dashed border-border-seam p-4 text-muted-foreground">No drafts yet.</p> : null}
    {read.data ? [...read.data.jobs].reverse().map(job => <DraftJobView key={job.requestId} job={job} section={section} />) : null}
    {first.data && first.data.total > 20 ? <nav aria-label="Draft history pages" className="flex flex-wrap items-center gap-2 text-muted-foreground"><span className="grow">{offset} earlier drafts · {offset + 1}–{Math.min(offset + 20, first.data.total)} of {first.data.total}</span><Button variant="outline" disabled={offset === 0} onClick={() => setPage({ sectionId: section.id, offset: Math.max(0, offset - 20) })}>Earlier drafts</Button><Button variant="outline" disabled={offset + 20 >= first.data.total} onClick={() => setPage({ sectionId: section.id, offset: offset + 20 })}>More drafts</Button></nav> : null}
    <DraftDialog key={section.id} section={section} threads={detail.data?.threads ?? []} open={open} onClose={() => setOpen(false)} onReturnFocus={() => trigger.current?.focus()} />
  </section>;
}
