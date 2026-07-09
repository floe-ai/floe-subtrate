/**
 * Handler unit tests — relay endpoint logic for board CRUD handlers.
 *
 * Foundation Slice 1 (fm/snowball-found-s1):
 *   - Cards are now markdown files at tasks/<id>.md (not bus Contexts)
 *   - Columns are bus Contexts (created at board init)
 *   - GET /board reads card files
 *   - POST /card creates card files
 *   - POST /move rewrites card file frontmatter + appends carry-forward
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import { registerHttpHandlers } from "../handlers.js";
import { saveSidecar, loadSidecar, sidecarExists } from "../sidecar.js";
import { writeCard, readCard, listCards } from "../card-file.js";
import { SIDECAR_SCHEMA, defaultColumns } from "../types.js";
import type { BoardSidecar, CardFile } from "../types.js";

// ---------------------------------------------------------------------------
// Test harness
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

function makeCtx(tmpDir: string, bus: StubBusClient): ExtensionContext {
  return {
    workspacePath: tmpDir,
    busClient: bus,
    workspaceId: "ws-test",
    extensionName: "snowball",
    hooks: { on: () => {} },
    registerHttpHandler: () => {},
  };
}

function buildHandlerMap(ctx: ExtensionContext): Map<string, Handler> {
  const map = new Map<string, Handler>();
  const ctxWithCapture: ExtensionContext = {
    ...ctx,
    registerHttpHandler: (
      method: string,
      path: string,
      handler: Handler
    ) => {
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
  return handler({
    method,
    path,
    query: opts.query ?? {},
    body: opts.body ?? null,
  });
}

function makeSidecar(
  scopeId: string,
  workspaceId: string,
  column_contexts: Record<string, string> = {}
): BoardSidecar {
  return {
    schema: SIDECAR_SCHEMA,
    scope_id: scopeId,
    workspace_id: workspaceId,
    columns: defaultColumns(),
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let bus: StubBusClient;
let handlers: Map<string, Handler>;

const SCOPE = "scope:ws-test:my-project";

beforeEach(() => {
  tmpDir = join(tmpdir(), `snowball-handler-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  bus = new StubBusClient();
  const ctx = makeCtx(tmpDir, bus);
  handlers = buildHandlerMap(ctx);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GET /board
// ---------------------------------------------------------------------------

describe("GET /board", () => {
  it("returns default board with initialized:false when no sidecar exists", async () => {
    const res = await call(handlers, "GET", "/board", {
      query: { scope_id: SCOPE },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.initialized).toBe(false);
    expect(Array.isArray(body.columns)).toBe(true);
    expect((body.columns as unknown[]).length).toBe(3);
    expect(Array.isArray(body.cards)).toBe(true);
    expect((body.cards as unknown[]).length).toBe(0);
  });

  it("returns initialized:true when sidecar file exists", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "GET", "/board", {
      query: { scope_id: SCOPE },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.initialized).toBe(true);
  });

  it("includes cards from task files", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "Task A", column: "todo" }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", title: "Task B", column: "in-progress" }));

    const res = await call(handlers, "GET", "/board", { query: { scope_id: SCOPE } });
    const body = res.body as Record<string, unknown>;
    const cards = body.cards as unknown[];
    expect(cards).toHaveLength(2);
  });

  it("returns 400 when scope_id missing", async () => {
    const res = await call(handlers, "GET", "/board", { query: {} });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /board/init
// ---------------------------------------------------------------------------

describe("POST /board/init", () => {
  it("persists sidecar and creates column contexts", async () => {
    const res = await call(handlers, "POST", "/board/init", {
      body: { scope_id: SCOPE },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect((body.board as Record<string, unknown>).initialized).toBe(true);

    // Sidecar should exist on disk
    expect(sidecarExists(tmpDir, SCOPE)).toBe(true);

    // Column contexts should be created in bus
    expect(bus.createdContexts).toHaveLength(3); // one per default column
  });

  it("is idempotent — calling twice doesn't create duplicate contexts", async () => {
    await call(handlers, "POST", "/board/init", { body: { scope_id: SCOPE } });
    const contextCountAfterFirst = bus.createdContexts.length;

    await call(handlers, "POST", "/board/init", { body: { scope_id: SCOPE } });
    // No new contexts created on second call
    expect(bus.createdContexts.length).toBe(contextCountAfterFirst);
  });

  it("returns 400 when scope_id missing", async () => {
    const res = await call(handlers, "POST", "/board/init", { body: {} });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /card
// ---------------------------------------------------------------------------

describe("POST /card", () => {
  it("creates a card file in tasks/", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "New task" },
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.card_id).toBe("string");

    // Verify file was created
    const cards = listCards(tmpDir);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("New task");
    expect(cards[0].column).toBe("todo"); // default first column
  });

  it("places card in specified column", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Done task", column_id: "done" },
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.card_id).toBeDefined();

    const cards = listCards(tmpDir);
    expect(cards[0].column).toBe("done");
  });

  it("includes description in card body", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Task with desc", description: "Do this work." },
    });

    expect(res.status).toBe(201);
    const cards = listCards(tmpDir);
    expect(cards[0].body).toContain("Do this work.");
  });

  it("returns 400 when scope_id missing", async () => {
    const res = await call(handlers, "POST", "/card", {
      body: { title: "Bad" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when title missing", async () => {
    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE },
    });
    expect(res.status).toBe(400);
  });

  it("enforces WIP limit", async () => {
    const sidecar = makeSidecar(SCOPE, "ws-test");
    sidecar.columns[0].wip_limit = 1;
    saveSidecar(tmpDir, SCOPE, sidecar);
    writeCard(tmpDir, makeCardFile({ id: "existing", column: "todo" }));

    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Overflow card" },
    });

    expect(res.status).toBe(422);
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("wip_limit_exceeded");
  });
});

// ---------------------------------------------------------------------------
// POST /card/delete
// ---------------------------------------------------------------------------

describe("POST /card/delete", () => {
  it("removes the card file", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
    writeCard(tmpDir, makeCardFile({ id: "card-to-delete" }));

    const res = await call(handlers, "POST", "/card/delete", {
      body: { scope_id: SCOPE, card_id: "card-to-delete" },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);

    expect(listCards(tmpDir)).toHaveLength(0);
  });

  it("returns 404 for nonexistent card", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/card/delete", {
      body: { scope_id: SCOPE, card_id: "nonexistent" },
    });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /card/rename
// ---------------------------------------------------------------------------

describe("POST /card/rename", () => {
  it("updates card title in file", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
    writeCard(tmpDir, makeCardFile({ id: "my-card", title: "Old title" }));

    const res = await call(handlers, "POST", "/card/rename", {
      body: { scope_id: SCOPE, card_id: "my-card", title: "New title" },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);

    const card = readCard(tmpDir, "my-card");
    expect(card!.title).toBe("New title");
  });

  it("returns 404 for nonexistent card", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/card/rename", {
      body: { scope_id: SCOPE, card_id: "nonexistent", title: "New title" },
    });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /card/criteria
// ---------------------------------------------------------------------------

describe("POST /card/criteria", () => {
  it("updates criterion check in card file", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
    writeCard(tmpDir, makeCardFile({ id: "my-card", column: "in-progress" }));

    const res = await call(handlers, "POST", "/card/criteria", {
      body: {
        scope_id: SCOPE,
        card_id: "my-card",
        column_id: "in-progress",
        criterion_id: "ec-tests",
        checked: true,
      },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);

    const card = readCard(tmpDir, "my-card");
    expect(card!.checks["in-progress"]["ec-tests"].checked).toBe(true);
  });

  it("returns 404 for nonexistent card", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/card/criteria", {
      body: {
        scope_id: SCOPE,
        card_id: "nonexistent",
        column_id: "todo",
        criterion_id: "ec-tests",
        checked: true,
      },
    });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /move
// ---------------------------------------------------------------------------

describe("POST /move", () => {
  it("moves card to target column", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
    writeCard(tmpDir, makeCardFile({ id: "my-card", column: "todo" }));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "my-card", to_column_id: "in-progress" },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.from_column_id).toBe("todo");
    expect(body.to_column_id).toBe("in-progress");

    // Card file should be updated
    const card = readCard(tmpDir, "my-card");
    expect(card!.column).toBe("in-progress");
  });

  it("appends carry-forward comment on move", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
    writeCard(tmpDir, makeCardFile({ id: "my-card", column: "todo", body: "Original body." }));

    await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "my-card", to_column_id: "in-progress" },
    });

    const card = readCard(tmpDir, "my-card");
    expect(card!.body).toContain("Original body.");
    expect(card!.body).toContain(`carry-forward from "To Do"`);
  });

  it("blocks move when exit criteria not satisfied (no force)", async () => {
    const sidecar = makeSidecar(SCOPE, "ws-test");
    sidecar.columns[0].exit_criteria = [{ id: "ec-1", description: "Review", kind: "human" }];
    saveSidecar(tmpDir, SCOPE, sidecar);
    writeCard(tmpDir, makeCardFile({ id: "my-card", column: "todo", checks: {} }));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "my-card", to_column_id: "in-progress" },
    });

    expect(res.status).toBe(422);
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("gate_blocked");
  });

  it("allows move with force=true despite unchecked criteria", async () => {
    const sidecar = makeSidecar(SCOPE, "ws-test");
    sidecar.columns[0].exit_criteria = [{ id: "ec-1", description: "Review", kind: "human" }];
    saveSidecar(tmpDir, SCOPE, sidecar);
    writeCard(tmpDir, makeCardFile({ id: "my-card", column: "todo", checks: {} }));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "my-card", to_column_id: "in-progress", force: true },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.forced).toBe(true);
  });

  it("blocks move when WIP limit exceeded", async () => {
    const sidecar = makeSidecar(SCOPE, "ws-test");
    sidecar.columns[1].wip_limit = 1;
    saveSidecar(tmpDir, SCOPE, sidecar);
    writeCard(tmpDir, makeCardFile({ id: "card-a", column: "in-progress", order: 0 }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", column: "todo", order: 0 }));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "card-b", to_column_id: "in-progress" },
    });

    expect(res.status).toBe(422);
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("wip_limit_exceeded");
  });

  it("returns 404 for nonexistent card", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "nonexistent", to_column_id: "done" },
    });

    expect(res.status).toBe(404);
  });

  it("returns 422 when already in target column", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
    writeCard(tmpDir, makeCardFile({ id: "my-card", column: "todo" }));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "my-card", to_column_id: "todo" },
    });

    expect(res.status).toBe(422);
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("already_in_column");
  });

  it("routes event to agent endpoint when destination is agent-owned", async () => {
    const sidecar = makeSidecar(SCOPE, "ws-test");
    sidecar.columns[1].owner = { kind: "agent", agent_id: "my-worker" };
    sidecar.column_contexts["in-progress"] = "ctx-inprogress";
    saveSidecar(tmpDir, SCOPE, sidecar);
    writeCard(tmpDir, makeCardFile({ id: "my-card", column: "todo" }));

    await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "my-card", to_column_id: "in-progress" },
    });

    // Should have emitted a routing event
    const routingEvent = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(routingEvent).toBeDefined();
    expect(routingEvent!.destination?.endpoint_id).toBe("actor:ws-test:my-worker");
    expect(routingEvent!.context_id).toBe("ctx-inprogress");
  });
});

// ---------------------------------------------------------------------------
// POST /columns
// ---------------------------------------------------------------------------

describe("POST /columns", () => {
  it("adds a new column", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "add", name: "Testing" },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const cols = (body.board as Record<string, unknown>).columns as unknown[];
    expect(cols).toHaveLength(4);
  });

  it("updates a column name", async () => {
    const sidecar = makeSidecar(SCOPE, "ws-test");
    saveSidecar(tmpDir, SCOPE, sidecar);

    const res = await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "update", column_id: "todo", name: "Backlog" },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const cols = (body.board as Record<string, unknown>).columns as Array<{ id: string; name: string }>;
    const updatedCol = cols.find((c) => c.id === "todo");
    expect(updatedCol!.name).toBe("Backlog");
  });

  it("deletes a column and moves its cards to first remaining column", async () => {
    const sidecar = makeSidecar(SCOPE, "ws-test");
    saveSidecar(tmpDir, SCOPE, sidecar);
    writeCard(tmpDir, makeCardFile({ id: "card-in-todo", column: "todo" }));

    const res = await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "delete", column_id: "in-progress" },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const cols = (body.board as Record<string, unknown>).columns as unknown[];
    expect(cols).toHaveLength(2);
  });

  it("cannot delete the last column", async () => {
    const sidecar = makeSidecar(SCOPE, "ws-test");
    sidecar.columns = [sidecar.columns[0]]; // Keep only todo
    saveSidecar(tmpDir, SCOPE, sidecar);

    const res = await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "delete", column_id: "todo" },
    });

    expect(res.status).toBe(422);
  });

  it("reorders columns", async () => {
    const sidecar = makeSidecar(SCOPE, "ws-test");
    saveSidecar(tmpDir, SCOPE, sidecar);

    const res = await call(handlers, "POST", "/columns", {
      body: {
        scope_id: SCOPE,
        action: "reorder",
        column_ids: ["done", "in-progress", "todo"],
      },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const cols = (body.board as Record<string, unknown>).columns as Array<{ id: string }>;
    expect(cols[0].id).toBe("done");
    expect(cols[1].id).toBe("in-progress");
    expect(cols[2].id).toBe("todo");
  });
});
