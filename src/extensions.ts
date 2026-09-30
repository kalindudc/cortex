/**
 * Embedded pi-extension registry — written into
 * `<pi agent dir>/extensions/<harness>/` by `cortex agents install` (and
 * wiped+rewritten by `cortex agents reset`).
 *
 * Why embedded: the cortex binary ships the pi-side glue (the
 * `cortex_update` tool) so coding agents running inside pi can post
 * cortex updates with auto-attribution to their active pi session. No
 * separate install step. Each TS file is imported with
 * `with { type: "file" }`, which `bun build --compile` rewrites to a
 * `/$bunfs/...` virtual path; we read the bytes via `Bun.file(path)`.
 *
 * Identical idiom to SKILLS in `src/skills.ts` — same single-binary discipline.
 *
 * Idempotency: `writeExtension()` / `writeAllExtensions()` always
 * overwrite. Extensions are machine-generated; documenting that here is
 * the load-bearing convention. Hand-edits are LOST on the next
 * `cortex agents install|reset`.
 *
 * Multi-extension registry: `EXTENSIONS` maps each extension name to its
 * file manifest. Adding a new extension = add a new entry to `EXTENSIONS`
 * + import its files; `cortex agents` and the tests pick it up automatically
 * via `listExtensions()`.
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
// attribute) and by the on-disk-write tests in `test/unit/extensions.test.ts`.
import piExtImport from "./extensions/pi.ts" with { type: "file" };
const piExt = piExtImport as unknown as string;
// The memory status + `/memory` panel view, installed beside index.ts under
// its own name (index.ts imports `./memory-view.ts`, which also resolves in
// this repo). Same cast as piExt; it is type-checked (no @ts-nocheck) and has
// only named exports, so tsc needs telling that the file loader supplies the
// default (the path).
// @ts-expect-error TS1192: the `file` import attribute yields a default path export
import piMemoryViewImport from "./extensions/memory-view.ts" with { type: "file" };
const piMemoryView = piMemoryViewImport as unknown as string;

export type ExtensionName = "pi";

// Map relative path inside the extension dir → embedded blob path. The
// relPath becomes the on-disk name under `extensionDir(name)`.
type Manifest = Record<string /*relPath*/, string /*embeddedPath*/>;

const EXTENSIONS: Record<ExtensionName, Manifest> = {
  pi: {
    "index.ts": piExt,
    "memory-view.ts": piMemoryView,
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
 * pi's agent dir, mirroring pi's own `getAgentDir()` (config.ts:528-534):
 * `PI_CODING_AGENT_DIR` (a leading `~` expanded to home) else
 * `<home>/.pi/agent`. pi loads global extensions from `<agentDir>/extensions`.
 */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = env.PI_CODING_AGENT_DIR;
  if (override) {
    if (override === "~") return home;
    if (override.startsWith("~/")) return path.join(home, override.slice(2));
    return override;
  }
  return path.join(home, ".pi", "agent");
}

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
  return process.env.CORTEX_PI_EXTENSION_DIR ?? path.join(piAgentDir(), "extensions");
}

/**
 * Install location for a single extension by name.
 */
export function extensionDir(name: ExtensionName): string {
  return path.join(extensionsRoot(), SUBDIR[name]);
}

/** Whether this machine runs pi: an explicit CORTEX_PI_EXTENSION_DIR target, `pi` on PATH, or pi's agent dir. */
export function piDetected(
  opts: { env?: NodeJS.ProcessEnv; which?: (cmd: string) => string | null; home?: string } = {},
): boolean {
  const env = opts.env ?? process.env;
  if (env.CORTEX_PI_EXTENSION_DIR) return true;
  const which = opts.which ?? ((cmd: string) => Bun.which(cmd));
  if (which("pi") !== null) return true;
  return fs.existsSync(piAgentDir(env, opts.home ?? os.homedir()));
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
 * locations. Called by `cortex agents install|reset`.
 */
export async function writeAllExtensions(): Promise<void> {
  for (const name of listExtensions()) {
    await writeExtension(name);
  }
}
