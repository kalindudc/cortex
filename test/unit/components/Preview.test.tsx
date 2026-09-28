// Preview — the read-only rich draft preview page (plan @400 N21, Task 10 B).
//
// DOMPurify is mocked with a passthrough (broken under happy-dom), exactly
// as in MarkdownView.test.tsx; the real sanitizer, Mermaid and hostile
// content are certified in Chromium by test/e2e/tui-preview.spec.ts. These
// tests cover the page's STRUCTURE: identity, explicit loading/error/expiry
// states, the exact-source view, rendering only through MarkdownView (so the
// fail-closed path is the shared one), and reference navigation that never
// touches the workspace singletons.

import { beforeEach, describe, expect, mock, test } from "bun:test";

const purifyCtrl = { supported: true };
mock.module("dompurify", () => ({
  default: {
    get isSupported() {
      return purifyCtrl.supported;
    },
    sanitize: (html: string) => html,
    addHook: () => {},
    removeHook: () => {},
  },
}));

import { fireEvent, render, waitFor } from "@testing-library/preact";
import { HttpError, TransportError } from "../../../src/api.ts";
import type { PreviewSnapshot } from "../../../src/contracts.ts";
import { Preview } from "../../../src/ui/components/Preview.tsx";
import { filters, selectedId, tasks } from "../../../src/ui/state/signals.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

const snapshot = (over: Partial<PreviewSnapshot> = {}): PreviewSnapshot => ({
  taskId: 7,
  title: "Plan <b>not bold</b>",
  source: "# Draft heading\n\nUnsaved words with @12 and #infra.\n",
  unsaved: true,
  createdAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
  bytes: 64,
  ...over,
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe("Preview", () => {
  beforeEach(() => {
    purifyCtrl.supported = true;
    tasks.value = [];
    selectedId.value = null;
    filters.value = { status: null, lane: null, tag: [] };
  });

  test("loads by the exact token, then shows the task identity and renders through MarkdownView", async () => {
    const asked: string[] = [];
    const { container } = render(
      <Preview
        token={TOKEN}
        load={async token => {
          asked.push(token);
          return snapshot();
        }}
        now={() => NOW}
      />,
    );
    expect(container.querySelector("[role=status]")?.textContent).toContain("Loading");
    await waitFor(() => expect(container.querySelector(".markdown-view h1")?.textContent).toBe("Draft heading"));
    expect(asked).toEqual([TOKEN]);
    // Identity: the id and the title as TEXT (never markup), and that this is an unsaved, read-only draft.
    const title = container.querySelector(".preview-title");
    expect(title?.textContent).toContain("@7");
    expect(title?.textContent).toContain("Plan <b>not bold</b>");
    expect(title?.querySelector("b")).toBeNull();
    expect(container.querySelector(".preview-kicker")?.textContent).toContain("Unsaved draft");
    expect(container.textContent).toContain("read-only");
    expect(container.querySelector(".preview-expiry")?.textContent).toContain("Expires");
    // Heading anchors use the workspace's namespace, so heading links match the dashboard.
    expect(container.querySelector(".markdown-view h1")?.id).toBe("task-7-draft-heading");
    expect(container.querySelector<HTMLAnchorElement>("a.preview-open")?.getAttribute("href")).toBe("/task/7");
    expect(document.title).toContain("@7");
  });

  test("a saved (not unsaved) text says so", async () => {
    const { container } = render(
      <Preview token={TOKEN} load={async () => snapshot({ unsaved: false })} now={() => NOW} />,
    );
    await waitFor(() => expect(container.querySelector(".preview-kicker")?.textContent).toContain("Saved text"));
  });

  test("the source view shows the EXACT source as text, and toggles back", async () => {
    const source = "# H\r\n\n\t<script>window.__pwned = 1</script>\n\u001b]52;c;aGk=\u0007 é\n";
    const { container } = render(<Preview token={TOKEN} load={async () => snapshot({ source })} now={() => NOW} />);
    await waitFor(() => expect(container.querySelector(".markdown-view")).not.toBeNull());
    const toggle = container.querySelector<HTMLButtonElement>("button.preview-source-toggle");
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle as HTMLButtonElement);
    const pre = container.querySelector("pre.preview-source");
    expect(pre?.textContent).toBe(source);
    expect(pre?.querySelector("script")).toBeNull();
    expect(container.querySelector(".markdown-view")).toBeNull();
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".markdown-view")).not.toBeNull());
    expect(container.querySelector("pre.preview-source")).toBeNull();
  });

  test("an expired preview is an explicit error with the daemon's message", async () => {
    const { container } = render(
      <Preview
        token={TOKEN}
        load={async () => {
          throw new HttpError(410, "This preview expired at 2026-01-02T03:14:05.000Z", "preview_expired");
        }}
        now={() => NOW}
      />,
    );
    await waitFor(() => expect(container.querySelector("[role=alert]")).not.toBeNull());
    const alert = container.querySelector("[role=alert]") as HTMLElement;
    expect(alert.querySelector("h1")?.textContent).toContain("expired");
    expect(alert.textContent).toContain("This preview expired at 2026-01-02T03:14:05.000Z");
    expect(alert.textContent).toContain(":preview");
    expect(container.querySelector(".markdown-view")).toBeNull();
  });

  test("unknown tokens and transport failures are explicit too", async () => {
    const notFound = render(
      <Preview
        token="nope"
        load={async () => {
          throw new HttpError(404, "No such preview", "preview_not_found");
        }}
      />,
    );
    await waitFor(() =>
      expect(notFound.container.querySelector("[role=alert] h1")?.textContent).toContain("not found"),
    );
    const broken = render(
      <Preview
        token={TOKEN}
        load={async () => {
          throw new TransportError("network", "GET", `/api/preview/${TOKEN}`, "GET failed: connection refused");
        }}
      />,
    );
    await waitFor(() =>
      expect(broken.container.querySelector("[role=alert]")?.textContent).toContain("connection refused"),
    );
  });

  test("an unsupported sanitizer fails CLOSED through MarkdownView (no second renderer)", async () => {
    purifyCtrl.supported = false;
    const { container } = render(<Preview token={TOKEN} load={async () => snapshot()} now={() => NOW} />);
    await waitFor(() => expect(container.querySelector(".md-render-error")).not.toBeNull());
    expect(container.querySelector(".md-source-fallback")?.textContent).toBe(snapshot().source);
    expect(container.querySelector(".markdown-view h1")).toBeNull();
  });

  test("a task reference leaves for its dashboard deep link; no workspace singleton changes", async () => {
    tasks.value = [];
    const visited: string[] = [];
    const { container } = render(
      <Preview token={TOKEN} load={async () => snapshot()} navigate={path => visited.push(path)} now={() => NOW} />,
    );
    await waitFor(() => expect(container.querySelector("button.md-ref")).not.toBeNull());
    const taskRef = container.querySelector<HTMLButtonElement>("button.md-ref[data-ref-kind='task']");
    fireEvent.click(taskRef as HTMLButtonElement);
    expect(visited).toEqual(["/task/12"]);
    const tagRef = container.querySelector<HTMLButtonElement>("button.md-ref[data-ref-kind='tag']");
    fireEvent.click(tagRef as HTMLButtonElement);
    expect(visited).toEqual(["/task/12"]);
    expect(container.querySelector(".preview-note")?.textContent).toContain("#infra");
    // The workspace's selection and filters were never touched.
    expect(selectedId.value).toBeNull();
    expect(filters.value).toEqual({ status: null, lane: null, tag: [] });
  });

  test("the page says when an open preview expires, and keeps what it showed", async () => {
    let now = NOW;
    const { container } = render(
      <Preview
        token={TOKEN}
        load={async () => snapshot({ expiresAt: new Date(NOW + 30).toISOString() })}
        now={() => now}
      />,
    );
    await waitFor(() => expect(container.querySelector(".markdown-view h1")).not.toBeNull());
    expect(container.querySelector(".preview-expired")).toBeNull();
    now = NOW + 30;
    await waitFor(() => expect(container.querySelector(".preview-expired")?.textContent).toContain("expired"));
    expect(container.querySelector(".markdown-view h1")?.textContent).toBe("Draft heading");
    await tick();
  });
});
