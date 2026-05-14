// Shared system-control strip rendered at the top of EVERY sidebar pane so
// the toolbar reads identically whether you are in lanes mode or tags mode.
// Order: home (back to lanes) | tag-mode | theme. The home button is hidden
// in lanes mode — it would be a no-op since we're already home — and the
// tag-mode button is hidden in tags mode for the same reason. This keeps the
// strip from advertising affordances that do nothing.
import type { VNode } from "preact";
import { sidebarView, selectedTag } from "../../state/signals.ts";
import { Icon } from "../Icon.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

export function SidebarSystemBar(): VNode {
  const inTags = sidebarView.value === "tags";
  return (
    <div class="pane-system">
      {inTags ? (
        <button
          class="btn-icon"
          title="Home (back to lanes)"
          aria-label="Home"
          onClick={() => {
            sidebarView.value = "lanes";
            selectedTag.value = null;
          }}
        >
          <Icon name="home" />
        </button>
      ) : (
        <button
          class="btn-icon"
          title="Manage tags"
          aria-label="Manage tags"
          onClick={() => {
            sidebarView.value = "tags";
          }}
        >
          <Icon name="hash" />
        </button>
      )}
      <ThemeToggle />
    </div>
  );
}
