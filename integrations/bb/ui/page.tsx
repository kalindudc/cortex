import { type ReactNode, useState } from "react";
import {
  type ExperimentalBadge,
  type ExperimentalPageTitle,
  experimental_useSidebarThreads,
  type PluginNavPanelProps,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { plural } from "./copy";
import { useBindings, useReviewQueue, useWorkstreams } from "./data";
import { Bindings, Library } from "./library";
import { FailureNotice } from "./parts";
import { NeedsYou } from "./review";
import { CORTEX_PAGE_PATH, ThreadContextPage } from "./thread-context";
import { WorkstreamDialog, WorkstreamPage } from "./workstreams";
import { SectionPage } from "./sections";

type Route =
  | { kind: "needs" }
  | { kind: "section"; id: string }
  | { kind: "workstream"; id: string; entryId: string | null }
  | { kind: "library" }
  | { kind: "bindings" }
  | { kind: "thread"; threadId: string };

const WS_ID = /^ws_[a-zA-Z0-9_-]+$/;
const KN_ID = /^kn_[a-zA-Z0-9_-]+$/;
const THREAD_ID = /^thr_[0-9a-z]{6,40}$/;

/** The page route from bb's still-encoded subPath; anything unknown lands on Needs you. */
export function parseRoute(subPath: string): Route {
  const parts = subPath.split("/").filter(Boolean).map(part => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  if (parts[0] === "sections" && parts[1] && /^sec_[a-zA-Z0-9_-]+$/.test(parts[1])) return { kind: "section", id: parts[1] };
  if (parts[0] === "workstreams" && parts[1] && WS_ID.test(parts[1])) {
    return { kind: "workstream", id: parts[1], entryId: parts[2] && KN_ID.test(parts[2]) ? parts[2] : null };
  }
  if (parts[0] === "library") return { kind: "library" };
  if (parts[0] === "bindings") return { kind: "bindings" };
  if (parts[0] === "threads" && parts[1] && THREAD_ID.test(parts[1])) return { kind: "thread", threadId: parts[1] };
  return { kind: "needs" };
}

export function CortexPage({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  return (
    <div className="h-full min-h-0 text-foreground" data-cortex-page="">
      {route.kind === "section" ? <SectionPage key={route.id} id={route.id} /> : null}
      {route.kind === "needs" ? <NeedsYou /> : null}
      {route.kind === "workstream" ? <WorkstreamPage key={route.id} id={route.id} selectedId={route.entryId} /> : null}
      {route.kind === "library" ? <Library /> : null}
      {route.kind === "bindings" ? <Bindings /> : null}
      {route.kind === "thread" ? (
        <div className="h-full overflow-y-auto p-4 md:p-5">
          <ThreadContextPage threadId={route.threadId} />
        </div>
      ) : null}
    </div>
  );
}

function NavRow({
  icon,
  label,
  current,
  count,
  attention = false,
  onClick,
}: {
  icon: string;
  label: string;
  current: boolean;
  count?: number;
  attention?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        current ? "bg-surface-selected font-semibold text-foreground" : "text-foreground hover:bg-state-hover",
      )}
    >
      <Icon name={icon} className={cn("size-4 shrink-0", attention ? "text-attention" : "text-muted-foreground")} aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      {count ? (
        <span className={cn("shrink-0 rounded-sm px-1.5 text-[11px] tabular-nums", attention ? "bg-surface-attention text-foreground" : "text-muted-foreground")}>
          {count}
          <span className="sr-only"> waiting</span>
        </span>
      ) : null}
    </button>
  );
}

function Group({ label, trailing, children }: { label: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-4 flex flex-col gap-0.5">
      <div className="flex items-center gap-2 px-2 pb-1">
        <h2 className="flex-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</h2>
        {trailing}
      </div>
      {children}
    </div>
  );
}

/** The page's own navigation in bb's section sidebar: Needs you, each workstream, the library, bindings and connected threads. */
export function CortexSidebar({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  const navigate = useBbNavigate();
  const queue = useReviewQueue();
  const workstreams = useWorkstreams();
  const bindings = useBindings();
  const sidebar = experimental_useSidebarThreads();
  const [creating, setCreating] = useState(false);
  const go = (path: string) => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: path });
  const waiting = new Map<string, number>();
  for (const item of queue.data?.items ?? []) waiting.set(item.workstream.id, (waiting.get(item.workstream.id) ?? 0) + 1);
  const bound = new Set((bindings.data?.bindings ?? []).filter(row => row.binding !== null).map(row => row.key));
  const sections = sidebar.sections;
  return (
    <nav aria-label="Cortex" className="flex h-full flex-col overflow-y-auto px-2 py-2">
      <NavRow icon="BellDot" label="Needs you" current={route.kind === "needs"} count={queue.data?.total} attention onClick={() => go("")} />
      <Group label="Your bb sections">
        {sections.map(section => <NavRow key={section.id} icon={bound.has(section.id) ? "Brain" : "Folder"} label={section.name} current={route.kind === "section" && route.id === section.id} onClick={() => go(`sections/${section.id}`)} />)}
        {sections.length === 0 ? <p role="status" className="px-2 text-[13px]">No bb sections yet.</p> : null}
      </Group>
      <details className="mt-4"><summary className="cursor-pointer px-2 py-1 text-[13px]">Advanced workstreams</summary>
      <Group
        label="Workstreams"
        trailing={
          <button
            type="button"
            aria-label="New workstream"
            title="New workstream"
            onClick={() => setCreating(true)}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon name="Plus" className="size-4" aria-hidden />
          </button>
        }
      >
        {workstreams.error ? <FailureNotice failure={workstreams.error} onRetry={workstreams.refetch} /> : null}
        {workstreams.data?.workstreams.length === 0 ? <p className="px-2 text-[12px] text-muted-foreground">None yet.</p> : null}
        {(workstreams.data?.workstreams ?? []).map(ws => (
          <NavRow
            key={ws.id}
            icon="Layers"
            label={ws.name}
            current={route.kind === "workstream" && route.id === ws.id}
            count={waiting.get(ws.id)}
            attention
            onClick={() => go(`workstreams/${ws.id}`)}
          />
        ))}
      </Group>
      </details>
      <Group label="More">
        <NavRow icon="Search" label="Library" current={route.kind === "library"} onClick={() => go("library")} />
        <NavRow icon="SectionMove" label="Connections" current={route.kind === "bindings"} onClick={() => go("bindings")} />
      </Group>
      <WorkstreamDialog workstream={null} open={creating} onOpenChange={setCreating} />
    </nav>
  );
}

/** The rail badge: how many entries wait for a person's review. */
export function useNeedsYouBadge(): ExperimentalBadge | null {
  const queue = useReviewQueue();
  const total = queue.data?.total ?? 0;
  if (total <= 0) return null;
  return { count: total, tone: "warning", label: `${plural(total, "entry", "entries")} waiting for your review` };
}

export function useCortexPageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const route = parseRoute(subPath);
  const workstreams = useWorkstreams();
  const { threads, sections } = experimental_useSidebarThreads();
  switch (route.kind) {
    case "section":
      return { title: sections.find(section => section.id === route.id)?.name ?? "Section context" };
    case "needs":
      return { title: "Needs you" };
    case "library":
      return { title: "Library" };
    case "bindings":
      return { title: "Bindings" };
    case "workstream":
      return { title: workstreams.data?.workstreams.find(ws => ws.id === route.id)?.name ?? "Workstream" };
    case "thread":
      return { title: threads.find(thread => thread.id === route.threadId)?.displayTitle ?? "Thread context" };
  }
}
