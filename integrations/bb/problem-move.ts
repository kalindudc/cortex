import type { createWorkstreamCli } from "./workstream-cli";
import type { z } from "zod";
import type { actorSchema } from "./workstream-contract";

export async function moveToBasics(cli: Pick<ReturnType<typeof createWorkstreamCli>, "knowledge" | "mutate">, actor: z.infer<typeof actorSchema>, input: { id: string; expectedRevision: number }, signal?: AbortSignal) {
  const old = await cli.knowledge(input.id, signal);
  if (old.revision !== input.expectedRevision) throw new Error("Entry revision conflict. Read the current entry before moving it.");
  if (old.state !== "approved") throw new Error("Only an approved entry can move to shared basics.");
  const result = await cli.mutate({ op: "edit", actor, id: old.id, expectedRevision: old.revision, facet: "orientation", reason: "Human moved entry to shared basics" }, signal);
  if (!result.entry || result.entry.state !== "candidate") throw new Error("The entry was not returned to Review. Nothing was approved.");
  try {
    const approved = await cli.mutate({ op: "accept", actor, id: old.id, expectedRevision: result.entry.revision, applicability: result.entry.applicability, reason: "Human approved shared basics" }, signal);
    return { result: approved, waitingInReview: false, refusal: null };
  } catch (cause) {
    return { result, waitingInReview: true, refusal: cause instanceof Error ? cause.message : String(cause) };
  }
}
