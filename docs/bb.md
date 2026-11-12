---
budget: 160
sources: [integrations/bb/, src/commands/agents.ts, src/commands/workstream.ts, src/bbPlugin.ts,
  src/bbPluginSource.ts, src/extensions/pi.ts]
---
# Cortex in bb

Cortex gives each connected bb section a shared brief: accepted takeaways that new threads can start with.
Its page follows your real sections; workstreams keep the knowledge independent of section names and lifetimes.
The thread's Cortex and Memory tabs retain task actions and detailed context controls.

## Install and upgrade

`cortex agents install` writes the plugin embedded in the Cortex binary to `~/.config/cortex/bb-plugin`, installs
its npm dependencies and registers it with bb. Repeating it changes only what differs; `cortex agents status`
shows those differences. `cortex agents reset` removes and replaces the plugin, resetting its settings.

Workstreams need a Cortex build and daemon with `cortex workstream` support. When upgrading, stop an older daemon
with `cortex stop`; never point the plugin at another production database to hide an unavailable command.

Settings stay in bb's plugin settings. `cortexPath` selects an executable; an empty value searches PATH, `~/bin`
and `~/.local/bin`. Reload the plugin after changing it. `memory` controls automatic lookup and saving;
`taskChip` controls the task shortcut and `memoryChip` the memory status. `contextWidget` chooses whether context
is shown beside conversations by default. Appearance settings do not grant sharing or erase existing context.

## Connect a section to a workstream

Open Cortex, choose a section and share context there. Confirm a new workstream or reuse an existing one;
a matching name alone connects nothing. Several sections can use the same brief, including across repositories.
Connecting imports no conversations and does not update running sessions. New threads in that section receive
eligible context automatically, without a separate Attach step. A preview is not proof of provider delivery.

Cortex uses its existing Brain SVG in its section list and composer. Native bb section names are left unchanged;
Cortex does not add an emoji prefix or decorate native section headers.
An unsectioned child inherits its starting thread's connection; a deliberate thread-specific connection wins.
Moving or disconnecting a section does not delete the workstream or erase text already in a running conversation.

A blank topic includes the workstream's shared basics. Choosing a topic adds approved knowledge saved under that
exact topic. Choose a target environment and, where relevant, a target host or cluster explicitly: your development
checkout and the machine running the agent are not deployment targets. An unknown target is not a wildcard.

## Draft from a thread

Choose the model in Cortex's Drafting settings, then Save. The default follows the source thread's model;
changes affect future drafts only. Choose a thread in the connected section and inspect excerpts from its finished
turns (never its first message, which has no turn to check) and the model before Start. The preview is not the whole
conversation or proof of provider use. Suggestions await your individual review; nothing is adopted automatically.
After reload, check the original request. Stop requested is not stopped; partial saved results remain linked.
Save recovery uses the original result without another model turn. The helper omits Cortex tools and memory;
provider-native tools and other plugins are not a security sandbox.

## Review saved knowledge

Save a message or selected passage as a takeaway, or write one from the thread's context controls. Message capture
checks the source; a rendered selection that cannot be matched offers whole-message or manual recovery instead.
Review wording, scope and sources before acceptance. Saving for review keeps the suggestion's identity and choices
without approval; unknown scope still blocks acceptance. A human can explicitly adopt a Rule, never by quote alone.
Source authorship and reachability are reported metadata, not authentication or proof that a claim is true now.

Agents have a bounded suggestion allowance per active run, including no-save results and failures. Your review
actions and explicit task updates are separate.

Keep one accepted source of knowledge rather than saving another summary for each thread. Repeated evidence can
be attached to existing knowledge. Exact duplicates can produce a no-save result; related suggestions help compare
and consolidate. They are bounded hints, not a semantic duplicate detector or a confidence score. Different subject
keys and superficially different sources still need human judgment.

Report competing factual claims as a conflict. Automatic context withholds their actionable wording until review;
it carries a notice and source references instead. Superseding knowledge is an explicit, revision-checked decision.
Agent evidence cannot silently cancel a human prohibition. Expired observations also need review: a new observation
becomes a suggestion and does not put a new timestamp on the old claim.

Archive keeps knowledge as history, out of future context. Forget removes current and revision text but keeps a tombstone.
Neither erases exports, backups or already-sent text. Forget cannot be undone; read its confirmation first.

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

A connected section adds its brief to ordinary Cortex memory; another workstream's knowledge needs an explicit human grant.
Direct shell and Cortex CLI access remain outside this accidental-selection control.

## Keep conversations clear

The composer summary shrinks with available space, down to one icon that opens its details, and stays in wide panes
beside bb's context card. Collapse it, or close it; the per-thread preference survives reloads. Restore it from the
thread action or Memory tab. The global default can hide it without disabling memory; each thread can override or
follow that default. Closing the widget changes presentation only, not knowledge sharing.

## Work with tasks

Open the Cortex tab from the thread panel, task shortcut or a `::cortex{id="529"}` card in a reply. Its switcher lists
tasks the thread updated and any manually linked by search or ID. Pin a focus task or follow the most active one.
A task the thread posted to cannot be unlinked; removing a manual link does not delete the task.

Overview folds the body at headings; Activity shows updates and source threads. Change status with Undo or post
a note with optional status, using your Cortex author. More copies the body or desktop command and controls
task-wide memory exclusion. Plan progress and source checks remain; Files unchanged is not factual verification.

## What agents receive

Every thread keeps Cortex's ordinary memory, including in connected sections. Under Automatic, threads you start look up and save;
children look up without a general primer or automatic save turn. Look up only omits those writes; Off omits
automatic lookup and recall. Existing explicit `cortex_update` access remains available in all modes.

Startup context contains short claims, approval, scope and source references, not captured evidence excerpts.
An explicit scoped recall can return the selected knowledge's full captured evidence within the output budget.

Bound threads also receive scoped context and can propose sourced findings or report corrections; they cannot approve
or grant sharing through these agent tools. Their scope comes from the executing thread, not caller-supplied
workstream or actor fields. Claude Code receives the Cortex skills from the plugin; other providers read their
installed skills. The pi extension steps aside in a bb thread so memory is not injected twice.

## Under the hood

The independent npm package is `integrations/bb/`; it uses only the public SDK, Node and declared dependencies.
It reads canonical tasks and workstream knowledge through the Cortex CLI, never through Cortex's database.
`src/bbPluginSource.ts` embeds the plugin at build time; tests compare its bundled files with the source.

- `workstream-contract.ts` validates RPC and CLI boundaries. `workstream-cli.ts` uses the current-entry command for
  canonical knowledge, not the oldest history revision. JSON mutations use stdin and `--input=-`.
- `workstream-store.ts` stores bindings, preferences, grants and frozen context history; `workstreams.ts` composes
  eligible context. `sections.ts` and `section-store.ts` keep resumable connection/capture intent and legacy title-mark ownership,
  not another canonical knowledge database. Intended IDs are persisted before cross-store writes.
- `workstream-agents.ts` prepares scope at dispatch, uses a synchronous configuration cache and registers read/propose
  tools. Session construction and provider delivery are distinct; the plugin does not claim hot system-prompt updates.
- `cli.ts` runs argument arrays with timeouts/cancellation, validates JSON and throws on tool failure. `state.ts`
  retains task links, source checks and the project primer cache; `watch.ts` invalidates reads.
- `draft-service.ts` owns durable helper intent and recovery; `draft-validation.ts` verifies sources and suggestions.
- `turns.ts` retains cued/first-user lookup, the narrower starting-thread path for children, and at most one save turn
  per eligible request. Workstream routing does not rewrite generic Cortex memory ranking.
- `app.tsx`, `ui/` and `panel/` use host UI and theme. Shared reads use public host identity, not per-hook RPC clients;
  only affected views refresh, preserving successful content and in-progress edits.

## Rules to keep

- No production database, real bb mutation or real npm invocation in tests; use temporary data and fakes:
  `test/integration/isolation.test.ts`, `test/integration/cli/agents-bb.test.ts`.
- Keep generic discovery and child behavior, bounded recall and explicit updates:
  `integrations/bb/server.test.ts`, `integrations/bb/turns.test.ts`, `integrations/bb/memory.test.ts`.
- Preserve current-state reads, source-role distinctions, approval/CAS and applicability guards:
  `test/unit/workstreams.test.ts`, `test/unit/workstreams-api.test.ts`, `test/integration/cli/workstreams.test.ts`.
- Test the CLI boundary, scope, context refusal, historical receipts and persistent visibility:
  `integrations/bb/workstreams.test.ts`, `integrations/bb/sections.test.ts`, `integrations/bb/cli.test.ts`,
  `integrations/bb/app.test.tsx`, `integrations/bb/section-ui.test.tsx`.
- `pnpm run test:bb` runs the plugin tests and typecheck after its npm dependencies are installed. The root suite
  does not substitute for the independent plugin tests, and neither proves live provider lifecycle behavior.
