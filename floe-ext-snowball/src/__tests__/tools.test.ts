/**
 * Tool gate enforcement tests — the critical invariant for Snowball's
 * asymmetric gating model (contract §5.2).
 *
 * AI movers: HARD blocked by unchecked exit criteria (no force)
 * Human movers (force=true): soft gate — warned but allowed
 * WIP limit: hard block for both
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { createTools } from "../tools/index.js";
import { saveSidecar, loadSidecar } from "../sidecar.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import { SIDECAR_SCHEMA, defaultColumns } from "../types.js";
import type { BoardSidecar } from "../types.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeCtx(tmpDir: string, bus: StubBusClient): ExtensionContext {
  return {
    workspacePath: tmpDir,
    busClient: bus,
    workspaceId: "ws:test",
    extensionName: "snowball",
    hooks: { on: () => {} },
  };
}

function makeSidecar(cards: BoardSidecar["cards"] = {}): BoardSidecar {
  const columns = defaultColumns();
  // Give in-progress column an exit criterion
  columns[1].exit_criteria = [
    { id: "ec-tests", description: "Tests pass", kind: "machine" },
  ];
  columns[1].wip_limit = 2;

  return {
    schema: SIDECAR_SCHEMA,
    scope_id: "scope:ws:test",
    workspace_id: "ws:test",
    columns,
    cards,
  };
}

async function callTool(
  tools: ReturnType<typeof createTools>,
  name: string,
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.execute("test-call-id", params) as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("move_card gate enforcement", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-tools-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hard blocks AI move when exit criteria unchecked (no force)", async () => {
    const sidecar = makeSidecar({
      ctx_card: {
        column_id: "in-progress",
        order: 0,
        title: "Test card",
        created_at: new Date().toISOString(),
        checks: {},
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card",
      to_column_id: "done",
      scope_id: "scope:ws:test",
      // No force → AI path
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("gate_blocked");
    expect(payload.unchecked_criteria).toHaveLength(1);
    expect(payload.unchecked_criteria[0].id).toBe("ec-tests");
  });

  it("allows AI move when all criteria are checked", async () => {
    const now = new Date().toISOString();
    const sidecar = makeSidecar({
      ctx_card: {
        column_id: "in-progress",
        order: 0,
        title: "Test card",
        created_at: now,
        checks: {
          "in-progress": {
            "ec-tests": { checked: true, checked_at: now, checked_by: null },
          },
        },
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card",
      to_column_id: "done",
      scope_id: "scope:ws:test",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.to_column_id).toBe("done");
  });

  it("allows human move with force=true even when criteria unchecked", async () => {
    const sidecar = makeSidecar({
      ctx_card: {
        column_id: "in-progress",
        order: 0,
        title: "Test card",
        created_at: new Date().toISOString(),
        checks: {},
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card",
      to_column_id: "done",
      scope_id: "scope:ws:test",
      force: true, // Human override
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.forced).toBe(true);
  });

  it("hard blocks WIP limit regardless of force", async () => {
    const sidecar = makeSidecar({
      ctx_existing_1: {
        column_id: "in-progress",
        order: 0,
        title: "Existing 1",
        created_at: new Date().toISOString(),
        checks: { "in-progress": { "ec-tests": { checked: true, checked_at: new Date().toISOString(), checked_by: null } } },
      },
      ctx_existing_2: {
        column_id: "in-progress",
        order: 1,
        title: "Existing 2",
        created_at: new Date().toISOString(),
        checks: { "in-progress": { "ec-tests": { checked: true, checked_at: new Date().toISOString(), checked_by: null } } },
      },
      ctx_new: {
        column_id: "todo",
        order: 0,
        title: "New card",
        created_at: new Date().toISOString(),
        checks: {},
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    // in-progress has WIP limit of 2 (already at 2)
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_new",
      to_column_id: "in-progress",
      scope_id: "scope:ws:test",
      force: true, // Even with force, WIP is hard-blocked
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("wip_limit_exceeded");
    expect(payload.current).toBe(2);
    expect(payload.limit).toBe(2);
  });

  it("returns card_not_found for unknown card", async () => {
    const sidecar = makeSidecar({});
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_nonexistent",
      to_column_id: "done",
      scope_id: "scope:ws:test",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("card_not_found");
  });
});

// ---------------------------------------------------------------------------
// check_criteria
// ---------------------------------------------------------------------------

describe("check_criteria", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-tools-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a criterion as checked", async () => {
    const sidecar = makeSidecar({
      ctx_card: {
        column_id: "in-progress",
        order: 0,
        title: "Test card",
        created_at: new Date().toISOString(),
        checks: {},
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "check_criteria", {
      card_id: "ctx_card",
      scope_id: "scope:ws:test",
      criterion_id: "ec-tests",
      checked: true,
      note: "CI green",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.checked).toBe(true);

    // Verify persisted
    const reloaded = loadSidecar(tmpDir, "scope:ws:test");
    const check = reloaded.cards["ctx_card"].checks["in-progress"]?.["ec-tests"];
    expect(check?.checked).toBe(true);
    expect(check?.checked_at).toBeTruthy();
  });

  it("records a criterion as unchecked", async () => {
    const now = new Date().toISOString();
    const sidecar = makeSidecar({
      ctx_card: {
        column_id: "in-progress",
        order: 0,
        title: "Test card",
        created_at: now,
        checks: {
          "in-progress": {
            "ec-tests": { checked: true, checked_at: now, checked_by: null },
          },
        },
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    await callTool(tools, "check_criteria", {
      card_id: "ctx_card",
      scope_id: "scope:ws:test",
      criterion_id: "ec-tests",
      checked: false,
    });

    const reloaded = loadSidecar(tmpDir, "scope:ws:test");
    const check = reloaded.cards["ctx_card"].checks["in-progress"]?.["ec-tests"];
    expect(check?.checked).toBe(false);
    expect(check?.checked_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// list_columns
// ---------------------------------------------------------------------------

describe("list_columns", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-tools-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns columns with card counts", async () => {
    const sidecar = makeSidecar({
      ctx_1: { column_id: "todo", order: 0, title: "Card 1", created_at: new Date().toISOString(), checks: {} },
      ctx_2: { column_id: "todo", order: 1, title: "Card 2", created_at: new Date().toISOString(), checks: {} },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "list_columns", {
      scope_id: "scope:ws:test",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.columns).toHaveLength(3);
    expect(payload.card_counts["todo"]).toBe(2);
    expect(payload.card_counts["in-progress"]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// create_card
// ---------------------------------------------------------------------------

describe("create_card", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-tools-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a card and returns context_id", async () => {
    const sidecar = makeSidecar({});
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "create_card", {
      scope_id: "scope:ws:test",
      title: "New feature card",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.card_id).toMatch(/^ctx_stub_/);
    expect(payload.column_id).toBe("todo"); // first column by default
    expect(payload.title).toBe("New feature card");

    // Verify sidecar was updated
    const reloaded = loadSidecar(tmpDir, "scope:ws:test");
    expect(reloaded.cards[payload.card_id]).toBeDefined();
    expect(reloaded.cards[payload.card_id].title).toBe("New feature card");
  });

  it("places card in specified column", async () => {
    const sidecar = makeSidecar({});
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "create_card", {
      scope_id: "scope:ws:test",
      title: "Already in progress",
      column_id: "in-progress",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.column_id).toBe("in-progress");
  });

  it("emits card.created event", async () => {
    const sidecar = makeSidecar({});
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    await callTool(tools, "create_card", {
      scope_id: "scope:ws:test",
      title: "Emitted card",
    });

    const emitted = bus.emittedEvents.find((e) => e.type === "snowball.card.created");
    expect(emitted).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// get_board_state
// ---------------------------------------------------------------------------

describe("get_board_state", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-tools-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns board snapshot with columns and cards", async () => {
    const sidecar = makeSidecar({
      ctx_1: { column_id: "todo", order: 0, title: "Card 1", created_at: new Date().toISOString(), checks: {} },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "get_board_state", {
      scope_id: "scope:ws:test",
    });

    const snapshot = JSON.parse(result.content[0].text);
    expect(snapshot.columns).toHaveLength(3);
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0].title).toBe("Card 1");
  });
});
