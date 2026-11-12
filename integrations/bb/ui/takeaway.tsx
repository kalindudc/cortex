import { type Ref, useEffect, useId, useRef, useState } from "react";
import { type ExperimentalThreadActionTabProps, experimental_useSidebarThreads, type PluginMessageActionRegistration, type ExperimentalPanelController } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { captureSourceSchema, type CaptureInput, type CaptureJob, type Section } from "../section-contract";
import { failureOf, type RpcFailure, useKnowledgeEntries, useSectionDetail, useWorkstreamWrites } from "./data";
import { KNOWLEDGE_SOURCE_EXCERPT_MAX } from "../workstream-contract";
import { FailureNotice, LoadingRows, Segmented, SourceList } from "./parts";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DimensionEditor } from "./dialogs";
import { KindMark } from "./marks";
import { tokens } from "./copy";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Knowledge, ReviewItem } from "./types";

export const TAKEAWAY_TAB_ID = "cortex-takeaway";
export const unknownWhere = (): Knowledge["applicability"] => ({ environment: { mode: "unknown" }, host: { mode: "unknown" } });
export const knownWhere = (value: Knowledge["applicability"]) => value.environment.mode !== "unknown" && value.host.mode !== "unknown";

export function WhereChoice({ value, onChange, compact = false }: { value: Knowledge["applicability"]; onChange: (value: Knowledge["applicability"]) => void; compact?: boolean }) {
  const id = useId();
  const [naming, setNaming] = useState(false);
  const choice = naming ? "named" : !knownWhere(value) ? "unknown" : value.environment.mode === "not-applicable" && value.host.mode === "not-applicable" ? "all" : "named";
  if (compact) return <div className="cortex-candidate-targets flex min-w-0 flex-wrap items-center gap-2 text-[12px]">
    <span>Applies to</span>
    {(["environment", "host"] as const).map(name => <details key={name} className="min-w-0">
      <summary className={`cursor-pointer rounded-sm border px-2 py-1 focus-visible:ring-1 focus-visible:ring-ring ${value[name].mode === "unknown" ? "border-dashed border-warning/60 text-warning-text" : "border-border-seam"}`}>
        {name === "environment" ? "Environment" : "Host"} {value[name].mode === "unknown" ? "?" : value[name].mode === "value" ? value[name].value : "· any"}
      </summary>
      <div className="py-2"><DimensionEditor name={name} label={name === "environment" ? "Environment" : "Host or cluster"} value={value[name]} onChange={next => onChange({ ...value, [name]: next })} /></div>
    </details>)}
    <Button size="sm" variant="outline" aria-pressed={value.environment.mode === "not-applicable" && value.host.mode === "not-applicable"} onClick={() => onChange({ environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } })}>Everywhere</Button>
  </div>;
  return <div className="flex flex-col gap-2">
    <span className="text-[13px] font-semibold">Where it applies</span>
    <Segmented label="Where it applies" value={choice} options={[{ value: "unknown", label: "Not chosen" }, { value: "all", label: "Everywhere" }, { value: "named", label: "Environment or host" }]} onChange={next => { setNaming(next === "named"); onChange(next === "all" ? { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } } : unknownWhere()); }} />
    {choice === "named" || !knownWhere(value) ? <details open={naming || undefined} className="text-[13px]">
      <summary className="cursor-pointer py-1">Choose an environment or host</summary>
      <div className="mt-2 grid gap-2">
        {(["environment", "host"] as const).map(name => <label key={name} htmlFor={`${id}-${name}`} className="grid gap-1">
          {name === "environment" ? "Environment" : "Host or cluster"}
          <Input id={`${id}-${name}`} className="text-[16px] sm:text-[13px]" value={value[name].mode === "value" ? value[name].value : ""} placeholder="Leave empty if it does not apply" onChange={event => {
            const text = event.target.value.trim();
            const other = name === "environment" ? "host" : "environment";
            onChange({ ...value, [name]: text ? { mode: "value", value: text } : { mode: "not-applicable" }, [other]: value[other].mode === "unknown" ? { mode: "not-applicable" } : value[other] });
          }} />
        </label>)}
      </div>
    </details> : null}
  </div>;
}

export function SuggestionCard({ item, section, onEdit, editRef, onAccepted, accepted = false }: { item: ReviewItem; accepted?: boolean; section: Section; onEdit: (opener: HTMLButtonElement) => void; editRef: (element: HTMLButtonElement | null) => void; onAccepted: (entry: Knowledge) => void }) {
  const writes = useWorkstreamWrites();
  const hintId = useId();
  const navigate = useBbNavigate();
  const sidebar = experimental_useSidebarThreads();
  const [whereDraft, setWhereDraft] = useState({ revision: item.entry.revision, value: item.entry.applicability });
  const where = whereDraft.revision === item.entry.revision ? whereDraft.value : item.entry.applicability;
  const [busy, setBusy] = useState(false);
  const [failed, setFailure] = useState<{ revision: number; value: ReturnType<typeof failureOf> } | null>(null);
  const failure = failed?.revision === item.entry.revision ? failed.value : null;
  const source = item.entry.sources[0];
  const sourceThread = source?.ref.match(/^(?:@thread:)?(thr_[a-z0-9]+)(?:#|$)/)?.[1];
  const act = async (accept: boolean) => {
    setBusy(true); setFailure(null);
    try {
      if (accept) {
        const out = await writes.acceptCandidate({ sectionId: section.id, expectedBindingRevision: section.binding.revision, id: item.entry.id, expectedRevision: item.entry.revision, applicability: where, reason: "Accepted by the person in Cortex" });
        if (out.entry) onAccepted(out.entry);
        toast("Accepted for new sessions. Running sessions keep their context.");
      } else {
        await writes.transition({ id: item.entry.id, expectedRevision: item.entry.revision, state: "rejected", reason: "Rejected by the person in Cortex" });
        toast("Rejected. Threads never get it.");
      }
    } catch (cause) { setFailure({ revision: item.entry.revision, value: failureOf(cause) }); }
    finally { setBusy(false); }
  };
  return <section data-cortex data-part="SuggestionCard" aria-label={item.entry.title} className="cortex-review-item grid min-w-0 gap-2 rounded-md border border-border-seam border-l-2 border-l-attention bg-card p-3 text-[13px]">
    <div className="flex items-center gap-2 text-muted-foreground"><KindMark kind={item.entry.kind} /><span>Suggested · text {tokens(Math.ceil(item.entry.text.length / 4))} tokens</span><span className="flex-1" /><Button variant="ghost" size="icon" aria-label="Open in Review" onClick={() => navigate.toPluginPanel("cortex", { subPath: "review" })}><Icon name="ExternalLink" className="size-3.5" aria-hidden /></Button></div>
    <h3 className="font-semibold break-words">{item.entry.title}</h3>
    <p data-content className="line-clamp-2 whitespace-pre-wrap break-words">{item.entry.text}</p>
    {source ? <div className="min-w-0 border-l-2 border-border-seam bg-surface-recessed px-2 py-1 text-[12px]">
      <div className="flex min-w-0 items-center gap-1 text-muted-foreground"><Icon name={source.authorType === "agent" ? "Bot" : "UserRound"} className="size-3 shrink-0" aria-hidden /><span>{source.authorType === "agent" ? "Agent" : source.authorType === "human" ? "Human" : "Unknown author"}</span>
        {sourceThread ? <Button variant="link" className="min-w-0 truncate p-0 text-[12px]" onClick={() => navigate.toThread(sourceThread)}>{sidebar.threads.find(thread => thread.id === sourceThread)?.title ?? "Source thread"}</Button> : <span>· source attached</span>}
      </div>{source.excerpt ? <blockquote data-content className="line-clamp-1 break-words">{source.excerpt}</blockquote> : null}
    </div> : null}
    {failure ? <FailureNotice failure={failure} /> : null}
    {!knownWhere(where) ? <p id={hintId} className="text-[12px] text-warning-text">Choose environment and host first</p> : null}
    <div className="flex min-w-0 flex-wrap items-center gap-2"><WhereChoice compact value={where} onChange={value => setWhereDraft({ revision: item.entry.revision, value })} />
      <TooltipProvider><Tooltip><TooltipTrigger asChild><span><Button aria-describedby={!knownWhere(where) ? hintId : undefined} disabled={busy || accepted || !knownWhere(where)} onClick={() => void act(true)}>{item.entry.kind === "directive" ? "Adopt rule" : "Accept"}</Button></span></TooltipTrigger><TooltipContent>{knownWhere(where) ? "New sessions only" : "Choose environment and host first"}</TooltipContent></Tooltip></TooltipProvider>
      <Button ref={editRef} variant="outline" disabled={busy || accepted} onClick={event => onEdit(event.currentTarget)}>Edit</Button><Button variant="ghost" disabled={busy || accepted} onClick={() => void act(false)}>Reject</Button>
    </div>
  </section>;
}

function TextFields({ title, text, setTitle, setText, textRef }: { title: string; text: string; setTitle: (value: string) => void; setText: (value: string) => void; textRef?: Ref<HTMLTextAreaElement> }) {
  const id = useId();
  return <>
    <label htmlFor={`${id}-title`} className="grid gap-1 text-[13px] font-semibold">Title<Input id={`${id}-title`} value={title} onChange={event => setTitle(event.target.value)} className="text-[16px] sm:text-[13px] font-normal" /></label>
    <label htmlFor={`${id}-text`} className="grid gap-1 text-[13px] font-semibold">Text<Textarea ref={textRef} id={`${id}-text`} value={text} onChange={event => setText(event.target.value)} rows={5} className="text-[16px] sm:text-[13px] font-normal" /></label>
  </>;
}

export function CandidateDialog({ entry, section, onClose, onReturnFocus }: { entry: Knowledge; section: Section; onClose: () => void; onReturnFocus?: (accepted: boolean) => void }) {
  const [open, setOpen] = useState(true);
  const accepted = useRef(false);
  const writes = useWorkstreamWrites();
  const read = useKnowledgeEntries([entry.id])[0]!;
  const [base, setBase] = useState(entry);
  const [title, setTitle] = useState(entry.title);
  const [text, setText] = useState(entry.text);
  const [where, setWhere] = useState(entry.applicability);
  const [kind, setKind] = useState(entry.kind);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof failureOf> | null>(null);
  const current = read.data?.entry && read.data.entry.revision > entry.revision ? read.data.entry : entry;
  const newer = current.revision > base.revision ? current : null;
  const bindingChanged = section.binding.binding?.workstreamId !== entry.workstreamId;
  const reviewEnded = current.state !== "candidate";
  const save = async (accept: boolean) => {
    if (newer || bindingChanged || reviewEnded || busy) return;
    setBusy(true); setFailure(null);
    try {
      const input = { sectionId: section.id, expectedBindingRevision: section.binding.revision, id: base.id, expectedRevision: base.revision, title: title.trim(), text: text.trim(), reason: accept ? "Accepted by the person in Cortex" : "Edited by the person in Cortex" };
      if (accept) await writes.acceptCandidate({ ...input, applicability: where, kind });
      else await writes.editCandidate({ ...input, applicability: where, kind });
      toast(accept ? "Takeaway accepted for new sessions. Running sessions were not changed." : "Saved for review. Not accepted.");
      accepted.current = accept;
      setOpen(false);
    } catch (cause) { setFailure(failureOf(cause)); read.refetch(); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) setOpen(false); }}>
    <DialogContent className="max-w-xl" data-cortex-takeaway="" onEscapeKeyDown={event => event.stopPropagation()} onCloseAutoFocus={event => event.preventDefault()} onAfterCloseAutoFocus={() => { onClose(); queueMicrotask(() => onReturnFocus?.(accepted.current)); }}>
      <DialogHeader><DialogTitle>Edit takeaway</DialogTitle><DialogDescription>Revision {base.revision} · original source kept</DialogDescription></DialogHeader>
      <fieldset disabled={busy} className="grid gap-4">
        <TextFields title={title} text={text} setTitle={setTitle} setText={setText} />
        <WhereChoice value={where} onChange={setWhere} />
        <Segmented label="Kind" value={kind} options={[{ value: "finding", label: "Takeaway" }, { value: "directive", label: "Rule to follow" }]} onChange={setKind} />
      </fieldset>
      <SourceList sources={base.sources} />
      {newer ? <div role="status" className="grid gap-2 border border-border-seam bg-surface-attention p-3 text-[13px]">
        <p>A newer version is available (revision {newer.revision}). Your draft was not saved.</p>
        <blockquote data-content className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{newer.text}</blockquote>
        {!reviewEnded ? <p>Your next save will replace the newer version with your draft text. It does not merge them.</p> : null}
        <Button variant="outline" disabled={reviewEnded} onClick={() => { setBase(newer); setFailure(null); }}>Keep my draft copy</Button>
      </div> : null}
      {reviewEnded ? <p role="alert">This takeaway is no longer waiting for review. Your draft is kept; use its saved page for further changes.</p> : null}
      {bindingChanged ? <p role="alert">This section changed workstream. Your draft is kept; return to the original workstream to save it.</p> : null}
      {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
      {failure ? <FailureNotice failure={failure} /> : null}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="outline" disabled={busy || newer !== null || bindingChanged || reviewEnded || !title.trim() || !text.trim()} onClick={() => void save(false)}>Save for review</Button>
        <Button disabled={busy || newer !== null || bindingChanged || reviewEnded || !knownWhere(where) || !title.trim() || !text.trim()} onClick={() => void save(true)}>{kind === "directive" ? "Save and adopt rule" : "Save and accept"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export type CaptureSeed = { source: CaptureInput["source"]; text: string };
const isCapturePreflightRefusal = (failure: RpcFailure) => failure.code === "invalid_input" || (failure.code === "invalid" && failure.issuesComplete === true && !!failure.issues?.length && failure.issues.every(issue => issue.path[0] === "source"));
export function CaptureDialog({ section, seed, onClose }: { section: Section; seed: CaptureSeed; onClose: () => void }) {
  const compact = useIsCompactViewport();
  const writes = useWorkstreamWrites();
  const [bindingRevision] = useState(section.binding.revision);
  const [workstreamId] = useState(section.binding.binding?.workstreamId);
  const [title, setTitle] = useState(seed.text.split("\n")[0]?.slice(0, 120) ?? "");
  const [text, setText] = useState(seed.text);
  const [where, setWhere] = useState(unknownWhere);
  const [kind, setKind] = useState<Knowledge["kind"]>("finding");
  const [source, setSource] = useState(seed.source);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const originalQuote = seed.source.kind === "message" ? seed.source.quote ?? seed.text : "";
  const [quote, setQuote] = useState(originalQuote);
  const [quoteEditing, setQuoteEditing] = useState(false);
  const quoteId = useId();
  const [preflightRejected, setPreflightRejected] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [intent, setIntent] = useState<CaptureInput | null>(null);
  const [job, setJob] = useState<CaptureJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof failureOf> | null>(null);
  const changed = section.binding.revision !== bindingRevision || section.binding.binding?.workstreamId !== workstreamId;
  const quoteValid = !quoteEditing || (quote.length > 0 && quote.length <= KNOWLEDGE_SOURCE_EXCERPT_MAX && originalQuote.includes(quote));
  const fail = (cause: unknown) => {
    const out = failureOf(cause);
    setFailure(out);
    if (!uncertain && job === null && isCapturePreflightRefusal(out)) {
      setIntent(null);
      setPreflightRejected(true);
    } else setUncertain(true);
  };
  const finish = (out: CaptureJob) => {
    setJob(out);
    if (out.status === "saved") { toast(source.kind === "manual" ? "Saved as a manual note. No message source claimed. Running sessions were not changed." : "Saved with its original source. Running sessions were not changed."); onClose(); }
  };
  const save = async (mode: CaptureInput["mode"]) => {
    if (busy || changed || intent || !quoteValid) return;
    const input: CaptureInput = { requestId: crypto.randomUUID(), sectionId: section.id, expectedBindingRevision: bindingRevision, source: source.kind === "message" && quoteEditing ? { ...source, quote } : source, title: title.trim(), text: text.trim(), applicability: where, mode, kind, reason: mode === "accept" ? "Accepted by the person in Cortex" : "Saved for review in Cortex" };
    setIntent(input); setPreflightRejected(false); setBusy(true); setFailure(null);
    try { finish(await writes.capture(input)); }
    catch (cause) { fail(cause); }
    finally { setBusy(false); }
  };
  const retry = async () => {
    if (!intent || busy) return;
    setBusy(true); setFailure(null);
    try { finish(job ? await writes.retryCapture(intent.requestId) : await writes.capture(intent)); }
    catch (cause) { fail(cause); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className={compact ? "max-w-xl" : "max-w-xl flex flex-col"} style={compact ? undefined : { maxHeight: "calc(100dvh - 2rem)" }} data-cortex-takeaway="">
      <DialogHeader className="shrink-0"><DialogTitle>Save as takeaway</DialogTitle><DialogDescription>{section.canonicalName} · new sessions only</DialogDescription></DialogHeader>
      <div data-cortex-capture-scroll="" className={compact ? "contents" : "grid min-h-0 gap-4 overflow-y-auto"} onFocus={event => {
        if (compact) return;
        const pane = event.currentTarget;
        const bounds = pane.getBoundingClientRect();
        const top = bounds.top + pane.clientTop;
        const bottom = Math.min(bounds.bottom, top + pane.clientHeight);
        const rect = event.target.getBoundingClientRect();
        if (rect.top < top) pane.scrollTop = Math.floor(pane.scrollTop + rect.top - top);
        else if (rect.bottom > bottom) pane.scrollTop = Math.ceil(pane.scrollTop + rect.bottom - bottom);
      }}>
      <fieldset disabled={intent !== null} className="grid gap-4">
        <TextFields title={title} text={text} setTitle={setTitle} setText={setText} textRef={textRef} />
        <WhereChoice value={where} onChange={setWhere} />
        <Segmented label="Kind" value={kind} options={[{ value: "finding", label: "Takeaway" }, { value: "directive", label: "Rule to follow" }]} onChange={setKind} />
        {source.kind === "message" && quoteEditing ? <div className="grid gap-1 text-[13px]"><label htmlFor={quoteId}>Exact source quote</label><Textarea autoFocus id={quoteId} value={quote} rows={3} aria-describedby={`${quoteId}-hint`} onChange={event => setQuote(event.target.value)} /><p id={`${quoteId}-hint`}>Use an exact passage from the original source, at most {KNOWLEDGE_SOURCE_EXCERPT_MAX.toLocaleString()} characters. It is verified when saved.</p></div> : null}
      </fieldset>
      <div className="border-l-2 border-border-seam pl-3 text-[13px]" data-content>
        {source.kind === "message" ? <><p>Original source: {source.threadId} · message {source.messageSeq}</p><blockquote className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words">{originalQuote}</blockquote><p>The source and selected quote are verified when saved.</p></> : <p>Written by you · no message source</p>}
      </div>
      {changed ? <p role="alert">The section connection changed. Your text is kept; close and choose the intended workstream before saving.</p> : null}
      {failure ? <FailureNotice failure={failure} /> : null}
      {job?.error ? <p role="alert">{job.error}</p> : null}
      {job?.status === "no-save" ? <p role="status">Nothing new was saved. The existing canonical takeaway was kept.</p> : null}
      {preflightRejected ? <div role="status" className="grid gap-2 text-[13px]"><p>This request was refused before a save job was created. Your draft and original source are kept. Changes stay here until you save.</p>{source.kind === "message" ? <div className="flex flex-wrap gap-2">{!quoteEditing ? <Button variant="outline" onClick={() => { setQuoteEditing(true); setFailure(null); }}>Use a shorter exact quote</Button> : null}<Button variant="outline" onClick={() => { setSource({ kind: "manual", threadId: source.threadId }); setQuoteEditing(false); setPreflightRejected(false); setFailure(null); queueMicrotask(() => textRef.current?.focus({ preventScroll: true })); }}>Use a manual note instead</Button></div> : null}</div> : null}
      {intent && job?.status !== "no-save" ? <div className="grid gap-2 text-[13px]"><p>{failure && isCapturePreflightRefusal(failure) ? "This refusal does not settle the earlier save outcome. Retry keeps its original request and source." : "The save outcome is pending or failed. Retry uses the same request and cannot create a second takeaway."}</p><Button variant="outline" disabled={busy} onClick={() => void retry()}>Retry save</Button></div> : null}
      </div>
      <DialogFooter className="shrink-0"><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="outline" disabled={busy || changed || intent !== null || !quoteValid || !title.trim() || !text.trim()} onClick={() => void save("review")}>Save for review</Button><Button disabled={busy || changed || intent !== null || !quoteValid || !knownWhere(where) || !title.trim() || !text.trim()} onClick={() => void save("accept")}>{kind === "directive" ? "Save and adopt rule" : "Save and accept"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function openTakeaway(panel: Pick<ExperimentalPanelController, "openTab">, seed?: CaptureSeed): boolean {
  return panel.openTab({ tab: { id: TAKEAWAY_TAB_ID, context: { kind: "thread" }, availability: "action" }, ...(seed ? { params: { source: seed.source, text: seed.text } } : {}) });
}

export const saveMessageAction: PluginMessageActionRegistration = {
  id: "cortex-save-takeaway", title: "Save as takeaway", icon: "Star",
  run: ({ threadId, message, selectedText, experimental_panel }) => {
    const quote = selectedText ?? message.text;
    if (selectedText !== undefined && (selectedText.length === 0 || selectedText.length > KNOWLEDGE_SOURCE_EXCERPT_MAX)) {
      toast.error("Select between 1 and 8,192 characters, or write a manual takeaway without a message source.");
      return;
    }
    if (!openTakeaway(experimental_panel, { source: { kind: "message", threadId, messageId: message.id, messageSeq: message.experimental_messageSeq, ...(selectedText !== undefined ? { quote } : {}) }, text: quote })) toast.error("bb could not open Save as takeaway here.");
  },
};

export function TakeawayPanel({ threadId, params }: ExperimentalThreadActionTabProps) {
  const { threads } = experimental_useSidebarThreads();
  const sectionId = threads.find(thread => thread.id === threadId)?.sectionId ?? null;
  const read = useSectionDetail(sectionId);
  const [open, setOpen] = useState(true);
  const sourceValue = params && typeof params === "object" && !Array.isArray(params) ? Reflect.get(params, "source") : null;
  const text = params && typeof params === "object" && !Array.isArray(params) ? Reflect.get(params, "text") : "";
  const parsed = captureSourceSchema.safeParse(sourceValue);
  const valid = parsed.success && (!parsed.data.threadId || parsed.data.threadId === threadId) && typeof text === "string";
  const seed: CaptureSeed = valid ? { source: parsed.data, text } : { source: { kind: "manual", threadId }, text: "" };
  const invalidSource = sourceValue !== null && sourceValue !== undefined && !valid;
  useEffect(() => setOpen(true), [params]);
  return <div className="grid gap-3 p-4 text-foreground">
    {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
    {invalidSource ? <p role="alert">The saved message source is invalid or belongs to another thread. Save from the original message again.</p> : sectionId === null ? <p role="status">This thread is not in a section. Choose a section in bb before saving shared context.</p> : read.data === undefined ? <LoadingRows label="Loading section context" /> : read.data.section.binding.binding === null ? <p role="status">Connect this section from the Cortex page before saving a shared takeaway.</p> : <><Button onClick={() => setOpen(true)}>Save as takeaway</Button>{open ? <CaptureDialog section={read.data.section} seed={seed} onClose={() => setOpen(false)} /> : null}</>}
  </div>;
}
