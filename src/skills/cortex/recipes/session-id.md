# Session ID for parallel agents

`cortex update --as <id>` REQUIRES an author id on every call. There are
two ways to provide it; pick the first one that applies.

## (1) PREFERRED — the `cortex_update` tool

If your harness has the `cortex_update` tool registered, call that tool
for every cortex update. The tool auto-attributes the update to your
active harness session, and the resulting updates are **resumable** — the
human supervising you can run `cortex resume <task-id>` and re-open your
exact session.

For pi: `cortex agents install` writes the bundled extension to
`~/.pi/agent/extensions/cortex/index.ts`; pi discovers it on the next start
(no enable step). `cortex_update` and `cortex_recall` then show up in your
"Available tools" list.

```ts
// Inside pi, your tool call looks like:
cortex_update({ task_id: 28, message: "implementation complete", status: "review" })
```

## (2) FALLBACK — generate a session id and pass it via `--as`

If `cortex_update` is not available (different harness, raw shell, CI
script), generate ONE author id at session start, hold it in working
memory, and reuse it on every `cortex update`:

```bash
# Once per session, hold in working memory:
SESSION_ID="${ROLE:-agent}-$(openssl rand -hex 4)"

# Then on every update:
cortex update <id> -m "..." --as "$SESSION_ID"
```

Set `ROLE` to whatever role you're playing — `planner`, `implementer`,
`reviewer`, `triage`. Tags end up looking like `planner-7f3a9201`.

## Why round-trip matters

Updates posted via the `cortex_update` tool carry a `pi-<full-uuidv7>`
author tag that maps 1:1 onto a pi session file. `cortex resume
<task-id>` aggregates these tags and re-opens the chosen session. Updates
posted via the openssl-fallback recipe are NOT resumable — there is no
session file to map to. Prefer the tool whenever it's available.

## Why working memory and not env / file

Two patterns that look tempting but fail in practice:

- **Environment variables (`CORTEX_AUTHOR=...`).** Sandboxed sub-shells
  throw env away. Several agent harnesses spawn sub-processes via
  `bash -c '...'` inside a fresh sandbox, so an exported `CORTEX_AUTHOR`
  set earlier in the session disappears. Worse, the failure mode is
  silent — the variable is just unset, and any code that reads
  `$CORTEX_AUTHOR` with an `or "agent"` fallback now mis-attributes
  every update.
- **A file in the repo (e.g. `.cortex-author`).** Two agents working in
  the same repo (e.g. a planner and an implementer collaborating on one
  branch) cannot disambiguate via a shared file — whichever wrote last
  wins, and the audit trail collapses into one identity. Repo files
  also leak across machines if committed.

The robust answer is to keep the id in the agent's own working memory:
generate once, repeat on every `cortex update`. If you forget, **the
CLI exits 1 with `Missing required argument: --as`** — the failure is
loud and immediate, never silent.

## Tag format

- **Hard limits:** max 80 chars, no newlines (validated by both the CLI
  and the server).
- **Fallback ids:** `<role>-<8 hex>` (~17 chars). Examples:
  `planner-7f3a9201`, `implementer-1c0ed4a8`. `openssl rand -hex 4` =
  4 bytes = ~4.3 billion possible suffixes; collision risk between
  parallel agents on one machine is negligible.
- **Tool-attributed ids:** `pi-<full-uuidv7>` (~39 chars). Example:
  `pi-01923f3a-9201-7c0e-b1c8-abcdef012345`. The full uuid is encoded
  so `pi --session <uuid>` matches exactly one session record.

## Spot-checking attribution

```bash
cortex show <task-id>
```

Each update line shows `[<author>]` — scan to confirm the expected tag
appears, not `agent` or someone else's. Tool-attributed updates show as
`pi-...`; fallback updates show as `<role>-...`.
