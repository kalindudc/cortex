// InboxPane — three-tab layout for the right column:
//   1. "Updates"  — the active task's update thread (the original behaviour).
//                   Each summary is rendered through RefText so @[id] / #[tag]
//                   refs in posted updates become clickable links.
//   2. "Authors"  — a roll-up of authors who have posted on the active task.
//   3. "Related"  — three buckets fetched from /api/tasks/:id/related:
//                   tasks that mention this one, tasks this one mentions
//                   (in body OR in any of its updates), and tasks sharing
//                   at least one tag. Clicking a row navigates to that task
//                   AND clears any active filter so the target is visible.

import type { VNode } from "preact";

import { activeTask, inboxList, taskAuthors } from "../../state/computed.ts";
import { tab, modal, relatedTasks, selectedId, clearAllFilters } from "../../state/signals.ts";
import { fmtTime, initial } from "../../lib/format.ts";
import { RefText } from "../../lib/RefText.tsx";
import { Icon } from "../Icon.tsx";
import type { Task } from "../../api/types.ts";

type InboxTab = "updates" | "authors" | "related";

export function InboxPane(): VNode {
  const current = tab.value;
  const selectTab = (t: InboxTab) => {
    tab.value = t;
  };
  return (
    <aside class="pane pane-inbox">
      <div class="tabs">
        <button class={current === "updates" ? "active" : ""} onClick={() => selectTab("updates")}>
          Updates
        </button>
        <button class={current === "authors" ? "active" : ""} onClick={() => selectTab("authors")}>
          Authors
        </button>
        <button class={current === "related" ? "active" : ""} onClick={() => selectTab("related")}>
          Related
        </button>
      </div>
      {current === "updates" ? <UpdatesView /> : current === "authors" ? <AuthorsView /> : <RelatedView />}
    </aside>
  );
}

function UpdatesView(): VNode {
  const at = activeTask.value;
  const list = inboxList.value;
  return (
    <>
      <div class="inbox-header">
        <h1 class="eyebrow grow">Inbox</h1>
        {at ? <span class="meta num">{list.length}</span> : null}
      </div>
      {list.length === 0 ? (
        <div class="empty">
          <Icon name="inbox" size={32} />
          <div class="empty-title">No updates yet</div>
          <div class="empty-sub">{at ? "Post an update to start a thread." : "Select a task to see its updates."}</div>
        </div>
      ) : (
        list.map(u => (
          <button type="button" class="inbox-row" onClick={() => (modal.value = { kind: "update-detail", update: u })}>
            <div class="row" style="gap:10px; align-items:flex-start">
              <span class="avatar">{initial(u.author)}</span>
              <div class="grow">
                <div class="summary">
                  <RefText text={u.summary} />
                </div>
                <div class="meta">
                  <span
                    class={
                      "dot dot-status-" +
                      (u.severity === "blocked" ? "blocked" : u.severity === "review" ? "review" : "open")
                    }
                    style="width:6px; height:6px"
                  ></span>
                  <span>{u.author}</span>
                  <span>&middot;</span>
                  <span>{fmtTime(u.created)}</span>
                </div>
              </div>
            </div>
          </button>
        ))
      )}
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
  return (
    <table class="authors-table">
      <thead>
        <tr>
          <th>Author</th>
          <th>Last seen</th>
          <th>Posts</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(a => (
          <tr>
            <td>{a.author}</td>
            <td class="num">{fmtTime(a.last_seen)}</td>
            <td class="num">{a.posts}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  if (data === null) {
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
