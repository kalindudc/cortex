import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";
import {
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
  useBbNavigate,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
import { useFooterMount } from "./footer";
import { errorText, useCortexRpc, useMemory, useTaskRows, useThreadState } from "./hooks";
import { ErrorNotice } from "./panel";
import { openCortexTab } from "./selection";
import { STATUS_LABEL, StatusDot } from "./status";

export const MEMORY_ACTION_ID = "cortex-memory";

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
      <p className="opacity-60">Click to open the Memory tab</p>
    </div>
  );
}

const ICON_TONE: Record<MarkerLook["tone"], string> = {
  muted: "text-muted-foreground hover:text-foreground",
  info: "text-file-accent",
  warning: "text-warning-text",
  error: "text-destructive-text",
};

/** The memory icon: its colour is the marker's state, hovering shows the summary, a click opens the Memory tab. */
function MemoryIcon({ threadId, placement }: { threadId: string; placement: "footer" | "header" }) {
  const { memory, error } = useMemory(threadId);
  const { state } = useThreadState(threadId);
  const navigate = useBbNavigate();
  const look = markerLook(memory, error);
  const task = state?.links.find(link => link.id === state.focusTaskId) ?? null;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-tone={look.tone}
            data-placement={placement}
            aria-label={`Cortex memory: ${look.title}. Open the Memory tab.`}
            onClick={() => {
              navigate.openThreadPanel({ actionId: MEMORY_ACTION_ID });
            }}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-state-hover",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              placement === "footer" ? "size-6" : "size-7",
              ICON_TONE[look.tone],
              memory?.view?.saving && "animate-pulse",
            )}
          >
            <Icon name="Brain" className="size-4" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side={placement === "footer" ? "top" : "bottom"} align="end" className="w-72">
          <MemorySummary memory={memory} error={error} task={task} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * A thread header action, which bb always mounts, unlike a prompt-box action.
 * It shows the memory icon beside the context circle under the prompt box,
 * or here in the header when that row is not on screen, unless the viewport is
 * compact: a phone's header has no room. The anchor stays to find the row.
 */
export function MemoryHeaderAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps): ReactNode {
  const { values } = useSettings();
  const hidden = values?.memoryChip === false;
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const mount = useFooterMount(hidden ? null : anchor);
  if (hidden) return null;
  const inHeader = mount === null && !isCompactViewport;
  const icon = <MemoryIcon threadId={threadId} placement={mount === null ? "header" : "footer"} />;
  return (
    <span ref={setAnchor} className={inHeader ? "inline-flex items-center" : "hidden"}>
      {mount !== null ? createPortal(icon, mount) : inHeader ? icon : null}
    </span>
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
    <h3 className="mt-4 mb-1 text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">{children}</h3>
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
        <span className="min-w-0 flex-1 truncate text-foreground">{row?.title ?? ""}</span>
        {tail ? <span className="max-w-[55%] shrink-0 truncate text-[11.5px] text-subtle-foreground">{tail}</span> : null}
      </button>
    </li>
  );
}

const NONE = <p className="px-1.5 text-muted-foreground">none yet</p>;

/** The mode menu and the note on when a change applies. */
function Controls({ memory, onChange }: { memory: MemoryState; onChange: (next: MemoryState) => void }) {
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
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-[26px] gap-1.5 px-2.5" aria-label={`Memory for this thread: ${current}. Change`}>
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
      </div>
      <p className="text-[11.5px] text-muted-foreground">A change applies when bb next starts this thread's agent.</p>
    </div>
  );
}

/** The Memory tab: what pi's `/memory` shows, for pi and every other provider, and the thread's memory mode. */
export function MemoryPanel({ threadId }: PluginThreadPanelProps): ReactNode {
  const { memory, error, refetch, accept } = useMemory(threadId);
  const navigate = useBbNavigate();
  const view = memory?.view ?? null;
  const focus = view?.role === "writer" ? view.focus : [];
  const ids = [...new Set([...focus, ...(view?.inContext ?? []).map(entry => entry.id)])];
  const rows = useTaskRows(ids);
  const open = (taskId: number) => {
    openCortexTab(navigate, threadId, taskId);
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
  const m = MEMORY_SYMBOLS;
  const parts = view ? totals(view) : [];
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
      {view === null ? (
        <p className="mt-2 text-muted-foreground">
          This thread's agent has not started a session since the Cortex plugin loaded.
        </p>
      ) : (
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
      <Controls memory={memory} onChange={accept} />
      {view === null || view.role === "off" ? null : (
        <>
          {view.role === "writer" ? (
            <section aria-label="Working on">
              <Heading>Working on</Heading>
              {focus.length === 0 ? NONE : null}
              <ul>
                {focus.map(id => (
                  <StreamRow key={id} id={id} row={rows?.get(id)} lane={lane} onOpen={open} />
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-label="In context">
            <Heading>In context ({view.inContext.length})</Heading>
            {view.inContext.length === 0 ? NONE : null}
            <ul>
              {view.inContext.map(entry => (
                <StreamRow
                  key={entry.id}
                  id={entry.id}
                  row={rows?.get(entry.id)}
                  lane={lane}
                  reason={reasonText(entry)}
                  onOpen={open}
                />
              ))}
            </ul>
          </section>
          {parts.length > 0 ? (
            <section aria-label="This session">
              <Heading>This session</Heading>
              <p className="px-1.5 text-muted-foreground">{parts.join(" \u00b7 ")}</p>
            </section>
          ) : null}
          <p className="mt-4 font-mono text-[11px] whitespace-pre-wrap text-subtle-foreground">
            {`${m.loaded} loaded  ${m.empty} nothing loaded  ${m.saving} saving  ${m.stale} stale  ${m.error} error`}
          </p>
        </>
      )}
    </div>
  );
}
