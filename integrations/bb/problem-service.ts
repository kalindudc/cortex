import type { Sections } from "./sections";
import type { Workstreams } from "./workstreams";
import type { DraftService } from "./draft-service";
import { authorProblem, captureProblem, catalogProblem, draftProblem, sectionProblems, unreachedProblem } from "./problems";
import type { Problem } from "./problem-contract";
import type { Knowledge } from "./workstream-contract";
import type { SectionEligibility } from "./section-contract";
export function createProblems(sections: Sections, workstreams: Workstreams, drafts: DraftService) {
  return async (signal?: AbortSignal) => {
    const list = await sections.sectionList(signal);
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
      if (binding && preview?.status !== "unavailable" && (["environment", "host"] as const).some(name => (binding.applicability?.[name].mode ?? "unknown") === "unknown")) {
        try { entries.push(...await catalog(binding.workstreamId)); }
        catch (cause) { catalogFailure = catalogProblem(section, cause instanceof Error ? cause.message : String(cause)); }
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
        const problem = unreachedProblem(rows, await catalog(workstreamId));
        if (problem) unreached.push(problem);
      } catch {
        // The per-section catalog problem already reports a failed knowledge read.
      }
    }
    let author: Problem[] = [];
    try { workstreams.human(); } catch { author = [authorProblem()]; }
    return { problems: [...author, ...result.flat(), ...unreached] };
  };
}
