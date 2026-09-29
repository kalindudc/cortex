# Persisting documents as cortex tasks

Canonical mechanics for any skill that stores a document (plan, research
analysis, PR review, PR description) as the BODY of a cortex task. Role
skills define their own tags and status flows; the mechanics below are
shared and MUST NOT be re-specified per skill.

## 1. Author identity

Use the `cortex_update` tool when registered; otherwise generate ONE
session id at session start and pass it via `--as` on every update. Full
rules and rationale: [session-id recipe](session-id.md).

```bash
SESSION_ID="<role>-$(openssl rand -hex 4)"   # e.g. planner-7f3a9201
```

Format `<role>-<8 hex>`, max 80 chars, no newlines. NEVER store it in env
vars (sandboxed sub-shells drop them) or repo files (two agents collapse
into one identity in the audit trail).

## 2. Lane

Default lane = current repository directory name. Override only when the
user explicitly names a different lane.

```bash
LANE=$(cortex memory lane)
```

## 3. Create with a body file

Draft the document into a tmpfile and persist via `--body-file`. NEVER
inline `-b "..."` for KB-scale markdown — shell escaping is a footgun.

```bash
BODY=$(mktemp -t cortex-doc.XXXXXX.md)
# write the document markdown to "$BODY"
cortex add "<title>" --lane "$LANE" --status draft --body-file "$BODY" -t "<tags>"
# stdout: [<id>] <title>
```

Do NOT pass `--priority` unless the user explicitly asked for an urgency
annotation — documents are organised by lane + tags, not a priority queue.

## 4. Attribute immediately

`cortex add` is anonymous. Record WHO created the task right after:

```bash
cortex update <id> --as "$SESSION_ID" -m "<role summary, e.g. 'plan written'>"
```

## 5. Revise

Two body-edit modes — pick by scope of change (details: [cli/edit.md](../cli/edit.md)):

- Surgical change (fix a line, mark a task done): anchor-based edit.
  Fails 409 if the anchor is missing or ambiguous — re-read, refine, retry.
  ```bash
  cortex edit <id> --body-search '<exact unique anchor>' --body-replace '<replacement>'
  ```
- Large restructure: full-body rewrite.
  ```bash
  cortex show <id> --json | jq -r .task.body > /tmp/body.md
  # edit /tmp/body.md
  cortex edit <id> --body-file /tmp/body.md
  ```

After any body edit, post an update: `cortex update <id> --as "$SESSION_ID" -m "revised: <summary>"`.

NEVER edit a task whose status is `review` without explicit user
confirmation — it silently destroys a review handoff.

## 6. Cross-link related tasks

To link task A to task B, post an update on A whose body contains the
literal token `@<B-id>` (e.g. `@114`) — greppable from `cortex show`.
