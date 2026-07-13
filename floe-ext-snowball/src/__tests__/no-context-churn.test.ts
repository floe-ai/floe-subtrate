/**
 * Tests for context-churn fix (fm/floe-card-context-churn) and Slice 4
 * (fm/snowball-card-context) behavior.
 *
 * Slice 4 invariants:
 *   - Every card creation creates exactly ONE card context (card = context).
 *   - `snowball.card.entered_column` uses destination:{kind:"context"} (card context),
 *     never a per-broadcast throwaway context or endpoint destination.
 *   - Columns with no assigned actors: no `entered_column` emitted.
 *   - Columns with assigned actors: `entered_column` emitted into card context.
 *   - `snowball.card.created`, `snowball.card.moved`, `snowball.card.criteria_checked`
 *     are never emitted (they were the source of context churn).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import { registerHttpHandlers } from "../handlers.js";
import { createTools } from "../tools/index.js";
import { slugify } from "../board-file.js";
import { writeCard } from "../card-file.js";
import { writeColumnToBoard as writeColumnFile, defaultColumnFiles } from "../board-file.js";
import type { ColumnFile } from "../types.js";
import type { CardFile } from "../types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RelayRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

interface RelayResponse {
  status: number;
  body: unknown;
}

type Handler = (req: RelayRequest) => Promise<RelayResponse>;

const SCOPE = "scope:ws-test:churn-test";
const WS_ID = "ws-test";

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
  const ctxWithCapture: ExtensionContext = {
    ...ctx,
    registerHttpHandler: (method: string, path: string, handler: Handler) => {
      map.set(`${method} ${path}`, handler);
    },
  };
  registerHttpHandlers(ctxWithCapture);
  return map;
}

async function call(
  map: Map<string, Handler>,
  method: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {}
): Promise<RelayResponse> {
  const handler = map.get(`${method} ${path}`);
  if (!handler) throw new Error(`No handler for ${method} ${path}`);
  return handler({ method, path, query: opts.query ?? {}, body: opts.body ?? null });
}

function makeCardFile(overrides: Partial<CardFile> = {}): CardFile {
  return {
    id: "test-card",
    title: "Test card",
    type: "task",
    actor: null,
    column: "todo",
    order: 0,
    created_at: new Date().toISOString(),
    context_id: null,
    checks: {},
    body: "",
    ...overrides,
  };
}

/** Write default 3-column setup (todo / in-progress / done) with no assigned actors. */
function setupDefaultColumns(tmpDir: string): ColumnFile[] {
  const slug = slugify(SCOPE);
  const cols = defaultColumnFiles(SCOPE);
  for (const col of cols) writeColumnFile(tmpDir, slug, col);
  return cols;
}

/** Write a column with an assigned actor (replaces old owner.kind=agent). */
function setupAgentColumn(tmpDir: string, agentId: string): void {
  const slug = slugify(SCOPE);
  const cols = defaultColumnFiles(SCOPE);
  const agentCol: ColumnFile = {
    ...cols[1],
    assigned_actors: [{ actor_ref: agentId, event_types: ["*"] }],
    exit_criteria: [{ id: "ec1", description: "Tests pass", kind: "machine" }],
  };
  writeColumnFile(tmpDir, slug, cols[0]); // todo (no actors)
  writeColumnFile(tmpDir, slug, agentCol); // in-progress (agent-assigned)
  writeColumnFile(tmpDir, slug, cols[2]); // done (no actors)
}

let tmpDir: string;
let bus: StubBusClient;

beforeEach(() => {
  tmpDir = join(tmpdir(), `snowball-churn-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  bus = new StubBusClient();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A. POST /card — creates card context, no card.created broadcast
// ---------------------------------------------------------------------------

describe("A: POST /card — card context created, no churn", () => {
  it("creates exactly ONE card context when creating a card in an unassigned column", async () => {
    setupDefaultColumns(tmpDir);
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "New task" },
    });

    expect(res.status).toBe(201);
    // Exactly one context created for the card
    expect(bus.createdContexts).toHaveLength(1);
    expect(bus.createdContexts[0].title).toBe("New task");
    expect(bus.createdContexts[0].scope_id).toBe(SCOPE);
    // No events emitted (no assigned actors in "todo")
    expect(bus.emittedEvents).toHaveLength(0);
    // No card.created broadcast
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.created")).toHaveLength(0);
  });

  it("returns context_id in the response", async () => {
    setupDefaultColumns(tmpDir);
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "My task" },
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.context_id).toBeDefined();
    expect(typeof body.context_id).toBe("string");
  });

  it("emits entered_column into card context when creating into an agent-assigned column", async () => {
    setupAgentColumn(tmpDir, "my-agent");
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Agent task", column_id: "in-progress" },
    });

    // WIP gate is checked on in-progress (exit_criteria), but no unchecked to block
    // Actually in-progress has exit_criteria but we're creating, not moving past it
    expect(res.status).toBe(201);
    // One context created (card context)
    expect(bus.createdContexts).toHaveLength(1);
    // entered_column emitted into card context
    const entered = bus.emittedEvents.filter((e) => e.type === "snowball.card.entered_column");
    expect(entered).toHaveLength(1);
    expect(entered[0].destination?.kind).toBe("context");
  });
});

// ---------------------------------------------------------------------------
// B. POST /move — no card.moved broadcast; entered_column into card context
// ---------------------------------------------------------------------------

describe("B: POST /move — no context churn, card context routing", () => {
  it("emits NO card.moved broadcast when moving to an unassigned column", async () => {
    setupDefaultColumns(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "c1", column: "todo" }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "c1", to_column_id: "done" },
    });

    expect(res.status).toBe(200);
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.moved")).toHaveLength(0);
    // No entered_column either (done has no assigned actors)
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.entered_column")).toHaveLength(0);
    // One card context created lazily (legacy card with context_id:null)
    expect(bus.createdContexts).toHaveLength(1);
  });

  it("emits entered_column with destination.kind=context when moving to agent-assigned column", async () => {
    setupAgentColumn(tmpDir, "my-agent");
    // Card already has a context (Slice 4 card)
    const cardContextId = "ctx_existing_card";
    bus.seedContext({
      context_id: cardContextId,
      workspace_id: WS_ID,
      scope_id: SCOPE,
      created_at: new Date().toISOString(),
      title: "Test card",
      first_message_preview: null,
      participants: [],
    });
    writeCard(tmpDir, makeCardFile({ id: "c2", column: "todo", context_id: cardContextId }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "c2", to_column_id: "in-progress" },
    });

    expect(res.status).toBe(200);
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.moved")).toHaveLength(0);

    // entered_column IS emitted using card context, not column context
    const enteredEvents = bus.emittedEvents.filter(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(enteredEvents).toHaveLength(1);
    expect(enteredEvents[0].destination?.kind).toBe("context"); // context routing, not endpoint
    expect(enteredEvents[0].destination?.context_id).toBe(cardContextId); // the CARD context
    expect(enteredEvents[0].response?.expected).toBe(true);
  });

  it("creates no extra contexts when card already has context_id", async () => {
    setupAgentColumn(tmpDir, "my-agent");
    const cardContextId = "ctx_pre_existing";
    bus.seedContext({
      context_id: cardContextId,
      workspace_id: WS_ID,
      scope_id: SCOPE,
      created_at: new Date().toISOString(),
      title: "Test card",
      first_message_preview: null,
      participants: [],
    });
    writeCard(tmpDir, makeCardFile({ id: "c3", column: "todo", context_id: cardContextId }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "c3", to_column_id: "in-progress" },
    });

    // No new contexts created (card already has context_id)
    expect(bus.createdContexts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C. move_card tool — no card.moved broadcast; entered_column into card context
// ---------------------------------------------------------------------------

describe("C: move_card tool — no context churn", () => {
  it("emits NO card.moved broadcast when moving to an unassigned column", async () => {
    setupDefaultColumns(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "t1", column: "todo" }));
    const ctx = makeCtx(tmpDir, bus);
    const tools = createTools(ctx);
    const moveCard = tools.find((t) => t.name === "move_card")!;

    const result = await moveCard.execute("call1", {
      scope_id: SCOPE,
      card_id: "t1",
      to_column_id: "done",
    });

    const body = JSON.parse(
      (result.content[0] as { type: "text"; text: string }).text
    );
    expect(body.ok).toBe(true);

    // No card.moved broadcast
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.moved")).toHaveLength(0);
    // No criteria_checked broadcast
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.criteria_checked")).toHaveLength(0);
    // No entered_column (done has no assigned actors)
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.entered_column")).toHaveLength(0);
  });

  it("emits entered_column with destination.kind=context when moving to agent-assigned column", async () => {
    setupAgentColumn(tmpDir, "my-agent");
    const cardContextId = "ctx_card_for_tool";
    bus.seedContext({
      context_id: cardContextId,
      workspace_id: WS_ID,
      scope_id: SCOPE,
      created_at: new Date().toISOString(),
      title: "Test card",
      first_message_preview: null,
      participants: [],
    });
    writeCard(tmpDir, makeCardFile({ id: "t2", column: "todo", context_id: cardContextId }));
    const extCtx = makeCtx(tmpDir, bus);
    const tools = createTools(extCtx);
    const moveCard = tools.find((t) => t.name === "move_card")!;

    await moveCard.execute("call2", {
      scope_id: SCOPE,
      card_id: "t2",
      to_column_id: "in-progress",
    });

    // No card.moved broadcast
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.moved")).toHaveLength(0);

    // entered_column IS emitted into the card context
    const entered = bus.emittedEvents.filter(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(entered).toHaveLength(1);
    expect(entered[0].destination?.kind).toBe("context"); // context routing, not endpoint
    expect(entered[0].destination?.context_id).toBe(cardContextId);
    expect(entered[0].response?.expected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. check_criteria tool — no criteria_checked broadcast
// ---------------------------------------------------------------------------

describe("D: check_criteria tool — no context churn", () => {
  it("emits NO snowball.card.criteria_checked event", async () => {
    const slug = slugify(SCOPE);
    const cols = defaultColumnFiles(SCOPE);
    const colWithCriteria: ColumnFile = {
      ...cols[1],
      exit_criteria: [{ id: "ec1", description: "Tests pass", kind: "machine" }],
    };
    writeColumnFile(tmpDir, slug, cols[0]);
    writeColumnFile(tmpDir, slug, colWithCriteria);
    writeColumnFile(tmpDir, slug, cols[2]);
    writeCard(tmpDir, makeCardFile({ id: "cr1", column: "in-progress" }));

    const ctx = makeCtx(tmpDir, bus);
    const tools = createTools(ctx);
    const checkCriteria = tools.find((t) => t.name === "check_criteria")!;

    await checkCriteria.execute("call3", {
      scope_id: SCOPE,
      card_id: "cr1",
      criterion_id: "ec1",
      checked: true,
    });

    // No criteria_checked broadcast
    expect(
      bus.emittedEvents.filter((e) => e.type === "snowball.card.criteria_checked")
    ).toHaveLength(0);

    // No contexts created
    expect(bus.createdContexts).toHaveLength(0);

    // No events of any kind emitted
    expect(bus.emittedEvents).toHaveLength(0);
  });

  it("emits NO events for unchecking a criterion either", async () => {
    const slug = slugify(SCOPE);
    const cols = defaultColumnFiles(SCOPE);
    const colWithCriteria: ColumnFile = {
      ...cols[1],
      exit_criteria: [{ id: "ec2", description: "Review done", kind: "human" }],
    };
    for (const col of [cols[0], colWithCriteria, cols[2]]) {
      writeColumnFile(tmpDir, slug, col);
    }
    writeCard(tmpDir, makeCardFile({
      id: "cr2",
      column: "in-progress",
      checks: { "in-progress": { ec2: { checked: true, checked_at: new Date().toISOString(), checked_by: null, note: null } } },
    }));

    const ctx = makeCtx(tmpDir, bus);
    const tools = createTools(ctx);
    const checkCriteria = tools.find((t) => t.name === "check_criteria")!;

    await checkCriteria.execute("call4", {
      scope_id: SCOPE,
      card_id: "cr2",
      criterion_id: "ec2",
      checked: false,
    });

    expect(bus.emittedEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// E. create_card tool — creates card context, no card.created broadcast
// ---------------------------------------------------------------------------

describe("E: create_card tool — card context created, no churn", () => {
  it("creates exactly ONE card context, emits NO events for unassigned column", async () => {
    setupDefaultColumns(tmpDir);
    const ctx = makeCtx(tmpDir, bus);
    const tools = createTools(ctx);
    const createCard = tools.find((t) => t.name === "create_card")!;

    const result = await createCard.execute("call5", {
      scope_id: SCOPE,
      title: "Agent-created task",
      column_id: "todo",
    });

    const body = JSON.parse(
      (result.content[0] as { type: "text"; text: string }).text
    );
    expect(body.ok).toBe(true);
    // context_id returned in response
    expect(body.context_id).toBeDefined();

    // No card.created broadcast
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.created")).toHaveLength(0);
    // Exactly one context created (card context)
    expect(bus.createdContexts).toHaveLength(1);
    expect(bus.createdContexts[0].title).toBe("Agent-created task");
    // No events (no assigned actors in todo)
    expect(bus.emittedEvents).toHaveLength(0);
  });
});
