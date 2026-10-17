import { useEffect, useRef, useState } from "react";
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { CortexTaskRow, CortexThreadState } from "../state";
import { errorText, useCortexRpc } from "./hooks";
import { StatusDot } from "./status";

const SEARCH_DEBOUNCE_MS = 200;

/** Tasks matching a query (a bare number or `#n` loads that task), debounced; null until the first answer. */
export function useTaskSearch(query: string) {
  const rpc = useCortexRpc();
  const [results, setResults] = useState<CortexTaskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setResults(null);
      setError(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      rpc.call("searchTasks", { query: trimmed }).then(
        out => {
          if (!live) return;
          setResults(out.tasks);
          setError(null);
        },
        cause => {
          if (live) setError(errorText(cause));
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, query]);
  return { results, error };
}

export function TaskRowLabel({ row }: { row: CortexTaskRow }) {
  return (
    <>
      <StatusDot status={row.status} />
      <span className="font-mono text-muted-foreground">#{row.id}</span>
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
    </>
  );
}

/** A search field for linking tasks; keys stay in the field instead of driving the surrounding menu. */
export function TaskSearchField({
  value,
  onChange,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [autoFocus]);
  return (
    <div className="relative">
      <Icon
        name="Search"
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground"
        aria-hidden
      />
      <Input
        ref={ref}
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
        }}
        placeholder="Link a task: search, or #id"
        aria-label="Search tasks to link"
        className="h-[30px] pl-8 text-[12.5px]"
      />
    </div>
  );
}

/** "Thread tasks": the thread's tasks with their origin, and a search that links a task. */
export function SwitcherMenu({
  state,
  selected,
  onSelect,
  onLink,
}: {
  state: CortexThreadState;
  selected: number | null;
  onSelect: (taskId: number) => void;
  onLink: (taskId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { results, error } = useTaskSearch(open ? query : "");
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  return (
    <DropdownMenu
      open={open}
      onOpenChange={next => {
        if (next) setOpen(true);
        else close();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="-ml-2 inline-flex h-[26px] items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
          aria-label={`Thread tasks (${state.links.length})`}
        >
          <Icon name="Brain" className="size-4" aria-hidden />
          Thread tasks
          <Badge variant="secondary" className="h-[18px] min-w-[18px] justify-center rounded-full px-1.5 text-[11px]">
            {state.links.length}
          </Badge>
          <Icon name="ChevronDown" className="size-3.5" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" mobileTitle="Thread tasks" className="w-[min(26rem,calc(100vw-2rem))]">
        <div className="p-1">
          <TaskSearchField value={query} onChange={setQuery} autoFocus={open} />
        </div>
        {query.trim() !== "" ? (
          <>
            {error !== null ? <p className="px-2 py-1.5 text-xs text-destructive-text">{error}</p> : null}
            {results !== null && results.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching tasks.</p>
            ) : null}
            {(results ?? []).map(row => (
              <DropdownMenuItem
                key={row.id}
                onSelect={() => {
                  close();
                  onLink(row.id);
                }}
              >
                <TaskRowLabel row={row} />
                <Icon name="Link" className="size-3.5 text-subtle-foreground" aria-label="link" />
              </DropdownMenuItem>
            ))}
          </>
        ) : (
          state.links.map(link => (
            <DropdownMenuItem key={link.id} onSelect={() => onSelect(link.id)} aria-checked={link.id === selected}>
              <TaskRowLabel row={link} />
              {link.id === selected ? (
                <Icon name="Check" className="size-3.5 text-primary" aria-label="current" />
              ) : (
                <span className="text-[10.5px] text-subtle-foreground">{link.authored ? "posted here" : "linked"}</span>
              )}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <p className="px-2 pt-1 pb-1.5 text-[11px] text-subtle-foreground">Tasks this thread posted to appear on their own.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Pin or unpin, copy the TUI command, and link or unlink. */
export function MoreMenu({
  taskId,
  pinned,
  listed,
  onPin,
  onLink,
  onUnlink,
}: {
  taskId: number;
  pinned: boolean;
  /** The task's row in the thread's list, or null when it is not linked. */
  listed: { authored: boolean } | null;
  onPin: () => void;
  onLink: () => void;
  onUnlink: () => void;
}) {
  const copy = async () => {
    const command = `cortex tui ${taskId}`;
    const copied = await experimental_copyToClipboard({ text: command });
    if (copied) toast(`Copied: ${command}`);
    else toast.error("Could not copy to the clipboard.");
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="More"
          className="grid size-[26px] place-items-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="MoreHorizontal" className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" mobileTitle={`Task #${taskId}`} className="w-60">
        <DropdownMenuItem onSelect={onPin}>
          <Icon name={pinned ? "PinOff" : "Pin"} aria-hidden />
          {pinned ? "Unpin" : "Pin as focus"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copy()}>
          <Icon name="Copy" aria-hidden />
          Copy <span className="font-mono">cortex tui {taskId}</span>
        </DropdownMenuItem>
        {listed === null ? (
          <DropdownMenuItem onSelect={onLink}>
            <Icon name="Link" aria-hidden />
            Link to this thread
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={onUnlink} disabled={listed.authored}>
            <Icon name="X" aria-hidden />
            Unlink
            {listed.authored ? <span className="ml-auto text-[11px] text-subtle-foreground">posted here</span> : null}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
