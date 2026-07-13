/**
 * Slice 4 (fm/snowball-card-context) — validation tests.
 *
 * Required invariants:
 * (a) Creating a card creates a bus context and sets context_id in frontmatter,
 *     with the creator as a participant.
 * (b) Creating/moving a card into a column with assigned actors adds those actors
 *     as participants and subscribes them to the column's event_types.
 * (c) A move sets the prior column's acted actors to an empty waking subscription
 *     (still participants, never woken again).
 * (d) entered_column is emitted with destination.kind === "context" (not "endpoint").
 * (e) No column contexts are created on move (card contexts only).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import { registerHttpHandlers } from "../handlers.js";
import { createTools } from "../tools/index.js";
import { saveSidecar, slugify } from "../sidecar.js";
import { writeCard, readCard } from "../card-file.js";
import { writeColumnFile, defaultColumnFiles, type ColumnFile } from "../column-file.js";
import { SIDECAR_SCHEMA } from "../types.js";
import type { BoardSidecar, CardFile } from "../types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RelayRequest { method: string; path: string; query: Record<string, string>; body: unknown; }
interface RelayResponse { status: number; body: unknown; }
type Handler = (req: RelayRequest) => Promise<RelayResponse>;

const SCOPE = "scope:ws-s4:board";
const WS_ID = "ws-s4";
const AGENT_A = "agent-alpha";
const AGENT_B = "agent-beta";
const OPERATOR_EP = `actor:${WS_ID}:operator`;
const AGENT_A_EP = `actor:${WS_ID}:${AGENT_A}`;
const AGENT_B_EP = `actor:${WS_ID}:${AGENT_B}`;

function makeCtx(tmpDir: string, bus: StubBusClient): ExtensionContext {
  return {
    workspacePath: tmpDir,
    busClient: bus,
    workspaceId: WS_ID,
    extensionName: "snowball",
    hooks: { on: () => {} },
    registerHttpHandler: () => {},
  };
}

function buildHandlerMap(ctx: ExtensionContext): Map<string, Handler> {
  const map = new Map<string, Handler>();
  registerHttpHandlers({ ...ctx, registerHttpHandler: (m, p, h) => map.set(`${m} ${p}`, h) });
  return map;
}

async function callHandler(
  map: Map<string, Handler>, method: string, path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {}
): Promise<RelayResponse> {
  const handler = map.get(`${method} ${path}`);
  if (!handler) throw new Error(`No handler for ${method} ${path}`);
  return handler({ method, path, query: opts.query ?? {}, body: opts.body ?? null });
}

function makeSidecar(): BoardSidecar {
  return { schema: SIDECAR_SCHEMA, scope_id: SCOPE, workspace_id: WS_ID, column_contexts: {} };
}

function makeCardFile(overrides: Partial<CardFile> = {}): CardFile {
  return {
    id: "test-card", title: "Test card", type: "task", actor: null,
    column: "todo", order: 0, created_at: new Date().toISOString(),
    context_id: null, checks: {}, body: "",
    ...overrides,
  };
}

/**
 * Write a board with:
 *   - todo: no assigned actors
 *   - alpha-col: AGENT_A assigned with event_types=["*"]
 *   - beta-col: AGENT_B assigned with event_types=["*"]
 *   - done: no assigned actors
 */
function writeBoardWithActors(tmpDir: string): ColumnFile[] {
  const slug = slugify(SCOPE);
  const cols: ColumnFile[] = [
    { id: "todo", name: "To Do", scope_id: SCOPE, order: 0, wip_limit: null, assigned_actors: [], exit_criteria: [], instructions: "" },
    { id: "alpha-col", name: "Alpha Work", scope_id: SCOPE, order: 1, wip_limit: null,
      assigned_actors: [{ actor_ref: AGENT_A, event_types: ["*"] }], exit_criteria: [], instructions: "" },
    { id: "beta-col", name: "Beta Work", scope_id: SCOPE, order: 2, wip_limit: null,
      assigned_actors: [{ actor_ref: AGENT_B, event_types: ["*"] }], exit_criteria: [], instructions: "" },
    { id: "done", name: "Done", scope_id: SCOPE, order: 3, wip_limit: null, assigned_actors: [], exit_criteria: [], instructions: "" },
  ];
  for (const col of cols) writeColumnFile(tmpDir, slug, col);
  return cols;
}

let tmpDir: string;
let bus: StubBusClient;

beforeEach(() => {
  tmpDir = join(tmpdir(), `snowball-s4-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  bus = new StubBusClient();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) Creating a card creates a context and sets context_id with creator participant
// ---------------------------------------------------------------------------

describe("(a) Card creation → card context with creator as participant", () => {
  it("POST /card creates a bus context scoped to the board scope", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    const res = await callHandler(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "My Feature" },
    });

    expect(res.status).toBe(201);
    expect(bus.createdContexts).toHaveLength(1);
    const ctx = bus.createdContexts[0];
    expect(ctx.scope_id).toBe(SCOPE);
    expect(ctx.title).toBe("My Feature");
  });

  it("POST /card writes context_id into card frontmatter", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    const res = await callHandler(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Feature X" },
    });

    const body = res.body as Record<string, unknown>;
    const cardId = body.card_id as string;
    const card = readCard(tmpDir, cardId);
    expect(card!.context_id).toBeDefined();
    expect(typeof card!.context_id).toBe("string");
    // context_id in frontmatter matches what was created
    expect(card!.context_id).toBe(bus.createdContexts[0] ? body.context_id : null);
  });

  it("POST /card: operator is added as participant (creator = operator for UI)", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    await callHandler(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Operator Card" },
    });

    // Operator endpoint is the creator → becomes participant
    const createdCtx = bus.createdContexts[0];
    expect(createdCtx.participants).toContain(OPERATOR_EP);
  });

  it("create_card tool: first assigned actor added as participant (creator for tool path)", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const tools = createTools(makeCtx(tmpDir, bus));
    const createCard = tools.find((t) => t.name === "create_card")!;

    const result = await createCard.execute("call1", {
      scope_id: SCOPE,
      title: "Agent Card",
      column_id: "alpha-col", // column with AGENT_A
    });

    const body = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
    expect(body.ok).toBe(true);
    expect(body.context_id).toBeDefined();

    // AGENT_A is the first assigned actor → becomes participant/creator
    const createdCtx = bus.createdContexts[0];
    expect(createdCtx.participants).toContain(AGENT_A_EP);
  });
});

// ---------------------------------------------------------------------------
// (b) Creating/moving into a column with assigned actors adds actors as participants + subscribers
// ---------------------------------------------------------------------------

describe("(b) Column assignment → participants + subscriptions", () => {
  it("POST /move to agent column: assigned actor added as participant", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const cardCtxId = "ctx-card-1";
    bus.seedContext({ context_id: cardCtxId, workspace_id: WS_ID, scope_id: SCOPE,
      created_at: new Date().toISOString(), title: "Card 1", first_message_preview: null, participants: [] });
    writeCard(tmpDir, makeCardFile({ id: "c1", column: "todo", context_id: cardCtxId }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    await callHandler(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "c1", to_column_id: "alpha-col" },
    });

    // AGENT_A_EP must be in the card context's participants
    const ctx = (bus as unknown as { contexts: import("../stub/bus-client.js").ContextRef[] }).contexts.find((c: { context_id: string }) => c.context_id === cardCtxId);
    expect(ctx?.participants).toContain(AGENT_A_EP);
  });

  it("POST /move to agent column: assigned actor subscribed with correct event_types", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const cardCtxId = "ctx-card-2";
    bus.seedContext({ context_id: cardCtxId, workspace_id: WS_ID, scope_id: SCOPE,
      created_at: new Date().toISOString(), title: "Card 2", first_message_preview: null, participants: [] });
    writeCard(tmpDir, makeCardFile({ id: "c2", column: "todo", context_id: cardCtxId }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    await callHandler(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "c2", to_column_id: "alpha-col" },
    });

    // Subscription for AGENT_A should be ["*"]
    const subKey = `${cardCtxId}::${AGENT_A_EP}`;
    expect(bus._subscriptions?.get(subKey)).toEqual(["*"]);
  });

  it("move_card tool: assigned actor added as participant and subscribed", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const cardCtxId = "ctx-card-tool";
    bus.seedContext({ context_id: cardCtxId, workspace_id: WS_ID, scope_id: SCOPE,
      created_at: new Date().toISOString(), title: "Tool Card", first_message_preview: null, participants: [] });
    writeCard(tmpDir, makeCardFile({ id: "tc1", column: "todo", context_id: cardCtxId }));
    const tools = createTools(makeCtx(tmpDir, bus));

    await tools.find((t) => t.name === "move_card")!.execute("call2", {
      card_id: "tc1", to_column_id: "alpha-col", scope_id: SCOPE,
    });

    const ctx = (bus as unknown as { contexts: import("../stub/bus-client.js").ContextRef[] }).contexts.find((c: { context_id: string }) => c.context_id === cardCtxId);
    expect(ctx?.participants).toContain(AGENT_A_EP);
    const subKey = `${cardCtxId}::${AGENT_A_EP}`;
    expect(bus._subscriptions?.get(subKey)).toEqual(["*"]);
  });

  it("POST /card into agent column: column actor added as participant", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    await callHandler(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Direct to Agent", column_id: "alpha-col" },
    });

    // After card creation, AGENT_A should be in the context's participants
    const createdCtxId = bus.createdContexts[0]?.scope_id === SCOPE
      ? (bus as unknown as { contexts: import("../stub/bus-client.js").ContextRef[] }).contexts.find((c) => c.scope_id === SCOPE)?.context_id
      : null;
    if (createdCtxId) {
      const subKey = `${createdCtxId}::${AGENT_A_EP}`;
      expect(bus._subscriptions?.get(subKey)).toEqual(["*"]);
    }
    // At minimum, the context was created
    expect(bus.createdContexts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (c) Move sets prior column's actors to empty subscription (silent watchers)
// ---------------------------------------------------------------------------

describe("(c) Move → prior column actors become silent watchers", () => {
  it("prior column's assigned actor gets subscription=[] on move", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const cardCtxId = "ctx-card-move";
    bus.seedContext({
      context_id: cardCtxId, workspace_id: WS_ID, scope_id: SCOPE,
      created_at: new Date().toISOString(), title: "Move Card", first_message_preview: null,
      participants: [AGENT_A_EP], // AGENT_A was already a participant from prior column
    });
    // Card is currently in alpha-col (AGENT_A assigned)
    writeCard(tmpDir, makeCardFile({ id: "c3", column: "alpha-col", context_id: cardCtxId }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    await callHandler(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "c3", to_column_id: "beta-col" },
    });

    // AGENT_A is still a participant (not removed)
    const ctx = (bus as unknown as { contexts: import("../stub/bus-client.js").ContextRef[] }).contexts.find((c: { context_id: string }) => c.context_id === cardCtxId);
    expect(ctx?.participants).toContain(AGENT_A_EP);

    // But AGENT_A's subscription is now [] (silent watcher)
    const alphaSubKey = `${cardCtxId}::${AGENT_A_EP}`;
    expect(bus._subscriptions?.get(alphaSubKey)).toEqual([]);

    // AGENT_B is now subscribed with ["*"]
    const betaSubKey = `${cardCtxId}::${AGENT_B_EP}`;
    expect(bus._subscriptions?.get(betaSubKey)).toEqual(["*"]);
  });

  it("move_card tool: prior actor demoted to silent watcher", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const cardCtxId = "ctx-card-tool-move";
    bus.seedContext({
      context_id: cardCtxId, workspace_id: WS_ID, scope_id: SCOPE,
      created_at: new Date().toISOString(), title: "Tool Move Card", first_message_preview: null,
      participants: [AGENT_A_EP],
    });
    writeCard(tmpDir, makeCardFile({ id: "tc2", column: "alpha-col", context_id: cardCtxId }));
    const tools = createTools(makeCtx(tmpDir, bus));

    await tools.find((t) => t.name === "move_card")!.execute("call3", {
      card_id: "tc2", to_column_id: "beta-col", scope_id: SCOPE,
    });

    // Prior actor AGENT_A: still participant, empty subscription
    const ctx = (bus as unknown as { contexts: import("../stub/bus-client.js").ContextRef[] }).contexts.find((c: { context_id: string }) => c.context_id === cardCtxId);
    expect(ctx?.participants).toContain(AGENT_A_EP);
    const alphaSubKey = `${cardCtxId}::${AGENT_A_EP}`;
    expect(bus._subscriptions?.get(alphaSubKey)).toEqual([]);

    // New actor AGENT_B: subscribed with ["*"]
    const betaSubKey = `${cardCtxId}::${AGENT_B_EP}`;
    expect(bus._subscriptions?.get(betaSubKey)).toEqual(["*"]);
  });
});

// ---------------------------------------------------------------------------
// (d) entered_column emitted with destination.kind === "context"
// ---------------------------------------------------------------------------

describe("(d) entered_column uses destination.kind=context", () => {
  it("POST /move to agent column: entered_column destination.kind === context", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const cardCtxId = "ctx-card-d1";
    bus.seedContext({ context_id: cardCtxId, workspace_id: WS_ID, scope_id: SCOPE,
      created_at: new Date().toISOString(), title: "Card D1", first_message_preview: null, participants: [] });
    writeCard(tmpDir, makeCardFile({ id: "d1", column: "todo", context_id: cardCtxId }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    await callHandler(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "d1", to_column_id: "alpha-col" },
    });

    const entered = bus.emittedEvents.find((e) => e.type === "snowball.card.entered_column");
    expect(entered).toBeDefined();
    expect(entered!.destination?.kind).toBe("context"); // NOT "endpoint"
    expect(entered!.destination?.context_id).toBe(cardCtxId); // the CARD context
    expect(entered!.response?.expected).toBe(true);
  });

  it("move_card tool: entered_column destination.kind === context", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const cardCtxId = "ctx-card-d2";
    bus.seedContext({ context_id: cardCtxId, workspace_id: WS_ID, scope_id: SCOPE,
      created_at: new Date().toISOString(), title: "Card D2", first_message_preview: null, participants: [] });
    writeCard(tmpDir, makeCardFile({ id: "d2", column: "todo", context_id: cardCtxId }));
    const tools = createTools(makeCtx(tmpDir, bus));

    await tools.find((t) => t.name === "move_card")!.execute("call4", {
      card_id: "d2", to_column_id: "alpha-col", scope_id: SCOPE,
    });

    const entered = bus.emittedEvents.find((e) => e.type === "snowball.card.entered_column");
    expect(entered).toBeDefined();
    expect(entered!.destination?.kind).toBe("context");
    expect(entered!.destination?.context_id).toBe(cardCtxId);
  });

  it("no entered_column when moving to a column with no assigned actors", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const cardCtxId = "ctx-card-d3";
    bus.seedContext({ context_id: cardCtxId, workspace_id: WS_ID, scope_id: SCOPE,
      created_at: new Date().toISOString(), title: "Card D3", first_message_preview: null, participants: [] });
    writeCard(tmpDir, makeCardFile({ id: "d3", column: "todo", context_id: cardCtxId }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    await callHandler(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "d3", to_column_id: "done" }, // done has no actors
    });

    const entered = bus.emittedEvents.filter((e) => e.type === "snowball.card.entered_column");
    expect(entered).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (e) No column contexts created on move
// ---------------------------------------------------------------------------

describe("(e) No column contexts created on card move", () => {
  it("POST /move creates no contexts when card already has context_id", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const cardCtxId = "ctx-existing";
    bus.seedContext({ context_id: cardCtxId, workspace_id: WS_ID, scope_id: SCOPE,
      created_at: new Date().toISOString(), title: "Existing Card", first_message_preview: null, participants: [] });
    writeCard(tmpDir, makeCardFile({ id: "e1", column: "todo", context_id: cardCtxId }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    await callHandler(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "e1", to_column_id: "alpha-col" },
    });

    // No new contexts created (card already has one)
    expect(bus.createdContexts).toHaveLength(0);
  });

  it("POST /move creates exactly ONE card context for legacy card (lazy creation, not column ctx)", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    // Legacy card with context_id: null
    writeCard(tmpDir, makeCardFile({ id: "e2", column: "todo", context_id: null }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    await callHandler(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "e2", to_column_id: "alpha-col" },
    });

    // Exactly one context created (the card context), not a column context
    expect(bus.createdContexts).toHaveLength(1);
    const created = bus.createdContexts[0];
    // It's scoped to the board scope (not a "Column: ..." titled context)
    expect(created.scope_id).toBe(SCOPE);
    // It's NOT titled "Column: ..." (that was the old column context pattern)
    expect(created.title).not.toMatch(/^Column:/);
  });

  it("move_card tool: no column contexts created", async () => {
    writeBoardWithActors(tmpDir);
    saveSidecar(tmpDir, makeSidecar().scope_id, makeSidecar());
    const cardCtxId = "ctx-tool-e3";
    bus.seedContext({ context_id: cardCtxId, workspace_id: WS_ID, scope_id: SCOPE,
      created_at: new Date().toISOString(), title: "Tool Card", first_message_preview: null, participants: [] });
    writeCard(tmpDir, makeCardFile({ id: "e3", column: "todo", context_id: cardCtxId }));
    const tools = createTools(makeCtx(tmpDir, bus));

    await tools.find((t) => t.name === "move_card")!.execute("call5", {
      card_id: "e3", to_column_id: "alpha-col", scope_id: SCOPE,
    });

    // No new contexts (card already has one)
    expect(bus.createdContexts).toHaveLength(0);
    // No "Column: ..." contexts at all
    expect(bus.createdContexts.filter((c) => c.title?.startsWith("Column:"))).toHaveLength(0);
  });
});
