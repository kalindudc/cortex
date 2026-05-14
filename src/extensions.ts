/**
 * Embedded pi-extension registry — written into
 * `~/.pi/agent/extensions/<harness>/` on `cortex init` (and wiped+rewritten
 * on `cortex reset`).
 *
 * Why embedded: the cortex binary ships the pi-side glue (the
 * `cortex_update` tool) so coding agents running inside pi can post
 * cortex updates with auto-attribution to their active pi session. No
 * separate install step. Each TS file is imported with
 * `with { type: "file" }`, which `bun build --compile` rewrites to a
 * `/$bunfs/...` virtual path; we read the bytes via `Bun.file(path)`.
 *
 * Identical idiom to SKILLS in `src/skills.ts` and UI_ASSETS in
 * `src/server.ts` — same single-binary discipline.
 *
 * Idempotency: `writeExtension()` / `writeAllExtensions()` always
 * overwrite. Extensions are machine-generated; documenting that here is
 * the load-bearing convention. Hand-edits are LOST on the next
 * init/reset.
 *
 * Multi-extension registry: `EXTENSIONS` maps each extension name to its
 * file manifest. Adding a new extension = add a new entry to `EXTENSIONS`
 * + import its files; init/reset/test pick it up automatically via
 * `listExtensions()`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- pi extension (cortex_update tool) ------------------------------------
// `with { type: "file" }` is a Bun bundler directive that rewrites the
// import to a `/$bunfs/...` virtual path (a string). TypeScript still
// resolves `./extensions/pi.ts` as a module, so the default export's
// declared type is the function `(pi: ExtensionAPI) => void`. We cast to
// `string` because at runtime under Bun the value IS the embedded path,
// not the function. The runtime contract is enforced by the build script
// (`scripts/build.sh` runs `bun build --compile` which honors the import
// attribute) and by the on-disk-write tests in `test/skills.test.ts`.
import piExtImport from "./extensions/pi.ts" with { type: "file" };
const piExt = piExtImport as unknown as string;

export type ExtensionName = "pi";

// Map relative path inside the extension dir → embedded blob path. The
// relPath becomes the on-disk name under `extensionDir(name)`.
type Manifest = Record<string /*relPath*/, string /*embeddedPath*/>;

const EXTENSIONS: Record<ExtensionName, Manifest> = {
  pi: {
    "index.ts": piExt,
  },
};

// Per-extension subdirectory name under `extensionsRoot()`. We give the
// pi extension its own `cortex/` subdir so `cortex reset` can wipe it
// cleanly without touching unrelated user-installed extensions, and so
// adding a second harness later remains non-breaking.
const SUBDIR: Record<ExtensionName, string> = {
  pi: "cortex",
};

/**
 * Root install directory for ALL cortex-shipped pi extensions.
 * `CORTEX_PI_EXTENSION_DIR` env var overrides for test isolation — same
 * idiom as `CORTEX_SKILL_DIR` in `src/skills.ts` so the integration test
 * never clobbers the user's real `~/.pi/agent/extensions/` tree.
 *
 * Note: when `CORTEX_PI_EXTENSION_DIR` is set, it is used as the ROOT
 * (containing per-extension subdirs).
 */
export function extensionsRoot(): string {
  return process.env.CORTEX_PI_EXTENSION_DIR ?? path.join(os.homedir(), ".pi", "agent", "extensions");
}

/**
 * Install location for a single extension by name.
 */
export function extensionDir(name: ExtensionName): string {
  return path.join(extensionsRoot(), SUBDIR[name]);
}

/**
 * List every shipped extension name (deterministic insertion order from
 * `EXTENSIONS`).
 */
export function listExtensions(): ExtensionName[] {
  return Object.keys(EXTENSIONS) as ExtensionName[];
}

/**
 * Write every embedded file for a single extension into `targetDir`.
 * Always overwrites — extensions are machine-generated; that's the
 * contract.
 *
 * `targetDir` is overridable so tests can write into a tmp dir.
 */
export async function writeExtension(name: ExtensionName, targetDir: string = extensionDir(name)): Promise<void> {
  const manifest = EXTENSIONS[name];
  if (!manifest) throw new Error(`unknown extension: ${name}`);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [rel, embedPath] of Object.entries(manifest)) {
    const target = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = await Bun.file(embedPath).bytes();
    fs.writeFileSync(target, bytes);
  }
}

/**
 * Write all shipped extensions under their default `extensionDir()`
 * locations. Called by `cortex init` and `cortex reset`.
 */
export async function writeAllExtensions(): Promise<void> {
  for (const name of listExtensions()) {
    await writeExtension(name);
  }
}
