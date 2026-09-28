// src/ui/api/client.ts — the dashboard's typed client (plan @400 N11): a
// thin browser adapter over the environment-neutral createApi (src/api.ts)
// with relative same-origin fetch.
//
// Two guarantees are certified here:
//   1. The browser bundle graph never reaches daemon-only code: bundling
//      src/ui/index.tsx exactly as `ui:build` does (target browser) must
//      never pull in src/client.ts, src/store.ts or any other native src/
//      module, node:* / bun:* builtins, or the Bun global.
//   2. The adapter keeps the names current UI callers import while sending
//      relative, typed requests through createApi.
//
// Other unit files mock "src/ui/api/client.ts" process-wide, so the real
// adapter is imported through a cache-busting query suffix.

import { afterEach, describe, expect, expectTypeOf, test } from "bun:test";
import { builtinModules } from "node:module";
import path from "node:path";
import { HttpError } from "../../../src/api.ts";
import type {
  ApiClient as ContractApiClient,
  BackupResult,
  CortexClient,
  CreateLaneRequest,
  CreateTagRequest,
  CreateTaskRequest,
  EditLaneRequest,
  EditTagRequest,
  EditTaskRequest,
  PostUpdateRequest,
  TagWithCount as ContractTagWithCount,
} from "../../../src/contracts.ts";
import type {
  AddLaneBody,
  AddTagBody,
  AddTaskBody,
  ApiClient,
  BackupResponse,
  EditLaneBody,
  EditTagBody,
  EditTaskBody,
  PostUpdateBody,
  TagWithCount,
} from "../../../src/ui/api/client.ts";
import type { Update } from "../../../src/ui/api/types.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const UI_ENTRY = path.join(REPO_ROOT, "src", "ui", "index.tsx");

// ---------- 1. browser bundle graph ----------

/** Shared modules outside src/ui/ that are environment-neutral by contract (no node/Bun/DOM/state imports). */
const ENV_NEUTRAL_SHARED = new Set(["src/api.ts", "src/contracts.ts", "src/events.ts"]);
const BUILTINS = new Set(builtinModules);

interface BrowserGraph {
  success: boolean;
  logs: string[];
  /** Repo-relative paths of every bundled source file. */
  inputs: string[];
  /** `<importer> -> <specifier>` for every import of a node/Bun builtin. */
  builtinImports: string[];
  /** The bundled JavaScript, for global-object checks the import graph cannot see. */
  output: string;
}

async function bundleForBrowser(entry: string, files?: Record<string, string>): Promise<BrowserGraph> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    metafile: true,
    throw: false,
    ...(files ? { files } : {}),
  });
  const logs = result.logs.map(String);
  if (!result.success || !result.metafile) return { success: false, logs, inputs: [], builtinImports: [], output: "" };
  const relative = (p: string): string => path.relative(REPO_ROOT, path.resolve(process.cwd(), p));
  const builtinImports: string[] = [];
  for (const [file, info] of Object.entries(result.metafile.inputs)) {
    for (const imported of info.imports) {
      const spec = imported.path;
      if (/^(node|bun):/.test(spec) || spec === "bun" || BUILTINS.has(spec)) {
        builtinImports.push(`${relative(file)} -> ${spec}`);
      }
    }
  }
  const output = (await Promise.all(result.outputs.map(o => o.text()))).join("\n");
  return { success: true, logs, inputs: Object.keys(result.metafile.inputs).map(relative), builtinImports, output };
}

/** Every way a bundle graph breaks the N11 browser boundary; empty means clean. */
function boundaryViolations(graph: BrowserGraph): string[] {
  if (!graph.success) return [`browser build failed: ${graph.logs.join("; ")}`];
  const problems: string[] = [];
  for (const input of graph.inputs) {
    if (input.startsWith("src/") && !input.startsWith("src/ui/") && !ENV_NEUTRAL_SHARED.has(input)) {
      problems.push(`daemon-only module in the browser bundle: ${input}`);
    }
  }
  for (const edge of graph.builtinImports) problems.push(`builtin import in the browser bundle: ${edge}`);
  if (/\bBun\.[A-Za-z_$]/.test(graph.output)) problems.push("the browser bundle references the Bun global");
  return problems;
}

describe("browser bundle graph (N11): the dashboard never imports native code", () => {
  test("src/ui/index.tsx reaches the daemon only through the environment-neutral createApi", async () => {
    const graph = await bundleForBrowser(UI_ENTRY);
    expect(boundaryViolations(graph)).toEqual([]);
    // Positive controls: the check really sees the adapter and its shared core...
    expect(graph.inputs).toContain("src/ui/api/client.ts");
    expect(graph.inputs).toContain("src/api.ts");
    // ...and the native client / Store stay out.
    expect(graph.inputs).not.toContain("src/client.ts");
    expect(graph.inputs).not.toContain("src/store.ts");
  });

  test("the guard is not vacuous: native imports are reported", async () => {
    // Virtual entries under src/ui/ (in-memory only; nothing is written).
    const probe = path.join(REPO_ROOT, "src", "ui", "__boundary_probe__.ts");
    const native = await bundleForBrowser(probe, {
      [probe]: 'import { createClient } from "../client.ts";\nconsole.log(createClient);\n',
    });
    expect(boundaryViolations(native).length).toBeGreaterThan(0);
    // A daemon-only module that DOES bundle for the browser is still caught by path.
    const bundles = await bundleForBrowser(probe, {
      [probe]: 'import { subscribeChanges } from "../subscription.ts";\nconsole.log(subscribeChanges);\n',
    });
    expect(boundaryViolations(bundles)).toContain("daemon-only module in the browser bundle: src/subscription.ts");
    const bunGlobal = await bundleForBrowser(probe, { [probe]: "console.log(Bun.version);\n" });
    expect(boundaryViolations(bunGlobal)).toContain("the browser bundle references the Bun global");
  });
});

// ---------- 2. the adapter ----------

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

// @ts-expect-error — cache-bust query suffix has no .d.ts; runtime-only.
const adapter = (await import("../../../src/ui/api/client.ts?b=ui-api-client-test")) as { api: CortexClient };
const { api } = adapter;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace fetch with a recorder answering every request with `respond()`. */
function recordFetch(respond: () => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  const fake = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return respond();
  };
  globalThis.fetch = fake as unknown as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("src/ui/api/client.ts adapter", () => {
  test("reads, including the new snapshots, use relative same-origin paths", async () => {
    const calls = recordFetch(() => json([]));
    await api.tasks();
    await api.workspace();
    await api.taskState(7);
    await api.notifications();
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      "GET /api/tasks",
      "GET /api/workspace",
      "GET /api/tasks/7/state",
      "GET /api/notifications",
    ]);
  });

  test("legacy writes keep their JSON bodies and legacy results", async () => {
    const update: Update = {
      id: 9,
      task_id: 3,
      author: "me",
      summary: "hi",
      body: null,
      severity: "progress",
      created: 1,
    };
    const calls = recordFetch(() => json(update));
    const created = await api.postUpd(3, { author: "me", summary: "hi" });
    expect(created).toEqual(update);
    expect(calls).toEqual([
      {
        url: "/api/tasks/3/updates",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { author: "me", summary: "hi" },
      },
    ]);
    await api.delTag("x", true);
    expect(calls[1]).toMatchObject({ url: "/api/tags/x?force=1", method: "DELETE" });
  });

  test("versioned writes opt in with Prefer and carry the guard", async () => {
    const result = { task: { id: 3 }, versions: { title: "t2" }, replayed: false };
    const calls = recordFetch(() => json(result, 200, { "preference-applied": "cortex-versioned" }));
    expect(await api.versioned.editTask(3, { title: "x" }, { expected: { title: "t1" } })).toEqual(result as never);
    expect(calls[0]).toMatchObject({
      url: "/api/tasks/3",
      method: "PATCH",
      headers: { prefer: "cortex-versioned" },
      body: { title: "x", guard: { expected: { title: "t1" } } },
    });
  });

  test("errors are typed HttpErrors that keep the server message the UI toasts", async () => {
    recordFetch(() => json({ error: "task 404 not found" }, 404));
    const failure = await api.editTask(404, { title: "x" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as HttpError).status).toBe(404);
    expect((failure as HttpError).message).toBe("task 404 not found");
  });

  test("the old exported names still resolve (aliases of the corrected contracts)", () => {
    expectTypeOf(api).toMatchTypeOf<ApiClient>();
    expectTypeOf<ApiClient>().toEqualTypeOf<ContractApiClient>();
    expectTypeOf<TagWithCount>().toEqualTypeOf<ContractTagWithCount>();
    expectTypeOf<BackupResponse>().toEqualTypeOf<BackupResult>();
    expectTypeOf<AddTaskBody>().toEqualTypeOf<CreateTaskRequest>();
    expectTypeOf<EditTaskBody>().toEqualTypeOf<EditTaskRequest>();
    expectTypeOf<AddLaneBody>().toEqualTypeOf<CreateLaneRequest>();
    expectTypeOf<EditLaneBody>().toEqualTypeOf<EditLaneRequest>();
    expectTypeOf<AddTagBody>().toEqualTypeOf<CreateTagRequest>();
    expectTypeOf<EditTagBody>().toEqualTypeOf<EditTagRequest>();
    expectTypeOf<PostUpdateBody>().toEqualTypeOf<PostUpdateRequest>();
  });
});
