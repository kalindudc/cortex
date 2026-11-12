import type { JSX } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { SectionEligibility } from "../section-contract";
import { deliverySummary, tokens } from "./copy";
import { heldReason } from "./marks";
import type { Knowledge } from "./types";

/** `estimatedTokens` is the whole exact text (preamble and scope included); when given, the gap is drawn as an overhead segment. */
export type BriefInput = Pick<SectionEligibility, "entries" | "notices" | "budgetTokens"> & { estimatedTokens?: number; status?: SectionEligibility["status"] };
export type BriefSegment = {
  key: string;
  kind: "overhead" | "entry" | "notice";
  knowledgeKind?: Knowledge["kind"];
  tokens: number;
  title: string;
  cut: boolean;
};
export type BriefData = {
  segments: BriefSegment[];
  status?: SectionEligibility["status"];
  used: number;
  budget: number;
  scale: number;
  cutCount: number;
};

export function briefSegments(input: BriefInput): BriefData {
  let used = 0;
  let cutCount = 0;
  const parts = input.entries.reduce((sum, entry) => sum + entry.estimatedTokens, 0) + input.notices.reduce((sum, notice) => sum + notice.estimatedTokens, 0);
  const overhead = input.estimatedTokens === undefined ? 0 : Math.max(0, input.estimatedTokens - parts);
  const segments: BriefSegment[] = [
    ...(overhead > 0 ? [{ key: "overhead", kind: "overhead" as const, tokens: overhead, title: "Preamble and scope", cut: false }] : []),
    ...input.entries.map(entry => ({
      key: entry.knowledge.id,
      kind: "entry" as const,
      knowledgeKind: entry.knowledge.kind,
      tokens: entry.estimatedTokens,
      title: entry.knowledge.title,
      cut: false,
    })),
    ...input.notices.map(notice => ({
      key: notice.id,
      kind: "notice" as const,
      tokens: notice.estimatedTokens,
      title: `Notice only: ${heldReason(notice).label}`,
      cut: false,
    })),
  ];
  for (const segment of segments) {
    used += segment.tokens;
    segment.cut = used > input.budgetTokens;
    if (segment.cut) cutCount++;
  }
  return { segments, used, budget: input.budgetTokens, scale: Math.max(input.budgetTokens, used), cutCount, ...(input.status ? { status: input.status } : {}) };
}

export type BriefStripProps = {
  data: BriefInput | BriefData;
  compact?: boolean;
  highlightKey?: string | null;
  onHover?: (key: string | null) => void;
  heldCount?: number;
};

export function BriefStrip({ data, compact = false, highlightKey, onHover, heldCount }: BriefStripProps): JSX.Element {
  const brief = "segments" in data ? data : briefSegments(data);
  const entryCount = brief.segments.filter(segment => segment.kind === "entry").length;
  const noticeCount = brief.segments.filter(segment => segment.kind === "notice").length;
  const status = brief.status ?? (brief.used > brief.budget ? "over-budget" : "ready");
  const ready = status === "ready";
  return (
    <div
      data-cortex
      className={cn("cortex-strip min-w-0 w-full", compact && "cortex-strip-compact")}
      role="img"
      aria-label={`${tokens(brief.used)} of ${brief.budget} tokens. ${entryCount} entries ${ready ? "go in" : "selected"}, ${noticeCount} notices, ${deliverySummary(status, "Within budget.")}`}
    >
      <div className={cn("relative flex bg-surface-recessed", compact ? "h-2" : "h-3.5")}>
          {brief.segments.map(segment => {
            const title = `${segment.title} · ${tokens(segment.tokens)} tokens${segment.cut ? " · past the budget" : ""}`;
            return (
                  <span
                    key={`${segment.kind}:${segment.key}`}
                    data-segment-key={segment.key}
                    title={title}
                    style={{ width: `${100 * segment.tokens / brief.scale}%` }}
                    className={cn(
                      "cortex-strip-segment h-full shrink-0",
                      segment.kind === "entry" && "bg-primary",
                      segment.kind === "overhead" && "bg-muted-foreground/40",
                      segment.knowledgeKind === "directive" && "cortex-strip-directive",
                      (segment.kind === "notice" || (!ready && segment.kind === "entry")) && "cortex-hatch-notice",
                      segment.cut && "cortex-hatch-cut",
                      highlightKey === segment.key && "cortex-strip-highlight",
                    )}
                    onMouseEnter={() => onHover?.(segment.key)}
                    onMouseLeave={() => onHover?.(null)}
                  />
            );
          })}
        <span
          aria-hidden
          className="cortex-strip-cut pointer-events-none absolute -top-1 -bottom-1 w-0.5 bg-foreground"
          style={{ left: `calc(${100 * brief.budget / brief.scale}% - 1px)` }}
        />
      </div>
      {!compact ? (
        <div className="cortex-strip-legend mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground tabular-nums">
          <span><b className="font-semibold text-foreground">{tokens(brief.used)}</b> / {brief.budget} tokens</span>
          <span className="inline-flex items-center gap-1"><span aria-hidden className="size-2.5 bg-primary" /><b className="font-semibold text-foreground">{entryCount}</b> {ready ? "go in" : "selected"}</span>
          <span className="inline-flex items-center gap-1"><span aria-hidden className="cortex-hatch-notice size-2.5" /><b className="font-semibold text-foreground">{noticeCount}</b> {ready ? "notice only" : "notices selected"}</span>
          {heldCount === undefined ? null : <span className="inline-flex items-center gap-1"><span aria-hidden className="size-2.5 border border-dashed border-border-seam" /><b className="font-semibold text-foreground">{heldCount}</b> held back</span>}
          {!ready ? <span className="text-destructive-text">{deliverySummary(status, "")}</span> : null}
          {brief.used > brief.budget ? (
            <span className="inline-flex items-center gap-1 text-destructive-text">
              <Icon name="AlertTriangle" className="size-3.5 shrink-0" aria-hidden />
              <span><b className="font-semibold">Over budget by {tokens(brief.used - brief.budget)}</b>: nothing is sent until it fits</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
