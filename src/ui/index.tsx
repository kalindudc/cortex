// Bundler entry. CSS import causes Bun to emit out/bundle.css alongside
// bundle.js (per https://bun.sh/docs/bundler/css). app.js handles render +
// SSE wiring; this file is purely a glue point so future plans can swap
// app.js for native TSX bootstrap without changing the bundler config.
import "./styles.css";
import "./app.js";
