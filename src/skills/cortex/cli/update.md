# `cortex update`

Post an update on a task. Optionally flip the task's status in the same call.

> ⚠️ **Every update needs an author: `--as <id>` (alias `--author`), or the bb thread default.**
>
> Cortex is multi-agent by design. Every update must self-attribute so the human supervisor can tell the planner from the implementer from the reviewer in the inbox. Inside a bb thread with a valid `BB_THREAD_ID`, the author defaults to `bb-<thread id>`; an explicit `--as` always wins. Outside bb there is no default: generate a session id ONCE at the start of your agent session via the [session-id recipe](../recipes/session-id.md) and pass it on every `cortex update`.
>
> If `--as` is missing outside a bb thread, the CLI rejects the call before the daemon is contacted. You will see:
>
> ```text
> $ cortex update 42 -m "looks ready"
> error: --as is required outside a bb thread
> ```
>
> Exit code is non-zero. **This is loud, not silent — easy to catch in agent loops.**

## Usage

```bash
cortex update <id> -m "<message>" --as <session-id> [-s <status>] [-b <body>] [--json]
```

## Args

| Flag | Alias | Required | Description |
|---|---|---|---|
| `<id>` | (positional) | yes | Task id from `cortex ls`. |
| `--message` | `-m` | yes | What changed and what it means, in one or two plain sentences on one line, **max 4096 chars**. Put numbers, lists and logs in `--body`. |
| `--as` | `--author` | outside bb | Author tag: `<role>-<8 hex>`, `pi-<uuidv7>` or `bb-<thread id>`; max 80 chars, no newlines. Defaults to `bb-<thread id>` in a bb thread. See [recipes/session-id.md](../recipes/session-id.md). |
| `--status` | `-s` | no | One of `draft`, `open`, `review`, `blocked`, `done`. Flips the task and writes an audit-trail row. |
| `--body` | `-b` | no | Longer detail shown by `cortex show <id>`. |
| `--json` | — | no | Emit `{ "update": {...}, "status"? }` as JSON on stdout instead of the `✓ ...` lines. On failure emits `{ "error": { "code", "message" } }` and exits 1. |

## Examples

Plain update, no status change:

```bash
cortex update 42 -m "Repro confirmed — race in test setup, not the code under test." \
  --as planner-7f3a9201
```

Update + status flip (writes BOTH a message row AND a `status → blocked` audit row, both attributed to `--as`):

```bash
cortex update 42 -m "Need a Stripe test key from ops; pausing here." \
  -s blocked \
  --as implementer-1c0ed4a8
```

The TUI flashes ONLY for the second example, because the transition is into `blocked`.

## Pitfalls

- **Forgetting `--as` outside bb exits 1** with `error: --as is required outside a bb thread`. The fix is to grab your session id (held in working memory for the lifetime of the session — see the recipe) and re-run.
- **Newlines in `--as` are rejected.** `-m` is not validated for newlines, but keep it on one line as one or two plain sentences; use `-b` for multi-line detail.
- **`--as` over 80 chars is rejected.** The format is `<role>-<8 hex>` (~17 chars); 80 is generous but enforced.
- **`-m` over 4096 chars is rejected** by the SQLite `CHECK` constraint (`summary too long (max 4096 chars)`); neither the CLI nor the daemon pre-validates length. If your update is that long, the body (`-b`) is the right place; keep `-m` as a scannable headline.
- **No `--severity` flag exists.** Encode urgency in the message text (`"ready for review"`, `"blocking release"`, `"FYI only"`). Structured signal goes in `--status`, not a separate severity dimension.
- Setting `-s` to the task's CURRENT status still writes an audit row. That's intentional: re-confirming `blocked` after a check-in is useful history.
