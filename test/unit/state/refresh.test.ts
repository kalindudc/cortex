// state/refresh.ts — task-safe Related fetching (task 330, N2).
//
// Both async paths (refresh() and the activeTask effect) must publish
// Related results ONLY for the still-current request/task generation: a
// slow response for task A can never appear under task B, a stale error
// can never mask a current success, and failures surface an explicit
// error/retry state instead of a silent empty success.
//
// The api client is mocked with DEFERRED promises resolved out of order.
// The module keeps internal state (lastActive, request generation) across
// tests in the shared bun process, so every test uses its OWN task ids and
// filters relatedCalls by task id instead of relying on global counts.

import { describe, test, expect, mock, beforeEach } from "bun:test";

interface DeferredRelated {
  taskId: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}
const relatedCalls: DeferredRelated[] = [];
const updatesCalls: number[] = [];

mock.module("../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    notifications: mock(() => Promise.resolve([])),
    updates: mock((taskId: number) => {
      updatesCalls.push(taskId);
      return Promise.resolve([]);
    }),
    related: mock(
      (taskId: number) =>
        new Promise((resolve, reject) => {
          relatedCalls.push({ taskId, resolve, reject });
        }),
    ),
    editTask: mock(() => Promise.resolve({})),
  },
}));
mock.module("../../../src/ui/api/errors.ts", () => ({
  tryApi: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  showError: () => {},
}));

import {
  tasks,
  selectedId,
  filters,
  workspaceQuery,
  relatedTasks,
  relatedError,
  relatedLoading,
  showAllTasks,
} from "../../../src/ui/state/signals.ts";
import type { Task, RelatedTasks } from "../../../src/ui/api/types.ts";

// Fresh module instance bound to THIS file's api mock.
// @ts-expect-error — cache-bust query suffix has no .d.ts; runtime-only.
const refreshMod = await import("../../../src/ui/state/refresh.ts?b=refresh-test");
const { fetchRelated, retryRelated } = refreshMod as {
  fetchRelated: (taskId: number) => Promise<void>;
  retryRelated: () => void;
};

const mkTask = (id: number): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body: null,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
});

const ALL_IDS = [11, 12, 21, 31, 41, 42, 51, 61, 71, 72];
const buckets = (n: number): RelatedTasks => ({ referencedBy: [mkTask(n)], references: [], shared: [] });
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
const callsFor = (taskId: number): DeferredRelated[] => relatedCalls.filter(c => c.taskId === taskId);

describe("state/refresh related-fetch generations (N2)", () => {
  beforeEach(() => {
    relatedCalls.length = 0;
    updatesCalls.length = 0;
    tasks.value = ALL_IDS.map(mkTask);
    filters.value = { status: null, lane: null, tag: [] };
    workspaceQuery.value = "";
    showAllTasks.value = false;
    relatedTasks.value = null;
    relatedError.value = null;
    relatedLoading.value = null;
  });

  test("a slow response for task A never publishes under task B (out-of-order)", async () => {
    selectedId.value = 11; // effect → fetchRelated(11)
    selectedId.value = 12; // effect → fetchRelated(12); 11 still in flight
    const a = callsFor(11);
    const b = callsFor(12);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    b[0].resolve(buckets(12));
    await tick();
    expect(relatedTasks.value).toEqual(buckets(12));
    // Task A's slow response lands late — must be discarded.
    a[0].resolve(buckets(11));
    await tick();
    expect(relatedTasks.value).toEqual(buckets(12));
    expect(relatedError.value).toBeNull();
    expect(relatedLoading.value).toBeNull();
  });

  test("a newer request supersedes an older one for the SAME task", async () => {
    selectedId.value = 21; // effect-driven fetch (older generation)
    void fetchRelated(21); // explicit newer generation
    const calls = callsFor(21);
    expect(calls.length).toBe(2);
    calls[1].resolve(buckets(2)); // newest generation wins
    await tick();
    expect(relatedTasks.value).toEqual(buckets(2));
    calls[0].resolve(buckets(1)); // stale — discarded
    await tick();
    expect(relatedTasks.value).toEqual(buckets(2));
  });

  test("failure publishes a keyed error with loading cleared; retry refetches", async () => {
    selectedId.value = 31;
    const first = callsFor(31);
    expect(first.length).toBe(1);
    expect(relatedLoading.value?.taskId).toBe(31);
    expect(relatedLoading.value?.generation).toBeGreaterThan(0);
    first[0].reject(new Error("related backend down"));
    await tick();
    expect(relatedError.value).toEqual({ taskId: 31, message: "related backend down" });
    expect(relatedLoading.value).toBeNull();

    retryRelated();
    await tick();
    const retries = callsFor(31);
    expect(retries.length).toBe(2);
    retries[1].resolve(buckets(31));
    await tick();
    expect(relatedTasks.value).toEqual(buckets(31));
    expect(relatedError.value).toBeNull();
  });

  test("a stale error after switching tasks is discarded (no error flash on B)", async () => {
    selectedId.value = 41;
    selectedId.value = 42;
    callsFor(41)[0].reject(new Error("stale failure"));
    await tick();
    expect(relatedError.value).toBeNull(); // stale error suppressed
    callsFor(42)[0].resolve(buckets(42));
    await tick();
    expect(relatedTasks.value).toEqual(buckets(42));
    expect(relatedError.value).toBeNull();
  });

  test("empty buckets are a CONFIRMED empty, distinct from loading", async () => {
    selectedId.value = 51;
    callsFor(51)[0].resolve({ referencedBy: [], references: [], shared: [] });
    await tick();
    expect(relatedTasks.value).toEqual({ referencedBy: [], references: [], shared: [] });
    expect(relatedLoading.value).toBeNull();
    expect(relatedError.value).toBeNull();
  });

  test("a fetch that is already stale at START performs no request or state write", async () => {
    selectedId.value = 71;
    const currentCall = callsFor(71)[0];
    currentCall.resolve(buckets(71));
    await tick();
    const beforeCalls = relatedCalls.length;
    await fetchRelated(999);
    expect(relatedCalls.length).toBe(beforeCalls);
    expect(relatedTasks.value).toEqual(buckets(71));
    expect(relatedLoading.value).toBeNull();
  });

  test("losing the active task invalidates an in-flight Related request", async () => {
    selectedId.value = 72;
    const inFlight = callsFor(72).at(-1);
    if (!inFlight) throw new Error("expected task 72 Related call");
    tasks.value = [];
    selectedId.value = null;
    await tick();
    expect(relatedTasks.value).toBeNull();
    expect(relatedLoading.value).toBeNull();
    expect(relatedError.value).toBeNull();
    inFlight.resolve(buckets(71));
    await tick();
    expect(relatedTasks.value).toBeNull();
  });

  test("the activeTask effect fetches updates keyed by the task id", async () => {
    selectedId.value = 61;
    await tick();
    expect(updatesCalls).toContain(61);
  });
});
