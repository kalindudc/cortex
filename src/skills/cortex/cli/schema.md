# `cortex schema`

Print the cortex data model and command grammar in one call — the fastest way for an agent to orient without probing `--help` per command. Reads nothing from the database.

## Usage

```bash
cortex schema          # human summary
cortex schema --json   # machine-readable model + grammar + commands
```

## JSON shape

```jsonc
{
  "version": "0.2.0",
  "tables": {
    "tasks":  { "columns": [...], "enums": { "status": ["draft","open","review","blocked","done"] } },
    "updates":{ "columns": [...], "enums": { "severity": ["progress","review","blocked"] } },
    "lanes":  { "columns": ["name","color","sort"] },
    "tags":   { "columns": ["name","color","created"] },
    "task_tags":     { "columns": ["task_id","tag_name"] },
    "notifications": { "columns": [...] }
  },
  "grammar": {
    "taskId": "positive integer, e.g. 42",
    "tagName": "^[a-z0-9_@-]{1,32}$",
    "author": "attribution tag: max 80 chars, no newlines; <role>-<8hex>, pi-<uuidv7> or bb-<thread-id>",
    "refs": "@<taskId> links a task; #<tag> links a tag (in bodies/summaries)",
    "statuses": ["draft","open","review","blocked","done"],
    "severities": ["progress","review","blocked"],
    "priority": "non-negative integer; 0 = highest; unset sorts last"
  },
  "output": {
    "json": "every mutating command accepts --json ... exit 0 success / 1 error",
    "errorCodes": ["not_found","bad_request","validation","conflict","body_search_not_found","body_search_ambiguous","error"]
  },
  "commands": [ { "name": "add", "summary": "..." }, ... ]
}
```

## The agent I/O contract

- Every mutating command (`add`, `edit`, `update`, `mv`, `rm`, `tag add|edit|rm`, `lane add|edit|rm`) accepts `--json`.
- With `--json`: success prints the resulting object to **stdout**; an error prints `{ "error": { "code", "message", "matches"? } }` to **stdout**. Human diagnostics never pollute stdout.
- Exit code is `0` on success and `1` on error — the machine discriminator is the `code` field, not the exit code.
- Error `code` values are listed under `output.errorCodes`. Anchor body edits surface `body_search_not_found` and `body_search_ambiguous` (the latter with `matches`).
