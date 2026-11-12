import { useEffect, useMemo, useState } from "react";
import { experimental_useSidebarThreads, Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { CortexTaskDetail } from "../state";
import { useSectionDetail } from "../ui/data";
import { CORTEX_PAGE_PATH } from "../ui/thread-context";
import { initiallyOpen, splitSections } from "./sections";
import { deliverySummary } from "../ui/copy";
import { relativeTime } from "./time";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function FileChips({ files }: { files: readonly string[] }) {
  return (
    <span className="my-1.5 flex flex-wrap gap-1">
      {files.map(file => (
        <span key={file} className="max-w-full break-words rounded bg-surface-recessed px-1.5 py-px font-mono text-[11px] text-file-accent [overflow-wrap:anywhere]">
          {file}
        </span>
      ))}
    </span>
  );
}

/** Why the body may be out of date: the changed and missing files, the sync age, and the unfolded updates. */
export function FreshnessCallout({
  detail,
  flash,
  onShowActivity,
}: {
  detail: CortexTaskDetail;
  flash: boolean;
  onShowActivity: () => void;
}) {
  const { staleness, sync } = detail;
  if (staleness.verdict === "fresh") return null;
  const synced = relativeTime(sync.syncedAt);
  const notFolded =
    sync.notFolded > 0 ? (
      <>
        {" "}
        {plural(sync.notFolded, "update is", "updates are")} not yet folded into the body.{" "}
        <button type="button" className="text-primary hover:underline" onClick={onShowActivity}>
          See them in Activity
        </button>
      </>
    ) : null;
  if (staleness.verdict === "unverifiable") {
    return (
      <div
        role="note"
        data-testid="freshness-callout"
        className={cn(
          "flex gap-2.5 rounded-lg border border-border bg-surface-recessed px-3 py-2.5 text-[12.5px] leading-normal transition-shadow",
          flash && "ring-2 ring-ring/40",
        )}
      >
        <Icon name="CircleQuestion" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          Freshness not checked{staleness.reason ? `: ${staleness.reason}` : ""}.{notFolded}
        </div>
      </div>
    );
  }
  const files = [...sync.changed, ...sync.missing];
  return (
    <div
      role="note"
      data-testid="freshness-callout"
      className={cn(
        "flex gap-2.5 rounded-lg border border-warning/45 bg-warning/10 px-3 py-2.5 text-[12.5px] leading-normal transition-shadow",
        flash && "ring-2 ring-warning/35",
      )}
    >
      <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden />
      <div>
        <b className="font-semibold text-warning-text">This body may be out of date.</b>{" "}
        {sync.changed.length > 0 ? (
          <>
            {plural(sync.changed.length, "file")} it cites changed since it was last synced {synced}:
            <FileChips files={sync.changed} />
          </>
        ) : null}
        {sync.missing.length > 0 ? (
          <>
            {plural(sync.missing.length, "file")} it cites {sync.missing.length === 1 ? "is" : "are"} missing:
            <FileChips files={sync.missing} />
          </>
        ) : null}
        {files.length === 0 ? <>It was last synced {synced}. </> : null}
        {sync.old ? <>That sync is {sync.ageDays} days old. </> : null}
        {notFolded}
      </div>
    </div>
  );
}

export function UnfoldedUpdates({ count, onShow }: { count: number; onShow: () => void }) {
  if (count === 0) return null;
  return (
    <div data-testid="unfolded-updates" role="note" className="mb-3 flex items-center gap-2 rounded-md border border-attention/30 bg-surface-attention px-3 py-2 text-[12.5px]">
      <Icon name="TimeSchedule" className="size-4 shrink-0 text-attention" aria-hidden />
      <span className="min-w-0 flex-1"><b className="font-semibold">{plural(count, "update")}</b> {count === 1 ? "is" : "are"} not in the body yet.</span>
      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onShow}>Show</Button>
    </div>
  );
}

export function BriefBridge({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { threads } = experimental_useSidebarThreads();
  const sectionId = threads.find(thread => thread.id === threadId)?.sectionId ?? null;
  const read = useSectionDetail(sectionId);
  if (!read.data || read.error || !read.data.section.binding.binding) return null;
  const { section, eligibility, review } = read.data;
  return (
    <Button variant="ghost" className="mt-4 h-auto w-full justify-start whitespace-normal rounded-md border border-surface-selected-border bg-surface-selected px-3 py-3 text-left text-xs" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `sections/${section.id}` })}>
      <Icon name="Brain" className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]"><b className="font-semibold">{section.name}</b> brief · {deliverySummary(eligibility.status, `${eligibility.entries.length} go in`)} · {review.total} to review</span>
      <Icon name="ChevronRight" className="size-3.5 shrink-0" aria-hidden />
    </Button>
  );
}

export function useBodySections(body: string | null) {
  const sections = useMemo(() => splitSections(body ?? ""), [body]);
  const [open, setOpen] = useState<boolean[]>(() => initiallyOpen(sections, body?.length ?? 0));
  useEffect(() => {
    setOpen(initiallyOpen(sections, body?.length ?? 0));
  }, [sections, body]);
  const allOpen = sections.every((s, i) => s.heading === null || open[i]);
  return { sections, open, setOpen, allOpen, hasHeadings: sections.some(section => section.heading !== null), toggleAll: () => setOpen(sections.map(() => !allOpen)) };
}

/** The body split at its `## ` headings; long bodies open on their first section. */
export function BodySections({ state }: { state: ReturnType<typeof useBodySections> }) {
  const { sections, open, setOpen } = state;
  if (sections.length === 0) return <p className="mt-4 text-sm text-muted-foreground">This task has no body.</p>;
  return (
    <div className="mt-1 min-w-0 break-words [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto">
      {sections.map((section, i) =>
        section.heading === null ? (
          <div key="lead" data-content className="my-3 text-[13px] leading-relaxed">
            <Markdown content={section.markdown} />
          </div>
        ) : (
          <Collapsible
            key={`${i}:${section.heading}`}
            open={open[i] ?? false}
            onOpenChange={next => setOpen(current => current.map((value, j) => (j === i ? next : value)))}
            className="border-t border-border first-of-type:border-t-0"
            data-testid="body-section"
          >
            <CollapsibleTrigger className="group flex min-h-10 w-full items-center gap-2 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <Icon
                name="ChevronRight"
                className="size-4 shrink-0 text-subtle-foreground transition-transform group-data-[state=open]:rotate-90"
                aria-hidden
              />
              <span className="min-w-0 break-words text-[13px] font-semibold text-foreground">{section.heading}</span>
              {section.items > 0 ? (
                <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{plural(section.items, "item")}</span>
              ) : null}
            </CollapsibleTrigger>
            {open[i] || section.preview === "" ? null : (
              <p className="-mt-1 mb-2 ml-6 truncate text-xs text-muted-foreground" data-testid="section-preview">
                {section.preview}
              </p>
            )}
            <CollapsibleContent data-content className="mb-3 ml-6 text-[13px] leading-relaxed">
              <Markdown content={section.markdown} />
            </CollapsibleContent>
          </Collapsible>
        ),
      )}
    </div>
  );
}
