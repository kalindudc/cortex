// Ambient module declarations for Bun-specific imports that tsc doesn't
// understand natively.
//
// `*.md` — Bun's text-loader contract: importing a markdown file yields its
// raw string content. Used by src/skills.ts to embed shipped skill bodies
// at build time.
//
// `*.js with { type: "file" }` and `*.css with { type: "file" }` — Bun's
// "file" import attribute resolves to a string filesystem path that
// `bun build --compile` embeds into the final binary. tsc reads `with`
// attributes since TS 5.3 but cannot infer the runtime shape, so we
// declare these wildcards as string-default exports. (`*.html` is already
// declared by bun-types as `HTMLBundle`; we override the `with`-attributed
// case here so server.ts can pass the imported value to `Bun.file()`.)

declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*/out/bundle.js" {
  const path: string;
  export default path;
}

declare module "*/out/bundle.css" {
  const path: string;
  export default path;
}

declare module "*/out/mermaid.js" {
  const path: string;
  export default path;
}
