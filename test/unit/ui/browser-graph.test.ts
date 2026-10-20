import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The renderer is bundled for the browser and must never pull in the Store,
// the native client, the user's author lookup or any node:/bun: module.
const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const ENTRY = path.join(ROOT, "src/ui/index.tsx");
const FORBIDDEN = ["src/store.ts", "src/client.ts", "src/lib/userAuthor.ts"].map(p => path.join(ROOT, p));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-graph-"));

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function graph(entry: string): Promise<{ success: boolean; files: string[]; imports: string[] }> {
  const result = await Bun.build({ entrypoints: [entry], target: "browser", metafile: true, throw: false });
  const inputs = result.metafile?.inputs ?? {};
  const files = Object.keys(inputs).map(p => path.resolve(process.cwd(), p));
  const imports = Object.values(inputs).flatMap(input => input.imports.map(i => i.path));
  return { success: result.success, files, imports };
}

describe("renderer browser graph", () => {
  test("builds and reaches the API client but no store, native client or node:/bun: module", async () => {
    const { success, files, imports } = await graph(ENTRY);
    expect(success).toBe(true);
    expect(files).toContain(path.join(ROOT, "src/api.ts"));
    // The whole dashboard is about 107 modules; far fewer means the entry stopped reaching it.
    expect(files.length).toBeGreaterThan(100);
    for (const file of FORBIDDEN) expect(files).not.toContain(file);
    expect(imports.filter(p => p.startsWith("node:") || p.startsWith("bun:"))).toEqual([]);
  });

  test("the check can fail: an entry that imports the store does not build for the browser", async () => {
    const entry = path.join(scratch, "entry.ts");
    fs.writeFileSync(
      entry,
      `import { Store } from ${JSON.stringify(path.join(ROOT, "src/store.ts"))};\nconsole.log(Store);\n`,
    );
    const { success } = await graph(entry);
    expect(success).toBe(false);
  });
});
