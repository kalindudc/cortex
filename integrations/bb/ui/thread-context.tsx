import { isFlag, isPageCount, oneOf, usePlaceState } from "./place";
import { type ReactNode, useState } from "react";
import {
  experimental_copyToClipboard,
  experimental_Diff as Diff,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useSidebarThreads,
  useBbNavigate,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTaskSearch } from "../panel/menus";
import {
  bindingWord,
  facetWord,
  BRIEF_KIND_LOOK,
  dimensionWord,
  ORIGIN_WORD,
  plural,
  ROUTE_WORD,
  STATUS_LOOK,
  tokens,
  VISIBILITY_WORD,
} from "./copy";
import {
  type RpcFailure,
  useDeliveryReceipts,
  useKnowledgeSearch,
  useKnowledgeEntries,
  useThreadContext,
  useWorkstreams,
  useWorkstreamWrites,
} from "./data";
import { BindingDialog, ChangeForThreadDialog, EditKnowledgeDialog, PrepareDraftDialog } from "./dialogs";
import { activeGrants, changedLineCount, dismissedFor, shortTime, unifiedPatch, type Visibility, visibilityOf } from "./model";
import { Applicability, CORTEX_TAB_LIST, CORTEX_TAB_TRIGGER, EmptyNote, FailureNotice, Heading, Hint, IconButton, LoadingRows, PagedFooter, StateMark, TONE_TEXT } from "./parts";
import { BriefStrip } from "./brief-strip";
import { heldReason, ReasonChip } from "./marks";
import type { ContextEntry, DeliveryReceipt, Knowledge, ThreadContext } from "./types";
import "./thread-context.css";

export const CORTEX_PAGE_PATH = "cortex";

export function useSectionName(threadId: string): string | null {
  const { threads, sections } = experimental_useSidebarThreads();
  const sectionId = threads.find(thread => thread.id === threadId)?.sectionId ?? null;
  return sections.find(section => section.id === sectionId)?.name ?? null;
}

export function useDefaultShown(): boolean {
  const { values } = useSettings();
  return values?.contextWidget !== "hidden";
}

export function visibilityDetail(context: Pick<ThreadContext, "dismissed" | "dismissedPreference">, defaultShown: boolean): string {
  if (context.dismissedPreference === true) return "Hidden for this thread";
  if (context.dismissedPreference === false) return "Shown";
  return defaultShown ? "Shown (setting)" : "Hidden (setting)";
}

/** Above the composer: shown, hidden for this thread, or the global setting. Restores a dismissed widget. */
export function VisibilityControl({ context }: { context: ThreadContext }) {
  const writes = useWorkstreamWrites();
  const defaultShown = useDefaultShown();
  const current = visibilityOf(context.dismissedPreference);
  const choose = async (choice: Visibility) => {
    try {
      await writes.setDismissed(context.threadId, dismissedFor(choice));
      toast(choice === "hidden" ? "Hidden above the composer for this thread" : choice === "shown" ? "Shown above the composer" : "Follows the setting again");
    } catch (cause) {
      toast.error((cause as RpcFailure).message);
    }
  };
  const options: Array<[Visibility, string]> = [
    ["shown", VISIBILITY_WORD.shown],
    ["hidden", VISIBILITY_WORD.hidden],
    ["follow", VISIBILITY_WORD.follow(defaultShown)],
  ];
  const detail = visibilityDetail(context, defaultShown);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button type="button" role="switch" aria-checked={!context.dismissed} aria-label="Above composer" onClick={() => void choose(context.dismissed ? "shown" : "hidden")} className="flex items-center gap-1.5 rounded-sm text-[11.5px] text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <span aria-hidden className={cn("inline-flex h-4 w-7 items-center rounded-sm border border-border-seam p-0.5", context.dismissed ? "bg-surface-recessed" : "bg-primary")}>
          <span className={cn("size-2.5 rounded-sm bg-primary-foreground", !context.dismissed && "ml-auto")} />
        </span>
        Above composer
      </button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label={`Above the composer: ${detail}. Change`}>
          <Icon name="ChevronDown" className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent data-cortex align="start" mobileTitle="Above the composer" className="w-72">
        {options.map(([choice, label]) => (
          <DropdownMenuItem key={choice} onSelect={() => void choose(choice)} aria-checked={choice === current}>
            <span className="flex-1">{label}</span>
            {choice === current ? <Icon name="Check" className="size-3.5 text-primary" aria-label="current" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-muted-foreground">Hiding changes only what you see. Threads still get their context.</p>
      </DropdownMenuContent>
    </DropdownMenu>
    </div>
  );
}

function Scope({ context, sectionName, onConnect }: { context: ThreadContext; sectionName: string | null; onConnect: () => void }) {
  const topic = context.binding?.topic ?? null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name="Brain" className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 break-words text-[13px] font-semibold text-foreground">{context.workstream?.name ?? "No workstream"}</span>
        <span className="text-[12.5px] text-muted-foreground">· {topic ? facetWord(topic) : "Shared basics"}</span>
        <span className="flex-1" />
        <span className="text-[11.5px] text-muted-foreground">{bindingWord(context, sectionName)}</span>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={onConnect}>
          Change…
        </Button>
      </div>
      <div className="cortex-context-targets flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
        <span>Targets</span>
        <Applicability value={context.applicability} />
      </div>
    </div>
  );
}

function EntryMenu({
  context,
  entry,
  onChange,
  onEdit,
}: {
  context: ThreadContext;
  entry: ContextEntry;
  onChange?: () => void;
  onEdit: () => void;
}) {
  const writes = useWorkstreamWrites();
  const navigate = useBbNavigate();
  const override = async (next: { excluded: boolean; text: string | null }, done: string) => {
    try {
      await writes.setOverride({
        threadId: context.threadId,
        expectedRevision: context.revision,
        knowledgeId: entry.knowledge.id,
        canonicalRevision: entry.knowledge.revision,
        ...next,
      });
      toast(done);
    } catch (cause) {
      toast.error((cause as RpcFailure).message);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${entry.knowledge.title}`}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="MoreHorizontal" className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent data-cortex align="end" mobileTitle={entry.knowledge.title} className="w-72">
        <p className="px-2 pt-1.5 pb-1 text-[11px] font-semibold text-muted-foreground">This thread only</p>
        {onChange ? <DropdownMenuItem onSelect={onChange}>
          <Icon name="Edit" aria-hidden />
          Change for this thread…
        </DropdownMenuItem> : null}
        <DropdownMenuItem onSelect={() => void override({ excluded: true, text: null }, "Left out of this thread's next context")}>
          <Icon name="Minus" aria-hidden />
          Leave out of this thread
        </DropdownMenuItem>
        {entry.origin === "thread-only" ? (
          <DropdownMenuItem onSelect={() => void override({ excluded: false, text: null }, "This thread uses the saved text again")}>
            <Icon name="RotateCcw" aria-hidden />
            Use saved text
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <p className="px-2 pt-1 pb-1 text-[11px] font-semibold text-muted-foreground">Every thread</p>
        <DropdownMenuItem onSelect={onEdit}>
          <Icon name="EditFile" aria-hidden />
          Edit saved knowledge…
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `workstreams/${entry.knowledge.workstreamId}/${entry.knowledge.id}` })
          }
        >
          <Icon name="ArrowUpRight" aria-hidden />
          Open in Cortex
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EntryRow({ context, entry }: { context: ThreadContext; entry: ContextEntry }) {
  const [dialog, setDialog] = useState<"change" | "edit" | null>(null);
  const kind = BRIEF_KIND_LOOK[entry.knowledge.kind];
  const local = entry.origin === "thread-only";
  return (
    <li className="flex items-start gap-2 border-t border-border-seam py-2 first:border-t-0">
      <Icon name={kind.icon} className={cn("mt-0.5 size-4 shrink-0", local ? "text-attention" : "text-primary")} aria-label={kind.word} />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 break-words text-[12.5px] font-semibold text-foreground" title={entry.knowledge.title}>
          {entry.knowledge.title}
        </p>
        <p data-content className="line-clamp-2 text-[12.5px] text-foreground">
          {entry.text}
        </p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          {local ? `${ORIGIN_WORD["thread-only"]} · changed by you` : ORIGIN_WORD[entry.origin]}
          {" · "}
          {facetWord(entry.knowledge.facet)}
          {" · "}
          <span className="tabular-nums">{tokens(entry.estimatedTokens)} tokens</span>
          {" · "}{plural(entry.knowledge.sources.length, "source")}
        </p>
      </div>
      <EntryMenu context={context} entry={entry} onChange={() => setDialog("change")} onEdit={() => setDialog("edit")} />
      <ChangeForThreadDialog context={context} entry={entry} open={dialog === "change"} onOpenChange={open => setDialog(open ? "change" : null)} />
      <EditKnowledgeDialog entry={entry.knowledge} workstream={context.workstream} open={dialog === "edit"} onOpenChange={open => setDialog(open ? "edit" : null)} />
    </li>
  );
}

function NoticeRow({ context, notice, knowledge }: { context: ThreadContext; notice: ThreadContext["notices"][number]; knowledge?: Knowledge }) {
  const [dialog, setDialog] = useState<"edit" | null>(null);
  const local = context.overrides.find(row => row.knowledgeId === notice.id);
  const entry: ContextEntry | null = knowledge ? {
    knowledge, text: local?.text ?? knowledge.text, origin: local?.text ? "thread-only" : "canonical", overrideActor: local?.actor ?? null, estimatedTokens: notice.estimatedTokens,
  } : null;
  return (
    <li className="flex items-start gap-2 border-t border-border-seam py-2 first:border-t-0">
      <Icon name="EyeOff" className="mt-0.5 size-4 shrink-0 text-warning-text" aria-label="Notice" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 break-words text-[12.5px] font-medium text-foreground" title={knowledge?.title ?? notice.id}>{knowledge?.title ?? "Saved knowledge"}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span>Notice only</span>
          <ReasonChip reason={heldReason(notice, { entry: knowledge, applicability: context.applicability })} />
          <span className="tabular-nums">{tokens(notice.estimatedTokens)} tokens</span>
          <span>{plural(notice.sources.length, "source")}</span>
        </div>
      </div>
      {entry ? <>
        <EntryMenu context={context} entry={entry} onEdit={() => setDialog("edit")} />
        <EditKnowledgeDialog entry={entry.knowledge} workstream={context.workstream} open={dialog === "edit"} onOpenChange={open => setDialog(open ? "edit" : null)} />
      </> : null}
    </li>
  );
}

function ExcludedRow({ context, exclusion, knowledge }: { context: ThreadContext; exclusion: ThreadContext["exclusions"][number]; knowledge?: Knowledge }) {
  const writes = useWorkstreamWrites();
  const local = context.overrides.find(row => row.knowledgeId === exclusion.id && row.excluded);
  return (
    <li className="flex items-center gap-2 border-t border-border-seam py-1.5 first:border-t-0 text-[12.5px]">
      <Icon name="Minus" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 break-words text-foreground" title={knowledge?.title ?? exclusion.id}>{knowledge?.title ?? "Saved knowledge"}</p>
        <ReasonChip reason={heldReason(exclusion, { entry: knowledge, applicability: context.applicability })} />
      </div>
      {local ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[12px]"
          onClick={async () => {
            try {
              await writes.setOverride({
                threadId: context.threadId,
                expectedRevision: context.revision,
                knowledgeId: exclusion.id,
                canonicalRevision: local.canonicalRevision,
                excluded: false,
                text: local.text,
              });
              toast("Back in this thread's next context");
            } catch (cause) {
              toast.error((cause as RpcFailure).message);
            }
          }}
        >
          Put back
        </Button>
      ) : null}
    </li>
  );
}

/** Share approved knowledge from another workstream, or one legacy task, with this thread only. */
function ShareDialog({ context, open, onOpenChange }: { context: ThreadContext; open: boolean; onOpenChange: (open: boolean) => void }) {
  const writes = useWorkstreamWrites();
  const [mode, setMode] = useState<"knowledge" | "legacy-task">("knowledge");
  const [query, setQuery] = useState("");
  const knowledge = useKnowledgeSearch(open && mode === "knowledge" ? query : "");
  const tasks = useTaskSearch(open && mode === "legacy-task" ? query : "");
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  const share = async (kind: "knowledge" | "legacy-task", id: string, name: string) => {
    setFailure(null);
    try {
      await writes.setGrant({ threadId: context.threadId, expectedRevision: context.revision, kind, id, granted: true });
      toast(`Shared ${name} with this thread`);
      onOpenChange(false);
    } catch (cause) {
      setFailure(cause as RpcFailure);
    }
  };
  const rows =
    mode === "knowledge"
      ? (knowledge.data?.items ?? [])
          .filter(item => item.entry.state === "approved" && item.workstream.id !== context.workstream?.id)
          .map(item => ({ id: item.entry.id, title: item.entry.title, meta: item.workstream.name }))
      : (tasks.results ?? []).map(row => ({ id: String(row.id), title: row.title, meta: `#${row.id} · ${row.lane}` }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-cortex data-cortex-context className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Share with this thread</DialogTitle>
          <DialogDescription>From the next session. Revoke later; running sessions keep their text.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {(["knowledge", "legacy-task"] as const).map(option => (
            <Button key={option} variant={mode === option ? "secondary" : "ghost"} size="sm" aria-pressed={mode === option} onClick={() => setMode(option)}>
              {option === "knowledge" ? "Knowledge from another workstream" : "A task outside any workstream"}
            </Button>
          ))}
        </div>
        <Input
          aria-label={mode === "knowledge" ? "Search saved knowledge" : "Search tasks"}
          placeholder={mode === "knowledge" ? "Search approved knowledge" : "Search tasks, or #id"}
          value={query}
          onChange={event => setQuery(event.target.value)}
          className="text-[13px]"
        />
        {mode === "legacy-task" ? (
          <p className="text-[12px] text-muted-foreground">Sent as history for reference, labelled as not current guidance. It does not join the workstream.</p>
        ) : null}
        {failure ? <FailureNotice failure={failure} /> : null}
        <ul className="max-h-72 overflow-y-auto">
          {rows.map(row => (
            <li key={row.id} className="flex items-center gap-2 border-t border-border-seam py-1.5 text-[12.5px]">
              <div className="min-w-0 flex-1"><p className="break-words text-foreground">{row.title}</p>
              <p className="break-words text-[11.5px] text-muted-foreground">{row.meta}</p></div>
              <Button variant="outline" size="sm" className="h-7 px-2 text-[12px]" onClick={() => void share(mode, row.id, row.title)}>
                Share
              </Button>
            </li>
          ))}
        </ul>
        {query.trim() !== "" && rows.length === 0 && !knowledge.isLoading ? <p className="text-[12px] text-muted-foreground">Nothing matches.</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Grants({ context, knowledge, compact = false }: { context: ThreadContext; knowledge: Map<string, Knowledge>; compact?: boolean }) {
  const writes = useWorkstreamWrites();
  const [open, setOpen] = useState(false);
  const grants = activeGrants(context);
  return (
    <section aria-label="Shared with this thread">
      <Heading
        count={grants.length}
        trailing={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={() => setOpen(true)}>
            Share…
          </Button>
        }
      >
        {compact ? "Shared in" : "Shared with this thread"}
      </Heading>
      {grants.length === 0 ? <p className="text-[12px] text-muted-foreground">Nothing from outside {context.workstream?.name ?? "the workstream"}.</p> : null}
      <ul>
        {grants.map(grant => (
          <li key={`${grant.kind}-${grant.id}`} className="flex items-center gap-2 border-t border-border-seam py-1.5 first:border-t-0 text-[12.5px]">
            <Icon name={grant.kind === "knowledge" ? "Layers" : "Archive"} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 break-words text-foreground" title={grant.id}>{grant.kind === "legacy-task" ? `Task #${grant.id}` : knowledge.get(grant.id)?.title ?? "Shared knowledge"}</span>
            <span className="shrink-0 text-[11.5px] text-muted-foreground">by you · {shortTime(grant.grantedAt)}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[12px]"
              onClick={async () => {
                try {
                  await writes.setGrant({ threadId: context.threadId, expectedRevision: context.revision, kind: grant.kind, id: grant.id, granted: false });
                  toast("Revoked for future sessions. A running session keeps what it already has.");
                } catch (cause) {
                  toast.error((cause as RpcFailure).message);
                }
              }}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      <ShareDialog context={context} open={open} onOpenChange={setOpen} />
    </section>
  );
}

export function ExactText({ text, label = "Exact text" }: { text: string; label?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-semibold text-foreground">{label}</span>
        <span className="flex-1" />
        <IconButton
          label={`Copy ${label.toLowerCase()}`}
          icon="Copy"
          onClick={async () => {
            const copied = await experimental_copyToClipboard({ text });
            if (copied) toast("Copied");
            else toast.error("Could not copy to the clipboard.");
          }}
        />
      </div>
      <pre
        data-content
        tabIndex={0}
        aria-label={label}
        className="max-h-96 min-w-0 overflow-auto rounded-md border border-border-seam bg-surface-recessed px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words text-foreground"
      >
        {text}
      </pre>
    </div>
  );
}

function Fold({ label, count, children, defaultOpen = false }: { label: string; count?: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-md py-1 text-left text-[12.5px] font-semibold text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 text-muted-foreground" aria-hidden />
          {label}
          {count ? <span className="font-normal text-muted-foreground">{count}</span> : null}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function ChangesSinceLast({ context }: { context: ThreadContext }) {
  const last = context.lastReceipt;
  if (last === null) return <p className="text-[12px] text-muted-foreground">Nothing was prepared for this thread yet.</p>;
  if (last.text === context.exactText) return <p className="text-[12px] text-muted-foreground">Same as {ROUTE_WORD[last.route].toLowerCase()} {shortTime(last.emittedAt)}.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11.5px] text-muted-foreground">
        Next context compared with {ROUTE_WORD[last.route].toLowerCase()} {shortTime(last.emittedAt)}
      </p>
      <div className="overflow-hidden rounded-md border border-border-seam">
        <Diff patch={unifiedPatch(last.text, context.exactText, "thread-context.txt")} path="thread-context.txt" overflow="wrap" />
      </div>
    </div>
  );
}

export function NextContext({ context, compact = false }: { context: ThreadContext; compact?: boolean }) {
  const [shown, setShown] = useState(20);
  const going = context.entries.length + context.notices.length;
  const noticeIds = new Set(context.notices.map(notice => notice.id));
  const leftOut = context.exclusions.filter(exclusion => !noticeIds.has(exclusion.id));
  const ids = [...new Set([
    ...context.notices.slice(0, shown).map(notice => notice.id),
    ...leftOut.slice(0, shown).map(exclusion => exclusion.id),
    ...activeGrants(context).filter(grant => grant.kind === "knowledge").map(grant => grant.id),
  ])];
  const reads = useKnowledgeEntries(ids);
  const knowledge = new Map(context.entries.map(entry => [entry.knowledge.id, entry.knowledge]));
  for (const read of reads) if (read.data) knowledge.set(read.data.entry.id, read.data.entry);
  const failure = reads.find(read => read.error);
  const excluded = <>
    {leftOut.length === 0 ? <p className="text-[12px] text-muted-foreground">Nothing left out.</p> : null}
    <ul>{leftOut.slice(0, shown).map(exclusion => <ExcludedRow key={exclusion.id} context={context} exclusion={exclusion} knowledge={knowledge.get(exclusion.id)} />)}</ul>
  </>;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <section aria-label="Goes in">
        <Heading count={going}>Goes in</Heading>
        {going === 0 ? <p className="text-[12px] text-muted-foreground">Nothing approved applies to this thread yet.</p> : null}
        <ul>
          {context.entries.map(entry => <EntryRow key={entry.knowledge.id} context={context} entry={entry} />)}
          {context.notices.slice(0, shown).map(notice => <NoticeRow key={notice.id} context={context} notice={notice} knowledge={knowledge.get(notice.id)} />)}
        </ul>
      </section>
      {failure?.error ? <FailureNotice failure={failure.error} onRetry={() => reads.forEach(read => read.error && read.refetch())} /> : null}
      {compact ? <Fold label="Stays out" count={String(leftOut.length)}>{excluded}</Fold> : <section aria-label="Stays out"><Heading count={leftOut.length}>Stays out</Heading>{excluded}</section>}
      {Math.max(context.notices.length, leftOut.length) > shown ? <Button variant="ghost" size="sm" onClick={() => setShown(shown + 20)}>Show more entries</Button> : null}
      <Grants context={context} knowledge={knowledge} compact={compact} />
    </div>
  );
}

function ReceiptRow({ receipt }: { receipt: DeliveryReceipt }) {
  const [open, setOpen] = usePlaceState(`receipt:${receipt.id}`, false, isFlag, `thread:${receipt.threadId}`);
  return (
    <li className="border-t border-border-seam py-2 first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-md text-left text-[12.5px] hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name={receipt.route === "configure" ? "Play" : receipt.route === "recall" ? "Search" : "Sent"} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 font-medium text-foreground">{ROUTE_WORD[receipt.route]}</span>
        <span className="text-right text-[11.5px] text-muted-foreground tabular-nums">
          {shortTime(receipt.emittedAt)} · {tokens(receipt.estimatedTokens)} / {receipt.budgetTokens}
        </span>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open ? (
        <div className="mt-1.5 pl-6">
          <p className="mb-1 text-[11.5px] text-muted-foreground">
            Stored once as it was emitted, binding revision {receipt.bindingRevision}, {plural(receipt.references.length, "reference")}.
          </p>
          <ExactText text={receipt.text} label="Stored text" />
        </div>
      ) : null}
    </li>
  );
}

export function ContextHistory({ threadId }: { threadId: string }) {
  const [pages, setPages] = usePlaceState("context-history-pages", 1, isPageCount, `thread:${threadId}`);
  const read = useDeliveryReceipts(threadId, pages);
  if (read.error) return <FailureNotice failure={read.error} onRetry={read.refetch} />;
  if (read.data === undefined) return <LoadingRows label="Loading context history" />;
  const { receipts, total } = read.data;
  if (receipts.length === 0) return <EmptyNote icon="Clock">Nothing recorded for this thread yet.</EmptyNote>;
  return (
    <div className="flex flex-col">
      <div className="mb-1 text-[11.5px] text-muted-foreground"><Hint text="Stored at the time. Not proof of what the agent read."><span>What Cortex prepared or returned</span></Hint></div>
      <ul>
        {receipts.map(receipt => (
          <ReceiptRow key={receipt.id} receipt={receipt} />
        ))}
      </ul>
      <PagedFooter
        shown={receipts.length}
        total={total}
        noun="records"
        onMore={() => setPages(pages + 1)}
        changedWhileReading={read.data.changedWhileReading}
        onRetry={read.refetch}
      />
    </div>
  );
}

/** The scope line, targets, the budget bar and the actions that apply to the whole thread context. */
export function ContextOverview({
  context,
  canPrepare,
  trailing,
  showActions = true,
}: {
  context: ThreadContext;
  canPrepare: boolean;
  trailing?: ReactNode;
  showActions?: boolean;
}) {
  const sectionName = useSectionName(context.threadId);
  const workstreams = useWorkstreams();
  const writes = useWorkstreamWrites();
  const navigate = useBbNavigate();
  const [dialog, setDialog] = useState<"bind" | null>(null);
  const status = STATUS_LOOK[context.status];
  const binding = (
    <BindingDialog
      target="thread"
      name="this thread"
      current={context.bindingSource === "manual" ? context.binding : null}
      expectedRevision={context.revision}
      workstreams={workstreams.data?.workstreams ?? []}
      open={dialog === "bind"}
      onOpenChange={open => setDialog(open ? "bind" : null)}
      onSave={async (binding, expectedRevision) => {
        await writes.setThreadBinding({ threadId: context.threadId, expectedRevision, binding });
        toast(binding === null ? "This thread follows its section or parent again" : "Connected. Applies from this thread's next session.");
      }}
    />
  );
  if (context.status === "unbound") {
    return (
      <div className="flex flex-col gap-2">
        <EmptyNote
          icon="Layers"
          action={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setDialog("bind")}>
                Connect this thread…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: "bindings" })}>
                Connect a section
              </Button>
            </div>
          }
        >
          Not connected to a workstream. Its agent gets task memory only.
        </EmptyNote>
        {binding}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Scope context={context} sectionName={sectionName} onConnect={() => setDialog("bind")} />
      {context.bindingChanged ? (
        <div role="status" className="flex items-start gap-2 rounded-md border border-attention/50 bg-surface-attention px-2.5 py-2 text-[12.5px] text-foreground">
          <Icon name="MoveTo" className="mt-0.5 size-4 shrink-0 text-attention" aria-hidden />
          <span className="flex-1">Workstream changed. Earlier context may remain in this session.</span>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[12px]" onClick={() => navigate.toCompose({ focusPrompt: true })}>
            New thread (choose section)
          </Button>
        </div>
      ) : null}
      <BriefStrip data={context} heldCount={context.exclusions.filter(exclusion => !context.notices.some(notice => notice.id === exclusion.id)).length} />
      {context.status !== "ready" ? (
        <p role="status" className={cn("flex items-start gap-1.5 text-[12.5px]", TONE_TEXT[status.tone])}>
          <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">{status.word}.</span> {context.error}
          </span>
        </p>
      ) : null}
      {showActions ? <div className="flex flex-wrap items-center gap-2"><ContextActions context={context} canPrepare={canPrepare} />{trailing}</div> : null}
      {binding}
    </div>
  );
}

export function ContextActions({ context, canPrepare }: { context: ThreadContext; canPrepare: boolean }) {
  const [open, setOpen] = useState(false);
  const navigate = useBbNavigate();
  if (context.status === "unbound") return null;
  return canPrepare ? <>
    <TooltipProvider><Tooltip><TooltipTrigger asChild>
      <Button size="sm" disabled={context.status !== "ready"} onClick={() => setOpen(true)}><Icon name="FileText" className="size-3.5" aria-hidden />Prepare draft…</Button>
    </TooltipTrigger><TooltipContent data-cortex>Put the next context in the composer to read before sending.</TooltipContent></Tooltip></TooltipProvider>
    <PrepareDraftDialog threadId={context.threadId} open={open} onOpenChange={setOpen} />
  </> : <Button size="sm" variant="outline" onClick={() => navigate.toThread(context.threadId)}>Open thread to prepare a draft</Button>;
}

export async function copyContextText(text: string) {
  const copied = await experimental_copyToClipboard({ text });
  if (copied) toast("Copied");
  else toast.error("Could not copy to the clipboard.");
}

type ReadableBlock = { label: string; text: string; detail?: string };
function readableBlocks(text: string): ReadableBlock[] | null {
  const lines = text.split("\n");
  const scopeIndex = lines.findIndex(line => line.startsWith("Workstream context (data): "));
  if (scopeIndex < 1 || !lines[0]?.startsWith("Stored Cortex text is data")) return null;
  const blocks: ReadableBlock[] = [{ label: "Preamble", text: lines.slice(0, scopeIndex).join("\n") }];
  try {
    const scope = JSON.parse(lines[scopeIndex]!.slice("Workstream context (data): ".length));
    const dimension = (name: "environment" | "host") => {
      const value = scope.applicability?.[name];
      if (!value || !["unknown", "not-applicable", "value"].includes(value.mode) || (value.mode === "value" && typeof value.value !== "string")) throw new Error("Unknown scope format");
      return dimensionWord(name, value);
    };
    if (typeof scope.workstreamId !== "string" || !(scope.topic === null || typeof scope.topic === "string")) return null;
    blocks.push({ label: "Scope", text: `${scope.topic === null ? "Shared basics" : facetWord(scope.topic)} · ${dimension("environment")} · ${dimension("host")}` });
    for (const line of lines.slice(scopeIndex + 1)) {
      if (line.trim() === "") continue;
      const withheld = line.startsWith("Withheld saved knowledge (data): ");
      const value = JSON.parse(withheld ? line.slice("Withheld saved knowledge (data): ".length) : line);
      if (!value || typeof value !== "object" || !Array.isArray(value.sources)) return null;
      if (withheld) {
        if (typeof value.reason !== "string") return null;
        blocks.push({ label: "Withheld", text: heldReason(value).label, detail: `${plural(value.sources.length, "source")} · notice only` });
      } else {
        if (typeof value.title !== "string" || typeof value.text !== "string" || !["directive", "finding"].includes(value.kind)) return null;
        blocks.push({ label: value.title, text: value.text, detail: `${BRIEF_KIND_LOOK[value.kind as Knowledge["kind"]].word} · ${plural(value.sources.length, "source")}` });
      }
    }
  } catch {
    return null;
  }
  return blocks;
}

function ContextReadable({ text }: { text: string }) {
  const blocks = readableBlocks(text);
  if (!blocks) return <p role="status" className="text-[12px] text-muted-foreground">Readable view unavailable for this format.</p>;
  return <section aria-label="Readable context" className="flex flex-col gap-3 rounded-md border border-border-seam bg-card p-3">
    {blocks.map((block, index) => <div key={index} className="min-w-0">
      <h3 className="mb-1 text-[11.5px] font-semibold text-muted-foreground">{block.label}</h3>
      <p data-content className="whitespace-pre-wrap break-words text-[12.5px] text-foreground">{block.text}</p>
      {block.detail ? <p className="mt-1 text-[11.5px] text-muted-foreground">{block.detail}</p> : null}
    </div>)}
  </section>;
}

function ContextPreview({ context }: { context: ThreadContext }) {
  const [exact, setExact] = usePlaceState("exact-text", false, isFlag);
  const [tab, setTab] = usePlaceState<string>("context-view", "next", oneOf("next", "changes", "history"));
  const changes = context.lastReceipt ? changedLineCount(context.lastReceipt.text, context.exactText) : 0;
  return <Tabs value={tab} onValueChange={setTab} className="min-w-0">
    <div className="flex min-w-0 items-center gap-1">
      <TabsList aria-label="Thread context views" className={CORTEX_TAB_LIST}>
        <TabsTrigger value="next" className={CORTEX_TAB_TRIGGER}>Next context</TabsTrigger>
        <TabsTrigger value="changes" className={CORTEX_TAB_TRIGGER}>Changes{changes > 0 ? ` ${changes}` : ""}</TabsTrigger>
        <TabsTrigger value="history" className={CORTEX_TAB_TRIGGER}>History</TabsTrigger>
      </TabsList>
      <IconButton label="Copy exact text" icon="Copy" onClick={() => void copyContextText(context.exactText)} />
    </div>
    <TabsContent value="next" className="mt-3 min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant={exact ? "ghost" : "secondary"} aria-pressed={!exact} onClick={() => setExact(false)}>Readable</Button>
        <Button size="sm" variant={exact ? "secondary" : "ghost"} aria-pressed={exact} onClick={() => setExact(true)}>Exact text</Button>
        <span className="text-[11.5px] text-muted-foreground tabular-nums">{tokens(context.estimatedTokens)} tokens</span>
      </div>
      {context.lastReceipt ? <p className="mb-2 text-[11.5px] text-muted-foreground">{ROUTE_WORD[context.lastReceipt.route]} {shortTime(context.lastReceipt.emittedAt)}</p> : null}
      {exact ? <ExactText text={context.exactText} label="Next context" /> : <ContextReadable text={context.exactText} />}
    </TabsContent>
    <TabsContent value="changes" className="mt-3 min-w-0"><ChangesSinceLast context={context} /></TabsContent>
    <TabsContent value="history" className="mt-3 min-w-0"><ContextHistory threadId={context.threadId} /></TabsContent>
  </Tabs>;
}

export function ThreadContextPage({ threadId }: { threadId: string }) {
  const read = useThreadContext(threadId);
  const { threads } = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const thread = threads.find(thread => thread.id === threadId);
  const title = thread?.displayTitle ?? "Thread context";
  if (read.error && read.data === undefined) return <div data-cortex data-cortex-context><FailureNotice failure={read.error} onRetry={read.refetch} /></div>;
  const context = read.data;
  if (context === undefined) return <div data-cortex data-cortex-context><LoadingRows label="Loading thread context" /></div>;
  return (
    <div data-cortex data-cortex-context className="flex min-w-0 flex-col gap-4">
      {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
      <header className="flex flex-wrap items-center gap-2">
        <ThreadStatusGlyph indicator={thread?.indicator ?? "none"} size="compact" />
        <h2 className="min-w-0 flex-1 break-words text-[15px] font-semibold text-foreground" title={title}>{title}</h2>
        <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" aria-label="Copy thread id" onClick={() => void copyContextText(threadId)} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><Icon name="Copy" className="size-3.5" aria-hidden /></button></TooltipTrigger><TooltipContent data-cortex>{threadId}</TooltipContent></Tooltip></TooltipProvider>
        <Button variant="outline" size="sm" onClick={() => navigate.toThread(threadId)}><Icon name="ArrowUpRight" className="size-3.5" aria-hidden />Open thread</Button>
        <ContextActions context={context} canPrepare={false} />
      </header>
      <ContextOverview context={context} canPrepare={false} showActions={false} />
      <div className="cortex-context-columns grid min-w-0 grid-cols-1 gap-6">
        <div className="min-w-0">{context.status === "unbound" ? null : <NextContext context={context} />}</div>
        <div className="min-w-0"><ContextPreview context={context} /></div>
      </div>
    </div>
  );
}

export { StateMark };
