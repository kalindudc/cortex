import { type ReactNode, useEffect, useState } from "react";
import {
  type ExperimentalBadge,
  type ExperimentalPageTitle,
  experimental_useSidebarThreads,
  type PluginNavPanelProps,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { deliverySummary, plural } from "./copy";
import { BriefStrip } from "./brief-strip";
import { useBindings, useReviewQueue, useSectionDetail, useWorkstreams } from "./data";
import { Library } from "./library";
import { OverviewPage } from "./overview";
import { FailureNotice, LoadingRows } from "./parts";
import { NeedsYou } from "./review";
import { SectionPage } from "./sections";
import { CORTEX_PAGE_PATH, ThreadContextPage } from "./thread-context";
import { WorkstreamList } from "./workstream-list";
import { WorkstreamPage } from "./workstreams";

export type SectionTab = "brief" | "knowledge" | "drafts" | "edits";
export type SectionRoute = { kind: "section"; id: string; tab: SectionTab; entryId: string | null; connect: boolean };
export type Route =
  | { kind: "overview" }
  | { kind: "review" }
  | SectionRoute
  | { kind: "workstreams" }
  | { kind: "workstream"; id: string; entryId: string | null }
  | { kind: "library" }
  | { kind: "bindings" }
  | { kind: "thread"; threadId: string };

const WS_ID = /^ws_[a-zA-Z0-9_-]+$/;
const KN_ID = /^kn_[a-zA-Z0-9_-]+$/;
const SECTION_ID = /^sec_[a-zA-Z0-9_-]+$/;
const THREAD_ID = /^thr_[0-9a-z]{6,40}$/;

/** bb supplies encoded path segments; malformed or unknown routes land on Overview. */
export function parseRoute(subPath: string): Route {
  const [path, query] = subPath.split("?", 2);
  let parts: string[];
  try {
    parts = path!.split("/").filter(Boolean).map(part => decodeURIComponent(part));
  } catch {
    return { kind: "overview" };
  }
  if (parts[0] === "sections" && parts[1] && SECTION_ID.test(parts[1])) {
    const tab = parts[2] ?? "brief";
    if (tab === "connect" && parts.length === 3) return { kind: "section", id: parts[1], tab: "brief", entryId: null, connect: true };
    if ((tab === "brief" || tab === "knowledge" || tab === "drafts" || tab === "edits") && parts.length <= 4 && (!parts[3] || KN_ID.test(parts[3]))) {
      return { kind: "section", id: parts[1], tab, entryId: parts[3] ?? null, connect: new URLSearchParams(query).get("connect") === "1" };
    }
  }
  if (parts[0] === "workstreams") {
    if (parts.length === 1) return { kind: "workstreams" };
    if (parts[1] && WS_ID.test(parts[1]) && parts.length <= 3 && (!parts[2] || KN_ID.test(parts[2]))) return { kind: "workstream", id: parts[1], entryId: parts[2] ?? null };
  }
  if (parts.length === 1 && parts[0] === "review") return { kind: "review" };
  if (parts.length === 1 && parts[0] === "library") return { kind: "library" };
  if (parts.length === 1 && parts[0] === "bindings") return { kind: "bindings" };
  if (parts.length === 2 && parts[0] === "threads" && parts[1] && THREAD_ID.test(parts[1])) return { kind: "thread", threadId: parts[1] };
  return { kind: "overview" };
}

function Redirect({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  useEffect(() => { navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath, replace: true }); }, [navigate, subPath]);
  return <LoadingRows label="Opening page" rows={2} />;
}

function WorkstreamRoute({ route }: { route: Extract<Route, { kind: "workstream" }> }) {
  const bindings = useBindings();
  if (bindings.data === undefined) return bindings.error ? <FailureNotice failure={bindings.error} onRetry={bindings.refetch} /> : <LoadingRows label="Loading connections" />;
  const sections = bindings.data.bindings.filter(row => row.binding?.workstreamId === route.id);
  if (!bindings.error && sections.length === 1) return <Redirect subPath={`sections/${sections[0]!.key}/knowledge${route.entryId ? `/${route.entryId}` : ""}`} />;
  return <WorkstreamPage key={route.id} id={route.id} selectedId={route.entryId} />;
}

export function CortexPage({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  return (
    <div data-cortex data-cortex-page="" className="@container h-full min-h-0 min-w-0 text-foreground [@media(pointer:coarse)]:[&_button]:min-h-11 max-[480px]:[&_button]:min-h-11">
      {route.kind === "overview" ? <OverviewPage /> : null}
      {route.kind === "section" ? <SectionPage key={route.id} {...route} /> : null}
      {route.kind === "review" ? <NeedsYou /> : null}
      {route.kind === "workstreams" ? <WorkstreamList /> : null}
      {route.kind === "workstream" ? <WorkstreamRoute route={route} /> : null}
      {route.kind === "library" ? <Library /> : null}
      {route.kind === "bindings" ? <Redirect subPath="" /> : null}
      {route.kind === "thread" ? <div className="h-full min-w-0 overflow-y-auto p-4"><ThreadContextPage threadId={route.threadId} /></div> : null}
    </div>
  );
}

// Compact rows like bb's own lists; only a narrow viewport or a touch screen
// grows them to 44 px. A container query would not do: the sidebar itself is
// always narrow.
const TOUCH = "max-[576px]:min-h-11 [@media(pointer:coarse)]:min-h-11";

function NavRow({ icon, label, current, count, attention = false, bound = false, muted = false, countWord = "waiting", second, nested = false, onClick }: {
  icon: string; label: string; current: boolean; count?: number; attention?: boolean; bound?: boolean; muted?: boolean; countWord?: string; second?: ReactNode; nested?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" aria-label={count ? `${label} ${count} ${countWord}` : label} aria-current={current ? "page" : undefined} onClick={onClick} className={cn(
      "relative grid min-h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md py-1.5 pr-2 text-left text-[13px] leading-tight focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      TOUCH,
      nested ? "pl-6" : "pl-2",
      current ? "bg-surface-selected font-semibold text-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-primary" : muted ? "text-muted-foreground hover:bg-state-hover hover:text-foreground" : "text-foreground hover:bg-state-hover",
    )}>
      <Icon name={icon} className={cn("size-4 shrink-0", bound ? "text-primary" : attention ? "text-attention" : "text-muted-foreground")} aria-hidden />
      <span className="min-w-0 truncate" title={label}>{label}</span>
      <span className="flex items-center">{count ? <span className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm px-1 text-[11px] font-semibold tabular-nums", attention ? "bg-surface-attention text-foreground" : "font-medium text-muted-foreground")}>
        {count}<span className="sr-only"> {countWord}</span>
      </span> : null}</span>
      {second !== undefined ? <span className="col-start-2 col-end-4 flex min-w-0 items-center gap-2 pt-1 text-[11px] font-normal text-muted-foreground">{second}</span> : null}
    </button>
  );
}

function Heading({ label, trailing }: { label: string; trailing?: ReactNode }) {
  return <div className="flex min-h-7 items-center gap-2 px-2 pt-3 pb-1"><h2 className="flex-1 text-[11px] font-semibold text-muted-foreground">{label}</h2>{trailing}</div>;
}

// The brief of a shared section in one line: its strip and what goes in.
function SectionBrief({ sectionId }: { sectionId: string }) {
  const brief = useSectionDetail(sectionId).data?.eligibility;
  if (!brief) return null;
  const held = brief.exclusions.length + brief.notices.length;
  return <><span className="min-w-0 flex-1"><BriefStrip data={brief} compact /></span><span className="shrink-0 tabular-nums">{deliverySummary(brief.status, `${brief.entries.length} in`)}{held ? ` · ${held} held` : ""}</span></>;
}

const UNSHARED_KEY = "cortex.sidebar.unshared-open";

function useUnsharedOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => globalThis.localStorage?.getItem(UNSHARED_KEY) === "1");
  return [open, next => { setOpen(next); globalThis.localStorage?.setItem(UNSHARED_KEY, next ? "1" : "0"); }];
}

export function CortexSidebar({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  const navigate = useBbNavigate();
  const queue = useReviewQueue();
  const workstreams = useWorkstreams();
  const bindings = useBindings();
  const sidebar = experimental_useSidebarThreads();
  const [unsharedOpen, setUnsharedOpen] = useUnsharedOpen();
  const go = (path: string) => navigate.toPluginPanel(CORTEX_PAGE_PATH, { subPath: path });
  const waiting = new Map<string, number>();
  for (const item of queue.data?.items ?? []) if (item.entry.state === "candidate") waiting.set(item.workstream.id, (waiting.get(item.workstream.id) ?? 0) + 1);
  const bound = new Map((bindings.data?.bindings ?? []).filter(row => row.binding !== null).map(row => [row.key, row.binding!]));
  const currentSection = route.kind === "section" ? route.id : route.kind === "thread" ? sidebar.threads.find(thread => thread.id === route.threadId)?.sectionId : null;
  const shared = sidebar.sections.filter(section => bound.has(section.id));
  const unshared = sidebar.sections.filter(section => !bound.has(section.id));
  // With nothing shared there is nothing to fold them under.
  const fold = shared.length > 0;
  const unsharedShown = !fold || unsharedOpen ? unshared : unshared.filter(section => section.id === currentSection);
  const sectionRow = (section: (typeof sidebar.sections)[number], nested = false) => {
    const binding = bound.get(section.id);
    return <NavRow key={section.id} icon={binding ? "Brain" : "Folder"} bound={!!binding} muted={!binding} label={section.name} current={currentSection === section.id} count={binding ? waiting.get(binding.workstreamId) : undefined} attention={!!binding} second={binding ? <SectionBrief sectionId={section.id} /> : undefined} nested={nested} onClick={() => go(`sections/${section.id}`)} />;
  };
  return (
    <nav data-cortex aria-label="Cortex" className="flex h-full min-w-0 flex-col gap-px overflow-y-auto p-2">
      <NavRow icon="BellDot" label="Review" current={route.kind === "review"} count={queue.data?.total} attention onClick={() => go("review")} />
      <NavRow icon="GridView" label="Overview" current={route.kind === "overview" || route.kind === "bindings"} onClick={() => go("")} />
      <Heading label="Sections" trailing={<TooltipProvider><Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" aria-label="About sections" className={cn("size-6", "max-[576px]:size-11 [@media(pointer:coarse)]:size-11")}><Icon name="Info" className="size-3.5 text-muted-foreground" aria-hidden /></Button></TooltipTrigger><TooltipContent>Sections come from bb. Connect one to share a brief.</TooltipContent></Tooltip></TooltipProvider>} />
      {bindings.error ? <FailureNotice failure={bindings.error} onRetry={bindings.refetch} /> : null}
      {shared.map(section => sectionRow(section))}
      {fold && unshared.length > 0 ? <NavRow icon={unsharedOpen ? "ChevronDown" : "ChevronRight"} muted label="Not shared" countWord={unshared.length === 1 ? "section" : "sections"} count={unshared.length} current={false} onClick={() => setUnsharedOpen(!unsharedOpen)} /> : null}
      {unsharedShown.map(section => sectionRow(section, fold))}
      {sidebar.sections.length === 0 ? <p role="status" className="px-2 py-1.5 text-[13px] text-muted-foreground">No bb sections yet.</p> : null}
      <Heading label="Knowledge" />
      <NavRow icon="Search" label="Library" current={route.kind === "library"} onClick={() => go("library")} />
      <NavRow icon="Layers" label="Workstreams" current={route.kind === "workstreams" || route.kind === "workstream"} count={workstreams.data?.total} countWord={workstreams.data?.total === 1 ? "workstream" : "workstreams"} onClick={() => go("workstreams")} />
    </nav>
  );
}

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
    case "section": return { title: sections.find(section => section.id === route.id)?.name ?? "Section context" };
    case "overview": case "bindings": return { title: "Overview" };
    case "review": return { title: "Review" };
    case "library": return { title: "Library" };
    case "workstreams": return { title: "Workstreams" };
    case "workstream": return { title: workstreams.data?.workstreams.find(ws => ws.id === route.id)?.name ?? "Workstream" };
    case "thread": return { title: threads.find(thread => thread.id === route.threadId)?.displayTitle ?? "Thread context" };
  }
}
