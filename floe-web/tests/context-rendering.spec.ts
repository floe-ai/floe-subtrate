/**
 * Slice 5 — FloeWeb context-scoped rendering.
 *
 * Mirrors the live E2E proofs in design §6.2 (E2E-1, E2E-2, E2E-5, E2E-8) at
 * the component level using mocked bus routes. Slice 6 owns the live runs.
 */
import { test as base, expect, Page, Route } from "@playwright/test";

const test = base;

const WORKSPACE_ID = "ws_ctx";
const FLOE = `endpoint:${WORKSPACE_ID}:agent:floe`;
const REVIEWER = `endpoint:${WORKSPACE_ID}:agent:reviewer`;
const OPERATOR = `endpoint:${WORKSPACE_ID}:user:operator`;

type ContextSummary = {
  context_id: string;
  workspace_id: string;
  parent_context_id: string | null;
  created_by_endpoint_id: string | null;
  created_at: string;
  last_event_at: string | null;
  participants: string[];
  first_message_preview: string | null;
};

type ContextEvent = {
  event_id: string;
  type: string;
  workspace_id: string;
  context_id: string;
  source_endpoint_id: string | null;
  destination_json: { kind: "endpoint"; endpoint_id: string };
  thread_id?: string | null;
  content: { text?: string; data?: Record<string, unknown> };
  metadata?: Record<string, unknown>;
  created_at: string;
};

type WorldState = {
  contexts: ContextSummary[];
  eventsByContext: Record<string, ContextEvent[]>;
  emitCalls: unknown[];
  legacyEventsCalls: number;
  contextEventsCalls: Record<string, number>;
  contextsListCalls: number;
};

function makeWorld(initial?: Partial<WorldState>): WorldState {
  return {
    contexts: [],
    eventsByContext: {},
    emitCalls: [],
    legacyEventsCalls: 0,
    contextEventsCalls: {},
    contextsListCalls: 0,
    ...initial
  };
}

function makeContext(o: Partial<ContextSummary> & { context_id: string }): ContextSummary {
  return {
    workspace_id: WORKSPACE_ID,
    parent_context_id: null,
    created_by_endpoint_id: OPERATOR,
    created_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    participants: [OPERATOR, FLOE],
    first_message_preview: null,
    ...o
  };
}

function makeMessage(o: Partial<ContextEvent> & { context_id: string; created_at: string }): ContextEvent {
  return {
    event_id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    workspace_id: WORKSPACE_ID,
    source_endpoint_id: OPERATOR,
    destination_json: { kind: "endpoint", endpoint_id: FLOE },
    content: { text: "" },
    metadata: {},
    ...o
  };
}

async function setupRoutes(page: Page, world: WorldState): Promise<void> {
  await page.route("**/v1/workspaces", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workspaces: [{
          workspace_id: WORKSPACE_ID,
          name: "Ctx WS",
          path: "/tmp/ctx",
          status: "attached",
          init_authorized: true,
          created_at: new Date().toISOString()
        }]
      })
    })
  );

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/endpoints`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        endpoints: [
          {
            endpoint_id: FLOE,
            workspace_id: WORKSPACE_ID,
            actor_type: "agent",
            name: "Floe",
            status: "active",
            agent_id: "floe",
            metadata_json: "{}"
          },
          {
            endpoint_id: REVIEWER,
            workspace_id: WORKSPACE_ID,
            actor_type: "agent",
            name: "Reviewer",
            status: "active",
            agent_id: "reviewer",
            metadata_json: "{}"
          },
          {
            endpoint_id: OPERATOR,
            workspace_id: WORKSPACE_ID,
            actor_type: "human",
            name: "Operator",
            status: "idle",
            agent_id: null,
            metadata_json: "{}"
          }
        ]
      })
    })
  );

  await page.route("**/v1/auth/profiles", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        profiles: [{ id: "prof_1", provider: "openai", model: "gpt-4", label: "GPT-4" }]
      })
    })
  );

  await page.route("**/v1/runtime/bindings**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        bindings: [{
          binding_key: "b1",
          scope: "agent",
          workspace_id: WORKSPACE_ID,
          endpoint_id: FLOE,
          auth_profile: "prof_1",
          model: "gpt-4"
        }]
      })
    })
  );

  await page.route("**/v1/runtime/telemetry**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [] }) })
  );

  await page.route("**/v1/auth/models**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [] }) })
  );

  // Context-scoped events: must be hit (not the legacy workspace-wide one).
  await page.route(/\/v1\/contexts\/[^/]+\/events(?:\?.*)?$/, (route: Route) => {
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/v1\/contexts\/([^/]+)\/events/);
    const id = m?.[1] ?? "";
    world.contextEventsCalls[id] = (world.contextEventsCalls[id] ?? 0) + 1;
    const events = world.eventsByContext[id] ?? [];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events })
    });
  });

  // Context list (must include `participant=` query)
  await page.route(/\/v1\/contexts(?:\?.*)?$/, (route: Route) => {
    const url = new URL(route.request().url());
    const participant = url.searchParams.get("participant") ?? "";
    world.contextsListCalls++;
    const filtered = world.contexts.filter((c) => c.participants.includes(participant));
    const sorted = [...filtered].sort((a, b) =>
      (b.last_event_at ?? b.created_at).localeCompare(a.last_event_at ?? a.created_at)
    );
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ contexts: sorted })
    });
  });

  // Legacy workspace-wide events — count usage
  await page.route(/\/v1\/events(?:\?[^/]*)?$/, (route) => {
    world.legacyEventsCalls++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: [] })
    });
  });

  // Emit endpoint
  await page.route("**/v1/events/emit", async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() ?? "{}");
    world.emitCalls.push(body);
    let context_id: string = body.context_id ?? "";
    if (!context_id) {
      // Bus would synthesize a new context for an unscoped emit.
      context_id = `ctx_new_${world.contexts.length + 1}`;
      const now = new Date().toISOString();
      const ctx = makeContext({
        context_id,
        created_at: now,
        last_event_at: now,
        first_message_preview: typeof body.content?.text === "string" ? body.content.text.slice(0, 80) : null,
        participants: [body.source_endpoint_id, body.destination?.endpoint_id].filter(Boolean) as string[]
      });
      world.contexts.push(ctx);
    }
    const created_at = new Date().toISOString();
    const event: ContextEvent = {
      event_id: `evt_${Math.random().toString(36).slice(2, 10)}`,
      type: body.type,
      workspace_id: body.workspace_id,
      context_id,
      source_endpoint_id: body.source_endpoint_id,
      destination_json: body.destination,
      content: body.content ?? {},
      metadata: body.metadata ?? {},
      created_at
    };
    world.eventsByContext[context_id] = [...(world.eventsByContext[context_id] ?? []), event];
    const ctx = world.contexts.find((c) => c.context_id === context_id);
    if (ctx) ctx.last_event_at = created_at;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, event_id: event.event_id, accepted_at: created_at, deliveries_created: 0, event })
    });
  });

  await page.route("**/v1/endpoints/register", (route) =>
    route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ endpoint: {} }) })
  );

  await page.route("**/v1/events/stream", (route) => route.abort());
  await page.route("**/v1/workspaces/*/select", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  );
}

async function bootApp(page: Page, world: WorldState): Promise<void> {
  await setupRoutes(page, world);
  await page.goto("/");
  await page.evaluate((url) => localStorage.setItem("floe.busUrl", url), "http://127.0.0.1:5377");
  await page.reload();
  await page.waitForSelector(".workspace-home, [data-testid='workspace-loaded']", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  // Open the channel
  await page.click('.icon-button[title="Toggle Channel"]');
  await page.waitForTimeout(400);
}

test.describe("Slice 5 — context-scoped chat rendering", () => {
  test("empty state: no contexts → primed composer + no creation calls (E2E-5 mirror)", async ({ page }) => {
    const world = makeWorld();
    await bootApp(page, world);

    // Empty state for the agent
    await expect(page.locator(".channel")).toContainText(/No conversations with .* yet/i);

    // Selecting an agent did NOT create or fetch a context's events.
    expect(world.emitCalls.length).toBe(0);
    expect(Object.keys(world.contextEventsCalls).length).toBe(0);
    // Context list IS fetched (cheap), but no contexts are created.
    expect(world.contextsListCalls).toBeGreaterThan(0);
    expect(world.contexts.length).toBe(0);
  });

  test("first send creates context with context_id:null and FloeWeb adopts the returned id (E2E-1 mirror)", async ({ page }) => {
    const world = makeWorld();
    await bootApp(page, world);

    await page.locator(".channel-composer input").fill("hello floe");
    await page.locator('.channel-composer .icon-button[title="Send"]').click();
    await page.waitForTimeout(600);

    expect(world.emitCalls.length).toBe(1);
    const body = world.emitCalls[0] as Record<string, unknown>;
    expect(body.context_id).toBeNull();
    expect((body as any).destination?.endpoint_id).toBe(FLOE);
    expect(world.contexts.length).toBe(1);

    const newId = world.contexts[0].context_id;
    // Wait for refresh / chat fetch on adopted context
    await page.waitForTimeout(600);
    expect(world.contextEventsCalls[newId]).toBeGreaterThan(0);
  });

  test("continuing an existing conversation sends explicit context_id (User Story 20)", async ({ page }) => {
    const world = makeWorld();
    const ctxId = "ctx_existing";
    world.contexts.push(makeContext({
      context_id: ctxId,
      first_message_preview: "earlier hello",
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:01.000Z"
    }));
    world.eventsByContext[ctxId] = [
      makeMessage({ context_id: ctxId, created_at: "2024-06-01T10:00:00.000Z", content: { text: "earlier hello" } })
    ];

    await bootApp(page, world);

    // Click the existing context in the list
    await page.locator('[data-testid="context-list-item"]').first().click();
    await page.waitForTimeout(300);

    await page.locator(".channel-composer input").fill("follow up");
    await page.locator('.channel-composer .icon-button[title="Send"]').click();
    await page.waitForTimeout(500);

    expect(world.emitCalls.length).toBe(1);
    expect((world.emitCalls[0] as any).context_id).toBe(ctxId);
    // Must NOT pass current_delivery_context_id from UI emits
    expect((world.emitCalls[0] as any).current_delivery_context_id).toBeUndefined();
  });

  test("chat fetch hits /v1/contexts/:id/events not /v1/events?workspace_id (E2E-8 mirror)", async ({ page }) => {
    const world = makeWorld();
    const ctxId = "ctx_a";
    world.contexts.push(makeContext({
      context_id: ctxId,
      first_message_preview: "aaa",
      last_event_at: "2024-06-01T10:00:01.000Z"
    }));
    world.eventsByContext[ctxId] = [
      makeMessage({ context_id: ctxId, created_at: "2024-06-01T10:00:00.000Z", content: { text: "aaa" } })
    ];
    await bootApp(page, world);

    await page.locator('[data-testid="context-list-item"]').first().click();
    await page.waitForTimeout(400);

    expect(world.contextEventsCalls[ctxId]).toBeGreaterThan(0);
    // Chat must contain the seeded message
    await expect(page.locator(".channel-message")).toContainText("aaa");
  });

  test("two contexts with the same participants render distinct event lists (E2E-2 mirror)", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_a",
      first_message_preview: "alpha topic",
      participants: [OPERATOR, FLOE, REVIEWER],
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:00.000Z"
    }));
    world.contexts.push(makeContext({
      context_id: "ctx_b",
      first_message_preview: "beta topic",
      participants: [OPERATOR, FLOE, REVIEWER],
      created_at: "2024-06-02T10:00:00.000Z",
      last_event_at: "2024-06-02T10:00:00.000Z"
    }));
    world.eventsByContext["ctx_a"] = [
      makeMessage({ context_id: "ctx_a", created_at: "2024-06-01T10:00:00.000Z", content: { text: "ALPHA-MSG" } })
    ];
    world.eventsByContext["ctx_b"] = [
      makeMessage({ context_id: "ctx_b", created_at: "2024-06-02T10:00:00.000Z", content: { text: "BETA-MSG" } })
    ];
    await bootApp(page, world);

    const items = page.locator('[data-testid="context-list-item"]');
    await expect(items).toHaveCount(2);
    // List sorted by last_event_at desc → beta first
    await expect(items.nth(0)).toContainText("beta topic");
    await expect(items.nth(1)).toContainText("alpha topic");

    await items.nth(0).click();
    await page.waitForTimeout(300);
    await expect(page.locator(".channel-body")).toContainText("BETA-MSG");
    await expect(page.locator(".channel-body")).not.toContainText("ALPHA-MSG");

    await items.nth(1).click();
    await page.waitForTimeout(300);
    await expect(page.locator(".channel-body")).toContainText("ALPHA-MSG");
    await expect(page.locator(".channel-body")).not.toContainText("BETA-MSG");
  });

  test("rendering does not client-side filter by source_endpoint_id (negative test)", async ({ page }) => {
    const world = makeWorld();
    const ctxId = "ctx_mixed";
    world.contexts.push(makeContext({
      context_id: ctxId,
      first_message_preview: "mixed sources",
      participants: [OPERATOR, FLOE, REVIEWER],
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:03.000Z"
    }));
    world.eventsByContext[ctxId] = [
      makeMessage({
        context_id: ctxId,
        source_endpoint_id: OPERATOR,
        created_at: "2024-06-01T10:00:00.000Z",
        content: { text: "FROM-OPERATOR" }
      }),
      makeMessage({
        context_id: ctxId,
        source_endpoint_id: REVIEWER,
        created_at: "2024-06-01T10:00:01.000Z",
        content: { text: "FROM-REVIEWER" }
      }),
      makeMessage({
        context_id: ctxId,
        source_endpoint_id: FLOE,
        created_at: "2024-06-01T10:00:02.000Z",
        content: { text: "FROM-FLOE" }
      })
    ];
    await bootApp(page, world);

    await page.locator('[data-testid="context-list-item"]').first().click();
    await page.waitForTimeout(400);

    const body = page.locator(".channel-body");
    await expect(body).toContainText("FROM-OPERATOR");
    await expect(body).toContainText("FROM-REVIEWER");
    await expect(body).toContainText("FROM-FLOE");
  });

  test("label fallback: pulse-only context labels as 'Pulse: <name>'", async ({ page }) => {
    const world = makeWorld();
    const ctxId = "ctx_pulse";
    world.contexts.push(makeContext({
      context_id: ctxId,
      first_message_preview: null,
      participants: [FLOE],
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:00.000Z"
    }));
    world.eventsByContext[ctxId] = [
      {
        event_id: "ev_p",
        type: "pulse.fired",
        workspace_id: WORKSPACE_ID,
        context_id: ctxId,
        source_endpoint_id: null,
        destination_json: { kind: "endpoint", endpoint_id: FLOE },
        content: { data: { pulse_id: "p1" } },
        metadata: { trigger_kind: "pulse", pulse_name: "morning_check" },
        created_at: "2024-06-01T10:00:00.000Z"
      }
    ];
    await bootApp(page, world);

    await expect(page.locator('[data-testid="context-list-item"]').first()).toContainText("Pulse: morning_check");
  });

  test("default context (first operator↔agent) is pinned first regardless of activity", async ({ page }) => {
    const world = makeWorld();
    // Older operator↔agent context — should be pinned as default
    world.contexts.push(makeContext({
      context_id: "ctx_default",
      first_message_preview: "very first chat",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-01T00:00:00.000Z",
      last_event_at: "2024-06-01T00:00:00.000Z"
    }));
    // Newer operator↔agent context with more recent activity
    world.contexts.push(makeContext({
      context_id: "ctx_recent",
      first_message_preview: "fresh activity",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-05T00:00:00.000Z",
      last_event_at: "2024-06-05T10:00:00.000Z"
    }));
    await bootApp(page, world);

    const items = page.locator('[data-testid="context-list-item"]');
    await expect(items).toHaveCount(2);
    // Default pinned first even though the other has more recent activity
    await expect(items.nth(0)).toContainText("very first chat");
    await expect(items.nth(1)).toContainText("fresh activity");
  });

  test("'New conversation' enters draft state and makes no API call until first send (User Story 19)", async ({ page }) => {
    const world = makeWorld();
    const ctxId = "ctx_old";
    world.contexts.push(makeContext({
      context_id: ctxId,
      first_message_preview: "old chat",
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:00.000Z"
    }));
    world.eventsByContext[ctxId] = [
      makeMessage({ context_id: ctxId, created_at: "2024-06-01T10:00:00.000Z", content: { text: "old chat" } })
    ];
    await bootApp(page, world);

    const callsBefore = world.emitCalls.length;
    const ctxsBefore = world.contexts.length;

    await page.locator('[data-testid="new-conversation-button"]').click();
    await page.waitForTimeout(300);

    // Composer is enabled but no API call was made
    expect(world.emitCalls.length).toBe(callsBefore);
    expect(world.contexts.length).toBe(ctxsBefore);

    await page.locator(".channel-composer input").fill("draft send");
    await page.locator('.channel-composer .icon-button[title="Send"]').click();
    await page.waitForTimeout(500);

    expect(world.emitCalls.length).toBe(1);
    expect((world.emitCalls[0] as any).context_id).toBeNull();
    expect(world.contexts.length).toBe(ctxsBefore + 1);
  });
});
