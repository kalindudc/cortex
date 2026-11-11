import { type ReactNode, useState } from "react";
import {
  experimental_copyToClipboard,
  experimental_Diff as Diff,
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
import { cn } from "@/lib/utils";
import { useTaskSearch } from "../panel/menus";
import {
  bindingWord,
  facetWord,
  KIND_LOOK,
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
  useThreadContext,
  useWorkstreams,
  useWorkstreamWrites,
} from "./data";
import { BindingDialog, ChangeForThreadDialog, EditKnowledgeDialog, PrepareDraftDialog } from "./dialogs";
import { activeGrants, changedLineCount, dismissedFor, shortTime, unifiedPatch, type Visibility, visibilityOf } from "./model";
import { Applicability, BudgetBar, EmptyNote, FailureNotice, Heading, IconButton, LoadingRows, PagedFooter, StateMark, TONE_TEXT } from "./parts";
import type { ContextEntry, DeliveryReceipt, ThreadContext } from "./types";

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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-[12px]" aria-label={`Above the composer: ${detail}. Change`}>
          <Icon name={context.dismissed ? "EyeOff" : "Eye"} className="size-3.5" aria-hidden />
          {context.dismissed ? "Hidden above composer" : "Shown above composer"}
          <Icon name="ChevronDown" className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" mobileTitle="Above the composer" className="w-72">
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
  );
}

function Scope({ context, sectionName, onConnect }: { context: ThreadContext; sectionName: string | null; onConnect: () => void }) {
  const topic = context.binding?.topic ?? null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name="Layers" className="size-4 text-primary" aria-hidden />
        <span className="text-[14px] font-semibold text-foreground">{context.workstream?.name ?? "No workstream"}</span>
        <span className="text-[12.5px] text-muted-foreground">· {topic ? facetWord(topic) : "Shared basics only"}</span>
        <span className="flex-1" />
        <span className="text-[11.5px] text-muted-foreground">{bindingWord(context, sectionName)}</span>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={onConnect}>
          Change…
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
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
  onChange: () => void;
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
      <DropdownMenuContent align="end" mobileTitle={entry.knowledge.title} className="w-72">
        <p className="px-2 pt-1.5 pb-1 text-[11px] font-semibold text-muted-foreground">This thread only</p>
        <DropdownMenuItem onSelect={onChange}>
          <Icon name="Pencil" aria-hidden />
          Change for this thread…
        </DropdownMenuItem>
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
  const kind = KIND_LOOK[entry.knowledge.kind];
  const local = entry.origin === "thread-only";
  return (
    <li className="flex items-start gap-2 border-t border-border-seam py-2 first:border-t-0">
      <Icon name={kind.icon} className={cn("mt-0.5 size-4 shrink-0", local ? "text-attention" : "text-primary")} aria-label={kind.word} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-semibold text-foreground" title={entry.knowledge.title}>
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
          <span className="tabular-nums">{tokens(entry.estimatedTokens)}</span>
        </p>
      </div>
      <EntryMenu context={context} entry={entry} onChange={() => setDialog("change")} onEdit={() => setDialog("edit")} />
      <ChangeForThreadDialog context={context} entry={entry} open={dialog === "change"} onOpenChange={open => setDialog(open ? "change" : null)} />
      <EditKnowledgeDialog entry={entry.knowledge} workstream={context.workstream} open={dialog === "edit"} onOpenChange={open => setDialog(open ? "edit" : null)} />
    </li>
  );
}

function NoticeRow({ notice }: { notice: ThreadContext["notices"][number] }) {
  return (
    <li className="flex items-start gap-2 border-t border-border-seam py-2 first:border-t-0">
      <Icon name="TriangleAlert" className="mt-0.5 size-4 shrink-0 text-warning-text" aria-label="Notice" />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] text-foreground">{notice.reason}</p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          Notice only, its text is held back · <span className="font-mono">{notice.id}</span>
          {notice.sources.length > 0 ? ` · ${plural(notice.sources.length, "source")}` : ""} · <span className="tabular-nums">{tokens(notice.estimatedTokens)}</span>
        </p>
      </div>
    </li>
  );
}

function ExcludedRow({ context, exclusion }: { context: ThreadContext; exclusion: ThreadContext["exclusions"][number] }) {
  const writes = useWorkstreamWrites();
  const local = context.overrides.find(row => row.knowledgeId === exclusion.id && row.excluded);
  return (
    <li className="flex items-center gap-2 border-t border-border-seam py-1.5 first:border-t-0 text-[12.5px]">
      <Icon name="Minus" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{exclusion.id}</span>
      <span className="min-w-0 flex-1 truncate text-foreground" title={exclusion.reason}>
        {exclusion.reason}
      </span>
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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Share with this thread</DialogTitle>
          <DialogDescription>From this thread's next session only. You can revoke it later; a running session keeps what it already has.</DialogDescription>
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
              <span className="min-w-0 flex-1 truncate text-foreground">{row.title}</span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">{row.meta}</span>
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

function Grants({ context }: { context: ThreadContext }) {
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
        Shared with this thread
      </Heading>
      {grants.length === 0 ? <p className="text-[12px] text-muted-foreground">Nothing from outside {context.workstream?.name ?? "the workstream"}.</p> : null}
      <ul>
        {grants.map(grant => (
          <li key={`${grant.kind}-${grant.id}`} className="flex items-center gap-2 border-t border-border-seam py-1.5 first:border-t-0 text-[12.5px]">
            <Icon name={grant.kind === "knowledge" ? "Layers" : "Archive"} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono text-foreground">{grant.kind === "legacy-task" ? `#${grant.id}` : grant.id}</span>
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
        className="max-h-96 overflow-auto rounded-md border border-border-seam bg-muted/40 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words text-foreground"
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

/** What goes into this thread's next context, the cut, and what stays out and why. */
export function NextContext({ context }: { context: ThreadContext }) {
  const going = context.entries.length + context.notices.length;
  const changes = context.lastReceipt ? changedLineCount(context.lastReceipt.text, context.exactText) : 0;
  return (
    <div className="flex flex-col">
      <Heading count={going}>Goes in</Heading>
      {going === 0 ? <p className="text-[12px] text-muted-foreground">Nothing approved applies to this thread yet.</p> : null}
      <ul>
        {context.entries.map(entry => (
          <EntryRow key={entry.knowledge.id} context={context} entry={entry} />
        ))}
        {context.notices.map(notice => (
          <NoticeRow key={notice.id} notice={notice} />
        ))}
      </ul>
      <div role="separator" aria-label={`Budget ${context.budgetTokens} tokens`} className="my-2 flex items-center gap-2 text-[11px] font-semibold text-foreground">
        <span className="h-px flex-1 bg-foreground" />
        <span className="tabular-nums">cut · {context.budgetTokens} tokens</span>
        <span className="h-px flex-1 bg-foreground" />
      </div>
      <Heading count={context.exclusions.length}>Stays out</Heading>
      {context.exclusions.length === 0 ? <p className="text-[12px] text-muted-foreground">Nothing left out.</p> : null}
      <ul>
        {context.exclusions.map(exclusion => (
          <ExcludedRow key={exclusion.id} context={context} exclusion={exclusion} />
        ))}
      </ul>
      <Grants context={context} />
      <Fold label="Exact text" count={tokens(context.estimatedTokens)}>
        <ExactText text={context.exactText} label="Next context" />
      </Fold>
      <Fold label="Changes since last prepared" count={context.lastReceipt ? plural(changes, "line") : undefined}>
        <ChangesSinceLast context={context} />
      </Fold>
    </div>
  );
}

function ReceiptRow({ receipt }: { receipt: DeliveryReceipt }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-border-seam py-2 first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-md text-left text-[12.5px] hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-semibold text-foreground">{ROUTE_WORD[receipt.route]}</span>
        <span className="flex-1" />
        <span className="text-[11.5px] text-muted-foreground tabular-nums">
          {shortTime(receipt.emittedAt)} · {tokens(receipt.estimatedTokens)} / {receipt.budgetTokens}
        </span>
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
  const [pages, setPages] = useState(1);
  const read = useDeliveryReceipts(threadId, pages);
  if (read.error) return <FailureNotice failure={read.error} onRetry={read.refetch} />;
  if (read.data === undefined) return <LoadingRows label="Loading context history" />;
  const { receipts, total } = read.data;
  if (receipts.length === 0) return <EmptyNote icon="Clock">Nothing recorded for this thread yet.</EmptyNote>;
  return (
    <div className="flex flex-col">
      <p className="mb-1 text-[11.5px] text-muted-foreground">What Cortex prepared or returned, as stored at the time. Not a record of what the agent read.</p>
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
}: {
  context: ThreadContext;
  canPrepare: boolean;
  trailing?: ReactNode;
}) {
  const sectionName = useSectionName(context.threadId);
  const workstreams = useWorkstreams();
  const writes = useWorkstreamWrites();
  const navigate = useBbNavigate();
  const [dialog, setDialog] = useState<"bind" | "prepare" | null>(null);
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
          <Icon name="SectionMove" className="mt-0.5 size-4 shrink-0 text-attention" aria-hidden />
          <span className="flex-1">Workstream changed. Earlier context may remain in this session.</span>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[12px]" onClick={() => navigate.toCompose({ focusPrompt: true })}>
            New thread
          </Button>
        </div>
      ) : null}
      <BudgetBar context={context} />
      {context.status !== "ready" ? (
        <p role="status" className={cn("flex items-start gap-1.5 text-[12.5px]", TONE_TEXT[status.tone])}>
          <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">{status.word}.</span> {context.error}
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {canPrepare ? (
          <Button size="sm" variant="outline" disabled={context.status !== "ready"} onClick={() => setDialog("prepare")}>
            Prepare draft…
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => navigate.toThread(context.threadId)}>
            Open thread to prepare a draft
          </Button>
        )}
        {trailing}
      </div>
      {binding}
      {canPrepare ? <PrepareDraftDialog threadId={context.threadId} open={dialog === "prepare"} onOpenChange={open => setDialog(open ? "prepare" : null)} /> : null}
    </div>
  );
}

/** A thread's context on the Cortex page: scope and lists beside the exact text, history and changes. */
export function ThreadContextPage({ threadId }: { threadId: string }) {
  const read = useThreadContext(threadId);
  const { threads } = experimental_useSidebarThreads();
  const title = threads.find(thread => thread.id === threadId)?.displayTitle ?? threadId;
  if (read.error) return <FailureNotice failure={read.error} onRetry={read.refetch} />;
  const context = read.data;
  if (context === undefined) return <LoadingRows label="Loading thread context" />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 truncate text-[15px] font-semibold text-foreground" title={title}>
          {title}
        </h2>
        <span className="font-mono text-[11.5px] text-muted-foreground">{threadId}</span>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <ContextOverview context={context} canPrepare={false} />
          {context.status === "unbound" ? null : <NextContext context={context} />}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {context.status === "unbound" ? null : <ExactText text={context.exactText} label="Next context" />}
          <section aria-label="Context history">
            <Heading>Context history</Heading>
            <ContextHistory threadId={threadId} />
          </section>
        </div>
      </div>
    </div>
  );
}

export { StateMark };
