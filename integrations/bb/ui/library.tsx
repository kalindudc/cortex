import { useState } from "react";
import { experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { dimensionWord, facetWord, plural, STATE_LOOK } from "./copy";
import { useBindings, useKnowledgeSearch, useReviewQueue, useWorkstreams, useWorkstreamWrites } from "./data";
import { BindingDialog } from "./dialogs";
import { KnowledgeActions, KnowledgeDetail } from "./knowledge";
import { displayState } from "./model";
import { EmptyNote, FailureNotice, LoadingRows, Segmented, TONE_TEXT } from "./parts";
import { CORTEX_PAGE_PATH } from "./thread-context";
import type { Binding, Knowledge, Workstream } from "./types";

function ResultRow({ entry, workstream, selected, onSelect }: { entry: Knowledge; workstream: Workstream; selected: boolean; onSelect: () => void }) {
  const look = STATE_LOOK[displayState(entry, Date.now())];
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          "flex w-full items-start gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
          selected ? "bg-surface-selected" : "hover:bg-state-hover",
        )}
      >
        <Icon name={look.icon} className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[look.tone])} aria-label={look.word} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[12.5px] font-semibold text-foreground">{entry.title}</span>
          <span className="mt-0.5 line-clamp-2 text-[11.5px] text-muted-foreground">
            {workstream.name} · {facetWord(entry.facet)} · {look.word}
          </span>
        </span>
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
  const search = useKnowledgeSearch(view === "search" ? query : "");
  const queue = useReviewQueue();
  const similar = (queue.data?.items ?? []).filter(item => item.hints.length > 0);
  const items = view === "search" ? (search.data?.items ?? []) : similar;
  const selected = items.find(item => item.entry.id === selectedId) ?? items[0] ?? null;
  const read = view === "search" ? search : queue;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border-seam px-4 py-3 md:px-5">
        <Segmented
          label="Library view"
          value={view}
          options={[
            { value: "search", label: "Search" },
            { value: "similar", label: `Similar entries${similar.length ? ` · ${similar.length}` : ""}` },
          ]}
          onChange={next => {
            setView(next);
            setSelectedId(null);
            setShowDetail(false);
          }}
        />
        {view === "search" ? (
          <div className="relative w-full max-w-md">
            <Icon name="Search" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input aria-label="Search saved knowledge" placeholder="Search saved knowledge" value={query} onChange={event => setQuery(event.target.value)} className="h-8 pl-8 text-[13px]" />
          </div>
        ) : null}
        {view === "search" && search.data ? (
          <span className="text-[12px] text-muted-foreground">
            {search.data.total > search.data.items.length ? `First ${search.data.items.length} of ${search.data.total}` : plural(search.data.total, "match", "matches")}
          </span>
        ) : null}
      </div>
      {read.error ? (
        <div className="p-4 md:p-5">
          <FailureNotice failure={read.error} onRetry={read.refetch} />
        </div>
      ) : view === "search" && query.trim() === "" ? (
        <div className="p-4 md:p-5">
          <EmptyNote icon="Search">Search titles, text and sources in every workstream, including history.</EmptyNote>
        </div>
      ) : read.isLoading ? (
        <div className="p-4 md:p-5">
          <LoadingRows label="Searching" />
        </div>
      ) : items.length === 0 ? (
        <div className="p-4 md:p-5">
          <EmptyNote icon="Search">{view === "search" ? "Nothing matches." : "No entries waiting for review look like others."}</EmptyNote>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul aria-label="Results" className={cn("min-h-0 w-full overflow-y-auto border-r border-border-seam lg:w-[22rem] lg:shrink-0", showDetail && "hidden lg:block")}>
            {items.map(item => (
              <ResultRow
                key={item.entry.id}
                entry={item.entry}
                workstream={item.workstream}
                selected={item.entry.id === selected?.entry.id}
                onSelect={() => {
                  setSelectedId(item.entry.id);
                  setShowDetail(true);
                }}
              />
            ))}
          </ul>
          {selected ? (
            <div className={cn("min-w-0 flex-1 overflow-y-auto px-4 py-4 md:px-5", showDetail ? "block" : "hidden lg:block")}>
              <Button variant="ghost" size="sm" className="mb-2 lg:hidden" onClick={() => setShowDetail(false)}>
                <Icon name="ChevronLeft" className="size-4" aria-hidden />
                Results
              </Button>
              <KnowledgeDetail entry={selected.entry} workstream={selected.workstream} actions={<KnowledgeActions entry={selected.entry} workstream={selected.workstream} />}>
                {selected.hints.length > 0 ? (
                  <p className="text-[12px] text-muted-foreground">
                    Similar to {selected.hints.map(hint => hint.id).join(", ")}. Compare and decide in Needs you.
                  </p>
                ) : null}
              </KnowledgeDetail>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function targetsWord(binding: Binding): string {
  const applicability = binding.applicability;
  if (!applicability) return "Targets not chosen";
  return `${dimensionWord("environment", applicability.environment)} · ${dimensionWord("host", applicability.host)}`;
}

/** bb sections and the workstream each one points to; threads in a section follow it, children follow their parent. */
export function Bindings() {
  const sidebar = experimental_useSidebarThreads();
  const bindings = useBindings();
  const workstreams = useWorkstreams();
  const writes = useWorkstreamWrites();
  const navigate = useBbNavigate();
  const [editing, setEditing] = useState<string | null>(null);
  if (bindings.error && bindings.data === undefined) return <div className="p-4 md:p-5"><FailureNotice failure={bindings.error} onRetry={bindings.refetch} /></div>;
  if (bindings.data === undefined || sidebar.status === "loading") return <div className="p-4 md:p-5"><LoadingRows label="Loading bindings" /></div>;
  const rows = new Map(bindings.data.bindings.map(row => [row.key, row]));
  const names = new Map((workstreams.data?.workstreams ?? []).map(ws => [ws.id, ws.name]));
  const sections = sidebar.sections;
  const editingSection = sections.find(section => section.id === editing) ?? null;
  const editingRow = editing ? rows.get(editing) : undefined;
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      {bindings.error ? <FailureNotice failure={bindings.error} onRetry={bindings.refetch} /> : null}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <div className="flex flex-col gap-0.5 text-[12.5px] text-muted-foreground">
          <p>Threads in a connected section get its approved knowledge from their next session.</p>
          <p>Child threads without a section follow their parent.</p>
          <p>This sets what Cortex sends, not what an agent can read.</p>
        </div>
        {sections.length === 0 ? (
          <EmptyNote icon="SectionAdd">No bb sections yet. Create one in the sidebar, or connect a single thread from its Memory tab.</EmptyNote>
        ) : (
          <ul aria-label="Sections" className="flex flex-col rounded-md border border-border-seam">
            {sections.map(section => {
              const row = rows.get(section.id);
              const binding = row?.binding ?? null;
              const threads = sidebar.threads.filter(thread => thread.sectionId === section.id && !thread.isArchived);
              return (
                <li key={section.id} className="flex flex-col gap-1.5 border-t border-border-seam px-3 py-2.5 first:border-t-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon name="Folder" className="size-4 text-muted-foreground" aria-hidden />
                    <span className="text-[13px] font-semibold text-foreground">{section.name}</span>
                    <Icon name="ArrowRight" className="size-3.5 text-muted-foreground" aria-hidden />
                    {binding ? (
                      <span className="text-[13px] text-foreground">
                        {names.get(binding.workstreamId) ?? binding.workstreamId}
                        <span className="text-muted-foreground"> · {binding.topic ? facetWord(binding.topic) : "Shared basics only"}</span>
                      </span>
                    ) : (
                      <span className="text-[13px] text-muted-foreground">Not connected</span>
                    )}
                    <span className="flex-1" />
                    <span className="text-[11.5px] text-muted-foreground">{plural(threads.length, "thread")}</span>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[12px]" onClick={() => setEditing(section.id)}>
                      {binding ? "Change…" : "Connect…"}
                    </Button>
                  </div>
                  {binding ? (
                    <p className="pl-6 text-[11.5px] text-muted-foreground">
                      {targetsWord(binding)} · budget {binding.budgetTokens} tokens
                      {binding.requiredKnowledgeIds.length > 0 ? ` · ${plural(binding.requiredKnowledgeIds.length, "required entry", "required entries")}` : ""}
                    </p>
                  ) : null}
                  {binding && threads.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 pl-6">
                      {threads.slice(0, 6).map(thread => (
                        <Button
                          key={thread.id}
                          variant="ghost"
                          size="sm"
                          className="h-7 max-w-56 px-2 text-[12px]"
                          aria-label={`Thread context for ${thread.displayTitle}`}
                          onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `threads/${thread.id}` })}
                        >
                          <span className="truncate" title={thread.displayTitle}>
                            {thread.displayTitle}
                          </span>
                        </Button>
                      ))}
                      {threads.length > 6 ? <span className="self-center text-[11.5px] text-muted-foreground">{threads.length - 6} more</span> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {editingSection ? (
        <BindingDialog
          target="section"
          name={editingSection.name}
          current={editingRow?.binding ?? null}
          expectedRevision={editingRow?.revision ?? 0}
          workstreams={workstreams.data?.workstreams ?? []}
          open
          onOpenChange={open => {
            if (!open) setEditing(null);
          }}
          onSave={async (binding, expectedRevision) => {
            await writes.setSectionBinding({ sectionId: editingSection.id, expectedRevision, binding });
            toast(binding ? `${editingSection.name} connected. Applies from each thread's next session.` : `${editingSection.name} disconnected for future sessions`);
          }}
        />
      ) : null}
    </div>
  );
}
