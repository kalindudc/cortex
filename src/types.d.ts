// Ambient module declarations for Bun-specific imports that tsc doesn't
// understand natively.
//
// `*.md` — Bun's text-loader contract: importing a markdown file yields its
// raw string content. Used by src/skills.ts to embed shipped skill bodies
// at build time.

declare module "*.md" {
  const content: string;
  export default content;
}
