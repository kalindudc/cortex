// copy-mermaid.ts — copy the mermaid runtime the renderer imports lazily into out/ui/mermaid.
//
// Run: `pnpm exec bun scripts/copy-mermaid.ts` (a step of `pnpm run ui:build`).
// src/ui/lib/markdown.ts imports only `/mermaid/mermaid.esm.min.mjs`, whose
// chunks all live in `chunks/mermaid.esm.min/`, so that entry and those chunks
// are the whole runtime; source maps are left out.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const ENTRY = "mermaid.esm.min.mjs";
const CHUNKS = path.join("chunks", "mermaid.esm.min");
const OUT = path.join(ROOT, "out", "ui", "mermaid");

function fail(message: string): never {
  console.error(`copy-mermaid: ${message}`);
  process.exit(1);
}

const dist = fs.realpathSync(path.join(ROOT, "node_modules", "mermaid", "dist"));
if (!fs.existsSync(path.join(dist, ENTRY))) fail(`missing ${path.join(dist, ENTRY)}`);
if (!fs.statSync(path.join(dist, CHUNKS), { throwIfNoEntry: false })?.isDirectory()) {
  fail(`missing directory ${path.join(dist, CHUNKS)}`);
}

const files = [
  ENTRY,
  ...fs
    .readdirSync(path.join(dist, CHUNKS))
    .filter(name => name.endsWith(".mjs"))
    .map(name => path.join(CHUNKS, name)),
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, CHUNKS), { recursive: true });
for (const file of files) fs.copyFileSync(path.join(dist, file), path.join(OUT, file));
console.log(`Copied ${files.length} mermaid files to ${path.relative(ROOT, OUT)}`);
