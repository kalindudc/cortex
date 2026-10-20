import { useState } from "react";
import { type PluginThreadHeaderActionProps, useBbNavigate, useSettings } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useFooterPresent } from "./footer";
import { useThreadState } from "./hooks";
import { openCortexTab } from "./selection";
import { StatusDot } from "./status";

/**
 * The header task chip, unless the taskChip setting hides it or the viewport is
 * compact: a phone's header has no room, and the right panel still opens the tab.
 * While the pane shows no footer row the memory icon sits in the header instead,
 * so the header keeps one Cortex button. The anchor stays to find the row.
 */
export function CortexChip({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { values } = useSettings();
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const hidden = values?.taskChip === false || isCompactViewport;
  const memoryOff = values?.memoryChip === false;
  const footer = useFooterPresent(hidden || memoryOff ? null : anchor);
  if (hidden) return null;
  const shown = memoryOff || footer;
  return (
    <span ref={setAnchor} className={shown ? "inline-flex items-center" : "hidden"}>
      {shown ? <TaskChip threadId={threadId} /> : null}
    </span>
  );
}

/** `#<id> · <status>` for the focus task (plain `cortex` without one); opens the Cortex tab following it. */
function TaskChip({ threadId }: { threadId: string }) {
  const { state, error } = useThreadState(threadId);
  const navigate = useBbNavigate();
  const focus = state?.links.find(link => link.id === state.focusTaskId) ?? null;
  const health = error !== null ? "error" : (state?.health.kind ?? "ok");
  const label = focus ? `#${focus.id} \u00b7 ${focus.status}` : "cortex";
  const detail =
    error ??
    (state?.health.kind !== "ok" ? state?.health.message : undefined) ??
    (focus ? focus.title : "No Cortex task yet");
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-tone={focus === null && health === "ok" ? "muted" : health}
      aria-label={`Cortex: ${label}. ${detail}. Open the Cortex tab.`}
      onClick={() => {
        openCortexTab(navigate, threadId, null);
      }}
      className={cn(
        "h-7 gap-1.5 px-2 font-mono text-xs",
        focus === null && "text-muted-foreground",
        (health === "blocked" || health === "stale") && "text-warning-text",
        health === "error" && "text-destructive-text",
      )}
    >
      {health === "ok" || health === "blocked" ? (
        focus ? (
          <StatusDot status={focus.status} />
        ) : (
          <Icon name="Brain" className="size-4" aria-hidden />
        )
      ) : (
        <Icon name="AlertTriangle" className="size-4" aria-hidden />
      )}
      <span>{label}</span>
    </Button>
  );
}
