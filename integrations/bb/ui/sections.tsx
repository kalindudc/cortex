import { type Ref, useRef, useState } from "react";
import { experimental_ThreadStatusGlyph as ThreadStatusGlyph, experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectionJob, ConnectInput, Section } from "../section-contract";
import { failureOf, type OutputOf, useSectionCaptureJobs, useSectionDetail, useSections, useWorkstreams, useWorkstreamWrites } from "./data";
import { ConfirmDialog } from "./dialogs";
import { Applicability, ApprovalLine, EmptyNote, FailureNotice, LoadingRows, Segmented, SourceList } from "./parts";
import { plural } from "./copy";
import { CandidateDialog, CaptureDialog, knownWhere, WhereChoice } from "./takeaway";
import { CORTEX_PAGE_PATH } from "./thread-context";
import { DraftDialog, DraftJobs } from "./drafting";
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
    <DialogHeader><DialogTitle>Share context in {section.canonicalName}</DialogTitle><DialogDescription>Connect once. New threads in this section automatically get accepted, applicable context. No old conversations are imported or sent to running sessions.</DialogDescription></DialogHeader>
    <Segmented label="Workstream choice" value={choice} options={[{ value: "create", label: "New workstream" }, { value: "reuse", label: "Use existing" }]} onChange={setChoice} />
    {choice === "create" ? <label className="grid gap-1 text-[13px]">Workstream name<Input value={name} onChange={event => setName(event.target.value)} className="text-[16px] sm:text-[13px]" /></label> : null}
    {choice === "reuse" ? <div className="grid gap-2">
      {workstreams.filter(workstream => !workstream.archived).map(workstream => <button type="button" key={workstream.id} aria-pressed={selected === workstream.id} onClick={() => setSelected(workstream.id)} className="grid min-h-11 gap-1 rounded-md border border-border-seam p-3 text-left text-[13px] hover:bg-state-hover aria-pressed:bg-surface-selected focus-visible:ring-1 focus-visible:ring-ring">
        <span className="font-semibold">{workstream.name}</span><span>{connections.filter(row => row.binding.binding?.workstreamId === workstream.id).map(row => row.canonicalName).join(", ") || "Not connected to another section"}</span>
      </button>)}
      {existing ? <p className="text-[13px]">Uses the same canonical brief. Changes are shared with its other connected sections.</p> : <p role="status" className="text-[13px]">Choose the workstream to share.</p>}
    </div> : null}
    <p className="flex items-start gap-2 text-[13px]"><Icon name="Brain" className="size-4 shrink-0" aria-hidden /><span>Cortex shows connected sections with this icon. It does not verify provider use.</span></p>
    {failure ? <FailureNotice failure={failure} /> : null}
    {job?.error ? <p role="alert">{job.error}</p> : null}
    {intent ? <div className="grid gap-2 text-[13px]"><p>Connection not confirmed. Retry keeps the intended workstream and request; it does not create a second workstream.</p><Button variant="outline" disabled={busy} onClick={() => void retry()}>Retry connection</Button></div> : null}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || intent !== null || choice === "" || (choice === "create" ? !name.trim() : !existing)} onClick={() => void submit()}>Share context</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function ReviewCard({ item, section, onEdit, editRef }: { item: ReviewItem; section: Section; onEdit: (opener: HTMLButtonElement) => void; editRef: (element: HTMLButtonElement | null) => void }) {
  const writes = useWorkstreamWrites();
  const [whereDraft, setWhereDraft] = useState({ revision: item.entry.revision, value: item.entry.applicability });
  const where = whereDraft.revision === item.entry.revision ? whereDraft.value : item.entry.applicability;
  const [busy, setBusy] = useState(false);
  const [failed, setFailure] = useState<{ revision: number; value: ReturnType<typeof failureOf> } | null>(null);
  const failure = failed?.revision === item.entry.revision ? failed.value : null;
  const act = async (accept: boolean) => {
    setBusy(true); setFailure(null);
    try {
      if (accept) await writes.acceptCandidate({ sectionId: section.id, expectedBindingRevision: section.binding.revision, id: item.entry.id, expectedRevision: item.entry.revision, applicability: where, reason: "Accepted by the person in Cortex" });
      else await writes.transition({ id: item.entry.id, expectedRevision: item.entry.revision, state: "rejected", reason: "Rejected by the person in Cortex" });
    } catch (cause) { setFailure({ revision: item.entry.revision, value: failureOf(cause) }); }
    finally { setBusy(false); }
  };
  return <section aria-label={item.entry.title} className="cortex-review-item grid gap-3 border-l-2 border-attention bg-surface-attention p-3 text-[13px]">
    <div className="flex flex-wrap items-baseline gap-2"><h3 className="min-w-0 flex-1 font-semibold break-words">{item.entry.title}</h3><span>Not accepted · revision {item.entry.revision}</span></div>
    <p data-content className="line-clamp-3 whitespace-pre-wrap break-words">{item.entry.text}</p>
    <SourceList sources={item.entry.sources} />
    <WhereChoice key={item.entry.revision} value={where} onChange={value => setWhereDraft({ revision: item.entry.revision, value })} />
    {failure ? <FailureNotice failure={failure} /> : null}
    <div className="flex flex-wrap gap-2"><Button disabled={busy || !knownWhere(where)} onClick={() => void act(true)}>{item.entry.kind === "directive" ? "Adopt rule" : "Accept"}</Button><Button ref={editRef} variant="outline" onClick={event => onEdit(event.currentTarget)}>Edit</Button><Button variant="ghost" disabled={busy} onClick={() => void act(false)}>Reject</Button></div>
  </section>;
}

export function SectionView({ data, sections, workstreams, onConnect, onCapture, onEdit, onStop, onMark, onRetry, onDraft, reviewHeadingRef, sectionRootRef, scrollportRef, onEditControl }: { data: OutputOf<"sectionDetail">; sections: Section[]; workstreams: Workstream[]; onConnect: () => void; onCapture: () => void; onEdit: (entry: Knowledge, opener: HTMLButtonElement) => void; onStop: () => void; onMark: (action: "remove") => void; onRetry: () => void; onDraft?: (opener: HTMLButtonElement) => void; reviewHeadingRef?: Ref<HTMLHeadingElement>; sectionRootRef?: Ref<HTMLDivElement>; scrollportRef?: Ref<HTMLDivElement>; onEditControl?: (id: string, element: HTMLButtonElement | null) => void }) {
  const navigate = useBbNavigate();
  const sidebar = experimental_useSidebarThreads();
  const section = data.section;
  const bound = section.binding.binding !== null;
  const workstreamId = section.binding.binding?.workstreamId;
  const workstream = workstreams.find(workstream => workstream.id === workstreamId);
  const candidates = data.review.items.filter(item => item.entry.state === "candidate");
  const sharedWith = sections.filter(row => row.id !== section.id && row.binding.binding?.workstreamId === workstreamId && workstreamId);
  const advanced = <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" aria-label="Advanced section actions"><Icon name="MoreHorizontal" className="size-4" aria-hidden />Advanced</Button></DropdownMenuTrigger><DropdownMenuContent align="end" mobileTitle="Advanced section actions">
    {bound ? <><DropdownMenuItem onSelect={onConnect}>Change workstream…</DropdownMenuItem><DropdownMenuItem onSelect={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `workstreams/${workstreamId}` })}>Topics, budget, targets, history and archive…</DropdownMenuItem></> : null}
    {section.marker.status === "owned" ? <DropdownMenuItem onSelect={() => onMark("remove")}>Remove title mark</DropdownMenuItem> : null}
    {bound ? <DropdownMenuItem onSelect={onStop}>Stop sharing…</DropdownMenuItem> : null}
    {section.marker.error && section.marker.originalTitle !== null && section.marker.decoratedTitle !== null ? <DropdownMenuItem onSelect={() => onMark("remove")}>Retry title cleanup</DropdownMenuItem> : null}
    <DropdownMenuItem onSelect={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: "bindings" })}>Connections and legacy settings…</DropdownMenuItem><DropdownMenuItem onSelect={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: "library" })}>Library and advanced knowledge actions…</DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
  return <div ref={sectionRootRef} tabIndex={-1} aria-label={`Cortex section: ${section.canonicalName}`} data-cortex-section="" className="cortex-section flex min-h-0 h-full flex-col text-foreground">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-seam px-4 py-3">
      <Icon name="Brain" className="size-4" aria-hidden /><span className="text-[13px] font-semibold">{bound ? `Sharing ${workstream?.name ?? "a workstream"}` : "Not shared"}</span><span className="text-[13px]">{plural(section.threadCount, "thread")}</span><span className="flex-1" /><TooltipProvider><Tooltip><TooltipTrigger asChild><Button variant="outline" aria-label={`New thread in ${section.canonicalName}`} onClick={() => navigate.toCompose({ placement: { sectionId: section.id, pinned: false }, focusPrompt: true })}>New thread</Button></TooltipTrigger><TooltipContent>Opens the native composer in this section without replacing your draft.</TooltipContent></Tooltip></TooltipProvider>{bound ? <Button variant="outline" onClick={onConnect}>Change…</Button> : null}{advanced}
    </div>
    <div ref={scrollportRef} className="min-h-0 flex-1 overflow-y-auto p-4">
      <DraftJobs section={section} />
      {section.connectionJob && section.connectionJob.status !== "connected" ? <div role="alert" className="mb-4 grid gap-2 border border-border-seam p-3 text-[13px]"><p>{section.connectionJob.error ?? "Connection pending. The workstream is retained."}</p><Button variant="outline" onClick={onRetry}>Retry connection</Button></div> : null}
      {section.marker.error ? <div role="alert" className="mb-4 text-[13px]">Sharing and section titles are separate. {section.marker.error} {section.marker.originalTitle !== null && section.marker.decoratedTitle !== null ? "Use Advanced to retry title cleanup." : "No native title decoration will be applied."}</div> : null}
      {!bound ? <section className="grid max-w-xl gap-4 py-6"><h2 className="text-lg font-semibold">One shared brief for this section</h2><p className="text-[13px]">Connect a new or existing workstream. New threads automatically get accepted context that applies here.</p><Button className="justify-self-start" onClick={onConnect}>Share context in this section</Button></section> : <>
        <div role="group" aria-label="Context for new sessions" className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]"><span><Icon name="ArrowRight" className="mr-1 inline size-3.5" aria-hidden />New threads: {plural(data.eligibility.entries.length, "eligible takeaway")}</span><span>{plural(data.eligibility.notices.length, "held notice")}</span><span>Preview, not a delivery receipt</span></div>
        {data.eligibility.error ? <p role="alert" className="mb-4 text-[13px]">{data.eligibility.error}</p> : null}
        <h2 ref={reviewHeadingRef} tabIndex={-1} className={candidates.length > 0 ? "mb-3 flex items-center gap-2 text-sm font-semibold" : "sr-only"}>{candidates.length > 0 ? <><Icon name="CircleDot" className="size-4" aria-hidden />Waiting for your review</> : "Takeaway review"}</h2>
        {candidates.length > 0 ? <section aria-label="Waiting for your review" className="mb-5 grid gap-3">{candidates.map(item => <ReviewCard key={item.entry.id} item={item} section={section} editRef={element => onEditControl?.(item.entry.id, element)} onEdit={opener => onEdit(item.entry, opener)} />)}</section> : null}
        {data.review.total > data.review.items.filter(item => item.entry.state === "candidate").length ? <Button variant="outline" className="mb-4" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: "" })}>Disputes, rechecks and more review items…</Button> : null}
        <div className="cortex-section-columns grid gap-6">
          <section aria-label="Shared brief" className="min-w-0"><div className="mb-3 flex flex-wrap items-center gap-2"><h2 className="flex-1 text-sm font-semibold">Shared brief</h2>{onDraft ? <Button variant="outline" onClick={event => onDraft(event.currentTarget)}><Icon name="Sparkles" className="size-4" aria-hidden />Draft from a thread</Button> : null}<Button onClick={onCapture}><Icon name="BookmarkPlus" className="size-4" aria-hidden />Write takeaway</Button></div>
            {data.eligibility.entries.length === 0 ? <EmptyNote>Nothing accepted and applicable yet. Save a message from a section thread, or write a takeaway.</EmptyNote> : <ul className="grid gap-3">{data.eligibility.entries.map(row => <li key={row.knowledge.id} className="border-t border-border-seam pt-3"><div className="flex items-start gap-2"><Icon name={row.knowledge.kind === "directive" ? "ListTodo" : "Bookmark"} className="size-4 shrink-0" aria-hidden /><span className="text-[13px] font-semibold break-words">{row.knowledge.title}</span></div><p data-content className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[13px]">{row.text}</p><ApprovalLine entry={row.knowledge} /><details className="mt-1 text-[13px]"><summary className="cursor-pointer py-1">Source and full takeaway</summary><p data-content className="my-2 whitespace-pre-wrap break-words">{row.text}</p><SourceList sources={row.knowledge.sources} /><Button variant="outline" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `workstreams/${workstreamId}/${row.knowledge.id}` })}>Edit, history and advanced actions…</Button></details></li>)}</ul>}
            {sharedWith.length > 0 ? <p className="mt-3 text-[13px]">Same canonical brief also used by {sharedWith.map(row => row.canonicalName).join(", ")}.</p> : null}
            {data.eligibility.notices.length > 0 ? <details className="mt-3 text-[13px]"><summary className="cursor-pointer py-1">Held notices ({data.eligibility.notices.length})</summary>{data.eligibility.notices.map(notice => <p key={notice.id}>{notice.reason}</p>)}</details> : null}
          </section>
          <section aria-label="Section threads" className="min-w-0"><h2 className="mb-3 text-sm font-semibold">Threads</h2><ul className="grid min-w-0 grid-cols-1 gap-1">{data.threads.map(thread => <li key={thread.id} className="min-w-0"><button type="button" className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring" onClick={() => navigate.toThread(thread.id)}><ThreadStatusGlyph indicator={sidebar.threads.find(row => row.id === thread.id)?.indicator ?? "none"} size="compact" /><span className="min-w-0 truncate" title={thread.name}>{thread.name}</span></button></li>)}</ul><p className="mt-3 text-[13px]">Existing sessions are not refreshed. A prepared context record does not verify provider use.</p></section>
        </div>
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
  return <section aria-label="Unfinished takeaway saves" className="mx-4 my-3 grid gap-2 text-[13px]">
    {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
    {failure ? <FailureNotice failure={failure} /> : null}
    {(read.data?.total ?? 0) > 0 ? <><h2 className="font-semibold">Unfinished saves ({read.data!.total})</h2><p>Retry keeps the original request, workstream and source. Dismiss removes this retry, not any saved takeaway.</p></> : null}
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

export function SectionPage({ id }: { id: string }) {
  const read = useSectionDetail(id);
  const sections = useSections();
  const workstreams = useWorkstreams();
  const writes = useWorkstreamWrites();
  const [connecting, setConnecting] = useState(false);
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
      <CaptureRecovery section={data.section} />
      <SectionView data={data} sections={sections.data?.sections ?? []} workstreams={workstreams.data?.workstreams ?? []} onConnect={() => setConnecting(true)} onCapture={() => setCapturing(true)} onDraft={opener => { draftOpener.current = opener; setDrafting(true); }} onEdit={edit} reviewHeadingRef={reviewHeading} sectionRootRef={sectionRoot} scrollportRef={scrollport} onEditControl={(id, element) => { if (element) editControls.current.set(id, element); else editControls.current.delete(id); }} onStop={() => setStopping(true)} onMark={action => void mark(action)} onRetry={() => void retry()} />
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
