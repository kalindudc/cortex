import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import type { CortexRunner } from "./cli";
import { CortexCliError } from "./cli";
import { createMemoryWrites, noteParameters } from "./memory-writes";
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
  let addError: Error | null = null;
  let similarityFails = false;
  let hits = [{ id: 77, lane: "other", title: "Similar subject" }];
  let statusAtEdit: string | undefined;
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
        if (addError) throw addError;
        const added = task(next++, { title: args.at(-1), lane: get("lane"), memory_excluded: args.includes("--memory-excluded") });
        tasks.set(added.id, added);
        return schema.parse({ ...added, body: options?.input });
      }
      if (verb === "memory" && sub === "search") {
        if (similarityFails) throw new Error("search unavailable");
        return schema.parse({ hits: hits.slice(0, Number(get("limit"))) });
      }
      if (verb === "show") {
        const found = tasks.get(Number(sub));
        if (!found) throw new CortexCliError("exit", `cortex show ${sub} failed: task ${sub} not found`);
        return schema.parse({ task: found });
      }
      if (verb === "edit") {
        const found = tasks.get(Number(sub))!;
        if (statusAtEdit) found.status = statusAtEdit;
        if (get("unless-status")?.split(",").includes(found.status)) {
          throw new CortexCliError("exit", `cortex edit ${sub} failed: task ${sub} is ${found.status}`);
        }
        found.title = get("title") ?? found.title;
        if (get("bodySearch") !== undefined) found.body = found.body.replace(get("bodySearch")!, get("bodyReplace")!);
        return schema.parse({ ...found, ...(get("message") !== undefined ? { update: { id: 90 } } : {}) });
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
    atomicEdit: true,
    changed: () => {},
    clock: () => now,
  };
  const restart = () => createMemoryWrites(createWorkstreamStore(bb).memoryWrites, deps);
  return {
    calls, tasks, task, restart, writes: restart(), advance: (ms: number) => { now += ms; },
    cached: (value: string | null) => { cached = value; }, local: (value: string | null) => { local = value; },
    localFails: () => { localFails = true; }, pause: () => { pause = true; },
    addFails: (value: Error | null) => { addError = value; }, similarityFails: () => { similarityFails = true; },
    setHits: (value: typeof hits) => { hits = value; }, statusAtEdit: (value: string) => { statusAtEdit = value; },
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
  expect(one).not.toContain("Similar tasks:");
  expect(replay).toContain("@1");
  expect(replay).toMatch(/already saved/i);
  expect(await s.restart().note(input, actor())).toContain("@1");
  expect(actuallyAdded(s)).toHaveLength(1);
  s.advance(DAY);
  expect(await s.writes.note(input, actor())).toContain("@2");
  expect(actuallyAdded(s)).toHaveLength(2);
  expect(await s.writes.note({ ...input, body: `${BODY}\nMore evidence.` }, actor())).toContain("@3");
});

test.each(["deleted", "recreated"])("a %s task is not a replay of the earlier create", async kind => {
  const s = setup();
  const input = note("Original saved document");
  expect(await s.writes.note(input, actor())).toContain("Saved @1");
  s.advance(1);
  if (kind === "deleted") s.tasks.delete(1);
  else s.tasks.set(1, s.task(1, { title: "Different document on the old id" }));
  expect(await s.restart().note(input, actor())).toContain("Saved @2");
  expect(actuallyAdded(s)).toHaveLength(2);
  expect(await s.restart().note(input, actor())).toContain("Already saved: @2");
});

test("offers only similar titles, favors the same lane, and still finds hits after noisy rows", async () => {
  const s = setup();
  s.setHits([
    { id: 1, lane: "checkout", title: "Persistence daemon lease protocol" },
    { id: 71, lane: "checkout", title: "The review for release 110" },
    { id: 72, lane: "other", title: "Daemon protocol compatibility" },
    { id: 73, lane: "checkout", title: "Lease" },
    { id: 74, lane: "checkout", title: "Persistence daemon lease protocol tests" },
    { id: 75, lane: "checkout", title: "Protocol for the changelog 110" },
  ]);
  const result = await s.writes.note(note("Persistence Daemon Lease Protocol for the 110"), actor());
  expect(result).toContain("Similar tasks:");
  expect(result.match(/^- @(\d+)/gm)).toEqual(["- @73", "- @74", "- @72"]);
});

test("stop words, short words, and numbers alone do not qualify a hit", async () => {
  const s = setup();
  s.setHits([{ id: 71, lane: "other", title: "The and it 110" }]);
  expect(await s.writes.note(note("The and it 110"), actor())).not.toContain("Similar tasks:");
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
  s.addFails(new Error("create rejected"));
  await expect(s.writes.note(note("Not committed"), actor())).rejects.toThrow("create rejected");
  s.addFails(null);
  const draft = await s.writes.note(note("Temporary document", "exclude"), actor());
  expect(draft).toContain("excluded");
  expect(await s.writes.curate(curate(10), actor())).toContain("included");
  expect(await s.writes.note(note("Budget exhausted now"), actor())).toContain("daily lane budget");
});

test.each(["timeout", "json", "shape"] as const)("a %s after dispatch keeps the persistent lane slot", async code => {
  const s = setup();
  for (let i = 0; i < 9; i++) await s.writes.note(note(`Baseline document ${i}`), actor(`thr_base${i}`));
  s.addFails(new CortexCliError(code, "write outcome unknown"));
  await expect(s.writes.note(note("Possibly committed"), actor())).rejects.toThrow("write outcome unknown");
  s.addFails(null);
  expect(await s.restart().note(note("Next document"), actor("thr_other"))).toContain("daily lane budget");
});

test("an explicit exclusion records the author's choice with the create", async () => {
  const s = setup();
  expect(await s.writes.note(note("Excluded by choice", "exclude"), actor())).toContain("excluded");
  expect(actuallyAdded(s)[0].args).toEqual(expect.arrayContaining([
    "--memory-excluded", "--memory-exclusion-reason=Saved excluded by its author",
  ]));
});

test.each(["", ".", "!", "?"])("curation ends its reason with just one punctuation mark (%s)", async punctuation => {
  const s = setup();
  s.tasks.set(1, s.task(1));
  const { reason, ...input } = curate(1, "exclude");
  const result = await s.writes.curate({ ...input, reason: reason + punctuation }, actor());
  expect(result.split("\n")[0]).toMatch(new RegExp(`Reason: ${reason}\\${punctuation || "."}$`));
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
  expect(s.calls.filter(c => c.args[0] === "edit" && c.args[1] === "6").map(c => c.args)).toEqual([[
    "edit", "6", "--json", "--message=Verified again", `--as=bb-${THREAD}`, "--unless-status=review,done",
    "--bodySearch=isolated", "--bodyReplace=hermetic",
  ]]);
  expect(s.calls.some(c => c.args[0] === "update")).toBe(false);
  await expect(s.writes.note({ task_id: 6, search: "hermetic", summary: "Missing replacement" }, actor())).rejects.toThrow(/together/);
});

test("a create carrying revision fields is refused with the create form, before any write or budget", async () => {
  const s = setup();
  const withSummary = s.writes.note({ ...note("Taxonomy of motifs"), summary: "Saved the taxonomy" }, actor());
  await expect(withSummary).rejects.toThrow(
    "Not saved: summary is not used when creating. Without task_id, cortex_note creates a new document from title, kind and body",
  );
  const summaryForTitle = s.writes.note({ body: BODY, kind: "note", summary: "Saved the taxonomy" }, actor());
  await expect(summaryForTitle).rejects.toThrow("Not saved: title is missing; summary is not used when creating.");
  await expect(summaryForTitle).rejects.toThrow(
    /To revise an existing task instead, pass its task_id, a summary, and search with replace or a new title\. Never fall back to the shell\.$/,
  );
  const anchors = s.writes.note({ ...note("Taxonomy of motifs"), search: "a", replace: "b" }, actor());
  await expect(anchors).rejects.toThrow("Not saved: search, replace are not used when creating.");
  await expect(s.writes.note({ title: "Taxonomy of motifs", body: BODY }, actor())).rejects.toThrow("Not saved: kind is missing.");
  // No lane lookup, CLI call or reservation: the hourly check below would fail if a refusal had spent a slot.
  expect(s.calls).toEqual([]);
  expect(await s.writes.note(note("First real document"), actor())).toContain("Saved @1");
  expect(await s.writes.note(note("Second real document"), actor())).toContain("Saved @2");
});

test("a revision carrying create fields or no summary is refused with the revise form, before any edit", async () => {
  const s = setup();
  s.tasks.set(6, s.task(6));
  const withBody = s.writes.note({ task_id: 6, search: "isolated", replace: "hermetic", summary: "Checked", body: BODY, kind: "note" }, actor());
  await expect(withBody).rejects.toThrow(
    "Not saved: body, kind are not used when revising. With task_id, cortex_note revises that task",
  );
  const noSummary = s.writes.note({ task_id: 6, search: "isolated", replace: "hermetic" }, actor());
  await expect(noSummary).rejects.toThrow("Not saved: summary is missing.");
  await expect(noSummary).rejects.toThrow(
    /To create a new document instead, leave out task_id and pass title, kind and body\. Never fall back to the shell\.$/,
  );
  await expect(s.writes.note({ task_id: 6, summary: "Nothing to change" }, actor())).rejects.toThrow(
    "Not saved: provide title or search and replace.",
  );
  await expect(s.writes.note({ task_id: 6, search: "", replace: "x", summary: "Checked" }, actor())).rejects.toThrow(
    "Not saved: search: cannot be empty.",
  );
  expect(s.calls).toEqual([]);
});

test("the advertised schema says which form uses each field", () => {
  const { properties } = z.toJSONSchema(noteParameters) as { properties: Record<string, { description?: string }> };
  for (const field of ["body", "kind", "tags", "memory", "status"]) {
    expect(properties[field]?.description, field).toMatch(/^Create only/);
  }
  for (const field of ["search", "replace", "summary"]) {
    expect(properties[field]?.description, field).toMatch(/^Revise only/);
  }
  expect(properties.summary?.description).toContain("required with task_id");
  expect(properties.task_id?.description).toContain("leave out to create");
  expect(properties.title?.description).toContain("required to create");
});

test.each(["review", "done"])("a change to %s before the edit still refuses the revision", async status => {
  const s = setup();
  s.tasks.set(1, s.task(1));
  s.statusAtEdit(status);
  await expect(s.writes.note({ task_id: 1, title: "New title", summary: "Verified again" }, actor())).rejects.toThrow(
    `@1 is ${status}; post a cortex_update instead of revising it.`,
  );
  expect(s.tasks.get(1)?.title).toBe("Similar subject 1");
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
