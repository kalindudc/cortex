import type { CortexRunner } from "./cli";
import {
  knowledgeSchema,
  workstreamRpcMethods,
  coreContextSchema,
  mutationResultSchema,
  type Applicability,
} from "./workstream-contract";

export function createWorkstreamCli(runner: CortexRunner) {
  return {
    knowledgeList(
      input: {
        query?: string;
        workstreamId?: string;
        states?: string[];
        reviewOnly?: boolean;
        limit: number;
        offset: number;
      },
      signal?: AbortSignal,
    ) {
      const args = ["workstream", "knowledge", "--json", `--limit=${input.limit}`, `--offset=${input.offset}`];
      if (input.query) args.push(`--query=${input.query}`);
      if (input.workstreamId) args.push(`--workstream=${input.workstreamId}`);
      if (input.states?.length) args.push(`--states=${input.states.join(",")}`);
      if (input.reviewOnly) args.push("--review-only");
      return runner.run(args, workstreamRpcMethods.knowledgeSearch.output, { signal });
    },
    list(input: { limit: number; offset: number; archived: boolean }, signal?: AbortSignal) {
      return runner.run(
        [
          "workstream",
          "list",
          "--json",
          `--limit=${input.limit}`,
          `--offset=${input.offset}`,
          ...(input.archived ? ["--archived"] : []),
        ],
        workstreamRpcMethods.workstreamList.output,
        { signal },
      );
    },
    show(input: { id: string; limit: number; offset: number }, signal?: AbortSignal) {
      return runner.run(
        ["workstream", "show", input.id, "--json", `--limit=${input.limit}`, `--offset=${input.offset}`],
        workstreamRpcMethods.workstreamShow.output,
        { signal },
      );
    },
    history(input: { id: string; limit: number; offset: number }, signal?: AbortSignal) {
      return runner.run(
        ["workstream", "history", input.id, "--json", `--limit=${input.limit}`, `--offset=${input.offset}`],
        workstreamRpcMethods.workstreamHistory.output,
        { signal },
      );
    },
    read(id: string, topic: string | null, applicability: Applicability, signal?: AbortSignal) {
      const args = ["workstream", "read", id, "--json"];
      if (topic !== null) args.push(`--topic=${topic}`);
      for (const key of ["environment", "host"] as const) {
        const dim = applicability[key];
        if (dim.mode === "value") args.push(`--${key}=${dim.value}`);
      }
      return runner.run(args, coreContextSchema, { signal });
    },
    mutate(input: object, signal?: AbortSignal) {
      return runner.run(["workstream", "mutate", "--input=-", "--json"], mutationResultSchema, {
        input: JSON.stringify(input),
        signal,
      });
    },
    async knowledge(id: string, signal?: AbortSignal) {
      return runner.run(["workstream", "entry", id, "--json"], knowledgeSchema, { signal });
    },
  };
}
