// InboxPane — task-context content for the document workspace.
//
// TaskDocument's tablist drives the shared `tab` signal; this component
// renders the matching context view. No independent tab strip remains —
// the pane IS the panel content.
//
//   "updates" — Activity: newest-first keyed EXPANDABLE cards (summary with
//               clickable refs, full author, time, severity label + dot;
//               expanding reveals the rendered body through the shared
//               MarkdownView plus a Markdown-source disclosure — summary-
//               only updates stay useful without inventing a body), then
//               the '+ Post update' composer disclosure AFTER the thread
//               in normal scroll flow. No fixed bottom dock.
//   "authors" — per-task author rollup (existing aggregation).
//   "related" — three buckets from /api/tasks/:id/related; row click
//               navigates and clears filters (existing contract).
//
// Expansion state lives in a module-level per-task map so SSE churn and
// panel switches preserve which cards are open; the keyed list keeps DOM
// nodes stable as agent updates arrive (reader position preserved).

import type { VNode } from "preact";

import { activeTask, inboxList, resumeCandidatesForTask, taskAuthors } from "../../state/computed.ts";
import { resumeOutcome, resumeSession } from "../../lib/resume.ts";
import {
  tab,
  relatedTasks,
  relatedError,
  relatedLoading,
  selectedId,
  clearAllFilters,
  postUpdateOpen,
} from "../../state/signals.ts";
import { retryRelated } from "../../state/refresh.ts";
import { useSignal } from "@preact/signals";
import { fmtTime, initial } from "../../../lib/format.ts";
import { RefText } from "../../lib/RefText.tsx";
import { kbd } from "../../lib/keys.ts";
import { Icon } from "../Icon.tsx";
import { MarkdownView } from "../active/MarkdownView.tsx";
import { PostUpdateForm } from "../active/PostUpdateForm.tsx";
import type { Task, Update } from "../../api/types.ts";

// Per-task expanded-card memory (update ids). Module-level so expansion
// survives panel switches and SSE-driven re-renders; pruned implicitly by
// being keyed on update ids that simply stop rendering.
const expandedByTask = new Map<number, Set<number>>();

const SEVERITY_LABEL: Record<Update["severity"], string> = {
  progress: "progress",
  review: "review",
  blocked: "blocked",
};

export function InboxPane(): VNode {
  const current = tab.value;
  return (
    <div class="pane-inbox task-context">
      {current === "authors" ? <AuthorsView /> : current === "related" ? <RelatedView /> : <ActivityView />}
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
            <span class={severityClass} style="width:6px; height:6px"></span>
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

function AuthorsView(): VNode {
  const rows = taskAuthors.value;
  if (rows.length === 0) {
    return (
      <div class="empty">
        <Icon name="inbox" size={32} />
        <div class="empty-title">No authors on this task yet.</div>
      </div>
    );
  }
  const at = activeTask.value;
  const resumable = new Set(resumeCandidatesForTask.value.map(c => c.author));
  const outcome = resumeOutcome.value;
  return (
    <>
      <table class="authors-table">
        <thead>
          <tr>
            <th>Author</th>
            <th>Last seen</th>
            <th>Posts</th>
            <th>
              <span class="visually-hidden">Resume</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(a => (
            <tr>
              <td>{a.author}</td>
              <td class="num">{fmtTime(a.last_seen)}</td>
              <td class="num">{a.posts}</td>
              <td>
                {at && resumable.has(a.author) ? (
                  <button
                    type="button"
                    class="btn"
                    aria-label={`Resume ${a.author}`}
                    onClick={() => void resumeSession(at.id, a.author)}
                  >
                    Resume
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="meta resume-outcome" role="status">
        {outcome && at && outcome.taskId === at.id ? outcome.text : ""}
      </p>
    </>
  );
}

function RelatedView(): VNode {
  const at = activeTask.value;
  const data = relatedTasks.value;
  if (!at) {
    return (
      <div class="empty">
        <Icon name="inbox" size={32} />
        <div class="empty-title">Select a task to see related tasks.</div>
      </div>
    );
  }
  // Distinguish error/retry, loading, and confirmed empty. Keys are
  // checked at the rendering boundary too (defence in depth against a
  // stale producer accidentally painting another task's state).
  const error = relatedError.value;
  if (error?.taskId === at.id) {
    return (
      <div class="empty related-error" role="alert">
        <div class="empty-title">Couldn't load related tasks</div>
        <div class="empty-sub">{error.message}</div>
        <button type="button" class="btn" onClick={() => retryRelated()}>
          Retry
        </button>
      </div>
    );
  }
  const loading = relatedLoading.value;
  if (data === null || loading?.taskId === at.id) {
    return (
      <div class="empty">
        <div class="empty-title">Loading…</div>
      </div>
    );
  }
  return (
    <>
      <RelatedSection title="Referenced by" kind="inbound references" tasks={data.referencedBy} />
      <RelatedSection title="References" kind="outbound references" tasks={data.references} />
      <RelatedSection title="Shared tags" kind="shared tags" tasks={data.shared} />
    </>
  );
}

function RelatedSection({ title, kind, tasks }: { title: string; kind: string; tasks: Task[] }): VNode {
  return (
    <div class="related-section">
      <div class="inbox-header">
        <h2 class="eyebrow grow">{title}</h2>
        <span class="meta num">{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <div class="meta related-empty">no {kind}</div>
      ) : (
        tasks.map(t => (
          <button
            type="button"
            class="inbox-row related-row"
            onClick={() => {
              clearAllFilters();
              selectedId.value = t.id;
            }}
          >
            <div class="row" style="gap:8px; align-items:center">
              <span class="chip-id num">[{t.id}]</span>
              <span class="related-title grow">{t.title}</span>
            </div>
          </button>
        ))
      )}
    </div>
  );
}
