import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationAttachments,
  stageConversationAttachments,
} from "./conversationAttachments.ts";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  vi.clearAllMocks();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("conversation attachments", () => {
  it("parses only usable attachment references", () => {
    expect(conversationAttachments({
      attachments: [
        { path: ".floe/state/attachments/c/a.png", name: "a.png", media_type: "image/png", bytes: 42 },
        { name: "missing-path.png" },
      ],
    })).toEqual([{
      path: ".floe/state/attachments/c/a.png",
      name: "a.png",
      media_type: "image/png",
      bytes: 42,
    }]);
  });

  it("stages only the selected bytes through the desktop IPC boundary", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const file = new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" });
    invoke.mockResolvedValue({
      path: ".floe/state/attachments/context/screen.png",
      name: "screen.png",
      media_type: "image/png",
      bytes: 3,
    });

    const result = await stageConversationAttachments(
      { workspace_id: "workspace", locator: "C:\\work" },
      "context",
      [file],
    );

    expect(invoke).toHaveBeenCalledWith("stage_attachment", {
      workspaceRoot: "C:\\work",
      contextId: "context",
      fileName: "screen.png",
      mediaType: "image/png",
      bytes: [1, 2, 3],
    });
    expect(result[0]?.path).toContain(".floe/state/attachments/context/");
  });

  it("does not offer host-file ingress from the remote browser client", async () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    await expect(stageConversationAttachments(
      { workspace_id: "workspace", locator: "C:\\work" },
      "context",
      [file],
    )).rejects.toThrow("desktop app");
    expect(invoke).not.toHaveBeenCalled();
  });
});
