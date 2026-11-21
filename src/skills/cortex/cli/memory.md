# `cortex memory`

Agent memory over cortex tasks: ranked recall across lanes, staleness since
the last body sync, the breadcrumb trail, and the one-call context a harness
fetches per prompt. Protocol: [recipes/memory.md](../recipes/memory.md).

## Usage

```bash
cortex memory search <query> [--lane=<name>] [--boost=<lane>] [--limit=<n>] [--json]
cortex memory show <id> [--section=<text>] [--json]
cortex memory context [--query=<text>] [--author=<tag>] [--exclude=<ids>] [--limit=<n>] [--lane=<name>] [--load-hint=<text>] [--no-primer] [--json]
cortex memory streams --author=<tag> [--with-excluded] [--limit=<n>] [--json]
cortex memory lane [--checkout]
cortex memory exclude <id> [--as <author>] [-m <reason>] [--json]
cortex memory include <id> [--as <author>] [-m <reason>] [--json]
cortex memory excluded [--json]
```

## Args

| Command | Args | Output |
|---|---|---|
| `search <query>` | `--lane` (a filter; default every lane), `--boost` (rank this lane higher), `--limit` (default 5, max 20) | ranked hits; `--json`: `{ terms, recent, hits }` |
| `show <id>` | `--section` (only the sections whose heading slug contains it, in full) | staleness + body (section-first past 12,000 chars) + breadcrumb trail; `--json`: `{ task, synced, latest, trail, staleness }` plus `sections` with `--section` |
| `context` | `--query`, `--author` (its streams lead the primer), `--exclude` (ids already shown, comma-separated), `--limit`, `--lane` (the primer's lane and the boosted lane; default: this checkout's), `--load-hint` (how the hits text says to load a hit), `--no-primer` (hits only) | primer + hits from every lane; `--json`: `{ lane, checkoutLane, terms, recent, primer, primerIds, hits, hitsText }` (`checkoutLane`: Git-verified lane, or null) (`primerIds`: the streams the primer lists) |
| `streams` | `--author` (required; the tasks that author posted updates to), `--with-excluded` (also tasks kept out of memory, for the user's own views), `--limit` (default 20, max 50) | bodiless rows, newest activity first; `--json`: `[{ id, title, lane, status, tags, updated, synced, activity, memory_excluded }]` |
| `lane` | `--checkout` (print nothing outside Git) | this checkout's lane (worktrees share it); without the flag, falls back to the current folder's name outside Git |
| `exclude <id>` / `include <id>` | `-m` / `--message` (reason, required for agents), `--as` (author; required with a reason outside bb) | commit the change and attributed reason together, nothing on a no-op; `--json`: the task with a `changed` boolean |
| `excluded` | none | the tasks kept out of memory, with who excluded them, when and why if known; `--json`: task rows without bodies |

- A hit or stream carries `activity` (the newest body edit or update, status changes excluded) and `latest`: the newest stream reached through same-lane `@id` links to later-created tasks (a handover chain), or null.
- `recent` is true when the query had a recency word (`last`, `latest`, `recent`, `current`, `today`, ...): the word is dropped from the terms and equally matching hits sort newest activity first.
- A hyphen/underscore/dot compound (`routing-events`) also matches as a phrase, which ranks first.

`staleness` is `{ verdict: "fresh" | "stale" | "unverifiable", synced, ageDays, old, repo: "this" | "other" | "none", changed, missing, checked, behind }`. `repo: "other"` means fewer than half of the cited files exist in this checkout.

## Example

```bash
$ cortex memory search "what was I last doing for the routing-events work" --boost=cortex
$ cortex memory show 42
[42] Idle stream heartbeat (open · cortex) · latest linked @57 (open, active 2026-09-29)
staleness: stale · synced 2026-09-01 (29d) · changed: src/server.ts
$ cortex memory show 42 --section=next
```

## Pitfalls

- In bb, agents use `cortex_curate`; never use the CLI to bypass a refusal. The no-reason form is for the user's own actions. Loading by id still works. Task JSON keeps the boolean `memory_excluded` and includes `memory_exclusion` metadata on excluded tasks.

- Pass values as `--flag=value`. Nested subcommands skip cortex's argv normalizer, so a dash-leading value in a separate `--flag value` pair is read as a flag.
- The search index and its `@id` link graph are DERIVED: built lazily on the first search, reconciled on every search and show, never backed up. Nothing to maintain.
- Staleness is measured from the last BODY edit, never from status flips or updates. Cited files resolve against the cwd's checkout; when most are absent there (another repo) or outside git the verdict is `unverifiable`.
- Punctuation, filler words ("continue the work", "something came up"), URLs, absolute, `~/` and `./` paths, emails, UUIDs, commit hashes and fenced code are ignored. Repo-relative paths, inline code, `@id` and `#tag` still count. A query with no content words returns no hits.
