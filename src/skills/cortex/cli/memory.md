# `cortex memory`

Agent memory over cortex tasks: ranked recall, staleness since the last body
sync, the breadcrumb trail, and the one-call context a harness fetches per
prompt. Protocol: [recipes/memory.md](../recipes/memory.md).

## Usage

```bash
cortex memory search <query> [--lane=<name>] [--limit=<n>] [--json]
cortex memory show <id> [--json]
cortex memory context [--query=<text>] [--author=<tag>] [--exclude=<ids>] [--limit=<n>] [--lane=<name>] [--no-primer] [--json]
cortex memory lane
```

## Args

| Command | Args | Output |
|---|---|---|
| `search <query>` | `--lane`, `--limit` (default 5, max 20) | ranked hits; `--json`: `{ terms, hits }` |
| `show <id>` | none | staleness + body + breadcrumb trail; `--json`: `{ task, synced, trail, staleness }` |
| `context` | `--query`, `--author` (its streams lead the primer), `--exclude` (ids already shown, comma-separated), `--limit`, `--lane` (default: this checkout's), `--no-primer` (hits only) | primer + hits; `--json`: `{ lane, terms, primer, hits, hitsText }` |
| `lane` | none | this checkout's lane (git's common dir basename; worktrees share it) |

`staleness` is `{ verdict: "fresh" | "stale" | "unverifiable", synced, ageDays, old, repo: "this" | "other" | "none", changed, missing, checked, behind }`.

## Example

```bash
$ cortex memory context --query="continue the mouse wheel work" --author=pi-0192...
$ cortex memory show 42
staleness: stale · synced 2026-09-01 (29d) · changed: src/tui/mouse.ts
```

## Pitfalls

- Pass values as `--flag=value`. Nested subcommands skip cortex's argv normalizer, so a dash-leading value in a separate `--flag value` pair is read as a flag.
- The search index is DERIVED: built lazily on the first search, reconciled on every search, never backed up. Nothing to maintain.
- Staleness is measured from the last BODY edit, never from status flips or updates. It needs the stream's repo as the cwd; from another repo or outside git the verdict is `unverifiable`.
- Punctuation and filler words ("continue the work", "please fix") are ignored; a query with no content words returns no hits.
