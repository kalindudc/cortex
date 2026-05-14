// InboxPane — two-tab layout: "Updates" (the active task's update thread,
// the original behaviour) and "Authors" (a roll-up of recent author
// activity loaded lazily from /api/authors when the tab is first opened).

import type { VNode } from "preact";

import { activeTask, inboxList } from "../../state/computed.ts";
import { tab, authors } from "../../state/signals.ts";
import { fetchAuthors } from "../../state/refresh.ts";
import { fmtTime, initial } from "../../lib/format.ts";
import { Icon } from "../Icon.tsx";

export function InboxPane(): VNode {
  const at = activeTask.value;
  const list = inboxList.value;
  const current = tab.value;
  const selectTab = (t: "updates" | "authors") => {
    tab.value = t;
    // Lazy-load the author roll-up the first time (and on every subsequent
    // click — keeps the table fresh without polling).
    if (t === "authors") fetchAuthors();
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
      </div>
      {current === "updates" ? (
        <>
          <div class="inbox-header">
            <h1 class="eyebrow grow">Inbox</h1>
            {at ? <span class="meta num">{list.length}</span> : null}
          </div>
          {list.length === 0 ? (
            <div class="empty">
              <Icon name="inbox" size={32} />
              <div class="empty-title">No updates yet</div>
              <div class="empty-sub">
                {at ? "Post an update to start a thread." : "Select a task to see its updates."}
              </div>
            </div>
          ) : (
            list.map(u => (
              <div class="inbox-row">
                <div class="row" style="gap:10px; align-items:flex-start">
                  <span class="avatar">{initial(u.author)}</span>
                  <div class="grow">
                    <div class="summary">{u.summary}</div>
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
              </div>
            ))
          )}
        </>
      ) : authors.value.length === 0 ? (
        <div class="empty">
          <Icon name="inbox" size={32} />
          <div class="empty-title">No author activity in the last 24h.</div>
        </div>
      ) : (
        <table class="authors-table">
          <thead>
            <tr>
              <th>Author</th>
              <th>Last seen</th>
              <th>Posts</th>
            </tr>
          </thead>
          <tbody>
            {authors.value.map(a => (
              <tr>
                <td>{a.author}</td>
                <td class="num">{fmtTime(a.last_seen)}</td>
                <td class="num">{a.posts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </aside>
  );
}
