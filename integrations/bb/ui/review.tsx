import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { facetWord, plural, STATE_LOOK } from "./copy";
import { type RpcFailure, useKnowledgeEntries, useReviewQueue, useWorkstreamWrites, type Writes } from "./data";
import { ObserveDialog, Side } from "./dialogs";
import { KnowledgeDetail } from "./knowledge";
import { displayState, oldestFirst, waitAge, wordDiff } from "./model";
import { EmptyNote, FailureNotice, LoadingRows, Segmented, StateMark, TONE_TEXT } from "./parts";
import type { AdmissionHint, Knowledge, ReviewItem } from "./types";
import { DiffText } from "./dialogs";

const HINT_WORD: Record<AdmissionHint["reason"], string> = {
  "same-subject": "Same subject",
  "same-text": "Same words",
  "shared-source": "Same source",
};

const RELATED_STEP = 3;

type Option = { id: string; label: string; effect: string; run: () => Promise<void>; opens?: "observe" };

function optionsFor(item: ReviewItem, others: Knowledge[], writes: Writes, now: number): Option[] {
  const { entry, workstream } = item;
  const state = displayState(entry, now);
  const reason = (text: string) => `${text} in Cortex review`;
  const options: Option[] = [];
  if (entry.state === "candidate") {
    options.push({
      id: "approve",
      label: "Approve",
      effect: `Threads in ${workstream.name} get it from their next session.`,
      run: async () => {
        await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "approved", reason: reason("Approved") });
      },
    });
    for (const other of others.filter(o => o.state === "approved" || o.state === "recheck")) {
      options.push({
        id: `replace-${other.id}`,
        label: `Approve and replace ${other.title}`,
        effect: "The older entry moves to history with its sources.",
        run: async () => {
          await writes.supersede({ id: entry.id, expectedRevision: entry.revision, otherId: other.id, otherExpectedRevision: other.revision, reason: reason("Replaced") });
        },
      });
      if (entry.sources.length > 0) {
        options.push({
          id: `merge-${other.id}`,
          label: `Keep ${other.title}, add these sources to it`,
          effect: "One entry stays. The new wording is rejected; its sources are kept as evidence.",
          run: async () => {
            await writes.evidence({ id: other.id, expectedRevision: other.revision, sources: entry.sources, reason: reason(`Evidence from ${entry.id}`) });
            await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "rejected", reason: reason(`Merged as evidence into ${other.id}`) });
          },
        });
      }
    }
    options.push({
      id: "reject",
      label: "Reject",
      effect: "Kept in history. Threads never get it.",
      run: async () => {
        await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "rejected", reason: reason("Rejected") });
      },
    });
  } else if (entry.state === "disputed") {
    for (const other of others) {
      options.push({
        id: `keep-${entry.id}-${other.id}`,
        label: `Keep this, replace ${other.title}`,
        effect: "This one goes back into thread context; the other moves to history.",
        run: async () => {
          await writes.supersede({ id: entry.id, expectedRevision: entry.revision, otherId: other.id, otherExpectedRevision: other.revision, reason: reason("Dispute resolved") });
        },
      });
      options.push({
        id: `keep-${other.id}-${entry.id}`,
        label: `Keep ${other.title}, replace this`,
        effect: "The other one goes back into thread context; this moves to history.",
        run: async () => {
          await writes.supersede({ id: other.id, expectedRevision: other.revision, otherId: entry.id, otherExpectedRevision: entry.revision, reason: reason("Dispute resolved") });
        },
      });
    }
    options.push({
      id: "archive",
      label: "Archive this",
      effect: "Out of every thread's next context; kept for history.",
      run: async () => {
        await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "archived", reason: reason("Archived") });
      },
    });
  } else if (state === "expired" || entry.state === "recheck") {
    options.push({
      id: "observe",
      label: "Record what you see now…",
      effect: "Saved as a new observation for review. This one stays held back.",
      run: async () => {},
      opens: "observe",
    });
    options.push({
      id: "archive",
      label: "Archive this",
      effect: "Out of every thread's next context; kept for history.",
      run: async () => {
        await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "archived", reason: reason("Archived") });
      },
    });
  }
  return options;
}

function itemReason(entry: Knowledge, now: number): string {
  const state = displayState(entry, now);
  if (state === "candidate") return entry.kind === "directive" ? "New directive" : "New finding";
  if (state === "disputed") return "Disputed";
  if (state === "expired") return "Expired";
  return STATE_LOOK[state].word;
}

function QueueRow({ item, selected, onSelect, now }: { item: ReviewItem; selected: boolean; onSelect: () => void; now: number }) {
  const state = displayState(item.entry, now);
  const look = STATE_LOOK[state];
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          "flex w-full items-start gap-2.5 border-l-2 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
          selected ? "border-primary bg-surface-selected" : "border-attention hover:bg-state-hover",
        )}
      >
        <Icon name={look.icon} className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[look.tone])} aria-label={look.word} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[12.5px] font-semibold text-foreground">{item.entry.title}</span>
          <span className="mt-0.5 line-clamp-2 text-[11.5px] text-muted-foreground">
            {itemReason(item.entry, now)} · {item.workstream.name} · {facetWord(item.entry.facet)}
            {item.hints.length > 0 ? ` · ${plural(item.hints.length, "similar entry", "similar entries")}` : ""}
          </span>
        </span>
        <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">{waitAge(item.entry.updatedAt, now)}</span>
      </button>
    </li>
  );
}

function Decision({ item, onDone, now }: { item: ReviewItem; onDone: () => void; now: number }) {
  const writes = useWorkstreamWrites();
  const relatedIds = useMemo(
    () => [...new Set([...item.entry.conflicts, ...item.hints.map(hint => hint.id)])].filter(id => id !== item.entry.id),
    [item],
  );
  const [loadCount, setLoadCount] = useState(RELATED_STEP);
  const loadedIds = relatedIds.slice(0, loadCount);
  const reads = useKnowledgeEntries(loadedIds);
  const relatedEntries = reads.flatMap(read => (read.data ? [read.data.entry] : []));
  const unreadable = loadedIds.flatMap((id, index) => (reads[index]?.error ? [{ id, failure: reads[index]!.error! }] : []));
  const loadingRelated = reads.some(read => read.isLoading);
  const options = loadingRelated ? [] : optionsFor(item, relatedEntries, writes, now);
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  const [observing, setObserving] = useState(false);
  const chosen = options.find(option => option.id === choice) ?? null;
  useEffect(() => {
    setChoice(null);
    setFailure(null);
    setLoadCount(RELATED_STEP);
  }, [item.entry.id]);
  const confirm = async () => {
    if (!chosen) return;
    if (chosen.opens === "observe") {
      setObserving(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await chosen.run();
      toast(`${chosen.label}: done`);
      onDone();
    } catch (cause) {
      setFailure(cause as RpcFailure);
    } finally {
      setBusy(false);
    }
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < Math.min(9, options.length)) {
      event.preventDefault();
      setChoice(options[index]!.id);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={keys}>
      <div className="min-h-36 flex-1 overflow-y-auto px-4 py-4 md:px-5">
        <KnowledgeDetail entry={item.entry} workstream={item.workstream}>
          {relatedEntries.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">Compare</p>
              {relatedEntries.map(other => {
                const hint = item.hints.find(h => h.id === other.id);
                return (
                  <div key={other.id} className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                    <Side entry={other} label={hint ? HINT_WORD[hint.reason] : "Disputes this"} />
                    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border-seam p-3">
                      <span className="text-[11.5px] font-semibold text-foreground">Wording change</span>
                      <DiffText ops={wordDiff(other.text, item.entry.text)} label={`Words changed from ${other.title}`} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          {relatedIds.length > 0 ? (
            <div className="flex flex-col items-start gap-1">
              {loadingRelated ? <LoadingRows rows={1} label="Loading the entries to compare" /> : null}
              {unreadable.map(row => (
                <p key={row.id} role="alert" className="text-[12px] text-destructive-text">
                  <span className="font-mono">{row.id}</span> could not be read: {row.failure.message}. Options that need it are hidden.
                </p>
              ))}
              {relatedIds.length > loadedIds.length ? (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={() => setLoadCount(loadCount + RELATED_STEP)}>
                  Compare {Math.min(RELATED_STEP, relatedIds.length - loadedIds.length)} more of {relatedIds.length - loadedIds.length} not loaded
                </Button>
              ) : null}
              <p className="text-[11.5px] text-muted-foreground">Similar means same subject, words or source. Cortex never merges by itself.</p>
            </div>
          ) : null}
        </KnowledgeDetail>
      </div>
      <div className="flex max-h-[55%] min-h-0 shrink-0 flex-col border-t border-border-seam bg-background px-4 pt-3 pb-3 md:px-5">
        <div role="radiogroup" aria-label="Your call" className="-mx-1 flex min-h-0 flex-col gap-1.5 overflow-y-auto px-1 py-0.5">
          {options.map((option, index) => (
            <button
              key={option.id}
              ref={node => {
                if (node && option.id === choice) node.scrollIntoView?.({ block: "nearest" });
              }}
              type="button"
              role="radio"
              aria-checked={option.id === choice}
              onClick={() => setChoice(option.id)}
              className={cn(
                "flex items-start gap-2.5 rounded-md border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                option.id === choice ? "border-primary bg-surface-selected" : "border-border-seam hover:bg-state-hover",
              )}
            >
              <Icon name={option.id === choice ? "CircleCheck" : "Circle"} className={cn("mt-0.5 size-4 shrink-0", option.id === choice ? "text-primary" : "text-muted-foreground")} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-semibold text-foreground">{option.label}</span>
                <span className="block text-[11.5px] text-muted-foreground">{option.effect}</span>
              </span>
              {index < 9 ? <kbd className="shrink-0 rounded-sm border border-border-seam px-1 font-mono text-[11px] text-muted-foreground">{index + 1}</kbd> : null}
            </button>
          ))}
        </div>
        {failure ? (
          <div className="mt-2 shrink-0">
            <FailureNotice failure={failure} />
          </div>
        ) : null}
        <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Button disabled={chosen === null || busy} onClick={() => void confirm()}>
            {chosen ? `Confirm: ${chosen.label}` : loadingRelated ? "Loading options" : "Choose an option"}
          </Button>
          {options.length > 0 ? <span className="text-[11.5px] text-muted-foreground">J and K move · 1 to {Math.min(9, options.length)} choose</span> : null}
        </div>
      </div>
      <ObserveDialog entry={item.entry} mode="observe" open={observing} onOpenChange={open => setObserving(open)} />
    </div>
  );
}

/** Needs you: entries waiting for a person's decision, oldest first, each with its evidence and named options. */
export function NeedsYou() {
  const read = useReviewQueue();
  const now = Date.now();
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const items = useMemo(() => oldestFirst(read.data?.items ?? []), [read.data]);
  const workstreams = useMemo(() => [...new Map(items.map(item => [item.workstream.id, item.workstream])).values()], [items]);
  const visible = filter === "all" ? items : items.filter(item => item.workstream.id === filter);
  const selected = visible.find(item => item.entry.id === selectedId) ?? visible[0] ?? null;
  if (read.error) return <div className="p-4 md:p-5"><FailureNotice failure={read.error} onRetry={read.refetch} /></div>;
  if (read.data === undefined) return <div className="p-4 md:p-5"><LoadingRows label="Loading what needs you" /></div>;
  const move = (delta: number) => {
    if (visible.length === 0) return;
    const index = Math.max(0, visible.findIndex(item => item.entry.id === selected?.entry.id));
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + delta))]!;
    setSelectedId(next.entry.id);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [role=dialog], [role=menu]")) return;
    if (event.key === "j" || event.key === "k") {
      event.preventDefault();
      move(event.key === "j" ? 1 : -1);
    }
  };
  const oldest = items[0];
  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={keys}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-seam px-4 py-3 md:px-5">
        <span className="text-[28px] leading-none font-semibold text-foreground tabular-nums">{read.data.total}</span>
        <span className="text-[14px] font-semibold text-foreground">need you</span>
        {oldest ? <span className="text-[12px] text-muted-foreground">oldest {waitAge(oldest.entry.updatedAt, now)}</span> : null}
        <span className="flex-1" />
        {workstreams.length > 1 ? (
          <Segmented
            label="Workstream"
            value={filter}
            options={[{ value: "all", label: "All" }, ...workstreams.map(ws => ({ value: ws.id, label: ws.name }))]}
            onChange={setFilter}
          />
        ) : null}
      </div>
      {visible.length === 0 ? (
        <div className="p-4 md:p-5">
          <EmptyNote icon="CircleCheck">Nothing waits for your review.</EmptyNote>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul
            ref={listRef}
            aria-label="Waiting for your review"
            className={cn("min-h-0 w-full overflow-y-auto border-r border-border-seam lg:w-[22rem] lg:shrink-0", showDetail && "hidden lg:block")}
          >
            {visible.map(item => (
              <QueueRow
                key={item.entry.id}
                item={item}
                now={now}
                selected={item.entry.id === selected?.entry.id}
                onSelect={() => {
                  setSelectedId(item.entry.id);
                  setShowDetail(true);
                }}
              />
            ))}
            {read.data.total > items.length ? (
              <li className="px-3 py-2 text-[11.5px] text-muted-foreground">{plural(read.data.total - items.length, "older item")} after these</li>
            ) : null}
          </ul>
          {selected ? (
            <div className={cn("min-w-0 flex-1 flex-col", showDetail ? "flex" : "hidden lg:flex")}>
              <div className="flex items-center gap-2 border-b border-border-seam px-3 py-1.5 lg:hidden">
                <Button variant="ghost" size="sm" onClick={() => setShowDetail(false)}>
                  <Icon name="ChevronLeft" className="size-4" aria-hidden />
                  Queue
                </Button>
                <StateMark state={displayState(selected.entry, now)} />
              </div>
              <Decision item={selected} now={now} onDone={() => setSelectedId(null)} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
