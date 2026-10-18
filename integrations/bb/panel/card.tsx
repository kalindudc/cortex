import { useState } from "react";
import { type PluginMessageDirectiveProps, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { parseTaskId, useTaskDetail } from "./hooks";
import { openCortexTab } from "./selection";
import { STATUS_LABEL, StatusDot } from "./status";

/** `::cortex{id="<id>"}` in an assistant reply: a card that opens the task in the Cortex tab. */
export function CortexCard({ attributes, message }: PluginMessageDirectiveProps) {
  const navigate = useBbNavigate();
  const taskId = parseTaskId(attributes.id);
  const { detail, error } = useTaskDetail(message.threadId, taskId);
  const [declined, setDeclined] = useState(false);
  if (taskId === null) {
    return (
      <div role="alert" className="my-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-destructive-text">
        Cortex card: the id must be a task number, as in ::cortex{'{id="529"}'}.
      </div>
    );
  }
  const open = () => {
    setDeclined(!openCortexTab(navigate, message.threadId, taskId));
  };
  return (
    <Card className="my-2 flex items-center gap-3 px-3 py-2 text-sm">
      {detail ? (
        <StatusDot status={detail.task.status} className="size-2.5" />
      ) : (
        <Icon name="Brain" className="size-4 text-muted-foreground" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-foreground">
          <span className="font-mono text-muted-foreground">#{taskId}</span> {detail?.task.title ?? (error ? "" : "…")}
        </p>
        <p className="text-xs text-muted-foreground">
          {error ? error : detail ? `${STATUS_LABEL[detail.task.status]} \u00b7 ${detail.task.lane}` : "Loading…"}
        </p>
        {declined ? (
          <p role="status" className="text-xs text-destructive-text">
            bb could not open the Cortex tab here; open this thread to see the task.
          </p>
        ) : null}
      </div>
      <Button size="sm" variant="outline" onClick={open}>
        Open
      </Button>
    </Card>
  );
}
