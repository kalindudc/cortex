// RenderMarkdownModal — read-only renderer for the active task body.
//
// Mounts under the `render-markdown` modal kind (see ModalRoot.tsx).
// Renders the body as HTML markdown (GFM) via marked, with mermaid code
// fences converted to SVG by the lazy-loaded mermaid chunk (see
// src/ui/lib/markdown.ts → runMermaid).
//
// SANITIZATION: cortex is single-user, localhost-only, no auth (AGENTS.md
// §1). Task bodies are written by the same human or their delegated agents,
// so we accept the threat of inline HTML rendering verbatim and do NOT pull
// in DOMPurify. The renderer leaves raw HTML in place; mermaid fences are
// passed verbatim too (mermaid's parser needs raw `-->`, `<`, `&`).
//
// MERMAID is lazy-loaded — first open per session pays a one-time fetch +
// parse cost; subsequent opens reuse the cached module. See markdown.ts.
//
// EDITING the body still happens in the always-on EditableTaskBody /
// CodeMirror surface under the modal — closing this modal returns the user
// to that editing surface unchanged. This modal is intentionally read-only.

import type { VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { tasks } from "../../state/signals.ts";
import { renderMarkdown, runMermaid } from "../../lib/markdown.ts";

export function RenderMarkdownModal({ taskId, close }: { taskId: number; close: () => void }): VNode {
  const overlayClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains("overlay")) close();
  };
  // Look up from the live `tasks` signal (not a passed-in Task) so SSE
  // body edits flow through to the modal while it is open.
  const task = tasks.value.find(t => t.id === taskId);
  const hasBody = !!task?.body && task.body.trim().length > 0;
  const html = hasBody ? renderMarkdown(task.body as string) : "";
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rootRef.current) void runMermaid(rootRef.current);
  }, [html]);
  return (
    <div class="overlay overlay--centered" onClick={overlayClick}>
      <div class="modal modal--wide modal--render-markdown">
        <h2>{task?.title ?? `Task ${taskId}`}</h2>
        <div class="update-body">
          {task == null ? (
            <p class="meta" style="margin:0">
              Task no longer exists.
            </p>
          ) : hasBody ? (
            <div class="markdown-rendered" ref={rootRef} dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <p class="meta" style="margin:0">
              Nothing to render.
            </p>
          )}
        </div>
        <div class="modal-actions">
          <button class="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
