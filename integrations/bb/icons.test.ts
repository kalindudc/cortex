import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// bb resolves an icon name against its own built-in set (not lucide) and
// draws a lightning bolt for any name it does not know, so a lucide name such
// as "Pencil" renders as the wrong glyph without any error. This is the
// built-in set of the bb app this plugin targets; extend it only with names
// that exist there.
const BB_ICONS = new Set(
  `AiBrain01 AiBrowser AiContentGenerator01 AlertCircle AlertTriangle AlignLeft AppWindow Archive
ArchiveRestore ArrowDown ArrowLeft ArrowReloadHorizontal ArrowRight ArrowTurnBackward
ArrowTurnForward ArrowUp ArrowUpDown ArrowUpRight Beaker BellDot Bot Brain Browser Bug Calendar
CalendarCheckOut02 ChartColumn Check ChevronDown ChevronLeft ChevronRight ChevronUp ChevronsDown
ChevronsUp ChildThread Circle CircleArrowShrink CircleCheck CircleQuestion CircleX Clean Clock
ClockArrowDown ClockArrowUp Cloud CloudOff Code Coffee Columns2 ComputerCloud ComputerTerminal01
Copy CornerDownLeft CornerDownRight DateTime DiffAdded DiffConflict DiffModified DiffRemoved
DiffRenamed Download DragDropHorizontal DragDropVertical Edit EditFile ElectricPlugs Explore
ExternalLink Eye EyeOff File FileAttachment FileDiff FileQuestion FileText Filter FilterHorizontal
Folder Folder02 FolderEdit FolderExport FolderGit FolderMinus FolderOpen FolderPlus FolderSync
FolderUnknown Fork GitBranch GitMerge GitPullRequest GitPullRequestArrow GitPullRequestClosed
GitPullRequestDraft Globe GridView Home Info Keyboard Laptop Layers LayoutList Limitation Link
ListEnd ListTodo ListView Loading Lock Mail MailOpen Maximize2 Megaphone02 MessageCirclePlus
MessageQuestion MessageSquare MessageSquarePlus Mic Minimize2 Minus MoreHorizontal MoveTo NewTab
News01 PackageReceive PanelBottom PanelLeft PanelRight Paperclip Pause Pin PinOff Play Plug02 Plus
Puzzle Repeat RotateCcw Rows2 Search SecurityCheck Sent Settings SideChat SlidersHorizontal
Smartphone Sort SortingAZ02 SortingNineOne SortingOneNine SortingZA01 Space Spinner Square
SquareUnlock02 Star Target Terminal TextWrap TimeSchedule ToolCase Toolbox Trash2 Unavailable
UserRound UserRoundPlus Workflow Zap ZoomIn ZoomOut`.split(/\s+/),
);

const root = new URL(".", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

// An icon position is a JSX `name=`/`icon=`/`fallback=` prop, an `icon:` field
// or a `glyph =` binding. Its expression runs to the matching brace (JSX), the
// first top-level comma or closing brace (a field) or the semicolon (a
// binding); every capitalised literal in it, ternary branches included, must
// be a bb icon name. Literals compared with `===` are values, not icons.
const ICON_POSITION = /\b(?:name=|icon=|fallback=|icon:\s*|glyph\s*=\s*)/g;

function expressionAt(text: string, from: number): string {
  if (text[from] === '"') return text.slice(from, text.indexOf('"', from + 1) + 1);
  const braced = text[from] === "{";
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (char === "{" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ")" || char === "]") {
      if (depth === 0) return text.slice(from, i);
      depth--;
      if (braced && depth === 0) return text.slice(from, i + 1);
    } else if (depth === 0 && !braced && (char === "," || char === ";" || char === "\n")) return text.slice(from, i);
  }
  return text.slice(from);
}

function iconNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(ICON_POSITION)) {
    const expression = expressionAt(text, (match.index ?? 0) + match[0].length);
    for (const literal of expression.matchAll(/(===?\s*|!==?\s*)?"([A-Z][A-Za-z0-9]+)"/g)) if (!literal[1]) names.push(literal[2]!);
  }
  return names;
}

describe("icons", () => {
  const files = ["ui", "panel", "components"].flatMap(dir => sources(join(root, dir))).concat(join(root, "app.tsx"));

  test("the scan finds the icons it is meant to check", () => {
    const found = new Set(files.flatMap(file => iconNames(readFileSync(file, "utf8"))));
    for (const name of ["Brain", "CircleCheck", "MoreHorizontal", "AlertTriangle", "Star"]) expect(found).toContain(name);
  });

  test("every icon name the plugin passes to bb is one bb draws", () => {
    const unknown = files.flatMap(file =>
      iconNames(readFileSync(file, "utf8"))
        .filter(name => !BB_ICONS.has(name))
        .map(name => `${file.slice(root.length)}: ${name}`),
    );
    expect(unknown).toEqual([]);
  });
});
