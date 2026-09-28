// index.tsx — Bundler entry for every page the daemon serves: routes the
// page to its boot BEFORE any page-specific module runs.
//
// - `/preview/<token>` (the terminal's `:preview`, plan @400 N21) boots the
//   read-only rich draft preview (components/Preview.tsx) and NOTHING of the
//   workspace: no selection/filter/preference seeding or persistence, no
//   history rewriting (state/url.ts would replace the preview URL), no live
//   stream, no global shortcuts and no notification prompt.
// - Every other path (/, /task/:id) boots the dashboard (dashboard.tsx),
//   whose side-effect imports keep their documented order there.
//
// Both boots are dynamic imports of modules inside this ONE bundle (ui:build
// has no code splitting): Bun evaluates a dynamically imported module only
// when its import() runs, so the page that is not booted never executes.
//
// CSS is NOT imported here — out/bundle.css is built directly by
// scripts/build-css.sh from src/ui/styles/*.css (run as a prebuild step in
// package.json:ui:build / ui:watch). The server embeds out/bundle.css via
// `with { type: "file" }` in src/server.ts, so the file just needs to exist
// on disk; nothing requires it to flow through the JS bundler.

import { render } from "preact";

/** `/preview/<token>`: the raw path segment goes to the daemon untouched (it answers anything but a live token with an explicit error). */
const PREVIEW_PATH = /^\/preview\/([^/]+)\/?$/;

const preview = PREVIEW_PATH.exec(window.location.pathname);
if (preview) {
  const token = preview[1] ?? "";
  void import("./components/Preview.tsx").then(({ Preview }) => {
    const mountPoint = document.querySelector("main#app");
    if (!mountPoint) throw new Error("#main#app not found in document — cannot mount the cortex preview");
    render(<Preview token={token} />, mountPoint);
  });
} else {
  void import("./dashboard.tsx");
}
