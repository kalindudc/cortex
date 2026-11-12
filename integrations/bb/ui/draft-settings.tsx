import { useEffect, useRef, useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, experimental_useProviders, type ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { draftSelectionSchema, type DraftConfig, type DraftSelection } from "../draft-contract";
import { failureOf, useDraftConfig, useDraftWrites, type RpcFailure } from "./data";
import { FailureNotice, LoadingRows } from "./parts";

export function RequestedDraftModel({ value }: { value: DraftSelection }) {
  const { providers } = experimental_useProviders();
  const provider = providers.find(row => row.id === value.providerId);
  return <span className="break-words">{provider?.displayName ?? value.providerId} · {value.model}{value.reasoningLevel ? ` · Thinking: ${value.reasoningLevel}` : ""}{value.serviceTier ? ` · Tier: ${value.serviceTier}` : ""}</span>;
}

export function DraftingSettings() {
  const read = useDraftConfig();
  const writes = useDraftWrites();
  const catalog = experimental_useProviders();
  const [draft, setDraft] = useState<DraftConfig | null>(null);
  const [seed, setSeed] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [failure, setFailure] = useState<RpcFailure | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (draft === null && read.data) setDraft(read.data); }, [draft, read.data]);
  if (!draft) return read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : <LoadingRows label="Loading drafting settings" />;
  const shown = draft.selection ?? seed;
  const first = catalog.providers.find(provider => provider.available);
  const unavailable = draft.selection !== null && (catalog.status !== "ready" || !catalog.providers.some(provider => provider.id === draft.selection!.providerId && provider.available));
  const stale = read.data !== undefined && read.data.revision !== draft.revision;
  const dirty = read.data !== undefined && JSON.stringify(draft.selection) !== JSON.stringify(read.data.selection);
  const choose = (value: ExperimentalProviderModelPickerValue) => {
    const next = { providerId: value.providerId, model: value.model, reasoningLevel: value.reasoningLevel, ...(value.serviceTier === undefined ? {} : { serviceTier: value.serviceTier }) };
    const parsed = draftSelectionSchema.safeParse(next);
    if (!parsed.success) { setFailure({ code: "invalid_input", message: "Choose a concrete provider and model before saving." }); return; }
    setSeed(null); setDraft({ ...draft, selection: parsed.data }); setFailure(null); setSaved(false);
  };
  const save = async () => {
    if (pending.current || !dirty || stale || unavailable || seed !== null || read.error) return;
    pending.current = true; setBusy(true); setFailure(null); setSaved(false);
    try { const out = await writes.config({ expectedRevision: draft.revision, selection: draft.selection }); setDraft(out); setSaved(true); }
    catch (cause) { setFailure(failureOf(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div data-cortex-drafting-settings="" className="grid max-w-2xl gap-3 text-[13px] text-foreground">
    <p>Applies to future drafting jobs only. Existing jobs keep their requested model.</p>
    {read.error ? <FailureNotice failure={read.error} onRetry={read.refetch} /> : null}
    <div className="grid gap-2"><span className="font-semibold">Requested model</span>
      {shown === null ? <div className="flex flex-wrap items-center gap-2"><span>Follow source thread model</span><Button variant="outline" disabled={busy || !first} onClick={() => { if (first) { setSeed({ providerId: first.id, model: "", reasoningLevel: "" }); setSaved(false); } }}>Choose a model</Button></div> : <div className="flex min-w-0 flex-wrap items-center gap-2"><ProviderModelPicker value={shown} onChange={choose} disabled={busy} />{draft.selection === null ? <Button variant="ghost" disabled={busy} onClick={() => { setSeed(null); setFailure(null); }}>Cancel model choice</Button> : <Button variant="outline" disabled={busy} onClick={() => { setSeed(null); setDraft({ ...draft, selection: null }); setSaved(false); setFailure(null); }}>Follow source thread model</Button>}</div>}
      {draft.selection ? <p>Selected: <RequestedDraftModel value={draft.selection} /></p> : null}
      {catalog.status !== "ready" ? <p role="status">{catalog.status === "loading" ? "Loading model providers. Your saved choice is retained." : "Model providers are unavailable. Your saved choice is retained; no fallback is selected."}</p> : unavailable ? <p role="alert">The selected provider is unavailable. Your choice is retained; no fallback is selected.</p> : !first ? <p role="status">No model provider is available.</p> : null}
    </div>
    {stale ? <div role="status" className="grid gap-2 border-l-2 border-attention bg-surface-attention p-3"><p>Newer drafting settings are available. Your choice has not been replaced.</p><Button variant="outline" className="justify-self-start" disabled={busy} onClick={() => { if (read.data) { setDraft(read.data); setSeed(null); setFailure(null); setSaved(false); } }}>Reload saved selection</Button><p>Reload replaces this unsaved choice with the latest saved selection.</p></div> : null}
    {failure ? <FailureNotice failure={failure} /> : null}
    {saved ? <p role="status"><Icon name="Check" className="mr-1 inline size-4" aria-hidden />Drafting settings saved. Existing jobs keep their requested model.</p> : null}
    <Button className="justify-self-start" disabled={busy || !dirty || stale || unavailable || seed !== null || read.error !== null} onClick={() => void save()}>{busy ? "Saving settings…" : "Save drafting settings"}</Button>
  </div>;
}
