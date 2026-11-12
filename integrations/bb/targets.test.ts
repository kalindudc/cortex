import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Touch-size targets (44 px) and 16 px inputs follow the viewport width and
// the pointer, never a container width. The sidebar, the side tabs and the
// entry pane are narrow on every screen, so a container query made every
// desktop row touch-sized and wasted half the sidebar.
const root = new URL(".", import.meta.url).pathname;

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, pattern);
    return pattern.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function containerBlocks(css: string): string[] {
  const blocks: string[] = [];
  for (const match of css.matchAll(/@container[^{]*\{/g)) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    blocks.push(css.slice(match.index, i));
  }
  return blocks;
}

describe("touch targets", () => {
  test("no container query sets a touch-size target or input size", () => {
    const offenders: string[] = [];
    for (const file of files(join(root, "ui"), /\.css$/)) {
      for (const block of containerBlocks(readFileSync(file, "utf8"))) {
        if (/min-(?:height|width):\s*44px|font-size:\s*16px/.test(block)) offenders.push(`${file.slice(root.length)}: ${block.split("\n")[0]}`);
      }
    }
    for (const file of ["ui", "panel", "components"].flatMap(dir => files(join(root, dir), /\.tsx?$/))) {
      for (const match of readFileSync(file, "utf8").matchAll(/@max-\[\d+px\](?:\/[\w-]+)?:(?:\[[^\]]*\]:)?(?:min-h-11|min-w-11|size-11|h-11|text-base|text-\[16px\])/g)) {
        offenders.push(`${file.slice(root.length)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
