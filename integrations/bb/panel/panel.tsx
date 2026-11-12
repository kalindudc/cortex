import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CortexStatus } from "../detail";
import type { CortexTaskDetail, CortexTaskRow, CortexThreadState } from "../state";
import { ActivityTimeline, Composer } from "./activity";
import { errorText, panelTaskId, useCortexRpc, useTaskDetail, useThreadState } from "./hooks";
import { MoreMenu, SwitcherMenu, TaskRowLabel, TaskSearchField, useTaskSearch } from "./menus";
import { BodySections, BriefBridge, FreshnessCallout, UnfoldedUpdates, useBodySections } from "./overview";
import { selectTask, useSelectedTask } from "./selection";
import { NextStepButton, STATUS_LABEL, StatusTrack } from "./status";
import { relativeTime } from "./time";

const FLASH_MS = 900;

export function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-[12.5px] text-foreground"
    >
      <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0 text-destructive-text" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <Button variant="outline" size="sm" className="h-[26px] px-2.5" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <DelayedLoading>
      <div className="px-4 pt-3 pb-3" data-testid="cortex-loading" aria-busy="true">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="mt-3 h-2.5 w-20" />
        <Skeleton className="mt-2 h-4 w-11/12" />
        <Skeleton className="mt-1.5 h-4 w-3/5" />
        <div className="mt-3 flex gap-2">
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-6 w-28" />
        </div>
        {[90, 70, 84, 60].map(width => (
          <Skeleton key={width} className="mt-4 h-2.5" style={{ width: `${width}%` }} />
        ))}
      </div>
    </DelayedLoading>
  );
}

function FreshnessPill({ detail, onClick }: { detail: CortexTaskDetail; onClick: () => void }) {
  const { verdict, reason } = detail.staleness;
  const files = detail.sync.changed.length + detail.sync.missing.length;
  const hint = verdict === "fresh"
    ? "The task's source files have not changed since its last sync. This does not check that the task is still right."
    : verdict === "stale"
      ? reason ?? "The body may be out of date. Open the source checks."
      : `Freshness not checked${reason ? `: ${reason}` : ""}`;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            title={hint}
            className={cn(
              "inline-flex min-h-6 items-center gap-1 rounded-md border px-2 text-[11.5px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              verdict === "stale" ? "border-warning/45 bg-warning/10 text-warning-text" : verdict === "fresh" ? "border-success/35 text-success" : "border-border-seam text-muted-foreground",
            )}
          >
            <Icon name={verdict === "stale" ? "AlertTriangle" : verdict === "fresh" ? "CircleCheck" : "CircleQuestion"} className="size-3 shrink-0" aria-hidden />
            {verdict === "stale" ? (files > 0 ? `Stale · ${files} ${files === 1 ? "file" : "files"}` : "Stale") : verdict === "fresh" ? "Files unchanged" : "Freshness not checked"}
          </button>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ProgressBar({ progress }: { progress: { done: number; total: number } }) {
  const percent = Math.round((100 * progress.done) / progress.total);
  return (
    <div className="mt-2.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
      <span>Plan</span>
      <div
        className="h-1 flex-1 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-label="Plan progress"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
      >
        <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
      </div>
      <span>
        {progress.done}/{progress.total} tasks
      </span>
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One task: header (switcher, status, freshness, progress), Overview and Activity, and the composer. */
function TaskView({
  threadId,
  state,
  detail,
  onSelect,
  onLink,
  onThread,
  onDetail,
}: {
  threadId: string;
  state: CortexThreadState;
  detail: CortexTaskDetail;
  onSelect: (taskId: number | null) => void;
  onLink: (taskId: number) => void;
  onThread: (next: CortexThreadState) => void;
  onDetail: (next: CortexTaskDetail) => void;
}) {
  const rpc = useCortexRpc();
  const [tab, setTab] = useState("overview");
  const [flash, setFlash] = useState(false);
  const pendingStatus = useRef(false);
  const { task } = detail;
  const bodySections = useBodySections(task.body);
  const listed = state.links.find(link => link.id === task.id) ?? null;
  const pinned = state.pinnedTaskId === task.id;
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  /** Applies at once, then reconciles with the server's detail; reverts on failure. Undo is a second change. */
  const changeStatus = async (to: CortexStatus, undoOf?: CortexStatus) => {
    const from = task.status;
    if (to === from || pendingStatus.current) return;
    pendingStatus.current = true;
    const before = detail;
    onDetail({ ...detail, task: { ...task, status: to } });
    try {
      onDetail(await rpc.call("setStatus", { threadId, taskId: task.id, status: to }));
      if (undoOf !== undefined) {
        toast(`#${task.id} is back to ${STATUS_LABEL[to]}`);
      } else {
        toast(`Moved #${task.id} to ${STATUS_LABEL[to]}`, {
          action: { label: "Undo", onClick: () => void changeStatusRef.current(from, to) },
        });
      }
    } catch (cause) {
      onDetail(before);
      toast.error(`Could not move #${task.id}: ${errorText(cause)}`);
    } finally {
      pendingStatus.current = false;
    }
  };
  const changeStatusRef = useRef(changeStatus);
  changeStatusRef.current = changeStatus;

  const threadWrite = async (call: () => Promise<CortexThreadState>, done?: string) => {
    try {
      onThread(await call());
      if (done) toast(done);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };
  const togglePin = () =>
    threadWrite(
      () => rpc.call("pin", { threadId, taskId: pinned ? null : task.id }),
      pinned ? "Focus follows the most active task again" : `#${task.id} is now this thread's focus`,
    );
  const toggleMemory = async () => {
    const excluded = !task.memoryExcluded;
    try {
      onDetail(await rpc.call("setMemoryExcluded", { threadId, taskId: task.id, excluded }));
      toast(
        excluded
          ? `#${task.id} is out of automatic memory in every thread; reading it by id still works`
          : `#${task.id} is back in automatic memory in every thread`,
      );
    } catch (cause) {
      toast.error(`Could not change memory for #${task.id}: ${errorText(cause)}`);
    }
  };
  const post = async ({ text, status }: { text: string; status: CortexStatus | null }) => {
    if (text.trim() === "") {
      if (status !== null) await changeStatus(status);
      return;
    }
    onDetail(
      await rpc.call("postNote", { threadId, taskId: task.id, text, ...(status === null ? {} : { status }) }),
    );
    toast("Note posted");
  };

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <header className="shrink-0 border-b border-border px-4 pt-3">
        <div className="flex items-center gap-2">
          <SwitcherMenu state={state} selected={task.id} onSelect={id => onSelect(id)} onLink={onLink} />
          <span className="flex-1" />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
          <button
            type="button"
            aria-pressed={pinned}
            aria-label={pinned ? "Pinned as this thread's focus. Unpin" : "Pin as focus"}
            onClick={() => void togglePin()}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-md hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              pinned ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon name="Pin" className="size-4" aria-hidden />
          </button>
              </TooltipTrigger>
              <TooltipContent>{pinned ? "Pinned as this thread's focus. Unpin" : "Pin as focus"}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <MoreMenu
            taskId={task.id}
            body={task.body}
            pinned={pinned}
            listed={listed}
            memoryExcluded={task.memoryExcluded}
            onPin={() => void togglePin()}
            onToggleMemory={() => void toggleMemory()}
            onLink={() => onLink(task.id)}
            onUnlink={() =>
              void threadWrite(async () => {
                const next = await rpc.call("unlink", { threadId, taskId: task.id });
                onSelect(null);
                return next;
              }, `Unlinked #${task.id} from this thread`)
            }
          />
        </div>
        <h2 data-content title={task.title} className="mt-2 line-clamp-2 break-words text-[15px] leading-snug font-semibold text-foreground [overflow-wrap:anywhere]">
          {task.title}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-muted-foreground">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{task.lane}</span>
          <span aria-hidden>·</span>
          <span>Updated {relativeTime(task.updated)} · {plural(detail.updates.length, "update")}</span>
          {task.memoryExcluded ? (
            <>
              <span aria-hidden>·</span>
              <span>excluded from memory</span>
            </>
          ) : null}
          {task.tags.map(tag => (
            <Badge key={tag} variant="secondary" className="max-w-full break-words rounded-full px-1.5 py-px text-[11px] font-normal [overflow-wrap:anywhere]">
              #{tag}
            </Badge>
          ))}
        </div>
        <StatusTrack status={task.status} canWrite={state.canWrite} onChoose={to => void changeStatus(to)} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {state.canWrite ? <NextStepButton status={task.status} onChoose={to => void changeStatus(to)} /> : null}
          <span className="flex-1" />
          <FreshnessPill
            detail={detail}
            onClick={() => {
              setTab("overview");
              setFlash(true);
            }}
          />
        </div>
        {state.canWrite ? null : (
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">Update cortex to change status from bb.</p>
        )}
        {detail.progress ? <ProgressBar progress={detail.progress} /> : null}
        <div className="mt-2 flex min-w-0 items-center gap-1 overflow-x-auto">
        <TabsList className="h-auto shrink-0 justify-start gap-0.5 rounded-none bg-transparent p-0">
          {[
            ["overview", "Overview"],
            ["activity", "Activity"],
          ].map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value as string}
              className="-mb-px rounded-none border-b-2 border-transparent bg-transparent px-2.5 py-2 text-[12.5px] font-normal text-muted-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              {label}
              {value === "activity" ? (
                <Badge variant="secondary" className="ml-1 h-[18px] rounded-full px-1.5 text-[11px]">
                  {detail.updates.length}
                </Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        {tab === "overview" && bodySections.hasHeadings ? (
          <Button variant="ghost" size="sm" className="ml-auto h-7 shrink-0 px-2 text-[11.5px]" onClick={bodySections.toggleAll}>
            {bodySections.allOpen ? "Collapse all" : "Expand all"}
          </Button>
        ) : null}
        </div>
      </header>
      <TabsContent value="overview" className="mt-0 min-w-0 px-4 pt-3.5 pb-4">
        <UnfoldedUpdates count={detail.sync.notFolded} onShow={() => setTab("activity")} />
        <FreshnessCallout detail={detail} flash={flash} onShowActivity={() => setTab("activity")} />
        <BodySections state={bodySections} />
        <BriefBridge threadId={threadId} />
      </TabsContent>
      <TabsContent value="activity" className="mt-0 min-w-0 px-4 pt-3.5 pb-4">
        <ActivityTimeline detail={detail} />
      </TabsContent>
      </div>
      {state.canWrite ? <Composer onPost={post} /> : null}
    </Tabs>
  );
}

function RecentRow({ row, onLink }: { row: CortexTaskRow; onLink: (taskId: number) => void }) {
  return (
    <li className="flex items-center gap-2 border-t border-border px-1 py-1.5 text-[12.5px]">
      <TaskRowLabel row={row} />
      <Button variant="outline" size="sm" className="h-[26px] gap-1 px-2" onClick={() => onLink(row.id)}>
        <Icon name="Link" className="size-3.5" aria-hidden />
        Link
      </Button>
    </li>
  );
}

/** No task yet: how tasks appear here, a search to link one, and the lane's recent tasks. */
function EmptyPanel({ threadId, onLink }: { threadId: string; onLink: (taskId: number) => void }) {
  const rpc = useCortexRpc();
  const [query, setQuery] = useState("");
  const { results, error } = useTaskSearch(query);
  const [recent, setRecent] = useState<{ lane: string | null; tasks: CortexTaskRow[] } | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("recentTasks", { threadId }).then(
      out => {
        if (live) setRecent(out);
      },
      () => {
        if (live) setRecent({ lane: null, tasks: [] });
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId]);
  const rows = query.trim() === "" ? (recent?.tasks ?? []) : (results ?? []);
  return (
    <div className="mx-auto h-full max-w-md overflow-y-auto px-5 py-8">
      <EmptyState
        icon="Brain"
        message="No Cortex task on this thread yet. A task appears here on its own when this thread posts an update to it. You can also link one now."
        className="items-start"
        messageClassName="text-[12.5px]"
      />
      <div className="mt-4">
        <TaskSearchField value={query} onChange={setQuery} />
      </div>
      {error !== null ? <p className="mt-2 text-xs text-destructive-text">{error}</p> : null}
      <p className="mt-4 mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {query.trim() !== "" ? "Matching tasks" : recent?.lane ? `Recent in ${recent.lane}` : "Recent tasks"}
      </p>
      {query.trim() !== "" && results !== null && results.length === 0 ? (
        <p className="text-xs text-muted-foreground">No matching tasks.</p>
      ) : null}
      <ul>
        {rows.map(row => (
          <RecentRow key={row.id} row={row} onLink={onLink} />
        ))}
      </ul>
    </div>
  );
}

/** The Cortex tab: the thread's tasks, one task's status, body and activity. Never edits a body or title. */
export function CortexPanel(props: ExperimentalThreadActionTabProps) {
  return (
    <div data-cortex className="@container/cortex-task h-full min-h-0 min-w-0">
      <div className="h-full min-h-0 min-w-0 pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11 max-[480px]:[&_button]:min-h-11 max-[480px]:[&_button]:min-w-11">
        <TaskPanel {...props} />
      </div>
    </div>
  );
}

function TaskPanel({ threadId, params }: ExperimentalThreadActionTabProps) {
  const thread = useThreadState(threadId);
  const requested = panelTaskId(params);
  const chosen = useSelectedTask(threadId);
  const selected = chosen ?? requested ?? thread.state?.focusTaskId ?? null;
  const task = useTaskDetail(threadId, selected);
  const link = async (taskId: number) => {
    try {
      thread.accept(await thread.rpc.call("link", { threadId, taskId }));
      selectTask(threadId, taskId);
      toast(`Linked #${taskId} to this thread`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  const { state } = thread;
  let content: ReactNode;
  if (thread.error !== null) {
    content = <ErrorNotice message={thread.error} onRetry={thread.refetch} />;
  } else if (state === null) {
    content = null;
  } else if (state.health.kind === "error") {
    content = <ErrorNotice message={state.health.message ?? "Cortex failed"} onRetry={thread.refetch} />;
  } else if (selected === null) {
    return <EmptyPanel threadId={threadId} onLink={id => void link(id)} />;
  } else if (task.error !== null) {
    content = <ErrorNotice message={task.error} onRetry={task.refetch} />;
  } else if (task.detail !== null) {
    return (
      <TaskView
        key={`${threadId}:${task.detail.task.id}`}
        threadId={threadId}
        state={state}
        detail={task.detail}
        onSelect={id => selectTask(threadId, id)}
        onLink={id => void link(id)}
        onThread={thread.accept}
        onDetail={task.apply}
      />
    );
  }
  if (content === null || content === undefined) return <LoadingSkeleton />;
  return <div className="p-4">{content}</div>;
}
