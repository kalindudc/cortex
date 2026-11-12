import { useEffect, useMemo, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { actorWord, dimensionWord, facetWord } from "./copy";
import { KnowledgeStateMark } from "./marks";
import { type RpcFailure, useHistory, useWorkstream, useWorkstreamWrites } from "./data";
import { ConfirmDialog, ProposeDialog } from "./dialogs";
import { KnowledgeActions, KnowledgeDetail } from "./knowledge";
import { facetsOf, groupKnowledge, shortTime } from "./model";
import { EmptyNote, FailureNotice, LoadingRows, PagedFooter, Segmented } from "./parts";
import { CORTEX_PAGE_PATH } from "./thread-context";
import type { Knowledge, Workstream } from "./types";

export function WorkstreamDialog({
  workstream,
  open,
  onOpenChange,
}: {
  workstream: Workstream | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const writes = useWorkstreamWrites();
  const navigate = useBbNavigate();
  const [name, setName] = useState(workstream?.name ?? "");
  const [description, setDescription] = useState(workstream?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  useEffect(() => {
    if (open) {
      setName(workstream?.name ?? "");
      setDescription(workstream?.description ?? "");
      setFailure(null);
    }
  }, [open]);
  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      if (workstream === null) {
        const out = await writes.createWorkstream({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
        toast(`Created ${name.trim()}`);
        if (out.workstream) navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `workstreams/${out.workstream.id}` });
      } else {
        await writes.editWorkstream({
          id: workstream.id,
          expectedRevision: workstream.revision,
          ...(name.trim() !== workstream.name ? { name: name.trim() } : {}),
          ...(description.trim() !== workstream.description ? { description: description.trim() } : {}),
          reason: "Edited in Cortex",
        });
        toast("Saved");
      }
      onOpenChange(false);
    } catch (cause) {
      setFailure(cause as RpcFailure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{workstream === null ? "New workstream" : `Edit ${workstream.name}`}</DialogTitle>
          <DialogDescription>A workstream holds knowledge shared by the threads you connect to it, across projects.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <label htmlFor="cortex-ws-name" className="text-[11.5px] font-semibold text-foreground">
            Name
          </label>
          <Input id="cortex-ws-name" value={name} onChange={event => setName(event.target.value)} className="text-[13px]" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="cortex-ws-description" className="text-[11.5px] font-semibold text-foreground">
            What it is for
          </label>
          <Textarea id="cortex-ws-description" value={description} onChange={event => setDescription(event.target.value)} rows={3} className="text-[13px]" />
        </div>
        {failure ? <FailureNotice failure={failure} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || name.trim() === ""} onClick={() => void save()}>
            {workstream === null ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


function EntryRow({ entry, selected, onSelect }: { entry: Knowledge; selected: boolean; onSelect: () => void }) {
  return <li>
    <button type="button" aria-current={selected ? "true" : undefined} onClick={onSelect}
      className={cn("cortex-knowledge-row grid w-full gap-x-3 gap-y-1 border-b border-border-seam px-3 py-3 text-left hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring", selected && "bg-surface-selected")}>
      <KnowledgeStateMark entry={entry} />
      <span className="min-w-0 font-semibold break-words">{entry.title}</span>
      <span className="text-muted-foreground">{facetWord(entry.facet)}</span>
      <span className="min-w-0 break-words text-muted-foreground">{dimensionWord("environment", entry.applicability.environment)} · {dimensionWord("host", entry.applicability.host)}</span>
      <span className="text-muted-foreground">{shortTime(entry.updatedAt)}</span>
    </button>
  </li>;
}

export function WorkstreamEdits({ id }: { id: string }) {
  const [pages, setPages] = useState(1);
  const read = useHistory(id, pages);
  if (read.error && !read.data) return <FailureNotice failure={read.error} onRetry={read.refetch} />;
  if (read.data === undefined) return <LoadingRows label="Loading history" />;
  if (read.data.revisions.length === 0) return <EmptyNote icon="Clock">No edits yet.</EmptyNote>;
  return <section data-cortex data-part="WorkstreamEdits" className="min-w-0 text-[12.5px]">
    {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
    <p className="mb-3 text-muted-foreground">Workstream edits. Entry history is in its detail.</p>
    <div className="cortex-edits-row grid gap-3 border-b border-border-seam py-2 font-semibold"><span>Change</span><span>By</span><span>When</span></div>
    <ol>{read.data.revisions.map(revision => <li key={`${revision.id}-${revision.revision}`} className="cortex-edits-row grid gap-3 border-b border-border-seam py-3">
      <span className="min-w-0 break-words"><b>{revision.action}</b> · {"title" in revision.snapshot ? revision.snapshot.title : revision.snapshot.name} · rev {revision.revision}{revision.reason ? <span data-content className="mt-1 block text-muted-foreground">{revision.reason}</span> : null}</span>
      <span className="min-w-0 break-words text-muted-foreground">{revision.actor.type === "agent" ? "Agent" : actorWord(revision.actor)}</span>
      <span className="text-muted-foreground">{shortTime(revision.at)}</span>
    </li>)}</ol>
    <PagedFooter shown={read.data.revisions.length} total={read.data.total} noun="edits" onMore={() => setPages(pages + 1)} changedWhileReading={read.data.changedWhileReading} onRetry={read.refetch} />
  </section>;
}

export function WorkstreamKnowledge({ id, selectedId = null, onSelect, onClose }: { id: string; selectedId?: string | null; onSelect?: (id: string) => void; onClose?: () => void }) {
  const read = useWorkstream(id);
  const navigate = useBbNavigate();
  const [facet, setFacet] = useState("all");
  const [adding, setAdding] = useState(false);
  const [showDetail, setShowDetail] = useState(selectedId !== null);
  useEffect(() => setShowDetail(selectedId !== null), [selectedId]);
  const entries = read.data?.entries ?? [];
  const facets = useMemo(() => facetsOf(entries), [entries]);
  const shown = facet === "all" ? entries : entries.filter(entry => entry.facet === facet);
  const selected = entries.find(entry => entry.id === selectedId) ?? groupKnowledge(shown, Date.now())[0]?.entries[0] ?? null;
  const select = (entryId: string) => {
    if (onSelect) onSelect(entryId);
    else navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `workstreams/${id}/${entryId}`, replace: true });
    setShowDetail(true);
  };
  if (read.error && !read.data) return <FailureNotice failure={read.error} onRetry={read.refetch} />;
  if (!read.data) return <LoadingRows label="Loading workstream" />;
  const { workstream, total } = read.data;
  return <section data-cortex data-part="WorkstreamKnowledge" className="cortex-workstream-knowledge min-w-0 text-[12.5px]">
    {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
    <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
      <div className="cortex-topic-tabs min-w-0 flex-1 overflow-x-auto"><Segmented label="Topic" value={facet} options={[{ value: "all", label: "All topics" }, ...facets.map(f => ({ value: f, label: facetWord(f) }))]} onChange={setFacet} /></div>
      <Button size="sm" onClick={() => setAdding(true)}><Icon name="Plus" className="size-4" aria-hidden />Add knowledge</Button>
    </div>
    {entries.length === 0 ? <EmptyNote icon="Layers">No saved knowledge yet. Connected threads get only the workstream's name until you approve something.</EmptyNote> :
      <div className={cn("cortex-knowledge-layout grid min-w-0 gap-4", showDetail && "cortex-detail-open")}>
        <div className="cortex-master min-w-0">
          <div aria-hidden className="cortex-knowledge-heading cortex-knowledge-row grid gap-3 border-b border-border-seam px-3 py-2 font-semibold text-muted-foreground"><span>State</span><span>Entry</span><span>Topic</span><span>Applies to</span><span>Updated</span></div>
          <ul aria-label="All knowledge">{shown.map(entry => <EntryRow key={entry.id} entry={entry} selected={selectedId === entry.id} onSelect={() => select(entry.id)} />)}</ul>
          {shown.length === 0 ? <EmptyNote>No knowledge in this topic.</EmptyNote> : null}
          {total > entries.length ? <p className="px-3 py-2 text-muted-foreground">Showing {entries.length} of {total}. Search the library for the rest.</p> : null}
        </div>
        {selected && (showDetail || !onSelect) ? <div className={cn("cortex-detail min-w-0 rounded-md border border-border-seam bg-card p-4", !showDetail && "cortex-detail-idle")}>
          <Button variant="ghost" size="sm" className="cortex-detail-back mb-2" onClick={() => { setShowDetail(false); onClose?.(); }}><Icon name="ChevronLeft" className="size-4" aria-hidden />{workstream.name}</Button>
          {onClose ? <Button variant="ghost" size="icon" aria-label="Close entry" onClick={() => { setShowDetail(false); onClose(); }}><Icon name="X" className="size-4" aria-hidden /></Button> : null}
          <KnowledgeDetail entry={selected} workstream={workstream} onOpen={select} actions={<KnowledgeActions entry={selected} workstream={workstream} />} />
        </div> : null}
      </div>}
    <ProposeDialog workstream={workstream} facets={facets} open={adding} onOpenChange={setAdding} />
  </section>;
}

export function WorkstreamPage({ id, selectedId }: { id: string; selectedId: string | null }) {
  const read = useWorkstream(id);
  const [tab, setTab] = useState<"knowledge" | "history">("knowledge");
  const [dialog, setDialog] = useState<"edit" | "archive" | null>(null);
  const writes = useWorkstreamWrites();
  if (read.error && !read.data) return <div className="p-4"><FailureNotice failure={read.error} onRetry={read.refetch} /></div>;
  if (!read.data) return <LoadingRows label="Loading workstream" />;
  const { workstream } = read.data;
  return <div data-cortex className="cortex-section h-full min-h-0 overflow-y-auto text-foreground">
    <header className="border-b border-border-seam px-4 py-3">
      <div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 break-words text-[17px] font-semibold">{workstream.name}</h2>
        {workstream.archived ? <span className="text-muted-foreground">Archived</span> : null}
        <Button size="sm" variant="outline" onClick={() => setDialog("edit")}>Edit</Button>
        {!workstream.archived ? <Button size="sm" variant="ghost" onClick={() => setDialog("archive")}>Archive</Button> : null}
      </div>
      {workstream.description ? <p data-content className="mt-1 line-clamp-2 text-[12.5px] text-muted-foreground">{workstream.description}</p> : null}
      <div className="mt-3"><Segmented label="View" value={tab} options={[{ value: "knowledge", label: "Saved knowledge" }, { value: "history", label: "Workstream edits" }]} onChange={setTab} /></div>
    </header>
    <div className="p-4">{tab === "history" ? <WorkstreamEdits id={id} /> : <WorkstreamKnowledge id={id} selectedId={selectedId} />}</div>
    <WorkstreamDialog workstream={workstream} open={dialog === "edit"} onOpenChange={open => setDialog(open ? "edit" : null)} />
    <ConfirmDialog title={`Archive ${workstream.name}?`} facts={[{ icon: "Minus", text: "Connected threads stop getting its knowledge from their next session." }, { icon: "Archive", text: "Its knowledge and history stay readable." }, { icon: "SideChat", text: "Sessions already running keep what they received." }]} confirm="Archive" open={dialog === "archive"} onOpenChange={open => setDialog(open ? "archive" : null)} onConfirm={async () => {
      await writes.editWorkstream({ id: workstream.id, expectedRevision: workstream.revision, archived: true, reason: "Archived in Cortex" }); toast(`Archived ${workstream.name}`);
    }} />
  </div>;
}
