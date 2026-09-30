---
name: cortex-research
description: This skill should be used when the user asks to "research X", "investigate Y", "analyze Z", "spike on a problem", or wants a deep written analysis of an unknown before any implementation. Produces a single cortex task whose body holds a concise, evidence-backed analysis with actionable next steps. Do NOT use this skill to draft an implementation plan — use cortex-planner for that. Do NOT use this skill to execute code changes — use cortex-implementer for that.
---

# Cortex Research Skill

CRITICAL: before using this skill, load the `cortex` skill to ensure the CLI is available and you understand the cortex workflow. This skill is a layer on top of cortex for writing standalone analyses, so the basics of task creation, updates, lanes, tags, and priorities still apply.

## Purpose

Research is a written analysis of an unknown — a question whose answer is not yet obvious from the code, the docs, or the operational data. The output of this skill is the analysis itself, persisted as the body of a cortex task and tagged so it can be discovered later.

CRITICAL: this skill should not produce any implementation. Store any research artifacts in a temporary location like /tmp and only produce the final analysis as the cortex task body. If the research surfaces a next step that involves implementation, add it as next steps in the analysis.

Three disciplines distinguish good research from a long opinion:

1. Every claim is grounded in cited evidence — file:line, URL excerpt, command output, or query result. Anything that cannot be cited is labeled an assumption or open question.
2. Negative findings ("X does not exist", "feature Y does not support Z") are recorded as first-class results, not as silence.
3. The headline finding is one sentence and decided BEFORE the body is written. The body justifies the headline; the body does not search for one.

Depth over ceremony: a 60-line analysis with 8 cited findings beats a 400-line essay with 2 verifiable claims. If the analysis is short because the question was easy, that is a feature.

---

## Cortex persistence

The analysis lives as the BODY of a cortex task. Three cortex specifics apply.

1. ALWAYS use the `cortex_update` tool for every update when it is registered. If unavailable, generate ONE session id at session start, hold it in working memory (never env vars or repo files), and pass it via `--as` on every update — full rules in the `cortex` skill's [session-id recipe](../cortex/recipes/session-id.md):
    ```bash
    SESSION_ID="research-$(openssl rand -hex 4)"   # e.g. research-9b1c4f2a
    ```

2. ANALYSIS BODY → cortex task. Draft the analysis into a tmpfile and persist via `--body-file`:
    ```bash
    ANALYSIS=$(mktemp -t cortex-research.XXXXXX.md)
    # write the analysis markdown to "$ANALYSIS" using the Analysis Template below
    cortex add "<title>" --lane "$LANE" \
      --body-file "$ANALYSIS" \
      -t "research,$TOPIC_SLUG"
    # stdout: [<id>] <title>
    ```
    ALWAYS use `--body-file`; NEVER inline `-b "..."` for KB-scale analyses (shell escaping is a footgun).

    DO NOT pass `--priority` unless the user explicitly asked for one. Research notes are documents organised by the `research` + `<topic-slug>` tags, not items in a priority queue.

3. LANE = the project the work belongs to (the cortex skill's recipes/persistence.md §2); this checkout's default:
    ```bash
    LANE=$(cortex memory lane)
    ```
    Reuse an existing stream's lane when continuing work; the user naming a lane wins.

4. TAGS — every research task MUST carry the `research` tag PLUS an auto-derived `<topic-slug>` when multiple analysis tasks for the same research task is needed in the form of a stack:
    ```bash
    TOPIC_SLUG=$(printf '%s' "<analysis title>" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9_@-' | cut -c1-32)
    # fallback if TOPIC_SLUG is empty (all-punctuation title): TOPIC_SLUG="topic-$(openssl rand -hex 3)"
    # cortex add "<title>" --lane "$LANE" --body-file "$ANALYSIS" -t "research,$TOPIC_SLUG"
    ```
    The topic tag lets `cortex ls -t <topic-slug>` enumerate every analysis on the same subject across lanes. The `cut -c1-32` enforces the [a-z0-9_@-]{1,32} tag-name cap.

    CRITICAL: keep the topic slug short and derived; remember it in working memory for follow-up analyses on the same topic.

After `cortex add`, attribute the analysis IMMEDIATELY with a cortex update
This is MANDATORY — `cortex add` is anonymous; the update records WHO did the analysis.

REVISIONS: two edit modes — anchor-based partial edit for surgical changes (fixing a citation, appending one finding; fails 409 on a missing or ambiguous anchor — re-fetch, refine, retry), full-body rewrite via `--body-file` when the structure no longer fits. Exact commands: the `cortex` skill's [persistence recipe](../cortex/recipes/persistence.md). After any edit post `cortex update <id> --as "$SESSION_ID" -m "revised: <brief summary>"`.

NEVER edit a task whose status is `review` or `done` without explicit user confirmation — overwriting silently destroys someone else's downstream work.

---

## Core protocol

RESEARCH PHASE — small, cheap loops:

For each open sub-question, in the order you choose (research sub-questions don't carry a cortex priority — sequence them by dependency / cost / expected information gain):

1. State the sub-question in ONE falsifiable sentence (not "look into X" — "does X support Y under condition Z?").
2. Pick the source that can answer it: a file read beats a web search; a web search beats a multi-hour data query.
3. Capture the evidence verbatim — file:line excerpt, URL + quoted paragraph, command + first relevant line of output.
4. Classify the result:
   - ANSWERED — evidence settles the sub-question; record the answer and move on.
   - DEAD-END — evidence shows the question itself was malformed; record the dead end so the next agent does not retrace it.
   - RECURSE — answer surfaces a more specific sub-question; add it to the queue and continue.

Stop conditions — pick the first that fires:

- Every sub-question is ANSWERED or recorded as a known DEAD-END.
- Three consecutive RECURSE rounds without converging on a headline. STOP and surface the deadlock to the user.
- The cumulative cost of the next cheapest source exceeds the value of resolving it. Record as an open question and continue.

DECISION POINT — write ONE sentence: `Headline: <answer in plain language>`. If you cannot, the research phase is not done — go back.

WRITE PHASE — once the headline is decided:

- Re-read the Analysis Template and Size Guidance sections of THIS skill file (use the read tool — do not rely on memory).
- Draft into a tmpfile. Cite every claim. Strip every section that has no content (do not leave empty placeholders).
- Run the Pre-Write Checklist and Post-Write Review before persisting.

---

## Research process

Pick the cheapest source first. Most analyses need 2-3 of the buckets below, not all of them.

### 1. Codebase

- `read` for full-file context; `bash` with `rg` / `find` / `ls` for fast lookups.
- `ast_query` for structural patterns (e.g., "find every class extending BaseModel"). Prefer over grep when the question is structural.
- `git_blame` (or `git_blame_context`) to learn WHY a piece of code exists before reasoning about whether to change it.
- `git_diff_summary` to scope what has changed recently in a module.

### 2. External

- `web_fetch` is the primary external tool — go directly to known URLs (official docs, GitHub raw content, RFCs, API references) rather than searching.
- `web_search` ONLY when you genuinely do not know the URL or are surveying an unfamiliar landscape. Capture the discovered URL, then `web_fetch` the actual source for the citation.
- Prefer named formal standards and primary sources over generic "best practices" articles.

### 3. Operational and observability

- `data_portal_search` / `data_portal_get_metadata` / `data_portal_query` when the question is "what does the production data say".
- `gcp_logs_query` / `gcp_logs_tail` for "what is the system actually doing right now".
- `grokt_search_code` / `grokt_bulk_search` / `grokt_get_file` for cross-repo code questions when the answer is not in the local checkout.
- `slack_search_public` / `slack_search_public_and_private` for organizational context — past decisions, incident retros, ownership.
- `github_search_issues` / `github_search_pull_requests` / `github_pull_request_read` for upstream context on libraries you depend on.

### 4. Negative-space audit (BEFORE writing)

After the headline is decided, deliberately look for evidence that would FALSIFY it:

- "What would I see if the headline were wrong?"
- Search for that signal — code, log, doc, or counter-example. Either find it (and revise the headline) or record explicitly that the falsifier was searched for and not found.

A single recorded counter-example check is worth ten unverified claims.

Use the tools that are available, if the exact tool does not exist, choose the closest one. For example, `data_portal_query` vs `query_bigquery` is a common fallback choice when the former is unavailable. Use the tools that are available to you, instead of asking the user to install new ones or worrying about the semantics of which tool is "right" for the question.

---

## Analysis Template

Use the following structure. Strip any section that has no content — do NOT ship empty headers.

```markdown
# Research: <title>

> Question: <one falsifiable sentence>
> Headline: <one-sentence answer>

## Context

- Why this question is being asked (1-3 bullets, link upstream cortex task / Slack thread / incident if any).

## Method

- Sources consulted (codebase / external / operational), grouped by bucket.
- Scope and explicit non-scope (what was deliberately NOT investigated, and why).

## Findings

1. <Finding> — <evidence: file:line excerpt | URL + quoted line | command + output snippet>
2. ...

### Negative findings

- <"X does not support Y" — evidence>
- <"there is no Z in this codebase" — search command + zero-result output>

### Open questions

- <Question that remains, with the cheapest path to answering it>

## Implications

- What the findings mean for the next decision (1-5 bullets, plain language, no recommendations yet).

## Recommended next steps

1. <Concrete action> — handoff to `cortex-planner` (design needed) | `cortex-implementer` (plan exists, just execute) | neither (no further work warranted).
2. ...

## References

- Files: `<path>:<line>` ...
- URLs: <url> — <one-line summary of what was used from it>
- Commands / queries: <command> — <one-line summary of the result>

## Verification Notes

- Claims re-checked: <list>
- Counter-examples searched for: <list>
- Multi-model critique: <invoked / skipped — reason>
```

NOTE: this template is a GUIDELINE, not a straitjacket. The analysis should be as long as it needs to be to answer the question decisively, but no longer. Use your judgment to include only the sections that are relevant to the specific analysis you are writing.

What this template is NOT (anti-patterns):

- NOT a plan. No FROM/TO blocks, no Low-Level Tasks, no CREATE/UPDATE file recipes. Those belong to `cortex-planner`.
- NOT execution. No code changes, no test edits, no PR descriptions. Those belong to `cortex-implementer`.
- NOT a chronology. The Method section describes WHAT was consulted and the SCOPE — not "first I looked at X, then I tried Y".
- NOT a wish list. Recommended next steps are 2-3 lines each, concrete, and each names a handoff target.
- NOT a tutorial. The reader is another senior engineer; explain the unknown, not the known.

---

## Claim verification

Before persisting, extract verifiable claims and re-check the cheap ones inline:

- Quantitative — "this function is called 12 times". Re-run the search; quote the count.
- Existence — "there is a helper at path X". Re-`ls` it; quote the path.
- Negative — "feature Y does not support Z". Re-run the falsifier search; quote the zero-result output.
- API — "library accepts argument shape A". Re-read the function signature; quote it.

Optional multi-model critique pass — invoke when the headline is high-stakes (architectural recommendation, irreversible decision, contested area):

Follow the consensus recipe at `~/.agents/skills/critique/references/consensus-recipe.md`: ONE spawned task per critic model, each covering the analysis + ALL claims to challenge; majority KEEP / REJECT per claim. Revise on REJECT and log the revision in Verification Notes.

If the critique infrastructure is unavailable, perform inline verification only and note the limitation in Verification Notes.

---

## Size guidance

SOFT LIMITS:
- ≤300 lines total
- ≤10 findings (numbered + negative combined)

HARD LIMITS:
- 700 lines total
- 15 findings

If exceeded, the analysis has likely fused two questions. Split into two research tasks under the same `<topic-slug>` tag with sequential priorities.

Anti-patterns (named so you can call them out in self-review):

- "Wall of context" — an analysis that recapitulates the codebase without distilling a finding.
- "Tutorial drift" — explaining the well-known to pad length.
- "Naked claim" — a finding without a citation. Either cite or label as an open question.
- "Phantom plan" — sneaking FROM/TO blocks or Low-Level Tasks into Recommended next steps. Hand off to `cortex-planner` instead.
- "Decision laundering" — recommending an action whose tradeoffs were never examined in Findings.

---

## Pre-Write Checklist

STOP. Before persisting the analysis, complete every item:

1. Re-read the Analysis Template, Size guidance, and Post-Write Review sections of this skill file (use the read tool — do not rely on memory).
2. Read at least one past `-t research` task in the same lane if any exists, to match its level of detail:
   ```bash
   cortex ls --lane "$LANE" -t research --json | jq -r '.[0].id' \
     | xargs -I {} cortex show {} --json | jq -r .task.body
   ```
3. Verify:
   - [ ] Question is one falsifiable sentence (not "look into X")
   - [ ] Headline is one sentence and is decided (not "TBD")
   - [ ] Every claim in Findings has a citation (file:line | URL | command)
   - [ ] Negative findings recorded explicitly (or section deliberately omitted because none applied)
   - [ ] Counter-example check performed and recorded in Verification Notes
   - [ ] Recommended next steps are concrete AND each names a handoff target (`cortex-planner`, `cortex-implementer`, or neither)
   - [ ] Size respected (≤300 lines soft, ≤600 hard)
   - [ ] $SESSION_ID held in working memory
   - [ ] LANE resolved (the project the work belongs to; this checkout's lane by default, or user-specified)
   - [ ] TAGS computed: `research` always, plus `<topic-slug>` auto-derived from title

## Post-Write Review

Before `cortex add`, scan every section:

- [ ] Every claim is grounded in a citation — strip or label any naked claim
- [ ] Method describes sources and scope — not chronology
- [ ] Findings are decisive — each one resolves a sub-question, not "I noticed that"
- [ ] Negative findings exist OR the omission is deliberate
- [ ] Recommended next steps are ≤2-3 lines each and name a handoff skill
- [ ] Empty template sections removed (no `## Open questions` followed by nothing)
- [ ] Headline at the top still matches the body

---

## Rules

- ALWAYS load the `cortex` skill first for CLI vocabulary and lane / tag / status semantics.
- ALWAYS track the core protocol with TODOs or Quests, if the tooling supports it.
- ALWAYS persist the analysis via `cortex add --body-file`; NEVER inline `-b "..."` for multi-KB analyses.
- ALWAYS attribute the analysis immediately after `cortex add` with `cortex_update` (preferred) or `cortex update <id> --as "$SESSION_ID" -m "research written"` (fallback).
- ALWAYS pass `-t "research,<topic-slug>"` on every research task. The topic slug is auto-derived from the title — never prompt the user.
- ONLY produce the analysis. NEVER draft an implementation plan inline (hand off to `cortex-planner`). NEVER make code changes (hand off to `cortex-implementer`). NEVER produce PR descriptions.
- NEVER edit a `review`- or `done`-status cortex task without explicit user confirmation.
- "I don't know" is a valid headline when honestly arrived at — prefer it over a fabricated answer.
- Cite every claim; label every uncited statement as an assumption or open question.
- MAINTAINABILITY above all else.
- ALWAYS follow KISS (keep it simple stupid); AVOID over-engineering.
