import { isTauri, type WorkspaceFsRef } from "./workspaceFs.ts";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export type ConversationAttachment = {
  path: string;
  name: string;
  media_type: string;
  bytes: number;
};

export function conversationAttachments(content: Record<string, unknown> | null | undefined): ConversationAttachment[] {
  const value = content?.["attachments"];
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate["path"] !== "string" || typeof candidate["name"] !== "string") return [];
    return [{
      path: candidate["path"],
      name: candidate["name"],
      media_type: typeof candidate["media_type"] === "string"
        ? candidate["media_type"]
        : "application/octet-stream",
      bytes: typeof candidate["bytes"] === "number" ? candidate["bytes"] : 0,
    }];
  });
}

export async function stageConversationAttachments(
  workspace: WorkspaceFsRef,
  contextId: string,
  files: File[],
): Promise<ConversationAttachment[]> {
  if (files.length === 0) return [];
  if (!isTauri()) {
    throw new Error("File attachments are available in the Floe desktop app.");
  }
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`Attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files at a time.`);
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return Promise.all(files.map(async file => {
    if (file.size === 0) throw new Error(`${file.name} is empty.`);
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} exceeds the 20MB attachment limit.`);
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    return invoke<ConversationAttachment>("stage_attachment", {
      workspaceRoot: workspace.locator,
      contextId,
      fileName: file.name,
      mediaType: file.type || null,
      bytes,
    });
  }));
}

export function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
