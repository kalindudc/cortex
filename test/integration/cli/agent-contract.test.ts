import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { runCli, mkTmpEnv } from "../helpers.ts";

// End-to-end coverage of the agent-first CLI contract (Plan 357): --json on
// mutating commands, machine-readable error codes, --body-file - stdin,
// one-shot --as attribution, token-efficient `ls --json`, non-interactive
// `rm`, and the schema/doctor orientation commands. Hermetic via mkTmpEnv.

describe("cortex agent JSON contract", () => {
  let env: Record<string, string>;
  let cleanup: () => void;

  beforeAll(async () => {
    const e = mkTmpEnv("agent-contract");
    env = e.env;
    cleanup = e.cleanup;
    const r = await runCli({ args: ["init"], env });
    expect(r.code).toBe(0);
  });

  afterAll(() => cleanup());

  const cli = (...args: string[]) => runCli({ args, env });
  const cliIn = (stdin: string, ...args: string[]) => runCli({ args, env, stdin });

  test("add --json returns the full task object", async () => {
    const r = await cli("add", "json task", "-t", "plan,demo", "--json");
    expect(r.code).toBe(0);
    const t = JSON.parse(r.stdout);
    expect(t.id).toBeGreaterThan(0);
    expect(t.title).toBe("json task");
    expect(t.status).toBe("open");
    expect(t.tags).toEqual(["demo", "plan"]);
    expect(typeof t.created).toBe("number");
  });

  test("add --as records the first 'created' update", async () => {
    const t = JSON.parse((await cli("add", "attributed", "--as", "impl-abcd1234", "--json")).stdout);
    const s = await cli("show", String(t.id), "--json");
    const updates = JSON.parse(s.stdout).updates as { author: string; summary: string }[];
    expect(updates.some(u => u.author === "impl-abcd1234" && u.summary === "created")).toBe(true);
  });

  test("add --body-file - reads the body from stdin", async () => {
    const r = await cliIn("PIPED BODY\n", "add", "stdin body", "--body-file", "-", "--json");
    expect(r.code).toBe(0);
    const t = JSON.parse(r.stdout);
    const s = await cli("show", String(t.id), "--json");
    expect(JSON.parse(s.stdout).task.body).toBe("PIPED BODY\n");
  });

  test("ls --json omits body by default; --full includes it", async () => {
    await cli("add", "with body", "-b", "SECRET BODY");
    const rows = JSON.parse((await cli("ls", "--json")).stdout) as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Object.hasOwn(row, "body")).toBe(false);
    const full = JSON.parse((await cli("ls", "--json", "--full")).stdout) as Record<string, unknown>[];
    expect(full.every(row => Object.hasOwn(row, "body"))).toBe(true);
  });

  test("update --json returns { update, status }", async () => {
    const a = JSON.parse((await cli("add", "to update", "--json")).stdout);
    const r = await cli("update", String(a.id), "-m", "progressing", "-s", "review", "--as", "impl-abcd1234", "--json");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.update.summary).toBe("progressing");
    expect(out.status).toBe("review");
  });

  test("edit ambiguous anchor --json → body_search_ambiguous with matches", async () => {
    const a = JSON.parse((await cliIn("dup\ndup\n", "add", "amb", "--body-file", "-", "--json")).stdout);
    const r = await cli("edit", String(a.id), "--body-search", "dup", "--body-replace", "x", "--json");
    expect(r.code).toBe(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.error.code).toBe("body_search_ambiguous");
    expect(envelope.error.matches).toBe(2);
  });

  test("edit missing task --json → not_found with actionable hint", async () => {
    const r = await cli("edit", "99999", "-t", "renamed", "--json");
    expect(r.code).toBe(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.error.code).toBe("not_found");
    expect(envelope.error.message).toContain("cortex ls");
  });

  test("rm --json without --force refuses to prompt (exit 1, no hang) and preserves the task", async () => {
    const a = JSON.parse((await cli("add", "keep me", "--json")).stdout);
    const r = await cli("rm", String(a.id), "--json"); // no stdin, no --force
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.message).toContain("--force");
    const s = await cli("show", String(a.id), "--json");
    expect(s.code).toBe(0);
  });

  test("rm --force --json returns { ok, id }", async () => {
    const a = JSON.parse((await cli("add", "delete me", "--json")).stdout);
    const r = await cli("rm", String(a.id), "--force", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, id: a.id });
  });

  test("schema --json describes tables, error codes, and commands", async () => {
    const r = await cli("schema", "--json");
    expect(r.code).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(Object.keys(s.tables)).toContain("tasks");
    expect(s.output.errorCodes).toContain("body_search_ambiguous");
    expect((s.commands as { name: string }[]).some(c => c.name === "add")).toBe(true);
  });

  test("doctor --json reports counts, migrations, and daemon state", async () => {
    const r = await cli("doctor", "--json");
    expect(r.code).toBe(0);
    const d = JSON.parse(r.stdout);
    expect(d.daemon.running).toBe(false);
    expect(typeof d.counts.tasks).toBe("number");
    expect(Array.isArray(d.pendingMigrations)).toBe(true);
  });

  test("non-json add still prints the exact human line (back-compat)", async () => {
    const r = await cli("add", "human line");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^\[\d+\] human line\n?$/);
  });
});
