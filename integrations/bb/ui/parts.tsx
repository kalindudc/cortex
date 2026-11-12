import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AUTHOR_WORD,
  actorWord,
  type DisplayState,
  dimensionWord,
  KIND_LOOK,
  SOURCE_STATUS_WORD,
  STATE_LOOK,
  type Tone,
  tokens,
  UNKNOWN_HINT,
} from "./copy";
import type { RpcFailure } from "./data";
import { shortTime } from "./model";
import type { ContextEntry, ContextNotice, Knowledge, KnowledgeSource, ThreadContext } from "./types";

export const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  attention: "text-attention",
  warning: "text-warning-text",
  destructive: "text-destructive-text",
  muted: "text-muted-foreground",
  primary: "text-primary",
};

/** A state glyph with its word, so state never rides on colour alone. */
export function StateMark({ state, compact = false }: { state: DisplayState; compact?: boolean }) {
  const look = STATE_LOOK[state];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", TONE_TEXT[look.tone])} data-state={state}>
      <Icon name={look.icon} className="size-3.5" aria-hidden />
      <span className={compact ? "sr-only" : "text-[11.5px]"}>{look.word}</span>
    </span>
  );
}

export function KindMark({ kind }: { kind: Knowledge["kind"] }) {
  const look = KIND_LOOK[kind];
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Icon name={look.icon} className="size-3.5" aria-hidden />
      <span className="text-[11.5px]">{look.word}</span>
    </span>
  );
}

/** Environment and host as named chips; unknown carries a warning and its reason on demand. */
export function Applicability({ value }: { value: Knowledge["applicability"] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {(["environment", "host"] as const).map(name => {
        const dimension = value[name];
        const unknown = dimension.mode === "unknown";
        const chip = (
          <span
            key={name}
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded-sm border px-1.5 text-[11px]",
              unknown ? "border-warning/50 text-warning-text" : "border-border-seam text-muted-foreground",
            )}
          >
            {unknown ? <Icon name="CircleQuestion" className="size-3" aria-hidden /> : null}
            {dimensionWord(name, dimension)}
          </span>
        );
        return unknown ? (
          <Hint key={name} text={UNKNOWN_HINT}>
            {chip}
          </Hint>
        ) : (
          chip
        );
      })}
    </span>
  );
}

export function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-[12px]">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Who approved it, kept apart from who wrote the sources: a source's author is never approval. */
export function ApprovalLine({ entry }: { entry: Knowledge }) {
  if (entry.approval === null) {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
        <Icon name="CircleDot" className="size-3.5" aria-hidden />
        Not approved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-foreground">
      <Icon name="SecurityCheck" className="size-3.5 text-success" aria-hidden />
      Approved by {actorWord(entry.approval.actor)} · {shortTime(entry.approval.at)}
    </span>
  );
}

const WEB_REF = /^https?:\/\/\S+$/;
const LONG_EXCERPT = 280;

function SourceRef({ value }: { value: string }) {
  const navigate = useBbNavigate();
  if (!WEB_REF.test(value)) return <span className="min-w-0 font-mono break-all text-muted-foreground">{value}</span>;
  return (
    <button
      type="button"
      onClick={() => {
        if (!navigate.openUrl(value)) toast.error("bb could not open this link here.");
      }}
      className="min-w-0 rounded-sm text-left font-mono break-all text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {value}
    </button>
  );
}

function SourceExcerpt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_EXCERPT || text.split("\n").length > 3;
  return (
    <div className="mt-1 flex flex-col items-start gap-0.5">
      <blockquote data-content className={cn("text-[12.5px] whitespace-pre-wrap break-words text-foreground", long && !open && "line-clamp-3")}>
        {text}
      </blockquote>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="rounded-sm text-[11.5px] text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {open ? "Show less" : `Show all ${text.length.toLocaleString()} characters`}
        </button>
      ) : null}
    </div>
  );
}

export function SourceList({ sources }: { sources: readonly KnowledgeSource[] }) {
  if (sources.length === 0) return <p className="text-[12px] text-muted-foreground">No sources.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {sources.map((source, index) => {
        const status = source.status ? SOURCE_STATUS_WORD[source.status] : null;
        return (
          <li key={`${index}-${source.ref}-${source.observedAt}`} className="border-l-2 border-border-seam pl-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px]">
              <span className="font-semibold text-foreground">{AUTHOR_WORD[source.authorType]}</span>
              <span className="text-muted-foreground">observed {shortTime(source.observedAt)}</span>
              {status ? (
                <Hint text="Reported by whoever added the source; Cortex did not check it.">
                  <span className="text-warning-text">{status}</span>
                </Hint>
              ) : null}
            </div>
            <p className="mt-0.5 text-[11.5px]">
              <SourceRef value={source.ref} />
            </p>
            {source.excerpt ? <SourceExcerpt text={source.excerpt} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Saved text is data, never instructions: shown verbatim, never rendered as Markdown. */
export function KnowledgeText({ text, clamp = false }: { text: string; clamp?: boolean }) {
  return (
    <p data-content className={cn("text-[13px] leading-relaxed whitespace-pre-wrap break-words text-foreground", clamp && "line-clamp-3")}>
      {text}
    </p>
  );
}

export function Heading({ children, count, trailing }: { children: ReactNode; count?: number; trailing?: ReactNode }) {
  return (
    <div className="mt-4 mb-1.5 flex items-center gap-2">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>
      {count === undefined ? null : <span className="text-[11px] text-muted-foreground tabular-nums">{count}</span>}
      <span className="flex-1" />
      {trailing}
    </div>
  );
}

export function FailureNotice({ failure, onRetry, title }: { failure: RpcFailure; onRetry?: () => void; title?: string }) {
  const conflict = failure.code === "conflict";
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-surface-destructive px-3 py-2 text-[12.5px] text-foreground"
    >
      <Icon name={conflict ? "GitBranch" : "AlertCircle"} className="mt-0.5 size-4 shrink-0 text-destructive-text" aria-hidden />
      <span className="min-w-0 flex-1 break-words">
        {title ?? (conflict ? "Changed since you opened it." : null)} {failure.message}
      </span>
      {onRetry ? (
        <Button variant="outline" size="sm" className="h-7 px-2.5" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function LoadingRows({ rows = 4, label }: { rows?: number; label: string }) {
  return (
    <DelayedLoading>
      <div aria-busy="true" aria-label={label} className="flex flex-col gap-2 py-2">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-4" style={{ width: `${90 - index * 12}%` }} />
        ))}
      </div>
    </DelayedLoading>
  );
}

export function EmptyNote({ icon = "Layers", children, action }: { icon?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div data-empty className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border-seam px-3 py-3 text-[12.5px] text-muted-foreground">
      <span className="inline-flex items-center gap-2">
        <Icon name={icon} className="size-4" aria-hidden />
        {children}
      </span>
      {action}
    </div>
  );
}

/**
 * A segmented choice. Arrow keys move within the group only; the handler sits
 * on the group, never on the document.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = options.findIndex(option => option.value === value);
    const next = (index + delta + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={move} className={cn("inline-flex flex-wrap border border-border-seam rounded-md p-0.5", className)}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={node => {
            refs.current[index] = node;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value || (index === 0 && !options.some(option => option.value === value)) ? 0 : -1}
          onClick={() => onChange(option.value)}
          className={cn(
            "min-h-7 rounded-sm px-2.5 text-[12px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            option.value === value ? "bg-surface-selected font-semibold text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type Segment = { id: string; tokens: number; label: string; tone: "directive" | "finding" | "notice" | "thread" };
const SEGMENT_FILL: Record<Segment["tone"], string> = {
  directive: "bg-primary/70",
  finding: "bg-success/60",
  notice: "bg-warning/55",
  thread: "bg-attention/60",
};

export function segmentsOf(context: ThreadContext): Segment[] {
  const entries = context.entries.map((entry: ContextEntry) => ({
    id: entry.knowledge.id,
    tokens: entry.estimatedTokens,
    label: entry.knowledge.title,
    tone: (entry.origin === "canonical" ? entry.knowledge.kind : "thread") as Segment["tone"],
  }));
  const notices = context.notices.map((notice: ContextNotice) => ({
    id: notice.id,
    tokens: notice.estimatedTokens,
    label: "Notice only",
    tone: "notice" as const,
  }));
  return [...entries, ...notices];
}

/**
 * The cut line: the budget as a bar, each piece of the next context as a
 * segment, the budget edge as a rule. Tokens not tied to an entry (the header
 * and footer) sit before the first entry so the total always matches.
 */
export function BudgetBar({ context, className }: { context: ThreadContext; className?: string }) {
  const segments = segmentsOf(context);
  const assigned = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const scale = Math.max(context.budgetTokens, context.estimatedTokens, 1);
  const header = Math.max(0, context.estimatedTokens - assigned);
  const over = context.estimatedTokens > context.budgetTokens;
  const pct = (n: number) => `${(100 * n) / scale}%`;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div
        role="img"
        aria-label={`${tokens(context.estimatedTokens)} of ${context.budgetTokens} tokens${over ? ", over budget" : ""}`}
        className="relative flex h-3 overflow-hidden rounded-sm bg-muted"
      >
        {header > 0 ? <span className="h-full bg-muted-foreground/35" style={{ width: pct(header) }} /> : null}
        {segments.map(segment => (
          <span
            key={segment.id}
            title={`${segment.label} · ${tokens(segment.tokens)} tokens`}
            className={cn("h-full border-r border-background", SEGMENT_FILL[segment.tone])}
            style={{ width: pct(segment.tokens) }}
          />
        ))}
        <span aria-hidden className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: `calc(${pct(context.budgetTokens)} - 1px)` }} />
      </div>
      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground tabular-nums">
        <span className={over ? "font-semibold text-destructive-text" : "text-foreground"}>
          {tokens(context.estimatedTokens)} / {context.budgetTokens} tokens
        </span>
        <span aria-hidden>·</span>
        <span>{context.entries.length} with text</span>
        {context.notices.length > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span>{context.notices.length} notice only</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function IconButton({
  label,
  icon,
  onClick,
  className,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      <Icon name={icon} className="size-4" aria-hidden />
    </button>
  );
}

/** Below a paged list: how much is shown, a way to load older rows, and a note when pages were read at different moments. */
export function PagedFooter({
  shown,
  total,
  noun,
  onMore,
  changedWhileReading,
  onRetry,
}: {
  shown: number;
  total: number;
  noun: string;
  onMore: () => void;
  changedWhileReading: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1">
      {changedWhileReading ? (
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-warning-text">
          Changed while loading, so pages may overlap or skip a row.
          <button type="button" onClick={onRetry} className="rounded-sm underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            Reload
          </button>
        </p>
      ) : null}
      {total > shown ? (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={onMore}>
          Show older · {shown} of {total} {noun}
        </Button>
      ) : shown > 0 ? (
        <span className="text-[11.5px] text-muted-foreground">All {total} {noun}</span>
      ) : null}
    </div>
  );
}
