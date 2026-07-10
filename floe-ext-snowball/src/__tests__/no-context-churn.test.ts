/**
 * Regression tests for context-churn fix (fm/floe-card-context-churn).
 *
 * Root cause: snowball.card.created / card.moved / card.criteria_checked were
 * broadcast with `target: "active_with_delivery_processor"` and no context_id.
 * resolveContext() always creates a NEW context for broadcast events with no
 * supplied context_id (destEndpoint is null for broadcasts → created: true).
 * This produced one throwaway context AND one agent-turn delivery per card
 * mutation per active AI agent endpoint.
 *
 * Fix: removed all three (plus gate_overridden) pure-notification broadcasts.
 * The entered_column routing event (which carries a stable column context_id)
 * is the canonical signal for agent routing AND WS-based UI refresh.
 *
 * These tests verify:
 *  A. POST /card emits NO bus events at all (no card.created broadcast).
 *  B. POST /move emits NO card.moved broadcast; entered_column IS emitted when
 *     the destination column is agent-owned.
 *  C. move_card tool emits NO card.moved broadcast; entered_column IS emitted.
 *  D. check_criteria tool emits NO criteria_checked broadcast.
 *  E. No additional contexts are created by card mutations (only the
 *     board-init contexts, created explicitly by POST /board/init).
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
import { writeCard } from "../card-file.js";
import { writeColumnFile, defaultColumnFiles, type ColumnFile } from "../column-file.js";
import { SIDECAR_SCHEMA } from "../types.js";
import type { BoardSidecar, CardFile } from "../types.js";

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

function makeSidecar(
  column_contexts: Record<string, string> = {}
): BoardSidecar {
  return {
    schema: SIDECAR_SCHEMA,
    scope_id: SCOPE,
    workspace_id: WS_ID,
    column_contexts,
  };
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
    checks: {},
    body: "",
    ...overrides,
  };
}

/** Write default 3-column setup (todo / in-progress / done). */
function setupDefaultColumns(tmpDir: string): ColumnFile[] {
  const slug = slugify(SCOPE);
  const cols = defaultColumnFiles(SCOPE);
  for (const col of cols) writeColumnFile(tmpDir, slug, col);
  return cols;
}

/** Write a column with an agent owner. */
function setupAgentColumn(tmpDir: string, agentId: string): void {
  const slug = slugify(SCOPE);
  const cols = defaultColumnFiles(SCOPE);
  // Make "in-progress" agent-owned
  const agentCol: ColumnFile = {
    ...cols[1],
    owner: { kind: "agent", agent_id: agentId },
    exit_criteria: [{ id: "ec1", description: "Tests pass", kind: "machine" }],
  };
  writeColumnFile(tmpDir, slug, cols[0]); // todo (human)
  writeColumnFile(tmpDir, slug, agentCol); // in-progress (agent)
  writeColumnFile(tmpDir, slug, cols[2]); // done (human)
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
// A. POST /card — no bus events emitted
// ---------------------------------------------------------------------------

describe("A: POST /card — no context churn", () => {
  it("emits NO bus events when creating a card in a human-owned column", async () => {
    setupDefaultColumns(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar());
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "New task" },
    });

    expect(res.status).toBe(201);
    // No events emitted at all — no card.created broadcast
    expect(bus.emittedEvents).toHaveLength(0);
    // No contexts created by card creation
    expect(bus.createdContexts).toHaveLength(0);
  });

  it("emits no snowball.card.created event even with scope + column specified", async () => {
    setupDefaultColumns(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar());
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Done task", column_id: "done" },
    });

    expect(res.status).toBe(201);
    const cardCreatedEvents = bus.emittedEvents.filter(
      (e) => e.type === "snowball.card.created"
    );
    expect(cardCreatedEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B. POST /move — no card.moved broadcast; entered_column for agent columns
// ---------------------------------------------------------------------------

describe("B: POST /move — no context churn", () => {
  it("emits NO card.moved broadcast when moving to a human-owned column", async () => {
    setupDefaultColumns(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar());
    writeCard(tmpDir, makeCardFile({ id: "c1", column: "todo" }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "c1", to_column_id: "done" },
    });

    expect(res.status).toBe(200);
    const movedEvents = bus.emittedEvents.filter(
      (e) => e.type === "snowball.card.moved"
    );
    expect(movedEvents).toHaveLength(0);
    expect(bus.createdContexts).toHaveLength(0);
  });

  it("emits entered_column (not card.moved broadcast) when moving to an agent-owned column", async () => {
    setupAgentColumn(tmpDir, "my-agent");
    // Pre-seed a column context so entered_column carries the stable context_id
    const ctx = `ctx_agent_col`;
    saveSidecar(tmpDir, SCOPE, makeSidecar({ "in-progress": ctx }));
    // Seed the bus context so the sidecar lookup resolves
    bus.seedContext({
      context_id: ctx,
      workspace_id: WS_ID,
      scope_id: SCOPE,
      created_at: new Date().toISOString(),
      title: null,
      first_message_preview: null,
      participants: [`actor:${WS_ID}:my-agent`, `actor:${WS_ID}:snowball-overseer`],
    });
    writeCard(tmpDir, makeCardFile({ id: "c2", column: "todo" }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "c2", to_column_id: "in-progress" },
    });

    expect(res.status).toBe(200);

    // No card.moved broadcast
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.moved")).toHaveLength(0);

    // entered_column IS emitted (the routing signal that actually engages the agent)
    const enteredEvents = bus.emittedEvents.filter(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(enteredEvents).toHaveLength(1);
    expect(enteredEvents[0].context_id).toBe(ctx); // uses the stable column context
    expect(enteredEvents[0].destination?.kind).toBe("endpoint"); // targeted, not broadcast
    expect(enteredEvents[0].response?.expected).toBe(true);
  });

  it("creates NO new contexts (only the pre-existing column context used)", async () => {
    setupAgentColumn(tmpDir, "my-agent");
    const ctx = `ctx_agent_col`;
    saveSidecar(tmpDir, SCOPE, makeSidecar({ "in-progress": ctx }));
    bus.seedContext({
      context_id: ctx,
      workspace_id: WS_ID,
      scope_id: SCOPE,
      created_at: new Date().toISOString(),
      title: null,
      first_message_preview: null,
      participants: [`actor:${WS_ID}:my-agent`, `actor:${WS_ID}:snowball-overseer`],
    });
    writeCard(tmpDir, makeCardFile({ id: "c3", column: "todo" }));
    const handlers = buildHandlerMap(makeCtx(tmpDir, bus));

    await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "c3", to_column_id: "in-progress" },
    });

    // No new contexts created by the move (stable context reused)
    expect(bus.createdContexts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C. move_card tool — no card.moved broadcast; entered_column for agent columns
// ---------------------------------------------------------------------------

describe("C: move_card tool — no context churn", () => {
  it("emits NO card.moved broadcast when moving to a human-owned column", async () => {
    setupDefaultColumns(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar());
    writeCard(tmpDir, makeCardFile({ id: "t1", column: "todo" }));
    const ctx = makeCtx(tmpDir, bus);
    const tools = createTools(ctx);
    const moveCard = tools.find((t) => t.name === "move_card")!;

    const result = await moveCard.execute("call1", {
      scope_id: SCOPE,
      card_id: "t1",
      to_column_id: "done",
    });

    // Should succeed
    const body = JSON.parse(
      (result.content[0] as { type: "text"; text: string }).text
    );
    expect(body.ok).toBe(true);

    // No card.moved broadcast
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.moved")).toHaveLength(0);
    // No criteria_checked broadcast
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.criteria_checked")).toHaveLength(0);
  });

  it("emits entered_column (not card.moved) when moving to an agent-owned column", async () => {
    setupAgentColumn(tmpDir, "my-agent");
    const ctx = `ctx_agent_col`;
    saveSidecar(tmpDir, SCOPE, makeSidecar({ "in-progress": ctx }));
    bus.seedContext({
      context_id: ctx,
      workspace_id: WS_ID,
      scope_id: SCOPE,
      created_at: new Date().toISOString(),
      title: null,
      first_message_preview: null,
      participants: [`actor:${WS_ID}:my-agent`, `actor:${WS_ID}:snowball-overseer`],
    });
    bus.seedEndpoint({
      endpoint_id: `actor:${WS_ID}:my-agent`,
      workspace_id: WS_ID,
      agent_id: "my-agent",
      name: "my-agent",
      status: "idle",
    });
    writeCard(tmpDir, makeCardFile({ id: "t2", column: "todo" }));
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

    // entered_column IS emitted
    const entered = bus.emittedEvents.filter(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(entered).toHaveLength(1);
    expect(entered[0].context_id).toBe(ctx);
    expect(entered[0].destination?.kind).toBe("endpoint");
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
    saveSidecar(tmpDir, SCOPE, makeSidecar());
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
    saveSidecar(tmpDir, SCOPE, makeSidecar());
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
// E. create_card tool — no card.created broadcast
// ---------------------------------------------------------------------------

describe("E: create_card tool — no context churn", () => {
  it("emits NO bus events when creating a card via the tool", async () => {
    setupDefaultColumns(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar());
    bus.seedEndpoint({
      endpoint_id: `actor:${WS_ID}:snowball-overseer`,
      workspace_id: WS_ID,
      agent_id: "snowball-overseer",
      name: "snowball-overseer",
      status: "idle",
    });
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

    // No card.created broadcast
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.created")).toHaveLength(0);
    // No contexts created by card creation alone
    expect(bus.createdContexts).toHaveLength(0);
    // No events at all
    expect(bus.emittedEvents).toHaveLength(0);
  });
});
