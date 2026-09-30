---
name: docs
description: Keep cortex's docs (README.md, docs/*.md, AGENTS.md) true to the code and easy to read. Use before a PR, when `pnpm run docs:check` warns, or to audit one doc claim by claim.
---

# Docs

Repo-local skill for developing cortex (not embedded in the binary). The docs are for the public and for engineers:
they explain what cortex does and why it is built the way it is, so nobody has to guess and nobody "simplifies" the
wrong thing. Code is the truth; a doc that is not readable is not worth keeping.

## Where facts go

- README.md is the front door; docs/tui.md, docs/memory.md and docs/architecture.md each cover one area; AGENTS.md
  is the contract for agents changing the repo. One fact has ONE home: link to it instead of restating it.
- Every docs/*.md runs user-first: plain-language sections, then "Under the hood" (how and why, citing
  `path#Symbol`), then "Rules to keep" (each invariant with the test or symbol that enforces it).
- A design choice and the option it rejected go into the section they belong to, as a short "Why not ...?".
- Budgets: README.md 120 lines, AGENTS.md 150, each docs/*.md its front-matter `budget`. Over budget means cut,
  NEVER split into a new file. Ask the user before adding a doc file.

## Voice

- Short sentences, active voice, "you" for users, the current state only (no history, no "planned", no plan or
  task ids).
- Define a term the first time it appears (daemon, lease, SSE, FTS5) in half a sentence; prefer a tiny example.
- Code citations belong in "Under the hood" and "Rules to keep", not in every user-level sentence.

## Never document

- keybindings, `:commands`, theme tokens, tui.toml keys, CLI flags, HTTP routes, SSE event kinds as lists or
  tables: point at `?` / `:help`, `cortex <cmd> --help` or `cortex schema` (a few entry points in prose are fine)
- numeric constants: name the symbol instead
- file trees, repo maps, signature dumps; what a function does line by line (that is a code comment)
- plans, research, progress (cortex tasks), speculation ("we may later ...")

## sync (default)

1. Run `pnpm run docs:check --base "$(git merge-base HEAD main)"`.
2. For each `docs.stale_candidate`, read the doc and `git diff <base> -- <its sources>`.
3. Edit ONLY the sentences whose facts changed, in the doc's voice. A new design choice gets its "Why not ...?".
4. For each `comments.plan_ref` (a fail), replace the ref with the reason in words.
5. Re-run step 1 until there is no fail. A `docs.stale_candidate` whose sources changed without changing any fact
   the doc states (comments, refactors) stays a warning: say so in the report, NEVER edit a doc just to silence it.
   Never silence a fail by editing the linter; fix the doc or the code.

## audit <doc>

1. Spawn ONE researcher minion for the doc, giving it the doc and its front-matter `sources`.
2. It marks every claim VERIFIED (file:line), DRIFT (what the code says instead) or UNVERIFIABLE, and flags any
   passage a newcomer could not follow.
3. Fix every DRIFT, cut or re-anchor every UNVERIFIABLE claim, rewrite what was hard to follow; re-run
   `pnpm run docs:check`.
4. Report the claim counts and the edits to the user.

## Rules

- ALWAYS run `pnpm run docs:check` before reporting done.
- NEVER copy a value, list or table the program already shows.
- NEVER put plan ids, dates of work or progress notes in docs or comments.
