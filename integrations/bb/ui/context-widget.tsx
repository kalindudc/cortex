import { useLayoutEffect, useRef, useState } from "react";
import {
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  experimental_useAppPanel,
  experimental_useThreadContextKind,
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
import { cn } from "@/lib/utils";
import type { MemoryState } from "../memory";
import { markerLook, summaryHeadline } from "../panel/memory";
import { STATUS_LABEL } from "../panel/status";
import type { CortexThreadState } from "../state";
import { facetWord, ORIGIN_WORD, plural, STATUS_LOOK, tokens } from "./copy";
import { type RpcFailure, useMemoryState, useTaskState, useThreadContext, useWorkstreamWrites } from "./data";
import { PrepareDraftDialog } from "./dialogs";
import { contextHasContent } from "./model";
import { openMemoryTab, openTaskTab } from "./panel-tabs";
import { TONE_TEXT } from "./parts";
import type { ThreadContext } from "./types";

const STATUS_ICON: Record<keyof typeof STATUS_LABEL, string> = {
  draft: "CircleDot",
  open: "Circle",
  review: "Eye",
  blocked: "OctagonPause",
  done: "CircleCheck",
};
export const taskIcon = (status: keyof typeof STATUS_LABEL) => STATUS_ICON[status];

type Widget = {
  context: ThreadContext | undefined;
  failure: RpcFailure | null;
  memory: MemoryState | undefined;
  memoryFailure: RpcFailure | null;
  showMemory: boolean;
  task: CortexThreadState["links"][number] | null;
  showTask: boolean;
  retry: () => void;
};

function useWidget(threadId: string): Widget {
  const { values } = useSettings();
  const showMemory = values?.memoryChip !== false;
  const showTask = values?.taskChip !== false;
  const context = useThreadContext(threadId);
  const memory = useMemoryState(showMemory ? threadId : null);
  const state = useTaskState(showTask ? threadId : null);
  const task = state.data?.links.find(link => link.id === state.data?.focusTaskId) ?? null;
  return {
    context: context.data,
    failure: context.error,
    memory: memory.data,
    memoryFailure: memory.error,
    showMemory,
    task,
    showTask,
    retry: context.refetch,
  };
}

/** Whether the widget has anything to say and the person has not hidden it. Waits for the answer, so nothing flashes. */
function widgetVisible(widget: Widget): boolean {
  if (widget.context === undefined) return widget.failure !== null;
  if (widget.context.dismissed) return false;
  const memoryLive = widget.showMemory && widget.memory?.view != null && widget.memory.view.role !== "off";
  return contextHasContent(widget.context) || memoryLive || (widget.showTask && widget.task !== null);
}

/** The context row shows the widget only in banner panes; the card section covers card panes. */
export function useSegmentVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const kind = experimental_useThreadContextKind();
  const widget = useWidget(threadId);
  return kind === "banner" && widgetVisible(widget);
}

function MemoryMark({ memory, failure }: { memory: MemoryState | undefined; failure: RpcFailure | null }) {
  const look = markerLook(memory ?? null, failure?.message ?? null);
  if (look.symbol === "") return null;
  const tone = look.tone === "error" ? "text-destructive-text" : look.tone === "warning" ? "text-warning-text" : look.tone === "info" ? "text-file-accent" : "text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1", tone)} data-tone={look.tone} title={`Memory: ${look.title}`}>
      <Icon name="Brain" className="size-3.5" aria-hidden />
      <span className="font-mono text-[11px]" aria-hidden>
        {look.symbol}
      </span>
      <span className="sr-only">Memory: {look.title}</span>
    </span>
  );
}

function summaryLabel(widget: Widget): string {
  const context = widget.context;
  const state = context === undefined ? "Cortex context could not load" : context.status === "unbound" ? "Cortex memory. Not connected to a workstream" : `Cortex context: ${context.workstream?.name ?? "workstream"}${context.binding?.topic ? `, ${context.binding.topic}` : ""}. ${STATUS_LOOK[context.status].word}, ${plural(context.entries.length, "takeaway")}, ${plural(context.notices.length, "held notice")}. ${tokens(context.estimatedTokens)} of ${context.budgetTokens} tokens. Preview, not a delivery receipt`;
  const memory = widget.showMemory ? `Memory: ${markerLook(widget.memory ?? null, widget.memoryFailure?.message ?? null).title}` : null;
  const task = widget.showTask && widget.task ? `Task #${widget.task.id}: ${widget.task.title}, ${STATUS_LABEL[widget.task.status]}` : null;
  return [state, context?.error, widget.failure?.message, memory, task].filter(Boolean).join(". ");
}

/** One line in the context row: the workstream, its budget, what is held back, and the memory mark. */
export function ContextSegmentSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const widget = useWidget(threadId);
  const context = widget.context;
  const held = context ? context.notices.length : 0;
  const status = context ? STATUS_LOOK[context.status] : null;
  const memoryLook = widget.showMemory ? markerLook(widget.memory ?? null, widget.memoryFailure?.message ?? null) : null;
  const blocked = widget.failure !== null || !!context?.error || (context !== undefined && context.status !== "ready" && context.status !== "unbound") || memoryLook?.tone === "error";
  const glyph = blocked ? "CircleAlert" : held > 0 || memoryLook?.tone === "warning" ? "TriangleAlert" : "Brain";
  const root = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(240);
  useLayoutEffect(() => {
    const target = root.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(entry => entry.target === target);
      if (entry) setWidth(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const iconOnly = width < 100;
  const complete = width >= 240;
  const label = `${summaryLabel(widget)}. ${isExpanded ? "Hide" : "Show"} details`;
  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      ref={root}
      aria-label={label}
      title={label}
      onClick={onToggle}
      style={{ flex: "1 1 0%", minWidth: 0 }}
      data-cortex-summary=""
      className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span data-cortex-summary-icon="" className="inline-flex shrink-0">
        <Icon name={glyph} className={cn("size-3.5", glyph === "Brain" ? "text-primary" : "text-foreground")} aria-hidden />
      </span>
      {!iconOnly ? <>
      {!complete ? <span data-cortex-extra="" className="min-w-0 truncate text-foreground">Cortex</span> : context === undefined ? (
        <>
          <span className="min-w-0 truncate text-foreground">Cortex unavailable</span>
        </>
      ) : context.status === "unbound" ? (
        <span className="text-foreground">Cortex</span>
      ) : (
        <>
          <span data-cortex-extra="" className="min-w-0 truncate font-semibold text-foreground">{context.workstream?.name}</span>

          <span className={cn("shrink-0 whitespace-nowrap tabular-nums text-foreground", context.status === "ready" ? "" : TONE_TEXT[status!.tone])}>
            {context.status === "ready" ? plural(context.entries.length, "takeaway") : status!.word}
          </span>
          {held > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-warning-text">
              <Icon name="TriangleAlert" className="size-3" aria-hidden />
              <span className="tabular-nums">{held}</span>
              <span className="sr-only">held back</span>
            </span>
          ) : null}
        </>
      )}
      {complete && widget.showMemory ? <MemoryMark memory={widget.memory} failure={widget.memoryFailure} /> : null}
      {width >= 140 ? <Icon name={isExpanded ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0" aria-hidden /> : null}
      </> : null}
    </button>
  );
}

function HideButton({ threadId, compact = false }: { threadId: string; compact?: boolean }) {
  const writes = useWorkstreamWrites();
  const hide = async () => {
    try {
      await writes.setDismissed(threadId, true);
      toast("Hidden for this thread. Show it again from the thread menu or the Memory tab.");
    } catch (cause) {
      toast.error((cause as RpcFailure).message);
    }
  };
  return (
    <Button variant="ghost" size="sm" className={cn("h-7 gap-1 px-2 text-[12px]", compact && "px-1.5")} onClick={() => void hide()}>
      <Icon name="EyeOff" className="size-3.5" aria-hidden />
      Hide for this thread
    </Button>
  );
}

/** Below the row while expanded: what goes in, the actions, and the way to hide it for this thread. */
export function ContextSegmentDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const widget = useWidget(threadId);
  const panel = experimental_useAppPanel();
  const [preparing, setPreparing] = useState(false);
  if (!isExpanded) return null;
  const context = widget.context;
  if (context === undefined) {
    return (
      <div role="alert" className="flex items-center gap-2 px-2 py-1.5 text-[12.5px] text-destructive-text">
        <span className="flex-1">{widget.failure?.message ?? "Cortex did not answer."}</span>
        <Button variant="outline" size="sm" className="h-7 px-2" onClick={widget.retry}>
          Retry
        </Button>
        <HideButton threadId={threadId} compact />
      </div>
    );
  }
  const bound = context.status !== "unbound";
  return (
    <div className="flex flex-col gap-2 px-2 py-2 text-[12.5px]">
      {bound ? (
        <ul className="flex flex-col gap-1">
          {context.entries.slice(0, 3).map(entry => (
            <li key={entry.knowledge.id} className="flex min-w-0 items-center gap-2">
              <Icon name={entry.knowledge.kind === "directive" ? "ListTodo" : "Search"} className="size-3.5 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-foreground">{entry.knowledge.title}</span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">{ORIGIN_WORD[entry.origin]}</span>
            </li>
          ))}
          {context.entries.length > 3 ? <li className="text-[11.5px] text-muted-foreground">{plural(context.entries.length - 3, "more item")}</li> : null}
          {context.notices.length > 0 ? (
            <li className="flex items-center gap-2 text-warning-text">
              <Icon name="TriangleAlert" className="size-3.5" aria-hidden />
              {plural(context.notices.length, "notice")} only, text held back for review
            </li>
          ) : null}
          {context.status !== "ready" ? (
            <li className={TONE_TEXT[STATUS_LOOK[context.status].tone]}>
              {STATUS_LOOK[context.status].word}. {context.error}
            </li>
          ) : null}
        </ul>
      ) : null}
      {widget.showMemory && widget.memory ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Icon name="Brain" className="size-3.5" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{summaryHeadline(widget.memory, widget.memoryFailure?.message ?? null)}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="outline" size="sm" className="h-7 px-2 text-[12px]" onClick={() => openMemoryTab(panel)}>
          {bound ? "Preview context" : "Open Memory tab"}
        </Button>
        {bound ? (
          <Button variant="outline" size="sm" className="h-7 px-2 text-[12px]" disabled={context.status !== "ready"} onClick={() => setPreparing(true)}>
            Prepare draft…
          </Button>
        ) : null}
        <span className="flex-1" />
        <HideButton threadId={threadId} />
      </div>
      {bound ? <PrepareDraftDialog threadId={threadId} open={preparing} onOpenChange={setPreparing} /> : null}
    </div>
  );
}

/** The same context as card rows, for panes that show the thread context card. */
export function ContextCardSection({ threadId }: ExperimentalThreadContextCardProps) {
  const widget = useWidget(threadId);
  const panel = experimental_useAppPanel();
  const writes = useWorkstreamWrites();
  const [preparing, setPreparing] = useState(false);
  if (!widgetVisible(widget)) return null;
  const context = widget.context;
  const bound = context !== undefined && context.status !== "unbound";
  const hide = async () => {
    try {
      await writes.setDismissed(threadId, true);
      toast("Hidden for this thread. Show it again from the thread menu or the Memory tab.");
    } catch (cause) {
      toast.error((cause as RpcFailure).message);
    }
  };
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Cortex context actions"
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="MoreHorizontal" className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" mobileTitle="Cortex context" className="w-60">
        <DropdownMenuItem onSelect={() => openMemoryTab(panel)}>
          <Icon name="Eye" aria-hidden />
          Preview context
        </DropdownMenuItem>
        {bound ? (
          <DropdownMenuItem disabled={context.status !== "ready"} onSelect={() => setPreparing(true)}>
            <Icon name="MessageSquarePlus" aria-hidden />
            Prepare draft…
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => void hide()}>
          <Icon name="EyeOff" aria-hidden />
          Hide for this thread
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const showTaskRow = widget.showTask && widget.task !== null;
  const memoryLive = widget.showMemory && widget.memory?.view != null && widget.memory.view.role !== "off";
  // The Hide menu rides on the first row shown, so every visible card can be hidden.
  const menuOn = context === undefined || bound ? "context" : showTaskRow ? "task" : "memory";
  return (
    <>
      {context === undefined ? (
        <ThreadContextCardRow icon="AlertCircle" label="Cortex unavailable" title={widget.failure?.message} onClick={widget.retry} trailing="Retry" action={menu} />
      ) : bound ? (
        <ThreadContextCardRow
          icon="Layers"
          label={`${context.workstream?.name ?? "Workstream"}${context.binding?.topic ? ` · ${facetWord(context.binding.topic)}` : ""}`}
          title={`${STATUS_LOOK[context.status].word}. ${tokens(context.estimatedTokens)} of ${context.budgetTokens} tokens. Opens the Memory tab.`}
          trailing={context.status === "ready" ? `${tokens(context.estimatedTokens)}/${context.budgetTokens}` : STATUS_LOOK[context.status].word}
          onClick={() => openMemoryTab(panel)}
          action={menu}
        />
      ) : null}
      {showTaskRow && widget.task ? (
        <ThreadContextCardRow
          icon={taskIcon(widget.task.status)}
          label={`#${widget.task.id} ${widget.task.title}`}
          title={`${STATUS_LABEL[widget.task.status]}. Opens the Cortex tab.`}
          trailing={STATUS_LABEL[widget.task.status]}
          onClick={() => openTaskTab(panel, threadId, null)}
          action={menuOn === "task" ? menu : undefined}
        />
      ) : null}
      {memoryLive ? (
        <ThreadContextCardRow
          icon="Brain"
          label={summaryHeadline(widget.memory ?? null, widget.memoryFailure?.message ?? null)}
          title="Opens the Memory tab."
          trailing={markerLook(widget.memory ?? null, null).symbol}
          onClick={() => openMemoryTab(panel)}
          action={menuOn === "memory" ? menu : undefined}
        />
      ) : null}
      {bound ? <PrepareDraftDialog threadId={threadId} open={preparing} onOpenChange={setPreparing} /> : null}
    </>
  );
}
