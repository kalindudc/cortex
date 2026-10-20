// TaskDocument — the assembled document workspace for ONE task.
//
// Owns the single TaskDraft and routes it to TaskHeader (title/meta),
// EditableTaskBody (CodeMirror) and the rendered reader (MarkdownView).
//
// Lifetimes:
//   - The editor mounts LAZILY on first Edit/Split, then stays mounted but
//     hidden across Read and Activity passes — cursor,
//     undo history and pending edits survive. Keyed ONLY by the draft's
//     external-body replacement epoch (the parent keys by task id).
//   - The reader renders the CURRENT LOCAL DRAFT: immediately on Read
//     entry, debounced 150ms in Split, frozen while hidden. Body updates
//     arriving while the reader has an active text selection are staged
//     behind a 'Show latest' notice instead of replacing the selection.
//   - Reading position is remembered per task in session memory and
//     restored on return (heading + offset when possible, else clamped
//     scroll offset).
//
// One APG tablist governs Document / Activity, rendered inside the task
// toolbar; the Read/Edit/Split switch is a pressed-state button group, NOT
// a second tablist. Activity renders through the Activity view
// (ActivityPane). The headings of the shown document are published to
// `docOutline` for the side panel's Outline tab, whose clicks come back
// through `pendingHeadingFragment` (the one path that scrolls to a heading).

import type { VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import type { Task } from "../../api/types.ts";
import {
  tab,
  readerMode,
  pendingBodyFocus,
  pendingReaderFocus,
  pendingHeadingFragment,
  updates,
} from "../../state/signals.ts";
import { docOutline } from "../../state/context.ts";
import { requestMode } from "../../state/workspace.ts";
import { useTaskDraft } from "../../lib/useTaskDraft.ts";
import { resolveHeadingId } from "../../lib/markdown.ts";
import { tablistKeyHandler } from "../../lib/tablist.ts";
import type { MdEditorHandle } from "./MdEditor.tsx";
import { TaskHeader } from "./TaskHeader.tsx";
import { TaskToolbar } from "./TaskToolbar.tsx";
import { EditableTaskBody } from "./EditableTaskBody.tsx";
import { ExternalChangeBanner } from "./ExternalChangeBanner.tsx";
import { MarkdownView, type MarkdownHeading } from "./MarkdownView.tsx";
import { ActivityPane } from "./ActivityPane.tsx";
import { Icon } from "../Icon.tsx";

// ---------------------------------------------------------------------------
// Session-memory reading positions. Keyed by task id; survives task
// navigation, dies with the page (deliberately NOT browser storage).
// ---------------------------------------------------------------------------
interface ReadingPosition {
  headingId: string | null;
  delta: number; // scroll offset below the heading
  top: number; // absolute fallback when the heading is gone
}
const readingPositions = new Map<number, ReadingPosition>();

const TABS: Array<{ id: "document" | "updates"; label: string }> = [
  { id: "document", label: "Document" },
  { id: "updates", label: "Activity" },
];

export function TaskDocument({ task }: { task: Task }): VNode {
  const draft = useTaskDraft(task);
  const mode = readerMode.value;
  const currentTab = tab.value;

  // ---- editor lifetime ----
  const editorMounted = useSignal(false);
  const editorHandle = useRef<MdEditorHandle | null>(null);
  const editorVisible = currentTab === "document" && mode !== "read";
  // Ref mirror so onReady (fired outside render) can check visibility
  // without reading signals in a possibly-tracking context.
  const editorVisibleRef = useRef(editorVisible);
  editorVisibleRef.current = editorVisible;
  useEffect(() => {
    if ((mode === "edit" || mode === "split") && !editorMounted.value) editorMounted.value = true;
  }, [mode]);
  // Reveal → ask CodeMirror to re-measure (it cannot measure display:none).
  useEffect(() => {
    if (editorVisible) editorHandle.current?.requestMeasure();
  }, [editorVisible]);
  // One-shot body focus request (workspace.requestMode(mode, "body")):
  // consumed only once the editor is actually visible AND its handle
  // exists — either from this effect (visibility caught up) or straight
  // from onReady (handle arrived last). No signal writes on the unmount
  // path (onReady(null) only clears the ref) — writing component-owned
  // signals during unmount crashes preact's render queue.
  const tryConsumeBodyFocus = (): void => {
    if (pendingBodyFocus.peek() !== task.id) return;
    if (!editorVisibleRef.current) return;
    const h = editorHandle.current;
    if (!h) return;
    h.focus();
    pendingBodyFocus.value = null;
  };
  useEffect(() => {
    tryConsumeBodyFocus();
  }, [pendingBodyFocus.value, editorVisible]);

  // ---- reader source ----
  const readerVisible = currentTab === "document" && mode !== "edit";
  const readerSource = useSignal(draft.body);
  const staleNotice = useSignal(false);
  const readerRef = useRef<HTMLDivElement>(null);
  const announce = useSignal("");
  useEffect(() => {
    if (!readerVisible || pendingReaderFocus.peek() !== task.id) return;
    pendingReaderFocus.value = null;
    // A newer overlay action may have happened before this render. Never
    // take its focus; no animation completion or timeout is involved.
    if (document.querySelector("dialog[open], .popover[data-pop], .sidebar-filter-panel")) return;
    readerRef.current?.focus({ preventScroll: true });
  }, [readerVisible, pendingReaderFocus.value, task.id]);

  const selectionInsideReader = (): boolean => {
    const host = readerRef.current;
    if (!host || typeof document.getSelection !== "function") return false;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.anchorNode == null) return false;
    return host.contains(sel.anchorNode);
  };

  useEffect(() => {
    if (!readerVisible) return; // frozen while hidden — no rebuild churn
    if (mode === "split") {
      // Debounced preview while typing (150ms).
      const id = setTimeout(() => {
        readerSource.value = draft.body;
        staleNotice.value = false;
      }, 150);
      return () => clearTimeout(id);
    }
    // Read mode: immediate — unless it would replace an active selection.
    if (readerSource.value !== draft.body && selectionInsideReader()) {
      staleNotice.value = true;
      return;
    }
    readerSource.value = draft.body;
    staleNotice.value = false;
  }, [draft.body, mode, currentTab]);

  // Announce ACTUAL body replacements (external adoptions) without
  // stealing focus — bodyEpoch only moves on external replacement.
  const lastEpoch = useRef(draft.bodyEpoch);
  useEffect(() => {
    if (draft.bodyEpoch === lastEpoch.current) return;
    lastEpoch.current = draft.bodyEpoch;
    announce.value = "Task description updated";
  }, [draft.bodyEpoch]);

  // ---- outline + reading position ----
  const headings = useSignal<MarkdownHeading[]>([]);
  const activeHeading = useSignal<string | null>(null);
  // Source for which MarkdownView has completed DOM post-processing. This
  // separates the initial empty heading array from a CONFIRMED render with
  // zero headings, so missing/deleted URL targets can be retired safely.
  const renderedReaderSource = useSignal<string | null>(null);
  const onHeadings = (h: MarkdownHeading[]): void => {
    renderedReaderSource.value = readerSource.peek();
    headings.value = h;
    if (!h.some(heading => heading.id === activeHeading.peek())) activeHeading.value = h[0]?.id ?? null;
  };
  // Publish from an effect, never from a cleanup: writing a subscribed
  // signal on the unmount path crashes preact's render queue.
  useEffect(() => {
    docOutline.value = { taskId: task.id, headings: readerVisible ? headings.value : [], active: activeHeading.value };
  }, [task.id, readerVisible, headings.value, activeHeading.value]);

  // URL heading fragment: consume only on its owning task, once the
  // corresponding Markdown source has completed DOM post-processing.
  // Missing/deleted targets are consumed after that confirmed render — no
  // crash and no stale target waiting to surprise-scroll a future edit.
  useEffect(() => {
    const target = pendingHeadingFragment.value;
    if (target == null || target.taskId !== task.id || !readerVisible) return;
    const source = readerSource.value;
    // Empty descriptions have no MarkdownView callback; they are already a
    // confirmed missing target. Non-empty content waits for THIS source.
    if (source.trim() !== "" && renderedReaderSource.value !== source) return;
    const host = readerRef.current;
    if (!host) return;
    const id = resolveHeadingId(
      headings.value.map(h => h.id),
      task.id,
      target.id,
    );
    const el = id === null ? null : host.querySelector(`#${CSS.escape(id)}`);
    pendingHeadingFragment.value = null;
    el?.scrollIntoView({ block: "start" });
  }, [
    pendingHeadingFragment.value,
    renderedReaderSource.value,
    headings.value,
    readerVisible,
    readerSource.value,
    task.id,
  ]);

  const savePosition = (): void => {
    const host = readerRef.current;
    if (!host) return;
    const top = host.scrollTop;
    let headingId: string | null = null;
    let headingTop = 0;
    for (const h of Array.from(host.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))) {
      if (h.offsetTop <= top && h.offsetTop >= headingTop) {
        headingId = h.id || null;
        headingTop = h.offsetTop;
      }
    }
    readingPositions.set(task.id, { headingId, delta: top - headingTop, top });
    activeHeading.value = headingId ?? headings.peek()[0]?.id ?? null;
  };
  // Restore AFTER MarkdownView's child effect has built the DOM (child
  // effects run before this parent effect).
  useEffect(() => {
    if (!readerVisible) return;
    const host = readerRef.current;
    if (!host) return;
    const pos = readingPositions.get(task.id);
    if (!pos) return;
    const el = pos.headingId ? host.querySelector<HTMLElement>(`#${CSS.escape(pos.headingId)}`) : null;
    const target = el ? el.offsetTop + pos.delta : pos.top;
    const max = Math.max(0, host.scrollHeight - host.clientHeight);
    host.scrollTop = Number.isFinite(max) && max > 0 ? Math.min(target, max) : target;
  }, [readerVisible, task.id]);

  const emptyBody = draft.body.trim().length === 0;

  const tablistRef = useRef<HTMLDivElement>(null);
  const onTablistKey = tablistKeyHandler(
    () => tablistRef.current,
    i => {
      tab.value = TABS[i].id;
    },
  );

  return (
    <div class={`task-document mode-${mode}`}>
      <TaskToolbar
        task={task}
        tabs={
          <div class="doc-tabs" role="tablist" aria-label="Task content" ref={tablistRef} onKeyDown={onTablistKey}>
            {TABS.map(t => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`doc-tab-${t.id}`}
                aria-label={t.label}
                aria-selected={currentTab === t.id}
                aria-controls={`doc-panel-${t.id === "document" ? "document" : "context"}`}
                tabIndex={currentTab === t.id ? 0 : -1}
                class={currentTab === t.id ? "active" : ""}
                onClick={() => {
                  tab.value = t.id;
                }}
              >
                <span>{t.label}</span>
                {t.id === "updates" && (updates.value[task.id]?.length ?? 0) > 0 ? (
                  <span class="tab-count num" aria-hidden="true">
                    {updates.value[task.id].length}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        }
      />
      <div class="doc-page">
        <TaskHeader task={task} draft={draft} />
        {draft.external.body != null ? (
          <div class="doc-conflict">
            <ExternalChangeBanner
              label="Body"
              incoming={draft.external.body}
              onApply={() => draft.apply("body")}
              onDismiss={() => draft.keep("body")}
            />
          </div>
        ) : null}
        <span class="visually-hidden" aria-live="polite">
          {announce.value}
        </span>

        <div
          class={`doc-content mode-${mode}`}
          id="doc-panel-document"
          role="tabpanel"
          aria-labelledby="doc-tab-document"
          hidden={currentTab !== "document"}
        >
          <div class="doc-split">
            {editorMounted.value ? (
              <EditableTaskBody
                draft={draft}
                visible={editorVisible}
                onReady={h => {
                  editorHandle.current = h;
                  if (h) tryConsumeBodyFocus();
                }}
              />
            ) : null}
            {readerVisible ? (
              <div class="doc-reader" ref={readerRef} tabIndex={-1} onScroll={savePosition}>
                <div class="doc-reading-column">
                  {staleNotice.value ? (
                    <div class="doc-stale-notice" role="status">
                      <span>The description changed while you were reading.</span>
                      <button
                        type="button"
                        onClick={() => {
                          readerSource.value = draft.body;
                          staleNotice.value = false;
                        }}
                      >
                        Show latest
                      </button>
                    </div>
                  ) : null}
                  {emptyBody ? (
                    <div class="doc-empty-body">
                      <Icon name="fileText" size={24} />
                      <p>No description yet.</p>
                      <button type="button" class="btn" onClick={() => requestMode("edit", "body")}>
                        Add a description
                      </button>
                    </div>
                  ) : (
                    <MarkdownView source={readerSource.value} idPrefix={`task-${task.id}`} onHeadings={onHeadings} />
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div
          class="doc-context"
          id="doc-panel-context"
          role="tabpanel"
          aria-labelledby="doc-tab-updates"
          hidden={currentTab === "document"}
        >
          {currentTab !== "document" ? <ActivityPane /> : null}
        </div>
      </div>
    </div>
  );
}
