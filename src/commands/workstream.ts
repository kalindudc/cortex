import { defineCommand } from "citty";
import { withClient } from "../daemon.ts";
import { emitError, printJson } from "../output.ts";
import {
  type KnowledgeState,
  pageQuery,
  parseContextQuery,
  parseWorkstreamMutation,
  validateKnowledgeQuery,
} from "../workstreams.ts";

const json = { type: "boolean" as const, default: false, description: "emit JSON (all workstream results are JSON)" };
const id = { type: "positional" as const, required: true as const, description: "explicit workstream or knowledge ID" };
const page = {
  limit: { type: "string" as const, description: "page size, 1-200 (default 50)" },
  offset: { type: "string" as const, description: "nonnegative page offset (default 0)" },
};
function pagination(args: { limit?: string; offset?: string }) {
  return pageQuery({
    limit: args.limit === undefined ? undefined : Number(args.limit),
    offset: args.offset === undefined ? undefined : Number(args.offset),
  });
}

export default defineCommand({
  meta: {
    name: "workstream",
    description: "revisioned canonical workstreams and saved knowledge; no legacy-task fallback",
  },
  subCommands: {
    entry: defineCommand({
      meta: {
        name: "entry",
        description: "explicit current canonical knowledge read by ID; does not grant delivery permission",
      },
      args: { id, json },
      async run({ args }) {
        try {
          printJson(await withClient(c => c.workstreams.entry(args.id)));
        } catch (e) {
          emitError(args.json, e);
        }
      },
    }),
    knowledge: defineCommand({
      meta: {
        name: "knowledge",
        description: "human review/library search across canonical knowledge; not automatic context",
      },
      args: {
        ...page,
        json,
        query: { type: "string" as const, description: "plain substring search" },
        workstream: { type: "string" as const, description: "explicit workstream ID, including archived" },
        states: { type: "string" as const, description: "comma-separated knowledge states" },
        "review-only": {
          type: "boolean" as const,
          alias: "reviewOnly",
          default: false,
          description: "candidates, disputes, rechecks and expired approved entries",
        },
      },
      async run({ args }) {
        try {
          const query = {
            ...pagination(args),
            query: args.query,
            workstream: args.workstream,
            states: args.states?.split(",") as KnowledgeState[] | undefined,
            reviewOnly: args["review-only"],
          };
          validateKnowledgeQuery(query);
          printJson(await withClient(c => c.workstreams.knowledge(query)));
        } catch (e) {
          emitError(args.json, e);
        }
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "list workstreams" },
      args: {
        ...page,
        json,
        archived: { type: "boolean" as const, default: false, description: "include archived workstreams" },
      },
      async run({ args }) {
        try {
          const query = { ...pagination(args), archived: args.archived };
          printJson(await withClient(c => c.workstreams.list(query)));
        } catch (e) {
          emitError(args.json, e);
        }
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "explicit read of saved knowledge including candidates and history states" },
      args: { id, ...page, json },
      async run({ args }) {
        try {
          const query = pagination(args);
          printJson(await withClient(c => c.workstreams.show(args.id, query)));
        } catch (e) {
          emitError(args.json, e);
        }
      },
    }),
    read: defineCommand({
      meta: {
        name: "read",
        description: "approved applicable orientation and exact topic context, with withheld-claim notices",
      },
      args: {
        id,
        json,
        topic: { type: "string" as const, description: "exact topic facet" },
        environment: { type: "string" as const, description: "explicit environment (omitted means unknown)" },
        host: { type: "string" as const, description: "explicit host/cluster (omitted means unknown)" },
      },
      async run({ args }) {
        try {
          const query = parseContextQuery({ topic: args.topic, environment: args.environment, host: args.host });
          printJson(await withClient(c => c.workstreams.read(args.id, query)));
        } catch (e) {
          emitError(args.json, e);
        }
      },
    }),
    history: defineCommand({
      meta: { name: "history", description: "read attributed revisions of a workstream or knowledge ID" },
      args: { id, ...page, json },
      async run({ args }) {
        try {
          const query = pagination(args);
          printJson(await withClient(c => c.workstreams.history(args.id, query)));
        } catch (e) {
          emitError(args.json, e);
        }
      },
    }),
    mutate: defineCommand({
      meta: {
        name: "mutate",
        description:
          "apply one typed JSON mutation; existing IDs require expectedRevision; approval requires an explicit human actor (not authentication)",
      },
      args: {
        json,
        input: {
          type: "string" as const,
          required: true as const,
          description: "mutation JSON, or - for stdin (use --input=-)",
        },
      },
      async run({ args }) {
        try {
          const text = args.input === "-" ? await Bun.stdin.text() : args.input;
          if (text.length > 2 * 1024 * 1024) throw new Error("Mutation JSON exceeds the input limit");
          const mutation = parseWorkstreamMutation(JSON.parse(text));
          printJson(await withClient(c => c.workstreams.mutate(mutation)));
        } catch (e) {
          emitError(args.json, e);
        }
      },
    }),
  },
});
