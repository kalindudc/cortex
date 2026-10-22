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
}: {
  status: CortexStatus;
  canWrite: boolean;
  onChoose: (status: CortexStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!canWrite) {
    return (
      <span className={pillClass(status)} data-testid="status-pill">
        <StatusDot status={status} />
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
        <button type="button" className={pillClass(status)} aria-label={`Status: ${STATUS_LABEL[status]}. Change status`}>
          <StatusDot status={status} />
          {STATUS_LABEL[status]}
          <Icon name="ChevronDown" className="size-3.5 opacity-80" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        mobileTitle="Status"
        className="w-64"
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
        <p className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-subtle-foreground">
          Recorded as you, like a change in the cortex desktop app. Nobody is notified.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One click to cortex's next status: draft→open, open→review, review→done, blocked→open, done→open. */
export function NextStepButton({ status, onChoose }: { status: CortexStatus; onChoose: (status: CortexStatus) => void }) {
  return (
    <Button variant="outline" size="sm" className="h-[26px] gap-1.5 px-2.5" onClick={() => onChoose(NEXT_STATUS[status])}>
      {NEXT_LABEL[status]}
      <Icon name="ArrowRight" className="size-3.5" aria-hidden />
    </Button>
  );
}
