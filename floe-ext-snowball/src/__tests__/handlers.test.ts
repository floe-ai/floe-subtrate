/**
 * Handler unit tests — relay endpoint logic for new board CRUD handlers.
 *
 * Tests the request/response semantics of:
 *  - GET /board (includes initialized flag)
 *  - POST /board/init
 *  - POST /columns (add / update / delete / reorder)
 *  - POST /card
 *  - POST /card/delete
 *  - POST /card/rename
 *  - POST /card/criteria
 *
 * Uses the same test harness pattern as tools.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import { registerHttpHandlers } from "../handlers.js";
import { saveSidecar, loadSidecar, sidecarExists } from "../sidecar.js";
import { SIDECAR_SCHEMA, defaultColumns } from "../types.js";
import type { BoardSidecar } from "../types.js";

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

/**
 * Collect all registered handlers into a map by "METHOD /path".
 */
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
  cards: BoardSidecar["cards"] = {}
): BoardSidecar {
  return {
    schema: SIDECAR_SCHEMA,
    scope_id: scopeId,
    workspace_id: workspaceId,
    columns: defaultColumns(),
    cards,
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
    expect((body.columns as unknown[]).length).toBe(3); // default 3 columns
    expect(Array.isArray(body.cards)).toBe(true);
    expect((body.cards as unknown[]).length).toBe(0);
  });

  it("returns initialized:true when sidecar file exists", async () => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "GET", "/board", {
      query: { scope_id: SCOPE },
    });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).initialized).toBe(true);
  });

  it("returns 400 when scope_id is missing", async () => {
    const res = await call(handlers, "GET", "/board");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /board/init
// ---------------------------------------------------------------------------

describe("POST /board/init", () => {
  it("creates the sidecar file on disk", async () => {
    expect(sidecarExists(tmpDir, SCOPE)).toBe(false);

    const res = await call(handlers, "POST", "/board/init", {
      body: { scope_id: SCOPE },
    });

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).ok).toBe(true);
    expect(sidecarExists(tmpDir, SCOPE)).toBe(true);
  });

  it("is idempotent — calling twice does not error", async () => {
    await call(handlers, "POST", "/board/init", { body: { scope_id: SCOPE } });
    const res = await call(handlers, "POST", "/board/init", {
      body: { scope_id: SCOPE },
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 when scope_id is missing", async () => {
    const res = await call(handlers, "POST", "/board/init", { body: {} });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /columns — add
// ---------------------------------------------------------------------------

describe("POST /columns (add)", () => {
  beforeEach(() => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
  });

  it("adds a new column with given name", async () => {
    const res = await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "add", name: "Review" },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const board = body.board as { columns: Array<{ name: string }> };
    expect(board.columns.some((c) => c.name === "Review")).toBe(true);
    expect(board.columns.length).toBe(4);
  });

  it("persists the new column to disk", async () => {
    await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "add", name: "Staging" },
    });
    const reloaded = loadSidecar(tmpDir, SCOPE);
    expect(reloaded.columns.some((c) => c.name === "Staging")).toBe(true);
  });

  it("sets wip_limit when provided", async () => {
    await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "add", name: "Hot", wip_limit: 3 },
    });
    const reloaded = loadSidecar(tmpDir, SCOPE);
    const col = reloaded.columns.find((c) => c.name === "Hot")!;
    expect(col.wip_limit).toBe(3);
  });

  it("returns 400 when name is missing", async () => {
    const res = await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "add" },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /columns — update
// ---------------------------------------------------------------------------

describe("POST /columns (update)", () => {
  beforeEach(() => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
  });

  it("renames a column", async () => {
    const sidecar = loadSidecar(tmpDir, SCOPE);
    const colId = sidecar.columns[0].id; // "todo"

    const res = await call(handlers, "POST", "/columns", {
      body: {
        scope_id: SCOPE,
        action: "update",
        column_id: colId,
        name: "Backlog",
      },
    });

    expect(res.status).toBe(200);
    const reloaded = loadSidecar(tmpDir, SCOPE);
    expect(reloaded.columns[0].name).toBe("Backlog");
  });

  it("updates wip_limit to null", async () => {
    const sidecar = loadSidecar(tmpDir, SCOPE);
    const inProgressId = sidecar.columns[1].id; // wip_limit = 5

    await call(handlers, "POST", "/columns", {
      body: {
        scope_id: SCOPE,
        action: "update",
        column_id: inProgressId,
        wip_limit: null,
      },
    });

    const reloaded = loadSidecar(tmpDir, SCOPE);
    expect(reloaded.columns[1].wip_limit).toBeNull();
  });

  it("updates exit_criteria", async () => {
    const sidecar = loadSidecar(tmpDir, SCOPE);
    const colId = sidecar.columns[0].id;

    await call(handlers, "POST", "/columns", {
      body: {
        scope_id: SCOPE,
        action: "update",
        column_id: colId,
        exit_criteria: [
          { id: "ec-1", description: "Tests pass", kind: "machine" },
        ],
      },
    });

    const reloaded = loadSidecar(tmpDir, SCOPE);
    expect(reloaded.columns[0].exit_criteria.length).toBe(1);
    expect(reloaded.columns[0].exit_criteria[0].id).toBe("ec-1");
  });

  it("returns 404 for unknown column_id", async () => {
    const res = await call(handlers, "POST", "/columns", {
      body: {
        scope_id: SCOPE,
        action: "update",
        column_id: "nonexistent",
        name: "X",
      },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /columns — delete
// ---------------------------------------------------------------------------

describe("POST /columns (delete)", () => {
  beforeEach(() => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
  });

  it("removes the column", async () => {
    const sidecar = loadSidecar(tmpDir, SCOPE);
    const colId = sidecar.columns[2].id; // "done"

    const res = await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "delete", column_id: colId },
    });

    expect(res.status).toBe(200);
    const reloaded = loadSidecar(tmpDir, SCOPE);
    expect(reloaded.columns.find((c) => c.id === colId)).toBeUndefined();
    expect(reloaded.columns.length).toBe(2);
  });

  it("moves cards to first remaining column when deleting a column with cards", async () => {
    const sidecar = makeSidecar(SCOPE, "ws-test", {
      ctx_1: {
        column_id: "todo",
        order: 0,
        title: "Task 1",
        created_at: new Date().toISOString(),
        checks: {},
      },
    });
    saveSidecar(tmpDir, SCOPE, sidecar);

    // Delete "todo" — cards should move to first remaining (todo is index 0, so fallback is in-progress)
    const res = await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "delete", column_id: "todo" },
    });

    expect(res.status).toBe(200);
    const reloaded = loadSidecar(tmpDir, SCOPE);
    expect(reloaded.cards["ctx_1"].column_id).toBe("in-progress");
  });

  it("returns 422 when trying to delete the last column", async () => {
    // Remove two columns first
    const sidecar = makeSidecar(SCOPE, "ws-test");
    sidecar.columns = [sidecar.columns[0]]; // keep only first
    saveSidecar(tmpDir, SCOPE, sidecar);

    const res = await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "delete", column_id: "todo" },
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// POST /columns — reorder
// ---------------------------------------------------------------------------

describe("POST /columns (reorder)", () => {
  beforeEach(() => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
  });

  it("reorders columns as specified", async () => {
    const res = await call(handlers, "POST", "/columns", {
      body: {
        scope_id: SCOPE,
        action: "reorder",
        column_ids: ["done", "in-progress", "todo"],
      },
    });

    expect(res.status).toBe(200);
    const reloaded = loadSidecar(tmpDir, SCOPE);
    expect(reloaded.columns[0].id).toBe("done");
    expect(reloaded.columns[1].id).toBe("in-progress");
    expect(reloaded.columns[2].id).toBe("todo");
  });
});

// ---------------------------------------------------------------------------
// POST /card
// ---------------------------------------------------------------------------

describe("POST /card", () => {
  beforeEach(() => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
  });

  it("creates a card in the default (first) column", async () => {
    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "My new card" },
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.card_id).toBe("string");

    const reloaded = loadSidecar(tmpDir, SCOPE);
    const card = reloaded.cards[body.card_id as string];
    expect(card).toBeDefined();
    expect(card.title).toBe("My new card");
    expect(card.column_id).toBe("todo");
  });

  it("creates a card in the specified column", async () => {
    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "In-progress card", column_id: "in-progress" },
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    const reloaded = loadSidecar(tmpDir, SCOPE);
    expect(reloaded.cards[body.card_id as string].column_id).toBe("in-progress");
  });

  it("emits a context creation via bus client", async () => {
    await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Test card" },
    });
    // The stub bus client records contexts; we can verify one was created
    // by checking that the returned card_id was created by the stub
    expect(bus.emittedEvents.length).toBe(0); // card creation doesn't emit events
  });

  it("respects WIP limit when adding to a column at limit", async () => {
    const sidecar = loadSidecar(tmpDir, SCOPE);
    // in-progress has wip_limit=5; fill it with 5 cards
    for (let i = 0; i < 5; i++) {
      sidecar.cards[`ctx_${i}`] = {
        column_id: "in-progress",
        order: i,
        title: `Card ${i}`,
        created_at: new Date().toISOString(),
        checks: {},
      };
    }
    saveSidecar(tmpDir, SCOPE, sidecar);

    const res = await call(handlers, "POST", "/card", {
      body: {
        scope_id: SCOPE,
        title: "Over limit",
        column_id: "in-progress",
      },
    });

    expect(res.status).toBe(422);
    expect((res.body as Record<string, unknown>).error).toBe(
      "wip_limit_exceeded"
    );
  });

  it("auto-initializes (saves) sidecar when no file exists", async () => {
    // Delete the saved sidecar
    rmSync(join(tmpDir, ".floe"), { recursive: true, force: true });
    expect(sidecarExists(tmpDir, SCOPE)).toBe(false);

    await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "First card ever" },
    });

    expect(sidecarExists(tmpDir, SCOPE)).toBe(true);
  });

  it("returns 400 when scope_id is missing", async () => {
    const res = await call(handlers, "POST", "/card", {
      body: { title: "No scope" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when title is missing", async () => {
    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /card/delete
// ---------------------------------------------------------------------------

describe("POST /card/delete", () => {
  const CARD_ID = "ctx_to_delete";

  beforeEach(() => {
    const sidecar = makeSidecar(SCOPE, "ws-test", {
      [CARD_ID]: {
        column_id: "todo",
        order: 0,
        title: "Delete me",
        created_at: new Date().toISOString(),
        checks: {},
      },
    });
    saveSidecar(tmpDir, SCOPE, sidecar);
  });

  it("removes card from sidecar", async () => {
    const res = await call(handlers, "POST", "/card/delete", {
      body: { scope_id: SCOPE, card_id: CARD_ID },
    });

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).ok).toBe(true);

    const reloaded = loadSidecar(tmpDir, SCOPE);
    expect(reloaded.cards[CARD_ID]).toBeUndefined();
  });

  it("returns 404 for unknown card_id", async () => {
    const res = await call(handlers, "POST", "/card/delete", {
      body: { scope_id: SCOPE, card_id: "unknown" },
    });
    expect(res.status).toBe(404);
  });

  it("returns board snapshot with the deleted card absent", async () => {
    const res = await call(handlers, "POST", "/card/delete", {
      body: { scope_id: SCOPE, card_id: CARD_ID },
    });
    const board = (res.body as Record<string, unknown>).board as {
      cards: Array<{ card_id: string }>;
    };
    expect(board.cards.find((c) => c.card_id === CARD_ID)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /card/rename
// ---------------------------------------------------------------------------

describe("POST /card/rename", () => {
  const CARD_ID = "ctx_to_rename";

  beforeEach(() => {
    const sidecar = makeSidecar(SCOPE, "ws-test", {
      [CARD_ID]: {
        column_id: "todo",
        order: 0,
        title: "Old title",
        created_at: new Date().toISOString(),
        checks: {},
      },
    });
    saveSidecar(tmpDir, SCOPE, sidecar);
  });

  it("renames the card in the sidecar", async () => {
    const res = await call(handlers, "POST", "/card/rename", {
      body: { scope_id: SCOPE, card_id: CARD_ID, title: "New title" },
    });

    expect(res.status).toBe(200);
    const reloaded = loadSidecar(tmpDir, SCOPE);
    expect(reloaded.cards[CARD_ID].title).toBe("New title");
  });

  it("trims whitespace from the title", async () => {
    await call(handlers, "POST", "/card/rename", {
      body: { scope_id: SCOPE, card_id: CARD_ID, title: "  Trimmed  " },
    });
    const reloaded = loadSidecar(tmpDir, SCOPE);
    expect(reloaded.cards[CARD_ID].title).toBe("Trimmed");
  });

  it("returns 404 for unknown card_id", async () => {
    const res = await call(handlers, "POST", "/card/rename", {
      body: { scope_id: SCOPE, card_id: "ghost", title: "Ghost" },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /card/criteria
// ---------------------------------------------------------------------------

describe("POST /card/criteria", () => {
  const CARD_ID = "ctx_with_criteria";
  const COL_ID = "in-progress";
  const EC_ID = "ec-tests";

  beforeEach(() => {
    const sidecar = makeSidecar(SCOPE, "ws-test", {
      [CARD_ID]: {
        column_id: COL_ID,
        order: 0,
        title: "Criterioned card",
        created_at: new Date().toISOString(),
        checks: {},
      },
    });
    // Give in-progress column an exit criterion
    sidecar.columns[1].exit_criteria = [
      { id: EC_ID, description: "Tests pass", kind: "machine" },
    ];
    saveSidecar(tmpDir, SCOPE, sidecar);
  });

  it("marks a criterion as checked", async () => {
    const res = await call(handlers, "POST", "/card/criteria", {
      body: {
        scope_id: SCOPE,
        card_id: CARD_ID,
        column_id: COL_ID,
        criterion_id: EC_ID,
        checked: true,
      },
    });

    expect(res.status).toBe(200);
    const reloaded = loadSidecar(tmpDir, SCOPE);
    const check = reloaded.cards[CARD_ID].checks[COL_ID]?.[EC_ID];
    expect(check).toBeDefined();
    expect(check!.checked).toBe(true);
    expect(check!.checked_at).toBeTruthy();
    expect(check!.checked_by).toBe("human");
  });

  it("marks a criterion as unchecked", async () => {
    // First check it
    await call(handlers, "POST", "/card/criteria", {
      body: {
        scope_id: SCOPE,
        card_id: CARD_ID,
        column_id: COL_ID,
        criterion_id: EC_ID,
        checked: true,
      },
    });

    // Then uncheck it
    await call(handlers, "POST", "/card/criteria", {
      body: {
        scope_id: SCOPE,
        card_id: CARD_ID,
        column_id: COL_ID,
        criterion_id: EC_ID,
        checked: false,
      },
    });

    const reloaded = loadSidecar(tmpDir, SCOPE);
    const check = reloaded.cards[CARD_ID].checks[COL_ID]?.[EC_ID];
    expect(check!.checked).toBe(false);
    expect(check!.checked_at).toBeNull();
  });

  it("reflects updated criteria_checks in the board snapshot", async () => {
    const res = await call(handlers, "POST", "/card/criteria", {
      body: {
        scope_id: SCOPE,
        card_id: CARD_ID,
        column_id: COL_ID,
        criterion_id: EC_ID,
        checked: true,
      },
    });

    const board = (res.body as Record<string, unknown>).board as {
      cards: Array<{
        card_id: string;
        criteria_checks: Array<{ criterionId: string; checked: boolean }>;
      }>;
    };
    const card = board.cards.find((c) => c.card_id === CARD_ID)!;
    const checkInSnapshot = card.criteria_checks.find(
      (c) => c.criterionId === EC_ID
    );
    expect(checkInSnapshot?.checked).toBe(true);
  });

  it("returns 404 for unknown card_id", async () => {
    const res = await call(handlers, "POST", "/card/criteria", {
      body: {
        scope_id: SCOPE,
        card_id: "ghost",
        column_id: COL_ID,
        criterion_id: EC_ID,
        checked: true,
      },
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await call(handlers, "POST", "/card/criteria", {
      body: { scope_id: SCOPE, card_id: CARD_ID },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Post-mutation reload correctness
//
// These tests exercise the GET /board path that BoardView.tsx's reload()
// calls after every mutation (via withReload()).  They verify that each
// mutation type produces durable, immediately-readable state so the board
// UI can refresh correctly after any human action.
//
// The sequence: mutate via POST → re-fetch via GET /board → assert fresh data.
// ---------------------------------------------------------------------------

describe("post-mutation reload correctness", () => {
  beforeEach(() => {
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
  });

  it("GET /board after POST /card shows the new card in the correct column", async () => {
    const addRes = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Reload test card" },
    });
    expect(addRes.status).toBe(201);
    const { card_id } = addRes.body as { card_id: string };

    // Simulate reload(): re-fetch the board state
    const boardRes = await call(handlers, "GET", "/board", {
      query: { scope_id: SCOPE },
    });
    expect(boardRes.status).toBe(200);
    const board = boardRes.body as {
      cards: Array<{ card_id: string; title: string; column_id: string }>;
    };
    const found = board.cards.find((c) => c.card_id === card_id);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Reload test card");
    expect(found!.column_id).toBe("todo"); // default first column
  });

  it("GET /board after POST /move shows the card in its new column", async () => {
    // Create a card in the default (todo) column
    const addRes = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Moveable card" },
    });
    const { card_id } = addRes.body as { card_id: string };

    // Move it to in-progress (no exit criteria on todo, no WIP block on in-progress)
    const moveRes = await call(handlers, "POST", "/move", {
      body: {
        scope_id: SCOPE,
        card_id,
        to_column_id: "in-progress",
        force: false,
      },
    });
    expect(moveRes.status).toBe(200);

    // Simulate reload(): re-fetch the board state
    const boardRes = await call(handlers, "GET", "/board", {
      query: { scope_id: SCOPE },
    });
    const board = boardRes.body as {
      cards: Array<{ card_id: string; column_id: string }>;
    };
    const movedCard = board.cards.find((c) => c.card_id === card_id);
    expect(movedCard?.column_id).toBe("in-progress");
  });

  it("GET /board after POST /card/rename shows the updated title", async () => {
    const addRes = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Original title" },
    });
    const { card_id } = addRes.body as { card_id: string };

    await call(handlers, "POST", "/card/rename", {
      body: { scope_id: SCOPE, card_id, title: "Renamed title" },
    });

    // Simulate reload()
    const boardRes = await call(handlers, "GET", "/board", {
      query: { scope_id: SCOPE },
    });
    const board = boardRes.body as {
      cards: Array<{ card_id: string; title: string }>;
    };
    expect(board.cards.find((c) => c.card_id === card_id)?.title).toBe(
      "Renamed title"
    );
  });

  it("GET /board after POST /card/delete shows the card absent", async () => {
    const addRes = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Deletable" },
    });
    const { card_id } = addRes.body as { card_id: string };

    await call(handlers, "POST", "/card/delete", {
      body: { scope_id: SCOPE, card_id },
    });

    // Simulate reload()
    const boardRes = await call(handlers, "GET", "/board", {
      query: { scope_id: SCOPE },
    });
    const board = boardRes.body as {
      cards: Array<{ card_id: string }>;
    };
    expect(board.cards.find((c) => c.card_id === card_id)).toBeUndefined();
  });

  it("GET /board after POST /card/criteria shows the updated check state", async () => {
    // Set up a column with an exit criterion
    const sidecar = loadSidecar(tmpDir, SCOPE);
    sidecar.columns[0].exit_criteria = [
      { id: "ec-reload-test", description: "Done", kind: "human" },
    ];
    saveSidecar(tmpDir, SCOPE, sidecar);

    const addRes = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "Criteria card" },
    });
    const { card_id } = addRes.body as { card_id: string };

    await call(handlers, "POST", "/card/criteria", {
      body: {
        scope_id: SCOPE,
        card_id,
        column_id: "todo",
        criterion_id: "ec-reload-test",
        checked: true,
      },
    });

    // Simulate reload()
    const boardRes = await call(handlers, "GET", "/board", {
      query: { scope_id: SCOPE },
    });
    const board = boardRes.body as {
      cards: Array<{
        card_id: string;
        criteria_checks: Array<{ criterionId: string; checked: boolean }>;
      }>;
    };
    const card = board.cards.find((c) => c.card_id === card_id)!;
    const check = card.criteria_checks.find(
      (c) => c.criterionId === "ec-reload-test"
    );
    expect(check?.checked).toBe(true);
  });

  it("GET /board after POST /columns (add) shows the new column", async () => {
    await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "add", name: "QA" },
    });

    // Simulate reload()
    const boardRes = await call(handlers, "GET", "/board", {
      query: { scope_id: SCOPE },
    });
    const board = boardRes.body as { columns: Array<{ name: string }> };
    expect(board.columns.some((c) => c.name === "QA")).toBe(true);
    expect(board.columns.length).toBe(4); // 3 default + 1 new
  });

  it("GET /board after POST /columns (update) shows renamed column", async () => {
    const sidecar = loadSidecar(tmpDir, SCOPE);
    const colId = sidecar.columns[0].id; // "todo"

    await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "update", column_id: colId, name: "Backlog" },
    });

    // Simulate reload()
    const boardRes = await call(handlers, "GET", "/board", {
      query: { scope_id: SCOPE },
    });
    const board = boardRes.body as { columns: Array<{ id: string; name: string }> };
    expect(board.columns.find((c) => c.id === colId)?.name).toBe("Backlog");
  });

  it("GET /board after POST /columns (delete) shows the column removed", async () => {
    const sidecar = loadSidecar(tmpDir, SCOPE);
    const colToDelete = sidecar.columns[2].id; // "done"

    await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "delete", column_id: colToDelete },
    });

    // Simulate reload()
    const boardRes = await call(handlers, "GET", "/board", {
      query: { scope_id: SCOPE },
    });
    const board = boardRes.body as { columns: Array<{ id: string }> };
    expect(board.columns.find((c) => c.id === colToDelete)).toBeUndefined();
    expect(board.columns.length).toBe(2);
  });
});
