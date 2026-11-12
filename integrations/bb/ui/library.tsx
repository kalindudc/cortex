import { useRef, useState } from "react";
import { experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { BRIEF_STATE_LOOK, facetWord, plural } from "./copy";
import { useBindings, useKnowledgeEntries, useKnowledgeSearch, useReviewQueue } from "./data";
import { KnowledgeActions, KnowledgeDetail } from "./knowledge";
import { displayState } from "./model";
import { EmptyNote, FailureNotice, Hint, LoadingRows, Segmented, TONE_TEXT } from "./parts";
import { CORTEX_PAGE_PATH } from "./thread-context";
import type { Knowledge, Workstream } from "./types";
import "./review.css";

function ResultRow({ entry, workstream, selected, onSelect }: { entry: Knowledge; workstream: Workstream; selected: boolean; onSelect: () => void }) {
  const look = BRIEF_STATE_LOOK[displayState(entry, Date.now())];
  return (
    <li className="border-b border-border-seam">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          "flex w-full min-w-0 items-start gap-2 border-l-2 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
          selected ? "border-primary bg-surface-selected" : "border-transparent hover:bg-state-hover",
        )}
      >
        <Icon name={look.icon} className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[look.tone])} aria-label={look.word} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[13px] font-semibold text-foreground" title={entry.title}>{entry.title}</span>
          <span className="mt-1 block text-[12px] text-muted-foreground">{workstream.name} · {facetWord(entry.facet)}</span>
        </span>
        <span className={cn("max-w-24 text-right text-[11.5px]", TONE_TEXT[look.tone])}>{look.word}</span>
      </button>
    </li>
  );
}

/** Search every workstream's saved knowledge, and see entries Cortex found similar to others. */
export function Library() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"search" | "similar">("search");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [workstreamFilter, setWorkstreamFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useBbNavigate();
  const sidebar = experimental_useSidebarThreads();
  const bindings = useBindings();
  const search = useKnowledgeSearch(view === "search" ? query : "");
  const queue = useReviewQueue();
  const similar = (queue.data?.items ?? []).filter(item => item.hints.length > 0);
  const items = view === "search" ? (search.data?.items ?? []) : similar;
  const visible = items.filter(item => (workstreamFilter === "all" || item.workstream.id === workstreamFilter) && (stateFilter === "all" || displayState(item.entry, Date.now()) === stateFilter));
  const selectedRow = visible.find(item => item.entry.id === selectedId) ?? (selectedId === null ? visible[0] : null) ?? null;
  const extra = useKnowledgeEntries(selectedId && !visible.some(item => item.entry.id === selectedId) ? [selectedId] : [])[0];
  const selected = selectedRow ?? (extra?.data ? { ...extra.data, hints: [] } : null);
  const workstreams = [...new Map(items.map(item => [item.workstream.id, item.workstream])).values()];
  const states = [...new Set(items.map(item => displayState(item.entry, Date.now())))];
  const read = view === "search" ? search : queue;
  const usedBy = sidebar.sections.filter(section => bindings.data?.bindings.some(row => row.key === section.id && row.binding?.workstreamId === selected?.workstream.id));
  const resetSelection = () => { setSelectedId(null); setShowDetail(false); };
  const open = (id: string) => { setSelectedId(id); setShowDetail(true); };
  const filtered = workstreamFilter !== "all" || stateFilter !== "all";
  const count = filtered ? `${visible.length} of ${items.length} loaded matches` : view === "search" && search.data ? search.data.total > items.length ? `First ${items.length} of ${search.data.total}` : plural(search.data.total, "match", "matches") : plural(items.length, "similar entry", "similar entries");
  return (
    <div data-cortex data-part="Library" role="region" aria-label="Knowledge library" tabIndex={0} className="cortex-library flex h-full min-h-0 flex-col focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onKeyDown={event => {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=dialog], [role=menu]")) return;
      event.preventDefault();
      setView("search");
      resetSelection();
      requestAnimationFrame(() => inputRef.current?.focus());
    }}>
      <div className="cortex-master-detail" data-show-detail={showDetail || undefined}>
        <div className="cortex-master border-r border-border-seam">
          <header className="flex min-w-0 flex-col gap-2 border-b border-border-seam p-4">
            {view === "search" ? <div className="relative min-w-0">
              <Icon name="Search" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input ref={inputRef} aria-label="Search saved knowledge" placeholder="Search saved knowledge" value={query} onChange={event => { setQuery(event.target.value); resetSelection(); }} className="h-8 min-w-0 pl-8 pr-8 text-[13px]" />
              <kbd aria-hidden className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 border border-border-seam px-1 text-[11px] text-muted-foreground">/</kbd>
            </div> : null}
            <Segmented label="Library view" value={view} options={[{ value: "search", label: "Search" }, { value: "similar", label: `Similar entries${similar.length ? ` · ${similar.length}` : ""}` }]} onChange={next => { setView(next); resetSelection(); setWorkstreamFilter("all"); setStateFilter("all"); }} />
            <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Filter loaded results">
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="cortex-filter h-auto min-h-7 px-2 py-1 text-[12px]">{workstreams.find(ws => ws.id === workstreamFilter)?.name ?? "All workstreams"}<Icon name="ChevronDown" className="size-3" aria-hidden /></Button></DropdownMenuTrigger>
                <DropdownMenuContent data-cortex className="cortex-knowledge" mobileTitle="Workstream" align="start">
                  {[{ id: "all", name: "All workstreams" }, ...workstreams].map(ws => <DropdownMenuItem key={ws.id} onSelect={() => { setWorkstreamFilter(ws.id); resetSelection(); }}>{ws.name}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="cortex-filter h-auto min-h-7 px-2 py-1 text-[12px]">{stateFilter === "all" ? "Any state" : BRIEF_STATE_LOOK[stateFilter as keyof typeof BRIEF_STATE_LOOK].word}<Icon name="ChevronDown" className="size-3" aria-hidden /></Button></DropdownMenuTrigger>
                <DropdownMenuContent data-cortex className="cortex-knowledge" mobileTitle="State" align="start">
                  <DropdownMenuItem onSelect={() => { setStateFilter("all"); resetSelection(); }}>Any state</DropdownMenuItem>
                  {states.map(state => <DropdownMenuItem key={state} onSelect={() => { setStateFilter(state); resetSelection(); }}><Icon name={BRIEF_STATE_LOOK[state].icon} aria-hidden />{BRIEF_STATE_LOOK[state].word}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
              <Hint text="Filters apply only to the results currently loaded."><span className="inline-flex items-center text-muted-foreground"><Icon name="Info" className="size-3.5" aria-label="About result filters" /></span></Hint>
            </div>
          </header>
          {read.error ? <div className="p-4"><FailureNotice failure={read.error} onRetry={read.refetch} /></div> : null}
          {view === "search" && query.trim() === "" ? <div className="p-4"><EmptyNote icon="Search">Search titles, text and sources in every workstream, including history.</EmptyNote></div>
            : read.isLoading && !read.data ? <div className="p-4"><LoadingRows label="Searching" /></div>
            : visible.length === 0 ? <div className="p-4"><EmptyNote icon="Search">{filtered ? "No loaded results match these filters." : view === "search" ? "Nothing matches." : "No entries waiting for review look like others."}</EmptyNote></div>
            : <>
              <p className="border-b border-border-seam px-4 py-2 text-[12px] text-muted-foreground">{count}</p>
              <ul aria-label="Results">{visible.map(item => <ResultRow key={item.entry.id} entry={item.entry} workstream={item.workstream} selected={item.entry.id === selected?.entry.id} onSelect={() => open(item.entry.id)} />)}</ul>
            </>}
        </div>
        <div className="cortex-detail">
          <Button variant="ghost" size="sm" className="cortex-back mb-3" onClick={() => setShowDetail(false)}><Icon name="ChevronLeft" aria-hidden />Results</Button>
          {extra?.error ? <FailureNotice failure={extra.error} onRetry={extra.refetch} /> : extra?.isLoading ? <LoadingRows label="Loading knowledge" /> : selected ? (
            <KnowledgeDetail key={selected.entry.id} entry={selected.entry} workstream={selected.workstream} onOpen={open} actions={<KnowledgeActions entry={selected.entry} workstream={selected.workstream} />}>
              {usedBy.length > 0 ? <dl className="cortex-knowledge-values"><dt>Used by</dt><dd className="flex min-w-0 flex-wrap gap-2">{usedBy.map(section => <Button key={section.id} variant="link" size="sm" className="cortex-filter h-auto p-0 text-[12px]" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `sections/${section.id}` })}>{section.name}</Button>)}</dd></dl> : null}
              {bindings.error ? <FailureNotice failure={bindings.error} onRetry={bindings.refetch} title="Could not read connected sections" /> : null}
              {selected.hints.length > 0 ? <Button variant="link" size="sm" className="cortex-filter h-auto self-start p-0 text-[12px]" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: "review" })}>Compare {plural(selected.hints.length, "similar entry", "similar entries")} in Review<Icon name="ArrowUpRight" aria-hidden /></Button> : null}
            </KnowledgeDetail>
          ) : null}
        </div>
      </div>
    </div>
  );
}
