// DetailsTab — the side panel's Details tab for the active task: its
// properties (read-only; editing stays in the document header's chips), its
// authors with a Resume button on each resumable one, and its related tasks
// in three groups. Related data is fetched for the active task after every
// snapshot (state/refresh.ts), so this tab adds no fetch of its own.

import type { VNode } from "preact";

import type { Task } from "../../api/types.ts";
import { STATUS_LABEL } from "../../../lib/constants.ts";
import { fmtTime, initial } from "../../../lib/format.ts";
import { resumeOutcome, resumeSession } from "../../lib/resume.ts";
import { activeTask, resumeCandidatesForTask, taskAuthors } from "../../state/computed.ts";
import { retryRelated } from "../../state/refresh.ts";
import { clearAllFilters, lanes, relatedError, relatedLoading, relatedTasks, selectedId } from "../../state/signals.ts";
import { PriorityChip } from "../chips/PriorityChip.tsx";
import { Icon } from "../Icon.tsx";

export function DetailsTab(): VNode {
  const at = activeTask.value;
  if (!at) {
    return (
      <div class="empty">
        <Icon name="info" size={32} />
        <div class="empty-title">Select a task to see its details.</div>
      </div>
    );
  }
  return (
    <>
      <Properties task={at} />
      <AuthorsView />
      <h2 class="ctx-section-title">Related</h2>
      <RelatedView />
    </>
  );
}

function Properties({ task }: { task: Task }): VNode {
  const laneColor = lanes.value.find(l => l.name === task.lane)?.color ?? null;
  return (
    <>
      <h2 class="ctx-section-title">Properties</h2>
      <dl class="ctx-props">
        <dt>Status</dt>
        <dd>
          <span class={`dot dot-status-${task.status}`} aria-hidden="true"></span>
          {STATUS_LABEL[task.status]}
        </dd>
        <dt>Lane</dt>
        <dd>
          <span class="lane-color" style={laneColor ? `background: ${laneColor}` : ""} aria-hidden="true"></span>
          <span class="ctx-prop-text">{task.lane}</span>
        </dd>
        <dt>Priority</dt>
        <dd>{task.priority === null ? "None" : <PriorityChip priority={task.priority} />}</dd>
        <dt>Memory</dt>
        <dd>{task.memory_excluded ? "Kept out of agent memory" : "Agents can recall it"}</dd>
        <dt>Created</dt>
        <dd class="num">{new Date(task.created).toLocaleString()}</dd>
        <dt>Updated</dt>
        <dd>{fmtTime(task.updated)}</dd>
      </dl>
    </>
  );
}

function AuthorsView(): VNode {
  const rows = taskAuthors.value;
  const at = activeTask.value;
  const resumable = new Set(resumeCandidatesForTask.value.map(c => c.author));
  const outcome = resumeOutcome.value;
  return (
    <>
      <h2 class="ctx-section-title">
        Authors <span class="ctx-section-count num">{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p class="ctx-none">No authors on this task yet.</p>
      ) : (
        <ul class="author-list">
          {rows.map(a => (
            <li key={a.author} class="author-row">
              <span class="avatar" aria-hidden="true">
                {initial(a.author)}
              </span>
              <span class="author-main">
                <span class="author-name">{a.author}</span>
                <span class="author-meta">
                  {a.posts === 1 ? "1 update" : `${a.posts} updates`} · {fmtTime(a.last_seen)}
                </span>
              </span>
              {at && resumable.has(a.author) ? (
                <button
                  type="button"
                  class="btn author-resume"
                  aria-label={`Resume ${a.author}`}
                  onClick={() => void resumeSession(at.id, a.author)}
                >
                  <Icon name="play" size={12} />
                  <span>Resume</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
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
