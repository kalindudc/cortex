import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Sections } from "./sections";
import type { Workstreams } from "./workstreams";
import type { DraftService } from "./draft-service";
import { authorProblem, captureProblem, catalogProblem, draftProblem, sectionProblems, unreachedProblem } from "./problems";
import type { Problem } from "./problem-contract";
import type { Knowledge } from "./workstream-contract";
import type { SectionEligibility } from "./section-contract";
const PROBLEMS_TTL_MS = 30_000;
const PROBLEMS_READ_TIMEOUT_MS = 30_000;
type Problems = { problems: Problem[] };

function waitForRead<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      result => { signal.removeEventListener("abort", onAbort); resolve(result); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export function createProblems(bb: BbPluginApi, sections: Sections, workstreams: Workstreams, drafts: DraftService) {
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  let cache: { generation: number; expiresAt: number; result: Problems } | undefined;
  let inFlight: { generation: number; pending: Promise<Problems> } | undefined;

  async function compute(signal?: AbortSignal): Promise<{ result: Problems; degraded: boolean }> {
    let degraded = false;
    const list = await sections.sectionList(signal);
    signal?.throwIfAborted();
    const catalogs = new Map<string, Promise<Knowledge[]>>();
    const catalog = (id: string) => {
      let pending = catalogs.get(id);
      if (!pending) {
        pending = (async () => {
          const entries: Knowledge[] = [];
          let offset = 0;
          let total = 1;
          while (offset < total) {
            const page = await workstreams.cli.knowledgeList({ workstreamId: id, states: ["approved"], limit: 100, offset }, signal);
            entries.push(...page.items.map(item => item.entry));
            offset += 100; total = page.total;
          }
          return entries;
        })();
        catalogs.set(id, pending);
      }
      return pending;
    };
    const shared = new Map<string, { section: (typeof list.sections)[number]; preview: SectionEligibility | null }[]>();
    const result = await Promise.all(list.sections.map(async section => {
      const entries: Knowledge[] = [];
      const binding = section.binding.binding;
      let catalogFailure: Problem | null = null;
      const preview = binding ? await sections.eligibility(section.id, signal, [], rows => entries.push(...rows)) : null;
      signal?.throwIfAborted();
      if (preview?.status === "unavailable") degraded = true;
      if (binding && preview?.status !== "unavailable" && (["environment", "host"] as const).some(name => (binding.applicability?.[name].mode ?? "unknown") === "unknown")) {
        try { entries.push(...await catalog(binding.workstreamId)); }
        catch (cause) {
          degraded = true;
          catalogFailure = catalogProblem(section, cause instanceof Error ? cause.message : String(cause));
        }
      }
      if (binding) {
        const rows = shared.get(binding.workstreamId) ?? [];
        rows.push({ section, preview });
        shared.set(binding.workstreamId, rows);
      }
      const problems = sectionProblems(section, preview, entries);
      if (catalogFailure) problems.push(catalogFailure);
      let offset = 0;
      let total = 1;
      while (offset < total) {
        const captures = workstreams.store.jobs.pendingCaptures(section.id, 50, offset);
        for (const job of captures.jobs) if (job.status === "failed") problems.push(captureProblem(section, job));
        offset += 50; total = captures.total;
      }
      offset = 0; total = 1;
      while (offset < total) {
        const jobs = drafts.jobs({ sectionId: section.id, limit: 50, offset });
        for (const job of jobs.jobs) {
          const problem = draftProblem(section, job);
          if (problem) problems.push(problem);
        }
        offset += 50; total = jobs.total;
      }
      return problems;
    }));
    const unreached: Problem[] = [];
    for (const [workstreamId, rows] of shared) {
      // A section whose brief could not be read says so itself; its missing entries are not unreached.
      if (rows.some(row => !row.preview || row.preview.status === "unavailable")) continue;
      try {
        const knowledge = await catalog(workstreamId);
        for (const row of rows) {
          const problem = unreachedProblem([row, ...rows.filter(other => other !== row)], knowledge, workstreams.store.problemDismissed);
          if (problem) unreached.push(problem);
        }
      } catch {
        // Even if no section shows a catalog warning, the unreached check was incomplete.
        degraded = true;
      }
    }
    let author: Problem[] = [];
    try { workstreams.human(); } catch { author = [authorProblem()]; }
    return { result: { problems: [...author, ...result.flat(), ...unreached] }, degraded };
  }

  return async (signal?: AbortSignal, { fresh = false } = {}): Promise<Problems> => {
    signal?.throwIfAborted();
    if (fresh) return (await compute(signal)).result;

    lifetime.signal.throwIfAborted();
    const generation = workstreams.problemsGeneration();
    if (cache?.generation === generation && performance.now() < cache.expiresAt) return cache.result;
    if (inFlight?.generation === generation) return waitForRead(inFlight.pending, signal);

    // The shared read has its own deadline even if an SDK call ignores cancellation.
    const readSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(PROBLEMS_READ_TIMEOUT_MS)]);
    const pending = waitForRead(compute(readSignal), readSignal).then(({ result, degraded }) => {
      readSignal.throwIfAborted();
      if (!degraded && workstreams.problemsGeneration() === generation)
        cache = { generation, expiresAt: performance.now() + PROBLEMS_TTL_MS, result };
      return result;
    }).finally(() => {
      if (inFlight?.pending === pending) inFlight = undefined;
    });
    inFlight = { generation, pending };
    return waitForRead(pending, signal);
  };
}
