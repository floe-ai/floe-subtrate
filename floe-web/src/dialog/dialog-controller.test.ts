import { describe, expect, it } from "vitest";
import { createDialogController } from "./dialog-controller";

describe("dialog controller", () => {
  it("opens one request and resolves it when closed", async () => {
    const controller = createDialogController<{ title: string }, string>();
    const seen: Array<string | null> = [];
    controller.subscribe((dialog) => seen.push(dialog?.request.title ?? null));

    const result = controller.open({ title: "Delete conversation" }, "trigger", false);
    expect(controller.current()?.request.title).toBe("Delete conversation");
    expect(controller.current()?.restoreFocusTo).toBe("trigger");
    expect(seen).toEqual([null, "Delete conversation"]);

    controller.close(true);
    await expect(result).resolves.toBe(true);
    expect(controller.current()).toBeNull();
    expect(seen).toEqual([null, "Delete conversation", null]);
  });

  it("cancels the active request when a new one replaces it", async () => {
    const controller = createDialogController<{ title: string }>();

    const first = controller.open({ title: "First" }, null, false);
    const second = controller.open({ title: "Second" }, null, false);

    await expect(first).resolves.toBe(false);
    expect(controller.current()?.request.title).toBe("Second");

    controller.close(false);
    await expect(second).resolves.toBe(false);
  });
});
