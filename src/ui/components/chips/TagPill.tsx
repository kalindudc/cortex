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
// remain plain spans so they never introduce nested buttons. `onActivate`
// turns the label itself into a button (e.g. task tag pills that filter the
// sidebar on click) — kept a sibling of the remove button, never nested.

import type { VNode } from "preact";

import { tagColor, tagPillStyleFromHex } from "../../lib/color.ts";
import { tip } from "../../state/tooltip.ts";
import { Icon } from "../Icon.tsx";

export interface TagPillProps {
  name: string;
  color?: string | null;
  interactive?: boolean;
  // Opt-in only: pills inside picker/task-row buttons remain noninteractive.
  onActivate?: () => void;
  onRemove?: () => void;
  removeDisabled?: boolean;
}

export function TagPill({
  name,
  color,
  interactive = false,
  onActivate,
  onRemove,
  removeDisabled = false,
}: TagPillProps): VNode {
  const c = color !== undefined ? color : tagColor(name);
  const style = tagPillStyleFromHex(c);
  const cls = `tag-pill${c ? " tag-pill-colored" : ""}${interactive ? " tag-pill-interactive" : ""}${onRemove ? " tag-pill-removable" : ""}${onActivate ? " tag-pill-activatable" : ""}`;
  // The activate button owns its own tooltip, so the outer wrapper drops its
  // tip to avoid two overlapping tooltips firing on hover of the same pill.
  const outerTip = onActivate ? {} : tip(name, { placement: onRemove ? "top" : "right" });
  const label = onActivate ? (
    <button
      type="button"
      class="tag-pill-label tag-pill-filter"
      aria-label={`Filter tasks by #${name}`}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        onActivate();
      }}
      {...tip(`Filter tasks by #${name}`, { placement: "top" })}
    >
      {name}
    </button>
  ) : (
    <span class="tag-pill-label">{name}</span>
  );
  return (
    <span class={cls} style={style} {...outerTip}>
      {onRemove ? (
        <>
          {label}
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
      ) : onActivate ? (
        label
      ) : (
        name
      )}
    </span>
  );
}
