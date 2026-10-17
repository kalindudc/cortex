import { type ReactNode, useState } from "react";
import { Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type CortexStatus, STATUSES } from "../detail";
import type { CortexAuthor, CortexTaskDetail, CortexUpdate } from "../state";
import { STATUS_LABEL, STATUS_TEXT, StatusDot } from "./status";
import { absoluteTime, groupByDay, relativeTime } from "./time";

export const ACTIVITY_PAGE = 50;

function authorOf(detail: CortexTaskDetail, tag: string): CortexAuthor {
  return detail.authors[tag] ?? { kind: "other", label: tag };
}

function Avatar({ tag, who }: { tag: string; who: CortexAuthor }) {
  if (who.kind === "thread") {
    return (
      <span className="grid size-6 place-items-center rounded-[7px] bg-primary/15 text-primary" aria-hidden>
        <Icon name="MessageSquare" className="size-3.5" />
      </span>
    );
  }
  const letter = who.kind === "pi" ? "\u03c0" : (tag.charAt(0) || "?").toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 place-items-center rounded-full text-[11px] font-bold",
        who.kind === "you" ? "bg-primary/20 text-primary" : "bg-secondary text-secondary-foreground",
      )}
    >
      {letter}
    </span>
  );
}

function Who({ who }: { who: CortexAuthor }) {
  const navigate = useBbNavigate();
  const threadId = who.threadId;
  if (who.kind === "thread" && threadId !== undefined) {
    return (
      <button
        type="button"
        title="Open this bb thread"
        className="font-semibold text-foreground hover:underline"
        onClick={() => navigate.toThread(threadId)}
      >
        {who.label}
      </button>
    );
  }
  return <span className="font-semibold text-foreground">{who.label}</span>;
}

function When({ at }: { at: number }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={absoluteTime(at)}
      className="ml-auto shrink-0 text-[11px] whitespace-nowrap text-subtle-foreground"
    >
      {relativeTime(at)}
    </time>
  );
}

function NoteRow({ detail, update }: { detail: CortexTaskDetail; update: CortexUpdate }) {
  const [open, setOpen] = useState(false);
  const who = authorOf(detail, update.author);
  return (
    <li className="grid grid-cols-[24px_1fr] gap-2.5 pb-3.5" data-testid="activity-note">
      <Avatar tag={update.author} who={who} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
          <Who who={who} />
          <When at={update.created} />
        </div>
        <p className="mt-0.5 text-[13px] leading-normal text-foreground">{update.summary}</p>
        {update.body ? (
          <div className="mt-1">
            <button type="button" className="text-[11.5px] text-primary hover:underline" onClick={() => setOpen(!open)}>
              {open ? "Hide details" : "Show details"}
            </button>
            {open ? (
              <div className="mt-1.5 rounded-md bg-surface-recessed px-2.5 py-2 text-xs leading-normal text-muted-foreground">
                <Markdown content={update.body} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** A status change or the created row: one compact line with the status dot. */
function CompactRow({ detail, update }: { detail: CortexTaskDetail; update: CortexUpdate }) {
  const who = authorOf(detail, update.author);
  const to = update.to;
  return (
    <li className="grid grid-cols-[24px_1fr] gap-2.5 pb-3.5" data-testid="activity-compact">
      <span className="grid size-6 place-items-center" aria-hidden>
        <StatusDot status={to ?? "open"} className="size-2.5 ring-[3px] ring-card" />
      </span>
      <div className="flex min-w-0 items-baseline gap-1.5 text-xs leading-6 text-muted-foreground">
        <Who who={who} />
        {update.kind === "created" || to === undefined ? (
          <span>created this task</span>
        ) : (
          <span>
            moved this to <b className={cn("font-semibold", STATUS_TEXT[to])}>{STATUS_LABEL[to]}</b>
          </span>
        )}
        <When at={update.created} />
      </div>
    </li>
  );
}

type Entry = { kind: "update"; update: CortexUpdate } | { kind: "sync"; at: number };

/**
 * Newest first and grouped by day, with a divider where the body was last
 * synced; the newest ACTIVITY_PAGE updates, then "Show older".
 */
export function ActivityTimeline({ detail }: { detail: CortexTaskDetail }) {
  const [shown, setShown] = useState(ACTIVITY_PAGE);
  const newestFirst = [...detail.updates].reverse();
  const page = newestFirst.slice(0, shown);
  const entries: Entry[] = page.map(update => ({ kind: "update", update }));
  const syncAt = detail.sync.syncedAt;
  const divider = page.findIndex(update => update.created <= syncAt);
  if (divider > 0) entries.splice(divider, 0, { kind: "sync", at: syncAt });
  if (newestFirst.length === 0) return <p className="text-sm text-muted-foreground">No updates yet.</p>;
  const groups = groupByDay(entries, entry => (entry.kind === "sync" ? entry.at : entry.update.created));
  const rows = (items: Entry[]): ReactNode[] =>
    items.map(entry =>
      entry.kind === "sync" ? (
        <li
          key="sync"
          role="separator"
          className="my-0.5 mb-3.5 ml-8 flex items-center gap-2 text-[11px] text-subtle-foreground before:flex-1 before:border-t before:border-dashed before:border-border after:flex-1 after:border-t after:border-dashed after:border-border"
        >
          Body last synced here · {relativeTime(entry.at)}
        </li>
      ) : entry.update.kind === "note" ? (
        <NoteRow key={entry.update.id} detail={detail} update={entry.update} />
      ) : (
        <CompactRow key={entry.update.id} detail={detail} update={entry.update} />
      ),
    );
  return (
    <div>
      {groups.map(group => (
        <section key={group.label} aria-label={group.label}>
          <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">{group.label}</h3>
          <ol>{rows(group.items)}</ol>
        </section>
      ))}
      {newestFirst.length > shown ? (
        <Button variant="ghost" size="sm" onClick={() => setShown(shown + ACTIVITY_PAGE)}>
          Show older ({newestFirst.length - shown})
        </Button>
      ) : null}
    </div>
  );
}

/** A note posted as the user, optionally changing the status in the same step. */
export function Composer({
  onPost,
}: {
  onPost: (input: { text: string; status: CortexStatus | null }) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<CortexStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = text.trim() === "" && status === null;
  const submit = async () => {
    if (pending || empty) return;
    setPending(true);
    setError(null);
    try {
      await onPost({ text, status });
      setText("");
      setStatus(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="shrink-0 border-t border-border bg-card px-3 py-2.5"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        disabled={pending}
        placeholder="Add a note…"
        aria-label="Note"
        className="min-h-[54px] resize-none text-[12.5px]"
      />
      {error === null ? null : (
        <p role="alert" className="mt-1.5 text-xs text-destructive-text">
          {error}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={pending} className="h-[26px] gap-1.5 px-2">
              {status === null ? null : <StatusDot status={status} />}
              {status === null ? "Keep status" : `Set ${STATUS_LABEL[status]}`}
              <Icon name="ChevronDown" className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" mobileTitle="Status for this note">
            <DropdownMenuItem onSelect={() => setStatus(null)}>Keep status</DropdownMenuItem>
            {STATUSES.map(option => (
              <DropdownMenuItem key={option} onSelect={() => setStatus(option)}>
                <StatusDot status={option} />
                Set {STATUS_LABEL[option]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="text-[11px] text-subtle-foreground">Posts as you · ⌘↵</span>
        <span className="flex-1" />
        <Button type="submit" size="sm" className="h-[26px] px-3" disabled={pending || empty}>
          {pending ? "Posting…" : "Post"}
        </Button>
      </div>
    </form>
  );
}
