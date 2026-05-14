// Bundler entry. CSS is NOT imported here — out/bundle.css is built directly
// by scripts/build-css.sh from src/ui/styles/*.css (run as a prebuild step
// in package.json:ui:build / ui:watch). The server embeds out/bundle.css via
// `with { type: "file" }` in src/server.ts, so the file just needs to exist
// on disk; nothing requires it to flow through the JS bundler.
//
// app.js handles render + SSE wiring; this file is purely a glue point so
// future plans can swap app.js for native TSX bootstrap without changing
// the bundler config.
import "./app.js";
