import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, test } from "vitest";
import type { CortexRunner } from "./cli";
import { CortexCliError } from "./cli";
import { createMemoryWrites } from "./memory-writes";
import { createWorkstreamStore } from "./workstream-store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const THREAD = "thr_aaaaaaaa";
const BODY = "Verified source: the isolated checkout fixture at release 1.2.3 produced this stable result.";
const note = (title: string, memory?: "exclude") => ({ title, body: BODY, kind: "research" as const, memory });
const actor = (threadId = THREAD, child = false) => ({ threadId, child, signal: new AbortController().signal });
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function setup() {
  let now = 2 * DAY;
  let cached: string | null = "cached";
  let local: string | null = "/verified/checkout";
  let localFails = false;
  let pause = false;
  let addFails = false;
  let similarityFails = false;
  let next = 1;
  const calls: { args: readonly string[]; cwd?: string; input?: string }[] = [];
  const task = (id: number, fields: { status?: string; memory_excluded?: boolean; title?: string; lane?: string } = {}) => ({
    id, title: `Similar subject ${id}`, lane: "checkout", status: "open", tags: [], body: BODY,
    created: now, updated: now, memory_excluded: false, ...fields,
  });
  const tasks = new Map<number, ReturnType<typeof task>>();
  const runner: CortexRunner = {
    binary: "/unused",
    async text(args, options) {
      calls.push({ args, ...options });
      if (localFails) throw new CortexCliError("missing", "checkout directory vanished");
      if (args[0] === "memory" && args[1] === "lane" && options?.cwd === local) {
        if (local === "/plain/scratch-notes") return args.includes("--checkout") ? "" : "scratch-notes\n";
        return "checkout\n";
      }
      throw new Error(`unexpected text call: ${args}`);
    },
    async run(args, schema, options) {
      calls.push({ args, ...options });
      const [verb, sub, id] = args;
      const get = (flag: string) => args.find(arg => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3);
      if (verb === "add") {
        if (addFails) throw new Error("create rejected");
        const added = task(next++, { title: args.at(-1), lane: get("lane"), memory_excluded: args.includes("--memory-excluded") });
        tasks.set(added.id, added);
        return schema.parse({ ...added, body: options?.input });
      }
      if (verb === "memory" && sub === "search") {
        if (similarityFails) throw new Error("search unavailable");
        return schema.parse({ hits: [{ id: 77, lane: "other", title: "Similar subject" }] });
      }
      if (verb === "show") {
        const found = tasks.get(Number(sub));
        if (!found) throw new CortexCliError("exit", `cortex show ${sub} failed: task ${sub} not found`);
        return schema.parse({ task: found });
      }
      if (verb === "edit") {
        const found = tasks.get(Number(sub))!;
        found.title = get("title") ?? found.title;
        if (get("bodySearch") !== undefined) found.body = found.body.replace(get("bodySearch")!, get("bodyReplace")!);
        return schema.parse(found);
      }
      if (verb === "update") return schema.parse({ update: { id: 90 } });
      if (verb === "memory" && (sub === "include" || sub === "exclude")) {
        const found = tasks.get(Number(id))!;
        const excluded = sub === "exclude";
        const changed = excluded !== found.memory_excluded;
        found.memory_excluded = excluded;
        return schema.parse({ ...found, changed });
      }
      throw new Error(`unexpected run call: ${args}`);
    },
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "cortex" });
  disposers.push(() => harness.lifecycle.dispose());
  const deps = {
    runner,
    state: { async locate() { return { projectId: "proj_one", cwd: local }; }, laneFor: () => cached },
    paused: () => pause,
    changed: () => {},
    clock: () => now,
  };
  const restart = () => createMemoryWrites(createWorkstreamStore(bb).memoryWrites, deps);
  return {
    calls, tasks, task, restart, writes: restart(), advance: (ms: number) => { now += ms; },
    cached: (value: string | null) => { cached = value; }, local: (value: string | null) => { local = value; },
    localFails: () => { localFails = true; }, pause: () => { pause = true; },
    addFails: (value: boolean) => { addFails = value; }, similarityFails: () => { similarityFails = true; },
  };
}

const actuallyAdded = (s: ReturnType<typeof setup>) => s.calls.filter(({ args }) => args[0] === "add");
const curate = (id: number, memory: "include" | "exclude" = "include") => ({ task_id: id, memory, reason: "Verified against a tagged release" });

test("uses local lane before cached lane, then refuses rather than using the runner cwd", async () => {
  const s = setup();
  expect(await s.writes.note(note("Verified local behavior"), actor())).toContain("lane checkout");
  s.localFails();
  expect(await s.writes.note(note("Verified cached behavior"), actor())).toContain("lane cached");
  s.local(null);
  s.cached(null);
  await expect(s.writes.note(note("No lane available"), actor())).rejects.toThrow("no lane for this thread's project; ask the lead");
  expect(s.calls.filter(c => c.args[1] === "lane").map(c => c.cwd)).toEqual(["/verified/checkout", "/verified/checkout"]);
  expect(actuallyAdded(s)).toHaveLength(2);
});

test("a plain local folder uses only a verified cached lane, never its basename", async () => {
  const s = setup();
  s.local("/plain/scratch-notes");
  expect(await s.writes.note(note("Plain folder with cache"), actor())).toContain("lane cached");
  s.cached(null);
  await expect(s.writes.note(note("Plain folder without a cache"), actor())).rejects.toThrow("no lane for this thread's project; ask the lead");
  expect(actuallyAdded(s).map(c => c.args.find(arg => arg.startsWith("--lane=")))).toEqual(["--lane=cached"]);
});

test("replays concurrent and persisted exact creates without spending another slot; expires at 24 hours", async () => {
  const s = setup();
  const input = note("Source verified twice");
  const [one, replay] = await Promise.all([s.writes.note(input, actor()), s.writes.note(input, actor())]);
  expect(one).toContain("@1");
  expect(one).toContain("@77");
  expect(one).toContain("revise it with cortex_note task_id");
  expect(replay).toContain("@1");
  expect(replay).toMatch(/already saved/i);
  expect(await s.restart().note(input, actor())).toContain("@1");
  expect(actuallyAdded(s)).toHaveLength(1);
  s.advance(DAY);
  expect(await s.writes.note(input, actor())).toContain("@2");
  expect(actuallyAdded(s)).toHaveLength(2);
  expect(await s.writes.note({ ...input, body: `${BODY}\nMore evidence.` }, actor())).toContain("@3");
});

test("reserves rolling hourly creates before parallel calls and gives children one slot", async () => {
  const s = setup();
  const results = await Promise.allSettled([1, 2, 3].map(i => s.writes.note(note(`Document number ${i}`), actor())));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
  expect(String(results.find(r => r.status === "rejected")?.reason)).toMatch(/revise an existing task.*never fall back to the shell/i);
  s.advance(HOUR - 1);
  await expect(s.writes.note(note("A fourth document"), actor())).rejects.toThrow(/hour/);
  s.advance(1);
  await expect(s.writes.note(note("A fourth document"), actor())).resolves.toContain("@3");
  const child = actor("thr_bbbbbbbb", true);
  await s.writes.note(note("Child's first document"), child);
  await expect(s.writes.note(note("Child's second document"), child)).rejects.toThrow(/hour/);
});

test("holds the persistent lane budget across parallel threads, falls back excluded and blocks agent includes", async () => {
  const s = setup();
  const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    s.writes.note(note(`Lane document ${i}`), actor(`thr_lane${i}`))));
  expect(outcomes.filter(r => r.includes("daily lane budget"))).toHaveLength(2);
  const excluded = [...s.tasks.values()].filter(t => t.memory_excluded);
  expect(excluded).toHaveLength(2);
  const forced = actuallyAdded(s).filter(c => c.args.includes("--memory-excluded"));
  expect(forced).toHaveLength(2);
  for (const { args } of forced) {
    expect(args).toContain("--memory-exclusion-reason=Saved excluded: the lane's daily memory budget is used");
    expect(args.some(arg => arg.startsWith("--as=bb-thr_lane"))).toBe(true);
  }
  const writes = s.restart();
  await expect(writes.curate(curate(excluded[0].id), actor())).rejects.toThrow(/daily lane budget.*shell/i);
  expect(await writes.curate(curate(1), actor())).toMatch(/already included/i);
  s.advance(DAY - 1);
  expect(await writes.note(note("Still over the budget"), actor())).toContain("daily lane budget");
  s.advance(1);
  expect(await writes.curate(curate(excluded[0].id), actor())).toContain("included");
  expect(await writes.curate(curate(excluded[0].id), actor())).toMatch(/already included/i);
  s.local(null);
  expect(await writes.note(note("Independent project lane"), actor())).toContain("lane cached");
});

test("an include spends a lane slot and a failed create releases its reservations", async () => {
  const s = setup();
  for (let i = 0; i < 9; i++) await s.writes.note(note(`Baseline document ${i}`), actor(`thr_base${i}`));
  s.addFails(true);
  await expect(s.writes.note(note("Not committed"), actor())).rejects.toThrow("create rejected");
  s.addFails(false);
  const draft = await s.writes.note(note("Temporary document", "exclude"), actor());
  expect(draft).toContain("excluded");
  expect(await s.writes.curate(curate(10), actor())).toContain("included");
  expect(await s.writes.note(note("Budget exhausted now"), actor())).toContain("daily lane budget");
});

test("pausing still saves and refuses inclusions; advisory lookup failure does not resave", async () => {
  const s = setup();
  s.pause();
  s.similarityFails();
  const input = note("A document while paused");
  const saved = await s.writes.note(input, actor());
  expect(saved).toContain("paused");
  expect(saved).toContain("Similar-task lookup failed");
  expect(s.tasks.get(1)?.memory_excluded).toBe(true);
  expect(actuallyAdded(s)[0].args).toContain("--memory-exclusion-reason=Saved excluded: the memory pause is on");
  expect(actuallyAdded(s)[0].args).toContain(`--as=bb-${THREAD}`);
  await expect(s.writes.curate(curate(1), actor())).rejects.toThrow(/paused.*shell/i);
  expect(await s.writes.note(input, actor())).toContain("@1");
  expect(actuallyAdded(s)).toHaveLength(1);
});

test("revises only allowed statuses, supports anchored edit, and posts the supplied summary", async () => {
  const s = setup();
  s.tasks.set(4, s.task(4, { status: "review" }));
  s.tasks.set(5, s.task(5, { status: "done" }));
  s.tasks.set(6, s.task(6));
  for (const task_id of [4, 5]) {
    await expect(s.writes.note({ task_id, title: "New title", summary: "Verified again" }, actor())).rejects.toThrow(/cortex_update/);
  }
  const result = await s.writes.note({ task_id: 6, search: "isolated", replace: "hermetic", summary: "Verified again" }, actor());
  expect(result).toContain("@6");
  expect(s.tasks.get(6)?.body).toContain("hermetic checkout");
  expect(s.calls.filter(c => c.args[0] === "edit")).toHaveLength(1);
  expect(s.calls.find(c => c.args[0] === "update")?.args).toEqual(["update", "6", "--message=Verified again", `--as=bb-${THREAD}`, "--json"]);
  await expect(s.writes.note({ task_id: 6, search: "hermetic", summary: "Missing replacement" }, actor())).rejects.toThrow(/together/);
});

test("pausing blocks edits to included tasks but lets excluded drafts be revised", async () => {
  const s = setup();
  s.tasks.set(1, s.task(1));
  s.tasks.set(2, s.task(2, { memory_excluded: true }));
  s.pause();
  const revise = (task_id: number) => s.writes.note({ task_id, title: "Verified correction", summary: "Checked the source" }, actor());
  await expect(revise(1)).rejects.toThrow(/paused.*cortex_update/i);
  expect(s.tasks.get(1)?.title).toBe("Similar subject 1");
  expect(await revise(2)).toContain("Revised @2");
  expect(s.calls.filter(c => c.args[0] === "edit").map(c => c.args[1])).toEqual(["2"]);
});

test("hourly revision and curation caps hold for concurrent tools and reset after an hour", async () => {
  const s = setup();
  for (let i = 1; i <= 20; i++) s.tasks.set(i, s.task(i));
  const revisions = await Promise.allSettled(Array.from({ length: 11 }, (_, i) =>
    s.writes.note({ task_id: i + 1, title: "Revised title", summary: "Evidence updated" }, actor())));
  expect(revisions.filter(r => r.status === "fulfilled")).toHaveLength(10);
  expect(String(revisions.find(r => r.status === "rejected")?.reason)).toMatch(/cortex_update.*shell/i);
  const curations = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => s.writes.curate(curate(i + 1, "exclude"), actor())));
  expect(curations.filter(r => r.status === "fulfilled")).toHaveLength(5);
  expect(String(curations.find(r => r.status === "rejected")?.reason)).toMatch(/report.*lead.*shell/i);
  s.advance(HOUR);
  expect(await s.writes.curate(curate(6, "exclude"), actor())).toContain("excluded");
});
