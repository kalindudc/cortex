// ActivityPane — the Activity view of the document workspace: the active
// task's update thread and its composer. TaskDocument renders it when the
// "updates" tab is selected; the pane IS the panel content, with no tab
// strip of its own.
//
// The thread is newest-first keyed EXPANDABLE cards (summary with clickable
// refs, full author, time, severity label + dot; expanding reveals the
// rendered body through the shared MarkdownView plus a Markdown-source
// disclosure — summary-only updates stay useful without inventing a body),
// then the '+ Post update' composer disclosure AFTER the thread in normal
// scroll flow. No fixed bottom dock.
//
// Expansion state lives in a module-level per-task map so SSE churn and
// panel switches preserve which cards are open; the keyed list keeps DOM
// nodes stable as agent updates arrive (reader position preserved).

import type { VNode } from "preact";

import { activeTask, inboxList } from "../../state/computed.ts";
import { postUpdateOpen } from "../../state/signals.ts";
import { useSignal } from "@preact/signals";
import { fmtTime, initial } from "../../../lib/format.ts";
import { RefText } from "../../lib/RefText.tsx";
import { kbd } from "../../lib/keys.ts";
import { Icon } from "../Icon.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import { PostUpdateForm } from "./PostUpdateForm.tsx";
import type { Update } from "../../api/types.ts";

// Per-task expanded-card memory (update ids). Module-level so expansion
// survives panel switches and SSE-driven re-renders; pruned implicitly by
// being keyed on update ids that simply stop rendering.
const expandedByTask = new Map<number, Set<number>>();

const SEVERITY_LABEL: Record<Update["severity"], string> = {
  progress: "progress",
  review: "review",
  blocked: "blocked",
};

export function ActivityPane(): VNode {
  return (
    <div class="pane-inbox task-context">
      <ActivityView />
    </div>
  );
}

function UpdateCard({
  update,
  expanded,
  onToggle,
}: {
  update: Update;
  expanded: boolean;
  onToggle: () => void;
}): VNode {
  const severityClass = `dot dot-status-${update.severity === "blocked" ? "blocked" : update.severity === "review" ? "review" : "open"}`;
  const hasBody = !!update.body && update.body.trim().length > 0;
  return (
    <article class={`update-card${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        class="update-card-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
        title={expanded ? "Collapse update" : "Expand update"}
      >
        <span class="avatar">{initial(update.author)}</span>
        <span class="update-card-main">
          <span class="update-card-byline">
            <span class="update-card-author">{update.author}</span>
            <time>{fmtTime(update.created)}</time>
          </span>
          <span class="update-card-summary">
            <RefText text={update.summary} />
          </span>
          <span class="update-card-meta meta">
            <span class={severityClass}></span>
            <span class="update-card-severity">{SEVERITY_LABEL[update.severity] ?? update.severity}</span>
          </span>
        </span>
        <Icon name="chevronDown" className="update-disclosure" size={12} />
      </button>
      {expanded ? (
        <div class="update-card-body">
          {hasBody ? (
            <>
              <MarkdownView source={update.body as string} idPrefix={`update-${update.id}`} />
              <details class="update-source">
                <summary>Markdown source</summary>
                <pre>{update.body}</pre>
              </details>
            </>
          ) : (
            <p class="meta update-card-nobody">No body — the summary is the whole update.</p>
          )}
        </div>
      ) : null}
    </article>
  );
}

function ActivityView(): VNode {
  const at = activeTask.value;
  const list = inboxList.value;
  // Version tick to re-render after mutating the module-level expansion
  // set. Read during render (below) so bumps re-render this view.
  const expansionTick = useSignal(0);
  const _tick = expansionTick.value;
  const expandedFor = (taskId: number): Set<number> => {
    let set = expandedByTask.get(taskId);
    if (!set) {
      set = new Set();
      expandedByTask.set(taskId, set);
    }
    return set;
  };
  return (
    <>
      <div class="inbox-header activity-header">
        <div>
          <div class="activity-title">
            <h2>Activity</h2>
            {at ? <span class="tab-count num">{list.length}</span> : null}
          </div>
          <p class="activity-intro">Agent notes, readable where you are.</p>
        </div>
        <span class="activity-order">Newest first</span>
      </div>
      <div class="activity-thread">
        {list.length === 0 ? (
          <div class="empty">
            <Icon name="inbox" size={32} />
            <div class="empty-title">No updates yet</div>
            <div class="empty-sub">
              {at ? "Post an update to start a thread." : "Select a task to see its updates."}
            </div>
          </div>
        ) : (
          list.map(u => {
            const set = at ? expandedFor(at.id) : new Set<number>();
            return (
              <UpdateCard
                key={u.id}
                update={u}
                expanded={set.has(u.id)}
                onToggle={() => {
                  if (set.has(u.id)) set.delete(u.id);
                  else set.add(u.id);
                  expansionTick.value++;
                }}
              />
            );
          })
        )}
      </div>
      {at ? (
        <div class="activity-compose">
          <button
            type="button"
            class="post-update-toggle"
            aria-expanded={postUpdateOpen.value}
            onClick={() => (postUpdateOpen.value = !postUpdateOpen.value)}
            title={postUpdateOpen.value ? "Hide the update composer" : "Write an update"}
          >
            <Icon name="plus" className="compose-disclosure" size={12} />
            <span>Post update</span>
            <span class="kbd">{kbd("/")}</span>
          </button>
          {postUpdateOpen.value ? <PostUpdateForm task={at} /> : null}
        </div>
      ) : null}
    </>
  );
}
