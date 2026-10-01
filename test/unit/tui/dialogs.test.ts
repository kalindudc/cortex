import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Component, type OverlayHandle, type OverlayOptions, visibleWidth } from "@earendil-works/pi-tui";
import type { CortexClient, DaemonIdentity, WorkspaceSnapshot } from "../../../src/contracts.ts";
import type { Task } from "../../../src/store.ts";
import { DEFAULT_CONFIG } from "../../../src/tui/config.ts";
import {
  DIALOG_MARGIN,
  Dialog,
  type DialogRow,
  drawBox,
  type FormSpec,
  type ListSpec,
  paneBox,
  showDialog,
} from "../../../src/tui/dialogs.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";
import { WHEEL_NOTCH_MS } from "../../../src/tui/mouse.ts";
import { openPreferences } from "../../../src/tui/preferences.ts";
import { type OverlayHost, TuiSession } from "../../../src/tui/session.ts";
import { paint, resolveTheme, seg } from "../../../src/tui/theme.ts";

// Plan @400 N17/N19 (Task 8, part B): dialogs are keyboard-complete overlays
// that own input and return focus when they close. Lists: j/k and Enter, `/`
// filters (uncapped literal AND keywords), q/Esc close. Confirmations: y/n.
// Forms open in INSERT; in their NORMAL mode Esc and q mean :q; :w submits,
// :q! discards; create/management forms refuse :q while they hold input and
// make other commands wait. `:` works inside dialogs.

const DB = "0b6a2f4e-0c1d-4e5f-8a9b-1c2d3e4f5a6b";
const IDENTITY: DaemonIdentity = {
  protocol: 1,
  instanceId: "instance-1",
  databaseId: DB,
  databasePath: "/tmp/cortex.db",
  endpoint: { kind: "unix", socketPath: "/tmp/cortex-x.sock" },
  pid: 4242,
};

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body: null,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  ...over,
});

/** The toolkit's overlay stack, reduced to what dialogs rely on: the top visible overlay owns the keyboard. */
function fakeHost(columns = 100, rows = 30) {
  const stack: { component: Component; options: OverlayOptions | undefined; hidden: boolean }[] = [];
  const top = () => stack.filter(e => !e.hidden).at(-1) ?? null;
  const host: OverlayHost = {
    columns: () => columns,
    rows: () => rows,
    showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
      const entry = { component, options, hidden: false };
      stack.push(entry);
      return {
        hide: () => {
          const at = stack.indexOf(entry);
          if (at >= 0) stack.splice(at, 1);
        },
        setHidden: hidden => {
          entry.hidden = hidden;
        },
        isHidden: () => entry.hidden,
        focus: () => {},
        unfocus: () => {},
        isFocused: () => top() === entry,
        getBounds: () => undefined,
      };
    },
  };
  return { host, stack, focused: () => top()?.component ?? null };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-dialogs-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(tasks: Task[] = [task(1), task(2)], now?: () => number) {
  const snapshot: WorkspaceSnapshot = {
    identity: IDENTITY,
    cursor: "e:1",
    tasks,
    lanes: [],
    tags: [],
    notifications: [],
  };
  const quits: boolean[] = [];
  const session = new TuiSession({
    client: { workspace: async () => snapshot } as unknown as CortexClient,
    identity: IDENTITY,
    keys: DEFAULT_KEYS,
    preferences: openPreferences(path.join(dir, "tui", "default.state.json")),
    schedule: () => () => {},
    now,
    onQuit: force => quits.push(force),
  });
  session.applySnapshot(snapshot);
  session.setTheme(resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" } }));
  const fake = fakeHost();
  session.setOverlayHost(fake.host);
  /** Type inputs the way the toolkit delivers them to the focused component. */
  const type = (...inputs: string[]) => {
    for (const input of inputs) session.input(input);
  };
  return { session, fake, type, quits };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const plain = (lines: string[]): string => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
const FUNCTION_KEY = /\bF(?:[1-9]|[12][0-9]|3[0-5])\b/;

const rows = (...labels: string[]): DialogRow[] => labels.map(label => ({ key: label, label }));

function listSpec(over: Partial<ListSpec> = {}): ListSpec & { picked: string[]; dismissed: number } {
  const spec = {
    kind: "list" as const,
    title: "Pick one",
    label: "picker",
    pickLabel: "picks",
    rows: () => rows("alpha", "beta", "gamma"),
    picked: [] as string[],
    dismissed: 0,
    pick(row: DialogRow) {
      spec.picked.push(row.key);
    },
    dismiss() {
      spec.dismissed++;
    },
    ...over,
  };
  return spec;
}

describe("list dialogs", () => {
  test("j/k and arrows move, Enter picks, and the overlay owns the keyboard until q or Esc hands it back", () => {
    const { session, fake, type } = setup();
    const spec = listSpec();
    const overlay = showDialog(session, spec);
    expect(fake.focused()).toBe(overlay.dialog);
    expect(session.dialog).toBe(overlay.dialog);
    expect(overlay.dialog.highlighted()?.key).toBe("alpha");
    type("j", "j");
    expect(overlay.dialog.highlighted()?.key).toBe("gamma");
    type("j"); // clamped at the end
    expect(overlay.dialog.highlighted()?.key).toBe("gamma");
    type("k", "\x1b[A");
    expect(overlay.dialog.highlighted()?.key).toBe("alpha");
    type("G");
    expect(overlay.dialog.highlighted()?.key).toBe("gamma");
    type("\r");
    expect(spec.picked).toEqual(["gamma"]);
    // The workspace did not move underneath.
    expect(session.selectedTask()?.id).toBe(1);
    type("q");
    expect(session.dialog).toBeNull();
    expect(fake.focused()).toBeNull();
    expect(spec.dismissed).toBe(1);
    const again = showDialog(session, listSpec());
    type("\x1b");
    expect(session.dialog).toBeNull();
    expect(again.dialog.closed).toBe(true);
  });

  test("/ filters with the uncapped literal, case-insensitive AND-keyword search", () => {
    const { session, type } = setup();
    const many = Array.from({ length: 500 }, (_, i) => ({
      key: `k${i}`,
      label: `Item ${i}`,
      detail: i % 2 ? "odd" : "even",
    }));
    const spec = listSpec({ rows: () => many });
    const { dialog } = showDialog(session, spec);
    expect(dialog.visibleRows().length).toBe(500);
    type("/", ..."ITEM odd", "\r");
    expect(dialog.filter).toBe("ITEM odd");
    // Every match, never capped or paginated away.
    expect(dialog.visibleRows().length).toBe(250);
    expect(dialog.highlighted()?.key).toBe("k1");
    type("G");
    expect(dialog.highlighted()?.key).toBe("k499");
    expect(plain(dialog.render(80))).toContain("250 of 500");
    // Literal: regex characters are just text; AND: every keyword must match.
    type("/", ..."item .*", "\r");
    expect(dialog.visibleRows().length).toBe(0);
    expect(plain(dialog.render(80))).toContain("0 of 500");
    type("/", "\r");
    expect(dialog.visibleRows().length).toBe(500);
  });

  test("the list's own letter keys act on the highlighted row, before any NORMAL binding", () => {
    const { session, type } = setup();
    const used: string[] = [];
    const spec = listSpec({
      keys: [
        { key: "d", label: "delete", row: true, run: row => void used.push(`d:${row?.key}`) },
        { key: "a", label: "add", run: () => void used.push("a") },
      ],
    });
    const { dialog } = showDialog(session, spec);
    type("j", "d", "a");
    expect(used).toEqual(["d:beta", "a"]);
    expect(plain(dialog.render(80))).toMatch(/d delete/);
    // Other printable keys do nothing (NORMAL never inserts text).
    type("z");
    expect(dialog.highlighted()?.key).toBe("beta");
  });

  test("rows are read live and the highlight follows its row by key", () => {
    const { session, type } = setup();
    let live = rows("alpha", "beta", "gamma");
    const { dialog } = showDialog(session, listSpec({ rows: () => live }));
    type("j", "j");
    expect(dialog.highlighted()?.key).toBe("gamma");
    live = rows("gamma", "alpha");
    expect(dialog.highlighted()?.key).toBe("gamma");
    live = rows("alpha");
    expect(dialog.highlighted()?.key).toBe("alpha");
  });

  test("`:` works inside a dialog: :q closes the top dialog only, and other commands close it first", async () => {
    const { session, type, quits } = setup();
    showDialog(session, listSpec());
    type(":", "q", "\r");
    await settle();
    expect(session.dialog).toBeNull();
    expect(quits).toEqual([]);
    showDialog(session, listSpec());
    type(":", ..."2", "\r");
    await settle();
    expect(session.dialog).toBeNull();
    expect(session.selectedId).toBe(2);
    type(":", "q", "\r");
    await settle();
    expect(quits).toEqual([false]);
  });

  test("a highlight callback previews each row as it is highlighted; dismiss undoes it", () => {
    const { session, type } = setup();
    const seen: (string | null)[] = [];
    const spec = listSpec({ highlight: row => void seen.push(row?.key ?? null) });
    showDialog(session, spec);
    type("j", "j", "k");
    expect(seen).toEqual(["beta", "gamma", "beta"]);
    type("\x1b");
    expect(spec.dismissed).toBe(1);
  });
});

describe("confirmations", () => {
  test("y confirms; n, Esc and q cancel; other keys (Enter included) never confirm", async () => {
    const { session, type } = setup();
    let yes = 0;
    let no = 0;
    const open = () =>
      showDialog(session, {
        kind: "confirm",
        title: "Delete @1",
        label: "delete",
        message: ["Delete @1 task 1?"],
        yes: "deletes it",
        no: "keeps it",
        confirm: () => {
          yes++;
        },
        dismiss: () => {
          no++;
        },
      });
    for (const cancel of ["n", "N", "\x1b", "q"]) {
      open();
      type("\r", "j", "x", cancel);
      await settle();
      expect(session.dialog).toBeNull();
    }
    expect([yes, no]).toEqual([0, 4]);
    const { dialog } = open();
    expect(plain(dialog.render(60))).toMatch(/y deletes it · n keeps it/);
    type("y");
    await settle();
    expect([yes, no]).toEqual([1, 4]);
    expect(session.dialog).toBeNull();
  });

  test("n answers the question even though NORMAL binds n to the next search result", async () => {
    const { session, type } = setup();
    session.setQuery("task");
    let no = 0;
    showDialog(session, {
      kind: "confirm",
      title: "Sure?",
      label: "confirm",
      message: ["Really?"],
      yes: "yes",
      confirm: () => {},
      dismiss: () => {
        no++;
      },
    });
    type("n");
    expect(no).toBe(1);
    expect(session.selectedTask()?.id).toBe(1);
  });
});

function formSpec(over: Partial<FormSpec> = {}): FormSpec & { submitted: Record<string, string>[] } {
  const spec = {
    kind: "form" as const,
    title: "New lane",
    label: "new lane",
    guarded: true,
    submitLabel: "creates",
    fields: [
      { name: "name", label: "Name", value: "" },
      { name: "color", label: "Color", value: "", hint: "#rrggbb" },
    ],
    submitted: [] as Record<string, string>[],
    submit: async (values: Readonly<Record<string, string>>) => {
      spec.submitted.push({ ...values });
      return true;
    },
    ...over,
  };
  return spec;
}

describe("forms", () => {
  test("open in INSERT: printable keys (j, q, : included) are text, Tab moves between fields, Enter submits", async () => {
    const { session, type } = setup();
    const spec = formSpec();
    const { dialog } = showDialog(session, spec);
    expect(session.keys.mode()).toBe("INSERT");
    type(..."jq:x", "\x7f", "\t", ..."#2563eb");
    expect(dialog.values()).toEqual({ name: "jq:", color: "#2563eb" });
    type("\x1b[Z", "!");
    expect(dialog.values().name).toBe("jq:!");
    type("\r");
    await settle();
    expect(spec.submitted).toEqual([{ name: "jq:!", color: "#2563eb" }]);
    expect(session.dialog).toBeNull();
    expect(session.keys.mode()).toBe("NORMAL");
  });

  test("Esc leaves to the form's NORMAL mode; there j/k move, i edits again, and Esc or q mean :q", async () => {
    const { session, type } = setup();
    const { dialog } = showDialog(session, formSpec());
    type("\x1b");
    expect(session.keys.mode()).toBe("NORMAL");
    expect(session.dialog).toBe(dialog);
    type("j", "i", ..."#fff");
    expect(dialog.values().color).toBe("#fff");
    type("\x1b", "q"); // :q, refused: the form holds input
    expect(session.dialog).toBe(dialog);
    expect(session.status?.text).toMatch(/unsaved input.*:w.*:q!/);
    type("\x1b"); // Esc is :q as well
    expect(session.dialog).toBe(dialog);
    // Without input, Esc closes it.
    const empty = showDialog(session, formSpec());
    type("\x1b", "\x1b");
    expect(empty.dialog.closed).toBe(true);
    expect(session.dialog).toBe(dialog);
  });

  test("a create/management form with input refuses :q and makes other commands wait; :q! discards", async () => {
    const { session, type, quits } = setup();
    const spec = formSpec();
    const { dialog } = showDialog(session, spec);
    type(..."later", "\x1b");
    type(":", "q", "\r");
    await settle();
    expect(session.dialog).toBe(dialog);
    expect(session.status?.text).toMatch(/new lane form has unsaved input/);
    type(":", ..."2", "\r");
    await settle();
    expect(session.selectedTask()?.id).toBe(1);
    expect(session.status?.text).toMatch(/waits.*:w saves it.*:q! discards it/);
    expect(dialog.blocksCommands()).toBe(true);
    type(":", "q", "!", "\r");
    await settle();
    expect(dialog.closed).toBe(true);
    expect(spec.submitted).toEqual([]);
    expect(quits).toEqual([]);
  });

  test(":w, :wq and Ctrl-s submit; a failed submit keeps the draft and shows the error in the form", async () => {
    const { session, type } = setup();
    let fail = true;
    const spec = formSpec({
      submit: async values => {
        if (fail) throw new Error(`lane ${values.name} already exists`);
        return true;
      },
    });
    const { dialog } = showDialog(session, spec);
    type(..."now", "\x13");
    await settle();
    expect(dialog.closed).toBe(false);
    expect(dialog.values().name).toBe("now");
    expect(plain(dialog.render(70))).toContain("lane now already exists");
    expect(session.status?.level).toBe("error");
    type("\x1b", ":", "w", "\r");
    await settle();
    expect(dialog.closed).toBe(false);
    fail = false;
    type(":", "w", "q", "\r");
    await settle();
    expect(dialog.closed).toBe(true);
  });

  test("a rebase keeps the draft over new incoming values (the conflict path)", async () => {
    const { session, type } = setup();
    let first = true;
    const spec = formSpec({
      fields: [{ name: "name", label: "Name", value: "old" }],
      submit: async (_values, form) => {
        if (first) {
          first = false;
          form.rebase({ name: "theirs" });
          throw new Error("changed meanwhile");
        }
        return true;
      },
    });
    const { dialog } = showDialog(session, spec);
    type("\x15", ..."mine", "\r");
    await settle();
    expect(dialog.values().name).toBe("mine");
    expect(dialog.baseline().name).toBe("theirs");
    expect(dialog.hasDraft()).toBe(true);
    type("\r");
    await settle();
    expect(dialog.closed).toBe(true);
  });

  test("pasted line breaks become spaces; a locked field explains itself and takes no input", () => {
    const { session, type } = setup();
    const { dialog } = showDialog(
      session,
      formSpec({
        fields: [
          { name: "name", label: "Name", value: "now", locked: "the now lane cannot be renamed" },
          { name: "color", label: "Color", value: "" },
        ],
      }),
    );
    type("\x1b[200~#12\n34\r\n56\x1b[201~");
    expect(dialog.values()).toEqual({ name: "now", color: "#12 34 56" });
    expect(plain(dialog.render(80))).toContain("the now lane cannot be renamed");
  });
});

describe("the wheel", () => {
  test("one notch moves one row (a list) or one field (a form), however many reports the terminal sends for it", () => {
    // Ghostty reports one notch as mouse-scroll-multiplier (3 by default) wheel reports; a multiplexer forwards each.
    let now = 1_000;
    const { session, type } = setup(undefined, () => now);
    const notch = (dialog: Dialog, direction: 1 | -1 = 1) => {
      for (let i = 0; i < 3; i++) {
        const event = { type: "wheel", button: "none", x: 1, y: 1, wheelDelta: direction };
        expect(dialog.handleMouse(event as never)).toEqual({ handled: true });
      }
    };
    const list = showDialog(session, listSpec());
    notch(list.dialog);
    expect(list.dialog.highlighted()?.key).toBe("beta");
    now += WHEEL_NOTCH_MS;
    notch(list.dialog);
    expect(list.dialog.highlighted()?.key).toBe("gamma");
    notch(list.dialog, -1); // the other way is a new notch at once
    expect(list.dialog.highlighted()?.key).toBe("beta");
    type("q");
    const form = showDialog(
      session,
      formSpec({
        fields: [
          { name: "name", label: "Name", value: "" },
          { name: "color", label: "Color", value: "" },
          { name: "note", label: "Note", value: "" },
        ],
      }),
    );
    now += WHEEL_NOTCH_MS;
    notch(form.dialog);
    type("x"); // INSERT: typed into the field the notch moved to
    expect(form.dialog.values()).toEqual({ name: "", color: "x", note: "" });
  });
});

describe("focus return", () => {
  test("closing the top dialog hands the keyboard to the one below in its own mode, then to the workspace", async () => {
    const { session, fake, type } = setup();
    session.setFocus("document");
    const list = showDialog(session, listSpec());
    const form = showDialog(session, formSpec());
    expect(fake.focused()).toBe(form.dialog);
    expect(session.keys.mode()).toBe("INSERT");
    type("\x1b", "\x1b"); // NORMAL, then :q (no input: closes)
    expect(fake.focused()).toBe(list.dialog);
    expect(session.dialog).toBe(list.dialog);
    expect(session.keys.mode()).toBe("NORMAL");
    // The form below a list keeps its INSERT mode when the list above it closes.
    const form2 = showDialog(session, formSpec());
    type("\x1b"); // NORMAL
    type("i");
    const top = showDialog(session, listSpec());
    expect(session.keys.mode()).toBe("NORMAL");
    type("q");
    expect(session.dialog).toBe(form2.dialog);
    expect(session.keys.mode()).toBe("INSERT");
    session.closeDialogs();
    expect(top.dialog.closed && form2.dialog.closed && list.dialog.closed).toBe(true);
    expect(fake.focused()).toBeNull();
    expect(session.keys.mode()).toBe("NORMAL");
    // Dialogs never move the workspace focus.
    expect(session.focus).toBe("document");
  });

  test("hide() on the returned overlay handle closes the dialog like q", () => {
    const { session, fake } = setup();
    const spec = listSpec();
    const overlay = showDialog(session, spec);
    overlay.hide();
    expect(overlay.dialog.closed).toBe(true);
    expect(session.dialog).toBeNull();
    expect(fake.stack.length).toBe(0);
    expect(spec.dismissed).toBe(1);
  });

  test("the overlay leaves room for the status line, the prompt and its completions", () => {
    const { session, fake } = setup();
    showDialog(session, listSpec());
    const options = fake.stack[0]?.options;
    expect(options?.anchor).toBe("center");
    expect(typeof options?.margin === "object" ? options.margin.bottom : 0).toBe(DIALOG_MARGIN.bottom);
    expect(DIALOG_MARGIN.bottom).toBeGreaterThanOrEqual(7);
  });

  test("showDialog without a terminal to draw on refuses", () => {
    const { session } = setup();
    session.setOverlayHost(null);
    expect(() => showDialog(session, listSpec())).toThrow(/terminal/);
  });
});

describe("rendering (N20, P9)", () => {
  test("every line is exactly the overlay width; untrusted text is escaped; no function-key hints", () => {
    const { session } = setup();
    const hostile = "evil\x1b]52;c;SGVsbG8=\x07\x1b[2J\x9b31m";
    const { dialog } = showDialog(
      session,
      listSpec({ title: `T${hostile}`, rows: () => [{ key: "x", label: hostile, detail: hostile, mark: "[x]" }] }),
    );
    for (const width of [40, 64, 90]) {
      const lines = dialog.render(width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const joined = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
      expect(joined).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      expect(joined).toContain("evil^[]52;c;SGVsbG8=^G");
      expect(joined).not.toMatch(FUNCTION_KEY);
    }
  });

  test("the highlight and row states are text (a marker and marks), never color alone", () => {
    const { session, type } = setup();
    const { dialog } = showDialog(
      session,
      listSpec({
        rows: () => [
          { key: "a", label: "attached", mark: "[x]" },
          { key: "b", label: "free", mark: "[ ]" },
        ],
      }),
    );
    type("j");
    const text = plain(dialog.render(50));
    expect(text).toMatch(/\[x\] attached/);
    expect(text).toMatch(/▌\[ \] free/);
  });

  test("a form's focused field carries the cursor marker only while typing (IME placement)", () => {
    const { session, type } = setup();
    const { dialog } = showDialog(session, formSpec());
    dialog.focused = true;
    expect(dialog.render(60).join("")).toContain("\x1b_pi:c\x07");
    type("\x1b");
    expect(dialog.render(60).join("")).not.toContain("\x1b_pi:c\x07");
    expect(dialog).toBeInstanceOf(Dialog);
  });
});

describe("pane sizes: one centred placement", () => {
  test("paneBox: small, medium and large widths and heights at three terminal sizes", () => {
    expect(paneBox("small", 150, 40)).toEqual({ width: 60, height: 32 });
    expect(paneBox("medium", 150, 40)).toEqual({ width: 76, height: 32 });
    // Large: 120 at most, and 80% of the rows (40 - 8 margin rows = floor(40 * 0.8) = 32).
    expect(paneBox("large", 150, 40)).toEqual({ width: 120, height: 32 });
    expect(paneBox("large", 100, 30).width).toBe(80);
    // At 80 x 24 every size fits inside the side margins, and large is never narrower than medium.
    expect(paneBox("small", 80, 24)).toEqual({ width: 60, height: 16 });
    expect(paneBox("medium", 80, 24)).toEqual({ width: 76, height: 16 });
    expect(paneBox("large", 80, 24)).toEqual({ width: 76, height: 16 });
    for (const size of ["small", "medium", "large"] as const) {
      expect(paneBox(size, 80, 24).width).toBeLessThanOrEqual(80 - DIALOG_MARGIN.left - DIALOG_MARGIN.right);
    }
  });

  test("showDialog centres every dialog: lists are medium, confirmations and forms small, large on request", () => {
    const { session, fake } = setup();
    showDialog(session, listSpec());
    expect(fake.stack.at(-1)?.options).toMatchObject({ anchor: "center", width: 76 });
    showDialog(session, {
      kind: "confirm",
      title: "Sure?",
      label: "confirm",
      message: ["Really?"],
      yes: "yes",
      confirm: () => {},
    });
    expect(fake.stack.at(-1)?.options).toMatchObject({ anchor: "center", width: 60 });
    showDialog(session, formSpec());
    expect(fake.stack.at(-1)?.options).toMatchObject({ anchor: "center", width: 60 });
    const big = fakeHost(150, 40);
    session.setOverlayHost(big.host);
    showDialog(session, listSpec(), "large");
    expect(big.stack.at(-1)?.options).toMatchObject({ anchor: "center", width: 120, maxHeight: 32 });
  });

  test("drawBox frames painted body lines at exactly the box width and escapes the title", () => {
    const theme = resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" } });
    const width = 40;
    const body = ["one", "two"].map(text => paint(theme, [seg("text@raised", text)], width - 2, "text@raised"));
    const lines = drawBox(theme, "TITLE", body, width);
    expect(lines.length).toBe(body.length + 2);
    for (const line of lines) expect(visibleWidth(line)).toBe(width);
    expect(plain(lines).split("\n")[0]).toStartWith("╭─ TITLE");
    const hostile = plain(drawBox(theme, "evil\x1b[31m", body, width));
    expect(hostile).not.toContain("\x1b");
    expect(hostile).toContain("evil^[[31m");
  });
});
