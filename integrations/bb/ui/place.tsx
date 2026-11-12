import { createContext, type Dispatch, type SetStateAction, useContext, useLayoutEffect, useRef, useState } from "react";
import { experimental_usePluginId } from "@get-bb/plugin-sdk/app";

export const PlaceScope = createContext("page");
export const oneOf = <T extends string>(...choices: T[]) => (value: unknown): value is T => typeof value === "string" && choices.includes(value as T);
export const isText = (value: unknown): value is string => typeof value === "string";
export const isNullableText = (value: unknown): value is string | null => value === null || isText(value);
export const isFlag = (value: unknown): value is boolean => typeof value === "boolean";
export const isOffset = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) % 20 === 0;
export const isNullableOffset = (value: unknown): value is number | null => value === null || isOffset(value);
export const isPageCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 100;

// Place memory is optional: blocked or full browser storage must not prevent reading Cortex.
export function readPlace(storage: "localStorage" | "sessionStorage", key: string): unknown {
  try {
    const raw = globalThis[storage]?.getItem(key);
    return raw === null || raw === undefined ? undefined : JSON.parse(raw);
  } catch (cause) {
    console.warn("Cortex could not read browser place memory", cause);
    return undefined;
  }
}

export function writePlace(storage: "localStorage" | "sessionStorage", key: string, value: unknown) {
  try { globalThis[storage]?.setItem(key, JSON.stringify(value)); }
  catch (cause) { console.warn("Cortex could not save browser place memory", cause); }
}

export function usePlaceState<T>(name: string, initial: T, valid: (value: unknown) => value is T, scope?: string): [T, Dispatch<SetStateAction<T>>] {
  const pluginId = experimental_usePluginId();
  const route = useContext(PlaceScope);
  const key = `${pluginId}.cortex.place:${scope ?? route}:${name}`;
  const read = () => {
    const saved = readPlace("sessionStorage", key);
    return valid(saved) ? saved : initial;
  };
  const [stored, setStored] = useState(() => ({ key, value: read() }));
  let value = stored.value;
  if (stored.key !== key) {
    value = read();
    setStored({ key, value });
  }
  return [value, next => {
    setStored(previous => {
      const current = previous.key === key ? previous.value : read();
      const value = typeof next === "function" ? (next as (value: T) => T)(current) : next;
      writePlace("sessionStorage", key, value);
      return { key, value };
    });
  }];
}

/** Watches the existing scrollports, including ones mounted after asynchronous reads. */
export function usePageScroll(route: string) {
  const pluginId = experimental_usePluginId();
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const ports = new Map<HTMLElement, { restore: () => void; dispose: () => void }>();
    const scan = () => {
      for (const [port, handlers] of ports) {
        if (!element.contains(port)) { handlers.dispose(); ports.delete(port); }
      }
      for (const port of Array.from(element.querySelectorAll<HTMLElement>("[data-cortex-scroll]"))) {
        if (ports.has(port)) continue;
        const key = `${pluginId}.cortex.scroll:${route}:${port.dataset.cortexScroll}`;
        const saved = readPlace("sessionStorage", key);
        const top = typeof saved === "number" && Number.isFinite(saved) && saved >= 0 ? saved : 0;
        port.scrollTop = top;
        let pending = port.scrollTop < top;
        const restore = () => {
          if (!pending) return;
          port.scrollTop = top;
          pending = port.scrollTop < top;
        };
        const save = () => { if (!pending) writePlace("sessionStorage", key, port.scrollTop); };
        const interact = () => { pending = false; };
        port.addEventListener("scroll", save);
        for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) port.addEventListener(event, interact, { passive: true });
        const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restore);
        resize?.observe(port);
        for (const child of Array.from(port.children)) resize?.observe(child);
        ports.set(port, { restore, dispose: () => {
          if (port.isConnected) save();
          port.removeEventListener("scroll", save);
          for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) port.removeEventListener(event, interact);
          resize?.disconnect();
        } });
      }
      for (const handlers of ports.values()) handlers.restore();
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(element, { childList: true, characterData: true, attributes: true, subtree: true });
    return () => { observer.disconnect(); for (const handlers of ports.values()) handlers.dispose(); };
  }, [pluginId, route]);
  return root;
}
