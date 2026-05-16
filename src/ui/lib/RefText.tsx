// ui/lib/RefText.tsx — Plain-text renderer for `@[id]` / `#[tag]` refs.
//
// Used by update bubbles (and any other plain-text surface that wants
// linkified refs without a markdown pipeline). NEVER use
// dangerouslySetInnerHTML — Preact escapes string children automatically
// so emitting nested elements alongside string segments is safe by
// construction.
//
// Anchors carry a real fragment `href` (e.g. `#task-12`, `#tag-ops`) so
// biome's `useValidAnchor` passes — `href="#"` would not. The click
// handler always `preventDefault`s, so the URL never actually changes;
// the fragment is purely a stable selector for tooling. `stopPropagation`
// keeps the surrounding row's onClick (e.g. open-update-detail in
// InboxPane) from also firing.
//
// Visible labels match the source verbatim (`@123`, `#tag`) since the
// bracketless grammar already produces a readable string.

import type { VNode } from "preact";
import { navigateRef, parseRefs } from "./refs.ts";

/**
 * Render `text` with each `@[id]` rendered as `@id` and each `#[tag]` as
 * `#tag`, both as clickable anchors that drive navigation through
 * `navigateRef`. The visible label drops the brackets — the source stays
 * in the underlying string (and in any editor view).
 */
export function RefText({ text }: { text: string }): VNode {
  const segments = parseRefs(text);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "text") return seg.text;
        if (seg.kind === "task") {
          const id = seg.id;
          return (
            <a
              key={`${i}-task-${id}`}
              href={`#task-${id}`}
              class="cortex-ref cortex-ref-task"
              onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                navigateRef("task", String(id));
              }}
            >
              {`@${id}`}
            </a>
          );
        }
        const name = seg.name;
        return (
          <a
            key={`${i}-tag-${name}`}
            href={`#tag-${name}`}
            class="cortex-ref cortex-ref-tag"
            onClick={e => {
              e.preventDefault();
              e.stopPropagation();
              navigateRef("tag", name);
            }}
          >
            {`#${name}`}
          </a>
        );
      })}
    </>
  );
}
