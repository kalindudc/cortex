import { type ReactNode, useState } from "react";
import { type ExperimentalThreadActionTabProps, experimental_useAppPanel } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  effectiveMode,
  MEMORY_MODES,
  MODE_LABEL,
  type MemoryMode,
  type MemoryState,
  type MemoryView,
  ROLE,
  ROLE_LABEL,
} from "../memory";
import type { CortexTaskRow } from "../state";
import { useThreadContext } from "../ui/data";
import { openTaskTab } from "../ui/panel-tabs";
import { FailureNotice, LoadingRows } from "../ui/parts";
import { ContextHistory, ContextOverview, NextContext, VisibilityControl } from "../ui/thread-context";
import { errorText, useCortexRpc, useMemory, useTaskRows } from "./hooks";
import { ErrorNotice } from "./panel";
import { STATUS_LABEL, StatusDot } from "./status";

// Copies of src/extensions/memory-view.ts#MEMORY_SYMBOLS (the plugin imports no cortex source); the saving arc is static.
export const MEMORY_SYMBOLS = {
  loaded: "\u25cf",
  empty: "\u25cb",
  stale: "\u25d0",
  error: "\u2298",
  saving: "\u25dc",
} as const;

export type MarkerLook = { symbol: string; tone: "muted" | "info" | "warning" | "error"; title: string };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The pi footer's marker, with its priority: error > stale > saving > loaded > nothing loaded. */
export function markerLook(memory: MemoryState | null, error: string | null): MarkerLook {
  const s = MEMORY_SYMBOLS;
  if (error !== null) return { symbol: s.error, tone: "error", title: `error: ${error}` };
  if (memory === null) return { symbol: s.empty, tone: "muted", title: "loading" };
  const { view } = memory;
  if ((view?.role ?? ROLE[memory.mode]) === "off") return { symbol: "", tone: "muted", title: "off for this thread" };
  if (view === null) return { symbol: s.empty, tone: "muted", title: "no agent session since the Cortex plugin loaded" };
  if (view.error) return { symbol: s.error, tone: "error", title: `error: ${view.error}` };
  if (view.stale) {
    const { id, detail } = view.stale;
    return { symbol: s.stale, tone: "warning", title: `@${id} is stale: ${detail}` };
  }
  if (view.saving) return { symbol: s.saving, tone: "info", title: "the automatic save turn is running" };
  if (view.inContext.length > 0) {
    return { symbol: s.loaded, tone: "info", title: `${plural(view.inContext.length, "stream")} in context` };
  }
  return { symbol: s.empty, tone: "info", title: "nothing loaded yet" };
}

const SYMBOL_TONE: Record<MarkerLook["tone"], string> = {
  muted: "",
  info: "text-file-accent",
  warning: "text-warning-text",
  error: "text-destructive-text",
};

/** `~350`, `~1.4k`: characters / 4, the usual token estimate (src/extensions/memory-view.ts tokens). */
function tokens(chars: number): string {
  const n = Math.round(chars / 4);
  return n < 1000 ? `~${n}` : `~${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

const SOURCES = [
  { via: "summary", label: "session summary", bar: "bg-primary-foreground" },
  { via: "prompt", label: "matched a message", bar: "bg-primary-foreground/60" },
  { via: "recall", label: "recalled by the agent", bar: "bg-primary-foreground/30" },
] as const;

/** The hover summary's first line: what needs attention, else how much memory is in context. */
export function summaryHeadline(memory: MemoryState | null, error: string | null): string {
  if (error !== null) return `Memory could not load: ${error}`;
  if (memory === null) return "Loading\u2026";
  const { view } = memory;
  if ((view?.role ?? ROLE[memory.mode]) === "off") return "Off for this thread";
  if (view === null) return "This thread's agent has not started a session since the Cortex plugin loaded";
  if (view.error) return `Error: ${view.error}`;
  if (view.stale) return `@${view.stale.id} is stale: ${view.stale.detail}`;
  if (view.saving) return "Saving: the automatic save turn is running";
  if (view.inContext.length === 0) return "Nothing loaded yet";
  return `${plural(view.inContext.length, "stream")} in context \u00b7 ${tokens(view.stats.chars)} tokens`;
}

/** Where the streams in context came from, as one stacked bar and its legend. */
function SourceBar({ view }: { view: MemoryView }) {
  const total = view.inContext.length;
  const counts = SOURCES.map(source => ({
    ...source,
    n: view.inContext.filter(entry => entry.via === source.via).length,
  })).filter(source => source.n > 0);
  const label = counts.map(source => `${source.n} ${source.label}`).join(", ");
  return (
    <div className="flex flex-col gap-1">
      <div role="img" aria-label={label} className="flex h-1.5 overflow-hidden rounded-full bg-primary-foreground/15">
        {counts.map(source => (
          <span key={source.via} className={source.bar} style={{ width: `${(100 * source.n) / total}%` }} />
        ))}
      </div>
      <div aria-hidden className="flex flex-wrap gap-x-2.5 gap-y-0.5 opacity-80">
        {counts.map(source => (
          <span key={source.via} className="inline-flex items-center gap-1">
            <span className={cn("size-1.5 rounded-full", source.bar)} />
            {source.n} {source.label}
          </span>
        ))}
      </div>
    </div>
  );
}

type FocusTask = { id: number; title: string; status: keyof typeof STATUS_LABEL };

/** The hover card: mode and lane, health, where the streams came from, the work, the totals and the thread's task. */
export function MemorySummary({
  memory,
  error,
  task,
}: {
  memory: MemoryState | null;
  error: string | null;
  task: FocusTask | null;
}) {
  const view = memory?.view ?? null;
  const live = view !== null && view.role !== "off";
  const focus = live && view.role === "writer" ? view.focus : [];
  const st = view?.stats;
  const totals =
    live && st
      ? [
          plural(st.prompts, "prompt"),
          `${plural(st.lookups, "lookup")}${st.lookups > 0 ? `, last ${st.lastMs} ms` : ""}`,
          ...(st.checkpoints > 0 ? [plural(st.checkpoints, "save turn")] : []),
        ].join(" \u00b7 ")
      : null;
  return (
    <div className="flex flex-col gap-1.5 py-0.5" data-testid="memory-summary">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">Cortex memory</span>
        {memory ? (
          <span className="truncate opacity-70">
            {MODE_LABEL[memory.mode]}
            {view?.lane ? ` \u00b7 ${view.lane}` : ""}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-3 break-words">{summaryHeadline(memory, error)}</p>
      {live && view.inContext.length > 0 ? <SourceBar view={view} /> : null}
      {focus.length > 0 ? <p className="opacity-80">Working on {focus.map(id => `#${id}`).join(", ")}</p> : null}
      {totals ? <p className="opacity-80">{totals}</p> : null}
      {task ? (
        <p className="truncate opacity-80">{`Task #${task.id} \u00b7 ${STATUS_LABEL[task.status]}: ${task.title}`}</p>
      ) : null}
    </div>
  );
}

/** The health line in the words of pi's `/memory` (src/extensions/memory-view.ts healthLine), for one view. */
function healthText(view: MemoryView): string {
  if (view.role === "off") return "off \u2014 no memory summary and no recall";
  if (view.error) return `error \u2014 ${view.error}`;
  if (view.stale) return `stale \u2014 @${view.stale.id}: ${view.stale.detail}`;
  if (view.saving) return "saving \u2014 the memory checkpoint turn is running";
  if (view.role === "reader") return "Look up only: no memory summary; the agent can still recall";
  if (view.inContext.length === 0) return "ready \u2014 nothing loaded yet";
  const { lookups, lastMs, chars } = view.stats;
  const done = lookups > 0 ? `${plural(lookups, "lookup")}, last ${lastMs} ms` : "0 lookups";
  return `working \u2014 ${done} \u00b7 ${tokens(chars)} tokens of memory added`;
}

function reasonText(entry: MemoryView["inContext"][number]): string {
  if (entry.via === "summary") return "session summary";
  if (entry.via === "recall") return "recalled by the agent";
  return `matched \u201c${entry.query ?? ""}\u201d`;
}

function totals(view: MemoryView): string[] {
  const st = view.stats;
  const parts: string[] = [];
  if (st.prompts > 0) parts.push(plural(st.prompts, "prompt"));
  if (st.checkpoints > 0) parts.push(plural(st.checkpoints, "checkpoint"));
  if (st.breadcrumbs > 0) parts.push(plural(st.breadcrumbs, "compaction snapshot"));
  if (st.silentRuns > 0) parts.push(`${plural(st.silentRuns, "agent run")} without memory`);
  return parts;
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-4 mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>
  );
}

/** One stream: status, #id, title, its lane when not the thread's, and why it is there; opens it in the Cortex tab. */
function StreamRow({
  id,
  row,
  lane,
  reason,
  onOpen,
}: {
  id: number;
  row: CortexTaskRow | undefined;
  lane: string | null;
  reason?: string;
  onOpen: (taskId: number) => void;
}) {
  const tail = [row && lane !== null && row.lane !== lane ? row.lane : null, reason].filter(Boolean).join(" \u00b7 ");
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(id)}
        aria-label={`Open #${id}${row ? ` ${row.title}` : ""} in the Cortex tab`}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-state-hover"
      >
        {row ? <StatusDot status={row.status} /> : null}
        <span className="shrink-0 font-mono text-muted-foreground">#{id}</span>
        <span className="min-w-0 flex-1 truncate text-foreground" title={row?.title}>
          {row?.title ?? ""}
        </span>
        {tail ? (
          <span className="max-w-[55%] shrink-0 truncate text-[11.5px] text-muted-foreground" title={tail}>
            {tail}
          </span>
        ) : null}
      </button>
    </li>
  );
}

const NONE = <p className="px-1.5 text-muted-foreground">none yet</p>;

/** The thread's memory mode menu; a change applies when bb next starts this thread's agent. */
function ModeControl({ memory, onChange }: { memory: MemoryState; onChange: (next: MemoryState) => void }) {
  const { threadId } = memory;
  const rpc = useCortexRpc();
  const follow = `Follow the setting (${MODE_LABEL[effectiveMode(memory.setting, null, memory.child)]})`;
  const current = memory.override === null ? follow : MODE_LABEL[memory.override];
  const choose = async (mode: MemoryMode | null) => {
    try {
      onChange(await rpc.call("setMemoryMode", { threadId, mode }));
      toast("Applies when bb next starts this thread's agent");
    } catch (cause) {
      toast.error(`Could not change memory: ${errorText(cause)}`);
    }
  };
  const options: Array<[MemoryMode | null, string]> = [[null, follow], ...MEMORY_MODES.map(m => [m, MODE_LABEL[m]] as [MemoryMode, string])];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-[12px]" aria-label={`Memory for this thread: ${current}. Change`}>
          {current}
          <Icon name="ChevronDown" className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" mobileTitle="Memory for this thread" className="w-80">
        {options.map(([mode, label]) => (
          <DropdownMenuItem key={mode ?? "follow"} onSelect={() => void choose(mode)} aria-checked={mode === memory.override}>
            <span className="flex-1">{label}</span>
            {mode === memory.override ? <Icon name="Check" className="size-3.5 text-primary" aria-label="current" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Working on, In context with each stream's reason, the session totals and the marker legend. */
function TaskMemory({ view, rows, onOpen }: { view: MemoryView | null; rows: Map<number, CortexTaskRow> | null; onOpen: (taskId: number) => void }) {
  if (view === null) {
    return <p className="mt-2 text-muted-foreground">This thread's agent has not started a session since the Cortex plugin loaded.</p>;
  }
  if (view.role === "off") return <p className="mt-2 text-muted-foreground">Memory is off for this thread.</p>;
  const focus = view.role === "writer" ? view.focus : [];
  const lane = view.lane ?? null;
  const parts = totals(view);
  const m = MEMORY_SYMBOLS;
  return (
    <>
      {view.role === "writer" ? (
        <section aria-label="Working on">
          <Heading>Working on</Heading>
          {focus.length === 0 ? NONE : null}
          <ul>
            {focus.map(id => (
              <StreamRow key={id} id={id} row={rows?.get(id)} lane={lane} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="In context">
        <Heading>In context ({view.inContext.length})</Heading>
        {view.inContext.length === 0 ? NONE : null}
        <ul>
          {view.inContext.map(entry => (
            <StreamRow key={entry.id} id={entry.id} row={rows?.get(entry.id)} lane={lane} reason={reasonText(entry)} onOpen={onOpen} />
          ))}
        </ul>
      </section>
      {parts.length > 0 ? (
        <section aria-label="This session">
          <Heading>This session</Heading>
          <p className="px-1.5 text-muted-foreground">{parts.join(" \u00b7 ")}</p>
        </section>
      ) : null}
      <p className="mt-4 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
        {`${m.loaded} loaded  ${m.empty} nothing loaded  ${m.saving} saving  ${m.stale} stale  ${m.error} error`}
      </p>
    </>
  );
}

const TAB_TRIGGER =
  "-mb-px rounded-none border-b-2 border-transparent bg-transparent px-2.5 py-2 text-[12.5px] font-normal text-muted-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none";

/**
 * The Memory tab: the thread's memory mode and health, whether Cortex context
 * shows above the composer (where a dismissed widget comes back), the thread's
 * next context, its context history, and the task memory pi's `/memory` shows.
 */
export function MemoryPanel({ threadId }: ExperimentalThreadActionTabProps): ReactNode {
  const { memory, error, refetch, accept } = useMemory(threadId);
  const context = useThreadContext(threadId);
  const panel = experimental_useAppPanel();
  const [chosen, setChosen] = useState<string | null>(null);
  const view = memory?.view ?? null;
  const focus = view?.role === "writer" ? view.focus : [];
  const ids = [...new Set([...focus, ...(view?.inContext ?? []).map(entry => entry.id)])];
  const rows = useTaskRows(ids);
  const open = (taskId: number) => {
    openTaskTab(panel, threadId, taskId);
  };
  if (error !== null) {
    return (
      <div className="p-4">
        <ErrorNotice message={error} onRetry={refetch} />
      </div>
    );
  }
  if (memory === null) return null;
  const look = markerLook(memory, null);
  const role = view?.role ?? ROLE[memory.mode];
  const lane = view?.lane ?? null;
  const bound = context.data !== undefined && context.data.status !== "unbound";
  const tab = chosen ?? (bound || context.error !== null ? "context" : "tasks");
  return (
    <div className="h-full overflow-y-auto px-4 pt-3 pb-4 text-[12.5px]">
      <header className="flex items-center gap-2">
        {look.symbol ? (
          <span aria-hidden className={cn("font-mono", SYMBOL_TONE[look.tone])}>
            {look.symbol}
          </span>
        ) : null}
        <h2 className="text-[14px] font-semibold text-foreground">Memory</h2>
        <span className="flex-1" />
        <span className="truncate text-[11.5px] text-muted-foreground">
          {ROLE_LABEL[role]}
          {lane === null ? "" : ` \u00b7 lane ${lane}`}
        </span>
      </header>
      {view === null ? null : (
        <p
          className={cn(
            "mt-2",
            look.tone === "error" ? "text-destructive-text" : look.tone === "warning" ? "text-warning-text" : "text-foreground",
          )}
          data-testid="memory-health"
        >
          {healthText(view)}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ModeControl memory={memory} onChange={accept} />
        {context.data ? <VisibilityControl context={context.data} /> : null}
      </div>
      <p className="mt-1.5 text-[11.5px] text-muted-foreground">A change applies when bb next starts this thread's agent.</p>
      <Tabs value={tab} onValueChange={setChosen} className="mt-2">
        <TabsList className="h-auto w-full justify-start gap-0.5 rounded-none border-b border-border-seam bg-transparent p-0">
          <TabsTrigger value="context" className={TAB_TRIGGER}>
            Next context
          </TabsTrigger>
          <TabsTrigger value="history" className={TAB_TRIGGER}>
            Context history
          </TabsTrigger>
          <TabsTrigger value="tasks" className={TAB_TRIGGER}>
            Task memory
          </TabsTrigger>
        </TabsList>
        <TabsContent value="context" className="mt-3">
          {context.error ? (
            <FailureNotice failure={context.error} onRetry={context.refetch} />
          ) : context.data === undefined ? (
            <LoadingRows label="Loading thread context" />
          ) : (
            <div className="flex flex-col gap-3">
              <ContextOverview context={context.data} canPrepare />
              {bound ? <NextContext context={context.data} /> : null}
            </div>
          )}
        </TabsContent>
        <TabsContent value="history" className="mt-3">
          <ContextHistory threadId={threadId} />
        </TabsContent>
        <TabsContent value="tasks" className="mt-1">
          <TaskMemory view={view} rows={rows} onOpen={open} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
