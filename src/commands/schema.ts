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
  { name: "init", summary: "initialize the database + write skills/extension" },
  { name: "add", summary: "create a task (--json, --as, --body-file -)" },
  { name: "ls", summary: "list tasks (--json omits body; --full includes it)" },
  { name: "show", summary: "show one task + its updates (--json)" },
  { name: "search", summary: "fuzzy task finder via fzf (--json for scripted use)" },
  { name: "memory", summary: "agent memory: search|show|context|lane (ranked recall, staleness, breadcrumbs; --json)" },
  { name: "update", summary: "post an update / change status (--as required, --json)" },
  { name: "edit", summary: "edit title/body/priority/tags (--json; anchor body edits)" },
  { name: "mv", summary: "move a task to a lane (--json)" },
  { name: "rm", summary: "remove a task (--json, --force)" },
  { name: "lane", summary: "manage lanes: add|ls|edit|rm (--json)" },
  { name: "tag", summary: "manage tags: add|ls|edit|rm (--json)" },
  { name: "doctor", summary: "health/orientation: version, db, daemon, migrations (--json; read-only)" },
  { name: "schema", summary: "print this data-model + command description (--json)" },
  {
    name: "tui",
    summary: "open the terminal workspace (also plain `cortex` in an interactive terminal; starts a headless daemon)",
  },
  {
    name: "serve",
    summary: "run this database's daemon: private socket + localhost dashboard (headless unless --open)",
  },
  { name: "open", summary: "open this database's dashboard in a browser (enables it on a headless daemon)" },
  { name: "stop", summary: "stop the daemon serving this database (others keep running)" },
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
      },
      grammar: {
        taskId: "positive integer, e.g. 42",
        tagName: TAG_NAME_RE.source,
        author: "attribution tag: max 80 chars, no newlines; <role>-<8hex> or pi-<uuidv7>",
        refs: "@<taskId> links a task; #<tag> links a tag (in bodies/summaries)",
        statuses: STATUSES,
        severities: SEVERITIES,
        priority: "non-negative integer; 0 = highest; unset sorts last",
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
