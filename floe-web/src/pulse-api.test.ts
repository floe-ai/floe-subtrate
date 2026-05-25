import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribePulse, unsubscribePulse } from "./pulse-api";

describe("Pulse API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("subscribes and unsubscribes a Pulse Context subscriber with encoded pulse id", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") || null });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const subscriber = { kind: "context" as const, context_id: "ctx_research" };
    await subscribePulse("http://bus.local/", "pulse/daily", subscriber);
    await unsubscribePulse("http://bus.local/", "pulse/daily", subscriber);

    expect(calls).toEqual([
      {
        url: "http://bus.local/v1/pulses/pulse%2Fdaily/subscribe",
        method: "POST",
        body: JSON.stringify(subscriber)
      },
      {
        url: "http://bus.local/v1/pulses/pulse%2Fdaily/unsubscribe",
        method: "POST",
        body: JSON.stringify(subscriber)
      }
    ]);
  });
});
