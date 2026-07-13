/**
 * Unit tests for the BusClient stub — exercises every new method added for
 * the card=context rework (participant management, subscriptions, children).
 *
 * These tests use only the in-memory StubBusClient; no real bus or I/O needed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { StubBusClient, type ContextRef } from "../stub/bus-client.js";

function makeCtx(id: string, workspaceId = "ws:1", scopeId = "scope:1"): ContextRef {
  return {
    context_id: id,
    workspace_id: workspaceId,
    scope_id: scopeId,
    created_at: new Date().toISOString(),
    title: null,
    first_message_preview: null,
    participants: [],
  };
}

describe("StubBusClient — participant management", () => {
  let client: StubBusClient;

  beforeEach(() => {
    client = new StubBusClient();
    client.seedContext(makeCtx("ctx:1"));
  });

  it("adds a participant and reports added=true", async () => {
    const result = await client.addParticipant("ctx:1", "actor:ws:1:agent-a");
    expect(result).toEqual({ added: true });
    const ctx = await client.listContextsForScope("ws:1", "scope:1");
    expect(ctx[0].participants).toContain("actor:ws:1:agent-a");
  });

  it("is idempotent — second add returns added=false", async () => {
    await client.addParticipant("ctx:1", "actor:ws:1:agent-a");
    const second = await client.addParticipant("ctx:1", "actor:ws:1:agent-a");
    expect(second).toEqual({ added: false });
    const ctx = await client.listContextsForScope("ws:1", "scope:1");
    expect(ctx[0].participants.filter((p) => p === "actor:ws:1:agent-a")).toHaveLength(1);
  });

  it("removes a participant and reports removed=true", async () => {
    await client.addParticipant("ctx:1", "actor:ws:1:agent-a");
    const result = await client.removeParticipant("ctx:1", "actor:ws:1:agent-a");
    expect(result).toEqual({ removed: true });
    const ctx = await client.listContextsForScope("ws:1", "scope:1");
    expect(ctx[0].participants).not.toContain("actor:ws:1:agent-a");
  });

  it("removeParticipant on absent endpoint returns removed=false", async () => {
    const result = await client.removeParticipant("ctx:1", "actor:ws:1:no-one");
    expect(result).toEqual({ removed: false });
  });
});

describe("StubBusClient — subscriptions", () => {
  let client: StubBusClient;

  beforeEach(() => {
    client = new StubBusClient();
    client.seedContext(makeCtx("ctx:1"));
  });

  it("subscribes with non-empty event types", async () => {
    await client.subscribeToContext("ctx:1", "actor:ws:1:agent-a", ["message", "snowball.card.entered_column"]);
    const subs = await client.listContextSubscriptions("ctx:1");
    expect(subs).toHaveLength(1);
    expect(subs[0].endpoint_id).toBe("actor:ws:1:agent-a");
    expect(subs[0].event_types).toEqual(["message", "snowball.card.entered_column"]);
  });

  it("subscribes with ['*'] (default) to receive all events", async () => {
    await client.subscribeToContext("ctx:1", "actor:ws:1:agent-a");
    const subs = await client.listContextSubscriptions("ctx:1");
    expect(subs[0].event_types).toEqual(["*"]);
  });

  it("subscribes with [] to create a silent watcher", async () => {
    await client.subscribeToContext("ctx:1", "actor:ws:1:agent-a", []);
    const subs = await client.listContextSubscriptions("ctx:1");
    expect(subs[0].event_types).toEqual([]);
  });

  it("UPSERT — re-subscribing overwrites prior event_types", async () => {
    await client.subscribeToContext("ctx:1", "actor:ws:1:agent-a", ["*"]);
    await client.subscribeToContext("ctx:1", "actor:ws:1:agent-a", []);
    const subs = await client.listContextSubscriptions("ctx:1");
    expect(subs).toHaveLength(1);
    expect(subs[0].event_types).toEqual([]);
  });

  it("unsubscribes an endpoint — removes the subscription row", async () => {
    await client.subscribeToContext("ctx:1", "actor:ws:1:agent-a", ["*"]);
    await client.unsubscribeFromContext("ctx:1", "actor:ws:1:agent-a");
    const subs = await client.listContextSubscriptions("ctx:1");
    expect(subs).toHaveLength(0);
  });

  it("unsubscribe is idempotent for absent subscriptions", async () => {
    await expect(
      client.unsubscribeFromContext("ctx:1", "actor:ws:1:no-one")
    ).resolves.toBeUndefined();
  });

  it("listContextSubscriptions returns empty array when no subscriptions exist", async () => {
    const subs = await client.listContextSubscriptions("ctx:1");
    expect(subs).toEqual([]);
  });

  it("subscriptions are scoped to context — do not bleed into other contexts", async () => {
    client.seedContext(makeCtx("ctx:2"));
    await client.subscribeToContext("ctx:1", "actor:ws:1:agent-a", ["*"]);
    const subsCtx2 = await client.listContextSubscriptions("ctx:2");
    expect(subsCtx2).toHaveLength(0);
  });
});

describe("StubBusClient — listChildContexts", () => {
  let client: StubBusClient;

  beforeEach(() => {
    client = new StubBusClient();
    client.seedContext(makeCtx("ctx:parent"));
  });

  it("returns empty array when no children seeded", async () => {
    const children = await client.listChildContexts("ctx:parent");
    expect(children).toEqual([]);
  });

  it("returns seeded children for a parent context", async () => {
    const child1 = makeCtx("ctx:child:1");
    const child2 = makeCtx("ctx:child:2");
    client._childContexts = new Map([["ctx:parent", [child1, child2]]]);

    const children = await client.listChildContexts("ctx:parent");
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.context_id)).toEqual(["ctx:child:1", "ctx:child:2"]);
  });

  it("children of different parents do not bleed", async () => {
    client.seedContext(makeCtx("ctx:other"));
    const child = makeCtx("ctx:child:1");
    client._childContexts = new Map([["ctx:parent", [child]]]);

    const children = await client.listChildContexts("ctx:other");
    expect(children).toHaveLength(0);
  });
});
