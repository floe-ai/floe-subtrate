import { describe, expect, it } from "vitest";
import { CHANNEL_AUTO_SCROLL_THRESHOLD_PX, isScrollContainerNearBottom } from "./channel-scroll";

describe("channel scroll helpers", () => {
  it("treats a container at the bottom as pinned", () => {
    expect(isScrollContainerNearBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
  });

  it("treats a container near the bottom threshold as pinned", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 1000 - 400 - CHANNEL_AUTO_SCROLL_THRESHOLD_PX + 1,
        clientHeight: 400,
        scrollHeight: 1000
      })
    ).toBe(true);
  });

  it("treats a container scrolled away from the bottom as not pinned", () => {
    expect(isScrollContainerNearBottom({ scrollTop: 480, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
  });
});
