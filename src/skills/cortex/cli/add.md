# `cortex add`

Create a new task. Returns `[<id>] <title>` on success — capture the id for later `cortex update`, `cortex show`, etc.

## Usage

```bash
cortex add "<title>" [-l <lane>] [-p <priority>] [-b <body> | --body-file <path>|-] [-s <status>] [-t <tags>] [--as <id>] [--json]
```

## Args

| Flag | Alias | Default | Description |
|---|---|---|---|
| `<title>` | (positional) | — | Task title. Quote it if it contains spaces. |
| `--lane` | `-l` | `now` | Lane name. Auto-created if it doesn't exist. |
| `--priority` | `-p` | (none) | Optional. Non-negative integer. **0 = highest**, larger numbers = lower priority. Leave unset for archive/document tasks (plans, research notes, anything you organise by lane or tag rather than urgency). |
| `--body` | `-b` | — | Longer description shown by `cortex show <id>`. |
| `--body-file` | — | — | Read the body from a file. `--body-file -` (or `--body-file=-`) reads stdin. Mutually exclusive with `-b`. ALWAYS prefer this over `-b` for KB-scale markdown (shell escaping is a footgun). |
| `--status` | `-s` | `open` | One of `draft`, `open`, `review`, `blocked`, `done`. Set the initial status of the task. |
| `--tags` | `-t` | — | Comma-separated tag names (e.g. `-t "plan,my-feature"`). Auto-creates missing tags. Tag names match `[a-z0-9_@-]{1,32}`. |
| `--as` | `--author` | — | Optional attribution tag. When set, records the first `created` update so the task isn't anonymous (create + attribute in ONE call). |
| `--json` | — | `false` | Emit the created task as JSON on stdout instead of `[<id>] <title>`. On failure emits `{ "error": { "code", "message" } }` and exits 1. |

## Examples

Urgent work item — set a priority so it sorts to the top:

```bash
$ cortex add "Investigate flaky CI on main" -l now -p 0 -b "Failures cluster in test/db.test.ts; happens ~1 in 5 runs."
[42] Investigate flaky CI on main
```

Archive/document task — omit `--priority`; the task sorts after every prioritised row in `cortex ls` and the dashboard hides the priority chip:

```bash
$ cortex add "Plan: nullable priority" -l cortex -t plan
[132] Plan: nullable priority
```

The new task starts in status `open` with no updates yet.

JSON + one-shot attribution (create, attribute, and capture the id in one call):

```bash
$ cortex add "Plan: nullable priority" -l cortex -t plan --as planner-7f3a9201 --json | jq .id
132
```

Body from stdin (no tmpfile needed):

```bash
$ generate_plan | cortex add "Plan: X" --body-file - --json
```

## Pitfalls

- **Author attribution is per-update, not per-task.** `cortex add` does NOT take an `--as` / `--author` flag. Tasks are created anonymously; the audit trail starts only when someone posts the first `cortex update --as <id>`. If you want to record who created the task, immediately follow `add` with an `update` carrying your session id (see [session-id recipe](../recipes/session-id.md)).
- **Do NOT auto-set `--priority` without an explicit user signal.** Most tasks are opt-in metadata containers (plans, research notes, archives). Priority is an urgency annotation; only set it when the user asked you to.
- `--priority` rejects negatives, decimals, and non-numeric strings. `-p 1.5` or `-p high` exit 1.
- A title-only task is fine; `--body` is for context the dashboard hides until you click into the task.
- Lanes are case-sensitive. `-l Now` and `-l now` create two separate lanes.
