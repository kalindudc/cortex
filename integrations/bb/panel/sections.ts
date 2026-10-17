// A task body as the Overview shows it: split at `## ` headings, each section
// folded to one line when the body is long. Pure, so it is tested in Node.

export type BodySection = {
  /** null for the text before the first `## ` heading, which shows open without a header. */
  heading: string | null;
  markdown: string;
  /** One line of plain text for a folded section. */
  preview: string;
  /** Top-level list items in the section. */
  items: number;
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;
/** A body this short, or with this few sections, shows fully open. */
export const FOLD_MIN_CHARS = 2_500;
export const FOLD_MIN_SECTIONS = 2;

/** Each line with whether it sits inside a fenced code block (fence lines count as inside). */
function withFences(lines: readonly string[]): Array<{ line: string; fenced: boolean }> {
  let fence: string | null = null;
  return lines.map(line => {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      const char = marker.charAt(0);
      if (fence === null) fence = char;
      else if (char === fence) fence = null;
      return { line, fenced: true };
    }
    return { line, fenced: fence !== null };
  });
}

/** Markdown reduced to one readable line: no list markers, emphasis, code ticks or link targets. */
export function plainLine(markdown: string): string {
  for (const { line, fenced } of withFences(markdown.split("\n"))) {
    if (fenced) continue;
    const text = line
      .replace(/^\s*(?:#{1,6}\s+|>\s?|(?:[-*+]|\d+[.)])\s+)/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

function countItems(markdown: string): number {
  return withFences(markdown.split("\n")).filter(({ line, fenced }) => !fenced && LIST_ITEM.test(line)).length;
}

function section(heading: string | null, lines: string[]): BodySection {
  const markdown = lines.join("\n").trim();
  return { heading, markdown, preview: plainLine(markdown), items: countItems(markdown) };
}

/**
 * The body's sections. `## ` lines inside fenced code (a plan's UPDATE
 * blocks) are not headings, and a leading `# ` title is dropped because the
 * header already shows the task's title.
 */
export function splitSections(body: string): BodySection[] {
  const lines = withFences(body.replace(/\r\n/g, "\n").split("\n"));
  const first = lines.findIndex(({ line }) => line.trim() !== "");
  if (first !== -1 && !lines[first]?.fenced && /^#\s/.test(lines[first]?.line ?? "")) lines.splice(first, 1);
  const sections: BodySection[] = [];
  let heading: string | null = null;
  let current: string[] = [];
  const flush = (): void => {
    const next = section(heading, current);
    if (next.heading !== null || next.markdown !== "") sections.push(next);
  };
  for (const { line, fenced } of lines) {
    if (!fenced && line.startsWith("## ")) {
      flush();
      heading = line.slice(3).replace(/\s+#+\s*$/, "").trim();
      current = [];
    } else {
      current.push(line);
    }
  }
  flush();
  return sections;
}

/** Which sections start open: all of a short body, else the leading text and the first headed section. */
export function initiallyOpen(sections: readonly BodySection[], bodyLength: number): boolean[] {
  const headed = sections.filter(s => s.heading !== null).length;
  if (headed <= FOLD_MIN_SECTIONS || bodyLength <= FOLD_MIN_CHARS) return sections.map(() => true);
  const firstHeaded = sections.findIndex(s => s.heading !== null);
  return sections.map((s, i) => s.heading === null || i === firstHeaded);
}
