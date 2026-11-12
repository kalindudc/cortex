import { useEffect, useRef, useState } from "react";
import { useBbNavigate, experimental_usePluginId, experimental_useServers } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import type { DraftJob, DraftPreview } from "../draft-contract";
import type { Section } from "../section-contract";
import { failureOf, useDraftCapabilities, useDraftConfig, useDraftJobs, useDraftJob, useDraftWrites, type RpcFailure } from "./data";
import { RequestedDraftModel } from "./draft-settings";
import { discardPendingDraft, draftRecoveryScope, pendingDraft, readPendingDraft, savePendingDraft, type DraftRecoveryScope, type PendingDraft } from "./draft-intent";
import { FailureNotice, LoadingRows } from "./parts";
import { CORTEX_PAGE_PATH } from "./thread-context";

const STATUS: Record<DraftJob["status"], string> = {
  prepared: "Preparing draft", "setup-requested": "Preparing drafting session", "setup-uncertain": "Session setup needs checking",
  queued: "Waiting to draft", activating: "Starting draft", running: "Drafting suggestions", validating: "Checking sources", saving: "Saving suggestions for review",
  "needs-recovery": "Needs recovery", failed: "Draft failed", completed: "Ready for review", "nothing-to-save": "Nothing to save", "cancel-requested": "Stop requested — not yet confirmed", stopped: "Stopped",
};
const terminal = (job: DraftJob) => ["completed", "nothing-to-save", "stopped"].includes(job.status);

export function DraftJobView({ job, onChange }: { job: DraftJob; onChange?: (next: DraftJob) => void }) {
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
  const stopping = job.cancellation.state === "requested";
  const attention = stopping || job.error !== null || job.retry !== "none" || job.status === "setup-uncertain";
  const label = stopping ? "Stop requested — not yet confirmed" : STATUS[job.status];
  const results = job.candidateResults.filter(result => result.status !== "pending");
  return <article data-cortex-draft-job="" className="grid min-w-0 gap-2 border-t border-border-seam py-3 text-[13px]">
    <div className="flex flex-wrap items-center gap-2"><Icon name={attention ? "CircleAlert" : terminal(job) ? "CircleCheck" : "CircleDot"} className="size-4 text-primary" aria-hidden /><span className="font-semibold">{label}</span><span>Requested {new Date(job.requestedAt).toLocaleString()}</span></div>
    <p>Requested model: <RequestedDraftModel value={job.execution} /></p>
    {job.progress ? <p role="status">{job.progress}</p> : null}
    {job.error ? <p role="alert">{job.error}</p> : null}
    {stopping ? <p>Stopping is not confirmed. Saved suggestions remain available.</p> : null}
    {failure ? <FailureNotice failure={failure} /> : null}
    {results.length > 0 ? <ul className="grid gap-2">{results.map((result, index) => <li key={result.intendedId} className="grid gap-1">{(result.status === "saved" || result.status === "no-save") && result.canonicalId ? <>{result.status === "no-save" ? <span>No new takeaway was saved</span> : null}<Button variant="outline" className="justify-self-start" onClick={() => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `workstreams/${job.workstreamId}/${result.canonicalId}` })}>{result.status === "no-save" ? "Open existing takeaway" : `Review saved suggestion ${index + 1}`}</Button></> : <span>{result.status === "no-save" ? "No new takeaway was saved" : "Suggestion save failed"}{result.error ? `: ${result.error}` : ""}</span>}</li>)}</ul> : null}
    {job.status === "completed" && job.candidateResults.some(result => result.status === "saved") ? <p>Saved findings require individual review. Nothing was accepted or adopted as a Rule automatically.</p> : null}
    <div className="flex flex-wrap gap-2">
      {!terminal(job) && job.cancellation.state !== "confirmed" ? <Button variant="outline" disabled={busy} onClick={() => void act("cancel")}>{stopping ? "Check stop" : "Stop drafting"}</Button> : null}
      {job.retry === "lookup-save" ? <Button variant="outline" disabled={busy} onClick={() => void act("resume")}>Recover suggestion saves</Button> : null}
      <Button variant="ghost" disabled={busy} onClick={() => void act("lookup")}>Refresh draft status</Button>
      <Button variant="ghost" onClick={() => navigate.toThread(job.sourceThreadId)}>Open source thread</Button>
    </div>
    {job.retry !== "none" ? <p>Recovery checks the existing request and saved output. It does not request another model turn.</p> : null}
    <details><summary className="cursor-pointer py-2">Original request and provenance</summary><dl className="mt-2 grid gap-1 break-all"><dt>Original workstream</dt><dd>{job.workstreamId} · revision {job.workstreamRevision}</dd><dt>Source snapshot</dt><dd>{job.sourceSnapshotId}</dd><dt>Settings revision</dt><dd>{job.execution.configRevision} · {job.execution.origin === "source-thread" ? "Source thread model" : "Configured model"}</dd><dt>Request</dt><dd>{job.requestId} · revision {job.revision}</dd></dl>{job.worker.threadId ? <Button variant="ghost" onClick={() => navigate.toThread(job.worker.threadId!)}>Open drafting session</Button> : null}</details>
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
  const sourcePresent = threads.some(thread => thread.id === sourceId);
  const bindingChanged = preview !== null && (preview.bindingRevision !== section.binding.revision || preview.workstreamId !== section.binding.binding?.workstreamId);
  const configChanged = preview !== null && config.data !== undefined && config.data.revision > preview.execution.configRevision;
  const canStart = recoveryScope.key !== null && !recoveryError && !intent && !busy && !failure && !expired && sourcePresent && section.binding.binding !== null && preview !== null && preview.sourceThreadId === sourceId && preview.sectionId === section.id && !bindingChanged && !configChanged && capabilities.data?.available === true && config.data !== undefined && !config.error && !capabilities.error;
  const loadPreview = async () => {
    const threadId = sourceId;
    if (pending.current || intent || !sourcePresent || !section.binding.binding) return;
    pending.current = true; setBusy(true); setFailure(null);
    try { setPreview(await writes.preview({ sectionId: section.id, expectedBindingRevision: section.binding.revision, sourceThreadId: threadId })); }
    catch (cause) { setFailure(failureOf(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  const start = async () => {
    if (pending.current || !canStart || !preview) return;
    if (Date.parse(preview.expiresAt) <= Date.now()) { setExpired(true); return; }
    const input = { requestId: crypto.randomUUID(), sectionId: section.id, expectedBindingRevision: preview.bindingRevision, sourceThreadId: preview.sourceThreadId, sourceSnapshotId: preview.snapshotId, expectedConfigRevision: preview.execution.configRevision };
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
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}><DialogContent data-cortex-drafting-dialog="" onCloseAutoFocus={event => { if (onReturnFocus) event.preventDefault(); }} onAfterCloseAutoFocus={onReturnFocus} className={compact ? "max-w-2xl" : "flex max-h-[calc(100dvh-2rem)] max-w-2xl flex-col"}>
    <DialogHeader className="shrink-0"><DialogTitle>Draft from a thread</DialogTitle><DialogDescription className="text-foreground">Use recent completed excerpts from one thread in this section. Up to three sourced findings are saved for your review, never accepted automatically.</DialogDescription></DialogHeader>
    <div data-cortex-draft-scroll="" className={compact ? "contents" : "grid min-h-0 gap-4 overflow-y-auto"} onFocus={event => {
      if (compact || !(event.target instanceof HTMLElement)) return;
      const pane = event.currentTarget;
      const top = pane.getBoundingClientRect().top + pane.clientTop;
      const bottom = top + pane.clientHeight;
      const target = event.target.getBoundingClientRect();
      if (target.top < top) pane.scrollTop += Math.floor(target.top - top);
      else if (target.bottom > bottom) pane.scrollTop += Math.ceil(target.bottom - bottom);
    }}>
      {shownJob ? <>{live.error ? <FailureNotice failure={live.error} onRetry={live.refetch} /> : null}<DraftJobView job={shownJob} onChange={setJob} /><p>Progress stays in this section after closing.</p>{terminal(shownJob) ? <Button variant="outline" className="justify-self-start" onClick={discard}>Prepare another draft</Button> : null}</> : <>
        <div role="group" aria-label="Source thread" className="grid gap-2"><span className="font-semibold">Source thread in {section.canonicalName}</span><div className={cn("grid gap-1.5", !compact && "max-h-64 overflow-y-auto pr-1")}>{threads.map(thread => { const chosen = sourceId === thread.id; return <Button key={thread.id} variant="outline" data-cortex-source-chosen={chosen ? "" : undefined} className={cn("h-auto min-h-11 justify-start gap-2 whitespace-normal text-left", chosen && "border-primary bg-primary/10 text-foreground")} disabled={busy || intent !== null} aria-pressed={chosen} onClick={() => { setSourceId(thread.id); setFailure(null); }}><Icon name={chosen ? "CircleCheck" : "Circle"} className={cn("size-4 shrink-0", chosen ? "text-primary" : "text-muted-foreground")} aria-hidden />{thread.name}</Button>; })}</div>{threads.length === 0 ? <p role="status">No source thread is listed in this section.</p> : null}</div>
        {!intent ? <Button variant="outline" className="justify-self-start" disabled={busy || !sourcePresent || !section.binding.binding} onClick={() => void loadPreview()}>{busy ? "Preparing preview…" : "Preview completed excerpts"}</Button> : null}
        {failure ? <FailureNotice failure={failure} /> : null}
        {preview ? <section aria-label="Completed source excerpts" className="grid min-w-0 gap-3 text-[13px]"><p>{preview.label}</p><p>{preview.messages.length} completed message{preview.messages.length === 1 ? "" : "s"} · {preview.messages.reduce((count, message) => count + message.quote.length, 0).toLocaleString()} excerpt characters · {preview.omittedMessages} messages omitted</p><p>Requested model: <RequestedDraftModel value={preview.execution} /></p><Button variant="ghost" className="justify-self-start" onClick={() => navigate.toThread(preview.sourceThreadId)}>Open source thread</Button>{preview.messages.map(message => <div key={`${message.messageId}:${message.messageSeq}`} className="grid min-w-0 gap-1 border-l-2 border-border-seam pl-3"><p className="break-all">{message.ref} · {message.role} · {message.authorType}</p><p>Completed {new Date(message.completedAt).toLocaleString()} · Characters {message.start + 1}–{message.end} of {message.totalChars.toLocaleString()}</p><blockquote data-content className="whitespace-pre-wrap break-words">{message.quote}</blockquote></div>)}</section> : null}
        {bindingChanged ? <p role="status">Section connection changed since this preview. Your preview is retained; prepare a new preview before starting.</p> : null}
        {configChanged ? <p role="status">Drafting settings changed since this preview. Your preview is retained; prepare a new preview before starting.</p> : null}
        {expired ? <p role="status">This preview expired. Prepare a new preview before starting.</p> : null}
        {preview && (!sourcePresent || preview.sourceThreadId !== sourceId) ? <p role="status">The preview is not for the current source choice. Prepare its completed excerpts before starting.</p> : null}
        {capabilities.error ? <FailureNotice failure={capabilities.error} onRetry={capabilities.refetch} /> : capabilities.data?.available === false ? <p role="alert">{capabilities.data.reason ?? "Drafting is unavailable."}</p> : null}
        {config.error ? <FailureNotice failure={config.error} onRetry={config.refetch} /> : null}
        {intent ? <div className="grid gap-2"><p>This request may already exist. Checking it does not request another model turn.</p><Button variant="outline" className="justify-self-start" disabled={busy} onClick={() => void lookup()}>Check drafting request</Button><p className="break-all">Request {intent.input.requestId}</p></div> : null}
      </>}
      {recoveryError ? <div className="grid gap-2"><p role="alert">Drafting recovery is blocked. {recoveryError} No new draft will be started.</p>{recoveryScope.key ? <Button variant="outline" className="justify-self-start" disabled={busy} onClick={reloadRecovery}>Retry recovery storage</Button> : null}</div> : null}
      {recoveryScope.key && (recoveryError || intent && !shownJob) ? <div className="grid gap-2">{confirmDiscard ? <><p>The original request may still be running or may have saved results. Discarding this record loses its recovery link. Starting another draft later may request another model turn.</p><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={discard}>Discard recovery record</Button><Button variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep recovery record</Button></div></> : <Button variant="outline" className="justify-self-start" disabled={busy} onClick={() => setConfirmDiscard(true)}>Discard recovery record…</Button>}</div> : null}
      {failure && shownJob ? <FailureNotice failure={failure} /> : null}
    </div>
    <DialogFooter className="shrink-0"><Button variant="outline" onClick={onClose}>Close draft preview</Button>{!intent ? <Button disabled={!canStart} onClick={() => void start()}>Start drafting</Button> : null}</DialogFooter>
  </DialogContent></Dialog>;
}
