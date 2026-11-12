import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { type CortexStatus, STATUSES } from "../detail";

// Copies of cortex's src/lib/constants.ts STATUS_LABEL and nextStatusFor, and
// the status keys this panel offers: the plugin imports no cortex source.
export const STATUS_LABEL: Record<CortexStatus, string> = {
  draft: "Draft",
  open: "Open",
  review: "In review",
  blocked: "Blocked",
  done: "Done",
};
export const NEXT_STATUS: Record<CortexStatus, CortexStatus> = {
  draft: "open",
  open: "review",
  review: "done",
  blocked: "open",
  done: "open",
};
export const NEXT_LABEL: Record<CortexStatus, string> = {
  draft: "Open it",
  open: "Ready for review",
  review: "Mark done",
  blocked: "Unblock",
  done: "Reopen",
};
export const STATUS_KEY: Record<CortexStatus, string> = { draft: "d", open: "o", review: "r", blocked: "b", done: "x" };
const BY_KEY = new Map(STATUSES.map(status => [STATUS_KEY[status], status]));

// Status colours: draft muted, open info, review warning, blocked
// destructive, done success; host tokens only.
const DOT: Record<CortexStatus, string> = {
  draft: "bg-muted-foreground",
  open: "bg-file-accent",
  review: "bg-warning",
  blocked: "bg-destructive",
  done: "bg-success",
};
export const STATUS_TEXT: Record<CortexStatus, string> = {
  draft: "text-foreground",
  open: "text-file-accent",
  review: "text-warning-text",
  blocked: "text-destructive-text",
  done: "text-success",
};
const PILL: Record<CortexStatus, string> = {
  draft: "border-muted-foreground/45 bg-muted-foreground/15",
  open: "border-file-accent/45 bg-file-accent/15",
  review: "border-warning/45 bg-warning/15",
  blocked: "border-destructive/45 bg-destructive/15",
  done: "border-success/45 bg-success/15",
};

export function StatusDot({ status, className }: { status: CortexStatus; className?: string }) {
  return (
    <span aria-hidden data-status={status} className={cn("inline-block size-2 shrink-0 rounded-full", DOT[status], className)} />
  );
}

const pillClass = (status: CortexStatus) =>
  cn(
    "inline-flex h-[26px] items-center gap-1.5 rounded-full border pr-2 pl-2.5 text-xs font-semibold",
    PILL[status],
    STATUS_TEXT[status],
  );

/** The status pill: a menu of every status with its key; a plain label when writes are off. */
export function StatusPill({
  status,
  canWrite,
  onChoose,
  track = false,
}: {
  status: CortexStatus;
  canWrite: boolean;
  onChoose: (status: CortexStatus) => void;
  track?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const className = track
    ? "inline-flex min-h-7 flex-1 items-center justify-center gap-1 border border-primary bg-primary px-2 text-xs font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    : pillClass(status);
  if (!canWrite) {
    return (
      <span className={className} data-testid="status-pill" aria-current={track ? "step" : undefined}>
        {track ? null : <StatusDot status={status} />}
        {STATUS_LABEL[status]}
      </span>
    );
  }
  const choose = (next: CortexStatus) => {
    setOpen(false);
    onChoose(next);
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(className, track ? "hover:bg-primary/90" : "hover:bg-state-hover")} aria-current={track ? "step" : undefined} aria-label={`Status: ${STATUS_LABEL[status]}. Change status`}>
          {track ? null : <StatusDot status={status} />}
          {STATUS_LABEL[status]}
          <Icon name="ChevronDown" className="size-3.5 opacity-80" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-cortex
        align="start"
        mobileTitle="Status"
        className="w-64 pointer-coarse:[&_[role=menuitem]]:min-h-11 max-[480px]:[&_[role=menuitem]]:min-h-11"
        onKeyDown={event => {
          const picked = BY_KEY.get(event.key);
          if (picked === undefined || event.metaKey || event.ctrlKey || event.altKey) return;
          event.preventDefault();
          choose(picked);
        }}
      >
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        {STATUSES.map(option => (
          <DropdownMenuItem key={option} onSelect={() => choose(option)} aria-checked={option === status}>
            <StatusDot status={option} />
            <span className="flex-1">{STATUS_LABEL[option]}</span>
            {option === status ? <Icon name="Check" className="size-3.5 text-primary" aria-label="current" /> : null}
            <DropdownMenuShortcut className="font-mono tracking-normal">{STATUS_KEY[option]}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-muted-foreground">
          Recorded as you, like a change in the cortex desktop app. Nobody is notified.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TRACK = ["draft", "open", "review", "done"] as const;

export function StatusTrack({ status, canWrite, onChoose }: {
  status: CortexStatus;
  canWrite: boolean;
  onChoose: (status: CortexStatus) => void;
}) {
  const current = TRACK.findIndex(step => step === status);
  const blocked = status === "blocked";
  const blockClass = cn(
    "ml-1 inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center gap-1 border px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    blocked ? "border-destructive bg-surface-destructive text-destructive-text" : "border-border-seam text-muted-foreground hover:bg-state-hover",
  );
  return (
    <div role="group" aria-label="Task status" className="mt-3 flex min-w-0 flex-wrap gap-y-1">
      <div className="flex min-w-0 flex-1 basis-60">
        {TRACK.map((step, index) => {
          if (step === status) return <StatusPill key={step} status={status} canWrite={canWrite} onChoose={onChoose} track />;
          const className = cn(
            "inline-flex min-h-7 min-w-0 flex-1 items-center justify-center gap-1 border border-border-seam px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            index < current ? "bg-success/10 text-success" : "text-muted-foreground",
          );
          const content = <>{index < current ? <Icon name="Check" className="size-3 shrink-0" aria-hidden /> : null}{STATUS_LABEL[step]}</>;
          return canWrite
            ? <button key={step} type="button" className={cn(className, "hover:bg-state-hover")} onClick={() => onChoose(step)}>{content}</button>
            : <span key={step} className={className}>{content}</span>;
        })}
      </div>
      {canWrite ? (
        <button type="button" className={cn(blockClass, blocked && "hover:bg-state-hover")} aria-pressed={blocked} aria-label={blocked ? "Unblock task" : "Block task"} title={blocked ? "Unblock task" : "Blocked"} onClick={() => onChoose(blocked ? "open" : "blocked")}>
          <Icon name="AlertTriangle" className="size-3.5" aria-hidden />
          {blocked ? "Blocked" : null}
        </button>
      ) : blocked ? <span className={blockClass} data-testid="status-pill"><Icon name="AlertTriangle" className="size-3.5" aria-hidden />Blocked</span> : null}
    </div>
  );
}

/** One click to cortex's next status: draft→open, open→review, review→done, blocked→open, done→open. */
export function NextStepButton({ status, onChoose }: { status: CortexStatus; onChoose: (status: CortexStatus) => void }) {
  return (
    <Button size="sm" className="h-7 gap-1.5 bg-primary px-2.5 text-primary-foreground hover:bg-primary/90" onClick={() => onChoose(NEXT_STATUS[status])}>
      {NEXT_LABEL[status]}
      <Icon name="ArrowRight" className="size-3.5" aria-hidden />
    </Button>
  );
}
