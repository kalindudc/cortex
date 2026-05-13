import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Store } from "../store.ts";
import { runCli, mkTmpEnv } from "./helpers.ts";

// Plan 3: every setStatus call writes an audit-trail row in `updates`
// alongside the actual status mutation (in the same transaction). This makes
// parallel-agent status oscillation visible as inbox history rather than
// silently overwriting the previous status.

let testEnv: Record<string, string>;
let dbPath: string;
let cleanup: () => void;

beforeAll(() => {
  const e = mkTmpEnv("audit");
  testEnv = e.env;
  dbPath = e.env.CORTEX_DB!;
  cleanup = e.cleanup;
});

afterAll(() => cleanup());

const run = (...args: string[]) => runCli({ args, env: testEnv });

describe("audit-trail status rows", () => {
  test("update -s review writes message + audit-trail row, both attributed", async () => {
    let r = await run("init");
    expect(r.code).toBe(0);
    r = await run("add", "audit-target");
    expect(r.code).toBe(0);

    r = await run("update", "1", "-s", "review", "-m", "ready", "--as", "a-1");
    expect(r.code).toBe(0);

    const s = Store.open(dbPath);
    const rows = s.listUpdates(1);
    s.close();
    expect(rows.length).toBe(2);
    // Both rows attributed to the same session.
    expect(rows.every((u) => u.author === "a-1")).toBe(true);
    // One row carries the message text the user typed, the other carries
    // the audit-trail marker.
    const summaries = rows.map((u) => u.summary).sort();
    expect(summaries).toEqual(["ready", "status \u2192 review"].sort());
  });

  test("a second status change appends another pair, status updates, audit chronological", async () => {
    let r = await run("update", "1", "-s", "blocked", "-m", "stuck", "--as", "a-2");
    expect(r.code).toBe(0);

    const s = Store.open(dbPath);
    const rows = s.listUpdates(1);
    const task = s.getTask(1);
    s.close();
    // 2 from the first status change + 2 from the second.
    expect(rows.length).toBe(4);
    expect(task?.status).toBe("blocked");
    // Last two rows attributed to a-2.
    const last2 = rows.slice(-2);
    expect(last2.every((u) => u.author === "a-2")).toBe(true);
    const last2Summaries = last2.map((u) => u.summary).sort();
    expect(last2Summaries).toEqual(["status \u2192 blocked", "stuck"].sort());
  });

  test("Store.addUpdate accepts 1024-char summary directly; rejects 1025", () => {
    const s = Store.open(":memory:");
    const t = s.addTask({ title: "x" });
    expect(() =>
      s.addUpdate({ task_id: t.id, author: "a", summary: "x".repeat(1024) }),
    ).not.toThrow();
    expect(() =>
      s.addUpdate({ task_id: t.id, author: "a", summary: "x".repeat(1025) }),
    ).toThrow(/summary too long/);
    s.close();
  });
});
