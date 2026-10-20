// Launch links: `--task=<id>` and `--heading=<slug>` on the app's command
// line, at launch or from a second launch. Every argv entry is scanned,
// because Chromium reorders a second instance's argv and appends its own
// switches; the last of each flag wins. A heading without a valid task is
// ignored, and only the `=` form is accepted. Never imports electron.

export interface DeepLink {
  readonly taskId: number;
  readonly heading: string | null;
}

const TASK_RE = /^[1-9][0-9]{0,15}$/;
// The rule of parseHeadingFragment in src/ui/state/url.ts.
const HEADING_RE = /^[a-z0-9-]{1,256}$/i;

export function parseDeepLink(argv: readonly string[]): DeepLink | null {
  let task: string | null = null;
  let heading: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--task=")) task = arg.slice("--task=".length);
    else if (arg.startsWith("--heading=")) heading = arg.slice("--heading=".length);
  }
  if (task === null || !TASK_RE.test(task)) return null;
  const taskId = Number(task);
  if (!Number.isSafeInteger(taskId)) return null;
  return { taskId, heading: heading !== null && HEADING_RE.test(heading) ? heading : null };
}

/** The app path that opens `link`: "/", "/task/42" or "/task/42#intro-2". */
export function deepLinkPath(link: DeepLink | null): string {
  if (link === null) return "/";
  return link.heading === null ? `/task/${link.taskId}` : `/task/${link.taskId}#${link.heading}`;
}
