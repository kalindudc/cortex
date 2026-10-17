import { type ReactNode, useEffect, useRef, useState } from "react";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { CortexStatus } from "../detail";
import type { CortexTaskDetail, CortexTaskRow, CortexThreadState } from "../state";
import { ActivityTimeline, Composer } from "./activity";
import { errorText, panelTaskId, useCortexRpc, useTaskDetail, useThreadState } from "./hooks";
import { MoreMenu, SwitcherMenu, TaskRowLabel, TaskSearchField, useTaskSearch } from "./menus";
import { BodySections, FreshnessCallout } from "./overview";
import { NextStepButton, STATUS_LABEL, StatusPill } from "./status";
import { relativeTime } from "./time";

const FLASH_MS = 900;

export function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-[12.5px] text-destructive-text"
    >
      <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />
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
  const base = "inline-flex h-[22px] items-center gap-1 rounded-full border px-2 text-[11.5px]";
  if (verdict === "stale") {
    return (
      <button type="button" onClick={onClick} className={cn(base, "border-warning/45 bg-warning/10 text-warning-text")}>
        <Icon name="AlertTriangle" className="size-3" aria-hidden />
        {files > 0 ? `Stale · ${files} ${files === 1 ? "file" : "files"}` : "Stale"}
      </button>
    );
  }
  if (verdict === "fresh") {
    return (
      <button type="button" onClick={onClick} className={cn(base, "border-success/35 text-success")}>
        <Icon name="CircleCheck" className="size-3" aria-hidden />
        Fresh
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Freshness not checked${reason ? `: ${reason}` : ""}`}
      className={cn(base, "border-border text-muted-foreground")}
    >
      <Icon name="CircleQuestion" className="size-3" aria-hidden />
      Not checked
    </button>
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
    <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border px-4 pt-3">
        <div className="flex items-center gap-2">
          <SwitcherMenu state={state} selected={task.id} onSelect={id => onSelect(id)} onLink={onLink} />
          <span className="flex-1" />
          <button
            type="button"
            aria-pressed={pinned}
            aria-label={pinned ? "Pinned as this thread's focus. Unpin" : "Pin as focus"}
            onClick={() => void togglePin()}
            className={cn(
              "grid size-[26px] place-items-center rounded-md hover:bg-state-hover",
              pinned ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon name="Pin" className="size-4" aria-hidden />
          </button>
          <MoreMenu
            taskId={task.id}
            pinned={pinned}
            listed={listed}
            onPin={() => void togglePin()}
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
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className="font-mono">#{task.id}</span>
          <span aria-hidden>·</span>
          <span>{task.lane}</span>
          {task.tags.map(tag => (
            <Badge key={tag} variant="secondary" className="rounded-full px-1.5 py-px text-[11px] font-normal">
              #{tag}
            </Badge>
          ))}
        </div>
        <h2 title={task.title} className="mt-1.5 line-clamp-2 text-[15px] leading-snug font-semibold text-foreground">
          {task.title}
        </h2>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <StatusPill status={task.status} canWrite={state.canWrite} onChoose={to => void changeStatus(to)} />
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
        <p className="mt-2 text-[11.5px] text-muted-foreground">
          Updated {relativeTime(task.updated)} · {plural(detail.updates.length, "update")}
          {detail.sync.notFolded > 0 ? ` · ${detail.sync.notFolded} not yet in the body` : ""}
        </p>
        <TabsList className="mt-1.5 h-auto justify-start gap-0.5 rounded-none bg-transparent p-0">
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
      </header>
      <TabsContent value="overview" className="mt-0 min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-4">
        <FreshnessCallout detail={detail} flash={flash} onShowActivity={() => setTab("activity")} />
        <BodySections body={task.body} />
      </TabsContent>
      <TabsContent value="activity" className="mt-0 flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-4">
          <ActivityTimeline detail={detail} />
        </div>
        {state.canWrite ? <Composer onPost={post} /> : null}
      </TabsContent>
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
    <div className="mx-auto max-w-md px-5 py-8">
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
      <p className="mt-4 mb-1.5 text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">
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
export function CortexPanel({ threadId, params }: PluginThreadPanelProps) {
  const thread = useThreadState(threadId);
  const requested = panelTaskId(params);
  const [chosen, setChosen] = useState<number | null>(null);
  const selected = chosen ?? requested ?? thread.state?.focusTaskId ?? null;
  const task = useTaskDetail(threadId, selected);
  const link = async (taskId: number) => {
    try {
      thread.accept(await thread.rpc.call("link", { threadId, taskId }));
      setChosen(taskId);
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
        threadId={threadId}
        state={state}
        detail={task.detail}
        onSelect={setChosen}
        onLink={id => void link(id)}
        onThread={thread.accept}
        onDetail={task.apply}
      />
    );
  }
  if (content === null || content === undefined) return <LoadingSkeleton />;
  return <div className="p-4">{content}</div>;
}
