// ThemeToggle — two-state flip: light ↔ dark. Icon shows the DESTINATION (sun when in dark mode, moon when in light mode) so the affordance reads as "click to go there" — a convention shared by GitHub, VS Code, Notion, etc.
import type { VNode } from "preact";
import { theme, toggleTheme } from "../../state/theme.ts";
import { Icon } from "../Icon.tsx";

export function ThemeToggle(): VNode {
  const isDark = theme.value === "dark";
  const iconName = isDark ? "sun" : "moon";
  const next = isDark ? "light" : "dark";
  return (
    <button
      class="btn-icon"
      onClick={toggleTheme}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      <Icon name={iconName} />
    </button>
  );
}
