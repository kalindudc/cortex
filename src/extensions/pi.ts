// @ts-nocheck — embedded asset: pi.ts is shipped as bytes via
// `with { type: "file" }` and runs INSIDE pi (which provides
// `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent` at runtime).
// cortex itself does NOT depend on those packages, so type-checking this
// file from cortex's tsconfig is incorrect — the imports are unresolvable
// here and the tool's `execute` callback signature comes from pi's
// `defineTool`. The tsconfig `exclude` of `src/extensions/**` covers this
// file when reached directly, but the import in `src/extensions.ts` still
// pulls it into the program graph; this directive is the second line of
// defense.
//
/**
 * cortex pi extension — embedded asset.
 *
 * Shipped inside the cortex binary; self-installed at
 * `~/.pi/agent/extensions/cortex/cortex.ts` on `cortex init` and
 * wiped+rewritten on `cortex reset`. The user must enable it once via
 * `pi config` (pi only loads global extensions when explicitly enabled).
 *
 * Single responsibility: register the `cortex_update` tool that wraps the
 * `cortex update` CLI with auto-attribution from the active pi session
 * (`pi-<full-uuidv7>`). Updates posted via this tool are resumable via
 * `cortex resume <task-id>`.
 *
 * Deliberately does NOT:
 *   - register any event handlers (no session_start, no spawn hook)
 *   - mutate bash spawn env or replace any built-in tool
 *   - register any other tool
 *
 * The `cortex update --as <id>` CLI behavior is unchanged. Humans and
 * fallback agents (no pi session) continue to pass `--as` directly.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "cortex_update",
      label: "Cortex Update",
      description:
        "Post an update on a cortex task with author attribution to the active pi session. Mirrors `cortex update <id> -m <message> [-s <status>] [-b <body>]`.",
      promptSnippet: "Post a cortex task update with attribution to your active pi session.",
      promptGuidelines: [
        "Use cortex_update for every cortex task update — it auto-attributes to your active pi session.",
        "Pass task_id (positive integer), message (≤4096 chars, no newlines), and optionally status (draft|open|review|blocked|done) and body (longer detail shown).",
        "Prefer this tool over shelling `cortex update <id> --as ... -m ...` — manually-attributed updates are NOT resumable by the user.",
        "If status is set, both a message row AND a `status → <status>` audit-trail row are written, both attributed to your session.",
      ],
      parameters: Type.Object({
        task_id: Type.Integer({
          description: "Task id (positive integer; see `cortex ls`)",
        }),
        message: Type.String({
          description: "Short summary, max 4096 chars; no newlines",
        }),
        status: Type.Optional(
          Type.Union(
            [
              Type.Literal("draft"),
              Type.Literal("open"),
              Type.Literal("review"),
              Type.Literal("blocked"),
              Type.Literal("done"),
            ],
            {
              description: "Optional status flip",
            },
          ),
        ),
        body: Type.Optional(
          Type.String({
            description: "Optional longer detail shown in `cortex show`",
          }),
        ),
      }),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const args: string[] = ["update", String(params.task_id), "-m", params.message, "--as", `pi-${sessionId}`];
        if (params.status !== undefined) {
          args.push("-s", params.status);
        }
        if (params.body !== undefined) {
          args.push("-b", params.body);
        }

        const result = await pi.exec("cortex", args, { signal });
        if (result.code !== 0) {
          return {
            content: [
              {
                type: "text",
                text: result.stderr.trim() || result.stdout.trim() || "cortex update failed",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: result.stdout }],
        };
      },
    }),
  );
}
