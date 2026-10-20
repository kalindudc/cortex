// ContextPanel — the side panel beside the document: one APG tablist of
// Details, Inbox and Outline (state/context.ts#contextTab, persisted) over
// one tabpanel holding the selected tab. App mounts it as a grid column on a
// wide window and inside a sheet on a narrow one. It is not a popover: no
// outside click closes it, and the toolbar's toggle shows or hides it.

import type { VNode } from "preact";
import { useRef } from "preact/hooks";

import { type ContextTab, contextTab } from "../../state/context.ts";
import { unreadCount } from "../../state/notifications.ts";
import { tablistKeyHandler } from "../../lib/tablist.ts";
import { Icon } from "../Icon.tsx";
import { DetailsTab } from "./DetailsTab.tsx";
import { InboxTab } from "./InboxTab.tsx";
import { OutlineTab } from "./OutlineTab.tsx";

const TABS: ReadonlyArray<{ id: ContextTab; label: string; icon: string }> = [
  { id: "details", label: "Details", icon: "info" },
  { id: "inbox", label: "Inbox", icon: "bell" },
  { id: "outline", label: "Outline", icon: "list" },
];

export function ContextPanel(): VNode {
  const current = contextTab.value;
  const unread = unreadCount.value;
  const tablistRef = useRef<HTMLDivElement>(null);
  const onTablistKey = tablistKeyHandler(
    () => tablistRef.current,
    i => {
      contextTab.value = TABS[i].id;
    },
  );
  return (
    <aside class="context-panel" aria-label="Side panel">
      <div class="ctx-head">
        <div class="ctx-tabs" role="tablist" aria-label="Side panel" ref={tablistRef} onKeyDown={onTablistKey}>
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`ctx-tab-${t.id}`}
              aria-selected={current === t.id}
              aria-controls={`ctx-panel-${t.id}`}
              tabIndex={current === t.id ? 0 : -1}
              class={`ctx-tab${current === t.id ? " active" : ""}`}
              onClick={() => {
                contextTab.value = t.id;
              }}
            >
              <Icon name={t.icon} size={14} />
              <span>{t.label}</span>
              {t.id === "inbox" && unread > 0 ? (
                <span class="ctx-tab-badge num" aria-hidden="true">
                  {unread}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      <div
        class={`ctx-body ctx-body-${current}`}
        role="tabpanel"
        id={`ctx-panel-${current}`}
        aria-labelledby={`ctx-tab-${current}`}
      >
        {current === "details" ? <DetailsTab /> : current === "inbox" ? <InboxTab /> : <OutlineTab />}
      </div>
    </aside>
  );
}
