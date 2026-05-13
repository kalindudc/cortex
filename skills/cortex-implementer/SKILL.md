---
name: cortex-implementer
description: This skill should be used when the user asks to "implement plan <id>", "execute the plan in cortex task X", "resume implementer work on task N", or hands off a cortex task ID containing a plan body for execution. Reads the plan from a cortex task, completes each Low-Level Task with bounded retry, posts one cortex update per task as progress, and transitions task status to review/blocked/done at the right gates. Do NOT use this skill to draft a new plan — use cortex-planner for that.
---

# Cortex Implementer Skill

CRITICAL: before using this skill, load the `cortex` skill to ensure the CLI is available and you understand the cortex workflow. This skill is a layer on top of cortex for executing implementation plans, so the basics of task creation, updates, lanes, and priorities still apply. This skill does NOT create or triage cortex tasks — it only executes plans that are already written and stored in task bodies.

## Purpose

This skill fills the workflow gap between plan creation and PR generation. It takes a plan stored as the body of a cortex task and executes every Low-Level Task systematically -- producing working code on the first pass.

The plan body is read once at the start and is NEVER mutated during execution. Per-task progress, blockers, and the final review handoff are reported as cortex updates so a human supervising several agents can watch the dashboard and react. Completion is signalled by transitioning the task's status, not by editing the body.

---

## Cortex persistence

The plan source and per-task progress markers live in cortex — not as files. Three cortex specifics apply.

1. SESSION ID — every `cortex update` REQUIRES `--as <session-id>` (alias `--author`). Generate ONE id at the start of your agent session, hold in working memory, and reuse it for the lifetime of the session:
   ```bash
   SESSION_ID="implementer-$(openssl rand -hex 4)"   # e.g. implementer-1c0ed4a8
   ```
   Format `<role>-<8 hex>`, max 80 chars, no newlines. NEVER store in env vars (sandboxed sub-shells throw them away) or in repo files (two agents collapse into one identity in the audit trail).

2. PLAN BODY ← cortex task. Fetch the plan with:
   ```bash
   cortex show <id> --json | jq -r '.task.status'
   cortex show <id> --json | jq -r '.task.body' > /tmp/plan-<id>.md
   ```
   The task body is the plan markdown. Read it in FULL; do NOT mutate it (body is owned by cortex-planner).

3. PROGRESS → cortex updates. Post one cortex update per Low-Level Task as the canonical completion marker (the cortex task body is NEVER mutated to record progress):
   ```bash
   cortex update <id> --as "$SESSION_ID" -m "task <N>: <one-line summary>"
   ```
   ONE update per task — NOT per file edit, NOT per retry. The dashboard shows updates chronologically.

STATUS TRANSITIONS (every command also passes `--as "$SESSION_ID"`):

| Trigger | Command |
|---|---|
| All Low-Level Tasks complete + Validation Gates green | `cortex update <id> -s review --as "$SESSION_ID" -m "ready for review: <summary>"` |
| 3-retry exhaustion (per Retry Protocol) | `cortex update <id> -s blocked --as "$SESSION_ID" -m "<error>" -b "<attempts + theory>"` |
| Human confirms merge | `cortex update <id> -s done --as "$SESSION_ID" -m "merged"` |

`blocked` is the ONE transition that fires a browser notification — use it deliberately. `done` is reserved for human-confirmed merges.

LANE-LEVEL WORKFLOW: to pick the next plan from a stack (one lane = one plan stack with sequential priorities):
```bash
LANE=$(git rev-parse --show-toplevel 2>/dev/null | xargs basename || basename "$PWD")
cortex ls --lane "$LANE" --status open --json | jq -c '[.[]] | min_by(.priority)'
```
Feed the resulting id into Plan Ingestion. Execute ONE plan per agent invocation.

MULTI-AGENT COORDINATION: cortex enforces NO locks. Before starting, scan `cortex show <id> --json | jq '.updates'` for activity in the last few minutes from any author other than `$SESSION_ID`. If found, post `cortex update <id> --as "$SESSION_ID" -m "another agent active; standing down"` and exit.

---

## Plan Ingestion

A cortex task `<id>` MUST be explicitly provided by the user. Do NOT auto-discover or assume a task. (Exception: "pick the next plan in lane X" — see LANE-LEVEL WORKFLOW above.)

1. If `$ARGUMENTS` contains a cortex task id, use that. Otherwise, ask the user.
2. Fetch and read the plan body completely (see Cortex persistence > PLAN BODY ← cortex task).
3. Extract tasks from "Low-Level Tasks" if present; for non-standard formats (analysis reports, recommendation docs), explicitly list inferred tasks and re-order by structural dependency when targeting the same file. If ambiguous, ask the user.
4. For each task, identify: target files, functions, implementation details, verification commands.
5. Classify status by reading the cortex update history (`cortex show <id> --json | jq -r '.updates[] | select(.message | test("^task [0-9]+:")) | .message'`):
   - Completed -- a `task N: ...` update from any session id already exists
   - In progress -- the most recent update is a `resuming from task N` from THIS `$SESSION_ID`
   - Pending -- no update for this N
6. Enumerate all tasks and their statuses. Track progress in working memory; do NOT mutate the cortex task body.
7. Read all files in the "Beginning context" section (or infer from task descriptions).
8. Use the plan as a guide, not a strict contract; deviations can be made to achieve the overall goal but must be documented and approved by the user.

### Resuming Partially Completed Plans

If any tasks are marked completed or in progress (per step 5 above), this is a resume:

- Consume any existing cortex updates from the plan
- Verify completed tasks -- read target files and confirm changes exist. If a change is missing, treat that task as `pending` again.
- Resume in-progress tasks -- continue from where they left off, don't restart.
- Run a baseline check -- build and test to confirm a working state. Report failures before continuing.
- Announce on cortex: `cortex update <id> --as "$SESSION_ID" -m "resuming from task <N>"`.
- Report resume status to the user: tasks verified, tasks to resume, tasks remaining.

If prior `task N: ...` updates came from a DIFFERENT author, treat as multi-agent coordination (see Cortex persistence > MULTI-AGENT COORDINATION) instead.

## Pre-Implementation Setup

1. Branch check: Verify you are NOT on `main`. If on `main`, propose a branch name and create it with `gt create` (if available) or `git checkout -b` with the provided branch name template without prompting the user for confirmation.
2. Baseline check: Run the project's build/test command. If NOT green, STOP and inform the user.
3. Context loading: Read all files in "Beginning context". Verify each exists (or note as expected-missing for CREATE tasks).
4. Confirm `$SESSION_ID` is set in working memory (regenerate via the recipe in Cortex persistence > SESSION ID if missing).

BRANCH NAME TEMPLATE: `<github-username>/<feat|fix|chore>_<short-description>`

## Execution Loop

For each Low-Level Task, in order:

### Step 1: Parse

- Read the task description from the plan
- Identify: target files, functions to create/update, specific details
- Track progress in working memory (which task you are on, retry count). Do NOT mutate the cortex task body.

### Step 2: Context

- Read all files referenced by the task
- If files don't exist yet (CREATE tasks), verify parent directory exists
- If files exist (UPDATE tasks), read current content completely
- Understand the current state before making changes

### Step 3: Implement

Make the code changes described in the task. Follow the DOING/EXPECT pattern from the Agent Protocol.

Guidelines:
- Prefer the Edit tool over Write for existing files
- Prefer editing existing files over creating new ones
- Follow the project's coding standards (from the plan's Implementation Notes)
- Follow the plan's specific instructions for each task
- When multiple tasks target the same file, treat the plan as a specification and batch implementation -- the plan's value is in completeness, not edit granularity
- For rename-across-callsites tasks, use the Edit tool's `replaceAll` parameter to handle all sites in a single call per file
- Pre-check linter configs for strict rules before writing code to avoid create-then-rewrite cycles. When consolidating modules, expect length-limit violations. When changing data formats, update test helpers that bypass the app layer.
- Do NOT deviate from the plan without user approval -- surface simpler alternatives before committing
- When a plan conflicts with tooling/environment conventions, research the convention before overriding it

### Step 4: Verify

Run the verification command appropriate for the change type:

Scope: Run only the relevant test file(s) per task for fast feedback. Save the full suite for the Completion Protocol.

- Code changes: Build command (confirm compilation)
- New tests: Test command (confirm tests pass)
- Style changes: Lint command (confirm style compliance)
- Structural changes: Verify files exist/don't exist as expected
- Config/doc-only plans (no build/test/lint cycle): Verification is re-reading files and checking structural consistency. Baseline check reduces to `git status` showing a clean working tree. When project-specific validation commands are available (e.g., `ruby generate_config.rb --validate`), prefer them over bare `git status`.
- Greenfield CREATE-only plans (all tasks create new files, no existing code to modify): Same baseline reduction as config/doc-only -- `git status` for a clean working tree, then structural verification (file existence, content checks) after each task.
- Unavailable runtime: When a plan specifies runtime verification for a runtime not available locally, explicitly flag the deviation in the task record and recommend manual verification rather than silently skipping. This is distinct from missing credentials (which allow structural validation) -- missing runtimes block functional verification entirely.
- Compilation-dependency chains (A references B, B removes C): Defer verification to the last task in the chain rather than attempting intermediate builds that cannot succeed.

When running tests, prefer the `test_run_parsed` tool over raw bash for structured results. It returns pass/fail per test with parsed failure locations instead of raw terminal output. Note: `test_run_parsed` cannot parse Minitest output -- fall back to reading raw test output for Ruby/Minitest projects.

When test failures produce stack traces, use `stack_trace_resolve` to resolve compiled/container paths to actual source file:line references in the workspace.

Use `ast_query` to find patterns to follow when implementing (e.g., "find all classes extending BaseModel" to match existing conventions). Prefer over grep for structural code queries.

Compare RESULT vs EXPECT:
- If verification passes: proceed to Step 5
- If verification fails: enter the Retry Protocol (see below)

### Step 5: Record

- Post ONE cortex update per Low-Level Task:
  ```bash
  cortex update <id> --as "$SESSION_ID" -m "task <N>: <one-line summary>"
  ```
- If there were any deviations from the plan, include the detail in `-b`:
  ```bash
  cortex update <id> --as "$SESSION_ID" \
    -m "task <N>: <one-line summary>" \
    -b "Deviation: [what changed and why]"
  ```
- If the user requested the deviation, mention "user-approved" in the body -- user-initiated changes are pre-approved.
- Do NOT mutate the cortex task body. Body changes are reserved for cortex-planner.

### Step 6: Checkpoint (every 3 tasks)

- Re-read the plan's High-Level Objective
- Verify current implementation still aligns with the goal
- If drift detected: STOP, report to user, wait for confirmation before continuing
- If a task reveals the plan's approach is fundamentally flawed (not just the task implementation), STOP and present your finding. The plan may need revision before continuing -- do not force a broken plan to completion. (Plan revisions are owned by cortex-planner; surface to the user, don't edit the body yourself.)

## Retry Protocol

When verification fails at Step 4:

Up to 3 retries. Each attempt: read the error, state the exact failure, state your root-cause theory, adjust the implementation, re-run verification.

If all 3 attempts fail:
- STOP -- do not continue to the next task
- Transition the task to `blocked` and report on the audit trail:
```bash
cortex update <id> --as "$SESSION_ID" -s blocked \
  -m "task <N> blocked: <one-line error>" \
  -b "What failed: <exact error>
What was attempted: <approach 1> | <approach 2> | <approach 3>
Theory: <root-cause theory>
Proposed next: <what would help>"
```
- Wait for user confirmation before continuing

`blocked` is the ONE status transition that fires a browser notification on the cortex dashboard -- use it ONLY on genuine 3-retry exhaustion or a missing prerequisite.

Critical: NEVER silently retry -- state what changed and why. NEVER modify tests blindly -- verify they're correct first. NEVER modify the plan to fit broken code.

## Completion Protocol

After all tasks are completed:

1. Run ALL Validation Gates from the plan
2. Run the full build + test + lint cycle
3. Report final status: tasks completed (N/N), validation gates (pass/fail), files touched, deviations. Use the `git_diff_summary` tool for the final changeset summary -- it provides structured file categorization and counts instead of raw diff output. Supplement with `git status` when the plan creates new files, since `git_diff_summary` only covers tracked changes and will miss untracked files.
4. Transition the cortex task to `review` — status is the canonical completion signal (the cortex task body is NEVER mutated to record completion):
```bash
cortex update <id> --as "$SESSION_ID" -s review \
  -m "ready for review: <N>/<N> tasks complete; gates green" \
  -b "Changeset: <files touched>
Deviations: <any noted above>
Validation: build=PASS test=PASS lint=PASS"
```
5. Only the HUMAN flips status to `done` after merging. This skill MAY perform the `done` transition only when the user explicitly confirms the merge:
```bash
cortex update <id> --as "$SESSION_ID" -s done -m "merged"
```

## Rules

- ALWAYS load the `cortex` skill first for CLI vocabulary and status semantics
- ALWAYS track the core protocol with TODOs or Quests, if the tooling supports it
- ALWAYS post ONE `cortex update` per Low-Level Task with `--as "$SESSION_ID"`
- NEVER mutate the cortex task body -- body changes are reserved for cortex-planner
- NEVER skip a task -- execute them in strict order
- NEVER modify the plan's High-Level or Mid-Level Objectives
- NEVER work on `main` branch -- always use feature branches
- NEVER deviate from the plan without user approval
- Follow TDD: verify tests are correct before relying on them. Update tests only with clear justification.
- `blocked` is reserved for genuine 3-retry exhaustion or missing prerequisites; `done` is for human-confirmed merges
- MAINTAINABILITY above all else. Follow KISS.
- When confused: stop, present theories, get user signoff. Uncertainty expressed > uncertainty hidden.
