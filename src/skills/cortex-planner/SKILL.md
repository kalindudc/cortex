---
name: cortex-planner
description: This skill should be used when the user asks to "plan a feature", "draft an implementation plan", "write a plan for X", or needs a structured vertical-slice plan with research, file-level tasks, and validation gates. Produces a single cortex task whose body holds the full plan markdown, ready for the cortex-implementer skill to execute. Do NOT use this skill to execute an existing plan — use cortex-implementer for that.
---

# Cortex Planner Skill

CRITICAL: before using this skill, load the `cortex` skill to ensure the CLI is available and you understand the cortex workflow. This skill is a layer on top of cortex for writing implementation plans, so the basics of task creation, updates, lanes, and priorities still apply.

## Purpose

A plan is a structured prompt that supplies an AI coding agent with everything it needs to deliver a vertical slice of working software -- no more, no less.

A plan differs from a generic project plan by adding three AI-critical layers:

- Context -- Precise file paths, library versions, code snippets. Plans are always standalone -- all relevant context is embedded directly.
- Implementation Strategy -- Specific libraries, code standards, repo patterns, architectural decisions.
- Validation Gates -- Deterministic checks (build, test, lint) with TDD for quality control.

This skill persists the plan as the body of a cortex task. Multiple plans for one feature share a cortex lane as a stack with sequential priorities. The cortex-implementer skill consumes the task by ID later.

---

## Cortex persistence

Plans are stored in cortex — not as files. Three cortex specifics apply.

1. ALWAYS use the `cortex_update` tool for every update when it is registered. If unavailable, generate ONE session id at session start, hold it in working memory (never env vars or repo files), and pass it via `--as` on every update — full rules in the `cortex` skill's [session-id recipe](../cortex/recipes/session-id.md):
    ```bash
    SESSION_ID="planner-$(openssl rand -hex 4)"   # e.g. planner-7f3a9201
    ```

2. PLAN BODY → cortex task. Draft the plan into a tmpfile and persist it via `--body-file`:
    ```bash
    PLAN=$(mktemp -t cortex-plan.XXXXXX.md)
    # write the plan markdown to "$PLAN" using the Plan Template below
    cortex add "<title>" --lane "$LANE" --status draft --body-file "$PLAN"
    # stdout: [<id>] <title>
    ```
    ALWAYS use `--body-file`; NEVER inline `-b "..."` for KB-scale plans (shell escaping is a footgun).

    DO NOT pass `--priority` unless the user explicitly asked for one. Plans are documents organised by lane + `plan` tag, not items in a priority queue — see the Priority subsection below.

3. LANE = the project the work belongs to (the cortex skill's recipes/persistence.md §2); this checkout's default:
    ```bash
    LANE=$(cortex memory lane)
    ```
    Reuse an existing stream's lane when continuing work; the user naming a lane wins.

4. TAGS — every plan task MUST carry the `plan` tag. Plans inside a stack MUST also carry a stack-slug tag derived automatically from the feature title (NEVER prompt the user):
  ```bash
  STACK_SLUG=$(printf '%s' "<feature title>" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9_@-' | cut -c1-32)
  # fallback if STACK_SLUG is empty (all-punctuation title): STACK_SLUG="stack-$(openssl rand -hex 3)"
  # single plan:  cortex add "<title>" --lane "$LANE" --status draft --body-file "$PLAN" -t plan
  # plan stack:   cortex add "<title>" --lane "$LANE" --status draft --body-file "$PLAN" -t "plan,$STACK_SLUG"
  ```
  The stack tag lets `cortex ls -t <stack-slug>` enumerate the whole stack across lanes. The `cut -c1-32` enforces the [a-z0-9_@-]{1,32} tag-name cap.

  CRITICAL: keep the stack-slug tag name short and derived, keep it in memory for future deviations and other related plans

After `cortex add`, attribute the plan immediately:
```bash
cortex update <id> --as "$SESSION_ID" -m "plan written"
```
This is MANDATORY — `cortex add` is anonymous; the update records WHO planned it.

PLAN STACKS: when a single plan exceeds the size limits and cannot be consolidated, split into a stack — N tasks under a single stack-slug tag. Title each task `NN: <title>` for visual ordering in `cortex ls`; the leading `NN:` is the source of truth for stack order (no `--priority` required). After writing the whole stack, post a summary update on the first task listing every task ID. STOP and confirm with the user before creating a plan stack.

PRIORITY: cortex tasks default to no priority (the SQLite column is nullable; `cortex ls` sorts un-prioritised tasks after prioritised ones, then by created-time). Plans, plan stacks, and supporting documents are organised by lane + tag, not a priority queue — do NOT pass `--priority` to `cortex add` unless the user explicitly asked for an urgency annotation. `cortex ls` and the TUI show no priority when it is unset; `cortex show` omits the `priority:` line.

REVISIONS: two edit modes — anchor-based partial edit for surgical changes (adding a task, marking one `[COMPLETED]`; fails 409 on a missing or ambiguous anchor — re-fetch, refine, retry), full-body rewrite via `--body-file` for large restructures. Exact commands: the `cortex` skill's [persistence recipe](../cortex/recipes/persistence.md). After any edit post `cortex update <id> --as "$SESSION_ID" -m "revised: <brief summary>"`.

NEVER edit a task whose status is `review` without explicit user confirmation — overwriting silently destroys the implementer's review handoff.

---

## Core protocol

RESEARCH PHASE: Complete all investigation before writing.
DECISION POINT: Write one sentence: "Approach: [what will be implemented]"

Draft → Verify → Fix → Repeat (max 3 rounds)

Cheap checks:
- Task count ≤10
- Task block ≤25 lines
- Tasks numbered (not ### headers), each with a `Verify:` line
- Implementation Notes: flat bullets
- FROM blocks: changed lines only
- CREATE blocks: signatures only
- Context: only files plan modifies

If ANY fail: fix and re-verify.

WRITE PHASE: Once research AND verification complete, re-read the Plan Template, Plan Size Guidance, and Pre-Write Checklist sections of this skill file before writing. Then use the template. Reference decisions from exploration, not assumptions or alternatives.

---

## Research Process

Begin with thorough research to gather all necessary context:

### 1. Documentation Review
- Check `**/docs/` directories for relevant documentation

### 2. Web Research
- Research the concept, library documentation, and sample implementations
- Research platform/framework extension points and API constraints before drafting architecture -- feasibility shapes design
- Prefer named formal standards and peer-reviewed methodologies over generic "best practices" articles

### 3. Template Analysis
- Review past plans persisted in cortex for consistency and inspiration: `cortex ls --lane <l> --status done --json | jq` then `cortex show <id> --json | jq -r .task.body` to read the body. Follow our concept, standard, and template.

### 4. Codebase Exploration
- Identify relevant files, directories, and patterns to follow
- Read full content of ALL pattern files (not just the closest analog) -- consistency comes from breadth
- Verify both what patterns exist AND what infrastructure is absent -- missing frameworks/conventions are as important as existing ones
- Before proposing edits to config or deployed files, check if they are produced by a build/template system (Makefile, Taskfile, ERB, Jinja, code generation). Search for generator scripts, `src/templates/`, and build task definitions -- editing generated files directly will be overwritten
- If the repo is unfamiliar, map it first (entry points, module boundaries, where the tests live) before reading individual files
- For complex verification (patterns, dependencies, infrastructure), delegate to a sub-agent if your harness can, asking for findings with confidence levels and file:line evidence. Simple file reads stay inline. If delegation fails or times out, verify inline.

### Tools by use case

Use whatever your environment provides for each need; prefer a purpose-built tool over raw shell output when you have one:
- Structural code search (an AST or tree-sitter search, else `rg`): find patterns to follow, e.g. every route handler or every class extending a base class.
- History and blame (a structured blame tool, else `git blame` / `git log`): learn why code exists before planning changes around it.
- Recent changes (a diff-summary tool, else `git diff --stat`): scope what changed in the modules the plan touches.
- Tests (a test runner that parses results, else the repo's test script): confirm the baseline passes before planning.
- Stack traces (a resolver for compiled or container paths, else source maps): map frames to source file:line.
- The code host and CI (e.g. the `gh` CLI or the host's API): repository settings such as branch protection, secrets and app installations. Verify a command works before putting it in a plan.

---

## Plan Template

Use the following structure for every plan:

```markdown
# Plan: <title>

> Ingest the information from this file, implement the Low-Level Tasks, and generate the code that will satisfy the High and Mid-Level Objectives.

## What this plan does and why

[Three to five short paragraphs for the person who approves the plan. Say what is wrong or missing today, what will be possible after the plan, and the one or two design choices that matter, in ordinary words. Name a command or file at most once each; do not list tasks. A reader who stops here must be able to decide whether to approve.]

## High-Level Objective

- [Goal]

## Mid-Level Objective

- [Measurable steps toward the goal]

## Implementation Notes

- [Technical details, dependencies, coding standards]

## Context

### Beginning context

- [Files that exist at start]

### Ending context

- [Files that will exist at end]

## Low-Level Tasks

> Ordered from start to finish

1. [Task description]
   Verify: [command or observable result that shows this task works]

\```
UPDATE: [file path]
FROM:
  [exact lines being replaced]
TO:
  [exact replacement lines]
\```

\```
CREATE: [file path]
[Exported signatures with exact types]
[Key algorithmic decisions the implementer cannot infer from context]
[What to import and from where]
DO NOT write the implementation -- that is the implementer's job.
\```

## Validation Gates

- [Completion criteria]

## Verification Notes
[Claims verified, and how (command, probe, source read). A claim about an external tool, flag or version quotes the version or `--help` line you checked. Design claims left for an independent review. Revisions made: ...]
[If no revisions needed: "All claims verified."]

## Rules and requirements
- MAINTAINABILITY above all else
- ALWAYS follow KISS (keep it simple stupid), AVOID over engineering
- ALWAYS use the repo's own scripts or task runner (e.g. package.json scripts, make, task) over manual commands; if a new command is needed, ask the user first
```

---

## Claim Verification

Before persisting the plan to cortex, extract verifiable claims and validate them.

Claims to extract:
- File existence: "Beginning context" files, referenced pattern files
- API/function claims: "this library supports X", "function Y accepts Z"
- Code correctness: any code snippets in Low-Level Tasks
- Quantitative claims: line counts, element counts, test counts
- Negative claims: "X does not support Y", "there is no Z"

Verify inline, cheap checks first:

MECHANICAL claims, which a single tool call proves:
- File existence: `ls` / `find` the Beginning-context and pattern files
- API/function claims: read the source or installed type definitions
- Code snippets: verify syntax and semantics
- Quantitative claims: count against the actual source
Log results in "Verification Notes".

DESIGN claims, which carry design risk and no single call settles:
- Approach-level claims ("X is the right extension point", "this pattern generalizes")
- Negative claims ("the library does not support X", "there is no existing Z")
- External-platform behavior unprovable from the codebase
Gather the strongest evidence you can (a probe or prototype in a temp dir, primary docs, the installed source), state your confidence, and list each one in Verification Notes as a design claim, so an independent review can target them. This skill does not run that review.

Any claim flagged INCORRECT: revise the plan before output. Log the revision in the "Verification Notes" section at the end of the plan.

---

## Plan Size Guidance

A plan should be implementable in a single session. If it can't be, split it into a plan stack -- multiple independent plans in ONE cortex lane (per Cortex persistence > PLAN STACKS), each self-contained.

Keep plans concise but precise:
- Implementation Notes: focus on what the agent can't infer from the code
- Low-Level Tasks: enough detail to implement unambiguously, not more. Plans with exact FROM/TO diffs and verified API signatures reduce the implementer to mechanical execution -- the highest-efficiency mode.
- Context sections: file paths and brief descriptions, not full file contents

Task block rules:
- UPDATE tasks contain ONLY the changed lines as FROM/TO diffs -- never the whole file
- CREATE tasks contain ONLY exported signatures, key decisions, and imports -- never a full implementation
- A task block over 25 lines is a red flag: review it and strip anything the implementer can infer
- "Standalone" means all context needed to make a decision is present, NOT that the plan contains the code
- When deduplicating shared mechanics across 3+ skills (60+ lines of near-identical code), extract to a hidden orchestrator agent (agent = execution, skill = methodology). Quantify the overlap first to validate the extraction.

Anti-patterns -- NEVER do these:
- Implementation Notes with ### subsections, tables, or multi-level nesting. Implementation Notes are a FLAT bullet list. Each bullet is a decisive technical fact the implementer cannot infer from code.
- Low-Level Tasks that produce no files. Every task MUST be a CREATE or UPDATE on a specific file. Research and verification are NOT tasks -- they belong in Implementation Notes or Validation Gates.
- Beginning context listing files the plan does not touch. List ONLY files the plan creates, updates, or reads as direct input for those changes.
- Mid-Level Objectives that echo the Low-Level Task list. Mid-Level Objectives are measurable outcomes, not a file-by-file inventory.
- Validation Gates asserting per-section content for every file. Use focused automated checks.

CRITICAL: Plan stacks are a last resort. Always prefer a single plan, if a stack is needed, STOP, and confirm with the user before proceeding.

### Constraint Enforcement

HARD LIMITS:
- Max 10 - 15 tasks
- Max 25 - 35 lines per task block
- Max 300 - 500 lines total

If exceeded: prefer consolidation first. If still over limits, create a plan stack per existing protocol (STOP, confirm with user, split into multiple cortex tasks in one lane with sequential priorities).

---

## Pre-Write Checklist

STOP. Before writing the plan to cortex, complete every item. Do NOT skip this.

1. Re-read the Plan Template and Plan Size Guidance sections of this skill file (use the read tool -- do not rely on memory)
2. Read at least one past plan from cortex (`cortex ls --lane <l> --status done --json | jq` then `cortex show <id> --json | jq -r .task.body`) and compare its structure against the template -- match its level of detail, not exceed it (skip if none exits)
3. Verify:
   - [ ] Approach decided (not "will try X or Y")
   - [ ] All APIs verified (list files: ___)
   - [ ] Implementation notes are decisive technical facts, not explanatory essays
   - [ ] "What this plan does and why" and the High- and Mid-Level Objectives are written for the user who approves the plan ([persistence recipe](../cortex/recipes/persistence.md), section 7): complete sentences, every internal term explained the first time, no shorthand invented during the work. Only Implementation Notes and Low-Level Tasks may be written for the implementing agent.
   - [ ] Every planned Low-Level Task is a CREATE or UPDATE operation
   - [ ] Constraint enforcement completed
   - [ ] $SESSION_ID generated and held in working memory
   - [ ] LANE resolved (the project the work belongs to; this checkout's lane by default, or user-specified)
   - [ ] TAGS computed: `plan` always; `<stack-slug>` if writing a plan stack (auto-derived from title, never prompt the user)

## Post-Write Review

Before persisting the plan to cortex, scan every task block:
- [ ] No UPDATE task contains a full file -- only changed lines
- [ ] No CREATE task contains a full implementation -- only signatures, decisions, low level implementation details for ambiguous code
- [ ] No task block exceeds 25 lines -- if it does, split it into multiple tasks or move details to Implementation Notes
- [ ] No test task contains full test function bodies -- describe what to assert, not how to write it

---

## Output Format

- Persist the plan as the body of a cortex task using `cortex add "<title>" --lane "$LANE" --status draft --body-file <plan-tmpfile>` (see Cortex persistence above for the exact recipe; pass `--priority` only when the user asked for an urgency annotation)
- Immediately after creation, attribute with `cortex update <id> --as "$SESSION_ID" -m "plan written"`
- Inform the user of the cortex task id and provide a brief summary; the plan body is viewable via `cortex show <id>`

## User Interaction

After completing initial research, present a summary: scope, patterns to follow, approach, and validation criteria.

If research is unambiguous: state what you found and proceed directly to plan creation.

If scope is abstract or ambiguous: present a concrete architectural strawman early to force clarification -- don't wait until the full plan is drafted. STOP and wait for user confirmation before proceeding.

Plans always produce working software. Research informs Implementation Notes; Low-Level Tasks describe code to write (CREATE/UPDATE files), never report sections.

## Rules

- ALWAYS load the `cortex` skill first for CLI vocabulary and lane / status / tag semantics
- ALWAYS track the core protocol with a task list, if your tooling has one
- ALWAYS persist the plan via `cortex add --body-file`; NEVER inline `-b "..."` for multi-KB plans
- ALWAYS attribute the plan immediately after `cortex add` with `cortex update <id> --as "$SESSION_ID" -m "plan written"`
- ALWAYS pass `-t plan` to `cortex add` for any plan; for a plan stack, pass `-t plan,<stack-slug>` on every task in the stack
- ONLY generate the plan and DO NOT implement any code changes
- DO NOT generate any other documents like PR descriptions
- NEVER create multiple plans for the same feature / task
- NEVER edit a `review`-status cortex task without explicit user confirmation
- Plans MUST be created with `--status draft`. The `draft` status means "plan written, not approved for execution." Only transition out of `draft` when the user explicitly requests implementation.
- ALWAYS use a single plan as the source of truth
- For plan revisions, choose between `cortex edit --body-search`/`--body-replace` (anchor-based, race-safe for surgical changes) and `--body-file` (full overwrite, for restructures) based on the scope of the change — see the `cortex` skill for tradeoffs
- MAINTAINABILITY above all else
- ALWAYS follow KISS (keep it simple stupid), AVOID over engineering
