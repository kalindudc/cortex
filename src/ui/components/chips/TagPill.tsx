// TagPill — single tag rendered as a Primer-IssueLabelToken-style pill.
//
// Pill shape, per-tag background color derived from a hex via the GitHub
// luminance algorithm in styles/tag-pill.css (see .tag-pill). Inline style
// sets --label-r/g/b + --label-h/s/l from the hex; CSS derives perceived-
// lightness, text color (black/white), and border from those. When `color`
// is missing the inline style is empty and the pill falls through to the
// neutral CSS rule.
//
// `interactive` adds a hover treatment inside selectable rows. `onRemove`
// opts header pills into a named X button; ordinary picker/task-row pills
// remain plain spans so they never introduce nested buttons.

import type { VNode } from "preact";

import { tagColor, tagPillStyleFromHex } from "../../lib/color.ts";
import { tip } from "../../state/tooltip.ts";
import { Icon } from "../Icon.tsx";

export interface TagPillProps {
  name: string;
  color?: string | null;
  interactive?: boolean;
  // Opt-in only: pills inside picker/task-row buttons remain noninteractive.
  onRemove?: () => void;
  removeDisabled?: boolean;
}

export function TagPill({ name, color, interactive = false, onRemove, removeDisabled = false }: TagPillProps): VNode {
  const c = color !== undefined ? color : tagColor(name);
  const style = tagPillStyleFromHex(c);
  const cls = `tag-pill${c ? " tag-pill-colored" : ""}${interactive ? " tag-pill-interactive" : ""}${onRemove ? " tag-pill-removable" : ""}`;
  return (
    <span class={cls} style={style} {...tip(name, { placement: onRemove ? "top" : "right" })}>
      {onRemove ? (
        <>
          <span class="tag-pill-label">{name}</span>
          <button
            type="button"
            class="tag-remove"
            aria-label={`Remove tag ${name}`}
            disabled={removeDisabled}
            aria-busy={removeDisabled}
            onClick={(event: MouseEvent) => {
              event.stopPropagation();
              onRemove();
            }}
            {...tip(`Remove #${name} from this task`, { placement: "top" })}
          >
            <Icon name="x" size={10} />
          </button>
        </>
      ) : (
        name
      )}
    </span>
  );
}
