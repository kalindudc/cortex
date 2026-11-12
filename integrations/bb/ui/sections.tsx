import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { experimental_ThreadStatusGlyph as ThreadStatusGlyph, experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ConnectionJob, ConnectInput, Section } from "../section-contract";
import { failureOf, type OutputOf, useDraftJobs, useKnowledgeEntries, useSectionCaptureJobs, useSectionDetail, useSections, useWorkstream, useWorkstreams, useWorkstreamWrites } from "./data";
import { BindingDialog, ConfirmDialog } from "./dialogs";
import { Applicability, FailureNotice, LoadingRows, SourceList } from "./parts";
import { actorWord, deliverySummary, dimensionWord, facetWord, plural, tokens } from "./copy";
import { CandidateDialog, CaptureDialog, SuggestionCard } from "./takeaway";
import { CORTEX_PAGE_PATH } from "./thread-context";
import { DraftDialog } from "./drafting";
import { DraftRailCard, DraftsTab } from "./draft-rail";
import { BriefStrip } from "./brief-strip";
import { heldReason, KindMark, ReasonChip } from "./marks";
import { KnowledgeActions, KnowledgeDetail } from "./knowledge";
import { relativeAge } from "./model";
import { WorkstreamKnowledge, WorkstreamEdits } from "./workstreams";
import type { Knowledge, ReviewItem, Workstream } from "./types";

export function ConnectSectionDialog({ section, workstreams, connections, onClose }: { section: Section; workstreams: Workstream[]; connections: Section[]; onClose: () => void }) {
  const writes = useWorkstreamWrites();
  const [choice, setChoice] = useState<"create" | "reuse" | "">("");
  const [name, setName] = useState(section.canonicalName);
  const [selected, setSelected] = useState("");
  const [intent, setIntent] = useState<ConnectInput | null>(null);
  const [job, setJob] = useState<ConnectionJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof failureOf> | null>(null);
  const existing = workstreams.find(workstream => workstream.id === selected);
  const finish = (out: ConnectionJob) => {
    setJob(out);
    if (out.status === "connected") {
      toast(out.marker.error ? `Connected. ${out.marker.error}` : "Connected. No old conversations were imported or sent to running sessions.");
      onClose();
    }
  };
  const submit = async () => {
    if (busy || intent || choice === "" || (choice === "reuse" && !existing)) return;
    const input: ConnectInput = { requestId: crypto.randomUUID(), sectionId: section.id, expectedRevision: section.binding.revision, expectedTitle: section.name, choice: choice === "create" ? { kind: "create", name: name.trim() } : { kind: "reuse", workstreamId: existing!.id, expectedWorkstreamRevision: existing!.revision }, markTitle: false };
    setIntent(input); setBusy(true); setFailure(null);
    try { finish(await writes.connectSection(input)); }
    catch (cause) { setFailure(failureOf(cause)); }
    finally { setBusy(false); }
  };
  const retry = async () => {
    if (!intent || busy) return;
    setBusy(true); setFailure(null);
    try { finish(job ? await writes.retrySection(intent.requestId) : await writes.connectSection(intent)); }
    catch (cause) { setFailure(failureOf(cause)); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="max-w-xl" data-cortex-takeaway="">
    <DialogHeader><DialogTitle className="flex items-center gap-2"><Icon name="Brain" className="size-4 text-primary" aria-hidden />Share context in {section.canonicalName}</DialogTitle><DialogDescription>Old conversations are not imported. Running sessions are not changed.</DialogDescription></DialogHeader>
    <fieldset disabled={busy || intent !== null} className="grid min-w-0 gap-2">
      <legend className="sr-only">Workstream</legend>
      <label className={cn("flex cursor-pointer items-center gap-2 rounded-md border border-border-seam bg-card p-3 text-[13px]", choice === "create" && "bg-surface-selected border-surface-selected-border")}><input type="radio" name="cortex-connect-choice" aria-label="New workstream" checked={choice === "create"} onChange={() => setChoice("create")} /><span className="font-semibold">New workstream</span></label>
      {choice === "create" ? <label className="grid gap-1 px-3 pb-2 text-[13px]">Workstream name<Input value={name} onChange={event => setName(event.target.value)} className="text-[16px] sm:text-[13px]" /></label> : null}
      {workstreams.filter(workstream => !workstream.archived).map(workstream => <ConnectionWorkstreamChoice key={workstream.id} workstream={workstream} connections={connections} selected={choice === "reuse" && selected === workstream.id} onSelect={() => { setChoice("reuse"); setSelected(workstream.id); }} />)}
    </fieldset>
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground"><span>Shared basics</span><span>· 1,000 tokens</span><span>· Targets not chosen</span><span>· change after connecting</span></div>
    {failure ? <FailureNotice failure={failure} /> : null}
    {job?.error ? <p role="alert">{job.error}</p> : null}
    {intent ? <div className="grid gap-2 text-[13px]"><p>Connection not confirmed. Retry keeps the intended workstream and request; it does not create a second workstream.</p><Button variant="outline" disabled={busy} onClick={() => void retry()}>Retry connection</Button></div> : null}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || intent !== null || choice === "" || (choice === "create" ? !name.trim() : !existing)} onClick={() => void submit()}>Share context</Button></DialogFooter>
  </DialogContent></Dialog>;
}


function ConnectionWorkstreamChoice({ workstream, connections, selected, onSelect }: { workstream: Workstream; connections: Section[]; selected: boolean; onSelect: () => void }) {
  const names = connections.filter(row => row.binding.binding?.workstreamId === workstream.id).map(row => row.canonicalName);
  return <label className={cn("flex min-w-0 cursor-pointer items-start gap-2 rounded-md border border-border-seam bg-card p-3 text-[13px]", selected && "bg-surface-selected border-surface-selected-border")}>
    <input type="radio" name="cortex-connect-choice" aria-label={`Use ${workstream.name}`} checked={selected} onChange={onSelect} className="mt-1 shrink-0" />
    <span className="grid min-w-0 gap-1"><span className="font-semibold break-words">Use {workstream.name}</span><span className="break-words text-[12px] text-muted-foreground">{names.length ? `also shared by ${names.join(", ")}` : "Not connected to another section"}</span></span>
  </label>;
}

export type SectionTab = "brief" | "knowledge" | "drafts" | "edits";

export function SectionView({ data, sections, workstreams, onConnect, onCapture, onEdit, onStop, onMark, onRetry, onDraft, onBinding, tab = "brief", entryId = null, acceptedId = null, recovery, reviewHeadingRef, sectionRootRef, scrollportRef, onEditControl }: {
  data: OutputOf<"sectionDetail">; sections: Section[]; workstreams: Workstream[];
  onConnect: () => void; onCapture: () => void; onEdit: (entry: Knowledge, opener: HTMLButtonElement) => void;
  onStop: () => void; onMark: (action: "remove") => void; onRetry: () => void;
  onDraft?: (opener: HTMLButtonElement) => void; onBinding?: () => void;
  tab?: SectionTab; entryId?: string | null; acceptedId?: string | null; recovery?: ReactNode;
  reviewHeadingRef?: Ref<HTMLHeadingElement>; sectionRootRef?: Ref<HTMLDivElement>; scrollportRef?: Ref<HTMLDivElement>;
  onEditControl?: (id: string, element: HTMLButtonElement | null) => void;
}) {
  const navigate = useBbNavigate();
  const sidebar = experimental_useSidebarThreads();
  const section = data.section;
  const binding = section.binding.binding;
  const workstreamId = binding?.workstreamId ?? null;
  const workstreamRead = useWorkstream(workstreamId);
  const drafts = useDraftJobs(section.id, 0, binding !== null);
  const entryRead = useKnowledgeEntries(entryId ? [entryId] : [])[0];
  const workstream = workstreams.find(workstream => workstream.id === workstreamId) ?? workstreamRead.data?.workstream;
  const candidates = data.review.items.filter(item => item.entry.state === "candidate");
  const sharedWith = sections.filter(row => row.id !== section.id && workstreamId && row.binding.binding?.workstreamId === workstreamId);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [landed, setLanded] = useState<string[]>([]);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [allThreads, setAllThreads] = useState(false);
  const draftMenuOpener = useRef<HTMLButtonElement>(null);
  const entryOpener = useRef<HTMLButtonElement | null>(null);
  const detailClose = useRef<HTMLButtonElement>(null);
  const briefList = useRef<HTMLElement>(null);
  const entryButtons = useRef(new Map<string, HTMLButtonElement>());
  const previousEntryId = useRef<string | null>(null);
  useEffect(() => {
    if (entryId && tab === "brief") detailClose.current?.focus({ preventScroll: true });
    else if (previousEntryId.current && tab === "brief") {
      const target = entryOpener.current?.isConnected ? entryOpener.current : entryButtons.current.get(previousEntryId.current) ?? briefList.current;
      target?.focus({ preventScroll: true });
      entryOpener.current = null;
    }
    previousEntryId.current = entryId;
  }, [entryId, tab]);
  useEffect(() => {
    if (acceptedId) {
      setLanded(ids => ids.includes(acceptedId) ? ids : [...ids, acceptedId]);
      setAccepted(ids => ids.includes(acceptedId) ? ids : [...ids, acceptedId]);
    }
  }, [acceptedId]);
  useEffect(() => {
    setAccepted(ids => ids.filter(id => data.review.items.some(item => item.entry.id === id && item.entry.state === "candidate")));
  }, [data.review]);
  const accept = (item: ReviewItem) => {
    setLanded(ids => [...ids.filter(id => id !== item.entry.id), item.entry.id]);
    setAccepted(ids => [...ids.filter(id => id !== item.entry.id), item.entry.id]);
  };
  const knowledge = new Map([
    ...(workstreamRead.data?.entries ?? []).map(entry => [entry.id, entry] as const),
    ...data.review.items.map(item => [item.entry.id, item.entry] as const),
    ...data.eligibility.entries.map(row => [row.knowledge.id, row.knowledge] as const),
  ]);
  const held = [...data.eligibility.notices, ...data.eligibility.exclusions.filter(row => !data.eligibility.notices.some(notice => notice.id === row.id))];
  const selected = entryRead?.data?.entry ?? knowledge.get(entryId ?? "") ?? null;
  const targets = binding?.applicability ?? { environment: { mode: "unknown" as const }, host: { mode: "unknown" as const } };
  const heldFixes = new Set(held.map(row => heldReason(row, { entry: knowledge.get(row.id), applicability: targets }).fix));
  const approvedHeld = held.filter(row => knowledge.get(row.id)?.state === "approved").length;
  const route = (nextTab: SectionTab, kn?: string) => navigate.toPluginPanel("cortex", { subPath: `sections/${section.id}/${nextTab}${kn ? `/${kn}` : ""}` });
  const open = (id: string) => {
    if (!entryId && document.activeElement instanceof HTMLButtonElement) entryOpener.current = document.activeElement;
    route(tab, id);
  };
  const editBinding = onBinding ?? onConnect;
  const library = () => navigate.toPluginPanel("cortex", { subPath: "library" });
  const newThread = <TooltipProvider><Tooltip><TooltipTrigger asChild><Button variant="outline" aria-label={`New thread in ${section.canonicalName}`} onClick={() => navigate.toCompose({ placement: { sectionId: section.id, pinned: false }, focusPrompt: true })}><Icon name="Plus" className="size-3.5" aria-hidden />New thread</Button></TooltipTrigger><TooltipContent>Opens the native composer in this section without replacing your draft.</TooltipContent></Tooltip></TooltipProvider>;
  const actions = <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Advanced section actions"><Icon name="MoreHorizontal" className="size-4" aria-hidden /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" mobileTitle="Section actions">
    <DropdownMenuItem onSelect={library}>Search the library</DropdownMenuItem>
    {binding ? <DropdownMenuItem onSelect={() => route("edits")}>Edits</DropdownMenuItem> : null}
    {section.marker.status === "owned" ? <DropdownMenuItem onSelect={() => onMark("remove")}>Remove title mark</DropdownMenuItem> : null}
    {section.marker.error && section.marker.originalTitle !== null && section.marker.decoratedTitle !== null ? <DropdownMenuItem onSelect={() => onMark("remove")}>Retry title cleanup</DropdownMenuItem> : null}
  </DropdownMenuContent></DropdownMenu>;
  const callouts = <>
    {section.connectionJob && section.connectionJob.status !== "connected" ? <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-border-seam bg-surface-attention p-3 text-[13px]"><span className="min-w-0 flex-1 break-words">{section.connectionJob.error ?? "Connection pending. The workstream is retained."}</span><Button variant="outline" onClick={onRetry}>Retry connection</Button></div> : null}
    {section.marker.error ? <div role="alert" className="rounded-md border border-border-seam bg-surface-attention p-3 text-[13px]"><span>Sharing and section titles are separate. {section.marker.error}</span>{section.marker.originalTitle !== null && section.marker.decoratedTitle !== null ? <Button variant="ghost" onClick={() => onMark("remove")}>Retry title cleanup</Button> : null}</div> : null}
  </>;
  return <div ref={sectionRootRef} tabIndex={-1} aria-label={`Cortex section: ${section.canonicalName}`} data-cortex data-cortex-section="" data-part="SectionPage" className="cortex-section flex h-full min-h-0 min-w-0 flex-col text-foreground">
    <div ref={scrollportRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
    {!binding ? <div className="cortex-unbound mx-auto grid max-w-3xl gap-5 p-5">
      <div className="flex flex-wrap items-center gap-2"><Icon name="Folder" className="size-4 text-muted-foreground" aria-hidden /><span className="text-[13px] text-muted-foreground">{plural(section.threadCount, "thread")} · no shared brief</span><span className="flex-1" />{actions}</div>
      <div role="img" aria-label="No shared brief" className="h-3.5 w-full border border-dashed border-border-seam bg-surface-recessed" />
      {callouts}{recovery}
      <h2 className="text-xl font-semibold break-words">New threads in {section.canonicalName} start with nothing shared.</h2>
      <p className="text-[13px] text-muted-foreground">Connect a workstream. Its accepted takeaways become this section's brief.</p>
      <div className="flex flex-wrap gap-2"><Button onClick={onConnect}><Icon name="Brain" className="size-4" aria-hidden />Share context in {section.canonicalName}</Button>{newThread}</div>
      <div className="grid gap-2 text-[13px] text-muted-foreground"><span>Old conversations are not imported.</span><span>Nothing is sent to running sessions.</span></div>
    </div> : <>
      <header data-part="SectionHeader" className="cortex-section-header border-b border-border-seam bg-background px-4 pt-3">
        <div className="cortex-section-head flex min-w-0 flex-wrap items-center gap-2">
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" className="max-w-full min-w-0 bg-surface-selected" aria-label={`Sharing ${workstream?.name ?? "a workstream"}`}><Icon name="Brain" className="size-4 shrink-0 text-primary" aria-hidden /><span className="truncate">Sharing {workstream?.name ?? "a workstream"}</span><Icon name="ChevronDown" className="size-3.5 shrink-0" aria-hidden /></Button></DropdownMenuTrigger>
            <DropdownMenuContent mobileTitle="Sharing" align="start"><DropdownMenuItem onSelect={() => route("knowledge")}>Open workstream knowledge</DropdownMenuItem><DropdownMenuItem onSelect={editBinding}>Topic, budget and targets…</DropdownMenuItem><DropdownMenuItem onSelect={onConnect}>Change workstream…</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={onStop}>Stop sharing…</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
          <div className="cortex-section-facts flex min-w-0 flex-wrap gap-1">
            <Button size="sm" variant="outline" onClick={editBinding}>{facetWord(binding.topic ?? "orientation")}</Button>
            {(["environment", "host"] as const).map(name => <TooltipProvider key={name}><Tooltip><TooltipTrigger asChild><Button size="sm" variant="outline" aria-label={targets[name].mode === "unknown" ? `${name === "environment" ? "Environment" : "Host"} ?` : dimensionWord(name, targets[name])} className={cn("max-w-full min-w-0", targets[name].mode === "unknown" && "border-dashed border-warning/60 text-warning-text")} onClick={editBinding}><Icon name={name === "environment" ? "Target" : "ComputerCloud"} className="size-3 shrink-0" aria-hidden />{targets[name].mode === "unknown" ? <><span className="truncate">{name === "environment" ? "Environment" : "Host"}</span><span className="shrink-0">?</span></> : <span className="truncate">{dimensionWord(name, targets[name])}</span>}</Button></TooltipTrigger><TooltipContent>{targets[name].mode === "unknown" ? "Unknown never counts as any environment, so entries that need one stay out." : "Change targets"}</TooltipContent></Tooltip></TooltipProvider>)}
          </div>
          <span className="cortex-head-spacer flex-1" />
          <div className="cortex-section-actions flex flex-wrap items-center gap-1">{newThread}
            <div className="flex"><Button className="rounded-r-none" onClick={onCapture}><Icon name="Edit" className="size-3.5" aria-hidden />Write takeaway</Button><DropdownMenu><DropdownMenuTrigger asChild><Button ref={draftMenuOpener} size="icon" className="rounded-l-none border-l border-primary-foreground/30" aria-label="More ways to add"><Icon name="ChevronDown" className="size-3.5" aria-hidden /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" mobileTitle="Add to the brief"><DropdownMenuItem onSelect={onCapture}>Write takeaway</DropdownMenuItem>{onDraft ? <DropdownMenuItem onSelect={() => { if (draftMenuOpener.current) onDraft(draftMenuOpener.current); }}>Draft from a thread…</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu></div>{actions}
          </div>
        </div>
        <div className="my-3"><BriefStrip data={data.eligibility} heldCount={data.eligibility.exclusions.length + data.eligibility.notices.length} highlightKey={highlightKey} onHover={setHighlightKey} /></div>
        <Tabs value={tab} onValueChange={value => route(value as SectionTab)}><TabsList aria-label="Section views" className="cortex-section-tabs w-full justify-start overflow-x-auto bg-transparent">
          <TabsTrigger value="brief">Brief</TabsTrigger><TabsTrigger value="knowledge">All knowledge{workstreamRead.data ? ` · ${workstreamRead.data.total}` : ""}</TabsTrigger><TabsTrigger value="drafts">Drafts{drafts.data ? ` · ${drafts.data.total}` : ""}</TabsTrigger><TabsTrigger value="edits">Edits</TabsTrigger>
        </TabsList></Tabs>
      </header>
      {tab === "knowledge" ? <div className="p-4"><p className="mb-3 text-[12px] text-muted-foreground">Workstream also used by {sharedWith.length ? sharedWith.map(row => row.canonicalName).join(", ") : "no other section"}.</p><WorkstreamKnowledge id={binding.workstreamId} selectedId={entryId} onSelect={id => route("knowledge", id)} onClose={() => route("knowledge")} /></div> : tab === "edits" ? <div className="p-4"><WorkstreamEdits id={binding.workstreamId} /></div> : tab === "drafts" ? <div className="p-4"><DraftsTab section={section} /></div> :
      <div className={cn("cortex-section-columns grid min-w-0 gap-6 p-4", entryId && "cortex-detail-open")}>
        <main ref={briefList} tabIndex={-1} data-part="BriefList" className="cortex-master min-w-0">
          <div className="grid gap-2">{callouts}{recovery}{workstreamRead.error ? <FailureNotice failure={workstreamRead.error} onRetry={workstreamRead.refetch} /> : null}</div>
          {data.eligibility.status !== "ready" && data.eligibility.status !== "over-budget" ? <p role="alert" className="my-3 break-words text-[13px] text-destructive-text">{data.eligibility.status === "missing-required" ? "Missing required knowledge" : data.eligibility.status === "unavailable" ? "Brief unavailable" : "Not connected"}{data.eligibility.error ? ` · ${data.eligibility.error}` : ""}</p> : null}
          <div className={candidates.length ? "mb-2 mt-2 flex flex-wrap items-center gap-2" : "flex flex-wrap items-center gap-2"}><h2 ref={reviewHeadingRef} tabIndex={-1} className={candidates.length ? "text-[13px] font-semibold" : "sr-only"}>{candidates.length ? `Suggested · ${candidates.length}` : "Takeaway review"}</h2>{drafts.data?.jobs.filter(job => job.candidateResults.some(result => candidates.some(item => item.entry.id === result.canonicalId))).map(job => <span key={job.requestId} className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">from a draft of <Button variant="link" className="min-w-0 truncate p-0 text-[12px]" onClick={() => navigate.toThread(job.sourceThreadId)}>{data.threads.find(thread => thread.id === job.sourceThreadId)?.name ?? "a section thread"}</Button> · {relativeAge(job.requestedAt, Date.now())}</span>)}{candidates.length ? <span className="flex-1" /> : null}{data.review.total > candidates.length ? <Button size="sm" variant="link" className={candidates.length ? undefined : "h-auto px-0 py-1"} onClick={() => navigate.toPluginPanel("cortex", { subPath: "review" })}>{candidates.length ? `${data.review.total - candidates.length} more in Review` : `${plural(data.review.total, "entry", "entries")} waiting in Review`}</Button> : null}</div>
          <div className="grid gap-3">{candidates.map(item => {
            const leaving = accepted.includes(item.entry.id);
            return <div key={item.entry.id} className={cn("cortex-suggestion-wrap", leaving && "cortex-suggestion-leaving")} inert={leaving || undefined}><div className="min-h-0 overflow-hidden"><SuggestionCard item={item} section={section} accepted={leaving} editRef={element => onEditControl?.(item.entry.id, element)} onEdit={opener => onEdit(item.entry, opener)} onAccepted={() => accept(item)} /></div></div>;
          })}</div>
          <div className={cn("mb-2 flex flex-wrap items-center gap-2", candidates.length ? "mt-5" : "mt-2")}><h2 className="text-[13px] font-semibold">{deliverySummary(data.eligibility.status, `Goes to new threads · ${data.eligibility.entries.length}`)}</h2><span className="flex-1" /><TooltipProvider><Tooltip><TooltipTrigger asChild><Button size="sm" variant="ghost"><Icon name="Info" className="size-3.5" aria-hidden />New sessions only</Button></TooltipTrigger><TooltipContent>Running sessions keep what they started with. A preview is not proof an agent used it.</TooltipContent></Tooltip></TooltipProvider></div>
          {data.eligibility.entries.length === 0 ? <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-border-seam bg-card p-3 text-[13px]"><Icon name="Info" className="size-4 shrink-0" aria-hidden /><span className="min-w-0 flex-1">No entry reaches new threads yet.{approvedHeld ? ` ${plural(approvedHeld, "approved entry is", "approved entries are")} held back.` : ""}{heldFixes.has("open") && !heldFixes.has("targets") ? " Open each one to say where it applies." : ""}</span>{heldFixes.has("targets") ? <Button variant="outline" onClick={editBinding}>Set targets</Button> : null}</div> :
          <ol aria-label={data.eligibility.status === "ready" ? "Goes to new threads" : "Selected entries"}>{data.eligibility.entries.map((row, index) => <li key={row.knowledge.id}><button ref={element => { if (element) entryButtons.current.set(row.knowledge.id, element); else entryButtons.current.delete(row.knowledge.id); }} type="button" aria-label={`Open ${row.knowledge.title}`}  aria-current={entryId === row.knowledge.id ? "true" : undefined} className={cn("cortex-brief-row grid w-full min-w-0 gap-x-2 gap-y-1 border-b border-border-seam px-2 py-3 text-left text-[13px] hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring", landed.includes(row.knowledge.id) && "cortex-landed", (highlightKey === row.knowledge.id || entryId === row.knowledge.id) && "bg-surface-selected")} onMouseEnter={() => setHighlightKey(row.knowledge.id)} onMouseLeave={() => setHighlightKey(null)} onFocus={() => setHighlightKey(row.knowledge.id)} onBlur={() => setHighlightKey(null)} onClick={() => open(row.knowledge.id)}>
            <span className="text-right text-muted-foreground tabular-nums">{index + 1}</span><span data-content className="min-w-0 break-words">{row.knowledge.title}</span><span className="text-right text-muted-foreground tabular-nums">{tokens(row.estimatedTokens)}</span>
            <span className="col-start-2 col-end-4 flex flex-wrap items-center gap-1 text-[11.5px] text-muted-foreground"><KindMark kind={row.knowledge.kind} /><span>· approved by {row.knowledge.approval ? actorWord(row.knowledge.approval.actor) : "unknown"} · {landed.includes(row.knowledge.id) ? "just now" : relativeAge(row.knowledge.approval?.at ?? row.knowledge.updatedAt, Date.now())}</span></span>
          </button></li>)}</ol>}
          <div className="my-3 flex items-center gap-2 text-[11.5px] text-muted-foreground"><span className="h-px flex-1 bg-border-seam" />budget · {data.eligibility.budgetTokens} tokens<span className="h-px flex-1 bg-border-seam" /></div>
          {data.eligibility.status === "over-budget" ? <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-surface-destructive p-3 text-[13px]"><Icon name="AlertTriangle" className="size-4 text-destructive-text" aria-hidden /><span className="min-w-0 flex-1"><b>Over budget.</b> New threads get no brief until it fits.</span><Button variant="outline" onClick={editBinding}>Raise budget</Button></div> : null}
          {held.length ? <section aria-label="Held back"><h2 className="my-3 text-[13px] font-semibold text-muted-foreground">Held back · {held.length}</h2><ul>{held.map(row => {
            const entry = knowledge.get(row.id);
            const reason = heldReason(row, { entry, applicability: targets });
            return <li key={row.id} className="grid min-w-0 gap-1 border-b border-border-seam px-2 py-3 text-[13px] text-muted-foreground"><div className="flex items-start gap-2"><Icon name={"estimatedTokens" in row ? "EyeOff" : "Pause"} className="size-3.5 shrink-0" aria-hidden /><span className="min-w-0 flex-1 break-words">{entry?.title ?? "Held knowledge"}</span>{"estimatedTokens" in row && typeof row.estimatedTokens === "number" ? <span className="tabular-nums">{tokens(row.estimatedTokens)}</span> : null}</div><div className="flex min-w-0 flex-wrap items-center gap-2"><ReasonChip reason={reason} />{"estimatedTokens" in row ? <span className="text-[11.5px]">Notice only · text withheld</span> : null}{reason.fix ? <Button size="sm" variant="ghost" onClick={() => reason.fix === "targets" ? editBinding() : reason.fix === "review" ? navigate.toPluginPanel("cortex", { subPath: "review" }) : open(row.id)}>{reason.fix === "targets" ? "Set targets" : reason.fix === "review" ? "Review" : "Open"}</Button> : <Button size="sm" variant="ghost" onClick={() => open(row.id)}>Open</Button>}</div></li>;
          })}</ul></section> : null}
          {sharedWith.length ? <p className="mt-3 break-words text-[12px] text-muted-foreground">Same brief also used by {sharedWith.map(row => row.canonicalName).join(", ")}.</p> : null}
        </main>
        {entryId ? <aside data-part="KnowledgeSheet" className="cortex-detail min-w-0 self-start rounded-md border border-border-seam bg-card p-4">
          <div className="mb-2 flex items-center justify-between"><Button className="cortex-detail-back" size="sm" variant="ghost" onClick={() => route("brief")}><Icon name="ChevronLeft" className="size-4" aria-hidden />Back to brief</Button><Button ref={detailClose} size="icon" variant="ghost" aria-label="Close entry" onClick={() => route("brief")}><Icon name="X" className="size-4" aria-hidden /></Button></div>
          {entryRead?.error ? <FailureNotice failure={entryRead.error} onRetry={entryRead.refetch} /> : null}
          {selected && (entryRead?.data?.workstream ?? workstream) ? <KnowledgeDetail entry={selected} workstream={(entryRead?.data?.workstream ?? workstream)!} onOpen={open} actions={<KnowledgeActions entry={selected} workstream={(entryRead?.data?.workstream ?? workstream)!} />} /> : <LoadingRows label="Loading takeaway" />}
        </aside> : <aside data-part="SectionRail" className="grid min-w-0 content-start gap-4"><DraftRailCard section={section} />
          {onDraft ? <Button variant="outline" className="justify-self-start" onClick={event => onDraft(event.currentTarget)}><Icon name="AiContentGenerator01" className="size-4" aria-hidden />Draft from a thread</Button> : null}
          <section data-part="SectionThreads" aria-label="Section threads" className="min-w-0 rounded-md border border-border-seam bg-card"><h2 className="flex items-center justify-between border-b border-border-seam px-3 py-2 text-[13px] font-semibold">Threads<span className="text-muted-foreground tabular-nums">{section.threadCount}</span></h2><ul>{(allThreads ? data.threads : data.threads.slice(0, 7)).map(thread => {
            const native = sidebar.threads.find(row => row.id === thread.id);
            return <li key={thread.id} className="cortex-thread-row flex min-w-0 items-center gap-1 px-2 text-[12px]"><Button variant="ghost" className="min-w-0 flex-1 justify-start px-1" onClick={() => navigate.toThread(thread.id)}><ThreadStatusGlyph indicator={native?.indicator ?? "none"} size="compact" /><span className="min-w-0 truncate" title={thread.name}>{thread.name}</span></Button>{native?.updatedAt ? <span className="shrink-0 text-[11px] text-muted-foreground">{relativeAge(new Date(native.updatedAt).toISOString(), Date.now())}</span> : null}<Button variant="ghost" size="sm" className="cortex-thread-context" aria-label={`Thread context for ${thread.name}`} onClick={() => navigate.toPluginPanel("cortex", { subPath: `threads/${thread.id}` })}>Context</Button></li>;
          })}</ul>{data.threads.length > 7 ? <Button variant="ghost" size="sm" className="m-2" onClick={() => setAllThreads(!allThreads)}>{allThreads ? "Show fewer" : `Show all ${data.threads.length}`}</Button> : null}</section>
        </aside>}
      </div>}
    </>}
    </div>
  </div>;
}

function CaptureRecovery({ section }: { section: Section }) {
  const [offset, setOffset] = useState(0);
  const read = useSectionCaptureJobs(section.id, offset);
  const writes = useWorkstreamWrites();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof failureOf> | null>(null);
  const [saved, setSaved] = useState<Array<{ id: string; workstreamId: string; title: string }>>([]);
  const retry = async (requestId: string) => {
    setBusy(requestId); setFailure(null);
    try {
      const out = await writes.retryCapture(requestId);
      if (out.status === "saved" && out.entry) setSaved(rows => [...rows.filter(row => row.id !== out.entry!.id), { id: out.entry!.id, workstreamId: out.entry!.workstreamId, title: out.entry!.title }]);
      else if (out.error) throw new Error(out.error);
    } catch (cause) { setFailure(failureOf(cause)); }
    finally { setBusy(null); }
  };
  const dismiss = async (requestId: string) => {
    setBusy(requestId); setFailure(null);
    try { await writes.dismissCapture(section.id, requestId); }
    catch (cause) { setFailure(failureOf(cause)); }
    finally { setBusy(null); }
  };
  if (read.data?.total === 0 && !failure && !read.error && saved.length === 0) return null;
  return <section aria-label="Unfinished takeaway saves" className="my-3 grid min-w-0 gap-2 text-[13px]">
    {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
    {failure ? <FailureNotice failure={failure} /> : null}
    {(read.data?.total ?? 0) > 0 ? <><h2 className="font-semibold">Unfinished saves ({read.data!.total})</h2><p className="text-muted-foreground">Original request and source kept. Dismiss removes the retry, not saved knowledge.</p></> : null}
    {(read.data?.jobs ?? []).map(job => <div key={job.requestId} className="grid gap-2 border border-border-seam p-3">
      <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 font-semibold break-words">{job.intent.title}</span><span>{job.status} · {job.intent.mode === "accept" ? "Save and accept requested" : "Save for review requested"}</span></div>
      <Applicability value={job.intent.applicability} />
      {job.error ? <p role="alert">{job.error}</p> : null}
      {section.binding.revision !== job.expectedBindingRevision || section.binding.binding?.workstreamId !== job.workstreamId ? <p role="status">The section connection changed. Retry will not move this save to another workstream.</p> : null}
      <details><summary className="cursor-pointer py-1">Original source</summary><SourceList sources={job.sources} /></details>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy !== null} onClick={() => void retry(job.requestId)}>Retry save</Button><Button variant="ghost" disabled={busy !== null} onClick={() => void dismiss(job.requestId)}>Dismiss retry</Button>{job.knowledgeId ? <Button variant="ghost" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `workstreams/${job.workstreamId}/${job.knowledgeId}` })}>Open saved result</Button> : null}</div>
    </div>)}
    {read.data && read.data.total > 20 ? <div className="flex items-center gap-2"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous saves</Button><span>{offset + 1}–{Math.min(offset + 20, read.data.total)} of {read.data.total}</span><Button variant="outline" disabled={offset + 20 >= read.data.total} onClick={() => setOffset(offset + 20)}>More saves</Button></div> : null}
    {saved.map(row => <Button key={row.id} variant="outline" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `workstreams/${row.workstreamId}/${row.id}` })}>Save confirmed: {row.title}. Open result</Button>)}
  </section>;
}

export function SectionPage({ id = "", tab = "brief", entryId = null, connect = false }: { id?: string; tab?: SectionTab; entryId?: string | null; connect?: boolean }) {
  const read = useSectionDetail(id || null);
  const sections = useSections();
  const workstreams = useWorkstreams();
  const writes = useWorkstreamWrites();
  const navigate = useBbNavigate();
  const [connecting, setConnecting] = useState(connect);
  useEffect(() => {
    if (connect) {
      setConnecting(true);
      navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `sections/${id}/${tab}`, replace: true });
    }
  }, [id, connect, tab, navigate]);
  const [bindingOpen, setBindingOpen] = useState(false);
  const [acceptedId, setAcceptedId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [editing, setEditing] = useState<Knowledge | null>(null);
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof failureOf> | null>(null);
  const data = read.data;
  const editControls = useRef(new Map<string, HTMLButtonElement>());
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const sectionRoot = useRef<HTMLDivElement>(null);
  const scrollport = useRef<HTMLDivElement>(null);
  const draftOpener = useRef<HTMLButtonElement | null>(null);
  const invoking = useRef<{ element: HTMLButtonElement; id: string; index: number } | null>(null);
  const currentReview = useRef(data?.review.items.filter(item => item.entry.state === "candidate") ?? []);
  currentReview.current = data?.review.items.filter(item => item.entry.state === "candidate") ?? [];
  const edit = (entry: Knowledge, opener: HTMLButtonElement) => {
    invoking.current = { element: opener, id: entry.id, index: currentReview.current.findIndex(item => item.entry.id === entry.id) };
    setEditing(entry);
  };
  const restoreReviewFocus = (accepted: boolean) => {
    const origin = invoking.current;
    if (accepted && origin) setAcceptedId(origin.id);
    if (!origin) return;
    const remaining = currentReview.current.filter(item => !accepted || item.entry.id !== origin.id);
    const target = !accepted && origin.element.isConnected ? origin.element : !accepted && editControls.current.get(origin.id) ? editControls.current.get(origin.id) : editControls.current.get(remaining[Math.max(0, origin.index)]?.entry.id ?? "") ?? reviewHeading.current ?? sectionRoot.current;
    target?.focus({ preventScroll: true });
    if (target && scrollport.current?.contains(target)) {
      const pane = scrollport.current;
      const top = pane.getBoundingClientRect().top + pane.clientTop;
      const bottom = top + pane.clientHeight;
      const rect = target.getBoundingClientRect();
      if (rect.top < top) pane.scrollTop += rect.top - top;
      else if (rect.bottom > bottom) pane.scrollTop += rect.bottom - bottom;
    }
    invoking.current = null;
  };
  const mark = async (action: "apply" | "remove") => {
    if (!data) return;
    setFailure(null);
    try { const out = await writes.markSection({ sectionId: id, expectedTitle: data.section.name, action }); if (out.error) throw new Error(out.error); }
    catch (cause) { setFailure(failureOf(cause)); }
  };
  const retry = async () => {
    const requestId = data?.section.connectionJob?.requestId;
    if (!requestId) return;
    try { const out = await writes.retrySection(requestId); if (out.error) throw new Error(out.error); }
    catch (cause) { setFailure(failureOf(cause)); }
  };
  return <div className="flex h-full min-h-0 flex-col">
    {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
    {failure ? <FailureNotice failure={failure} /> : null}
    {!data ? read.error ? null : <LoadingRows label="Loading section context" /> : <>
      <SectionView tab={tab} entryId={entryId} acceptedId={acceptedId} recovery={<CaptureRecovery section={data.section} />} onBinding={() => setBindingOpen(true)} data={data} sections={sections.data?.sections ?? []} workstreams={workstreams.data?.workstreams ?? []} onConnect={() => setConnecting(true)} onCapture={() => setCapturing(true)} onDraft={opener => { draftOpener.current = opener; setDrafting(true); }} onEdit={edit} reviewHeadingRef={reviewHeading} sectionRootRef={sectionRoot} scrollportRef={scrollport} onEditControl={(id, element) => { if (element) editControls.current.set(id, element); else editControls.current.delete(id); }} onStop={() => setStopping(true)} onMark={action => void mark(action)} onRetry={() => void retry()} />
      <BindingDialog target="section" name={data.section.canonicalName} current={data.section.binding.binding} expectedRevision={data.section.binding.revision} workstreams={workstreams.data?.workstreams ?? []} open={bindingOpen} onOpenChange={setBindingOpen} onSave={async (binding, expectedRevision) => {
        const previous = data.section.binding.binding;
        const out = await writes.setSectionBinding({ sectionId: id, expectedRevision, binding });
        if (binding === null && previous) toast("Disconnected for future sessions.", { action: { label: "Undo", onClick: async () => {
          try { await writes.setSectionBinding({ sectionId: id, expectedRevision: out.revision, binding: previous }); toast("Sharing restored for future sessions."); }
          catch (cause) { toast.error(failureOf(cause).message); }
        } } });
        else toast("Saved. Applies to new sessions.");
      }} />
      {connecting ? <ConnectSectionDialog section={data.section} workstreams={workstreams.data?.workstreams ?? []} connections={sections.data?.sections ?? []} onClose={() => setConnecting(false)} /> : null}
      {capturing ? <CaptureDialog section={data.section} seed={{ source: { kind: "manual" }, text: "" }} onClose={() => setCapturing(false)} /> : null}
      <DraftDialog section={data.section} threads={data.threads} open={drafting} onClose={() => setDrafting(false)} onReturnFocus={() => {
        const target = draftOpener.current?.isConnected ? draftOpener.current : sectionRoot.current;
        target?.focus({ preventScroll: true });
        const pane = scrollport.current;
        if (target && pane?.contains(target)) {
          const top = pane.getBoundingClientRect().top + pane.clientTop;
          const bottom = top + pane.clientHeight;
          const rect = target.getBoundingClientRect();
          if (rect.top < top) pane.scrollTop += Math.floor(rect.top - top);
          else if (rect.bottom > bottom) pane.scrollTop += Math.ceil(rect.bottom - bottom);
        }
      }} />
      {editing ? <CandidateDialog entry={data.review.items.find(item => item.entry.id === editing.id)?.entry ?? editing} section={data.section} onClose={() => setEditing(null)} onReturnFocus={restoreReviewFocus} /> : null}
      <ConfirmDialog title="Stop sharing context in this section?" facts={[{ icon: "Brain", text: "New sessions stop inheriting this workstream." }, { icon: "Archive", text: "The canonical brief stays available to other connected sections." }, { icon: "MessageSquare", text: "Running sessions are not changed." }]} confirm="Stop sharing" open={stopping} onOpenChange={setStopping} onConfirm={async () => {
        await writes.setSectionBinding({ sectionId: id, expectedRevision: data.section.binding.revision, binding: null });
        toast("Sharing stopped. The canonical brief was kept.");
      }} />
    </>}
  </div>;
}
