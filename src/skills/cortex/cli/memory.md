# `cortex memory`

Agent memory over cortex tasks: ranked recall across lanes, staleness since
the last body sync, the breadcrumb trail, and the one-call context a harness
fetches per prompt. Protocol: [recipes/memory.md](../recipes/memory.md).

## Usage

```bash
cortex memory search <query> [--lane=<name>] [--boost=<lane>] [--limit=<n>] [--json]
cortex memory show <id> [--section=<text>] [--json]
cortex memory context [--query=<text>] [--author=<tag>] [--exclude=<ids>] [--limit=<n>] [--lane=<name>] [--load-hint=<text>] [--no-primer] [--json]
cortex memory lane
```

## Args

| Command | Args | Output |
|---|---|---|
| `search <query>` | `--lane` (a filter; default every lane), `--boost` (rank this lane higher), `--limit` (default 5, max 20) | ranked hits; `--json`: `{ terms, recent, hits }` |
| `show <id>` | `--section` (only the sections whose heading slug contains it, in full) | staleness + body (section-first past 12,000 chars) + breadcrumb trail; `--json`: `{ task, synced, latest, trail, staleness }` plus `sections` with `--section` |
| `context` | `--query`, `--author` (its streams lead the primer), `--exclude` (ids already shown, comma-separated), `--limit`, `--lane` (the primer's lane and the boosted lane; default: this checkout's), `--load-hint` (how the hits text says to load a hit), `--no-primer` (hits only) | primer + hits from every lane; `--json`: `{ lane, terms, recent, primer, hits, hitsText }` |
| `lane` | none | this checkout's lane (git's common dir: `<repo>/.git` or `~/world/git` names its parent; worktrees share it) |

- A hit or stream carries `activity` (the newest body edit or update, status changes excluded) and `latest`: the newest stream reached through same-lane `@id` links to later-created tasks (a handover chain), or null.
- `recent` is true when the query had a recency word (`last`, `latest`, `recent`, `current`, `today`, ...): the word is dropped from the terms and equally matching hits sort newest activity first.
- A hyphen/underscore/dot compound (`routing-events`) also matches as a phrase, which ranks first.

`staleness` is `{ verdict: "fresh" | "stale" | "unverifiable", synced, ageDays, old, repo: "this" | "other" | "none", changed, missing, checked, behind }`. `repo: "other"` means fewer than half of the cited files exist in this checkout.

## Example

```bash
$ cortex memory search "what was I last doing for the routing-events work" --boost=cortex
$ cortex memory show 42
[42] Mouse wheel notches (open · cortex) · latest linked @57 (open, active 2026-09-29)
staleness: stale · synced 2026-09-01 (29d) · changed: src/tui/mouse.ts
$ cortex memory show 42 --section=next
```

## Pitfalls

- Pass values as `--flag=value`. Nested subcommands skip cortex's argv normalizer, so a dash-leading value in a separate `--flag value` pair is read as a flag.
- The search index and its `@id` link graph are DERIVED: built lazily on the first search, reconciled on every search and show, never backed up. Nothing to maintain.
- Staleness is measured from the last BODY edit, never from status flips or updates. Cited files resolve against the cwd's checkout; when most are absent there (another repo) or outside git the verdict is `unverifiable`.
- Punctuation and filler words ("continue the work", "please fix") are ignored; a query with no content words returns no hits.
