import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeEvents } from "./stream.ts";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {}
}

describe("event stream readiness", () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.unstubAllGlobals();
  });

  it("announces when the live stream is ready for a fresh snapshot", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onOpen = vi.fn();
    const unsubscribe = subscribeEvents(() => {}, { onOpen });

    FakeWebSocket.instances[0]?.onopen?.();
    expect(onOpen).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
