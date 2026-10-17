import { useEffect, useMemo, useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { CortexTaskDetail } from "../state";
import { initiallyOpen, splitSections } from "./sections";
import { relativeTime } from "./time";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function FileChips({ files }: { files: readonly string[] }) {
  return (
    <span className="my-1.5 flex flex-wrap gap-1">
      {files.map(file => (
        <span key={file} className="rounded bg-surface-recessed px-1.5 py-px font-mono text-[11px] text-file-accent">
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

/** The body split at its `## ` headings; long bodies open on their first section. */
export function BodySections({ body }: { body: string | null }) {
  const sections = useMemo(() => splitSections(body ?? ""), [body]);
  const [open, setOpen] = useState<boolean[]>(() => initiallyOpen(sections, body?.length ?? 0));
  useEffect(() => {
    setOpen(initiallyOpen(sections, body?.length ?? 0));
  }, [sections, body]);
  if (sections.length === 0) return <p className="mt-4 text-sm text-muted-foreground">This task has no body.</p>;
  const headed = sections.filter(s => s.heading !== null);
  const allOpen = sections.every((s, i) => s.heading === null || open[i]);
  return (
    <div className="mt-1">
      {headed.length > 0 ? (
        <div className="mt-4 mb-0.5 flex items-center">
          <span className="text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">
            {plural(headed.length, "section")}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => setOpen(sections.map(() => !allOpen))}
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>
      ) : null}
      {sections.map((section, i) =>
        section.heading === null ? (
          <div key="lead" className="my-3 text-[13px] leading-relaxed">
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
            <CollapsibleTrigger className="group flex w-full items-center gap-2 py-2.5 text-left">
              <Icon
                name="ChevronRight"
                className="size-4 shrink-0 text-subtle-foreground transition-transform group-data-[state=open]:rotate-90"
                aria-hidden
              />
              <span className="text-[13px] font-semibold text-foreground">{section.heading}</span>
              {section.items > 0 ? (
                <span className="ml-auto text-[11.5px] text-subtle-foreground">{plural(section.items, "item")}</span>
              ) : null}
            </CollapsibleTrigger>
            {open[i] || section.preview === "" ? null : (
              <p className="-mt-1 mb-2 ml-6 truncate text-xs text-muted-foreground" data-testid="section-preview">
                {section.preview}
              </p>
            )}
            <CollapsibleContent className="mb-3 ml-6 text-[13px] leading-relaxed">
              <Markdown content={section.markdown} />
            </CollapsibleContent>
          </Collapsible>
        ),
      )}
    </div>
  );
}
