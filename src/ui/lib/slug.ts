// ui/lib/slug.ts — the heading anchor slug, with NO runtime imports, so the
// dashboard (MarkdownView), the terminal reader (src/tui/reader.ts) and
// cortex core (src/memory.ts section loads) share one rule (the
// refGrammar.ts precedent). A `#slug` printed by `cortex memory show`
// therefore matches the TUI's `:heading` and the web's anchors.

/** Heading anchor slug: lowercase ASCII words joined by "-", else "section". */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}
