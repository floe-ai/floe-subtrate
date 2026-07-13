/**
 * Handler unit tests — relay endpoint logic for board CRUD handlers.
 *
 * Slice 2 (fm/snowball-col-instr-s2):
 *   - Column definitions now live in committed column files (boards/<slug>/columns/).
 *   - makeSidecar() is a slim v3 helper (no `columns` field).
 *   - Tests use writeColumnFiles() to set up column definitions.
 *   - Tests needing column-specific config (WIP, exit_criteria, owner) write
 *     column files with those settings.
 *   - New tests: GET /column/instructions, POST /column/instructions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import { registerHttpHandlers } from "../handlers.js";
import { saveSidecar, loadSidecar, sidecarExists, slugify } from "../sidecar.js";
import { writeCard, readCard, listCards } from "../card-file.js";
import {
  writeColumnToBoard as writeColumnFile,
  readColumnFromBoard as readColumnFile,
  defaultColumnFiles,
  readBoardFile,
  writeBoardFile,
  DEFAULT_DONE_PROTOCOL,
} from "../board-file.js";
import { SIDECAR_SCHEMA } from "../types.js";
import type { BoardSidecar, CardFile, ColumnFile } from "../types.js";

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

/** v3 sidecar — no columns field. */
function makeSidecar(
  scopeId: string,
  workspaceId: string,
  column_contexts: Record<string, string> = {}
): BoardSidecar {
  return {
    schema: SIDECAR_SCHEMA,
    scope_id: scopeId,
    workspace_id: workspaceId,
    column_contexts,
  };
}

/** Write default column files for the SCOPE to tmpDir. */
function setupDefaultColumns(tmpDir: string, scopeId: string): ColumnFile[] {
  const slug = slugify(scopeId);
  const cols = defaultColumnFiles(scopeId);
  for (const col of cols) writeColumnFile(tmpDir, slug, col);
  return cols;
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
    setupDefaultColumns(tmpDir, SCOPE);
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

  it("includes instructions field in columns", async () => {
    const slug = slugify(SCOPE);
    const col: ColumnFile = {
      id: "todo",
      name: "To Do",
      scope_id: SCOPE,
      order: 0,
      wip_limit: null,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "Review tasks carefully.",
    };
    writeColumnFile(tmpDir, slug, col);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "GET", "/board", { query: { scope_id: SCOPE } });
    const body = res.body as Record<string, unknown>;
    const cols = body.columns as Array<{ id: string; instructions: string }>;
    const todo = cols.find((c) => c.id === "todo");
    expect(todo?.instructions).toBe("Review tasks carefully.");
  });
});

// ---------------------------------------------------------------------------
// POST /board/init
// ---------------------------------------------------------------------------

describe("POST /board/init", () => {
  it("creates default column files and column contexts on first init", async () => {
    const res = await call(handlers, "POST", "/board/init", {
      body: { scope_id: SCOPE },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect((body.board as Record<string, unknown>).initialized).toBe(true);

    // Sidecar should exist on disk (contexts created)
    expect(sidecarExists(tmpDir, SCOPE)).toBe(true);

    // Column contexts should be created in bus
    expect(bus.createdContexts).toHaveLength(3); // one per default column
  });

  it("is idempotent — calling twice doesn't create duplicate contexts", async () => {
    await call(handlers, "POST", "/board/init", { body: { scope_id: SCOPE } });
    const contextCountAfterFirst = bus.createdContexts.length;

    await call(handlers, "POST", "/board/init", { body: { scope_id: SCOPE } });
    expect(bus.createdContexts.length).toBe(contextCountAfterFirst);
  });

  it("preserves existing column files on second init", async () => {
    const slug = slugify(SCOPE);
    const customCol: ColumnFile = {
      id: "todo",
      name: "Custom Name",
      scope_id: SCOPE,
      order: 0,
      wip_limit: null,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "Do this.",
    };
    writeColumnFile(tmpDir, slug, customCol);

    await call(handlers, "POST", "/board/init", { body: { scope_id: SCOPE } });

    // Custom column file should be preserved
    const col = readColumnFile(tmpDir, slug, "todo");
    expect(col!.name).toBe("Custom Name");
    expect(col!.instructions).toBe("Do this.");
  });

  it("returns 400 when scope_id missing", async () => {
    const res = await call(handlers, "POST", "/board/init", { body: {} });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /column/instructions
// ---------------------------------------------------------------------------

describe("GET /column/instructions", () => {
  it("returns instructions for an existing column", async () => {
    const slug = slugify(SCOPE);
    const col: ColumnFile = {
      id: "todo",
      name: "To Do",
      scope_id: SCOPE,
      order: 0,
      wip_limit: null,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "Work on tasks here.",
    };
    writeColumnFile(tmpDir, slug, col);

    const res = await call(handlers, "GET", "/column/instructions", {
      query: { scope_id: SCOPE, column_id: "todo" },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.column_id).toBe("todo");
    expect(body.instructions).toBe("Work on tasks here.");
  });

  it("returns 404 when column file does not exist", async () => {
    const res = await call(handlers, "GET", "/column/instructions", {
      query: { scope_id: SCOPE, column_id: "nonexistent" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when params missing", async () => {
    const res = await call(handlers, "GET", "/column/instructions", {
      query: { scope_id: SCOPE },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /column/instructions
// ---------------------------------------------------------------------------

describe("POST /column/instructions", () => {
  it("saves instructions to the column file", async () => {
    const slug = slugify(SCOPE);
    const col: ColumnFile = {
      id: "todo",
      name: "To Do",
      scope_id: SCOPE,
      order: 0,
      wip_limit: null,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "",
    };
    writeColumnFile(tmpDir, slug, col);

    const res = await call(handlers, "POST", "/column/instructions", {
      body: { scope_id: SCOPE, column_id: "todo", instructions: "New instructions." },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.instructions).toBe("New instructions.");

    // Verify file on disk
    const updated = readColumnFile(tmpDir, slug, "todo");
    expect(updated!.instructions).toBe("New instructions.");
    // Frontmatter preserved
    expect(updated!.name).toBe("To Do");
    expect(updated!.wip_limit).toBeNull();
  });

  it("returns 404 when column file does not exist", async () => {
    const res = await call(handlers, "POST", "/column/instructions", {
      body: { scope_id: SCOPE, column_id: "nonexistent", instructions: "Test" },
    });
    expect(res.status).toBe(404);
  });

  it("Issue #3 regression: saves instructions for a default column that has not been persisted yet", async () => {
    // Issue #3: UI shows default in-memory columns before board is initialized.
    // Saving instructions for a default column (e.g. 'todo') should work without
    // requiring a separate POST /board/init first. The handler now auto-creates
    // default column files before writing instructions.
    // Before fix: returned 404 because the column file didn't exist.
    const res = await call(handlers, "POST", "/column/instructions", {
      body: { scope_id: SCOPE, column_id: "todo", instructions: "Work from top of list first." },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.instructions).toBe("Work from top of list first.");

    // Default column file must have been created on disk
    const slug = slugify(SCOPE);
    const updated = readColumnFile(tmpDir, slug, "todo");
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("To Do"); // default name preserved
    expect(updated!.instructions).toBe("Work from top of list first.");
  });

  it("Issue #3: auto-creates ALL default columns when saving instructions (not just the target)", async () => {
    await call(handlers, "POST", "/column/instructions", {
      body: { scope_id: SCOPE, column_id: "done", instructions: "Final check column." },
    });

    const slug = slugify(SCOPE);
    // All three default columns must exist on disk now
    expect(readColumnFile(tmpDir, slug, "todo")).not.toBeNull();
    expect(readColumnFile(tmpDir, slug, "in-progress")).not.toBeNull();
    expect(readColumnFile(tmpDir, slug, "done")).not.toBeNull();
  });

  it("returns 400 when params missing", async () => {
    const res = await call(handlers, "POST", "/column/instructions", {
      body: { scope_id: SCOPE, column_id: "todo" }, // missing instructions
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /card
// ---------------------------------------------------------------------------

describe("POST /card", () => {
  it("creates a card file in tasks/", async () => {
    setupDefaultColumns(tmpDir, SCOPE);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/card", {
      body: { scope_id: SCOPE, title: "New task" },
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.card_id).toBe("string");

    const cards = listCards(tmpDir);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("New task");
    expect(cards[0].column).toBe("todo");
  });

  it("places card in specified column", async () => {
    setupDefaultColumns(tmpDir, SCOPE);
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
    setupDefaultColumns(tmpDir, SCOPE);
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
    const slug = slugify(SCOPE);
    const cols = defaultColumnFiles(SCOPE);
    // todo with wip_limit=1
    const todoCol = { ...cols[0], wip_limit: 1 };
    writeColumnFile(tmpDir, slug, todoCol);
    writeColumnFile(tmpDir, slug, cols[1]);
    writeColumnFile(tmpDir, slug, cols[2]);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
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
    setupDefaultColumns(tmpDir, SCOPE);
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
    setupDefaultColumns(tmpDir, SCOPE);
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
    setupDefaultColumns(tmpDir, SCOPE);
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
    setupDefaultColumns(tmpDir, SCOPE);
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
    setupDefaultColumns(tmpDir, SCOPE);
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
    setupDefaultColumns(tmpDir, SCOPE);
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
    setupDefaultColumns(tmpDir, SCOPE);
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

    const card = readCard(tmpDir, "my-card");
    expect(card!.column).toBe("in-progress");
  });

  it("appends carry-forward comment on move", async () => {
    setupDefaultColumns(tmpDir, SCOPE);
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
    const slug = slugify(SCOPE);
    const cols = defaultColumnFiles(SCOPE);
    // Add exit criterion to todo column
    const todoCol = {
      ...cols[0],
      exit_criteria: [{ id: "ec-1", description: "Review", kind: "machine" as const }],
    };
    writeColumnFile(tmpDir, slug, todoCol);
    writeColumnFile(tmpDir, slug, cols[1]);
    writeColumnFile(tmpDir, slug, cols[2]);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
    writeCard(tmpDir, makeCardFile({ id: "my-card", column: "todo", checks: {} }));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "my-card", to_column_id: "in-progress" },
    });

    expect(res.status).toBe(422);
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("gate_blocked");
  });

  it("allows move with force=true despite unchecked criteria", async () => {
    const slug = slugify(SCOPE);
    const cols = defaultColumnFiles(SCOPE);
    const todoCol = {
      ...cols[0],
      exit_criteria: [{ id: "ec-1", description: "Review", kind: "human" as const }],
    };
    writeColumnFile(tmpDir, slug, todoCol);
    writeColumnFile(tmpDir, slug, cols[1]);
    writeColumnFile(tmpDir, slug, cols[2]);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
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
    const slug = slugify(SCOPE);
    const cols = defaultColumnFiles(SCOPE);
    // in-progress with wip_limit=1
    const inProgressCol = { ...cols[1], wip_limit: 1 };
    writeColumnFile(tmpDir, slug, cols[0]);
    writeColumnFile(tmpDir, slug, inProgressCol);
    writeColumnFile(tmpDir, slug, cols[2]);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
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
    setupDefaultColumns(tmpDir, SCOPE);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "nonexistent", to_column_id: "done" },
    });

    expect(res.status).toBe(404);
  });

  it("returns 422 when already in target column", async () => {
    setupDefaultColumns(tmpDir, SCOPE);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
    writeCard(tmpDir, makeCardFile({ id: "my-card", column: "todo" }));

    const res = await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "my-card", to_column_id: "todo" },
    });

    expect(res.status).toBe(422);
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("already_in_column");
  });

  it("routes entered_column into card context when destination has assigned actors", async () => {
    const slug = slugify(SCOPE);
    const cols = defaultColumnFiles(SCOPE);
    // in-progress assigned to my-worker
    const inProgressCol: ColumnFile = {
      ...cols[1],
      assigned_actors: [{ actor_ref: "my-worker", event_types: ["*"] }],
    };
    writeColumnFile(tmpDir, slug, cols[0]);
    writeColumnFile(tmpDir, slug, inProgressCol);
    writeColumnFile(tmpDir, slug, cols[2]);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
    writeCard(tmpDir, makeCardFile({ id: "my-card", column: "todo" }));

    await call(handlers, "POST", "/move", {
      body: { scope_id: SCOPE, card_id: "my-card", to_column_id: "in-progress" },
    });

    const routingEvent = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(routingEvent).toBeDefined();
    // Routed into card context (not endpoint-targeted)
    expect(routingEvent!.destination?.kind).toBe("context");
    // Card context id is set (not a column context)
    const cardContextId = routingEvent!.destination?.context_id;
    expect(cardContextId).toBeDefined();
    expect(typeof cardContextId).toBe("string");
    // Content references the card and column
    const data = routingEvent!.content.data as Record<string, unknown>;
    expect(data.card_id).toBe("my-card");
    expect(data.column_id).toBe("in-progress");
  });
});

// ---------------------------------------------------------------------------
// POST /columns
// ---------------------------------------------------------------------------

describe("POST /columns", () => {
  it("adds a new column", async () => {
    setupDefaultColumns(tmpDir, SCOPE);
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
    setupDefaultColumns(tmpDir, SCOPE);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "update", column_id: "todo", name: "Backlog" },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const cols = (body.board as Record<string, unknown>).columns as Array<{ id: string; name: string }>;
    const updatedCol = cols.find((c) => c.id === "todo");
    expect(updatedCol!.name).toBe("Backlog");
  });

  it("preserves instructions when updating column name", async () => {
    const slug = slugify(SCOPE);
    const col: ColumnFile = {
      id: "todo",
      name: "To Do",
      scope_id: SCOPE,
      order: 0,
      wip_limit: null,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "These are my instructions.",
    };
    writeColumnFile(tmpDir, slug, col);
    const cols = defaultColumnFiles(SCOPE);
    writeColumnFile(tmpDir, slug, cols[1]);
    writeColumnFile(tmpDir, slug, cols[2]);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "update", column_id: "todo", name: "Renamed" },
    });

    const updated = readColumnFile(tmpDir, slug, "todo");
    expect(updated!.name).toBe("Renamed");
    expect(updated!.instructions).toBe("These are my instructions.");
  });

  it("deletes a column and moves its cards to first remaining column", async () => {
    setupDefaultColumns(tmpDir, SCOPE);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));
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
    const slug = slugify(SCOPE);
    const cols = defaultColumnFiles(SCOPE);
    writeColumnFile(tmpDir, slug, cols[0]); // Only write todo
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

    const res = await call(handlers, "POST", "/columns", {
      body: { scope_id: SCOPE, action: "delete", column_id: "todo" },
    });

    expect(res.status).toBe(422);
  });

  it("reorders columns", async () => {
    setupDefaultColumns(tmpDir, SCOPE);
    saveSidecar(tmpDir, SCOPE, makeSidecar(SCOPE, "ws-test"));

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

// ---------------------------------------------------------------------------
// GET /board/instructions  (board done protocol)
// ---------------------------------------------------------------------------

describe("GET /board/instructions", () => {
  it("returns empty done_protocol when board.md does not exist", async () => {
    const res = await call(handlers, "GET", "/board/instructions", {
      query: { scope_id: SCOPE },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.scope_id).toBe(SCOPE);
    expect(body.done_protocol).toBe("");
  });

  it("returns existing done_protocol when board.md exists", async () => {
    // Trigger board init to create board.md
    setupDefaultColumns(tmpDir, SCOPE);
    await call(handlers, "POST", "/board/init", {
      body: { scope_id: SCOPE },
    });

    const res = await call(handlers, "GET", "/board/instructions", {
      query: { scope_id: SCOPE },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(typeof body.done_protocol).toBe("string");
    // Default protocol should mention check_criteria and move_card
    expect(body.done_protocol as string).toContain("check_criteria");
    expect(body.done_protocol as string).toContain("move_card");
  });

  it("returns 400 when scope_id is missing", async () => {
    const res = await call(handlers, "GET", "/board/instructions", {
      query: {},
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /board/instructions  (save board done protocol)
// ---------------------------------------------------------------------------

describe("POST /board/instructions", () => {
  it("saves a custom done protocol", async () => {
    const customProtocol = "My custom done protocol. Call move_card when done.";

    const res = await call(handlers, "POST", "/board/instructions", {
      body: { scope_id: SCOPE, done_protocol: customProtocol },
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.done_protocol).toBe(customProtocol);
  });

  it("persisted protocol is readable via GET", async () => {
    const customProtocol = "Test protocol — do work, then advance.";
    await call(handlers, "POST", "/board/instructions", {
      body: { scope_id: SCOPE, done_protocol: customProtocol },
    });

    const res = await call(handlers, "GET", "/board/instructions", {
      query: { scope_id: SCOPE },
    });
    const body = res.body as Record<string, unknown>;
    expect(body.done_protocol).toBe(customProtocol);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await call(handlers, "POST", "/board/instructions", {
      body: { scope_id: SCOPE }, // missing done_protocol
    });
    expect(res.status).toBe(400);
  });

  it("persists protocol to board.md file on disk", async () => {
    const customProtocol = "File-first done protocol.";
    await call(handlers, "POST", "/board/instructions", {
      body: { scope_id: SCOPE, done_protocol: customProtocol },
    });

    const slug = slugify(SCOPE);
    const bf = readBoardFile(tmpDir, slug);
    expect(bf).not.toBeNull();
    expect(bf!.done_protocol).toBe(customProtocol);
  });
});

// ---------------------------------------------------------------------------
// POST /board/init creates board.md with default done protocol
// ---------------------------------------------------------------------------

describe("POST /board/init — board.md creation", () => {
  it("creates board.md with default done protocol on init", async () => {
    setupDefaultColumns(tmpDir, SCOPE);
    const res = await call(handlers, "POST", "/board/init", {
      body: { scope_id: SCOPE },
    });

    expect(res.status).toBe(200);

    const slug = slugify(SCOPE);
    const bf = readBoardFile(tmpDir, slug);
    expect(bf).not.toBeNull();
    expect(bf!.scope_id).toBe(SCOPE);
    expect(bf!.done_protocol).toBe(DEFAULT_DONE_PROTOCOL);
  });

  it("does not overwrite existing board.md on re-init", async () => {
    setupDefaultColumns(tmpDir, SCOPE);
    // Init once
    await call(handlers, "POST", "/board/init", { body: { scope_id: SCOPE } });

    // Modify done protocol
    const customProtocol = "Custom protocol — should survive re-init.";
    await call(handlers, "POST", "/board/instructions", {
      body: { scope_id: SCOPE, done_protocol: customProtocol },
    });

    // Init again (idempotent)
    await call(handlers, "POST", "/board/init", { body: { scope_id: SCOPE } });

    const slug = slugify(SCOPE);
    const bf = readBoardFile(tmpDir, slug);
    expect(bf!.done_protocol).toBe(customProtocol);
  });
});

// ---------------------------------------------------------------------------
// POST /move — advance-on-conclusion: card stays on arrival (Part 1)
// ---------------------------------------------------------------------------

describe("POST /move — advance-on-conclusion behavior", () => {
  it("card entering agent-owned column is NOT immediately advanced (stays put)", async () => {
    const slug = slugify(SCOPE);
    const cols = defaultColumnFiles(SCOPE);
    // Make in-progress agent-owned with no exit criteria
    const agentCol: ColumnFile = {
      ...cols[1],
      assigned_actors: [{ actor_ref: "my-worker", event_types: ["*"] }],
      exit_criteria: [],
    };
    writeColumnFile(tmpDir, slug, cols[0]);
    writeColumnFile(tmpDir, slug, agentCol);
    writeColumnFile(tmpDir, slug, cols[2]);
    const sidecar = makeSidecar(SCOPE, "ws-test", { "in-progress": "ctx-agent" });
    saveSidecar(tmpDir, SCOPE, sidecar);
    writeCard(tmpDir, makeCardFile({ id: "stay-card", column: "todo" }));

    const res = await call(handlers, "POST", "/move", {
      body: {
        scope_id: SCOPE,
        card_id: "stay-card",
        to_column_id: "in-progress",
        force: false,
      },
    });

    expect(res.status).toBe(200);

    // Card must remain in the agent column, NOT auto-advanced to next column.
    const card = readCard(tmpDir, "stay-card");
    expect(card!.column).toBe("in-progress");

    // The routing event must have been emitted to wake the agent.
    const routingEvent = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(routingEvent).toBeDefined();

    // No overseer-sourced advance event should have fired.
    const overseerAdvance = bus.emittedEvents.filter(
      (e) =>
        e.type === "snowball.card.moved" &&
        (e.content.data as Record<string, unknown>)?.source === "overseer"
    );
    expect(overseerAdvance).toHaveLength(0);
  });
});
