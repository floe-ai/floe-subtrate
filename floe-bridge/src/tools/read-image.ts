/** Workspace-scoped image input for vision-capable model actors. */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { safeWorkspacePath } from "./path-scoping.js";
import type { ToolContext } from "./types.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export function createReadImageTool(ctx: ToolContext): AgentTool {
  return {
    name: "read_image",
    label: "Inspect Image",
    description:
      "Load an image from the workspace into your model context so you can inspect it directly. " +
      "Supports PNG, JPEG, GIF and WebP up to 20MB. Paths must stay inside the workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "Image path relative to the workspace root" }),
    }),
    execute: async (toolCallId, params: any) => {
      const startedAt = Date.now();
      const requestedPath = String(params?.path ?? "");
      const resolved = safeWorkspacePath(ctx.workspaceRoot, requestedPath);
      if (!resolved.ok) {
        enrichToolActivity(ctx, toolCallId, `read_image ${requestedPath} — path rejected`, true, [], startedAt);
        return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      }

      const mimeType = MIME_BY_EXTENSION.get(extname(resolved.path).toLowerCase());
      if (!mimeType) {
        enrichToolActivity(ctx, toolCallId, `read_image ${requestedPath} — unsupported type`, true, [], startedAt);
        return {
          content: [{ type: "text", text: "Unsupported image type. Use PNG, JPEG, GIF or WebP." }],
          details: { ok: false, error: "unsupported_image_type" },
        };
      }

      try {
        const fileStat = await stat(resolved.path);
        if (!fileStat.isFile()) {
          enrichToolActivity(ctx, toolCallId, `read_image ${requestedPath} — not a file`, true, [], startedAt);
          return { content: [{ type: "text", text: `'${requestedPath}' is not a file.` }], details: { ok: false } };
        }
        if (fileStat.size > MAX_IMAGE_BYTES) {
          enrichToolActivity(ctx, toolCallId, `read_image ${requestedPath} — too large`, true, [], startedAt);
          return {
            content: [{ type: "text", text: "Image exceeds the 20MB model-input limit." }],
            details: { ok: false, error: "image_too_large", bytes: fileStat.size },
          };
        }

        const image = await readFile(resolved.path);
        const relPath = relative(ctx.workspaceRoot, resolved.path);
        enrichToolActivity(ctx, toolCallId, `read_image ${relPath} (${fileStat.size} bytes)`, false, [relPath], startedAt);
        return {
          content: [
            { type: "text", text: `Workspace image: ${relPath}` },
            { type: "image", data: image.toString("base64"), mimeType },
          ],
          details: { ok: true, path: relPath, bytes: fileStat.size, mime_type: mimeType },
        };
      } catch (error: any) {
        const message = error?.code === "ENOENT"
          ? `Image not found: '${requestedPath}'`
          : `Error reading image '${requestedPath}': ${error?.message ?? String(error)}`;
        enrichToolActivity(ctx, toolCallId, `read_image ${requestedPath} — ${error?.code ?? "error"}`, true, [], startedAt);
        return { content: [{ type: "text", text: message }], details: { ok: false } };
      }
    },
  } as AgentTool;
}

function enrichToolActivity(
  ctx: ToolContext,
  toolCallId: string,
  summary: string,
  isError: boolean,
  filesTouched: string[],
  startedAt: number,
): void {
  const turn = ctx.getActiveTurn?.();
  if (!turn) return;
  const entry = turn.tool_activity.find(activity => activity.call_id === toolCallId);
  if (!entry) return;
  entry.summary = summary;
  entry.is_error = isError;
  entry.files_touched = filesTouched;
  entry.duration_ms = Date.now() - startedAt;
}
