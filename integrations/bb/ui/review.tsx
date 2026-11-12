import { type KeyboardEvent, type RefObject, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { BRIEF_STATE_LOOK, plural, STATE_LOOK } from "./copy";
import { type RpcFailure, useKnowledgeEntries, useReviewQueue, useWorkstreamWrites, type Writes } from "./data";
import { DiffText, EditKnowledgeDialog, ObserveDialog, Side } from "./dialogs";
import { KnowledgeDetail } from "./knowledge";
import { isHistorical, KnowledgeDecisionFailure, knowledgeDecisionToast } from "./knowledge-decisions";
import { displayState, oldestFirst, waitAge, wordDiff } from "./model";
import { EmptyNote, FailureNotice, Hint, LoadingRows, TONE_TEXT } from "./parts";
import { CORTEX_PAGE_PATH } from "./thread-context";
import type { AdmissionHint, Knowledge, ReviewItem } from "./types";
import { isFlag, isNullableText, isText, usePlaceState } from "./place";
import "./review.css";

const HINT_WORD: Record<AdmissionHint["reason"], string> = {
  "same-subject": "Same subject",
  "same-text": "Same words",
  "shared-source": "Same source",
};

const RELATED_STEP = 3;

type Option = { id: string; label: string; effect: string; run: () => Promise<Knowledge | void>; opens?: "observe" };

function optionsFor(item: ReviewItem, others: Knowledge[], writes: Writes, now: number): Option[] {
  const { entry, workstream } = item;
  const state = displayState(entry, now);
  const reason = (text: string) => `${text} in Cortex review`;
  const options: Option[] = [];
  const livePartners = others.filter(other => !isHistorical(other));
  const conflictsKnown = entry.conflicts.every(id => others.some(other => other.id === id));
  const liveConflicts = livePartners.filter(other => entry.conflicts.includes(other.id));
  if (entry.state === "candidate") {
    if (conflictsKnown && liveConflicts.length === 0) options.push({
      id: "approve",
      label: "Approve",
      effect: `Threads in ${workstream.name} get it from their next session.`,
      run: async () => {
        await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "approved", reason: reason("Approved") });
      },
    });
    for (const other of livePartners.filter(o => o.state === "approved" || o.state === "recheck" || entry.conflicts.includes(o.id))) {
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
            return (await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "rejected", reason: reason(`Merged as evidence into ${other.id}`) })).entry;
          },
        });
      }
    }
    options.push({
      id: "reject",
      label: "Reject",
      effect: "Kept in history. Threads never get it.",
      run: async () => {
        return (await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "rejected", reason: reason("Rejected") })).entry;
      },
    });
  } else if (entry.state === "disputed") {
    if (conflictsKnown && liveConflicts.length === 0) options.push({
      id: "approve",
      label: "Approve this",
      effect: `${others.filter(other => entry.conflicts.includes(other.id)).map(other => `${other.title} is ${other.state}`).join("; ") || "No live conflict remains"}, so nothing disputes this any more. Threads get it from their next session.`,
      run: async () => {
        await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "approved", reason: reason("Approved after historical conflicts") });
      },
    });
    for (const other of livePartners) {
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
        return (await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "archived", reason: reason("Archived") })).entry;
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
        return (await writes.transition({ id: entry.id, expectedRevision: entry.revision, state: "archived", reason: reason("Archived") })).entry;
      },
    });
  }
  return options;
}

function itemReason(entry: Knowledge, now: number): string {
  const state = displayState(entry, now);
  if (state === "candidate") return entry.kind === "directive" ? "New rule" : "New finding";
  if (state === "disputed") return "Disputed";
  if (state === "expired") return "Expired";
  return STATE_LOOK[state].word;
}

function QueueRow({ item, selected, onSelect, now }: { item: ReviewItem; selected: boolean; onSelect: () => void; now: number }) {
  const look = BRIEF_STATE_LOOK[displayState(item.entry, now)];
  return (
    <li className="border-b border-border-seam">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          "flex w-full min-w-0 items-start gap-2.5 border-l-2 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
          selected ? "border-primary bg-surface-selected hover:bg-surface-selected/80" : "border-transparent hover:bg-state-hover",
        )}
      >
        <Icon name={look.icon} className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[look.tone])} aria-label={look.word} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[13px] font-semibold text-foreground" title={item.entry.title}>{item.entry.title}</span>
          <span className="mt-1 block text-[12px] text-muted-foreground">
            {itemReason(item.entry, now)} · {item.workstream.name}
          </span>
          {item.hints.length > 0 ? <span className="block text-[11.5px] text-muted-foreground">{plural(item.hints.length, "similar entry", "similar entries")}</span> : null}
        </span>
        <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">{waitAge(item.entry.updatedAt, now)}</span>
      </button>
    </li>
  );
}

type DecisionKeys = { choose: (index: number) => void; confirm: () => void };

function optionIcon(option: Option): string {
  if (option.id === "approve") return "Check";
  if (option.id === "reject") return "X";
  if (option.id === "archive") return "Archive";
  if (option.opens === "observe") return "Eye";
  return option.id.startsWith("merge-") ? "Link" : "GitBranch";
}

function Decision({ item, onDone, onOpen, now, keysRef }: {
  item: ReviewItem;
  onDone: () => void;
  onOpen: (id: string) => void;
  now: number;
  keysRef: RefObject<DecisionKeys | null>;
}) {
  const writes = useWorkstreamWrites();
  const relatedIds = useMemo(
    () => [...new Set([...item.entry.conflicts, ...item.hints.map(hint => hint.id)])].filter(id => id !== item.entry.id),
    [item],
  );
  const [loadCount, setLoadCount] = useState(RELATED_STEP);
  const loadedIds = [...new Set([...item.entry.conflicts, ...relatedIds.filter(id => !item.entry.conflicts.includes(id)).slice(0, loadCount)])];
  const reads = useKnowledgeEntries(loadedIds);
  const relatedEntries = reads.flatMap(read => (read.data ? [read.data.entry] : []));
  const unreadable = loadedIds.flatMap((id, index) => (reads[index]?.error ? [{ id, failure: reads[index]!.error! }] : []));
  const loadingRelated = reads.some(read => read.isLoading);
  const options = loadingRelated ? [] : optionsFor(item, relatedEntries, writes, now);
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  const [dialog, setDialog] = useState<"observe" | "edit" | null>(null);
  const chosen = options.find(option => option.id === choice) ?? null;
  const confirm = async () => {
    if (!chosen || running.current) return;
    if (chosen.opens === "observe") {
      setDialog("observe");
      return;
    }
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const updated = await chosen.run();
      knowledgeDecisionToast(`${chosen.label}: done`, item.entry, updated || undefined, writes);
      onDone();
    } catch (cause) {
      setFailure(cause as RpcFailure);
      setChoice(null);
      writes.refreshKnowledge();
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  useImperativeHandle(keysRef, () => ({
    choose: index => {
      if (!busy && options[index]) setChoice(options[index]!.id);
    },
    confirm: () => { void confirm(); },
  }));
  return (
    <div className="flex min-w-0 flex-col gap-4" data-part="DecisionPane">
      <KnowledgeDetail
        entry={item.entry}
        workstream={item.workstream}
        onOpen={onOpen}
        facts={<span className="text-[12px] text-muted-foreground">waiting {waitAge(item.entry.updatedAt, now)}</span>}
      >
        {relatedEntries.length > 0 ? (
          <section aria-label="Compare" className="flex flex-col gap-2">
            <h3 className="text-[13px] font-semibold">Similar</h3>
            {relatedEntries.map(other => {
              const hint = item.hints.find(h => h.id === other.id);
              return (
                <div key={other.id} className="cortex-compare" data-part="Compare">
                  <Side entry={other} label={isHistorical(other) ? `${STATE_LOOK[other.state].word}, ${item.entry.conflicts.includes(other.id) ? "disputed this" : hint ? HINT_WORD[hint.reason].toLowerCase() : "related entry"}` : hint ? HINT_WORD[hint.reason] : "Disputes this"} />
                  <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border-seam p-3">
                    <span className="text-[12px] font-semibold text-foreground">Wording change</span>
                    <DiffText ops={wordDiff(other.text, item.entry.text)} label={`Words changed from ${other.title}`} />
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}
        {relatedIds.length > 0 ? (
          <div className="flex flex-col items-start gap-2">
            {loadingRelated ? <LoadingRows rows={1} label="Loading the entries to compare" /> : null}
            {unreadable.map(row => (
              <p key={row.id} role="alert" className="text-[12px] text-destructive-text">
                <span title={row.id}>Related entry</span> could not be read: {row.failure.message}. Options that need it are hidden.
              </p>
            ))}
            {relatedIds.length > loadedIds.length ? (
              <Button variant="ghost" size="sm" className="cortex-filter h-auto px-2 text-[12px]" onClick={() => setLoadCount(loadCount + RELATED_STEP)}>
                Compare {Math.min(RELATED_STEP, relatedIds.length - loadedIds.length)} more of {relatedIds.length - loadedIds.length} not loaded
              </Button>
            ) : null}
            <Hint text="Similar means same subject, words or source. Cortex never merges by itself.">
              <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground"><Icon name="Info" className="size-3.5" aria-hidden />About similar entries</span>
            </Hint>
          </div>
        ) : null}
      </KnowledgeDetail>
      <section aria-label="Decision" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 text-[13px] font-semibold">Your call</h3>
          {options.length > 0 ? <span className="text-[11.5px] text-muted-foreground">1–{Math.min(9, options.length)} choose</span> : null}
        </div>
        <div role="radiogroup" aria-label="Your call" className="flex min-w-0 flex-col gap-1.5">
          {options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={option.id === choice}
              disabled={busy}
              onClick={() => setChoice(option.id)}
              onKeyDown={event => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  setChoice(option.id);
                }
              }}
              className={cn(
                "cortex-choice flex min-w-0 items-start gap-2.5 rounded-md border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
                option.id === choice ? "border-primary bg-surface-selected enabled:hover:bg-surface-selected/80" : "border-border-seam hover:bg-state-hover",
              )}
            >
              {index < 9 ? <kbd aria-hidden className="shrink-0 rounded-sm border border-border-seam px-1 font-mono text-[11px] text-muted-foreground">{index + 1}</kbd> : null}
              <Icon name={optionIcon(option)} className={cn("mt-0.5 size-4 shrink-0", option.id === "reject" ? "text-destructive-text" : option.id === choice ? "text-primary" : "text-muted-foreground")} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-foreground">{option.label}</span>
                <span className="mt-0.5 block text-[12px] text-muted-foreground">{option.effect}</span>
              </span>
            </button>
          ))}
        </div>
        {failure ? <KnowledgeDecisionFailure failure={failure} /> : null}
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
          <Button className="cortex-choice h-auto min-h-8 bg-primary px-3 py-2 text-primary-foreground hover:bg-primary/90" aria-label={chosen ? `Confirm: ${chosen.label}` : loadingRelated ? "Loading options" : "Choose an option"} disabled={chosen === null || busy} onClick={() => void confirm()}>
            {chosen ? `Confirm: ${chosen.label}` : loadingRelated ? "Loading options" : "Choose an option"}
            <kbd aria-hidden className="rounded-sm border border-current px-1 text-[11px]">↵</kbd>
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog("edit")}><Icon name="Edit" aria-hidden />Edit first</Button>
        </div>
      </section>
      <EditKnowledgeDialog entry={item.entry} workstream={item.workstream} open={dialog === "edit"} onOpenChange={open => { if (!open) setDialog(null); }} />
      <ObserveDialog entry={item.entry} mode="observe" open={dialog === "observe"} onOpenChange={open => { if (!open) setDialog(null); }} />
    </div>
  );
}

export function NeedsYou() {
  const read = useReviewQueue();
  const navigate = useBbNavigate();
  const now = Date.now();
  const [filter, setFilter] = usePlaceState("workstream-filter", "all", isText);
  const [selectedId, setSelectedId] = usePlaceState<string | null>("selected-entry", null, isNullableText);
  const [showDetail, setShowDetail] = usePlaceState("show-detail", false, isFlag);
  const keysRef = useRef<DecisionKeys | null>(null);
  const items = useMemo(() => oldestFirst(read.data?.items ?? []), [read.data]);
  const workstreams = useMemo(() => [...new Map(items.map(item => [item.workstream.id, item.workstream])).values()], [items]);
  const visible = filter === "all" ? items : items.filter(item => item.workstream.id === filter);
  const selected = visible.find(item => item.entry.id === selectedId) ?? visible[0] ?? null;
  const open = (id: string) => {
    if (visible.some(item => item.entry.id === id)) {
      setSelectedId(id);
      setShowDetail(true);
    } else if (selected) {
      navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `workstreams/${selected.workstream.id}/${id}` });
    }
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing ||
      target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=combobox], [role=dialog], [role=alertdialog], [role=menu]")) return;
    if ((event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") && visible.length > 0) {
      event.preventDefault();
      const index = Math.max(0, visible.findIndex(item => item.entry.id === selected?.entry.id));
      const delta = event.key.toLowerCase() === "j" ? 1 : -1;
      setSelectedId(visible[Math.min(visible.length - 1, Math.max(0, index + delta))]!.entry.id);
    } else if (/^[1-9]$/.test(event.key)) {
      event.preventDefault();
      keysRef.current?.choose(Number(event.key) - 1);
    } else if (event.key === "Enter" && !target.closest("button, a, summary")) {
      event.preventDefault();
      keysRef.current?.confirm();
    }
  };
  if (read.error && read.data === undefined) return <div className="p-4"><FailureNotice failure={read.error} onRetry={read.refetch} /></div>;
  if (read.data === undefined) return <div className="p-4"><LoadingRows label="Loading what needs you" /></div>;
  const oldest = visible[0];
  return (
    <div data-cortex data-part="ReviewQueue" role="region" aria-label="Review queue" tabIndex={0} className="cortex-review flex h-full min-h-0 flex-col focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onKeyDown={keys}>
      {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
      <div className="cortex-master-detail" data-show-detail={showDetail || undefined}>
        <div data-cortex-scroll="list" className="cortex-master border-r border-border-seam">
          <header className="flex items-center gap-3 border-b border-border-seam px-4 py-3">
            <span className="text-[24px] leading-none font-semibold text-foreground tabular-nums">{filter === "all" ? read.data.total : visible.length}</span>
            <div className="min-w-0 flex-1"><h2 className="text-[13px] font-semibold">to review</h2>{oldest ? <p className="text-[12px] text-muted-foreground">oldest {waitAge(oldest.entry.updatedAt, now)}</p> : null}</div>
            <span title="J and K move through the queue" className="flex gap-1 text-[11px] text-muted-foreground"><kbd className="border border-border-seam px-1">J</kbd><kbd className="border border-border-seam px-1">K</kbd></span>
          </header>
          {workstreams.length > 1 ? <div role="group" aria-label="Workstream" className="flex flex-wrap gap-1.5 border-b border-border-seam p-3">
            {[{ id: "all", name: "All" }, ...workstreams].map(ws => <Button key={ws.id} variant="outline" size="sm" aria-pressed={filter === ws.id} className={cn("cortex-filter h-auto min-h-7 px-2 py-1 text-[12px]", filter === ws.id && "border-surface-selected-border bg-surface-selected")} onClick={() => { setFilter(ws.id); setSelectedId(null); setShowDetail(false); }}>{ws.name}</Button>)}
          </div> : null}
          {visible.length === 0 ? <div className="p-4"><EmptyNote icon="CircleCheck">Nothing waits for your review.</EmptyNote></div> : <>
            <p className="border-b border-border-seam px-4 py-2 text-[11.5px] text-muted-foreground">Oldest first</p>
            <ul aria-label="Waiting for your review">
              {visible.map(item => <QueueRow key={item.entry.id} item={item} now={now} selected={item.entry.id === selected?.entry.id} onSelect={() => { setSelectedId(item.entry.id); setShowDetail(true); }} />)}
            </ul>
          </>}
          {read.data.total > items.length ? <p className="px-4 py-3 text-[12px] text-muted-foreground">{plural(read.data.total - items.length, "older item")} after these</p> : null}
        </div>
        {selected ? <div data-cortex-scroll="detail" className="cortex-detail">
          <Button variant="ghost" size="sm" className="cortex-back mb-3" onClick={() => setShowDetail(false)}><Icon name="ChevronLeft" aria-hidden />Queue</Button>
          <Decision key={selected.entry.id} item={selected} now={now} keysRef={keysRef} onOpen={open} onDone={() => { setSelectedId(null); }} />
        </div> : null}
      </div>
    </div>
  );
}
