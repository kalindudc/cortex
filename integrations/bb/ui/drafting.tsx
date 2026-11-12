import { useEffect, useRef, useState } from "react";
import { useBbNavigate, experimental_usePluginId, experimental_useServers, experimental_useSidebarThreads, experimental_ThreadStatusGlyph as ThreadStatusGlyph } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import type { DraftJob, DraftPreview, DraftSelection } from "../draft-contract";
import type { Section } from "../section-contract";
import { failureOf, useDraftCapabilities, useDraftConfig, useDraftJobs, useDraftJob, useDraftWrites, useKnowledgeEntries, type RpcFailure } from "./data";
import { KnowledgeStateMark } from "./marks";
import { relativeAge } from "./model";
import { DraftModelChoice, RequestedDraftModel, selectionKey } from "./draft-settings";
import { discardPendingDraft, draftRecoveryScope, pendingDraft, readPendingDraft, savePendingDraft, type DraftRecoveryScope, type PendingDraft } from "./draft-intent";
import { FailureNotice, LoadingRows } from "./parts";
import { CORTEX_PAGE_PATH } from "./thread-context";

const STATUS: Record<DraftJob["status"], string> = {
  prepared: "Preparing draft", "setup-requested": "Preparing drafting session", "setup-uncertain": "Session setup needs checking",
  queued: "Waiting to draft", activating: "Starting draft", running: "Drafting suggestions", validating: "Checking sources", saving: "Saving suggestions for review",
  "needs-recovery": "Needs recovery", failed: "Draft failed", completed: "Ready for review", "nothing-to-save": "Nothing to save", "cancel-requested": "Stop requested — not yet confirmed", stopped: "Stopped",
};
export const terminal = (job: DraftJob) => ["completed", "nothing-to-save", "stopped"].includes(job.status);

export function draftPhase(job: DraftJob) {
  const stopping = job.cancellation.state === "requested" || job.status === "cancel-requested";
  const done = job.status === "completed" || job.status === "nothing-to-save";
  const phase = { prepared: 1, "setup-requested": 1, "setup-uncertain": 1, queued: 2, activating: 2, running: 2, validating: 3, saving: 4, completed: 5, "nothing-to-save": 5 };
  // Recovery and stop states expose durable saves and worker state, not the interrupted phase.
  const interrupted = job.retry === "lookup-save" || job.candidateResults.some(result => result.status !== "pending") ? 4 : job.worker.state === "not-requested" || job.worker.state === "requesting" || job.worker.state === "unknown" ? 1 : 2;
  const step = job.status in phase ? phase[job.status as keyof typeof phase] : interrupted;
  const tone = job.status === "failed" || job.error !== null ? "text-destructive-text" : stopping || job.retry !== "none" || job.status === "setup-uncertain" || job.status === "needs-recovery" ? "text-warning-text" : done ? "text-success" : job.status === "stopped" ? "text-muted-foreground" : "text-primary";
  return { step, done, tone, label: stopping ? "Stop requested — not yet confirmed" : STATUS[job.status] };
}

export function DraftPhaseBar({ job }: { job: DraftJob }) {
  const phase = draftPhase(job);
  return <div role="img" aria-label={`Prepare, Draft, Check, Save, Review. ${phase.label}, step ${phase.step} of 5.`} className="grid min-w-0 gap-1.5">
    <div className="grid grid-cols-5 gap-1" aria-hidden>{["Prepare", "Draft", "Check", "Save", "Review"].map((name, index) => <div key={name} className="grid gap-1.5"><span className={cn("h-1.5 rounded-sm bg-surface-recessed", index + 1 < phase.step || phase.done ? "bg-success" : index + 1 === phase.step ? phase.tone === "text-destructive-text" ? "bg-destructive" : phase.tone === "text-warning-text" ? "bg-attention" : phase.tone === "text-muted-foreground" ? "bg-muted-foreground" : "bg-primary" : "")} /><span className="text-[11px] text-muted-foreground [@container(max-width:359px)]:hidden">{name}</span></div>)}</div>
  </div>;
}

function DraftResult({ result, index, job, section }: { result: DraftJob["candidateResults"][number]; index: number; job: DraftJob; section?: Section }) {
  const navigate = useBbNavigate();
  const read = useKnowledgeEntries(result.canonicalId && (result.status === "saved" || result.status === "no-save") ? [result.canonicalId] : [])[0];
  const entry = read?.data?.entry;
  const noSave = result.status === "no-save";
  return <li className="grid min-w-0 gap-1 border-t border-border-seam pt-2">
    {noSave ? <span className="text-muted-foreground">No new takeaway was saved</span> : null}
    {(result.status === "saved" || noSave) && result.canonicalId ? <Button variant="ghost" aria-label={noSave ? "Open existing takeaway" : `Review saved suggestion ${index + 1}`} className="h-auto min-h-11 w-full justify-start gap-2 whitespace-normal text-left" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: section?.binding.binding?.workstreamId === job.workstreamId ? `sections/${section.id}/knowledge/${result.canonicalId}` : `workstreams/${job.workstreamId}/${result.canonicalId}` })}>
      {entry ? <KnowledgeStateMark entry={entry} /> : <Icon name="Check" className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{entry?.title ?? (noSave ? "Open existing takeaway" : `Review saved suggestion ${index + 1}`)}</span><Icon name="ChevronRight" className="ml-auto size-3.5 shrink-0" aria-hidden />
    </Button> : !noSave ? <span role="alert" className="text-destructive-text">Suggestion save failed{result.error ? `: ${result.error}` : ""}</span> : result.error ? <span className="text-muted-foreground">{result.error}</span> : null}
    {read?.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
  </li>;
}

export function DraftJobView({ job, onChange, section, compact = false, onDetails, preview }: { job: DraftJob; onChange?: (next: DraftJob) => void; section?: Section; compact?: boolean; onDetails?: () => void; preview?: DraftPreview | null }) {
  const writes = useDraftWrites();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  const act = async (kind: "cancel" | "resume" | "lookup") => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailure(null);
    try { const input = { sectionId: job.sectionId, requestId: job.requestId, expectedRevision: job.revision }; const next = kind === "cancel" ? await writes.cancel(input) : kind === "resume" ? await writes.resume(input) : await writes.lookup(job.sectionId, job.requestId); onChange?.(next); }
    catch (cause) { setFailure(failureOf(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  const sidebar = experimental_useSidebarThreads();
  const sourceName = sidebar.threads.find(thread => thread.id === job.sourceThreadId)?.displayTitle ?? "Source thread";
  const phase = draftPhase(job);
  const stopping = job.cancellation.state === "requested" || job.status === "cancel-requested";
  const attention = stopping || job.error !== null || job.retry !== "none" || job.status === "setup-uncertain" || job.status === "needs-recovery";
  const results = job.candidateResults.filter(result => result.status !== "pending");
  return <article data-cortex data-cortex-draft-job="" className={cn("grid min-w-0 gap-3 text-[13px] [container-type:inline-size] [overflow-wrap:anywhere] [&_button]:min-h-11 [&_summary]:min-h-11 [&_summary]:focus-visible:outline-ring [&_summary]:focus-visible:outline-2", compact ? "p-3" : "rounded-lg border border-border-seam bg-card p-4")}>
    <div className="flex flex-wrap items-center gap-2"><Icon name={attention ? "AlertCircle" : phase.done ? "CircleCheck" : job.status === "stopped" ? "Square" : "BellDot"} className={cn("size-4 shrink-0", phase.tone)} aria-hidden /><span className={cn("font-semibold", phase.tone)}>{phase.label}</span><span className="text-muted-foreground">step {phase.step} of 5</span>{!compact ? <time dateTime={job.requestedAt} title={new Date(job.requestedAt).toLocaleString()} className="ml-auto text-[12px] text-muted-foreground">Requested {relativeAge(job.requestedAt, Date.now())}</time> : null}</div>
    {compact || !terminal(job) ? <DraftPhaseBar job={job} /> : null}
    {section && (job.workstreamId !== section.binding.binding?.workstreamId || job.bindingRevision !== section.binding.revision) ? <p role="status" className="border-l-2 border-attention bg-surface-attention p-2">The section connection changed. This draft stays with its original workstream.</p> : null}
    <div className="grid min-w-0 gap-1 text-[12px]">
      <div className="flex min-w-0 items-center gap-1"><span className="shrink-0 text-muted-foreground">From</span><Button variant="link" aria-label="Open source thread" className="h-auto min-w-0 justify-start px-1 text-left" onClick={() => navigate.toThread(job.sourceThreadId)}><span className="truncate" title={sourceName}>{sourceName}</span></Button></div>
      {preview?.snapshotId === job.sourceSnapshotId ? <p className="text-muted-foreground">{preview.messages.length} completed messages · {preview.messages.reduce((count, message) => count + message.quote.length, 0).toLocaleString()} characters</p> : <TooltipProvider><Tooltip><TooltipTrigger asChild><span tabIndex={0} className="justify-self-start text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">Excerpt count not available</span></TooltipTrigger><TooltipContent>The saved job does not return excerpt counts. The original preview remains the source of those counts.</TooltipContent></Tooltip></TooltipProvider>}
      <p className="break-words text-muted-foreground [overflow-wrap:anywhere]"><span className="sr-only">Requested model: </span><RequestedDraftModel value={job.execution} /></p>
    </div>
    {job.progress ? <p role="status">{job.progress}</p> : null}
    {job.error ? <p role="alert">{job.error}</p> : null}
    {stopping ? <p>Stopping is not confirmed. Saved suggestions remain available.</p> : null}
    {failure ? <FailureNotice failure={failure} /> : null}
    {!compact && results.length > 0 ? <ul className="grid min-w-0 gap-2">{results.map((result, index) => <DraftResult key={result.intendedId} result={result} index={index} job={job} section={section} />)}</ul> : null}
    {job.status === "completed" && job.candidateResults.some(result => result.status === "saved") ? <p>Saved findings require individual review. Nothing was accepted or adopted as a Rule automatically.</p> : null}
    <div className="flex flex-wrap gap-2">
      {!terminal(job) && job.cancellation.state !== "confirmed" ? <Button variant="outline" disabled={busy} onClick={() => void act("cancel")}>{stopping ? "Check stop" : "Stop drafting"}</Button> : null}
      {job.retry === "lookup-save" ? <Button variant="outline" disabled={busy} onClick={() => void act("resume")}>Recover suggestion saves</Button> : null}
      {!compact ? <Button variant="ghost" disabled={busy} onClick={() => void act("lookup")}>Refresh draft status</Button> : null}
      {!compact && job.worker.threadId ? <Button variant="ghost" onClick={() => navigate.toThread(job.worker.threadId!)}>Open drafting session</Button> : null}
      {onDetails ? <Button variant="ghost" onClick={onDetails}>Details</Button> : null}
    </div>
    {job.retry !== "none" ? <p>Recovery checks the existing request and saved output. It does not request another model turn.</p> : null}
    {!compact ? <details><summary className="cursor-pointer py-2 text-muted-foreground">Request and provenance</summary><dl className="mt-2 grid gap-1 break-all text-[12px]"><dt className="text-muted-foreground">Original workstream</dt><dd>{job.workstreamId} · revision {job.workstreamRevision}</dd><dt className="text-muted-foreground">Source snapshot</dt><dd>{job.sourceSnapshotId}</dd><dt className="text-muted-foreground">Settings revision</dt><dd>{job.execution.configRevision} · {job.execution.origin === "source-thread" ? "Source thread model" : "Configured model"}</dd><dt className="text-muted-foreground">Request</dt><dd>{job.requestId} · revision {job.revision}</dd><dt className="text-muted-foreground">Deadline</dt><dd>{new Date(job.deadlineAt).toLocaleString()}</dd></dl></details> : null}
  </article>;
}

export function DraftJobs({ section }: { section: Section }) {
  const [chosenOffset, setOffset] = useState<number | null>(null);
  const first = useDraftJobs(section.id);
  const offset = chosenOffset ?? Math.floor(Math.max(0, (first.data?.total ?? 0) - 1) / 20) * 20;
  const page = useDraftJobs(section.id, offset, offset !== 0);
  const read = offset === 0 ? first : page;
  const error = first.error ?? read.error;
  if (read.data?.total === 0 && !error) return null;
  const latest = read.data?.jobs.at(-1);
  const earlier = read.data?.jobs.filter(job => terminal(job) && job !== latest) ?? [];
  const shown = read.data?.jobs.filter(job => !terminal(job) || job === latest) ?? [];
  const row = (job: DraftJob) => <div key={job.requestId}>{job.workstreamId !== section.binding.binding?.workstreamId || job.bindingRevision !== section.binding.revision ? <p role="status">The section connection changed. This draft stays with its original workstream.</p> : null}<DraftJobView job={job} /></div>;
  return <section aria-label="Drafting jobs" className="mb-4 grid min-w-0 gap-2 text-[13px]">
    {error ? <FailureNotice failure={error} onRetry={() => { first.refetch(); if (offset !== 0) page.refetch(); }} /> : null}
    {read.isLoading ? <LoadingRows label="Loading drafting jobs" /> : null}
    {read.data && read.data.total > 0 ? <><h2 className="font-semibold">Drafting jobs ({read.data.total})</h2>{shown.map(row)}{earlier.length > 0 ? <details><summary className="cursor-pointer py-2">Earlier finished drafts ({earlier.length} on this page)</summary>{earlier.map(row)}</details> : null}{read.data.total > 20 ? <div className="flex flex-wrap items-center gap-2"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Earlier drafts</Button><span>{offset + 1}–{Math.min(offset + 20, read.data.total)} of {read.data.total}</span><Button variant="outline" disabled={offset + 20 >= read.data.total} onClick={() => setOffset(offset + 20)}>More drafts</Button></div> : null}</> : null}
  </section>;
}

type DraftDialogProps = { section: Section; threads: Array<{ id: string; name: string }>; open: boolean; onClose: () => void; onReturnFocus?: () => void };
export function DraftDialog(props: DraftDialogProps) {
  const servers = experimental_useServers();
  const pluginId = experimental_usePluginId();
  const scope = draftRecoveryScope(servers, pluginId, props.section.id, window.location.origin);
  return <ScopedDraftDialog key={scope.key ?? "unresolved-server"} {...props} recoveryScope={scope} />;
}

function ScopedDraftDialog({ section, threads, open, onClose, onReturnFocus, recoveryScope }: DraftDialogProps & { recoveryScope: DraftRecoveryScope }) {
  const writes = useDraftWrites();
  const config = useDraftConfig(open);
  const capabilities = useDraftCapabilities(open);
  const compact = useIsCompactViewport();
  const navigate = useBbNavigate();
  const [sourceId, setSourceId] = useState("");
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const [initialRecovery] = useState(() => {
    try { return { intent: recoveryScope.key ? readPendingDraft(recoveryScope.key, section.id) : null, error: recoveryScope.error }; }
    catch (cause) { return { intent: null, error: failureOf(cause).message }; }
  });
  const [intent, setIntent] = useState<PendingDraft | null>(initialRecovery.intent);
  const [recoveryError, setRecoveryError] = useState<string | null>(initialRecovery.error);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [job, setJob] = useState<DraftJob | null>(null);
  const live = useDraftJob(job ? { sectionId: job.sectionId, requestId: job.requestId } : null);
  const shownJob = live.data ?? job;
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!preview) return;
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    setExpired(remaining <= 0);
    const timer = setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [preview]);
  const setting = config.data?.selection ?? null;
  // undefined until the person picks a model for this draft; until then the draft follows the Drafting setting.
  const [choice, setChoice] = useState<DraftSelection | null | undefined>(undefined);
  const model = choice === undefined ? setting : choice;
  const overridden = choice !== undefined && selectionKey(choice) !== selectionKey(setting);
  const [previewedModel, setPreviewedModel] = useState<string | null>(null);
  const sourcePresent = threads.some(thread => thread.id === sourceId);
  const bindingChanged = preview !== null && (preview.bindingRevision !== section.binding.revision || preview.workstreamId !== section.binding.binding?.workstreamId);
  const configChanged = preview !== null && config.data !== undefined && config.data.revision > preview.execution.configRevision;
  const modelChanged = preview !== null && !configChanged && previewedModel !== selectionKey(model);
  const fullAccess = preview?.execution.permissionMode === "full";
  const [fullAccessConfirmed, setFullAccessConfirmed] = useState(false);
  useEffect(() => setFullAccessConfirmed(false), [preview]);
  const canStart = !modelChanged && (!fullAccess || fullAccessConfirmed) && recoveryScope.key !== null && !recoveryError && !intent && !busy && !failure && !expired && sourcePresent && section.binding.binding !== null && preview !== null && preview.sourceThreadId === sourceId && preview.sectionId === section.id && !bindingChanged && !configChanged && capabilities.data?.available === true && config.data !== undefined && !config.error && !capabilities.error;
  const loadPreview = async () => {
    const threadId = sourceId;
    if (pending.current || intent || !sourcePresent || !section.binding.binding) return;
    pending.current = true; setBusy(true); setFailure(null);
    const key = selectionKey(model);
    try { setPreview(await writes.preview({ sectionId: section.id, expectedBindingRevision: section.binding.revision, sourceThreadId: threadId, ...(overridden && model !== null ? { selection: model } : {}) })); setPreviewedModel(key); }
    catch (cause) { setFailure(failureOf(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  const start = async () => {
    if (pending.current || !canStart || !preview) return;
    if (Date.parse(preview.expiresAt) <= Date.now()) { setExpired(true); return; }
    const input = { requestId: crypto.randomUUID(), sectionId: section.id, expectedBindingRevision: preview.bindingRevision, sourceThreadId: preview.sourceThreadId, sourceSnapshotId: preview.snapshotId, expectedConfigRevision: preview.execution.configRevision, ...(fullAccess ? { fullAccessConfirmed: true as const } : {}) };
    pending.current = true; setBusy(true); setFailure(null);
    try {
      const next = pendingDraft(input, preview);
      try { savePendingDraft(recoveryScope.key!, next); }
      catch (cause) { setRecoveryError(failureOf(cause).message); return; }
      setIntent(next);
      setJob(await writes.start(input, next));
    }
    catch (cause) { setFailure(failureOf(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  const lookup = async () => {
    if (pending.current || !intent) return;
    pending.current = true; setBusy(true); setFailure(null);
    try { setJob(await writes.lookup(intent.input.sectionId, intent.input.requestId, intent)); }
    catch (cause) { setFailure(failureOf(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  const discard = () => {
    if (!recoveryScope.key || pending.current) return;
    try {
      discardPendingDraft(recoveryScope.key);
      setIntent(null); setJob(null); setPreview(null); setSourceId(""); setFailure(null); setRecoveryError(null); setConfirmDiscard(false);
    } catch (cause) { setRecoveryError(failureOf(cause).message); }
  };
  const reloadRecovery = () => {
    if (!recoveryScope.key || pending.current) return;
    try { const restored = readPendingDraft(recoveryScope.key, section.id); setIntent(current => restored ?? current); setRecoveryError(null); }
    catch (cause) { setRecoveryError(failureOf(cause).message); }
  };
  const sidebar = experimental_useSidebarThreads();
  const step = shownJob || intent || canStart ? 3 : sourcePresent ? 2 : 1;
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}><DialogContent data-cortex data-part="DraftDialog" data-cortex-drafting-dialog="" onCloseAutoFocus={event => { if (onReturnFocus) event.preventDefault(); }} onAfterCloseAutoFocus={onReturnFocus} className={cn("text-[13px] [container-type:inline-size] [overflow-wrap:anywhere] [&_button]:min-h-11 [&_input]:text-[16px]", compact ? "max-w-2xl" : "flex max-h-[calc(100dvh-2rem)] max-w-2xl flex-col")}>
    <DialogHeader className="shrink-0"><DialogTitle className="flex items-center gap-2"><Icon name="AiContentGenerator01" className="size-4 text-primary" aria-hidden />Draft from a thread</DialogTitle><DialogDescription className="sr-only">Use recent completed excerpts from one thread in this section. Suggestions await individual review, never automatic approval.</DialogDescription></DialogHeader>
    <ol aria-label="Draft steps" className="grid shrink-0 grid-cols-3 border-b border-border-seam">{["Thread", "Excerpts", "Start"].map((name, index) => <li key={name} aria-current={step === index + 1 ? "step" : undefined} className={cn("border-b-2 border-transparent pb-2 text-[12px] text-muted-foreground", step === index + 1 && "border-primary font-semibold text-foreground")}><span>{index + 1} · {name}</span></li>)}</ol>
    <div data-cortex-draft-scroll="" className={compact ? "contents" : "grid min-h-0 gap-4 overflow-y-auto"} onFocus={event => {
      if (compact || !(event.target instanceof HTMLElement)) return;
      const pane = event.currentTarget;
      const top = pane.getBoundingClientRect().top + pane.clientTop;
      const bottom = top + pane.clientHeight;
      const target = event.target.getBoundingClientRect();
      if (target.top < top) pane.scrollTop += Math.floor(target.top - top);
      else if (target.bottom > bottom) pane.scrollTop += Math.ceil(target.bottom - bottom);
    }}>
      {shownJob ? <>{live.error ? <FailureNotice failure={live.error} onRetry={live.refetch} /> : null}<DraftJobView job={shownJob} onChange={setJob} section={section} preview={preview} /><p>Progress stays in this section after closing.</p>{terminal(shownJob) ? <Button variant="outline" className="justify-self-start" onClick={discard}>Prepare another draft</Button> : null}</> : <>
        <div role="group" aria-label="Source thread" className="grid gap-2"><span className="font-semibold">Source thread in {section.canonicalName}</span><div className={cn("grid gap-1.5", !compact && "max-h-64 overflow-y-auto pr-1")}>{threads.map(thread => { const chosen = sourceId === thread.id; return <Button key={thread.id} variant="outline" data-cortex-source-chosen={chosen ? "" : undefined} className={cn("h-auto min-h-11 justify-start gap-2 whitespace-normal text-left", chosen && "border-primary bg-primary/10 text-foreground")} disabled={busy || intent !== null} aria-pressed={chosen} onClick={() => { setSourceId(thread.id); setFailure(null); }}><Icon name={chosen ? "CircleCheck" : "Circle"} className={cn("size-4 shrink-0", chosen ? "text-primary" : "text-muted-foreground")} aria-hidden /><span className="shrink-0" aria-hidden><ThreadStatusGlyph indicator={sidebar.threads.find(row => row.id === thread.id)?.indicator ?? "none"} size="compact" /></span><span className="min-w-0 break-words [overflow-wrap:anywhere]" title={thread.name}>{thread.name}</span></Button>; })}</div>{threads.length === 0 ? <p role="status">No source thread is listed in this section.</p> : null}</div>
        {!intent ? <Button variant="outline" className="justify-self-start" disabled={busy || !sourcePresent || !section.binding.binding} onClick={() => void loadPreview()}>{busy ? "Preparing preview…" : "Preview completed excerpts"}</Button> : null}
        {!intent && !preview && !failure && !busy ? <p role="status" className="text-muted-foreground">{sourcePresent ? "Preview the completed excerpts to enable Start." : "Choose a source thread, then preview its completed excerpts to enable Start."}</p> : null}
        {failure ? <FailureNotice failure={failure} /> : null}
        {preview ? <section aria-label="Completed source excerpts" className="grid min-w-0 gap-2 text-[12px]">
          <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">Completed excerpts</span><TooltipProvider><Tooltip><TooltipTrigger asChild><span tabIndex={0} className="text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">Not the whole thread</span></TooltipTrigger><TooltipContent>{preview.label}</TooltipContent></Tooltip></TooltipProvider><Button variant="ghost" className="ml-auto" onClick={() => navigate.toThread(preview.sourceThreadId)}>Open source thread</Button></div>
          <p className="text-muted-foreground">{preview.messages.length} completed message{preview.messages.length === 1 ? "" : "s"} · {preview.messages.reduce((count, message) => count + message.quote.length, 0).toLocaleString()} characters · {preview.omittedMessages} omitted</p>
          <div className={cn("grid min-w-0 gap-2 rounded-md border border-border-seam p-2", !compact && "max-h-52 overflow-y-auto")}>{preview.messages.map(message => <div key={`${message.messageId}:${message.messageSeq}`} className="grid min-w-0 gap-1 border-l-2 border-border-seam bg-surface-recessed p-2"><p className="break-words text-muted-foreground" title={message.ref}>{message.role} · {message.authorType} · message {message.messageSeq}</p><p className="text-muted-foreground">Completed {new Date(message.completedAt).toLocaleString()} · Characters {message.start + 1}–{message.end} of {message.totalChars.toLocaleString()}</p><blockquote data-content className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.quote}</blockquote></div>)}</div>
          <p className="break-words [overflow-wrap:anywhere]">Requested model: <RequestedDraftModel value={preview.execution} />{preview.execution.origin === "override" ? " (this draft only)" : ""}</p>
        </section> : null}
        {!intent ? <DraftModelChoice setting={setting} value={model} onChange={setChoice} disabled={busy || config.data === undefined} /> : null}
        {bindingChanged ? <p role="status">Section connection changed since this preview. Your preview is retained; prepare a new preview before starting.</p> : null}
        {preview && fullAccess ? <div role="alert" data-part="FullAccessConfirm" data-cortex-full-access="" className="grid gap-2 rounded-md border border-attention bg-surface-attention p-3 text-[12px]"><p className="flex items-center gap-2 font-semibold"><Icon name="SecurityCheck" className="size-4 shrink-0 text-attention" aria-hidden />This draft runs with full access</p><p>The helper may run commands on this machine without asking while it reads these excerpts. It gets no Cortex tools or memory. Excerpts can contain instructions.</p><label className="flex min-h-11 cursor-pointer items-center gap-2"><Checkbox checked={fullAccessConfirmed} disabled={busy} onCheckedChange={checked => setFullAccessConfirmed(checked === true)} />Run this draft with full access</label></div> : null}
        {modelChanged ? <p role="status">The model for this draft changed since this preview. Preview again before starting.</p> : null}
        {configChanged ? <p role="status">Drafting settings changed since this preview. Your preview is retained; prepare a new preview before starting.</p> : null}
        {expired ? <p role="status">This preview expired. Prepare a new preview before starting.</p> : null}
        {preview && (!sourcePresent || preview.sourceThreadId !== sourceId) ? <p role="status">The preview is not for the current source choice. Prepare its completed excerpts before starting.</p> : null}
        {capabilities.error ? <FailureNotice failure={capabilities.error} onRetry={capabilities.refetch} /> : capabilities.data?.available === false ? <p role="alert">{capabilities.data.reason ?? "Drafting is unavailable."}</p> : null}
        {config.error ? <FailureNotice failure={config.error} onRetry={config.refetch} /> : null}
        {intent ? <div className="grid gap-2"><p>This request may already exist. Checking it does not request another model turn.</p><Button variant="outline" className="justify-self-start" disabled={busy} onClick={() => void lookup()}>Check drafting request</Button><details><summary className="min-h-11 cursor-pointer py-2 text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">Original request</summary><p className="break-all">Request {intent.input.requestId}</p></details></div> : null}
      </>}
      {recoveryError ? <div className="grid gap-2"><p role="alert">Drafting recovery is blocked. {recoveryError} No new draft will be started.</p>{recoveryScope.key ? <Button variant="outline" className="justify-self-start" disabled={busy} onClick={reloadRecovery}>Retry recovery storage</Button> : null}</div> : null}
      {recoveryScope.key && (recoveryError || intent && !shownJob) ? <div className="grid gap-2">{confirmDiscard ? <><p>The original request may still be running or may have saved results. Discarding this record loses its recovery link. Starting another draft later may request another model turn.</p><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={discard}>Discard recovery record</Button><Button variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep recovery record</Button></div></> : <Button variant="outline" className="justify-self-start" disabled={busy} onClick={() => setConfirmDiscard(true)}>Discard recovery record…</Button>}</div> : null}
      {failure && shownJob ? <FailureNotice failure={failure} /> : null}
    </div>
    <DialogFooter className="shrink-0 flex-wrap items-center border-t border-border-seam pt-3"><span className="mr-auto text-[12px] text-muted-foreground">Up to 3 findings, saved for your review.</span><Button variant="outline" aria-label="Close draft preview" onClick={onClose}>Cancel</Button>{!intent ? <Button disabled={!canStart} onClick={() => void start()}>Start drafting</Button> : null}</DialogFooter>
  </DialogContent></Dialog>;
}
