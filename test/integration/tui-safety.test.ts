import { test, expect, describe, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { BIN, mkTmpEnv, runCli } from "./helpers.ts";
import { isCooked, type Pty, reapPtys, spawnPty } from "./fixtures/pty.ts";

// ---------- hostile text cannot drive the terminal (plan @400 Task 12, G5) ----------
//
// The COMPILED bin/cortex runs in a real PTY (fixtures/pty.ts: continuously
// drained, bounded waits) over a mkTmpEnv() sandbox seeded with terminal
// control sequences in every untrusted field the CLI accepts: the title,
// the Markdown body (heading, paragraph, quote, list, inline code, fenced
// code, table), a lane name and color, a tag color (tag names are
// validated), an update's summary, body and author, and text pasted into
// the prompt, the search and the composer. The session walks every surface
// that shows them, then the WHOLE raw output is scanned:
//
// - every ESC sequence is tokenized: OSC, DCS, APC, PM and SOS must be the
//   TUI's own (the startup background query, OSC 8 around the one safe
//   seeded URL, OSC 52 only after the explicit `:copy`, pi-tui's kitty image
//   cleanup); no C1 control, DEL or C0 other than CR/LF may appear outside a
//   sequence;
// - CSI cannot be told apart by kind (the TUI's own full redraw sends
//   `\x1b[2J`), so every seeded control is preceded by a unique marker
//   (`<field><id>`) and the marker immediately followed by the raw control
//   is a leak;
// - each surface must show the payloads in their escaped, visible form
//   (`^[`, `^G`, `<U+009B>`), and the database keeps the raw source.
//
// The positive control proves the scan can fail: the same payloads spliced
// raw into the captured output are all reported, and the TUI's own
// legitimate sequences (alternate screen, full-redraw erase, OSC 8 around the
// safe link, the OSC 52 of `:copy`) are found in the real stream.
//
// The width test renders CJK/emoji/combining titles and bodies at 100x30,
// 80x24 and 120x40 and rebuilds the screen from pi-tui's row writes
// (`\x1b[<row>;1H\x1b[2K<line>`): no row is wider than the terminal
// (measured with Bun.stringWidth, independent of the renderer's own width
// function) and the pane divider and table borders stay in one column.
//
// Each sandbox's daemon is started by its TUI and stopped with `cortex stop`
// in the SAME env (instance-bound, never another daemon); the only signals
// go to PTY children this file spawned.

setDefaultTimeout(120_000);

// Terminal identity variables pi-tui reads to pick image/hyperlink/mouse
// behavior: removed, so the stream is the same on every machine and in CI.
const TERMINAL_IDENTITY = [
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERMINAL_EMULATOR",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "ZELLIJ",
  "KITTY_WINDOW_ID",
  "GHOSTTY_RESOURCES_DIR",
  "GHOSTTY_BIN_DIR",
  "WEZTERM_PANE",
  "WARP_SESSION_ID",
  "WARP_TERMINAL_SESSION_UUID",
  "ITERM_SESSION_ID",
  "WT_SESSION",
  "TERMUX_VERSION",
  "PI_HYPERLINKS",
  "PI_IMAGE_PROTOCOL",
  "PI_TRUE_COLOR",
  "PI_TUI_WRITE_LOG",
  "PI_TUI_DEBUG",
  "PI_TUI_DEBUG_REDRAW",
  "COLUMNS",
  "LINES",
  "NO_COLOR",
];

type Sandbox = ReturnType<typeof mkTmpEnv> & { tuiEnv: Record<string, string> };
const boxes: Sandbox[] = [];

/** A sandbox whose TUI env has colors on (theme styles wrap the escaped text) and no terminal identity. */
function sandbox(label: string): Sandbox {
  const box = mkTmpEnv(label);
  const tuiEnv: Record<string, string> = { ...box.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const key of TERMINAL_IDENTITY) delete tuiEnv[key];
  const made = { ...box, tuiEnv };
  boxes.push(made);
  return made;
}

afterAll(async () => {
  await reapPtys();
  const failures: string[] = [];
  for (const box of boxes.splice(0)) {
    // Instance-bound: stops only the daemon this sandbox's TUI started.
    const r = await runCli({ args: ["stop"], env: box.env });
    if (r.code !== 0) failures.push(`${box.tmpDir}: ${r.stderr}`);
    box.cleanup();
  }
  expect(failures).toEqual([]);
});

async function cli(env: Record<string, string>, ...args: string[]): Promise<string> {
  const r = await runCli({ args, env });
  expect(r.code, `cortex ${JSON.stringify(args).slice(0, 120)}: ${r.stderr}`).toBe(0);
  return r.stdout;
}

// ---------- the hostile payloads ----------

type Payload = { id: string; raw: string; shown: string; what: string };

/** One control per id; `shown` is its escaped form (src/tui/safety.ts caret / <U+XXXX> notation). */
const PAYLOADS: readonly Payload[] = [
  { id: "1", raw: "\x1b[2J", shown: "^[[2J", what: "CSI erase display" },
  { id: "2", raw: "\x1b]0;pwned\x07", shown: "^[]0;pwned^G", what: "OSC 0 window title" },
  { id: "3", raw: "\x1b]52;c;cHduZWQ=\x07", shown: "^[]52;c;cHduZWQ=^G", what: "OSC 52 clipboard write" },
  {
    id: "4",
    raw: "\x1b]8;;javascript:alert(1)\x1b\\",
    shown: "^[]8;;javascript:alert(1)^[\\",
    what: "OSC 8 to a javascript: URL",
  },
  { id: "5", raw: "\x1b]8;;file:///etc/passwd\x07", shown: "^[]8;;file:///etc/passwd^G", what: "OSC 8 to a file: URL" },
  { id: "6", raw: "\x1bP+q544e\x1b\\", shown: "^[P+q544e^[\\", what: "DCS XTGETTCAP query" },
  { id: "7", raw: "\x1b_Gf=100;cHduZWQ=\x1b\\", shown: "^[_Gf=100;cHduZWQ=^[\\", what: "APC kitty graphics" },
  { id: "8", raw: "\x9b2J\x9d0;pwned\x9c", shown: "<U+009B>2J<U+009D>0;pwned<U+009C>", what: "C1 CSI, OSC and ST" },
  { id: "9", raw: "\x07\x08", shown: "^G^H", what: "C0 BEL and BS" },
  { id: "0", raw: "\x1b[?1049l", shown: "^[[?1049l", what: "CSI leave the alternate screen" },
  { id: "a", raw: "\x1b[1;1H", shown: "^[[1;1H", what: "CSI cursor position" },
];

/** Every seeded `<marker><control>` (emitted raw, it is a leak) and what it is. */
const PROBES = new Map<string, string>();

/** `<field><id><control>` for the chosen payloads (all by default), recorded as probes. */
function hostile(field: string, ids = "1234567890a", separator = " "): string {
  const chosen = PAYLOADS.filter(p => ids.includes(p.id));
  for (const p of chosen) PROBES.set(`${field}${p.id}${p.raw}`, `${field}${p.id}: ${p.what}`);
  return chosen.map(p => `${field}${p.id}${p.raw}`).join(separator);
}

/** The escaped form of `hostile(field, ids, separator)`. */
function shown(field: string, ids = "1234567890a", separator = " "): string {
  return PAYLOADS.filter(p => ids.includes(p.id))
    .map(p => `${field}${p.id}${p.shown}`)
    .join(separator);
}

const SAFE_URL = "https://example.com/safe";
const LANE = hostile("ln", "1280", "");
const LANE_COLOR = hostile("lc", "13");
const TAG_COLOR = hostile("tc", "28");
// validateAuthorTag: at most 80 characters, no newline.
const AUTHOR = hostile("au", "12389", "");
const TITLE = `ti ${hostile("ti")}`;
const CODE = `cb ${hostile("cb")}`;
// The code block comes last: :copy finds it by number wherever the view is.
const BODY = [
  `# hd ${hostile("hd")}`,
  "",
  "| a | b |",
  "|---|---|",
  `| tb ${hostile("tb")} | x |`,
  "",
  `bo ${hostile("bo")}`,
  "",
  `> qt ${hostile("qt")}`,
  "",
  `- li ${hostile("li")}`,
  "",
  `Inline \`ic ${hostile("ic", "2389")}\` code.`,
  "",
  `[safe link](${SAFE_URL}) [js link](javascript:alert(1)) [file link](file:///etc/passwd) <file:///etc/hosts>`,
  "",
  "```sh",
  CODE,
  "```",
].join("\n");
const SUMMARY = `us ${hostile("us")}`;
const UPDATE_BODY = `ub ${hostile("ub")}`;
const BLOCKED = `bl ${hostile("bl")}`;
const PASTED = `pa ${hostile("pa")}`;
const SEARCHED = `se ${hostile("se")}`;
const COMPOSED = `co ${hostile("co")}`;

// ---------- the scan ----------

type TokenKind = "CSI" | "OSC" | "DCS" | "APC" | "PM" | "SOS" | "ESC" | "C0" | "C1" | "DEL" | "BAD";
type Token = { kind: TokenKind; at: number; seq: string; body: string };

const STRING_KINDS: Record<string, TokenKind> = { "]": "OSC", P: "DCS", _: "APC", "^": "PM", X: "SOS" };
/** pi-tui's own kitty image cleanup on a full redraw (only when it detects kitty graphics). */
const KITTY_DELETE_ALL = "Ga=d,d=A,q=2";

/** Every control in `raw`: escape sequences whole, and each lone control character. */
function scan(raw: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < raw.length) {
    const code = raw.charCodeAt(i);
    if (code === 0x1b) {
      const next = raw[i + 1] ?? "";
      if (next === "[") {
        const m = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(raw.slice(i, i + 256));
        const seq = m?.[0] ?? raw.slice(i, i + 16);
        tokens.push({ kind: m ? "CSI" : "BAD", at: i, seq, body: "" });
        i += m ? seq.length : 1;
        continue;
      }
      const kind = STRING_KINDS[next];
      if (kind !== undefined) {
        // The body runs to BEL or ST (ESC \); any other ESC cuts it short (a malformed sequence).
        let j = i + 2;
        while (j < raw.length && raw[j] !== "\x07" && raw[j] !== "\x1b") j++;
        const bel = raw[j] === "\x07";
        const st = raw[j] === "\x1b" && raw[j + 1] === "\\";
        const end = bel ? j + 1 : st ? j + 2 : j;
        tokens.push({ kind: bel || st ? kind : "BAD", at: i, seq: raw.slice(i, end), body: raw.slice(i + 2, j) });
        i = end;
        continue;
      }
      const m = /^\x1b(?:[()*+][0-9A-Za-z]|[0-~])/.exec(raw.slice(i, i + 3));
      tokens.push({ kind: m ? "ESC" : "BAD", at: i, seq: m?.[0] ?? raw.slice(i, i + 2), body: "" });
      i += m ? m[0].length : 1;
      continue;
    }
    if (code < 0x20) tokens.push({ kind: "C0", at: i, seq: raw.charAt(i), body: "" });
    else if (code === 0x7f) tokens.push({ kind: "DEL", at: i, seq: raw.charAt(i), body: "" });
    else if (code >= 0x80 && code <= 0x9f) tokens.push({ kind: "C1", at: i, seq: raw.charAt(i), body: "" });
    i++;
  }
  return tokens;
}

type ScanRules = { copyAt: number | null; safeUrls: readonly string[] };

/** Every control in `raw` that untrusted text could have produced; [] when the stream is clean. */
function violations(raw: string, rules: ScanRules): string[] {
  const found: string[] = [];
  const where = (t: Token) => `${JSON.stringify(t.seq.slice(0, 48))} at ${t.at}`;
  for (const t of scan(raw)) {
    if (t.kind === "CSI" || t.kind === "ESC") continue; // the markers below catch injected ones
    if (t.kind === "C0" && (t.seq === "\r" || t.seq === "\n")) continue;
    if (t.kind === "APC" && t.body === KITTY_DELETE_ALL) continue;
    if (t.kind === "OSC") {
      if (t.body === "11;?") continue; // the startup background-color query
      const link = /^8;[^;]*;(.*)$/s.exec(t.body);
      if (link !== null) {
        const url = link[1] ?? "";
        if (url === "" || rules.safeUrls.includes(url)) continue;
        found.push(`OSC 8 to an unsafe URL ${where(t)}`);
        continue;
      }
      if (t.body.startsWith("52;")) {
        if (rules.copyAt !== null && t.at >= rules.copyAt) continue;
        found.push(`OSC 52 clipboard write before any :copy ${where(t)}`);
        continue;
      }
    }
    found.push(`${t.kind} ${where(t)}`);
  }
  for (const [probe, what] of PROBES) {
    const at = raw.indexOf(probe);
    if (at >= 0) found.push(`seeded control emitted raw (${what}) at ${at}`);
  }
  return found;
}

/** The output with terminal control sequences removed (each changed row is written whole). */
function plainText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b[_P^X][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // APC, DCS, PM, SOS
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>78c]/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

/** Wait (bounded) until the plain text written at or after `from` contains `needle`; resolves with the mark then. */
async function expectPlain(pty: Pty, needle: string | RegExp, from = 0, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = plainText(pty.output().slice(from));
    if (typeof needle === "string" ? text.includes(needle) : needle.test(text)) return pty.mark();
    if (!pty.running())
      throw new Error(`the TUI exited before ${String(needle)}; plain tail: ${JSON.stringify(text.slice(-600))}`);
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${String(needle)}; plain tail: ${JSON.stringify(text.slice(-600))}`);
    }
    await Bun.sleep(10);
  }
}

/** Type keys one input at a time (each is its own read in the TUI), pausing briefly between them. */
async function keys(pty: Pty, ...inputs: string[]): Promise<void> {
  for (const input of inputs) {
    pty.write(input);
    await Bun.sleep(30);
  }
}

/** Type a `:` command line and wait for `needle` in what the TUI draws next. */
async function command(pty: Pty, line: string, needle: string | RegExp): Promise<number> {
  const mark = pty.mark();
  await keys(pty, ":", ...line, "\r");
  return expectPlain(pty, needle, mark);
}

/** The workspace owns the keys again (NORMAL, focus on the list or the document): every overlay closed. */
const WORKSPACE = /NORMAL\s+│ (?:document|tasks) │/;

/** Press `inputs` (closing an overlay or editor) and wait until the workspace status line is back. */
async function backToWorkspace(pty: Pty, ...inputs: string[]): Promise<void> {
  const mark = pty.mark();
  await keys(pty, ...inputs);
  await expectPlain(pty, WORKSPACE, mark);
}

const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;
const ESC = "\x1b";
const TAB = "\t";

/** Type one character every `everyMs` until `work` settles (keeps the draft dirty while it runs). */
async function typeWhile<T>(pty: Pty, char: string, work: Promise<T>, everyMs = 80): Promise<T> {
  let done = false;
  const result = work.finally(() => {
    done = true;
  });
  while (!done) {
    pty.write(char);
    await Bun.sleep(everyMs);
  }
  return result;
}

// ---------- the rebuilt screen (width test) ----------

/** Every row pi-tui wrote, in order: `\x1b[<row>;1H\x1b[2K<line>` up to the next cursor move or frame end. */
function rowWrites(raw: string): { row: number; line: string }[] {
  const writes: { row: number; line: string }[] = [];
  const start = /\x1b\[(\d+);1H\x1b\[2K/g;
  for (let m = start.exec(raw); m !== null; m = start.exec(raw)) {
    const from = m.index + m[0].length;
    const rest = raw.slice(from);
    const stop = rest.search(/\x1b\[\d+;\d+H|\x1b\[\?2026l/);
    writes.push({ row: Number(m[1]), line: stop < 0 ? rest : rest.slice(0, stop) });
  }
  return writes;
}

/** The visible screen after the writes in `raw`: plain text per row. */
function screen(raw: string, rows: number): string[] {
  const out: string[] = Array.from({ length: rows }, () => "");
  for (const { row, line } of rowWrites(raw)) if (row >= 1 && row <= rows) out[row - 1] = plainText(line);
  return out;
}

/** Wait (bounded) until the TUI wrote nothing for `quietMs`, so the last frame is complete. */
async function settle(pty: Pty, quietMs = 200, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = pty.mark();
  let quietSince = Date.now();
  while (Date.now() - quietSince < quietMs) {
    if (Date.now() >= deadline) throw new Error(`the TUI kept writing for ${timeoutMs}ms; tail: ${pty.tail()}`);
    await Bun.sleep(20);
    if (pty.mark() !== last) {
      last = pty.mark();
      quietSince = Date.now();
    }
  }
}

/** Terminal cells of the plain text before the first (or last) `char`; null when absent. */
function columnOf(line: string, char: string, last = false): number | null {
  const at = last ? line.lastIndexOf(char) : line.indexOf(char);
  return at < 0 ? null : Bun.stringWidth(line.slice(0, at));
}

// ---------- the tests ----------

describe("hostile task text in every TUI surface (G5)", () => {
  const box = sandbox("tui-safety");
  let pty: Pty;
  let copyAt = -1;

  beforeAll(async () => {
    await cli(box.env, "lane", "add", LANE, "--color", LANE_COLOR);
    await cli(box.env, "tag", "add", "hostile", "--color", TAG_COLOR);
    await cli(box.env, "add", TITLE, "-b", BODY, "--lane", LANE, "-t", "hostile", "--as", AUTHOR);
    await cli(box.env, "update", "1", "-m", SUMMARY, "-b", UPDATE_BODY, "--as", AUTHOR);
    await cli(box.env, "add", "plain neighbour");
  });

  test("every surface shows the payloads escaped; the session leaves the terminal restored", async () => {
    pty = spawnPty([BIN, "tui", "1"], { env: box.tuiEnv, cols: 130, rows: 50 });
    await pty.expect("TASKS", { timeoutMs: 20_000 });
    // The list, the document header (title, lane, tag) and Read.
    await expectPlain(pty, `ti ${shown("ti", "12")}`);
    await expectPlain(pty, shown("ln", "12", ""));
    await expectPlain(pty, "READ");
    for (const field of ["hd", "bo", "qt", "li", "tb"]) await expectPlain(pty, shown(field, "12"));
    await expectPlain(pty, shown("ic", "23"));
    await expectPlain(pty, "js link (javascript:alert(1)");

    // Edit (the raw source, escaped), Split (editor + preview) and the source view.
    await command(pty, "edit", "EDIT");
    await expectPlain(pty, "```sh");
    await command(pty, "split", "PREVIEW");
    await command(pty, "read", "READ");
    await command(pty, "source", "source (:source renders)");
    await command(pty, "source", "READ");

    // The title edited in place; Esc leaves it.
    await command(pty, "title", "INSERT · the title");
    await backToWorkspace(pty, ESC);

    // Activity (summary, expanded Markdown body, author), Related and Authors.
    await command(pty, "activity", "ACTIVITY · 2 · newest first");
    await expectPlain(pty, `us ${shown("us", "12")}`);
    await expectPlain(pty, shown("au", "12", ""));
    let mark = pty.mark();
    await keys(pty, "\r");
    await expectPlain(pty, `ub ${shown("ub", "12")}`, mark);
    await command(pty, "related", "RELATED");
    await command(pty, "authors", "AUTHORS · 1");
    await command(pty, "read", "READ");

    // Dialogs: lanes (name, color), the lane form's field values, tags (color), links, a y/n confirmation.
    await command(pty, "lanes", "LANES");
    await expectPlain(pty, shown("ln", "12", ""));
    mark = pty.mark();
    await keys(pty, "\r");
    await expectPlain(pty, `EDIT LANE ${shown("ln", "12", "")}`, mark);
    await expectPlain(pty, shown("lc", "1"), mark);
    // Esc leaves the form's INSERT, :q! discards it, q closes the lane list under it.
    await backToWorkspace(pty, ESC, ":", "q", "!", "\r", "q");
    await command(pty, "tags", "TAGS");
    await expectPlain(pty, shown("tc", "2"));
    await backToWorkspace(pty, "q");
    await command(pty, "links", "LINKS IN @1");
    await expectPlain(pty, "javascript:alert(1): not a web link");
    await expectPlain(pty, "file:///etc/passwd: not a web link");
    await backToWorkspace(pty, "q");
    await command(pty, "delete", `Delete @1 ti ${shown("ti", "1")}`);
    await backToWorkspace(pty, "n");

    // The command line: a completed lane name, a lane filter and its summary.
    mark = pty.mark();
    await keys(pty, ":", ..."lane ", TAB);
    await expectPlain(pty, `:lane ${shown("ln", "12", "")}`, mark);
    await keys(pty, ESC);
    mark = pty.mark();
    await keys(pty, ":", ..."heading ", TAB);
    await expectPlain(pty, ":heading hd-hd1-2j", mark);
    await expectPlain(pty, `hd ${shown("hd", "12")}`, mark);
    await keys(pty, ESC);
    mark = pty.mark();
    await keys(pty, ":", ..."filter lane ", TAB, "\r");
    await expectPlain(pty, "1 shown", mark);
    await expectPlain(pty, `lane ${shown("ln", "12", "")}`, mark);
    await command(pty, "clear", "no filters");

    // Errors carrying hostile text: the lane names from the database, a pasted argument, a pasted search.
    await command(pty, "lane nope", `No lane "nope" (lanes: ${shown("ln", "12", "")}`);
    mark = pty.mark();
    await keys(pty, ":", ..."lane ", paste(PASTED), "\r");
    await expectPlain(pty, `No lane "pa ${shown("pa", "12")}`, mark);
    // A pasted search: in the document (its label and message), then in the list (the prompt and the count).
    mark = pty.mark();
    await keys(pty, "/", paste(SEARCHED), "\r");
    await expectPlain(pty, `No match for /se ${shown("se", "12")}`, mark);
    await command(pty, "focus list", "│ tasks │");
    mark = pty.mark();
    await keys(pty, "/", paste(SEARCHED), "\r");
    await expectPlain(pty, "0 shown", mark);
    await command(pty, "clear", "no filters");

    // The composer with a pasted draft; :q! discards it.
    mark = pty.mark();
    await keys(pty, "c");
    await expectPlain(pty, "Post an update", mark);
    mark = pty.mark();
    await keys(pty, paste(COMPOSED));
    await expectPlain(pty, `co ${shown("co", "12")}`, mark);
    await backToWorkspace(pty, ESC, ":", "q", "!", "\r");

    // A live blocked transition by the hostile author flashes, then :messages and :notifications list it all.
    mark = pty.mark();
    await cli(box.env, "update", "1", "-m", BLOCKED, "-s", "blocked", "--as", AUTHOR);
    await expectPlain(pty, `is blocked by ${shown("au", "12", "")}`, mark);
    await command(pty, "activity", `bl ${shown("bl", "12")}`);
    await command(pty, "read", "READ");
    // A hostile name is one long word: inside the :messages box it wraps onto the row after its message's start.
    mark = pty.mark();
    await command(pty, "messages", `[error] No lane "nope" (lanes:`);
    await expectPlain(pty, shown("ln", "12", ""), mark);
    await expectPlain(pty, "[warn] ■ @1 is blocked by", mark);
    await expectPlain(pty, shown("au", "12", ""), mark);
    await backToWorkspace(pty, "q");
    await command(pty, "notifications", "NOTIFICATIONS ·");
    await expectPlain(pty, "open → blocked");
    await expectPlain(pty, `error: No lane "pa ${shown("pa", "1")}`);
    await backToWorkspace(pty, "q");

    // The explicit copy: the only OSC 52 the session may send.
    copyAt = pty.mark();
    await keys(pty, ":", ..."copy 1", "\r");
    await expectPlain(pty, "Copied code block 1", copyAt);

    pty.write(":q!\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
  });

  test("the raw stream holds no emitted control from the payloads, no OSC 52 before :copy and no unsafe OSC 8", () => {
    const raw = pty.output();
    // Reported first, so a leak is named even when the session stopped before :copy.
    expect(violations(raw, { copyAt: copyAt > 0 ? copyAt : null, safeUrls: [SAFE_URL] })).toEqual([]);
    expect(copyAt).toBeGreaterThan(0);
    // Exactly one clipboard write, after :copy, carrying the code block's raw source (base64 cannot break out).
    const clipboard = scan(raw).filter(t => t.kind === "OSC" && t.body.startsWith("52;"));
    expect(clipboard.map(t => t.at >= copyAt)).toEqual([true]);
    const copied = Buffer.from(clipboard[0]?.body.slice("52;c;".length) ?? "", "base64").toString("utf8");
    expect(copied.replace(/\n$/, "")).toBe(CODE);
    // OSC 8 only ever wraps the safe link.
    const urls = new Set(
      scan(raw)
        .filter(t => t.kind === "OSC" && t.body.startsWith("8;"))
        .map(t => t.body.replace(/^8;[^;]*;/, ""))
        .filter(url => url !== ""),
    );
    expect([...urls]).toEqual([SAFE_URL]);
  });

  test("positive control: the scan reports every payload spliced in raw and sees the TUI's own sequences", () => {
    const raw = pty.output();
    const rules: ScanRules = { copyAt, safeUrls: [SAFE_URL] };
    // Splice at a sequence boundary (just before an ESC [), so both halves stay intact and clean.
    const at = raw.indexOf("\x1b[", Math.floor(copyAt / 2));
    expect(at).toBeGreaterThan(0);
    const splice = (text: string): string => raw.slice(0, at) + text + raw.slice(at);
    expect(violations(splice(""), rules)).toEqual([]);
    // Each seeded control, emitted raw in the real stream, is reported.
    expect(PROBES.size).toBeGreaterThan(100);
    for (const [probe, what] of PROBES) expect(violations(splice(probe), rules).length, what).toBeGreaterThan(0);
    // Partial leaks without a marker are reported too: a raw introducer whose terminator was escaped, lone C0/C1.
    for (const partial of ["\x1b]0;pwned^G", "\x1bPpwned", "\x1b_G", "x\x07", "x\x08", "x\x9b2J", "x\x7f"]) {
      expect(violations(splice(partial), rules).length, JSON.stringify(partial)).toBeGreaterThan(0);
    }
    // The rules themselves: OSC 52 before :copy, and OSC 8 to anything but the safe link.
    expect(violations(raw, { copyAt: null, safeUrls: [SAFE_URL] }).join("\n")).toContain("OSC 52 clipboard write");
    expect(violations(raw, { copyAt, safeUrls: [] }).join("\n")).toContain("OSC 8 to an unsafe URL");
    // The real stream holds the TUI's own controls, found by the same tokenizer.
    const tokens = scan(raw);
    const has = (kind: TokenKind, seq: string) => tokens.some(t => t.kind === kind && t.seq === seq);
    expect(has("CSI", "\x1b[?1049h")).toBe(true); // alternate screen
    expect(has("CSI", "\x1b[2J")).toBe(true); // its own full-redraw erase: why every payload carries a marker
    expect(has("OSC", `\x1b]8;;${SAFE_URL}\x1b\\`)).toBe(true); // the safe link
    expect(tokens.filter(t => t.kind === "OSC" && t.body.startsWith("52;")).length).toBe(1);
  });

  test("the database still holds the raw source: display escaping never rewrote a field", async () => {
    type Shown = {
      task: { title: string; body: string; lane: string; tags: string[] };
      updates: { summary: string; body: string | null; author: string }[];
    };
    const shownTask = JSON.parse(await cli(box.env, "show", "1", "--json")) as Shown;
    expect(shownTask.task.title).toBe(TITLE);
    expect(shownTask.task.body).toBe(BODY);
    expect(shownTask.task.lane).toBe(LANE);
    const summaries = shownTask.updates.map(u => [u.summary, u.body, u.author]);
    expect(summaries).toContainEqual([SUMMARY, UPDATE_BODY, AUTHOR]);
    expect(summaries.some(([summary]) => summary === BLOCKED)).toBe(true);
    // The composer draft was discarded, never posted.
    expect(shownTask.updates.some(u => u.summary.includes("co co1"))).toBe(false);
  });

  test("a conflicting remote edit shows its hostile text escaped, and :apply takes it byte for byte", async () => {
    const CONFLICT = `cf ${hostile("cf")}`;
    const session = spawnPty([BIN, "tui", "2"], { env: box.tuiEnv, cols: 130, rows: 50 });
    await session.expect("TASKS", { timeoutMs: 20_000 });
    let mark = session.mark();
    await keys(session, ":", ..."edit", "\r", TAB);
    await expectPlain(session, "EDIT", mark);
    await keys(session, "i");
    // Keep typing while the CLI edits the same body, so the draft is dirty when the change arrives.
    mark = session.mark();
    await typeWhile(session, "y", cli(box.env, "edit", "2", "-b", CONFLICT));
    await expectPlain(session, `changed elsewhere (conflict): cf ${shown("cf", "12")}`, mark);
    mark = session.mark();
    await keys(session, ESC, ":", ..."apply", "\r");
    await expectPlain(session, `1 cf ${shown("cf", "12")}`, mark);
    session.write(":q!\r");
    expect(await session.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(session.localFlags())).toBe(true);
    expect(violations(session.output(), { copyAt: null, safeUrls: [SAFE_URL] })).toEqual([]);
    const task = JSON.parse(await cli(box.env, "show", "2", "--json")) as { task: { body: string } };
    expect(task.task.body).toBe(CONFLICT);
  });
});

describe("Unicode width keeps the layout aligned (G5)", () => {
  const TITLE_WIDE = "漢字タイトル 한국어 ✅ 🚀 👩‍👩‍👧 🇯🇵 👍🏽 cafe\u0301 ｆｕｌｌ ワイド";
  const TITLE_ODD = `x${TITLE_WIDE}`;
  const BODY_WIDE = [
    "# 見出し 👩‍👩‍👧",
    "",
    `${"漢字かな交じり文".repeat(12)} ${"👍🏽🇯🇵✅".repeat(8)} x${"한국어".repeat(10)}`,
    "",
    "| 名前 | 値 |",
    "|---|---|",
    "| 漢字 | ✅ |",
    "| x | 👩‍👩‍👧 ｆｕｌｌ |",
  ].join("\n");

  /** Every row the TUI wrote fits the width; the list/document divider sits in one column. */
  function checkLayout(raw: string, cols: number, rows: number, twoPanes: boolean): string[] {
    const tooWide = rowWrites(raw)
      .map(({ row, line }) => ({ row, width: Bun.stringWidth(plainText(line)) }))
      .filter(w => w.width > cols);
    expect(tooWide).toEqual([]);
    const lines = screen(raw, rows);
    if (twoPanes) {
      // Every body row (the status and hint rows and the comfortable blank row above them excepted) has the
      // divider in the same column.
      const dividers = new Set(lines.slice(0, rows - 3).map(line => columnOf(line, "│")));
      expect([...dividers]).toHaveLength(1);
      expect([...dividers][0]).not.toBeNull();
      expect(lines[rows - 3]?.trim()).toBe("");
    }
    // The table's right border sits in one column on every table row.
    const top = lines.findIndex(line => line.includes("┌"));
    const bottom = lines.findIndex(line => line.includes("└"));
    if (top >= 0 && bottom > top) {
      const right = new Set(
        lines
          .slice(top, bottom + 1)
          .map(line => Math.max(...["┐", "┤", "┘", "│"].map(c => columnOf(line, c, true) ?? -1))),
      );
      expect([...right]).toHaveLength(1);
    }
    return lines;
  }

  test("the layout checks catch a misaligned divider and an over-wide row (negative control)", () => {
    const aligned = "\x1b[1;1H\x1b[2Kab│cd\x1b[2;1H\x1b[2K漢│x";
    const shifted = "\x1b[1;1H\x1b[2Kab│cd\x1b[2;1H\x1b[2K漢字│x";
    expect(new Set(screen(aligned, 2).map(line => columnOf(line, "│"))).size).toBe(1);
    expect(new Set(screen(shifted, 2).map(line => columnOf(line, "│"))).size).toBe(2);
    expect(rowWrites("\x1b[1;1H\x1b[2K漢字漢字").map(w => Bun.stringWidth(plainText(w.line)))).toEqual([8]);
  });

  test("CJK, emoji and combining text at 100x30, 80x24 and 120x40: no row overflows, dividers and borders align", async () => {
    const box = sandbox("tui-width");
    await cli(box.env, "add", TITLE_WIDE, "-b", BODY_WIDE);
    await cli(box.env, "add", TITLE_ODD);
    await cli(box.env, "add", "plain ascii task");
    const pty = spawnPty([BIN, "tui", "1"], { env: box.tuiEnv, cols: 100, rows: 30 });
    await pty.expect("TASKS", { timeoutMs: 20_000 });
    await expectPlain(pty, "見出し");
    await expectPlain(pty, "plain ascii task");
    await settle(pty);
    let lines = checkLayout(pty.output(), 100, 30, true);
    // Inside the pane, the list wraps the selected wide title and truncates the other at a grapheme boundary.
    expect(lines.some(line => line.includes("@1  漢字タイトル"))).toBe(true);
    expect(lines.some(line => line.includes("@2  x漢字タイトル"))).toBe(true);

    // 80x24: one pane at a time; the document wraps the wide paragraph within it.
    let mark = pty.mark();
    pty.resize(80, 24);
    await pty.expect("\x1b[24;1H", { from: mark });
    await expectPlain(pty, "TASKS", mark);
    await settle(pty);
    checkLayout(pty.output().slice(mark), 80, 24, false);
    mark = pty.mark();
    await keys(pty, TAB);
    await expectPlain(pty, " READ ", mark);
    await settle(pty);
    checkLayout(pty.output().slice(mark), 80, 24, false);

    // 120x40: two panes again, the table fully in view.
    mark = pty.mark();
    pty.resize(120, 40);
    await pty.expect("\x1b[40;1H", { from: mark });
    await expectPlain(pty, "名前", mark);
    await settle(pty);
    lines = checkLayout(pty.output().slice(mark), 120, 40, true);
    expect(lines.some(line => line.includes("┌"))).toBe(true);

    pty.write(":q\r");
    expect(await pty.exited()).toEqual({ code: 0, signal: null });
    expect(isCooked(pty.localFlags())).toBe(true);
    // The source round-trips untouched.
    const shownTask = JSON.parse(await cli(box.env, "show", "1", "--json")) as {
      task: { title: string; body: string };
    };
    expect(shownTask.task.title).toBe(TITLE_WIDE);
    expect(shownTask.task.body).toBe(BODY_WIDE);
  });
});
