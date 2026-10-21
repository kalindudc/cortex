---
budget: 200
sources: [src/memory.ts, src/store.ts, src/commands/memory.ts, src/server.ts, src/extensions/pi.ts,
  src/extensions/memory-view.ts, src/skills/cortex/recipes/memory.md, integrations/bb/turns.ts]
---
# Agent memory

Coding agents forget everything when a session ends. Cortex lets them pick up where they left off by reading and
writing ordinary cortex tasks. This page explains what that looks like for you and your agents, then how it is
built and which rules keep it cheap and trustworthy.

## The idea: tasks double as memory

Each task an agent works on is a memory stream it can continue later; there is no separate store. In a stream:

- the body is the current state of the work, rewritten at milestones rather than appended to;
- updates are the history (progress notes, status changes), also called breadcrumbs;
- the lane is the project (`cortex memory lane` prints this checkout's default, shared by its worktrees);
- status is only your tracking: a `done` stream still counts as memory.

## What does a good memory stream look like?

A small template, ending with the date the body was last checked against the code:

```markdown
## Goal
Keep an idle live stream connected.
## State
The heartbeat is sent in server.ts; Bun closes a connection that is idle for 10 s.
## Decisions
- User: keep the heartbeat under the idle timeout. Rejected: raising Bun's timeout (hides dead peers).
## Next
1. Pin it with an integration test.
## Files
- `src/server.ts`
Verified: 2026-09-30
```

Decisions hold what a later agent must honour without you repeating it. Files lists what the stream relies on,
which is how cortex tells when it is out of date. The full protocol agents follow (when to read, write, or leave
memory alone) is the recipe `src/skills/cortex/recipes/memory.md`, installed by `cortex agents install`.

## How do agents find memory?

With pi (the coding agent cortex ships an extension for), memory arrives on its own:

- At session start the agent gets a primer: a short list of the streams it touched, the project's unfinished
  streams and a few recently active in other projects.
- On the first prompt, and whenever a later prompt asks about earlier work ("continue", "what was I doing",
  `@42`), relevant streams it has not seen yet arrive as a hidden message.
- The `cortex_recall` tool loads a stream (`"@42"`), one section of it (`"@42#next"`), or searches by keywords.

In bb the Cortex plugin gives every provider the primer and `cortex_recall`; pi, Claude Code and Codex get hits too.
Elsewhere without pi, an agent runs `cortex memory context --query="<the ask>"` once, then `cortex memory show <id>`.

Search matches words and their forms, and each hit shows which words matched. Full paths, links, commit hashes, UUIDs,
pasted code blocks and small talk in the ask are ignored, so they never pull in unrelated streams; a repo-relative
file like `src/server.ts` still counts. It covers every project, the current one first, because work spans repos. A
long body opens with its priority sections (Next, open questions, Decisions, State) and lists the rest. An older
stream names the newer one continuing it as its "latest linked". `cortex memory exclude <id>`, the desktop app's "Keep
out of agent memory" command or bb's More menu keep a task out of all of this; reading it by id still works, and a
running pi session keeps its primer until compaction or `/memory refresh`.

## When is memory stale?

Only a body edit re-syncs a stream. Updates and status changes posted since are listed with it, for the agent to
fold into State and Next. Each time a stream is loaded, cortex checks it against your checkout:

- fresh: nothing it cites changed since the re-sync; the agent continues from Next.
- stale: a file under Files changed or vanished, or the body has not been re-synced in a long time. The agent
  re-reads those files, fixes the body and refreshes `Verified:` before relying on it.
- unverifiable: there is no git checkout, or most cited files are not in it (the stream is about another repo).
  The agent verifies in the right place first.

## What you see in pi

The footer holds a quiet memory marker that fills in once memory is in context. It speaks up only when it matters:
a memory call failed (red), the agent is using a stale stream (yellow, with its id), or the automatic save turn is
running (a spinner). `/memory` opens a panel: health, the streams this session is working on, every stream in
context and why (session summary, matched your prompt, recalled by the agent) and the session's totals. It ends
with a legend of the symbols; `r` re-reads memory on the next prompt. In bb the extension steps aside and the Cortex
plugin's icon and Memory tab show the same states ([docs/bb.md](bb.md#memory-in-the-prompt-box-and-the-memory-tab)).

Only the session you type into writes memory; headless ones (delegated agents, `pi -p` scripts) only read.
`CORTEX_MEMORY=write|read|off` overrides that for the whole process.

## What does it cost?

- At most one memory lookup per prompt, and none after the first unless the prompt asks about earlier work.
- The primer stays byte-identical until compaction or `/memory refresh`, so your provider's prompt cache holds.
- `cortex_recall` has a small per-request budget and answers a repeated query without searching again.
- At most one extra "memory checkpoint" turn per request, only when the agent changed files and saved nothing.
- Lookups grow with the number of streams, not with their updates: each task's updates are read through an index.
- Nothing leaves your machine through cortex: search runs on the local database, and results go only into your
  agent's context, next to your prompt.

## Under the hood

`src/memory.ts` holds the helpers and never opens the Store; the index and ranking live in `src/store.ts`; roles
exist only in the pi extension. Budgets are named symbols: `src/memory.ts#MEMORY_LIMITS`, the constants atop
`src/extensions/pi.ts`, and BM25 weights inline in `src/store.ts#searchMemory`.

### The index: derived, lazy, reconciled on read

FTS5 is SQLite's full-text search engine. Its tables (`_memory_sections`, `_memory_section_map`, and
`_memory_links` for `@id` references) are derived from tasks, always rebuildable and never backed up.

- `src/store.ts#ensureMemoryIndex` creates them on the first search or show. Why not in `migrate()`? A SQLite
  built without FTS5 then breaks only memory search, loudly, not the tracker.
- `src/store.ts#reconcileMemoryIndex` runs inside the read's transaction and re-indexes any task whose signature
  (its revision token, or `updated` if never stamped) changed. A hit always reflects the current task, and no
  write path knows the index exists. A task in `memory_exclusions` (the user's choice, backed up) gets no
  sections, keeping its links. Why not a `no-memory` tag? Tag renames and `--set-tags` would undo it silently.
- The unit is a section (`src/memory.ts#memorySections`): body and update log split at headings and a size cap,
  each row carrying title and tags; the log skips status audits and `created` rows. Why not whole documents? Terms
  scattered across a long body qualified it for every broad query.

### Lanes and ranking

`src/memory.ts#memoryLane` names the repo from git's common dir in one spawn (`src/memory.ts#repoInfo`), else the
directory. The search route in `src/server.ts` tokenizes with `src/memory.ts#memoryTerms`. It first blanks text
that names no topic (`src/memory.ts#queryText` applying `src/memory.ts#QUERY_NOISE`): fenced code, URLs, emails,
UUIDs, and `~/`, `./`, `../` or absolute paths of two or more segments. A pasted checkout path would otherwise spend
the term budget on `users`, `src`, `github`. It then drops short tokens, digits, hex ids
(`src/memory.ts#isTermToken`) and `src/memory.ts#STOPWORDS`: function words, agent and conversational filler,
which would surface every stream, but never a word naming a cortex topic or command, nor a
`src/memory.ts#RECENCY_WORDS` member. `src/memory.ts#recencyIntent` makes recency words a newest-activity
tie-break only (a global blend was measured to cut precision); `src/memory.ts#memoryPhrases` searches compounds
like `routing-events` as phrases, from the same blanked text. Every surface (`cortex memory search`,
`cortex memory context`, pi's automatic hits, `cortex_recall`) gets these terms. Why not drop every path and
inline code? Streams cite repo-relative files (`src/server.ts`) and identifiers, and recall by them works. Why
not stopword `update` or `repo`? They name cortex topics. Why not clean the query in the pi extension or the
route? A copy in the extension drifts, and a future caller of the helpers would get raw text.
`src/store.ts#searchMemory` searches every lane and keeps a section only when it covers `MEMORY_LIMITS.minMatched`
stem groups (fewer for shorter queries), title and tags counting everywhere: a wrong memory is worse than none.
Order: phrase match, coverage, the tie-break, BM25 (title over tags over text) times the lane boost, then id.
Activity (`src/store.ts#ACTIVITY_SQL`) ignores status flips and lane or tag moves. `src/store.ts#latestLinked`
follows `@id` links to later streams in the same lane, bounded, to a handover chain's head; it and the stream lists
skip excluded tasks through `src/store.ts#MEMORY_EXCLUDED_SQL`.

### Staleness and breadcrumbs

`_body_edits` (private, created in `migrate()`) records when each body last changed and the highest update id then
(the breadcrumb watermark). Only `src/store.ts#recordBodySync` writes it, on creation and real body changes;
`src/store.ts#forgetBodySync` clears it on restore, which can reuse an id.

Checks run in the CLI only, since the daemon's working directory is not your repo, and git runs only outside
`src/daemon.ts#withClient`, never while the database lease (its one-owner lock) is held. `src/memory.ts#citedPaths`
reads paths only under `## Files` or `### Beginning context`, or prose like `Store.open` would count as missing.
`src/memory.ts#checkStaleness` resolves them against the work-tree root and compares file times with the sync. Why
not `git log --since`? Committer dates miss pulled commits made before the sync. `src/memory.ts#breadcrumbs` go by
update id, never time. `src/memory.ts#renderStream` opens with `src/memory.ts#MEMORY_PREAMBLE` (stored text is
data, not instructions). `src/commands/memory.ts` makes one `withClient` call per command; nested subcommands skip
the argv pre-normalizer, so harnesses pass `--flag=value`.

### The pi extension

`src/extensions/pi.ts` shells out to `cortex` and never touches the database; its footer and `/memory` panel are
pure functions of state and theme in `src/extensions/memory-view.ts`, installed beside it.

- `src/extensions/pi.ts#memoryRole`: a human attached (pi's `hasUI`) makes a writer, anything headless a reader.
- `src/extensions/pi.ts#injectMemory` spawns at most once per prompt: always on a writer's first (the primer),
  otherwise it needs two content words (`src/extensions/pi.ts#contentWords`, a cheap gate: the CLI's terms decide
  the hits) and either the first prompt or a `src/extensions/pi.ts#RECALL_CUE` match.
  The primer is refetched only after compaction or `/memory refresh`; errors go to the footer, never the prompt.
- In bb, `src/extensions/pi.ts#shouldStepAside` sees the plugin's `cortex_update` in `PI_BB_TOOLS_FILE` and
  registers nothing ([docs/bb.md](bb.md#under-the-hood)).
- `cortex_recall` claims a query before it runs (pi runs one message's tool calls in parallel). Failures throw:
  pi ignores a returned `isError`, and `pi.exec` reports a timeout as a success marked killed.
- `src/extensions/pi.ts#shouldCheckpoint` (writer only) grants one hidden turn to a completed request that edited
  files and wrote no memory. Compaction posts pi's own summary, with no extra model call, as an update on the newest
  `src/extensions/pi.ts#BREADCRUMB_STREAMS` focus streams. Neither edits a body: that stays the agent's to curate.

## Rules to keep

- Memory reads hide a task in `memory_exclusions` unless the caller passes `withExcluded` (the user's own views); a
  load by id never filters: `test/unit/server.test.ts` (every memory route), `test/unit/store-memory.test.ts`.
- Only `src/memory.ts#memoryTerms` output reaches an FTS5 MATCH, each term quoted by `src/store.ts#quoteTerm`;
  never raw text: `test/unit/server.test.ts`, `test/integration/cli/memory.test.ts` (punctuation queries).
- Query noise (absolute and home paths, URLs, emails, ids, fenced code) and filler never become terms;
  repo-relative paths, inline code, `@id` and `#tag` still do; no cortex topic or recency word is a stopword:
  `test/unit/memory.test.ts` (query noise), `test/unit/memory-eval.test.ts` (the prompt-noise cases).
- The index is created on first use, never in `migrate()`, with no triggers or write hooks:
  `test/unit/store-memory.test.ts`. It is never backed up: `test/unit/backup.test.ts` pins `src/backup.ts#TABLES`.
- Only `src/store.ts#recordBodySync` writes `_body_edits`; staleness never reads `tasks.updated`, and breadcrumbs
  follow the update-id watermark: `test/unit/store-memory.test.ts`, `test/unit/memory.test.ts`.
- Staleness runs in the CLI, never the daemon, and git never inside `withClient`: `src/commands/memory.ts`,
  exercised on a real checkout by `test/integration/cli/memory.test.ts`.
- The lane boosts, never filters by default: `test/unit/store-memory.test.ts`, `test/unit/memory-eval.test.ts`.
- Automation never edits a stream body, and a `review` stream's body changes only with the user's say-so:
  `test/unit/extensions-pi.test.ts` (breadcrumbs, checkpoint prompt), `src/skills/cortex/recipes/memory.md`.
- Bounded spawns (one lookup per prompt, one checkpoint turn per request, one `cortex ls --json` per `/memory`), a
  byte-identical primer, and tool failures that throw: `test/unit/extensions-pi.test.ts`.
- The footer and `/memory` render only through `src/extensions/memory-view.ts`, stored text passing
  `src/extensions/memory-view.ts#clean`: `test/unit/extensions-memory-view.test.ts`.
- Cited paths come only from Files and Beginning context sections, and rendered memory opens with
  `src/memory.ts#MEMORY_PREAMBLE`: `test/unit/memory.test.ts` (citedPaths, rendering).
- Cite a budget's symbol, never copy its value. Where prose restates one (`cortex_recall`'s description, the header
  of `src/extensions/pi.ts`, the recipe) it changes with the constant; no test reads the prose, so review it.
