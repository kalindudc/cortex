import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { experimental_useAppPanel, useRealtime, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { CortexStatus, CortexTaskDetail } from "../state";
import { openTaskTab } from "../ui/panel-tabs";
import { errorText, parseTaskId, useCortexRpc } from "./hooks";
import { STATUS_LABEL, StatusDot, StatusPill } from "./status";
import { absoluteTime, relativeTime } from "./time";

const ROW_LIMIT = 12;
const ACTOR_CHARS = 20;
const CARD_BUTTON = "h-7 rounded-[var(--radius)] border-border-seam px-2.5 pointer-coarse:min-h-11 max-[480px]:min-h-11";
const KINDS = {
  research: { label: "Research", glyph: "Search" },
  note: { label: "Note", glyph: "FileText" },
  plan: { label: "Plan", glyph: "ListTodo" },
  decision: { label: "Decision", glyph: "Target" },
} as const;
const KIND_TAGS = Object.keys(KINDS) as (keyof typeof KINDS)[];
const GROUPS = ["Saved", "Revised", "Curated"] as const;
type Group = (typeof GROUPS)[number];
type Receipt = { group: Group; action: string; author: string | null; at: number | null; reason?: string | null };
type Entry = { detail: CortexTaskDetail } | { error: string; missing: boolean };

function kindOf(tags: string[]) {
  const tag = KIND_TAGS.find(kind => tags.includes(kind));
  return tag === undefined ? { label: "Task", glyph: "File" } : KINDS[tag];
}

function who(detail: CortexTaskDetail, author: string | null, threadId: string): string | null {
  if (author === null) return null;
  if (author === `bb-${threadId}`) return "this thread";
  return detail.authors[author]?.label ?? author;
}

function receiptOf(detail: CortexTaskDetail, documentOnly = false): Receipt {
  const { task, updates } = detail;
  const exclusion = task.memoryExclusion;
  const createdExcluded = documentOnly && exclusion?.excluded_at === task.created &&
    updates.some(update => update.kind === "created" && update.author === exclusion?.excluded_by);
  if (task.memoryExcluded && !createdExcluded) {
    return {
      group: "Curated", action: "Excluded from memory", author: exclusion?.excluded_by ?? null,
      at: exclusion?.excluded_at ?? null, reason: exclusion?.reason,
    };
  }
  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i]!;
    const base = { author: update.author, at: update.created };
    if (update.revision) return { ...base, group: "Revised", action: "Revised" };
    if (update.kind === "created") return { ...base, group: "Saved", action: "Saved" };
    if (update.summary.startsWith("Included in memory again: ")) {
      return { ...base, group: "Curated", action: "Included in memory again" };
    }
    if (documentOnly) continue;
    if (update.kind === "status" && update.to === task.status) {
      return { ...base, group: "Saved", action: task.status === "done" ? "Marked done" : `Marked ${STATUS_LABEL[task.status].toLowerCase()}` };
    }
    if (update.kind === "note") return { ...base, group: "Saved", action: "Updated" };
  }
  return { group: "Saved", action: "Saved", author: null, at: task.created };
}

function MemoryCell({ excluded }: { excluded: boolean | null }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0", excluded === false
    ? "bg-foreground" : "border border-dashed border-muted-foreground", excluded === null && "opacity-40")} />;
}

/** One subscription for the card. A late read cannot replace a newer read or the result of an action. */
function useCardTasks(threadId: string, ids: number[]) {
  const rpc = useCortexRpc();
  const latest = useRef(new Map<number, object>());
  const [entries, setEntries] = useState(new Map<number, Entry>());
  const accept = useCallback((id: number, entry: Entry) => {
    setEntries(old => new Map(old).set(id, entry));
  }, []);
  const read = useCallback((id: number) => {
    const token = {};
    latest.current.set(id, token);
    rpc.call("task", { threadId, taskId: id }).then(
      detail => { if (latest.current.get(id) === token) accept(id, { detail }); },
      cause => {
        if (latest.current.get(id) !== token) return;
        const error = errorText(cause);
        accept(id, { error, missing: error.includes(`task ${id} not found`) });
      },
    );
  }, [rpc, threadId, accept]);
  const readAll = useCallback(() => ids.forEach(read), [ids, read]);
  useEffect(() => {
    readAll();
    const pending = latest.current;
    return () => pending.clear();
  }, [readAll]);
  useRealtime("task", payload => {
    const value = typeof payload === "object" && payload !== null && "taskId" in payload ? payload.taskId : null;
    const id = parseTaskId(value);
    if (id !== null && ids.includes(id)) read(id);
  });
  useRealtime("all", readAll);
  return { rpc, entries, read, apply: (id: number, detail: CortexTaskDetail) => {
    latest.current.delete(id);
    accept(id, { detail });
  } };
}

function TaskReadState({ id, entry, retry }: { id: number; entry?: Entry; retry: () => void }) {
  if (entry === undefined) return <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading task #{id}…</p>;
  if (!("error" in entry)) return null;
  if (entry.missing) return <p className="px-3 py-2 text-sm">Task #{id} no longer exists.</p>;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <p role="alert" className="min-w-0 break-words text-xs text-foreground">Could not load task #{id}: {entry.error}</p>
      <Button variant="outline" size="sm" className={CARD_BUTTON} onClick={retry}>Retry</Button>
    </div>
  );
}

/** The host renders a task or a bounded list only in an assistant message directive. */
export function CortexCard({ attributes, message }: PluginMessageDirectiveProps) {
  const many = attributes.ids !== undefined;
  const parsed = useMemo(() => {
    const raw = attributes.ids === undefined ? [attributes.id] : attributes.ids.split(",");
    const ids = raw.map(parseTaskId);
    if (ids.some(id => id === null)) return null;
    return [...new Set(ids as number[])];
  }, [attributes.id, attributes.ids]);
  if (parsed === null || (many && attributes.id !== undefined)) {
    return (
      <div data-cortex role="alert" className="my-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm">
        {many ? 'Cortex card: use a comma-separated list of task numbers, as in ::cortex{ids="42,43"}.' :
          'Cortex card: the id must be a task number, as in ::cortex{id="529"}.'}
      </div>
    );
  }
  const key = `${message.threadId}:${many}:${parsed.join(",")}`;
  return <TaskCards key={key} threadId={message.threadId} ids={parsed} many={many} />;
}

function TaskCards({ threadId, ids, many }: { threadId: string; ids: number[]; many: boolean }) {
  const panel = experimental_useAppPanel();
  const visible = useMemo(() => ids.slice(0, ROW_LIMIT), [ids]);
  const { rpc, entries, read, apply } = useCardTasks(threadId, visible);
  const busy = useRef(new Set<number>());
  const [pending, setPending] = useState(new Set<number>());
  const [failure, setFailure] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const open = (id: number) => setDeclined(!openTaskTab(panel, threadId, id));
  async function write(id: number, run: () => Promise<CortexTaskDetail>) {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    setPending(new Set(busy.current));
    setFailure(null);
    try { apply(id, await run()); }
    catch (cause) { setFailure(`Could not change task #${id}: ${errorText(cause)}`); }
    finally { busy.current.delete(id); setPending(new Set(busy.current)); }
  }
  const exclude = (taskId: number, excluded: boolean) =>
    void write(taskId, () => rpc.call("setMemoryExcluded", { threadId, taskId, excluded }));
  const status = (taskId: number, status: CortexStatus) =>
    void write(taskId, () => rpc.call("setStatus", { threadId, taskId, status }));
  const feedback = <>
    {declined ? <p role="status" className="px-3 pb-2 text-xs">bb could not open the Cortex tab here; open this thread to see the task.</p> : null}
    {failure ? <p role="alert" className="break-words px-3 pb-2 text-xs">{failure}</p> : null}
  </>;
  if (many) {
    const groups: Record<Group | "Other", { detail: CortexTaskDetail; receipt: Receipt }[]> = {
      Saved: [], Revised: [], Curated: [], Other: [],
    };
    const states: (boolean | null)[] = [];
    const unfinished: number[] = [];
    for (const id of visible) {
      const entry = entries.get(id);
      if (!entry || !("detail" in entry)) { unfinished.push(id); continue; }
      const { detail } = entry;
      const receipt = receiptOf(detail, true);
      groups[receipt.author === `bb-${threadId}` ? receipt.group : "Other"].push({ detail, receipt });
      states.push(detail.task.memoryExcluded);
    }
    const included = states.filter(state => state === false).length;
    const excluded = states.filter(state => state === true).length;
    return (
      <Card data-cortex role="region" aria-label={`${ids.length} Cortex tasks`} className="my-2 min-w-0 rounded-[var(--radius)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-border-seam px-3 py-2 text-xs text-muted-foreground">
          <span aria-hidden className="inline-flex gap-0.5">{states.map((state, i) => <MemoryCell key={i} excluded={state} />)}</span>
          <span><b className="text-foreground">{ids.length} tasks</b> · {included} in memory · {excluded} not</span>
        </div>
        {[...GROUPS, "Other" as const].filter(group => groups[group].length > 0).map(group => {
          const list = <ul key={group}>{groups[group].map(({ detail, receipt }) => {
              const { task } = detail;
              const author = who(detail, receipt.author, threadId);
              const chars = author ? [...author] : [];
              const actor = chars.length > ACTOR_CHARS ? `${chars.slice(0, ACTOR_CHARS - 1).join("")}…` : author;
              return (
                <li key={task.id} className="grid min-h-[34px] grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-0.5 text-xs hover:bg-state-hover max-[480px]:grid-cols-[auto_auto_auto_minmax(0,1fr)]">
                  <MemoryCell excluded={task.memoryExcluded} />
                  <span title={STATUS_LABEL[task.status]} className="inline-flex">
                    <StatusDot status={task.status} />
                    <span className="sr-only">{STATUS_LABEL[task.status]}</span>
                  </span>
                  <span className="text-muted-foreground">#{task.id}</span>
                  <div className="flex min-w-0 items-baseline justify-between gap-x-2">
                    <span className="min-w-0 flex-1 truncate text-foreground" title={task.title}>{task.title}</span>
                    <span className="max-w-[40%] truncate text-muted-foreground" title={author ?? undefined}>
                      {task.memoryExcluded ? "Excluded" : kindOf(task.tags).label}{actor ? ` · ${actor}` : ""}
                    </span>
                  </div>
                  <div className="flex items-center justify-end gap-1.5 max-[480px]:col-span-full">
                    {task.memoryExcluded !== null ? <Button size="sm" variant="outline" disabled={pending.has(task.id)} className={cn(CARD_BUTTON, task.memoryExcluded && "border-attention")}
                      aria-label={`${task.memoryExcluded ? "Include" : "Exclude"} task ${task.id} ${task.memoryExcluded ? "in" : "from"} memory`}
                      onClick={() => exclude(task.id, !task.memoryExcluded)}>{task.memoryExcluded ? "Include" : "Exclude"}</Button> : null}
                    <Button size="sm" variant="outline" aria-label={`Open task ${task.id}`} onClick={() => open(task.id)} className={cn(CARD_BUTTON, "w-7 px-0 pointer-coarse:min-w-11 max-[480px]:min-w-11")}>
                      <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                </li>
              );
            })}</ul>;
          if (group === "Other") return list;
          return <section key={group} aria-label={group}>
            <h3 className="px-3 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group} · {groups[group].length}</h3>
            {list}
          </section>;
        })}
        {unfinished.map(id => <TaskReadState key={id} id={id} entry={entries.get(id)} retry={() => read(id)} />)}
        {ids.length > ROW_LIMIT ? <p className="px-3 py-2 text-xs text-muted-foreground">{ids.length - ROW_LIMIT} more</p> : null}
        {feedback}
      </Card>
    );
  }
  const id = visible[0]!;
  const entry = entries.get(id);
  if (!entry || !("detail" in entry)) {
    return <Card data-cortex className="my-2 rounded-[var(--radius)]"><TaskReadState id={id} entry={entry} retry={() => read(id)} /></Card>;
  }
  const detail = entry.detail;
  const { task } = detail;
  const receipt = receiptOf(detail);
  const author = who(detail, receipt.author, threadId);
  const kind = kindOf(task.tags);
  const disabled = pending.has(id);
  const attention = receipt.group === "Curated" || task.status === "done";
  let latestNote: CortexTaskDetail["updates"][number] | undefined;
  for (let i = detail.updates.length - 1; i >= 0; i--) {
    const update = detail.updates[i]!;
    if (update.kind === "note" && !/^(Included in memory again|Excluded from memory): /.test(update.summary)) {
      latestNote = update;
      break;
    }
  }
  const reopen = task.status === "done" && detail.canWrite !== false;
  return (
    <Card data-cortex role="region" aria-label={`Cortex task ${id}`} className="my-2 min-w-0 rounded-[var(--radius)] text-sm">
      <div className={cn("flex min-h-[41px] flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-seam px-3 py-1.5 text-xs text-muted-foreground", attention && "bg-surface-attention")}>
        <Icon name={attention ? "cortex/curate" : "cortex/note"} className={cn("size-3.5 shrink-0", attention ? "text-attention" : "text-file-accent")} aria-hidden />
        <span className="min-w-0 flex-1 break-words">
          <b className="font-semibold text-foreground">{receipt.action}</b>{author ? <span> · by {author}</span> : null}
          {receipt.at !== null ? <> · <time dateTime={new Date(receipt.at).toISOString()} title={absoluteTime(receipt.at)}>{relativeTime(receipt.at)}</time></> : null}
        </span>
        {task.memoryExcluded ? <Button size="sm" variant="outline" disabled={disabled} className={cn(CARD_BUTTON, "border-attention")} onClick={() => exclude(id, false)}>Include in memory again</Button>
          : reopen ? <Button size="sm" variant="outline" disabled={disabled} className={cn(CARD_BUTTON, "border-attention")} onClick={() => status(id, "open")}>Reopen</Button> : null}
      </div>
      {receipt.reason ? <p data-content className="break-words px-3 pt-1.5 text-xs"><q>{receipt.reason}</q></p> : null}
      <div className="grid min-w-0 gap-1 px-3 pt-2 pb-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot status={task.status} className="size-[9px]" />
          <span className="shrink-0 text-muted-foreground">#{task.id}</span>
          <h3 data-content title={task.title} className={cn("min-w-0 truncate font-semibold", task.status === "done" ? "text-muted-foreground" : "text-foreground")}>{task.title}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><Icon name={kind.glyph} className="size-3.5" aria-hidden />{kind.label}</span>
          <span className="font-medium text-foreground">{STATUS_LABEL[task.status]}</span>
          <span className="inline-flex items-center gap-1.5"><MemoryCell excluded={task.memoryExcluded} />{task.memoryExcluded === null ? "Memory unknown" : task.memoryExcluded ? "Not in memory" : "In memory"}</span>
          <span className="min-w-0 break-words">{task.lane}{task.tags.filter(tag => !KIND_TAGS.some(kind => kind === tag)).map(tag => ` · #${tag}`)}</span>
        </div>
        {!task.memoryExcluded && latestNote ? <p data-content className="truncate text-xs text-muted-foreground" title={latestNote.summary}><b className="text-foreground">{who(detail, latestNote.author, threadId)}</b> {latestNote.summary}</p> : null}
        <div className="mt-1 flex flex-wrap justify-end gap-1.5">
          {task.memoryExcluded === false ? <Button type="button" size="sm" variant="outline" disabled={disabled} className={CARD_BUTTON} onClick={() => exclude(id, true)}>Exclude from memory</Button> : null}
          {reopen && task.memoryExcluded ? <Button type="button" size="sm" variant="outline" disabled={disabled} className={CARD_BUTTON} onClick={() => status(id, "open")}>Reopen</Button> : null}
          {task.status !== "done" && detail.canWrite !== false ? <StatusPill action status={task.status} canWrite disabled={disabled} onChoose={next => status(id, next)} /> : null}
          <Button type="button" size="sm" variant="outline" onClick={() => open(id)} className={CARD_BUTTON}>
            <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />Open task
          </Button>
        </div>
      </div>
      {feedback}
    </Card>
  );
}
