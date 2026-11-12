import { useEffect, useMemo, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { actorWord, facetWord, plural, STATE_LOOK } from "./copy";
import { type RpcFailure, useHistory, useWorkstream, useWorkstreamWrites } from "./data";
import { ConfirmDialog, ProposeDialog } from "./dialogs";
import { KnowledgeActions, KnowledgeDetail } from "./knowledge";
import { displayState, facetsOf, groupKnowledge, shortTime } from "./model";
import { EmptyNote, FailureNotice, LoadingRows, PagedFooter, Segmented, TONE_TEXT } from "./parts";
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

function EntryRow({ entry, selected, onSelect, now }: { entry: Knowledge; selected: boolean; onSelect: () => void; now: number }) {
  const state = displayState(entry, now);
  const look = STATE_LOOK[state];
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          "flex w-full items-start gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
          selected ? "bg-surface-selected" : "hover:bg-state-hover",
        )}
      >
        <Icon name={look.icon} className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[look.tone])} aria-label={look.word} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[12.5px] font-semibold text-foreground">{entry.title}</span>
          <span className="mt-0.5 line-clamp-2 text-[11.5px] text-muted-foreground">
            {entry.kind === "directive" ? "Directive" : "Finding"} · {facetWord(entry.facet)}
            {entry.applicability.environment.mode === "value" ? ` · ${entry.applicability.environment.value}` : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

function WorkstreamHistory({ id }: { id: string }) {
  const [pages, setPages] = useState(1);
  const read = useHistory(id, pages);
  if (read.error) return <FailureNotice failure={read.error} onRetry={read.refetch} />;
  if (read.data === undefined) return <LoadingRows label="Loading history" />;
  if (read.data.revisions.length === 0) return <EmptyNote icon="Clock">No edits yet.</EmptyNote>;
  return (
    <div>
      <p className="mb-1 text-[11.5px] text-muted-foreground">Edits to the workstream's name, description and archive state. Each entry's own history is in its detail.</p>
      <ol className="flex flex-col">
        {read.data.revisions.map(revision => (
          <li key={`${revision.id}-${revision.revision}`} className="flex flex-wrap items-baseline gap-x-2 border-t border-border-seam py-2 text-[12.5px] first:border-t-0">
            <span className="font-semibold text-foreground">{revision.action}</span>
            <span className="truncate text-foreground">{"title" in revision.snapshot ? revision.snapshot.title : revision.snapshot.name}</span>
            <span className="font-mono text-[11px] text-muted-foreground">rev {revision.revision}</span>
            <span className="flex-1" />
            <span className="text-[11.5px] text-muted-foreground">
              {actorWord(revision.actor)} · {shortTime(revision.at)}
            </span>
            {revision.reason ? (
              <span data-content className="basis-full text-[12px] text-muted-foreground">
                {revision.reason}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <PagedFooter
        shown={read.data.revisions.length}
        total={read.data.total}
        noun="edits"
        onMore={() => setPages(pages + 1)}
        changedWhileReading={read.data.changedWhileReading}
        onRetry={read.refetch}
      />
    </div>
  );
}

/** One workstream: its saved knowledge grouped by what threads get, each entry's evidence and history. */
export function WorkstreamPage({ id, selectedId }: { id: string; selectedId: string | null }) {
  const read = useWorkstream(id);
  const navigate = useBbNavigate();
  const now = Date.now();
  const [tab, setTab] = useState<"knowledge" | "history">("knowledge");
  const [facet, setFacet] = useState("all");
  const [dialog, setDialog] = useState<"add" | "edit" | "archive" | null>(null);
  const [showDetail, setShowDetail] = useState(selectedId !== null);
  const writes = useWorkstreamWrites();
  const entries = read.data?.entries ?? [];
  const facets = useMemo(() => facetsOf(entries), [entries]);
  const shown = facet === "all" ? entries : entries.filter(entry => entry.facet === facet);
  const groups = groupKnowledge(shown, now);
  const selected = entries.find(entry => entry.id === selectedId) ?? groups[0]?.entries[0] ?? null;
  if (read.error && read.data === undefined) return <div className="p-4 md:p-5"><FailureNotice failure={read.error} onRetry={read.refetch} /></div>;
  if (read.data === undefined) return <div className="p-4 md:p-5"><LoadingRows label="Loading workstream" /></div>;
  const { workstream, total } = read.data;
  const select = (entryId: string) => {
    navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: `workstreams/${id}/${entryId}`, replace: true });
    setShowDetail(true);
  };
  const counts = groupKnowledge(entries, now);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
      <div className="shrink-0 border-b border-border-seam px-4 pt-3 md:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[17px] font-semibold text-foreground">{workstream.name}</h2>
          {workstream.archived ? <span className="text-[11.5px] text-muted-foreground">Archived</span> : null}
          <span className="font-mono text-[11px] text-muted-foreground">rev {workstream.revision}</span>
          <span className="flex-1" />
          <Button size="sm" onClick={() => setDialog("add")}>
            <Icon name="Plus" className="size-4" aria-hidden />
            Add knowledge
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog("edit")}>
            Edit
          </Button>
          {workstream.archived ? null : (
            <Button size="sm" variant="ghost" onClick={() => setDialog("archive")}>
              Archive
            </Button>
          )}
        </div>
        {workstream.description ? (
          <p data-content className="mt-1 line-clamp-2 max-w-3xl text-[12.5px] text-muted-foreground">
            {workstream.description}
          </p>
        ) : null}
        <p className="mt-1.5 flex flex-wrap gap-x-3 text-[12px] text-muted-foreground">
          {counts.map(group => (
            <span key={group.id}>
              <span className="font-semibold text-foreground tabular-nums">{group.entries.length}</span> {group.label.toLowerCase()}
            </span>
          ))}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3 pb-2">
          <Segmented
            label="View"
            value={tab}
            options={[
              { value: "knowledge", label: "Saved knowledge" },
              { value: "history", label: "Workstream edits" },
            ]}
            onChange={setTab}
          />
          {tab === "knowledge" && facets.length > 1 ? (
            <Segmented label="Topic" value={facet} options={[{ value: "all", label: "All topics" }, ...facets.map(f => ({ value: f, label: facetWord(f) }))]} onChange={setFacet} />
          ) : null}
        </div>
      </div>
      {tab === "history" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 md:px-5">
          <WorkstreamHistory id={id} />
        </div>
      ) : entries.length === 0 ? (
        <div className="p-4 md:p-5">
          <EmptyNote
            icon="Layers"
            action={
              <Button size="sm" variant="outline" onClick={() => setDialog("add")}>
                Add knowledge
              </Button>
            }
          >
            No saved knowledge yet. Connected threads get only the workstream's name until you approve something.
          </EmptyNote>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className={cn("min-h-0 w-full overflow-y-auto border-r border-border-seam lg:w-[22rem] lg:shrink-0", showDetail && "hidden lg:block")}>
            {groups.map(group => (
              <section key={group.id} aria-label={group.label}>
                <h3 className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-seam bg-background px-3 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.label}
                  <span className="tabular-nums">{group.entries.length}</span>
                </h3>
                <ul>
                  {group.entries.map(entry => (
                    <EntryRow key={entry.id} entry={entry} now={now} selected={entry.id === selected?.id} onSelect={() => select(entry.id)} />
                  ))}
                </ul>
              </section>
            ))}
            {total > entries.length ? <p className="px-3 py-2 text-[11.5px] text-muted-foreground">Showing {entries.length} of {total}. Search the library for the rest.</p> : null}
          </div>
          {selected ? (
            <div className={cn("min-w-0 flex-1 overflow-y-auto px-4 py-4 md:px-5", showDetail ? "block" : "hidden lg:block")}>
              <Button variant="ghost" size="sm" className="mb-2 lg:hidden" onClick={() => setShowDetail(false)}>
                <Icon name="ChevronLeft" className="size-4" aria-hidden />
                {workstream.name}
              </Button>
              <KnowledgeDetail
                entry={selected}
                workstream={workstream}
                onOpen={select}
                actions={<KnowledgeActions entry={selected} workstream={workstream} />}
              />
            </div>
          ) : null}
        </div>
      )}
      <ProposeDialog workstream={workstream} facets={facets} open={dialog === "add"} onOpenChange={open => setDialog(open ? "add" : null)} />
      <WorkstreamDialog workstream={workstream} open={dialog === "edit"} onOpenChange={open => setDialog(open ? "edit" : null)} />
      <ConfirmDialog
        title={`Archive ${workstream.name}?`}
        facts={[
          { icon: "Minus", text: "Connected threads stop getting its knowledge from their next session." },
          { icon: "Archive", text: "Its knowledge and history stay readable." },
          { icon: "SideChat", text: "Sessions already running keep what they received." },
        ]}
        confirm="Archive"
        open={dialog === "archive"}
        onOpenChange={open => setDialog(open ? "archive" : null)}
        onConfirm={async () => {
          await writes.editWorkstream({ id: workstream.id, expectedRevision: workstream.revision, archived: true, reason: "Archived in Cortex" });
          toast(`Archived ${workstream.name}`);
        }}
      />
    </div>
  );
}
