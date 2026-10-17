import { type PluginThreadHeaderActionProps, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useThreadState } from "./hooks";
import { StatusDot } from "./status";

export const PANEL_ACTION_ID = "cortex";

/** `#<id> · <status>` for the focus task (plain `cortex` without one); opens the Cortex tab. */
export function CortexChip({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
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
        navigate.openThreadPanel({ actionId: PANEL_ACTION_ID });
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
      {isCompactViewport ? null : <span>{label}</span>}
    </Button>
  );
}
