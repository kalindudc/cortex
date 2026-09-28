// Preview — the read-only rich draft preview page (plan @400 N21, Task 10 B).
//
// `:preview` in the terminal holds one task's EXACT current text (unsaved
// edits included) in the daemon's memory (src/preview.ts) and opens
// `/preview/<token>`; src/ui/index.tsx boots this page there WITHOUT the
// workspace (no selection/filter/preference seeding, no history rewriting,
// no live stream, no notification prompt).
//
// - The text renders ONLY through MarkdownView (the one sanitized Markdown
//   boundary: DOMPurify, strict Mermaid, fail CLOSED to the source view when
//   the sanitizer is unsupported). This page never parses or inserts HTML;
//   the title and every message are text nodes.
// - Explicit states: loading, the daemon's not-found/expired/limit messages,
//   transport failures, and an open preview passing its expiry (the page
//   keeps what it showed and says so).
// - "Show source" displays the exact source as text.
// - References are followed WITHOUT the workspace singletons: @id leaves for
//   its dashboard deep link `/task/<id>`; #tag only explains where tag
//   filters live (a preview reads, it never filters or writes).

import type { VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import { HttpError } from "../../api.ts";
import type { PreviewSnapshot } from "../../contracts.ts";
import { api } from "../api/client.ts";
import { MarkdownView } from "./active/MarkdownView.tsx";

export interface PreviewProps {
  /** The token from `/preview/<token>`, passed to the daemon untouched. */
  token: string;
  /** Loads the preview (default: the dashboard's API client). */
  load?: (token: string) => Promise<PreviewSnapshot>;
  /** Leaves the preview for a same-origin path (default: location.assign). */
  navigate?: (path: string) => void;
  /** Clock seam (ms since the epoch) for the expiry notice. */
  now?: () => number;
}

type PreviewState =
  | { kind: "loading" }
  | { kind: "ready"; preview: PreviewSnapshot }
  | { kind: "error"; heading: string; message: string };

/** Longest single timer the browser honours (about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How often an open preview re-checks its expiry against the clock. */
const EXPIRY_POLL_MS = 1000;

function describeFailure(err: unknown): { heading: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof HttpError && (err.status === 410 || err.code === "preview_expired")) {
    return { heading: "This preview has expired", message };
  }
  if (err instanceof HttpError && (err.status === 404 || err.code === "preview_not_found")) {
    return { heading: "Preview not found", message };
  }
  return { heading: "The preview could not be loaded", message };
}

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
};

const defaultNavigate = (path: string): void => window.location.assign(path);

export function Preview(props: PreviewProps): VNode {
  const { token } = props;
  const load = props.load ?? ((t: string) => api.preview(t));
  const navigate = props.navigate ?? defaultNavigate;
  const now = props.now ?? Date.now;
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [showSource, setShowSource] = useState(false);
  const [expired, setExpired] = useState(false);
  const [note, setNote] = useState("");

  // Load once per token (the loader seam is stable per page).
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    setExpired(false);
    load(token).then(
      preview => {
        if (live) setState({ kind: "ready", preview });
      },
      (err: unknown) => {
        if (live) setState({ kind: "error", ...describeFailure(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [token]);

  const preview = state.kind === "ready" ? state.preview : null;

  useEffect(() => {
    if (preview === null) return;
    document.title = `Preview @${preview.taskId}: ${preview.title || "Untitled"} · cortex`;
  }, [preview]);

  // Track the expiry of the shown preview (the clock seam is stable per page).
  useEffect(() => {
    if (preview === null) return;
    const deadline = Date.parse(preview.expiresAt);
    if (Number.isNaN(deadline)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): void => {
      const remaining = deadline - now();
      if (remaining <= 0) {
        setExpired(true);
        return;
      }
      // Re-check at least every second: the clock seam (and a sleeping laptop) can move faster than a timer.
      timer = setTimeout(check, Math.min(remaining, EXPIRY_POLL_MS, MAX_TIMER_MS));
    };
    check();
    return () => clearTimeout(timer);
  }, [preview]);

  if (state.kind === "loading") {
    return (
      <div class="preview-page">
        <p class="preview-status" role="status">
          Loading the preview…
        </p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div class="preview-page">
        <div class="preview-error" role="alert">
          <h1>{state.heading}</h1>
          <p class="preview-error-message">{state.message}</p>
          <p class="preview-error-hint">
            Previews live only in the daemon's memory for 10 minutes. Run <code>:preview</code> in the terminal for a
            fresh one.
          </p>
        </div>
      </div>
    );
  }

  const shown = state.preview;
  const taskPath = Number.isSafeInteger(shown.taskId) && shown.taskId > 0 ? `/task/${shown.taskId}` : null;
  const followRef = (kind: "task" | "tag", value: string): void => {
    if (kind === "task") {
      if (/^\d+$/.test(value)) navigate(`/task/${Number(value)}`);
      return;
    }
    setNote(`#${value}: tag filters are in the dashboard's sidebar and the terminal's :filter; a preview only reads.`);
  };

  return (
    <div class="preview-page">
      <header class="preview-header">
        <p class="preview-kicker">{shown.unsaved ? "Unsaved draft" : "Saved text"} · rich preview · read-only</p>
        <h1 class="preview-title">
          <span class="preview-id">@{shown.taskId}</span> {shown.title || "Untitled"}
        </h1>
        <p class="preview-meta">
          Rendered with the dashboard's sanitizer and diagrams. Nothing here is saved: keep editing in the terminal.{" "}
          <span class="preview-expiry">Expires at {formatTime(shown.expiresAt)}.</span>
        </p>
        <div class="preview-actions">
          <button
            type="button"
            class="preview-source-toggle"
            aria-pressed={showSource ? "true" : "false"}
            onClick={() => setShowSource(value => !value)}
          >
            {showSource ? "Show rendered" : "Show source"}
          </button>
          {taskPath !== null && (
            <a class="preview-open" href={taskPath}>
              Open @{shown.taskId} in the dashboard
            </a>
          )}
        </div>
        <p class="preview-note" role="status" aria-live="polite">
          {note}
        </p>
      </header>
      {expired && (
        <p class="preview-expired" role="status">
          This preview expired at {formatTime(shown.expiresAt)}; the page keeps what it showed. Run{" "}
          <code>:preview</code> again for a fresh one.
        </p>
      )}
      <article class="preview-document">
        {showSource ? (
          <pre class="preview-source">{shown.source}</pre>
        ) : (
          <MarkdownView source={shown.source} idPrefix={`task-${shown.taskId}`} onRef={followRef} />
        )}
      </article>
    </div>
  );
}
