// @vitest-environment jsdom
import { useCallback, useState, type ReactNode } from "react";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { PersistentResponsiveDrawerShell } from "./components/ui/responsive-overlay";
import { Segmented } from "./ui/parts";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Drawer({ open, name, onClose, children }: { open: boolean; name: string; onClose: () => void; children: ReactNode }) {
  return <PersistentResponsiveDrawerShell open={open} srLabel={name} onOpenChange={next => { if (!next) onClose(); }} motionDurationMs={0}>{children}</PersistentResponsiveDrawerShell>;
}
const tab = (shiftKey = false) => fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey });

test.each([false, true])("React child Tab cancellation wins before owned drawer traversal (reverse=%s)", async reverse => {
  const seen: Array<{ prevented: boolean; focused: Element | null }> = [];
  const component = () => <Drawer open name="React editor drawer" onClose={vi.fn()}><button>Before</button><input aria-label="Editor" onKeyDown={event => {
    if (event.key === "Tab") { seen.push({ prevented: event.defaultPrevented, focused: document.activeElement }); event.preventDefault(); }
  }} /><button>Next</button></Drawer>;
  const slot = renderSlot({ component }, {}, {});
  const drawer = await slot.findByRole("dialog");
  const editor = within(drawer).getByRole("textbox", { name: "Editor" }); editor.focus();
  expect(tab(reverse)).toBe(false);
  expect(document.activeElement).toBe(editor);
  expect(seen).toEqual([{ prevented: false, focused: editor }]);
});

test("React native-event-only Tab cancellation remains respected", async () => {
  const component = () => <Drawer open name="Native-event editor drawer" onClose={vi.fn()}><input aria-label="Editor" onKeyDown={event => { if (event.key === "Tab") event.nativeEvent.preventDefault(); }} /><button>Next</button></Drawer>;
  const slot = renderSlot({ component }, {}, {});
  const drawer = await slot.findByRole("dialog");
  const editor = within(drawer).getByRole("textbox", { name: "Editor" }); editor.focus();
  expect(tab()).toBe(false); expect(document.activeElement).toBe(editor);
});

test("native child Tab cancellation remains respected", async () => {
  const component = () => <Drawer open name="Native editor drawer" onClose={vi.fn()}><input aria-label="Editor" /><button>Next</button></Drawer>;
  const slot = renderSlot({ component }, {}, {});
  const drawer = await slot.findByRole("dialog");
  const editor = within(drawer).getByRole("textbox", { name: "Editor" });
  editor.addEventListener("keydown", event => event.preventDefault()); editor.focus();
  expect(tab()).toBe(false); expect(document.activeElement).toBe(editor);
});

test("shared document-order control sees descendant React cancellation before traversing", async () => {
  const component = () => <div role="dialog"><input aria-label="Editor" onKeyDown={event => event.preventDefault()} /><button>Next</button></div>;
  const slot = renderSlot({ component }, {}, {});
  const drawer = await slot.findByRole("dialog");
  const editor = within(drawer).getByRole("textbox", { name: "Editor" }), next = within(drawer).getByRole("button", { name: "Next" });
  const dispatcher = vi.fn((event: KeyboardEvent) => { if (event.key === "Tab" && !event.defaultPrevented) { event.preventDefault(); next.focus(); } });
  document.addEventListener("keydown", dispatcher);
  try {
    editor.focus(); expect(tab()).toBe(false); expect(document.activeElement).toBe(editor);
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher.mock.calls[0]![0].defaultPrevented).toBe(true);
  } finally { document.removeEventListener("keydown", dispatcher); }
});

test("drawer traversal excludes negative-tabindex native and roving controls, disabled controls and inert/hidden groups", async () => {
  const component = () => <Drawer open name="Owned drawer" onClose={vi.fn()}>
    <button>First</button><button tabIndex={-1}>Roving inactive</button><button tabIndex={-2}>Negative button</button><input aria-label="Negative input" tabIndex={-1} /><a href="#" tabIndex={-1}>Negative link</a>
    <button disabled tabIndex={0}>Disabled</button><fieldset disabled><button>Inherited disabled</button></fieldset><div inert><button>Inert</button></div><div aria-hidden="true"><button>Hidden</button></div>
    <button role="radio" aria-checked="true" tabIndex={0}>Roving active</button><button>Last</button>
  </Drawer>;
  const slot = renderSlot({ component }, {}, {});
  const drawer = await slot.findByRole("dialog");
  const first = within(drawer).getByRole("button", { name: "First" });
  const active = within(drawer).getByRole("radio", { name: "Roving active" });
  const last = within(drawer).getByRole("button", { name: "Last" });
  tab(); expect(document.activeElement).toBe(first);
  tab(); expect(document.activeElement).toBe(active);
  tab(); expect(document.activeElement).toBe(last);
  tab(); expect(document.activeElement).toBe(first);
  tab(true); expect(document.activeElement).toBe(last);
  tab(true); expect(document.activeElement).toBe(active);
  tab(true); expect(document.activeElement).toBe(first);
});

test.each(["below", "above", "visible"])("drawer Tab reveals a %s target only within its nearest owned scrollport", async placement => {
  const component = () => <Drawer open name="Scroll drawer" onClose={vi.fn()}><button>Before</button><div data-test-scrollport="" style={{ overflowY: "auto", height: 300 }}><input aria-label="Title" /></div><button>After</button></Drawer>;
  const slot = renderSlot({ component }, {}, {});
  const drawer = await slot.findByRole("dialog");
  const target = within(drawer).getByRole("textbox", { name: "Title" });
  const pane = drawer.querySelector<HTMLElement>("[data-test-scrollport]")!;
  pane.scrollTop = 100;
  Object.defineProperty(pane, "clientHeight", { configurable: true, value: 300 });
  Object.defineProperty(pane, "scrollHeight", { configurable: true, value: 700 });
  Object.defineProperty(pane, "clientTop", { configurable: true, value: 0 });
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({ top: 50, bottom: 350 } as DOMRect);
  vi.spyOn(target, "getBoundingClientRect").mockImplementation(() => {
    const top = (placement === "below" ? 400 : placement === "above" ? 20 : 100) + 100 - pane.scrollTop;
    return { top, bottom: top + 36 } as DOMRect;
  });
  within(drawer).getByRole("button", { name: "Before" }).focus();
  const documentScroll = document.documentElement.scrollTop;
  tab(); expect(document.activeElement).toBe(target);
  expect(pane.scrollTop).toBe(placement === "below" ? 186 : placement === "above" ? 70 : 100);
  expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(50);
  expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(350);
  within(drawer).getByRole("button", { name: "After" }).focus();
  pane.scrollTop = 100;
  tab(true); expect(document.activeElement).toBe(target);
  expect(pane.scrollTop).toBe(placement === "below" ? 186 : placement === "above" ? 70 : 100);
  expect(document.documentElement.scrollTop).toBe(documentScroll);
});

test("an older first dispatcher stays untouched while the owned panel handles Tab and roving arrows", async () => {
  const key = Symbol.for("bb.persistent-drawer-stack.v1");
  const external = document.createElement("div");
  external.innerHTML = '<button>External drawer</button>';
  document.body.append(external);
  const entries = [{ panel: () => external, dismissOnEscape: vi.fn() }];
  const oldDispatcher = vi.fn((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== "Tab") return;
    const panel = entries.at(-1)!.panel();
    const controls = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    const index = controls.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus({ preventScroll: true });
  });
  Reflect.set(document, key, { entries, handleKeyDown: oldDispatcher });
  document.addEventListener("keydown", oldDispatcher);
  function Owned() {
    const [value, setValue] = useState("a");
    const close = useCallback(() => {}, []);
    return <Drawer open name="Owned after host" onClose={close}><button>Before</button><Segmented label="Roving" value={value} options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} onChange={setValue} /><div style={{ overflowY: "auto", height: 300 }}><button>After</button></div></Drawer>;
  }
  try {
    const slot = renderSlot({ component: Owned }, {}, {});
    const drawer = await slot.findByRole("dialog", { name: "Owned after host" });
    const before = within(drawer).getByRole("button", { name: "Before" }), after = within(drawer).getByRole("button", { name: "After" });
    const alpha = within(drawer).getByRole("radio", { name: "Alpha" }), beta = within(drawer).getByRole("radio", { name: "Beta" });
    const pane = after.parentElement!;
    Object.defineProperty(pane, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(pane, "scrollHeight", { configurable: true, value: 700 });
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({ top: 50, bottom: 350 } as DOMRect);
    vi.spyOn(after, "getBoundingClientRect").mockImplementation(() => ({ top: 400 - pane.scrollTop, bottom: 436 - pane.scrollTop } as DOMRect));
    before.focus(); tab(); expect(document.activeElement).toBe(alpha);
    tab(); expect(document.activeElement).toBe(after);
    expect(pane.scrollTop).toBe(86);
    tab(true); expect(document.activeElement).toBe(alpha);
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(document.activeElement).toBe(beta);
    expect(beta.getAttribute("tabindex")).toBe("0");
    tab(); expect(document.activeElement).toBe(after);
    tab(true); expect(document.activeElement).toBe(beta);
    tab(true); expect(document.activeElement).toBe(before);
    expect(Reflect.get(document, key).handleKeyDown).toBe(oldDispatcher);
    expect(entries).toHaveLength(2);
    cleanup();
    expect(entries).toHaveLength(1);
    expect(Reflect.get(document, key).handleKeyDown).toBe(oldDispatcher);
    external.querySelector<HTMLElement>("button")!.focus();
    expect(tab()).toBe(false);
  } finally {
    cleanup(); document.removeEventListener("keydown", oldDispatcher); Reflect.deleteProperty(document, key); external.remove();
  }
});

test("the top of two drawers owns Tab and Escape, other overlays retain Tab, and final close removes interception", async () => {
  const closeLower = vi.fn(), closeUpper = vi.fn();
  function Stack() {
    const [lower, setLower] = useState(true), [upper, setUpper] = useState(true);
    const lowerClose = useCallback(() => { closeLower(); setLower(false); }, []);
    const upperClose = useCallback(() => { closeUpper(); setUpper(false); }, []);
    return <><textarea aria-label="Composer" /><Drawer name="Lower" open={lower} onClose={lowerClose}><button>Lower first</button><button onClick={lowerClose}>Close lower</button></Drawer><Drawer name="Upper" open={upper} onClose={upperClose}><button>Upper first</button><button onClick={upperClose}>Close upper</button></Drawer><div data-bb-portaled-overlay=""><button>Other overlay</button></div></>;
  }
  const slot = renderSlot({ component: Stack }, {}, {});
  const lower = await slot.findByRole("dialog", { name: "Lower" }), upper = slot.getByRole("dialog", { name: "Upper" });
  const firstUpper = within(upper).getByRole("button", { name: "Upper first" });
  upper.focus();
  expect(tab()).toBe(false); expect(document.activeElement).toBe(firstUpper);
  const firstLower = within(lower).getByRole("button", { name: "Lower first" }); firstLower.focus();
  expect(tab()).toBe(true); expect(document.activeElement).toBe(firstLower);
  const other = slot.getByRole("button", { name: "Other overlay" }); other.focus();
  expect(tab()).toBe(true); expect(document.activeElement).toBe(other);
  expect(tab(true)).toBe(true); expect(document.activeElement).toBe(other);
  firstUpper.focus(); fireEvent.keyDown(firstUpper, { key: "Escape" });
  await waitFor(() => expect(closeUpper).toHaveBeenCalledTimes(1));
  expect(closeLower).not.toHaveBeenCalled();
  tab(); expect(document.activeElement).toBe(within(lower).getByRole("button", { name: "Lower first" }));
  fireEvent.click(within(lower).getByRole("button", { name: "Close lower" }));
  await waitFor(() => expect(closeLower).toHaveBeenCalledTimes(1));
  expect(Reflect.has(document, Symbol.for("bb.persistent-drawer-stack.v1"))).toBe(false);
  const composer = slot.getByRole("textbox", { name: "Composer" }); composer.focus();
  expect(tab()).toBe(true); expect(document.activeElement).toBe(composer);
});
