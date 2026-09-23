// PostUpdateForm — inline Activity composer (task 330, A2/A3): labeled
// author + 4096-char summary, per-task in-memory drafts, a submission guard
// (one request per submit, IME-safe), dispatch-time payload capture so
// deferred results can never post/clear another task's draft, SSE/API
// dedupe, and focus routing through requestPostUpdate.

import { describe, test, expect, mock, beforeEach } from "bun:test";

interface DeferredPost {
  taskId: number;
  payload: { author: string; summary: string };
  resolve: (u: unknown) => void;
  reject: (e: Error) => void;
}
const postCalls: DeferredPost[] = [];

mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    postUpd: mock(
      (taskId: number, payload: { author: string; summary: string }) =>
        new Promise((resolve, reject) => {
          postCalls.push({ taskId, payload, resolve, reject });
        }),
    ),
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    editTask: mock(() => Promise.resolve({})),
    setStat: mock(() => Promise.resolve({})),
  },
}));
mock.module("../../../../src/ui/api/errors.ts", () => ({
  tryApi: async <T,>(fn: () => Promise<T>): Promise<T> => fn(),
  showError: () => {},
}));

import { render, fireEvent } from "@testing-library/preact";
import { PostUpdateForm, clearPostDrafts } from "../../../../src/ui/components/active/PostUpdateForm.tsx";
import { meAuthor, updates, postUpdateFocusRequest } from "../../../../src/ui/state/signals.ts";
import type { Task, Update } from "../../../../src/ui/api/types.ts";

function task(over: Partial<Task> = {}): Task {
  return {
    id: 3,
    lane: "now",
    title: "t",
    body: null,
    status: "open",
    priority: null,
    created: 0,
    updated: 0,
    tags: [],
    ...over,
  };
}

const mkUpdate = (id: number, taskId: number, summary: string): Update => ({
  id,
  task_id: taskId,
  author: "me",
  summary,
  body: null,
  severity: "progress",
  created: 1,
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

function textarea(root: ParentNode): HTMLTextAreaElement {
  const ta = root.querySelector<HTMLTextAreaElement>("form.compose textarea");
  if (!ta) throw new Error("expected composer textarea");
  return ta;
}
function type(ta: HTMLTextAreaElement, text: string): void {
  ta.value = text;
  fireEvent.input(ta);
}

describe("PostUpdateForm", () => {
  beforeEach(() => {
    postCalls.length = 0;
    meAuthor.value = "me";
    updates.value = {};
    clearPostDrafts();
  });

  test("labeled author + summary with the 4096 limit", () => {
    const { container } = render(<PostUpdateForm task={task()} />);
    expect(container.querySelector("label[for='post-update-input']")).not.toBeNull();
    expect(container.querySelector("label[for='post-update-author']")).not.toBeNull();
    expect(textarea(container).getAttribute("maxlength")).toBe("4096");
    expect(container.querySelector(".char-counter")?.textContent).toBe("0/4096");
  });

  test("submit posts once with the captured payload and clears the draft on ack", async () => {
    const { container } = render(<PostUpdateForm task={task({ id: 3 })} />);
    const ta = textarea(container);
    type(ta, "hello world");
    fireEvent.submit(container.querySelector("form.compose") as HTMLFormElement);
    expect(postCalls.length).toBe(1);
    expect(postCalls[0].taskId).toBe(3);
    expect(postCalls[0].payload).toEqual({ author: "me", summary: "hello world" });
    postCalls[0].resolve(mkUpdate(50, 3, "hello world"));
    await tick();
    expect(textarea(container).value).toBe("");
  });

  test("duplicate submits while one is in flight fire ONE request", () => {
    const { container } = render(<PostUpdateForm task={task()} />);
    type(textarea(container), "once");
    const form = container.querySelector("form.compose") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(postCalls.length).toBe(1);
  });

  test("blank summaries never post", () => {
    const { container } = render(<PostUpdateForm task={task()} />);
    type(textarea(container), "   ");
    fireEvent.submit(container.querySelector("form.compose") as HTMLFormElement);
    expect(postCalls.length).toBe(0);
  });

  test("IME composition keydowns do not submit", () => {
    const { container } = render(<PostUpdateForm task={task()} />);
    const ta = textarea(container);
    type(ta, "composing");
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true, isComposing: true });
    expect(postCalls.length).toBe(0);
  });

  test("newer typing during a submit is retained after the ack (revision-scoped clear)", async () => {
    const { container } = render(<PostUpdateForm task={task({ id: 3 })} />);
    const ta = textarea(container);
    type(ta, "first");
    fireEvent.submit(container.querySelector("form.compose") as HTMLFormElement);
    type(ta, "first and more typing");
    postCalls[0].resolve(mkUpdate(51, 3, "first"));
    await tick();
    expect(textarea(container).value).toBe("first and more typing");
  });

  test("failed submits keep the text for retry", async () => {
    const { container } = render(<PostUpdateForm task={task({ id: 3 })} />);
    type(textarea(container), "will fail");
    fireEvent.submit(container.querySelector("form.compose") as HTMLFormElement);
    postCalls[0].reject(new Error("boom"));
    await tick();
    expect(textarea(container).value).toBe("will fail");
  });

  test("per-task drafts survive unmount/task switches without misattribution", () => {
    const a = render(<PostUpdateForm task={task({ id: 3 })} />);
    type(textarea(a.container), "draft for three");
    a.unmount();
    const b = render(<PostUpdateForm task={task({ id: 4 })} />);
    expect(textarea(b.container).value).toBe(""); // task 4 starts clean
    type(textarea(b.container), "draft for four");
    b.unmount();
    const a2 = render(<PostUpdateForm task={task({ id: 3 })} />);
    expect(textarea(a2.container).value).toBe("draft for three"); // recovered
  });

  test("a deferred ack after switching tasks clears only the ORIGINAL task's draft", async () => {
    const a = render(<PostUpdateForm task={task({ id: 3 })} />);
    type(textarea(a.container), "posting from three");
    fireEvent.submit(a.container.querySelector("form.compose") as HTMLFormElement);
    a.unmount();

    const b = render(<PostUpdateForm task={task({ id: 4 })} />);
    type(textarea(b.container), "typing on four");
    // The slow response for task 3 lands now.
    postCalls[0].resolve(mkUpdate(52, 3, "posting from three"));
    await tick();
    // Task 4's in-progress draft is untouched.
    expect(textarea(b.container).value).toBe("typing on four");
    b.unmount();
    // Task 3's submitted draft is cleared.
    const a2 = render(<PostUpdateForm task={task({ id: 3 })} />);
    expect(textarea(a2.container).value).toBe("");
  });

  test("the returned update is inserted once and deduped against its SSE echo", async () => {
    const { container } = render(<PostUpdateForm task={task({ id: 3 })} />);
    type(textarea(container), "dedupe me");
    fireEvent.submit(container.querySelector("form.compose") as HTMLFormElement);
    const created = mkUpdate(60, 3, "dedupe me");
    // SSE refresh beats the API response:
    updates.value = { 3: [created] };
    postCalls[0].resolve(created);
    await tick();
    expect((updates.value[3] ?? []).filter(u => u.id === 60).length).toBe(1);
  });

  test("unmount unregisters the global submit closure (hidden content cannot post)", () => {
    const view = render(<PostUpdateForm task={task({ id: 3 })} />);
    type(textarea(view.container), "must not post while hidden");
    expect(typeof window.__cortexPostUpdate).toBe("function");
    view.unmount();
    expect(window.__cortexPostUpdate).toBeUndefined();
    // The global key layer can only call the published closure; after the
    // panel is gone there is no stale task closure left to invoke.
    window.__cortexPostUpdate?.();
    expect(postCalls.length).toBe(0);
  });

  test("requestPostUpdate focus routing: focus request bump focuses the textarea", async () => {
    const scrolls: number[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => {
      scrolls.push(1);
    };
    try {
      const { container } = render(<PostUpdateForm task={task()} />);
      postUpdateFocusRequest.value = postUpdateFocusRequest.value + 1;
      // Signal-driven re-renders flush their effects on the rAF/timeout
      // tick, not the microtask queue — give it a real settle.
      await new Promise(r => setTimeout(r, 60));
      expect(document.activeElement).toBe(textarea(container));
      expect(scrolls.length).toBeGreaterThan(0);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
});
