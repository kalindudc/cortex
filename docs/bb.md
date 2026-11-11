---
budget: 160
sources: [integrations/bb/server.ts, integrations/bb/state.ts, integrations/bb/watch.ts, integrations/bb/app.tsx,
  integrations/bb/cli.ts, integrations/bb/detail.ts, integrations/bb/memory.ts, integrations/bb/panel/,
  integrations/bb/ui/, integrations/bb/workstream-contract.ts, integrations/bb/workstream-cli.ts,
  integrations/bb/workstream-store.ts, integrations/bb/workstream-rpc.ts, integrations/bb/workstream-agents.ts,
  integrations/bb/workstreams.ts, src/commands/agents.ts, src/commands/workstream.ts, src/bbPlugin.ts,
  src/bbPluginSource.ts, src/extensions/pi.ts, integrations/bb/turns.ts]
---
# Cortex in bb

Cortex keeps tasks and shared knowledge available while you work in bb threads. Its page brings together changes
that need your review, workstreams and saved knowledge. The thread's Cortex and Memory tabs keep task actions and
context close without requiring one long-lived coordinator conversation.

## Install and upgrade

`cortex agents install` writes the plugin embedded in the Cortex binary to `~/.config/cortex/bb-plugin`, installs
its npm dependencies and registers it with bb. Repeating it changes only what differs; `cortex agents status`
shows those differences. `cortex agents reset` removes and replaces the plugin, resetting its settings.

Workstreams require a Cortex build with `cortex workstream` support and a daemon running that build. An older
running daemon cannot serve the new commands; stop it with `cortex stop` when you intend to upgrade. Do not point a
new plugin at a different production database merely to make an unavailable command appear to work.

Settings stay in bb's plugin settings. `cortexPath` selects an executable; an empty value searches PATH, `~/bin`
and `~/.local/bin`. Reload the plugin after changing it. `memory` controls automatic lookup and saving;
`taskChip` controls the task shortcut and `memoryChip` the memory status. `contextWidget` chooses whether context
is shown beside conversations by default. Appearance settings do not grant sharing or erase existing context.

## Connect a section to a workstream

Create a workstream, then use Bindings to connect a bb section to it. The workstream can span repositories.
An unsectioned child inherits its starting thread's connection; a deliberate thread-specific connection takes
precedence. Changing sections changes future context, not the ownership of saved knowledge or text in a running
agent's conversation. A section is a convenient association, not a security boundary or the memory database.

A blank topic includes the workstream's shared basics. Choosing a topic adds approved knowledge saved under that
exact topic. Choose a target environment and, where relevant, a target host or cluster explicitly: your development
checkout and the machine running the agent are not deployment targets. An unknown target is not a wildcard.

## Review saved knowledge

New shared knowledge starts as a suggestion, not an approved instruction. Review its wording, applicability and
sources before approving it. A human-message quote is evidence, not approval. Source authorship and reachability
are reported metadata; neither a source pointer nor unchanged files proves that a claim is true now.

Agents can attempt up to ten new suggestions during an active thread run. No-save results and failures count;
the limit resets when the thread becomes idle. It does not limit your review actions or explicit task updates.

Keep one accepted source of knowledge rather than saving another summary for each thread. Repeated evidence can
be attached to existing knowledge. Exact duplicates can produce a no-save result; related suggestions help compare
and consolidate. They are bounded hints, not a semantic duplicate detector or a confidence score. Different subject
keys and superficially different sources still need human judgment.

Report competing factual claims as a conflict. Automatic context withholds their actionable wording until review;
it carries a notice and source references instead. Superseding knowledge is an explicit, revision-checked decision.
Agent evidence cannot silently cancel a human prohibition. Expired observations also need review: a new observation
becomes a suggestion and does not put a new timestamp on the old claim.

Archive keeps knowledge available as history but out of future context. Forget removes its content from the current
entry and stored revisions while preserving a tombstone. Neither action erases prior exports, backups or text already
sent to an agent. Forget is not an undoable archive; read the confirmation before using it.

## Inspect or change a thread's context

The Memory tab shows the workstream, topic and targets, what is selected, what stays out and why, and the exact
text prepared for the thread. The estimate is approximate; if required knowledge is missing or context exceeds its
budget or the SDK's startup character limit, the preview explains the refusal before sending. Constraints are never
silently truncated.

Change wording or leave something out for this thread only without modifying the shared knowledge. A shared edit
is a separate action with a revision check; if someone changed it first, your input stays available for review.
The existing task action Exclude from automatic memory is task-wide, not a thread-only choice. Direct task reads
by ID remain possible, and exclusion does not remove text already in a session.

Prepare context inserts a visible draft for you to inspect and send. Preparing a draft is not delivery. A reference
adds information; it cannot replace a running session's earlier text. Start a fresh thread when a clean context is
needed. Context history preserves returned recall text and accepted reference sends; it never recomputes old text
from today's budget or knowledge and never claims that an agent used something merely because it was offered.
Returning instructions from a configuration callback does not prove the provider received them.

Bound lookup uses the workstream and explicit human grants, without an implicit fallback to legacy or other
workstream content. Reading an older, unscoped task requires an explicit grant and is labeled historical context.
Direct shell and Cortex CLI access remain outside this accidental-selection control.

## Keep conversations clear

Collapse context when you want a short summary. Close it when you want it completely out of the conversation;
the per-thread preference survives reloads. Bring it back from the Cortex thread action or the Memory tab. The
global default can keep it hidden in new threads without disabling memory. A restored thread can override that
default, or return to following it. Closing the widget changes presentation only, not the knowledge-sharing policy.

## Work with tasks

Open the Cortex tab from the thread panel, task shortcut or a `::cortex{id="529"}` card in a reply. Its switcher lists
tasks the thread updated and any manually linked by search or ID. Pin a focus task or follow the most active one.
A task the thread posted to cannot be unlinked; removing a manual link does not delete the task.

Overview folds the body at headings; Activity shows updates and their source threads. Change status or take the
next step with Undo, and post a note with an optional status change. These writes use your Cortex author. The More
menu copies the body or a command to open the desktop task, and includes task-wide automatic-memory exclusion.
The plan progress and source-file checks remain available; Files unchanged is not a factual verification badge.

## What agents receive

Unbound threads retain Cortex's ordinary memory behavior. Under Automatic, threads you start look up and save;
children look up without a general primer or automatic save turn. Look up only omits those writes; Off omits
automatic lookup and recall. Existing explicit `cortex_update` access remains available in all modes.

Startup context contains short claims, approval, scope and source references, not captured evidence excerpts.
An explicit scoped recall can return the selected knowledge's full captured evidence within the output budget.

Bound threads receive scoped context and can propose sourced findings or report corrections; they cannot approve
or grant sharing through these agent tools. Their scope comes from the executing thread, not caller-supplied
workstream or actor fields. Claude Code receives the Cortex skills from the plugin; other providers read their
installed skills. The pi extension steps aside in a bb thread so memory is not injected twice.

## Under the hood

The independent npm package is `integrations/bb/`; it uses only the public SDK, Node and declared dependencies.
It reads canonical tasks and workstream knowledge through the Cortex CLI, never through Cortex's database.
`src/bbPluginSource.ts` embeds the source at build time; its tests compare the embedded files with that source.
Run the final root build and tests only after plugin writers stop, so that comparison is meaningful.

- `workstream-contract.ts` validates RPC and CLI boundaries. `workstream-cli.ts` uses the current-entry command for
  canonical knowledge, not the oldest history revision. JSON mutations use stdin and `--input=-`.
- `workstream-store.ts` stores bb-specific bindings, preferences, grants and frozen context history. It does not
  duplicate the canonical knowledge database. `workstreams.ts` composes eligible context and thread-only changes.
- `workstream-agents.ts` prepares scope at dispatch, uses a synchronous configuration cache and registers read/propose
  tools. Session construction and provider delivery are distinct; the plugin does not claim hot system-prompt updates.
- `cli.ts` runs argument arrays with timeouts and cancellation, validates JSON and throws on every tool failure.
  `state.ts` retains task links, source checks and the ordinary project primer cache; `watch.ts` invalidates reads.
- `turns.ts` retains cued/first-user lookup, the narrower starting-thread path for children, and at most one save turn
  per eligible request. Workstream routing does not rewrite generic Cortex memory ranking.
- `app.tsx`, `ui/` and `panel/` use host tabs, navigation and context surfaces. Their RPC invalidations distinguish
  task, memory and workstream changes. All user-facing styling follows the host theme.

## Rules to keep

- No production database, real bb mutation or real npm invocation in tests; use temporary data and fakes:
  `test/integration/isolation.test.ts`, `test/integration/cli/agents-bb.test.ts`.
- Keep generic discovery and child behavior, bounded recall and explicit updates:
  `integrations/bb/server.test.ts`, `integrations/bb/turns.test.ts`, `integrations/bb/memory.test.ts`.
- Preserve current-state reads, source-role distinctions, approval/CAS and applicability guards:
  `test/unit/workstreams.test.ts`, `test/unit/workstreams-api.test.ts`, `test/integration/cli/workstreams.test.ts`.
- Test the CLI boundary, scope, context refusal, historical receipts and persistent visibility:
  `integrations/bb/workstreams.test.ts`, `integrations/bb/cli.test.ts`, `integrations/bb/app.test.tsx`.
- `pnpm run test:bb` runs the plugin tests and typecheck after its npm dependencies are installed. The root suite
  does not substitute for the independent plugin tests, and neither proves live provider lifecycle behavior.
