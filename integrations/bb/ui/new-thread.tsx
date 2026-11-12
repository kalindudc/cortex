import { type KeyboardEvent, type ReactElement, useEffect, useId, useRef, useState } from "react";
import {
  type ComposerDraftSnapshot,
  type ComposerMention,
  experimental_copyToClipboard,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useBbNavigate,
  useComposer,
  useRealtime,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  type NewThreadMemory,
  PENDING_MENTION_PROVIDER,
  PENDING_UNKNOWN,
  type PendingChange,
  type PendingSelection,
} from "../pending-context-contract";
import type { SectionEligibility } from "../section-contract";
import { GrowingTextarea } from "./growing-textarea";
import { BriefStrip } from "./brief-strip";
import { BRIEF_KIND_LOOK, deliverySummary, plural, tokens } from "./copy";
import {
  failureOf,
  type RpcFailure,
  useBindings,
  useCortexRpc,
  useKnowledgeEntries,
  useNewThreadContext,
} from "./data";
import { heldReason, ReasonChip } from "./marks";
import { clearComposeSection, readComposeSection, rememberComposeSection } from "./new-thread-section";
import { FailureNotice } from "./parts";
import "./new-thread.css";

type PluginMention = Extract<ComposerMention, { kind: "plugin" }>;
type Entry = SectionEligibility["entries"][number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NEW_THREAD_OPEN = "cortex:new-thread-context-open";
const PROVIDER_NAME: Record<string, string> = { pi: "Pi", "claude-code": "Claude Code", codex: "Codex" };

export function cortexPill(mentions: readonly ComposerMention[], pluginId: string): PluginMention | null {
  return (
    (mentions.find(
      m => m.kind === "plugin" && m.pluginId === pluginId && m.provider === PENDING_MENTION_PROVIDER,
    ) as PluginMention | undefined) ?? null
  );
}

/** The draft without one pill: its text range goes, and later pills shift back by its length. */
export function withoutMention(draft: ComposerDraftSnapshot, pill: ComposerMention) {
  const length = pill.to - pill.from;
  return {
    text: draft.text.slice(0, pill.from) + draft.text.slice(pill.to),
    mentions: draft.mentions
      .filter(m => m.from !== pill.from || m.to !== pill.to)
      .map(m => (m.from >= pill.to ? { ...m, from: m.from - length, to: m.to - length } : m)),
  };
}

export const pillLabel = (changes: number, sectionName: string) =>
  `Cortex: ${plural(changes, "change")} to the ${sectionName} brief`;

/** Cortex's card on bb's New thread screen: what the thread starts with automatically, and changes for it alone. */
export function NewThreadContextBanner() {
  const composer = useComposer();
  return composer.scope.kind === "new-thread" ? <NewThreadContext projectId={composer.scope.projectId} /> : null;
}

function NewThreadContext({ projectId }: { projectId: string | null }) {
  const composer = useComposer();
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const rpc = useCortexRpc();
  const sdk = useSdk();
  const sidebar = experimental_useSidebarThreads();
  const bindings = useBindings();
  const [remembered] = useState(() => readComposeSection());
  const [picked, setPicked] = useState<string | null>(remembered?.sectionId ?? null);
  const [expanded, setExpanded] = useState(false);
  const [placementFixed, setPlacementFixed] = useState(false);
  // Cleared from the menu: filed outside any section, which is known, unlike a section nobody picked.
  const [cleared, setCleared] = useState(false);
  const [retained, setRetained] = useState<PendingSelection | null>(null);
  const rowButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const open = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== composer.key) return;
      setExpanded(true);
      requestAnimationFrame(() => rowButton.current?.focus());
    };
    window.addEventListener(NEW_THREAD_OPEN, open);
    return () => window.removeEventListener(NEW_THREAD_OPEN, open);
  }, [composer.key]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const bodyId = useId();
  const pill = cortexPill(composer.draft.mentions, pluginId);
  const pillId = pill && UUID.test(pill.id) ? pill.id : null;
  useEffect(() => {
    const dispose = composer.onSubmitted(() => clearComposeSection());
    return () => { dispose(); clearComposeSection(); };
  }, [composer.key]);
  const read = useNewThreadContext({ projectId, sectionId: picked, pendingId: pillId });
  const refetch = read.refetch;
  // A new pill id is a new read; keep the same section's last preview meanwhile so the list and focus stay put.
  const last = useRef(read.data);
  if (read.data) last.current = read.data;
  const data = read.data ?? (read.isLoading && (last.current?.section?.id ?? null) === picked ? last.current : undefined);
  const watched = data?.section?.binding?.workstreamId ?? null;
  // Section and global signals already refresh this read; knowledge edits arrive as this workstream's signal.
  useRealtime("workstreams", payload => {
    if (watched !== null && typeof payload === "object" && payload !== null && Reflect.get(payload, "workstreamId") === watched)
      refetch();
  });
  useEffect(() => { setPlacementFixed(false); }, [data?.pending?.refusedPlacement?.at]);
  const pending = data?.pending ?? null;
  useEffect(() => {
    if (pending && pending.draftKey === composer.key && !pending.usedBy) setRetained(pending);
  }, [pending, composer.key]);
  const problem = pill && !pillId ? PENDING_UNKNOWN : (data?.pendingProblem ?? null);
  const nameOf = (id: string) => sidebar.sections.find(s => s.id === id)?.name ?? "this section";

  const removePill = () => {
    if (pending?.refusedPlacement && !placementFixed) setPicked(pending.refusedPlacement.sectionId);
    return composer.replace(draft => {
      const current = cortexPill(draft.mentions, pluginId);
      return current ? withoutMention(draft, current) : draft;
    });
  };
  // A pill restored with its draft names the section it was made for; follow that pick.
  useEffect(() => {
    if (picked === null && !cleared && pending && pending.usedBy === null) setPicked(pending.sectionId);
  }, [picked, cleared, pending?.id]);
  // The one root draft owns its pills; one copied from another composer would not apply here.
  useEffect(() => {
    if (!pill || !pending || pending.draftKey === composer.key) return;
    removePill();
    setNote("Removed a Cortex pill copied from another draft. Its changes belong to that draft and do not apply here.");
  }, [pending?.id, composer.key]);

  const changes: PendingChange[] = pill && pending && problem === null ? pending.changes : [];
  function syncPill(record: PendingSelection | null) {
    const label = record ? pillLabel(record.changes.length, nameOf(record.sectionId)) : null;
    const current = cortexPill(composer.draft.mentions, pluginId);
    const same = current !== null && record !== null && current.id === record.id && current.label === label;
    if (current && !same) removePill();
    if (record && label && !same) composer.insert({ provider: PENDING_MENTION_PROVIDER, id: record.id, label }, { at: "end" });
  }
  async function save(next: PendingChange[]) {
    if (picked === null || projectId === null || !data?.section) return;
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      const out = await rpc.call("pendingContextSet", {
        pendingId: pillId && problem === null ? pillId : null,
        projectId,
        sectionId: picked,
        expectedBindingRevision: data.section.bindingRevision,
        draftKey: composer.key,
        changes: next,
      });
      setRetained(out.pending);
      syncPill(out.pending);
      refetch();
    } catch (cause) {
      setFailure(failureOf(cause));
    } finally {
      setBusy(false);
    }
  }
  const change = (next: PendingChange) => save([...changes.filter(c => c.knowledgeId !== next.knowledgeId), next]);
  const reset = (knowledgeId: string) => save(changes.filter(c => c.knowledgeId !== knowledgeId));
  async function restore() {
    if (!retained) return;
    setBusy(true); setFailure(null);
    try {
      const preview = await rpc.call("newThreadContext", { projectId, sectionId: retained.sectionId, pendingId: retained.id });
      if (preview.pendingProblem) throw new Error(preview.pendingProblem);
      if (retained.changes.some(c => !preview.base?.entries.some(e => e.knowledge.id === c.knowledgeId && e.knowledge.revision === c.canonicalRevision))) throw new Error("The saved knowledge changed. Review the brief before making these changes again.");
      fileIn(retained.sectionId); syncPill(retained);
    } catch (cause) { setFailure(failureOf(cause)); }
    finally { setBusy(false); }
  }

  const base = data?.base ?? null;
  const effective = data?.applied ?? base;
  const binding = data?.section?.binding ?? null;
  const memory = data?.memory ?? null;
  const held = base ? [...new Set([...base.notices.map(n => n.id), ...base.exclusions.map(e => e.id)])] : [];
  const heldEntries = useKnowledgeEntries(expanded ? held : []);
  const sharing = new Map((bindings.data?.bindings ?? []).map(row => [row.key, row.binding !== null]));
  const sections = [...sidebar.sections].sort(
    (a, b) => Number(sharing.get(b.id) ?? false) - Number(sharing.get(a.id) ?? false),
  );
  const pickedName = picked === null ? null : nameOf(picked);
  const share = () => picked && navigate.toPluginPanel("cortex", { subPath: `sections/${picked}` });


  const refused = pill && pending?.refusedPlacement;
  const off = memory?.mode === "off";
  const ready = effective?.status === "ready";
  const open = () => { setExpanded(true); requestAnimationFrame(() => rowButton.current?.focus()); };
  const fileIn = (sectionId: string) => {
    if (pill && pending && pending.sectionId !== sectionId) removePill();
    setPicked(sectionId);
    setCleared(false);
    rememberComposeSection(sectionId);
    setPlacementFixed(true);
    navigate.toCompose({ ...(projectId ? { projectId } : {}), placement: { sectionId, pinned: false }, focusPrompt: true });
  };
  const clearSection = () => {
    if (pill) removePill();
    setPicked(null);
    setCleared(true);
    clearComposeSection();
    setPlacementFixed(true);
    navigate.toCompose({ ...(projectId ? { projectId } : {}), placement: { sectionId: null, pinned: false }, focusPrompt: true });
  };
  const summary = !data ? "Reading the brief…" : off ? "nothing from Cortex · memory off" :
    picked === null ? (cleared ? "Cortex memory only" : "Cortex memory · brief unknown") : !binding ? "Cortex memory · nothing shared here" :
    effective?.entries.length === 0 && ready ? "brief empty · + memory" :
    `${plural(effective?.entries.length ?? 0, "entry", "entries")} · ${tokens(effective?.estimatedTokens ?? 0)}/${effective?.budgetTokens ?? 0} tokens`;
  const sectionSizes = new Map(data?.sectionSummaries.map(row => [row.sectionId, row]) ?? []);
  const sectionSize = (id: string) => {
    const row = sectionSizes.get(id);
    return row ? `${row.entries} · ${tokens(row.estimatedTokens)}` : "Nothing shared";
  };
  const refusedNow = !!refused && !placementFixed;
  const changeCount = changes.length;
  const briefShown = !!(effective && binding && !off);
  const nonEmpty = briefShown && (effective?.entries.length ?? 0) > 0;
  const blocked = briefShown && !ready;
  const shareable = sections.filter(s => sharing.get(s.id));
  const heldIds = held;
  const memoryTip = memory
    ? `Memory summary: ${memory.summary.cached ? `${plural(memory.summary.ids.length, "stream")}, ${tokens(Math.ceil(memory.summary.chars / 4))} tokens` : "read when the thread starts"}.${memory.lookup ? ` Matching tasks: up to ${memory.lookup.maxTasks}, looked up from your first message.` : ""}`
    : "";
  const unverified = picked !== null && remembered?.sectionId === picked && !placementFixed;
  const sectionTip = picked === null
    ? cleared
      ? "Filed outside any section, so no brief goes in. Pick a section to file it there and start with its brief."
      : "bb doesn't tell Cortex which section this thread is filed in. Pick one to file it there and see its brief."
    : unverified
      ? "Picked with Cortex's New thread button. bb files the thread where you last chose; pick here to be sure."
      : "Filed here from this menu. Change it to file the thread in another section.";
  return (
    <section data-cortex data-part="NewThreadContext" aria-label="Cortex context for this new thread"
      className={cn("cortex-nt", refusedNow && "nt-refused")}
      onKeyDown={event => {
        if (event.key === "Escape" && !(event.target instanceof HTMLTextAreaElement)) {
          event.stopPropagation(); setExpanded(false); rowButton.current?.focus();
        }
      }}>
      <div className={cn("nt-row", (refusedNow || blocked || (!pill && retained)) && "nt-wrap")}>
        {refusedNow ? <>
          <span className="nt-lead"><Icon name="CircleX" className="nt-ic nt-bad" aria-hidden /></span>
          <button ref={rowButton} type="button" className="nt-tog" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(v => !v)}>
            <span className="nt-facts">Not sent · bb filed it in {sidebar.sections.find(s => s.id === refused.sectionId)?.name ?? "another section"}</span>
            <span className="nt-sp" />
            <Icon name="ChevronDown" className="nt-chev" aria-hidden />
          </button>
          <button type="button" className="nt-btn nt-solid" onClick={() => fileIn(pending!.sectionId)}>File in {nameOf(pending!.sectionId)}</button>
          <button type="button" className="nt-btn" onClick={removePill}>Remove pill</button>
        </> : <>
          <span className="nt-lead"><Icon name="Brain" className={cn("nt-ic", off ? "nt-muted" : "nt-pri")} aria-hidden /><span className="nt-w">Starts with</span></span>
          {!off && <DropdownMenu>
            <TooltipProvider><Tooltip><TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button type="button" className={cn("nt-sec", picked === null && !cleared && "nt-unknown", unverified && "nt-unverified")} aria-label={`File this thread in: ${pickedName ?? (cleared ? "No section" : "Section ?")}${unverified ? ", picked in Cortex" : ""}`}>
                  {picked === null && !cleared && <Icon name="FolderUnknown" className="nt-ic" aria-hidden />}
                  <span className="nt-nm">{pickedName ?? (cleared ? "No section" : "Choose section")}</span>
                  {unverified && <><Icon name="CircleQuestion" className="nt-ic nt-src-ic" aria-hidden /><span className="nt-src">picked in Cortex</span></>}
                  <Icon name="ChevronDown" className="nt-ic" aria-hidden />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger><TooltipContent data-cortex className="max-w-72">{sectionTip}</TooltipContent></Tooltip></TooltipProvider>
            <DropdownMenuContent data-cortex align="start" mobileTitle="File this thread in" className="cortex-nt-menu">
              <DropdownMenuLabel>File this thread in · unpinned</DropdownMenuLabel>
              {sections.map(s => <DropdownMenuItem key={s.id} onSelect={() => fileIn(s.id)}>
                <Icon name={picked === s.id ? "Check" : "Folder"} className="size-3.5" aria-hidden />
                <span className="nt-mi-name">{s.name}</span>
                <span className="nt-mi-meta">{sectionSize(s.id)}{changeCount && s.id !== picked ? ` · drops ${plural(changeCount, "change")}` : ""}</span>
              </DropdownMenuItem>)}
              {picked !== null && <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={clearSection}>
                  <Icon name="X" className="size-3.5" aria-hidden />
                  <span className="nt-mi-name">Clear section</span>
                  <span className="nt-mi-meta">outside any section{changeCount ? ` · drops ${plural(changeCount, "change")}` : ""}</span>
                </DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>}
          <button ref={rowButton} type="button" className="nt-tog"
            aria-label="What this thread starts with" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(v => !v)}>
            {briefShown && <span className="nt-mini"><BriefStrip data={effective!} compact /></span>}
            <span data-part="Summary" className="nt-facts" title={summary}>{read.error ? "Cortex couldn't read the brief" : summary}</span>
            {nonEmpty && memory && !blocked && <span className="nt-memfact" title={memoryTip}><span className="nt-dot" aria-hidden>· </span>+ memory</span>}
            {blocked && <span className="nt-mark nt-bad"><Icon name="CircleX" className="nt-ic" aria-hidden /><b>sends no brief</b></span>}
            {briefShown && !blocked && heldIds.length > 0 && <span className="nt-mark nt-att"><Icon name="AlertTriangle" className="nt-ic" aria-hidden /><b>{heldIds.length}</b> held</span>}
            {changeCount > 0 && !off && <span className="nt-mark nt-pri" aria-label={`${plural(changeCount, "change")} for this thread`}><Icon name="EditFile" className="nt-ic" aria-hidden /><b>{changeCount}</b><span className="nt-long">{changeCount === 1 ? " change" : " changes"}</span></span>}
            <span className="nt-sp" />
            <Icon name="ChevronDown" className="nt-chev" aria-hidden />
          </button>
          {!pill && retained && <><span className="sr-only" role="status">Cortex changes removed</span>
            <button type="button" className="nt-btn" disabled={busy} onClick={restore}><Icon name="RotateCcw" className="nt-ic" aria-hidden />Put {plural(retained.changes.length, "change")} back</button></>}
          {read.error ? <button type="button" className="nt-btn" onClick={refetch}><Icon name="ArrowReloadHorizontal" className="nt-ic" aria-hidden />Retry</button>
            : off ? <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="nt-btn"><Icon name="SlidersHorizontal" className="nt-ic" aria-hidden />Memory settings</button></DropdownMenuTrigger><DropdownMenuContent data-cortex align="end" mobileTitle="Memory settings"><DropdownMenuLabel>Agent memory · plugin default</DropdownMenuLabel>{([["auto", "Automatic"], ["write", "Look up and save"], ["read", "Look up only"], ["off", "Off"]] as const).map(([value, label]) => <DropdownMenuItem key={value} onSelect={async () => { try { await sdk.plugins.updateSettings({ pluginId, values: { memory: value } }); refetch(); } catch (cause) { setFailure(failureOf(cause)); } }}>{label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
            : picked !== null && data?.section && !binding ? <button type="button" className="nt-btn" onClick={share}><Icon name="Link" className="nt-ic" aria-hidden />Share context</button>
            : blocked ? <button type="button" className="nt-btn" onClick={open}>{effective!.status === "over-budget" ? "Make it fit" : "Review"}</button>
            : null}
        </>}
      </div>
      {(problem || note || failure || (read.error && expanded)) && <div className="nt-notes">
        {problem && <div role="alert" className="nt-callout nt-c-bad"><Icon name="CircleX" className="nt-ic nt-bad" aria-hidden /><span className="nt-grow">{problem}</span><button type="button" className="nt-btn" onClick={removePill}>Remove pill</button></div>}
        {note && <p role="status" className="nt-callout nt-c-ok"><Icon name="CircleCheck" className="nt-ic" aria-hidden /><span className="nt-grow">{note}</span></p>}
        {failure && <FailureNotice failure={failure} title="Your change was not saved" />}
        {read.error && expanded && <FailureNotice failure={read.error} onRetry={refetch} title="Cortex could not preview this thread's context" />}
      </div>}
      {expanded && <div id={bodyId} data-part="NewThreadContextBody" className="nt-body">
        {refusedNow && pending && <div className="nt-callout nt-c-bad"><Icon name="CircleX" className="nt-ic nt-bad" aria-hidden /><span className="nt-grow">Your {plural(changeCount || pending.changes.length, "change")} are for {nameOf(pending.sectionId)}; bb filed this thread in {sidebar.sections.find(s => s.id === refused.sectionId)?.name ?? "another section"}. Your draft and pill are kept.</span></div>}
        {off && <div className="nt-callout nt-c-att"><Icon name="Brain" className="nt-ic nt-att" aria-hidden /><span className="nt-grow">Memory is off: none of this goes in.</span></div>}
        {unverified && !off && !refusedNow && <div className="nt-callout nt-c-att"><Icon name="CircleQuestion" className="nt-ic nt-att" aria-hidden /><span className="nt-grow">Picked with Cortex's New thread button. bb files the thread where you last chose a section; pick it above to be sure.</span></div>}
        {picked === null && !off && <>
          <h3 className="nt-grp">File this thread in · sections that share a brief</h3>
          {shareable.length === 0 ? <p className="nt-empty">No section shares a brief yet.</p> : <div className="nt-quick">
            {shareable.map(s => {
              const size = sectionSizes.get(s.id);
              return <button key={s.id} type="button" onClick={() => fileIn(s.id)} aria-label={`File in ${s.name}: ${size ? `${plural(size.entries, "entry", "entries")}, about ${size.estimatedTokens} of ${size.budgetTokens} tokens` : "nothing shared"}`}>
                {size && <span className="nt-gauge" aria-hidden><span style={{ width: `${Math.min(100, (100 * size.estimatedTokens) / Math.max(1, size.budgetTokens))}%` }} /></span>}
                <span className="nt-nm" title={s.name}>{s.name}</span>
                <span className="nt-muted nt-num">{size ? (size.entries ? `${size.entries} · ${tokens(size.estimatedTokens)}` : "empty") : "Nothing shared"}</span>
              </button>;
            })}
          </div>}
        </>}
        {!binding && picked !== null && data && !off && <div className="nt-callout nt-c-att"><Icon name="Info" className="nt-ic nt-att" aria-hidden /><span className="nt-grow">Nothing shared in {pickedName}, so no brief goes in.</span></div>}
        {binding && base && effective && <div className={cn("nt-brief", off && "nt-dimmed")}>
          <BriefStrip data={effective} hypothetical={off} heldCount={heldIds.length} />
          {effective.status !== "ready" && <div role="alert" className="nt-callout nt-c-bad">
            <Icon name="CircleX" className="nt-ic nt-bad" aria-hidden />
            <span className="nt-grow">{effective.status === "over-budget" ? `Over by ${tokens(Math.max(0, effective.estimatedTokens - effective.budgetTokens))} · no brief goes in · leave out entries below` : deliverySummary(effective.status, "")}</span>
            <button type="button" className="nt-btn" onClick={share}>{effective.status === "over-budget" ? "Raise budget" : "Fix in Cortex"}<Icon name="ArrowUpRight" className="nt-ic" aria-hidden /></button>
          </div>}
          {base.status === "over-budget" && effective.status === "ready" && <div role="status" className="nt-callout nt-c-ok"><Icon name="CircleCheck" className="nt-ic nt-ok" aria-hidden /><span className="nt-grow">Fits: {tokens(effective.estimatedTokens)} / {effective.budgetTokens}</span></div>}
          <h3 className="nt-grp">{off || !ready ? "Would go in" : "Goes in"} · {effective.entries.length}</h3>
          {base.entries.length === 0 && <p className="nt-empty">No approved knowledge in this brief yet.</p>}
          <ul aria-label="Goes in automatically when you send" className="nt-ents">
            {base.entries.map(entry => <EntryRow key={entry.knowledge.id} entry={entry}
              applied={effective.entries.find(e => e.knowledge.id === entry.knowledge.id) ?? null}
              change={changes.find(c => c.knowledgeId === entry.knowledge.id) ?? null}
              required={data?.section?.requiredKnowledgeIds.includes(entry.knowledge.id) ?? false}
              off={off} busy={busy} onChange={change} onReset={reset} />)}
          </ul>
          {heldIds.length > 0 && <><h3 className="nt-grp">Held back · {heldIds.length}</h3>
            <ul aria-label="Held back" className="nt-ents">{heldIds.map((id, index) => {
              const row = base.notices.find(n => n.id === id) ?? base.exclusions.find(e => e.id === id)!;
              const known = heldEntries[index]?.data?.entry ?? null;
              const notice = base.notices.find(n => n.id === id);
              return <li key={id} className="nt-ent nt-dim">
                <span className="nt-k"><Icon name="AlertTriangle" className="nt-ic nt-att" aria-hidden /></span>
                <div className="nt-main">
                  <span className="nt-ttl nt-static" title={known?.title ?? id}>{known?.title ?? id}</span>
                  <div className="nt-meta"><ReasonChip reason={heldReason(row, { entry: known })} />{notice && <span className="nt-chip">notice goes in</span>}</div>
                </div>
                <span className="nt-tok">{notice ? tokens(notice.estimatedTokens) : "0"}</span>
                <span className="nt-acts"><button type="button" className="nt-btn" aria-label={`Fix in Cortex: ${known?.title ?? id}`} onClick={() => navigate.toPluginPanel("cortex", { subPath: `sections/${picked}/brief/${id}` })}>Fix in Cortex<Icon name="ArrowUpRight" className="nt-ic" aria-hidden /></button></span>
              </li>;
            })}</ul></>}
        </div>}
        {memory && !off && <MemoryLines memory={memory} />}
        <footer className="nt-foot">
          <span className="nt-grow" title="The saved knowledge and threads already running are unchanged. Cortex checks the section and the brief again when you send.">Changes apply to this thread only</span>
          {changeCount > 0 && !off && <button type="button" className="nt-btn" disabled={busy} onClick={() => save([])}><Icon name="RotateCcw" className="nt-ic" aria-hidden />Reset all</button>}
          {effective && binding && !off && <button type="button" className="nt-btn" onClick={async () => {
            try { if (!await experimental_copyToClipboard({ text: effective.exactText })) throw new Error("Clipboard unavailable"); setNote("Exact text copied"); }
            catch (cause) { setFailure(failureOf(cause)); }
          }}><Icon name="Copy" className="nt-ic" aria-hidden />Copy exact text</button>}
          {picked && <button type="button" className="nt-btn" onClick={share}>Open in Cortex<Icon name="ArrowUpRight" className="nt-ic" aria-hidden /></button>}
        </footer>
      </div>}
    </section>
  );
}

function MemoryLines({ memory }: { memory: NewThreadMemory }) {
  const providers = memory.lookup?.providers.map(id => PROVIDER_NAME[id] ?? id).join(", ") ?? "";
  return <>
    <h3 className="nt-grp">Also goes in</h3>
    {memory.mode === "write" && <div className="nt-mem">
      <Icon name="Layers" className="nt-ic nt-muted" aria-hidden />
      <span className="nt-mem-text">Memory summary{memory.summary.cached ? ` · ${plural(memory.summary.ids.length, "stream")} · ${tokens(Math.ceil(memory.summary.chars / 4))}` : ""}</span>
      <span className="nt-ids">
        {memory.summary.cached ? memory.summary.ids.map(id => <span key={id} className="nt-id">@{id}</span>) : <span className="nt-later" title="Cortex reads the project summary when the thread starts; it is not previewed here.">at start</span>}
        {memory.summary.shortened && <span className="nt-later" title="May be shortened to fit bb's 4,096-character instruction limit">may shorten</span>}
      </span>
    </div>}
    {memory.lookup && <div className="nt-mem">
      <Icon name="Search" className="nt-ic nt-muted" aria-hidden />
      <span className="nt-mem-text">Matching tasks · up to {memory.lookup.maxTasks}, from your first message</span>
      <span className="nt-ids"><span className="nt-later" title={`Looked up from what you send, so they can't be shown now. ${providers}`}>after send</span></span>
    </div>}
  </>;
}

function EntryRow({
  entry,
  applied,
  change,
  busy,
  required,
  off,
  onChange,
  onReset,
}: {
  entry: Entry;
  applied: Entry | null;
  change: PendingChange | null;
  busy: boolean;
  required: boolean;
  off: boolean;
  onChange: (change: PendingChange) => void;
  onReset: (knowledgeId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [full, setFull] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const leaveButton = useRef<HTMLButtonElement>(null);
  const putBackButton = useRef<HTMLButtonElement>(null);
  const focusAction = useRef(false);
  const { knowledge } = entry;
  const leftOut = change?.excluded === true;
  const edited = !!change && !leftOut;
  const text = change?.text ?? knowledge.text;
  const look = BRIEF_KIND_LOOK[knowledge.kind];
  useEffect(() => {
    if (!focusAction.current) return;
    focusAction.current = false;
    (leftOut ? putBackButton.current : leaveButton.current)?.focus();
  }, [leftOut]);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (editing || !restoreFocus.current) return;
    restoreFocus.current = false;
    editButton.current?.focus();
  }, [editing]);
  const close = () => {
    restoreFocus.current = true;
    setEditing(false);
  };
  const save = (next: string) => {
    close();
    if (next === knowledge.text.trim()) {
      if (change) onReset(knowledge.id);
      return;
    }
    if (next !== change?.text)
      onChange({ knowledgeId: knowledge.id, canonicalRevision: knowledge.revision, excluded: false, text: next });
  };
  const tip = (label: string, button: ReactElement) => <TooltipProvider><Tooltip><TooltipTrigger asChild>{button}</TooltipTrigger><TooltipContent data-cortex>{label}</TooltipContent></Tooltip></TooltipProvider>;
  const requiredTip = "Required by this section; leaving it out would send no brief";
  return (
    <li
      data-knowledge-id={knowledge.id}
      data-change={leftOut ? "left-out" : change ? "edited" : "none"}
      className={cn("nt-ent", leftOut && "nt-out", edited && "nt-edited", full && "nt-open", off && "nt-dim", editing && "nt-editing")}
    >
      <span className="nt-k" title={look.word}><Icon name={look.icon} className="nt-ic" aria-hidden /><span className="sr-only">{look.word}</span></span>
      <div className="nt-main">
        <div className="nt-ttl-line">
          <button type="button" className="nt-ttl" onClick={() => setFull(v => !v)} aria-expanded={full} title={knowledge.title}>{knowledge.title}</button>
          {required && <span className="nt-lock" title={requiredTip} aria-label="Required"><Icon name="Lock" className="nt-ic" aria-hidden /></span>}
        </div>
        {editing ? (
          <InlineEditor initial={text} title={knowledge.title} onSave={save} onCancel={close} />
        ) : leftOut ? null : (
          <div className="nt-txt" data-content>{text}</div>
        )}
        {!editing && (leftOut || edited) && <div className="nt-meta">
          {leftOut && <span className="nt-chip"><Icon name="EyeOff" className="nt-ic" aria-hidden />left out</span>}
          {edited && <span className="nt-chip nt-chip-pri" title="This thread only. The saved text is unchanged."><Icon name="EditFile" className="nt-ic" aria-hidden />edited</span>}
        </div>}
      </div>
      {editing ? null : <span className="nt-tok">{leftOut ? <s>{tokens(entry.estimatedTokens)}</s> : tokens((applied ?? entry).estimatedTokens)}</span>}
      {editing || off ? null : (
        <span className="nt-acts">
          {leftOut ? (
            <button ref={putBackButton} type="button" className="nt-btn" aria-disabled={busy || undefined} aria-label={`Put back: ${knowledge.title}`} onClick={() => { if (!busy) { focusAction.current = true; onReset(knowledge.id); } }}>
              <Icon name="RotateCcw" className="nt-ic" aria-hidden />Put back
            </button>
          ) : <>
            {edited && tip("Reset to saved text", <button type="button" className="nt-btn nt-icon nt-ghost" aria-disabled={busy || undefined} aria-label={`Reset: ${knowledge.title}`} onClick={() => { if (!busy) onReset(knowledge.id); }}>
              <Icon name="RotateCcw" className="nt-ic" aria-hidden /><span className="nt-lbl">Reset</span>
            </button>)}
            {tip("Edit for this thread", <button ref={editButton} type="button" className="nt-btn nt-icon nt-ghost" aria-disabled={busy || undefined} aria-label={`Edit for this thread: ${knowledge.title}`} onClick={() => !busy && setEditing(true)}>
              <Icon name="EditFile" className="nt-ic" aria-hidden /><span className="nt-lbl">Edit</span>
            </button>)}
            {tip(required ? requiredTip : "Leave out of this thread", <button ref={leaveButton} type="button" className="nt-btn nt-icon nt-ghost" aria-disabled={busy || required || undefined} aria-label={`Leave out: ${knowledge.title}`} onClick={() => { if (!busy && !required) { focusAction.current = true; onChange({ knowledgeId: knowledge.id, canonicalRevision: knowledge.revision, excluded: true, text: null }); } }}>
              <Icon name="EyeOff" className="nt-ic" aria-hidden /><span className="nt-lbl">Leave out</span>
            </button>)}
          </>}
        </span>
      )}
    </li>
  );
}

function InlineEditor({
  initial,
  title,
  onSave,
  onCancel,
}: {
  initial: string;
  title: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = ref.current;
    element?.focus();
    element?.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && (!event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (text.trim()) onSave(text.trim());
    }
  };
  return (
    <div className="nt-edit">
      <GrowingTextarea
        ref={ref}
        value={text}
        aria-label={`Text for this thread: ${title}`}
        onChange={event => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="nt-keys">
        <span><kbd>⏎</kbd> save</span><span><kbd>⇧⏎</kbd> new line</span><span><kbd>esc</kbd> cancel</span>
        <span className="nt-grow" />
        <button type="button" className="nt-btn nt-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="nt-btn nt-solid" disabled={!text.trim()} onClick={() => onSave(text.trim())}>Save for this thread</button>
      </div>
    </div>
  );
}
