import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/store.ts";
import { buildApp, createRuntime } from "../../src/server.ts";
import { createApi, HttpError } from "../../src/api.ts";
import { createBackup, exportData, restoreBackup, readBackup, projectRestore } from "../../src/backup.ts";
import type { Knowledge, Workstream, WorkstreamMutation } from "../../src/workstreams.ts";
const stores: Store[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
function open(file = ":memory:") {
  const s = Store.open(file, { warnMigrations: false });
  stores.push(s);
  return s;
}
const actor = { id: "human", type: "human" as const };
const create: WorkstreamMutation = { op: "create", actor, name: "Core" };

test("typed API uses isolated handlers; event observes committed data, no-save/refusal emits nothing", async () => {
  const s = open();
  const runtime = createRuntime();
  const app = buildApp(s, runtime);
  const api = createApi(async (p, init) => app.fetch(new Request(`http://localhost${p}`, init)));
  const events: unknown[] = [];
  runtime.events.subscribe(e => {
    expect(s.listWorkstreams().total).toBe(1);
    events.push(e);
  });
  const w = (await api.workstreams.mutate(create)).workstream as Workstream;
  expect((await api.workstreams.list()).workstreams[0]?.id).toBe(w.id);
  expect((await api.workstreams.show(w.id)).entries).toEqual([]);
  expect((await api.workstreams.read(w.id)).entries).toEqual([]);
  expect((await api.workstreams.history(w.id)).total).toBe(1);
  expect(events).toHaveLength(1);
  await api.workstreams.mutate({
    op: "edit-workstream",
    actor,
    id: w.id,
    expectedRevision: 1,
    name: "New",
    reason: "Rename",
  });
  await expect(
    api.workstreams.mutate({
      op: "edit-workstream",
      actor,
      id: w.id,
      expectedRevision: 1,
      name: "Stale",
      reason: "Rename",
    }),
  ).rejects.toBeInstanceOf(HttpError);
  expect(events).toHaveLength(2);
  expect((await api.workstreams.show(w.id)).workstream.name).toBe("New");
});

test("malformed bodies, extra fields and invalid pagination refuse without writes", async () => {
  const app = buildApp(open());
  for (const body of [
    "oops",
    "[]",
    JSON.stringify({ ...create, approval: true }),
    JSON.stringify({ ...create, actor: { id: "", type: "human" } }),
  ]) {
    expect(
      (
        await app.fetch(
          new Request("http://localhost/api/workstreams/mutate", {
            method: "POST",
            body,
            headers: { "content-type": "application/json" },
          }),
        )
      ).status,
    ).toBe(400);
  }
  for (const q of ["limit=0", "offset=-1", "limit=201", "archived=garbage", "limit=1.2", "limit=oops"])
    expect((await app.fetch(new Request(`http://localhost/api/workstreams?${q}`))).status).toBe(400);
});

test("explicit entry API reads current approved revision, then forgotten redaction, never oldest history", async () => {
  const s = open();
  const app = buildApp(s);
  const api = createApi(async (p, init) => app.fetch(new Request(`http://localhost${p}`, init)));
  const w = (await api.workstreams.mutate(create)).workstream as Workstream;
  const proposed = (
    await api.workstreams.mutate({
      op: "propose",
      actor,
      workstreamId: w.id,
      subject: "current",
      title: "Current",
      text: "Claim to forget",
      kind: "directive",
      facet: "orientation",
      applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } },
      sources: [],
    })
  ).entry as Knowledge;
  await api.workstreams.mutate({
    op: "transition",
    actor,
    id: proposed.id,
    expectedRevision: 1,
    state: "approved",
    reason: "Review",
  });
  expect(await api.workstreams.entry(proposed.id)).toMatchObject({
    revision: 2,
    state: "approved",
    text: "Claim to forget",
  });
  expect((await api.workstreams.history(proposed.id)).revisions[0]?.snapshot).toMatchObject({
    revision: 1,
    state: "candidate",
  });
  await api.workstreams.mutate({
    op: "transition",
    actor,
    id: proposed.id,
    expectedRevision: 2,
    state: "forgotten",
    reason: "Forget",
  });
  expect(await api.workstreams.entry(proposed.id)).toMatchObject({
    revision: 3,
    state: "forgotten",
    text: "",
    sources: [],
  });
  await expect(api.workstreams.entry("missing")).rejects.toBeInstanceOf(HttpError);
});

test("human review query is bounded, excludes archived workstreams, filters plain text and states", async () => {
  const s = open();
  const app = buildApp(s);
  const api = createApi(async (p, init) => app.fetch(new Request(`http://localhost${p}`, init)));
  const w = (await api.workstreams.mutate(create)).workstream as Workstream;
  const proposal = {
    op: "propose",
    actor,
    workstreamId: w.id,
    subject: "s",
    title: "Specific finding",
    text: "Durable",
    kind: "finding",
    facet: "orientation",
    applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } },
    sources: [],
  } satisfies WorkstreamMutation;
  await api.workstreams.mutate(proposal);
  expect((await api.workstreams.knowledge({ reviewOnly: true, query: "SPECIFIC", limit: 1 })).total).toBe(1);
  expect((await api.workstreams.knowledge({ states: ["approved"] })).total).toBe(0);
  await api.workstreams.mutate({
    op: "edit-workstream",
    actor,
    id: w.id,
    expectedRevision: 1,
    archived: true,
    reason: "Archive",
  });
  expect((await api.workstreams.knowledge()).total).toBe(0);
  expect((await api.workstreams.knowledge({ workstream: w.id })).items[0]?.workstream.archived).toBe(true);
  expect((await app.fetch(new Request("http://localhost/api/workstream-knowledge?states=bogus"))).status).toBe(400);
});

test("backup restores all canonical rows/history; changed ID collision refuses atomically", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-workstream-backup-"));
  roots.push(dir);
  const s = open(path.join(dir, "source.db"));
  const w = s.mutateWorkstream(create).workstream as Workstream;
  const entry = s.mutateWorkstream({
    op: "propose",
    actor,
    workstreamId: w.id,
    subject: "s",
    title: "Title",
    text: "Durable",
    kind: "finding",
    facet: "orientation",
    applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } },
    sources: [],
  }).entry as Knowledge;
  const archive = path.join(dir, "archive.zip");
  await createBackup({ liveDbPath: path.join(dir, "source.db"), outPath: archive });
  const exported = await exportData(path.join(dir, "source.db"));
  expect(exported.workstreams).toHaveLength(1);
  expect(exported.knowledge).toHaveLength(1);
  expect(exported.workstream_revisions).toHaveLength(2);
  const dest = open(path.join(dir, "dest.db"));
  expect(projectRestore(readBackup(archive), dest).would.workstreams).toBe(1);
  await restoreBackup({ backupPath: archive, liveStore: dest });
  expect(dest.showWorkstream(w.id).entries[0]).toEqual(entry);
  expect(dest.workstreamHistory(entry.id).total).toBe(1);
  await restoreBackup({ backupPath: archive, liveStore: dest });
  expect(dest.workstreamHistory(entry.id).total).toBe(1);
  dest.mutateWorkstream({
    op: "edit",
    actor,
    id: entry.id,
    expectedRevision: 1,
    text: "New durable",
    reason: "Change",
  });
  await expect(restoreBackup({ backupPath: archive, liveStore: dest })).rejects.toThrow("canonical");
  expect(dest.showWorkstream(w.id).entries[0]?.text).toBe("New durable");
});
