# `cortex edit`

Edit a task's title, body, or priority. Body edits have two modes; prefer the anchor-based partial edit.

## Quick reference

```bash
# Title / priority (full replace, naturally race-safe):
cortex edit <id> -t "<new title>"
cortex edit <id> -p <priority>
cortex edit <id> --clear-priority   # clear back to unset (mutex with -p)

# Body — prefer anchor-based partial edit (race-safe):
cortex edit <id> --body-search "<exact unique anchor>" --body-replace "<replacement>"

# Body — full overwrite:
cortex edit <id> -b "<full body>"
cortex edit <id> --body-file <path>
cortex edit <id> --body-file -      # read the new body from stdin

# Structured output for agents:
cortex edit <id> -t "<new title>" --json   # prints the edited task as JSON

# Combined: title + partial body edit in one atomic call
cortex edit <id> -t "<new title>" --body-search "..." --body-replace "..."
```

## Clearing priority

Use `--clear-priority` when a task is no longer urgent (the work that prompted the priority is done) or when a priority was set by mistake. The task stays in its lane and keeps its tags; only the priority flips back to unset. After clearing, `cortex show` omits the `priority:` line, the dashboard hides the priority chip on list rows, and the task sorts after every prioritised row in `cortex ls`.

`--clear-priority` is mutually exclusive with `-p`; passing both exits 1.

## Why anchor-based

A full body overwrite (`-b` / `--body-file`) reads the body, modifies it in memory, writes the whole string back. If another writer changes the body between your read and your write, that change is silently lost.

Anchor-based search/replace makes the existing body content part of the operation. The server finds `--body-search` in the current body (must match exactly once) and splices `--body-replace` in its place, all inside a single transaction. If the anchor is missing or ambiguous, the operation fails loudly so the agent can re-read and refine. The same pattern is used by Aider, Claude Code's edit tool, and Cursor.

## Failure modes

| Outcome | HTTP | CLI exit | Stderr |
|---|---|---|---|
| Anchor not found in current body | 409 | non-zero | `body-search anchor not found in body` |
| Anchor matched N>1 times | 409 | non-zero | `body-search anchor matched N times; refine for uniqueness` |
| `--body-search` without `--body-replace` (or vice versa) | 400 | non-zero | `--body-search and --body-replace must be used together` |
| Combined with `-b` or `--body-file` | 400 | non-zero | `--body-search/--body-replace cannot be combined with -b or --body-file` |
| Empty `--body-search` | 400 | non-zero | `--body-search cannot be empty` |
| Task missing | 404 | non-zero | `task <id> not found` |

On 409, the server response body includes a machine-readable `code`:

- `body_search_not_found`
- `body_search_ambiguous` (with `matches: N`)

The CLI surfaces the SAME codes with `--json`, on both the daemon and direct-store paths: a failed edit prints `{ "error": { "code": "body_search_ambiguous", "message": "...", "matches": 2 } }` to stdout and exits 1. Branch on `code` (not the exit code) to decide whether to re-read + refine the anchor (`body_search_not_found`) or broaden it (`body_search_ambiguous`).

## Recipe: race-safe in-place amendment

```bash
# 1. Read the current body
body=$(cortex show <id> --json | jq -r .task.body)

# 2. Identify a UNIQUE multi-line anchor in the body that contains the
#    section you want to amend. Multi-line anchors are usually the right
#    granularity — they are naturally unique even when individual words
#    are not.
anchor='## Plan
- step 1
- step 2'
replacement='## Plan
- step 1
- step 2
- step 3'

# 3. Run the edit. If the anchor is stale (someone else changed it), the
#    operation fails 409 with code body_search_not_found. The agent re-reads
#    and refines. If the anchor matches multiple times, the operation fails
#    409 with code body_search_ambiguous; the agent broadens the anchor
#    (usually by including more surrounding lines) and retries.
cortex edit <id> --body-search "$anchor" --body-replace "$replacement"
```

## Recipe: making an ambiguous anchor unique

If the target text is short and appears multiple times in the body (e.g. the word "TODO"), include surrounding lines to disambiguate:

```bash
# Bad: "TODO" might match many times → 409 ambiguous
cortex edit 5 --body-search "TODO" --body-replace "DONE"

# Good: surrounding context makes the anchor unique
cortex edit 5 \
  --body-search '## Acceptance
- TODO: write tests' \
  --body-replace '## Acceptance
- DONE: tests written, see updates'
```

## Full overwrite tradeoffs

Full overwrite replaces the entire body in one write. It fits well when:

- Authoring the body for the first time.
- Most of the body is changing in ways that don't share a single coherent anchor.
- Constructing an anchor for the changed region would be longer than the change itself.

The tradeoff is concurrency: a full overwrite succeeds even if another writer has modified the body between your read and your write, replacing their change without signal. Anchor-based partial edits trade that for an explicit 409 on conflict. Sequential anchored edits — one per region — are also an option when several discrete sections change independently. Choose based on the scope of the change and how likely a concurrent write is in your context.

## When to use `cortex update` instead

`cortex update <id> -m "..." --as <session-id>` writes an append-only entry to the audit trail, separate from the task body. It is conflict-free — multiple agents can post updates concurrently with no interference. Updates and body edits address different things: the body is the task's current description, updates are the historical record of progress, findings, and status changes. There is no `update` operation that modifies the body — use `cortex edit` for that.
