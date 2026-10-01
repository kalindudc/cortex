// memory-eval.test.ts — a synthetic replay of the real prompts behind plan
// @422 (evaluation of 2026-09-30 on a restored 383-task backup): one memory
// call must answer "what was I last doing for X" and "continue X" from ANOTHER
// repo's lane, for work handed off along a chain of streams. The corpus
// mirrors the evidence: a same-lane handover chain A→B→C linked by `@id`
// refs, four PR reviews of the same work bulk-closed later (status audits
// only), cortex-lane distractors sharing the words but not the phrase, and a
// 20 kB handover whose Next Steps sit past the 12,000-char show budget.
// Everything goes through the server routes and the renderers, like the CLI.
// Hermetic: Store.open(":memory:") and setSystemTime.

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import type { MemorySearchResult } from "../../src/contracts.ts";
import { MEMORY_LIMITS, renderHits, renderPrimer, renderStream, type Staleness } from "../../src/memory.ts";
import { buildApp } from "../../src/server.ts";
import { type MemoryStream, type MemoryStreamRow, Store } from "../../src/store.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const at = (day: number): void => {
  setSystemTime(new Date(T0 + day * DAY));
};

let store: Store;
let app: ReturnType<typeof buildApp>;
const id = { a: 0, b: 0, c: 0, reviews: [] as number[], sse: 0, edge: 0, notes: 0, install: 0 };

const get = async <T>(path: string): Promise<T> => {
  const res = await app.fetch(new Request(`http://localhost${path}`));
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};
const search = (q: string, extra = ""): Promise<MemorySearchResult> =>
  get(`/api/memory/search?q=${encodeURIComponent(q)}${extra}`);

const filler = (label: string, chars: number): string => {
  const line = `${label} detail line with enough words to look like a real handover paragraph.\n`;
  return line.repeat(Math.ceil(chars / line.length));
};

beforeAll(() => {
  store = Store.open(":memory:");
  app = buildApp(store);
  at(0);
  // cortex-lane distractors: the words, never the phrase.
  id.sse = store.addTask({
    title: "Last-Event-ID SSE events",
    lane: "cortex",
    body: "## State\nThe SSE events stream resumes from Last-Event-ID; routing of frames is per client.",
  }).id;
  id.edge = store.addTask({
    title: "Google edge routing for SSE events support note",
    lane: "cortex",
    body: "Edge routing support for events delivered to the dashboard.",
  }).id;
  // Prompt-noise distractors: a checkout path, a PR URL and conversational filler, never the topic.
  id.notes = store.addTask({
    title: "Session notes: proxy setup",
    lane: "cortex",
    body:
      "## State\nWorking in /Users/kalindu/src/github.com/kalindudc/cortex; see https://github.com/kalindudc/cortex/pull/12.\n" +
      "Something came up: everything goes via the proxy, come back to it.",
  }).id;
  id.install = store.addTask({
    title: "Install from source",
    lane: "cortex",
    body: "## Steps\nClone https://github.com/kalindudc/cortex into ~/src, then see the build script for something else.",
  }).id;
  at(1);
  id.a = store.addTask({
    title: "Handover: gateway routing-events migration (part 1)",
    lane: "infra",
    body: "## State\nMigrating the routing-events pipeline to the new gateway.\n## Next\n1. Split the consumer.",
    author: "pi-a",
  }).id;
  at(3);
  for (let n = 1; n <= 4; n++) {
    id.reviews.push(
      store.addTask({
        title: `Review: routing-events PR #${n}`,
        lane: "infra",
        body: `## Findings\nThe routing-events consumer change in PR #${n} looks correct.`,
        author: "pi-r",
      }).id,
    );
  }
  at(5);
  id.b = store.addTask({
    title: "Handover: gateway routing-events migration (part 2)",
    lane: "infra",
    body: `## State\nContinues @${id.a}: the consumer is split; routing events now flow through the gateway.`,
    author: "pi-b",
  }).id;
  store.addUpdate({ task_id: id.a, author: "pi-a", summary: `handed off \u2192 @${id.b}` });
  at(9);
  // The newest stream: a 20 kB handover whose Next Steps start past the show budget.
  id.c = store.addTask({
    title: "Handover: gateway routing-events migration (part 3)",
    lane: "infra",
    body: [
      "# Handover",
      `Continues @${id.b}.`,
      "## 1. Context",
      filler("context", 12_500),
      "## 2. Decisions",
      "- Keep the old consumer until the gateway is verified.",
      "## 3. Log",
      filler("log", 7_500),
      "## 9. Next Steps",
      "1. Flip the routing-events traffic to the gateway.",
    ].join("\n"),
    author: "pi-c",
  }).id;
  store.addUpdate({ task_id: id.b, author: "pi-b", summary: `handed off \u2192 @${id.c}` });
  // Later: the user bulk-closes the reviews (and A, B), stamping `updated` only.
  at(20);
  for (const review of [...id.reviews, id.a, id.b]) store.setStatus(review, "done", { author: "kalindudc" });
});

afterAll(() => {
  setSystemTime();
});

describe("memory evaluation (plan @422, real-prompt replay)", () => {
  test("the corpus reproduces the evidence: C's handover is long and the bulk close stamped `updated`", () => {
    const c = store.getTask(id.c);
    expect((c?.body ?? "").length).toBeGreaterThan(20_000);
    expect((c?.body ?? "").indexOf("## 9. Next Steps")).toBeGreaterThan(MEMORY_LIMITS.showBodyChars);
    expect(store.getTask(id.reviews[0] ?? 0)?.updated).toBeGreaterThan(c?.updated ?? 0);
  });

  test('"what was I last doing for the routing-events work" from the cortex lane → the newest handover first', async () => {
    const q = "what was I last doing for the routing-events work";
    const result = await search(q, "&boost=cortex");
    expect(result.recent).toBe(true);
    expect(result.terms).toEqual(["routing", "events"]);
    expect(result.hits[0]?.id).toBe(id.c);
    // Bulk-closed reviews are not the most recent work.
    expect(id.reviews).not.toContain(result.hits[0]?.id);
    const text = renderHits(result.terms, result.hits, T0 + 30 * DAY, { recent: result.recent });
    expect(text).toContain("newest first");
    expect(text.split("\n")[2]).toStartWith(`- [${id.c}] open \u00b7 infra \u00b7 active 2026-09-10`);
  });

  test('"routing-events": phrase matches rank before the cortex distractors, even with the cortex boost', async () => {
    const result = await search("routing-events", "&boost=cortex&limit=10");
    const order = result.hits.map(hit => hit.id);
    const phrased = [id.a, id.b, id.c, ...id.reviews];
    expect(order.slice(0, phrased.length).sort()).toEqual([...phrased].sort());
    // Both distractors match both words (they qualify) but never the phrase.
    expect(order.slice(phrased.length).sort()).toEqual([id.sse, id.edge].sort());
  });

  test("every older hand-off names the chain head: A and B carry latest = C", async () => {
    const result = await search("gateway routing-events migration handover", "&limit=10");
    const latest = new Map(result.hits.map(hit => [hit.id, hit.latest?.id ?? null]));
    expect(latest.get(id.a)).toBe(id.c);
    expect(latest.get(id.b)).toBe(id.c);
    expect(latest.get(id.c)).toBeNull();
    // A review cites nothing, so it stays itself; the text says where the work went.
    expect(latest.get(id.reviews[0] ?? 0) ?? null).toBeNull();
    expect(renderHits(result.terms, result.hits, T0 + 30 * DAY)).toContain(
      `latest linked @${id.c} (open, active 2026-09-10)`,
    );
  });

  test("the primer from the cortex lane lists the handover under other lanes; closed reviews are not active", async () => {
    const active = await get<MemoryStreamRow[]>("/api/memory/streams?lane=cortex&active=1&limit=50");
    const elsewhere = await get<MemoryStreamRow[]>(`/api/memory/streams?excludeLane=cortex&active=1&limit=9`);
    const primer = renderPrimer({ lane: "cortex", active, authored: [], elsewhere, now: T0 + 30 * DAY });
    const tail = primer.slice(primer.indexOf("Recently active in other lanes:"));
    expect(tail.split("\n")[1]).toStartWith(`- [${id.c}] open \u00b7 infra`);
    // Across every status, activity (not `updated`) puts C before the bulk-closed reviews.
    const infra = await get<MemoryStreamRow[]>("/api/memory/streams?lane=infra&limit=10");
    expect(infra[0]?.id).toBe(id.c);
  });

  test("`memory show` of the long handover leads with Next Steps and lists the rest; A names its latest", async () => {
    const staleness: Staleness = {
      verdict: "unverifiable",
      synced: T0,
      ageDays: 0,
      old: false,
      repo: "none",
      changed: [],
      missing: [],
      checked: 0,
      behind: 0,
    };
    const c = await get<MemoryStream>(`/api/memory/streams/${id.c}`);
    const text = renderStream(c, staleness);
    expect(text).toContain("## 9. Next Steps\n1. Flip the routing-events traffic to the gateway.");
    expect(text.indexOf("## 9. Next Steps")).toBeLessThan(text.indexOf("## 2. Decisions"));
    expect(text).toContain(`Contents: #handover #1-context #3-log (cortex memory show ${id.c} --section=<text>)`);
    expect(renderStream(c, staleness, { section: "next" })).not.toContain("## 1. Context");
    const a = await get<MemoryStream>(`/api/memory/streams/${id.a}`);
    expect(renderStream(a, staleness).split("\n")[1]).toContain(`latest linked @${id.c} (open, active 2026-09-10)`);
  });

  // The prompt-noise distractors replay the audit's path-led and chatty prompts.
  const noNoise = (result: MemorySearchResult): void => {
    expect(result.terms).toEqual(["gateway", "migration"]);
    const hits = result.hits.map(hit => hit.id);
    expect(hits).not.toContain(id.notes);
    expect(hits).not.toContain(id.install);
  };

  test("a path-led prompt matches on its topic, not the checkout path", async () => {
    const q = "/Users/kalindu/src/github.com/kalindudc/cortex what was I last doing on the gateway migration";
    const result = await search(q, "&boost=cortex");
    noNoise(result);
    expect(result.recent).toBe(true);
    expect(result.hits[0]?.id).toBe(id.c);
  });

  test("a chatty prompt matches on its topic, not the filler", async () => {
    const result = await search(
      "something came up with everything via the gateway migration, come back to it",
      "&boost=cortex",
    );
    noNoise(result);
    expect(result.hits.map(hit => hit.id).sort()).toEqual([id.a, id.b, id.c].sort());
  });

  test("a URL and an @id in the prompt add no terms", async () => {
    const result = await search(
      `see https://github.com/kalindudc/cortex/pull/12 and @${id.b} for the gateway migration`,
      "&boost=cortex",
    );
    noNoise(result);
    expect(result.hits.map(hit => hit.id)).toContain(id.b);
  });
});
