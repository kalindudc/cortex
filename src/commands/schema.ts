import { defineCommand } from "citty";
import pkg from "../../package.json" with { type: "json" };
import { TAG_NAME_RE } from "../store.ts";
import { ErrCode, printJson } from "../output.ts";

/**
 * `cortex schema` — a static, DB-free description of the cortex data model and
 * command grammar so an agent can orient in ONE call instead of probing
 * `--help` per command. Built from the same constants the store enforces
 * (TAG_NAME_RE, the status/severity enums) plus the shared error-code set.
 */

const STATUSES = ["draft", "open", "review", "blocked", "done"] as const;
const SEVERITIES = ["progress", "review", "blocked"] as const;

const COMMANDS: { name: string; summary: string }[] = [
  { name: "init", summary: "initialize or migrate the database (agent tools: `cortex agents install`)" },
  {
    name: "agents",
    summary:
      "agents status|install|reset: the skills + pi extension (when pi is present) + bb plugin (when bb is); status compares, reset wipes first",
  },
  { name: "add", summary: "create a task (--json, --as, --body-file -)" },
  { name: "ls", summary: "list tasks (--json omits body; --full includes it)" },
  { name: "show", summary: "show one task + its updates (--json)" },
  { name: "search", summary: "fuzzy task finder via fzf (--json for scripted use)" },
  {
    name: "memory",
    summary:
      "agent memory: search|show|context|streams|lane|exclude|include|excluded (ranked recall, staleness, breadcrumbs; --json)",
  },
  {
    name: "update",
    summary: "post an update / change status (--as or bb thread, --json; --as-me only for tools acting for the user)",
  },
  {
    name: "workstream",
    summary:
      "canonical saved knowledge: list|show|entry|read|history|knowledge; mutate --input JSON (--json); attributed, revision-guarded mutations, candidates require human approval",
  },
  { name: "watch", summary: "follow changes and reconnect markers (--json)" },
  { name: "edit", summary: "edit title/body/priority/tags (--json; anchor body edits)" },
  { name: "mv", summary: "move a task to a lane (--json)" },
  { name: "rm", summary: "remove a task (--json, --force)" },
  { name: "lane", summary: "manage lanes: add|ls|edit|rm (--json)" },
  { name: "tag", summary: "manage tags: add|ls|edit|rm (--json)" },
  { name: "doctor", summary: "health/orientation: version, db, daemon, migrations (--json; read-only)" },
  { name: "schema", summary: "print this data-model + command description (--json)" },
  {
    name: "serve",
    summary: "run this database's daemon on its private socket (the desktop app starts one when needed)",
  },
  { name: "stop", summary: "stop the daemon serving this database (others keep running)" },
  { name: "app", summary: "open the installed desktop app, optionally at a task: app [id] [--heading slug]" },
  { name: "resume", summary: "re-open the harness session that posted updates on a task" },
  { name: "backup", summary: "write a data-only backup zip" },
  { name: "restore", summary: "merge a backup zip into the live database" },
  { name: "reset", summary: "stop this database's daemon, wipe and re-init the database (destructive)" },
];

export default defineCommand({
  meta: {
    name: "schema",
    description: "describe the cortex data model + command grammar for agents",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "emit the schema as JSON instead of the human summary",
    },
  },
  run({ args }) {
    const schema = {
      version: pkg.version,
      tables: {
        tasks: {
          columns: ["id", "lane", "title", "body", "status", "priority", "created", "updated"],
          enums: { status: STATUSES },
        },
        updates: {
          columns: ["id", "task_id", "author", "summary", "body", "severity", "created"],
          enums: { severity: SEVERITIES },
        },
        lanes: { columns: ["name", "color", "sort"] },
        tags: { columns: ["name", "color", "created"] },
        task_tags: { columns: ["task_id", "tag_name"] },
        notifications: {
          columns: ["id", "task_id", "author", "status", "title", "message", "read", "created"],
        },
        memory_exclusions: { columns: ["task_id"] },
        workstreams: { columns: ["id", "revision", "data"] },
        knowledge: { columns: ["id", "workstream_id", "revision", "data"] },
        workstream_revisions: { columns: ["id", "revision", "data"] },
      },
      grammar: {
        taskId: "positive integer, e.g. 42",
        tagName: TAG_NAME_RE.source,
        author: "attribution tag: max 80 chars, no newlines; <role>-<8hex>, pi-<uuidv7> or bb-<thread-id>",
        refs: "@<taskId> links a task; #<tag> links a tag (in bodies/summaries)",
        statuses: STATUSES,
        severities: SEVERITIES,
        priority: "non-negative integer; 0 = highest; unset sorts last",
      },
      workstream: {
        types: "src/workstreams.ts: WorkstreamMutation, Workstream, Knowledge, WorkstreamsApi",
        actor: { id: "nonempty attribution string", type: ["human", "agent", "system"] },
        applicability: {
          environment: "{mode:'value',value:string}|{mode:'not-applicable'}|{mode:'unknown'}",
          host: "same tagged dimension; unknown is not a wildcard",
        },
        source: {
          ref: "string",
          excerpt: "optional captured text",
          authorType: ["human", "agent", "system", "unknown"],
          observedAt: "ISO UTC timestamp",
          status: "optional: available|archived|unreachable; caller-reported, not a live check",
        },
        common:
          "Every mutation requires op and actor. Existing IDs require expectedRevision and reason. Unknown fields refuse.",
        mutations: {
          create: { required: ["name"], optional: ["description"] },
          "edit-workstream": {
            required: ["id", "expectedRevision", "reason"],
            optional: ["name", "description", "archived"],
            permission: "human",
          },
          propose: {
            required: ["workstreamId", "subject", "title", "text", "kind", "facet", "applicability", "sources"],
            optional: ["expiresAt"],
            result:
              "candidate only; no-save requires identical normalized text and matching subject, facet, kind, applicability and expiry with no new evidence. Other collisions remain reviewable candidates.",
          },
          edit: {
            required: ["id", "expectedRevision", "reason"],
            optional: ["title", "text", "facet", "sources", "expiresAt"],
            result: "new candidate revision; clear approval, protected directive edits require human",
          },
          evidence: {
            required: ["id", "expectedRevision", "reason", "sources"],
            result: "append distinct evidence without approving or renewing expiry",
          },
          transition: {
            required: ["id", "expectedRevision", "reason", "state"],
            states: ["approved", "recheck", "archived", "rejected", "forgotten"],
            permission: "human; forget scrubs stored content, not prior deliveries or archives",
          },
          conflict: {
            required: ["id", "expectedRevision", "reason", "otherId", "otherExpectedRevision"],
            result: "reciprocal dispute; an agent cannot remove an approved human directive",
          },
          supersede: {
            required: ["id", "expectedRevision", "reason", "otherId", "otherExpectedRevision"],
            permission: "human; id replaces otherId, same workstream/applicability, no competing subject owner",
          },
        },
        read: "Explicit ID, orientation plus exact topic, approved/applicable/unexpired only; claim-free review notices. No legacy fallback. Consumer grants/budgets/receipts belong to the integration.",
        trust:
          "Actor attribution is not authentication. Local single-user API; integrations must derive human approval from trusted user actions.",
        semanticDeduplication:
          "Not implemented. Normalized text/subject and shared evidence provide comparison hints only. No scores, automatic merges or promotion.",
      },
      output: {
        json: "every mutating command accepts --json: success prints the resulting object to stdout; errors print { error: { code, message, matches? } } to stdout; exit 0 on success, 1 on error",
        errorCodes: Object.values(ErrCode),
      },
      commands: COMMANDS,
    };
    if (args.json) {
      printJson(schema);
      return;
    }
    console.log(`cortex ${schema.version} — data model + commands`);
    console.log(`statuses:    ${STATUSES.join(", ")}`);
    console.log(`tag names:   ${schema.grammar.tagName}`);
    console.log(`refs:        ${schema.grammar.refs}`);
    console.log(`error codes: ${schema.output.errorCodes.join(", ")}`);
    console.log("commands:");
    for (const c of COMMANDS) {
      console.log(`  ${c.name.padEnd(9)} ${c.summary}`);
    }
  },
});
