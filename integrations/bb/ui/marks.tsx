import type { JSX } from "react";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { BRIEF_KIND_LOOK, BRIEF_STATE_LOOK, type DisplayState, STATE_LOOK, type Tone } from "./copy";
import { displayState, relativeAge } from "./model";
import { TONE_TEXT } from "./parts";
import type { ContextNotice, Knowledge, ThreadContext } from "./types";

export type KnowledgeStateMarkProps =
  | { entry: Knowledge; state?: never; expiresAt?: never }
  | { entry?: never; state: DisplayState; expiresAt?: Knowledge["expiresAt"] };

export function KnowledgeStateMark(props: KnowledgeStateMarkProps): JSX.Element {
  const now = Date.now();
  const state = props.entry
    ? displayState(props.entry, now)
    : props.state === "approved" && props.expiresAt != null && Date.parse(props.expiresAt) <= now
      ? "expired"
      : props.state;
  const look = BRIEF_STATE_LOOK[state];
  return (
    <span data-cortex data-state={state} className={cn("inline-flex items-center gap-1 text-[11.5px]", TONE_TEXT[look.tone])}>
      <Icon name={look.icon} className="size-3.5 shrink-0" aria-hidden />
      <span className="whitespace-nowrap">{look.word}</span>
    </span>
  );
}

export function KindMark({ kind }: { kind: Knowledge["kind"] }): JSX.Element {
  const look = BRIEF_KIND_LOOK[kind];
  return (
    <span data-cortex className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
      <Icon name={look.icon} className="size-3.5 shrink-0" aria-hidden />
      <span className="whitespace-nowrap">{look.word}</span>
    </span>
  );
}

export type HeldReason = {
  label: string;
  icon: IconName;
  tone: Tone;
  fix?: "targets" | "observe" | "review" | "open";
};

export type HeldReasonContext = {
  entry?: Knowledge | null;
  applicability?: Knowledge["applicability"];
  now?: number;
};

const NOTICE_REASON: Record<string, string> = {
  "unknown-applicability": "environment or host unknown/mismatched",
  "applicability-mismatch": "environment or host unknown/mismatched",
  expired: "expired; needs recheck",
  "source-unreachable": "source unavailable; needs recheck",
};

export function heldReason(
  item: ThreadContext["exclusions"][number] | ContextNotice,
  ctx: HeldReasonContext = {},
): HeldReason {
  // Notices carry the CLI's reason codes; exclusions carry sentences. Both
  // name the same causes, so codes map onto the sentence they mean.
  const reason = NOTICE_REASON[item.reason] ?? item.reason;
  if (reason === "environment or host unknown/mismatched") {
    const applicability = ctx.entry?.applicability;
    const dimensions = ["environment", "host"] as const;
    // An entry whose own environment or host is unknown never matches any
    // target, so only editing the entry lets it in.
    const own = applicability ? dimensions.filter(name => applicability[name].mode === "unknown") : item.reason === "unknown-applicability" ? [...dimensions] : [];
    if (own.length > 0) {
      const label = own.length === 2 ? (applicability ? "Environment and host unknown" : "Environment or host unknown") : `${own[0] === "host" ? "Host" : "Environment"} unknown`;
      return { label, icon: "CircleQuestion", tone: "warning", fix: "open" };
    }
    if (applicability) {
      if (dimensions.some(name => applicability[name].mode === "value" && ctx.applicability?.[name]?.mode === "unknown")) {
        return { label: "Needs a target", icon: "Target", tone: "warning", fix: "targets" };
      }
      for (const name of dimensions) {
        const entry = applicability[name];
        const target = ctx.applicability?.[name];
        if (entry.mode === "value" && (!target || target.mode !== "value" || entry.value !== target.value)) {
          return {
            label: `Other ${name}: ${entry.value}`,
            icon: name === "host" ? "ComputerCloud" : "Globe",
            tone: "muted",
            fix: "open",
          };
        }
      }
    }
    return { label: "Other environment or host", icon: "Target", tone: "muted", fix: "open" };
  }
  if (reason === "expired; needs recheck") {
    const expiresAt = ctx.entry?.expiresAt;
    const age = expiresAt ? ` ${relativeAge(expiresAt, ctx.now ?? Date.now())}` : "";
    return { label: `${STATE_LOOK.expired.word}${age}`, icon: STATE_LOOK.expired.icon, tone: "warning", fix: "observe" };
  }
  if (reason === "source unavailable; needs recheck") {
    return { label: "Source unavailable", icon: "EyeOff", tone: "warning", fix: "observe" };
  }
  if (reason === "different topic") return { label: "Other topic", icon: "Filter", tone: "muted", fix: "open" };
  if (reason === "outside this workstream") return { label: "Other workstream", icon: "Layers", tone: "muted", fix: "open" };
  if (reason === "left out of this thread") return { label: "Left out of this thread", icon: "EyeOff", tone: "muted", fix: "open" };
  if (reason === "thread-only change needs review after canonical revision changed") {
    return { label: "Thread-only text needs review", icon: "GitBranch", tone: "warning", fix: "review" };
  }
  if (Object.hasOwn(STATE_LOOK, reason)) {
    const state = reason as DisplayState;
    const look = STATE_LOOK[state];
    return {
      label: look.word,
      icon: state === "disputed" ? "DiffConflict" : look.icon,
      tone: look.tone,
      fix: state === "candidate" || state === "disputed" || state === "approved" ? "review" : state === "recheck" || state === "expired" ? "observe" : "open",
    };
  }
  return { label: reason, icon: "CircleQuestion", tone: "muted" };
}

export function ReasonChip({ reason }: { reason: HeldReason }): JSX.Element {
  return (
    <span
      data-cortex
      className={cn(
        "inline-flex min-h-5 max-w-full items-center gap-1 rounded-sm border border-dashed border-border-seam px-1.5 text-[12px]",
        TONE_TEXT[reason.tone],
        reason.tone === "warning" && "border-warning/60",
      )}
    >
      <Icon name={reason.icon} className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{reason.label}</span>
    </span>
  );
}
