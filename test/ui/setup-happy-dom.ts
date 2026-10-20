// Registers happy-dom as the global DOM for the renderer tests in test/ui.
// Only `pnpm run test:ui` preloads it; test/unit never does, so backend tests
// keep Bun's own globals.
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/preact";

// happy-dom's fetch, streams and text codecs do not interoperate with Bun's
// server and socket code (its fetch crashes at nodeRequest.end()), so Bun's
// natives are snapshotted first and put back. Event, EventTarget and
// MessageEvent stay happy-dom's: a native EventTarget rejects happy-dom's
// events, so all three must come from the same side.
const NATIVE_GLOBALS = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "XMLHttpRequest",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "AbortSignal",
] as const;

const globals = globalThis as Record<string, unknown>;
const native = NATIVE_GLOBALS.map(name => [name, globals[name]] as const);
GlobalRegistrator.register();
for (const [name, value] of native) {
  if (value) globals[name] = value;
}

// @testing-library/preact auto-cleans only under jest or vitest globals, so
// every render is unmounted between tests here.
afterEach(() => {
  cleanup();
});
