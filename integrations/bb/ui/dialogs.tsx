import { type ReactNode, useEffect, useState } from "react";
import { experimental_copyToClipboard, useComposer } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { dimensionWord, ORIENTATION, STATUS_LOOK, tokens } from "./copy";
import { isConflict, type RpcFailure, useKnowledgeEntries, useWorkstreamWrites } from "./data";
import { type DiffOp, wordDiff } from "./model";
import { Applicability, FailureNotice, KnowledgeText, Segmented, StateMark } from "./parts";
import type { Binding, ContextEntry, Dimension, Knowledge, ThreadContext, Workstream } from "./types";

const FIELD_LABEL = "text-[11.5px] font-semibold text-foreground";

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className={FIELD_LABEL}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11.5px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function DiffText({ ops, label }: { ops: DiffOp[]; label: string }) {
  if (!ops.some(op => op.op !== "same")) return <p className="text-[12px] text-muted-foreground">No change yet.</p>;
  return (
    <p aria-label={label} data-content className="rounded-md bg-muted/50 px-2.5 py-2 text-[12.5px] whitespace-pre-wrap break-words">
      {ops.map((op, index) =>
        op.op === "same" ? (
          <span key={index}>{op.text}</span>
        ) : op.op === "add" ? (
          <ins key={index} className="bg-success/20 text-foreground no-underline">
            {op.text}
          </ins>
        ) : (
          <del key={index} className="bg-destructive/15 text-foreground decoration-destructive-text">
            {op.text}
          </del>
        ),
      )}
    </p>
  );
}

function ScopeNote({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-border-seam px-2.5 py-2 text-[12.5px] text-foreground">
      <Icon name={icon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

const reasonOr = (note: string, fallback: string) => (note.trim() === "" ? fallback : note.trim());

/** A thread-only change: this thread's next context uses the new text; saved knowledge and other threads do not change. */
export function ChangeForThreadDialog({
  context,
  entry,
  open,
  onOpenChange,
}: {
  context: ThreadContext;
  entry: ContextEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const writes = useWorkstreamWrites();
  const [text, setText] = useState(entry.text);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  useEffect(() => {
    if (open) {
      setText(entry.text);
      setFailure(null);
    }
  }, [open]);
  const saved = entry.knowledge.text;
  const save = async (next: { text: string | null; excluded: boolean }, done: string) => {
    setBusy(true);
    setFailure(null);
    try {
      await writes.setOverride({
        threadId: context.threadId,
        expectedRevision: context.revision,
        knowledgeId: entry.knowledge.id,
        canonicalRevision: entry.knowledge.revision,
        ...next,
      });
      toast(done);
      onOpenChange(false);
    } catch (cause) {
      setFailure(cause as RpcFailure);
    } finally {
      setBusy(false);
    }
  };
  const unchanged = text.trim() === "" || text.trim() === entry.text.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Change for this thread only</DialogTitle>
          <DialogDescription>{entry.knowledge.title}</DialogDescription>
        </DialogHeader>
        <ScopeNote icon="SideChat">
          Only this thread's next context changes. Other threads keep the saved text. It shows as changed by you, not by the original sources.
        </ScopeNote>
        <Field label="Text for this thread" htmlFor="cortex-thread-text">
          <Textarea id="cortex-thread-text" value={text} onChange={event => setText(event.target.value)} rows={5} className="text-[13px]" />
        </Field>
        <DiffText ops={wordDiff(saved, text)} label="Change from the saved text" />
        {failure ? <FailureNotice failure={failure} /> : null}
        <DialogFooter>
          {entry.origin === "thread-only" ? (
            <Button variant="ghost" disabled={busy} onClick={() => void save({ text: null, excluded: false }, "This thread uses the saved text again")}>
              Use saved text
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || unchanged} onClick={() => void save({ text: text.trim(), excluded: false }, "Changed for this thread only")}>
            Save for this thread
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * An edit to saved knowledge for every thread, guarded by its revision. A
 * conflict keeps what the person typed and offers the newer revision to save over.
 */
export function EditKnowledgeDialog({
  entry,
  workstream,
  open,
  onOpenChange,
}: {
  entry: Knowledge;
  workstream: Pick<Workstream, "name"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const writes = useWorkstreamWrites();
  const [reloading, setReloading] = useState(false);
  const current = useKnowledgeEntries(open && reloading ? [entry.id] : [])[0];
  const [title, setTitle] = useState(entry.title);
  const [text, setText] = useState(entry.text);
  const [note, setNote] = useState("");
  const [base, setBase] = useState(entry);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  useEffect(() => {
    if (open) {
      setTitle(entry.title);
      setText(entry.text);
      setNote("");
      setBase(entry);
      setFailure(null);
      setReloading(false);
    }
  }, [open]);
  const latest = current?.data && current.data.entry.revision > entry.revision ? current.data.entry : entry;
  const newer = latest.revision > base.revision ? latest : null;
  const reload = () => {
    if (reloading) current?.refetch();
    else setReloading(true);
  };
  const save = async (approve: boolean) => {
    setBusy(true);
    setFailure(null);
    try {
      const reason = reasonOr(note, approve ? "Edited and approved in Cortex" : "Edited in Cortex");
      const out = await writes.edit({
        id: base.id,
        expectedRevision: base.revision,
        ...(title.trim() !== base.title ? { title: title.trim() } : {}),
        ...(text.trim() !== base.text ? { text: text.trim() } : {}),
        reason,
      });
      const saved = out.entry;
      if (approve && saved && saved.state !== "approved") {
        await writes.transition({ id: saved.id, expectedRevision: saved.revision, state: "approved", reason });
      }
      toast(
        approve
          ? `Saved and approved for every thread in ${workstream?.name ?? "this workstream"}`
          : saved?.state === "candidate"
            ? "Saved. It waits for your review before threads get it."
            : "Saved for every thread",
      );
      onOpenChange(false);
    } catch (cause) {
      setFailure(cause as RpcFailure);
    } finally {
      setBusy(false);
    }
  };
  const unchanged = title.trim() === base.title && text.trim() === base.text;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit saved knowledge</DialogTitle>
          <DialogDescription>
            Revision {base.revision} · <StateMark state={base.state} />
          </DialogDescription>
        </DialogHeader>
        <ScopeNote icon="Layers">
          Changes it for every thread in {workstream?.name ?? "this workstream"} from their next session. A change to approved knowledge needs approval again. History keeps every revision.
        </ScopeNote>
        <Field label="Title" htmlFor="cortex-edit-title">
          <Input id="cortex-edit-title" value={title} onChange={event => setTitle(event.target.value)} className="text-[13px]" />
        </Field>
        <Field label="Text" htmlFor="cortex-edit-text">
          <Textarea id="cortex-edit-text" value={text} onChange={event => setText(event.target.value)} rows={6} className="text-[13px]" />
        </Field>
        <DiffText ops={wordDiff(base.text, text)} label="Change from the saved text" />
        <Field label="Why (kept in history)" htmlFor="cortex-edit-note">
          <Input id="cortex-edit-note" value={note} onChange={event => setNote(event.target.value)} placeholder="Optional" className="text-[13px]" />
        </Field>
        {failure ? (
          <div className="flex flex-col gap-2">
            <FailureNotice failure={failure} />
            {isConflict(failure) && newer === null ? (
              <Button variant="outline" size="sm" className="self-start" disabled={current?.isLoading === true} onClick={reload}>
                {current?.isLoading ? "Loading the newer revision" : "Load the newer revision"}
              </Button>
            ) : null}
            {current?.error ? <FailureNotice failure={current.error} onRetry={current.refetch} /> : null}
          </div>
        ) : null}
        {newer ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[12px] text-muted-foreground">Revision {newer.revision} now says:</p>
            <DiffText ops={wordDiff(newer.text, text)} label="Your text compared with the newer revision" />
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                setBase(newer);
                setFailure(null);
              }}
            >
              Keep my text over revision {newer.revision}
            </Button>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" disabled={busy || unchanged || newer !== null} onClick={() => void save(true)}>
            Save and approve
          </Button>
          <Button disabled={busy || unchanged || newer !== null} onClick={() => void save(false)}>
            Save for all threads
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The exact next context as a draft in this thread's composer. Nothing is sent; the person decides. */
export function PrepareDraftDialog({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const writes = useWorkstreamWrites();
  const composer = useComposer();
  const [draft, setDraft] = useState<{ text: string; estimatedTokens: number; status: ThreadContext["status"]; error: string | null } | null>(null);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  const load = () => {
    setDraft(null);
    setFailure(null);
    writes.prepare(threadId).then(setDraft, cause => setFailure(cause as RpcFailure));
  };
  useEffect(() => {
    if (open) load();
  }, [open, threadId]);
  const here = composer.scope.kind === "thread" && composer.scope.threadId === threadId;
  const refused = draft !== null && (draft.status !== "ready" || draft.error !== null || draft.text === "");
  const insert = () => {
    if (!draft) return;
    composer.insert(draft.text, { at: "end", block: true });
    composer.focus();
    toast("Draft is in the composer. Nothing was sent.");
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Prepare a draft in the composer</DialogTitle>
          <DialogDescription>You choose whether to send it. The running session keeps what it already has.</DialogDescription>
        </DialogHeader>
        {failure ? <FailureNotice failure={failure} onRetry={load} /> : null}
        {draft === null && failure === null ? <p className="text-[12.5px] text-muted-foreground">Preparing…</p> : null}
        {draft !== null && refused ? (
          <FailureNotice
            failure={{ code: draft.status, message: draft.error ?? STATUS_LOOK[draft.status].word }}
            title={`${STATUS_LOOK[draft.status].word}.`}
          />
        ) : null}
        {draft !== null && !refused ? (
          <div className="flex min-h-0 flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
              <span className="font-semibold text-foreground">Exact draft</span>
              <span className="tabular-nums">{tokens(draft.estimatedTokens)} tokens</span>
            </div>
            <pre
              data-testid="draft-text"
              data-content
              tabIndex={0}
              aria-label="Exact draft text"
              className="max-h-[45vh] overflow-auto rounded-md border border-border-seam bg-muted/40 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words text-foreground"
            >
              {draft.text}
            </pre>
          </div>
        ) : null}
        {draft !== null && !refused && !here ? (
          <p role="status" className="text-[12px] text-muted-foreground">
            Open this thread to put the draft in its composer, or copy it.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {draft !== null && !refused ? (
            <Button
              variant="outline"
              onClick={async () => {
                const copied = await experimental_copyToClipboard({ text: draft.text });
                if (copied) toast("Copied the draft. Nothing was sent.");
                else toast.error("Could not copy to the clipboard.");
              }}
            >
              Copy
            </Button>
          ) : null}
          {draft !== null && !refused && here ? <Button onClick={insert}>Put in composer</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type DimensionMode = Dimension["mode"];

/** One target dimension: not chosen (unknown), does not apply, or a named value. An empty name means not chosen. */
export function DimensionEditor({
  name,
  label,
  value,
  onChange,
}: {
  name: "environment" | "host";
  label: string;
  value: Dimension;
  onChange: (next: Dimension) => void;
}) {
  const [mode, setMode] = useState<DimensionMode>(value.mode);
  const [text, setText] = useState(value.mode === "value" ? value.value : "");
  const emit = (nextMode: DimensionMode, nextText: string) =>
    onChange(
      nextMode !== "value"
        ? ({ mode: nextMode } as Dimension)
        : nextText.trim() === ""
          ? { mode: "unknown" }
          : { mode: "value", value: nextText.trim() },
    );
  const id = `cortex-target-${name}`;
  return (
    <div className="flex flex-col gap-1">
      <span className={FIELD_LABEL} id={`${id}-label`}>
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<DimensionMode>
          label={label}
          value={mode}
          options={[
            { value: "unknown", label: "Not chosen" },
            { value: "not-applicable", label: "Does not apply" },
            { value: "value", label: "Named" },
          ]}
          onChange={next => {
            setMode(next);
            emit(next, text);
          }}
        />
        {mode === "value" ? (
          <Input
            aria-labelledby={`${id}-label`}
            value={text}
            placeholder={name === "environment" ? "staging" : "cluster or host name"}
            onChange={event => {
              setText(event.target.value);
              emit("value", event.target.value);
            }}
            className="h-8 w-44 text-[13px]"
          />
        ) : null}
      </div>
      <p className="text-[11.5px] text-muted-foreground">{dimensionWord(name, value)}</p>
    </div>
  );
}

const UNKNOWN: Dimension = { mode: "unknown" };
export type BindingTarget = "section" | "thread";

/** Connect a section or one thread to a workstream: topic, budget and the target environment and host. */
export function BindingDialog({
  target,
  name,
  current,
  expectedRevision,
  workstreams,
  open,
  onOpenChange,
  onSave,
}: {
  target: BindingTarget;
  name: string;
  current: Binding | null;
  expectedRevision: number;
  workstreams: readonly Workstream[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (binding: Binding | null, expectedRevision: number) => Promise<void>;
}) {
  const [workstreamId, setWorkstreamId] = useState(current?.workstreamId ?? workstreams[0]?.id ?? "");
  const [topic, setTopic] = useState(current?.topic ?? "");
  const [budget, setBudget] = useState(String(current?.budgetTokens ?? 400));
  const [environment, setEnvironment] = useState<Dimension>(current?.applicability?.environment ?? UNKNOWN);
  const [host, setHost] = useState<Dimension>(current?.applicability?.host ?? UNKNOWN);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  useEffect(() => {
    if (!open) return;
    setWorkstreamId(current?.workstreamId ?? workstreams[0]?.id ?? "");
    setTopic(current?.topic ?? "");
    setBudget(String(current?.budgetTokens ?? 400));
    setEnvironment(current?.applicability?.environment ?? UNKNOWN);
    setHost(current?.applicability?.host ?? UNKNOWN);
    setFailure(null);
  }, [open]);
  const budgetTokens = Number(budget);
  const budgetOk = Number.isInteger(budgetTokens) && budgetTokens >= 128 && budgetTokens <= 6000;
  const submit = async (binding: Binding | null) => {
    setBusy(true);
    setFailure(null);
    try {
      await onSave(binding, expectedRevision);
      onOpenChange(false);
    } catch (cause) {
      setFailure(cause as RpcFailure);
    } finally {
      setBusy(false);
    }
  };
  const binding: Binding = {
    workstreamId,
    topic: topic.trim() === "" ? null : topic.trim(),
    budgetTokens,
    requiredKnowledgeIds: current?.workstreamId === workstreamId ? current.requiredKnowledgeIds : [],
    applicability: { environment, host },
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{target === "section" ? `Connect section ${name}` : "Connect this thread"}</DialogTitle>
          <DialogDescription>
            {target === "section"
              ? "Threads in this section get the workstream's approved knowledge when their next session starts. Child threads without a section follow their parent."
              : "Only this thread. It stops following its section or parent until you clear it."}
          </DialogDescription>
        </DialogHeader>
        {workstreams.length === 0 ? (
          <p role="status" className="text-[12.5px] text-muted-foreground">
            Create a workstream first.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Workstream</span>
            <Segmented
              label="Workstream"
              value={workstreamId}
              options={workstreams.map(ws => ({ value: ws.id, label: ws.name }))}
              onChange={setWorkstreamId}
            />
          </div>
        )}
        <Field label="Topic" htmlFor="cortex-binding-topic" hint="Leave blank to share the workstream basics only. Choose a topic to add its saved knowledge.">
          <Input id="cortex-binding-topic" value={topic} onChange={event => setTopic(event.target.value)} placeholder="mint" className="text-[13px]" />
        </Field>
        <Field label="Budget (tokens)" htmlFor="cortex-binding-budget" hint="128 to 6,000. Cortex refuses rather than cutting required knowledge.">
          <Input
            id="cortex-binding-budget"
            inputMode="numeric"
            value={budget}
            aria-invalid={!budgetOk}
            onChange={event => setBudget(event.target.value)}
            className="w-32 text-[13px]"
          />
        </Field>
        <div className="flex flex-col gap-3 rounded-md border border-border-seam p-3">
          <p className="text-[12px] text-muted-foreground">
            Where this work runs. Your bb workspace is not a deployment target. Knowledge for another environment or host stays out.
          </p>
          <DimensionEditor name="environment" label="Target environment" value={environment} onChange={setEnvironment} />
          <DimensionEditor name="host" label="Target host or cluster" value={host} onChange={setHost} />
        </div>
        {failure ? <FailureNotice failure={failure} /> : null}
        <DialogFooter>
          {current !== null ? (
            <Button variant="ghost" disabled={busy} onClick={() => void submit(null)}>
              {target === "section" ? "Disconnect" : "Follow section or parent"}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !budgetOk || workstreamId === ""} onClick={() => void submit(binding)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A person adds knowledge: always a candidate first; "Add and approve" approves it as a second, explicit step. */
export function ProposeDialog({
  workstream,
  facets,
  open,
  onOpenChange,
  seed,
}: {
  workstream: Workstream;
  facets: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed?: Partial<Pick<Knowledge, "subject" | "title" | "facet" | "kind" | "applicability">> & { title?: string };
}) {
  const writes = useWorkstreamWrites();
  const [kind, setKind] = useState<Knowledge["kind"]>(seed?.kind ?? "finding");
  const [title, setTitle] = useState(seed?.title ?? "");
  const [text, setText] = useState("");
  const [facet, setFacet] = useState(seed?.facet ?? ORIENTATION);
  const [environment, setEnvironment] = useState<Dimension>(seed?.applicability?.environment ?? { mode: "not-applicable" });
  const [host, setHost] = useState<Dimension>(seed?.applicability?.host ?? { mode: "not-applicable" });
  const [sourceRef, setSourceRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setKind(seed?.kind ?? "finding");
    setTitle(seed?.title ?? "");
    setText("");
    setFacet(seed?.facet ?? ORIENTATION);
    setEnvironment(seed?.applicability?.environment ?? { mode: "not-applicable" });
    setHost(seed?.applicability?.host ?? { mode: "not-applicable" });
    setSourceRef("");
    setFailure(null);
    setAnswer(null);
  }, [open]);
  const subject = seed?.subject ?? title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const submit = async (approve: boolean) => {
    setBusy(true);
    setFailure(null);
    setAnswer(null);
    try {
      const out = await writes.propose({
        workstreamId: workstream.id,
        subject: subject === "" ? "untitled" : subject.slice(0, 200),
        title: title.trim(),
        text: text.trim(),
        kind,
        facet: facet.trim() === "" ? ORIENTATION : facet.trim(),
        applicability: { environment, host },
        sources: sourceRef.trim() === "" ? [] : [{ ref: sourceRef.trim(), authorType: "human", observedAt: new Date().toISOString() }],
      });
      if (out.outcome === "no-save") {
        setAnswer(out.reason ?? "Cortex already has this; nothing new was saved.");
        return;
      }
      if (approve && out.entry) {
        await writes.transition({ id: out.entry.id, expectedRevision: out.entry.revision, state: "approved", reason: "Added and approved in Cortex" });
        toast(`Added and approved in ${workstream.name}`);
      } else {
        toast(`Added to ${workstream.name}. It waits for review.`);
      }
      onOpenChange(false);
    } catch (cause) {
      setFailure(cause as RpcFailure);
    } finally {
      setBusy(false);
    }
  };
  const ready = title.trim() !== "" && text.trim() !== "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add knowledge to {workstream.name}</DialogTitle>
          <DialogDescription>Threads get it only after it is approved.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Kind</span>
          <Segmented
            label="Kind"
            value={kind}
            options={[
              { value: "directive", label: "Directive: a rule to follow" },
              { value: "finding", label: "Finding: something observed" },
            ]}
            onChange={setKind}
          />
        </div>
        <Field label="Title" htmlFor="cortex-new-title">
          <Input id="cortex-new-title" value={title} onChange={event => setTitle(event.target.value)} className="text-[13px]" />
        </Field>
        <Field label="Text" htmlFor="cortex-new-text">
          <Textarea id="cortex-new-text" value={text} onChange={event => setText(event.target.value)} rows={4} className="text-[13px]" />
        </Field>
        <div className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Goes to</span>
          <Segmented
            label="Goes to"
            value={facet === ORIENTATION ? "basics" : "topic"}
            options={[
              { value: "basics", label: "Shared basics: every thread" },
              { value: "topic", label: "One topic" },
            ]}
            onChange={choice => setFacet(choice === "basics" ? ORIENTATION : facets.find(name => name !== ORIENTATION) ?? "")}
          />
          {facet !== ORIENTATION ? (
            <Input
              aria-label="Topic"
              value={facet}
              placeholder={facets.filter(name => name !== ORIENTATION).join(", ") || "mint"}
              onChange={event => setFacet(event.target.value)}
              className="mt-1 w-56 text-[13px]"
            />
          ) : null}
        </div>
        <div className="flex flex-col gap-3 rounded-md border border-border-seam p-3">
          <DimensionEditor name="environment" label="Applies to environment" value={environment} onChange={setEnvironment} />
          <DimensionEditor name="host" label="Applies to host or cluster" value={host} onChange={setHost} />
        </div>
        <Field label="Source" htmlFor="cortex-new-source" hint="Optional: a thread message, link or file it came from.">
          <Input id="cortex-new-source" value={sourceRef} onChange={event => setSourceRef(event.target.value)} className="text-[13px]" />
        </Field>
        {answer ? (
          <p role="status" className="text-[12.5px] text-foreground">
            {answer}
          </p>
        ) : null}
        {failure ? <FailureNotice failure={failure} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" disabled={busy || !ready} onClick={() => void submit(true)}>
            Add and approve
          </Button>
          <Button disabled={busy || !ready} onClick={() => void submit(false)}>
            Add for review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Re-check an expiring or held-back finding: the new observation is a candidate; the old one stays held back. */
export function ObserveDialog({
  entry,
  open,
  onOpenChange,
  mode,
}: {
  entry: Knowledge;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "observe" | "evidence";
}) {
  const writes = useWorkstreamWrites();
  const [value, setValue] = useState("");
  const [ref, setRef] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  useEffect(() => {
    if (open) {
      setValue("");
      setRef("");
      setExcerpt("");
      setFailure(null);
    }
  }, [open]);
  const source = () => ({
    ref: ref.trim(),
    ...(excerpt.trim() === "" ? {} : { excerpt: excerpt.trim() }),
    authorType: "human" as const,
    observedAt: new Date().toISOString(),
  });
  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      if (mode === "evidence") {
        const out = await writes.evidence({ id: entry.id, expectedRevision: entry.revision, sources: [source()], reason: "Evidence added in Cortex" });
        toast(out.outcome === "no-save" ? "That source is already there." : "Source added. Approval and expiry did not change.");
      } else {
        await writes.propose({
          workstreamId: entry.workstreamId,
          subject: entry.subject,
          title: entry.title,
          text: value.trim(),
          kind: entry.kind,
          facet: entry.facet,
          applicability: entry.applicability,
          sources: [source()],
          expiresAt: entry.expiresAt === null ? null : new Date(Date.now() + Math.max(3_600_000, Date.parse(entry.expiresAt) - Date.parse(entry.updatedAt))).toISOString(),
        });
        toast("Saved as a new observation for review. The old one stays held back.");
      }
      onOpenChange(false);
    } catch (cause) {
      setFailure(cause as RpcFailure);
    } finally {
      setBusy(false);
    }
  };
  const ready = ref.trim() !== "" && (mode === "evidence" || value.trim() !== "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === "evidence" ? "Add a source" : "Record what you see now"}</DialogTitle>
          <DialogDescription>{entry.title}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Last saved</span>
          <KnowledgeText text={entry.text} clamp />
          <Applicability value={entry.applicability} />
        </div>
        {mode === "observe" ? (
          <Field label="What you observed" htmlFor="cortex-observe-value">
            <Textarea id="cortex-observe-value" value={value} onChange={event => setValue(event.target.value)} rows={3} className="text-[13px]" />
          </Field>
        ) : null}
        <Field label="Source" htmlFor="cortex-observe-ref" hint="A command output, link or thread message.">
          <Input id="cortex-observe-ref" value={ref} onChange={event => setRef(event.target.value)} className="text-[13px]" />
        </Field>
        <Field label="Excerpt" htmlFor="cortex-observe-excerpt">
          <Textarea id="cortex-observe-excerpt" value={excerpt} onChange={event => setExcerpt(event.target.value)} rows={2} className="text-[13px]" />
        </Field>
        {failure ? <FailureNotice failure={failure} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !ready} onClick={() => void submit()}>
            {mode === "evidence" ? "Add source" : "Save for review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A confirmation that names what changes and what cannot be undone, at the decision. */
export function ConfirmDialog({
  title,
  facts,
  confirm,
  destructive = false,
  open,
  onOpenChange,
  onConfirm,
}: {
  title: string;
  facts: ReadonlyArray<{ icon: string; text: string }>;
  confirm: string;
  destructive?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  useEffect(() => {
    if (open) setFailure(null);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{facts.map(fact => fact.text).join(" ")}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1.5 text-[12.5px] text-foreground">
          {facts.map(fact => (
            <li key={fact.text} className="flex items-start gap-2">
              <Icon name={fact.icon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              {fact.text}
            </li>
          ))}
        </ul>
        {failure ? <FailureNotice failure={failure} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setFailure(null);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch (cause) {
                setFailure(cause as RpcFailure);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Side({ entry, label, className }: { entry: Knowledge; label: string; className?: string }) {
  return (
    <section aria-label={label} className={cn("flex min-w-0 flex-col gap-1.5 rounded-md border border-border-seam p-3", className)}>
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        <span className="font-semibold text-foreground">{label}</span>
        <StateMark state={entry.state} />
        <span className="text-muted-foreground">rev {entry.revision}</span>
      </div>
      <p className="text-[13px] font-semibold text-foreground">{entry.title}</p>
      <KnowledgeText text={entry.text} />
      <Applicability value={entry.applicability} />
    </section>
  );
}
