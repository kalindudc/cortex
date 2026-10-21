import fs from "node:fs";
import path from "node:path";

/**
 * The bb plugin's source, read from `integrations/bb/` and inlined into the
 * binary. Imported `with { type: "macro" }` (src/bbPlugin.ts), so Bun runs
 * this at bundle time (`bun build --compile`) and in its runtime transpiler
 * (`bun test`, `bun run`); the plugin's own `.ts`/`.tsx` files are read as
 * text, never imported, so the root tsc program never type-checks them.
 *
 * Embedded: everything the plugin's build reads, plus the bundled skills
 * (src/skills/) under skills/, which bb gives to Claude Code threads. Left
 * out: installed or built output, dotfiles, and test-only files.
 */
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const SKIP_FILES = new Set(["fake-cortex.ts", "vitest.config.ts"]);
const TEST_FILE = /\.test\.tsx?$/;

export function embeddedBbPlugin(): Record<string, string> {
  const root = path.join(import.meta.dir, "..", "integrations", "bb");
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, `${prefix}${entry.name}/`);
      } else if (entry.isFile() && !SKIP_FILES.has(entry.name) && !TEST_FILE.test(entry.name)) {
        files[`${prefix}${entry.name}`] = fs.readFileSync(full, "utf8");
      }
    }
  };
  walk(root, "");
  walk(path.join(import.meta.dir, "skills"), "skills/");
  if (!files["package.json"] || !files["package-lock.json"]) {
    throw new Error(`the bb plugin source is incomplete: ${root} has no package.json or package-lock.json`);
  }
  return files;
}
