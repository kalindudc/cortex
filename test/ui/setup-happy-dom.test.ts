import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("happy-dom provides the DOM", () => {
  const div = document.createElement("div");
  document.body.append(div);
  expect(document.body.contains(div)).toBe(true);
});

test("fetch and streams stay Bun's own: a Unix-socket server answers a streamed body", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ui-setup-"));
  const unix = path.join(dir, "s.sock");
  const server = Bun.serve({
    unix,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          },
        }),
      ),
  });
  try {
    const res = await fetch("http://localhost/x", { unix });
    expect(await res.text()).toBe("ok");
  } finally {
    await server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
