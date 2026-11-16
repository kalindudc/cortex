import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DimensionEditor } from "./dialogs";
import { failureOf, useWorkstreamWrites } from "./data";
import type { Knowledge } from "./types";
export function ApplicabilityCorrectionDialog({ entry, open, onOpenChange }: { entry: Knowledge; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [applicability, setApplicability] = useState(entry.applicability);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writes = useWorkstreamWrites();
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await writes.setApplicability({ id: entry.id, expectedRevision: entry.revision, applicability });
      onOpenChange(false);
    } catch (cause) { setError(failureOf(cause).message); } finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent data-cortex>
    <DialogHeader><DialogTitle>Set where it applies</DialogTitle><DialogDescription>A corrected copy of {entry.title} will be proposed, approved by you, and replace the old entry. Previously known targets stay unchanged.</DialogDescription></DialogHeader>
    {(["environment", "host"] as const).filter(name => entry.applicability[name].mode === "unknown").map(name => <DimensionEditor key={name} name={name} label={name === "host" ? "Host" : "Environment"} value={applicability[name]} onChange={next => setApplicability(current => ({ ...current, [name]: next }))} />)}
    {error ? <p role="alert">The corrected copy could not be approved. Review the entry before retrying.<details><summary>Details</summary>{error}</details></p> : null}
    <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy || Object.values(applicability).some(d => d.mode === "unknown")} onClick={() => void save()}>Approve corrected copy</Button></DialogFooter>
  </DialogContent></Dialog>;
}
