import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Server tests run in Node; app tests opt into jsdom with a
// `// @vitest-environment jsdom` first line, as the bb SDK harness expects.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["*.test.ts", "*.test.tsx"],
  },
});
