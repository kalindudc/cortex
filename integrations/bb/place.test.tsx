// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { isFlag, usePageScroll, usePlaceState } from "./ui/place";

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });

function StateProbe() {
  const [thread, setThread] = useState("first");
  const [value, setValue] = usePlaceState("tab", false, isFlag, thread);
  return <><button onClick={() => setThread(thread === "first" ? "second" : "first")}>Switch thread</button><button onClick={() => setValue(previous => !previous)}>{thread}: {String(value)}</button></>;
}

test("session state follows a changed thread without unmounting, and is plugin-scoped", () => {
  const slot = renderSlot({ component: StateProbe }, {});
  fireEvent.click(slot.getByRole("button", { name: "first: false" }));
  fireEvent.click(slot.getByRole("button", { name: "Switch thread" }));
  expect(slot.getByRole("button", { name: "second: false" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Switch thread" }));
  expect(slot.getByRole("button", { name: "first: true" })).toBeTruthy();
  slot.unmount();
  const copy = renderSlot({ component: StateProbe }, {}, { pluginId: "another-cortex" });
  expect(copy.getByRole("button", { name: "first: false" })).toBeTruthy();
});

test.each(["null", '"wrong type"', "{}"]) ("invalid saved state %s does not become a tab value", raw => {
  sessionStorage.setItem("test-plugin.cortex.place:first:tab", raw);
  const slot = renderSlot({ component: StateProbe }, {});
  expect(slot.getByRole("button", { name: "first: false" })).toBeTruthy();
});

test("unavailable storage does not prevent reading or changing a view", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Storage blocked", "SecurityError"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage full", "QuotaExceededError"); });
  const slot = renderSlot({ component: StateProbe }, {});
  fireEvent.click(slot.getByRole("button", { name: "first: false" }));
  expect(slot.getByRole("button", { name: "first: true" })).toBeTruthy();
  expect(console.warn).toHaveBeenCalled();
});

function ScrollProbe() {
  const [route, setRoute] = useState("first");
  const [loaded, setLoaded] = useState(false);
  const root = usePageScroll(route);
  return <div ref={root}>
    <button onClick={() => setRoute(route === "first" ? "second" : "first")}>Change route</button>
    <button onClick={() => setLoaded(true)}>Load</button>
    <div data-cortex-scroll="main">{loaded ? <p>Loaded content</p> : null}</div>
  </div>;
}

test("a reused scrollport starts at zero on a new route, and restores on return", () => {
  const slot = renderSlot({ component: ScrollProbe }, {});
  const port = slot.container.querySelector<HTMLElement>("[data-cortex-scroll]")!;
  port.scrollTop = 180;
  fireEvent.scroll(port);
  fireEvent.click(slot.getByRole("button", { name: "Change route" }));
  expect(port.scrollTop).toBe(0);
  fireEvent.click(slot.getByRole("button", { name: "Change route" }));
  expect(port.scrollTop).toBe(180);
});

test("a removed scrollport cannot overwrite its saved offset with a detached layout's zero", async () => {
  const slot = renderSlot({ component: ScrollProbe }, {});
  const port = slot.container.querySelector<HTMLElement>("[data-cortex-scroll]")!;
  port.scrollTop = 180;
  fireEvent.scroll(port);
  await act(async () => { port.remove(); port.scrollTop = 0; });
  expect(sessionStorage.getItem("test-plugin.cortex.scroll:first:main")).toBe("180");
});

test("a saved offset waits for asynchronous content instead of overwriting it with zero", async () => {
  sessionStorage.setItem("test-plugin.cortex.scroll:first:main", "180");
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  let position = 0;
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get() { return position; },
    set(value: number) { position = this.querySelector("p") ? value : 0; },
  });
  try {
    const slot = renderSlot({ component: ScrollProbe }, {});
    const port = slot.container.querySelector<HTMLElement>("[data-cortex-scroll]")!;
    fireEvent.scroll(port);
    expect(sessionStorage.getItem("test-plugin.cortex.scroll:first:main")).toBe("180");
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Load" })); });
    await waitFor(() => expect(port.scrollTop).toBe(180));
  } finally {
    if (scrollTop) Object.defineProperty(Element.prototype, "scrollTop", scrollTop);
    else Reflect.deleteProperty(Element.prototype, "scrollTop");
  }
});
