import { describe, expect, it } from "vitest";
import { preferredDesktopAuthOption } from "./index.ts";

describe("desktop provider authentication", () => {
  it("prefers device authorization when the provider offers it", () => {
    expect(preferredDesktopAuthOption([
      { id: "browser" },
      { id: "device_code" },
    ])).toBe("device_code");
  });

  it("keeps the provider default when device authorization is unavailable", () => {
    expect(preferredDesktopAuthOption([{ id: "browser" }])).toBe("browser");
  });
});
