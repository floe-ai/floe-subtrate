/**
 * BeforeTurn hook injection tests.
 *
 * Slice C (fm/floe-instruction-inject-once):
 *   BeforeTurn now returns ONLY resolved instructions (done_protocol + column
 *   instructions). No per-turn card list, no board snapshot, no criteria IDs.
 *   Agents call snowball_get_board_state for live card state.
 *
 * Retained regression coverage:
 *   - done protocol and column instructions are still injected
 *   - D-A isolation: no injection when origin maps to no card
 *   - Card tool flows (move_card / check_criteria) are unaffected
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { registerHooks } from "../hooks.js";
import { createTools } from "../tools/index.js";
import { slugify } from "../board-file.js";
import { writeCard, readCard } from "../card-file.js";
import {
  writeColumnToBoard as writeColumnFile,
} from "../board-file.js";
import { writeBoardFile } from "../board-file.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext, HookResult, HookName, HookHandler } from "../stub/extension-context.js";
import type { CardFile, ColumnFile } from "../types.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const SCOPE = "scope:ws:test";
const WS_ID = "ws:test";
const AGENT_ID = "col-worker";

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

/**
 * Standard 3-column board: todo (no actors) → agent-col (AGENT_ID assigned, ec-tests) → done (no actors).
 */
function writeBoard(tmpDir: string): ColumnFile[] {
  const slug = slugify(SCOPE);
  const cols: ColumnFile[] = [
    {
      id: "todo",
      name: "To Do",
      scope_id: SCOPE,
      wip_limit: null,
      order: 0,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "",
    },
    {
      id: "agent-col",
      name: "Agent Work",
      scope_id: SCOPE,
      wip_limit: null,
      order: 1,
      assigned_actors: [{ actor_ref: AGENT_ID, event_types: ["*"] }],
      exit_criteria: [
        { id: "ec-tests", description: "Tests pass", kind: "machine" },
        { id: "ec-review", description: "Code reviewed", kind: "human" },
      ],
      instructions: "Review each card carefully before advancing.",
    },
    {
      id: "done",
      name: "Done",
      scope_id: SCOPE,
      wip_limit: null,
      order: 2,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "",
    },
  ];
  for (const col of cols) writeColumnFile(tmpDir, slug, col);
  writeBoardFile(tmpDir, slug, {
    scope_id: SCOPE,
    done_protocol: "## Done Protocol\nCheck criteria, then call move_card.",
    columns: cols,
  });
  return cols;
}

/**
 * More reliable injection capture using a promise.
 */
async function getBeforeTurnInjection(
  tmpDir: string,
  bus: StubBusClient,
  agentId: string,
  extraPayload: Record<string, unknown> = {}
): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const ctx = makeCtx(tmpDir, bus);
    const endpointId = `actor:${WS_ID}:${agentId}`;

    const hookCtx: ExtensionContext = {
      ...ctx,
      hooks: {
        on: (_event: HookName, handler: HookHandler) => {
          (handler as (payload: Record<string, unknown>) => Promise<HookResult | void>)({ endpoint_id: endpointId, ...extraPayload }).then((result) => {
            if (!resolved) {
              resolved = true;
              if (result && "inject" in result) {
                const inject = (result as HookResult).inject;
                const content = inject ? (inject["content"] as string | undefined) : undefined;
                resolve(content ?? null);
              } else {
                resolve(null);
              }
            }
          }).catch(() => {
            if (!resolved) {
              resolved = true;
              resolve(null);
            }
          });
        },
      },
    };

    registerHooks(hookCtx);
  });
}

async function callTool(
  tools: ReturnType<typeof createTools>,
  name: string,
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.execute("test-call-id", params) as ReturnType<typeof tool.execute>;
}

// ---------------------------------------------------------------------------
// BeforeTurn injection: done protocol + column instructions
// ---------------------------------------------------------------------------

describe("BeforeTurn injection — resolved instructions (Slice C)", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-hooks-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("injects done protocol for column worker", async () => {
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ column: "agent-col" }));

    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID);
    expect(injection).not.toBeNull();
    expect(injection).toContain("Done Protocol");
  });

  it("injects column instructions for column worker", async () => {
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ column: "agent-col" }));

    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID);
    expect(injection).not.toBeNull();
    expect(injection).toContain("Review each card carefully before advancing.");
  });

  it("does NOT inject card list or criteria — agents use tools for live state", async () => {
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "my-card", title: "My Task", column: "agent-col" }));

    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID);
    // Injection must contain instructions but NOT card titles or criteria IDs
    expect(injection).toContain("Done Protocol");
    expect(injection).toContain("Review each card carefully before advancing.");
    // Card list must NOT appear in injection
    expect(injection).not.toContain("My Task");
    expect(injection).not.toContain("ec-tests");
    expect(injection).not.toContain("ec-review");
  });

  it("full agent protocol loop: check_criteria then move_card advances the card", async () => {
    // Tools still work correctly; agents get criteria via snowball_get_board_state
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "loop-card", title: "Loop Card", column: "agent-col" }));

    const tools = createTools(makeCtx(tmpDir, bus));

    // BeforeTurn injection contains instructions only (no criteria IDs)
    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID);
    expect(injection).toContain("Done Protocol");
    expect(injection).toContain("Review each card carefully before advancing.");
    expect(injection).not.toContain("ec-tests");

    // Step 1: Agent checks criterion ec-tests
    const check1 = await callTool(tools, "check_criteria", {
      card_id: "loop-card",
      scope_id: SCOPE,
      criterion_id: "ec-tests",
      checked: true,
      note: "All 47 assertions green",
    });
    expect(JSON.parse(check1.content[0].text).ok).toBe(true);

    // Step 2: Agent checks criterion ec-review
    const check2 = await callTool(tools, "check_criteria", {
      card_id: "loop-card",
      scope_id: SCOPE,
      criterion_id: "ec-review",
      checked: true,
      note: "Reviewed by senior dev",
    });
    expect(JSON.parse(check2.content[0].text).ok).toBe(true);

    // Step 3: Agent calls move_card — must succeed now that all criteria are checked
    const move = await callTool(tools, "move_card", {
      card_id: "loop-card",
      to_column_id: "done",
      scope_id: SCOPE,
    });
    const moveResult = JSON.parse(move.content[0].text);
    expect(moveResult.ok).toBe(true);
    expect(moveResult.to_column_id).toBe("done");

    // Card must be in 'done' now
    const card = readCard(tmpDir, "loop-card");
    expect(card!.column).toBe("done");
  });

  it("returns null injection when agent has no board columns", async () => {
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ column: "agent-col" }));

    // Different agent not owning any column → no injection
    const injection = await getBeforeTurnInjection(tmpDir, bus, "other-agent");
    expect(injection).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("Slice 4 regression — move_card tool uses stable card context", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-ctx-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lazy init: move_card tool creates and persists card context_id on first move", async () => {
    // Legacy card (no context_id). First move to an agent column creates
    // the card context lazily and writes it to the card frontmatter.
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "Card A", column: "todo" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "card-a",
      to_column_id: "agent-col",
      scope_id: SCOPE,
    });
    expect(JSON.parse(result.content[0].text).ok).toBe(true);

    // entered_column event must use destination.kind="context"
    const routingEvent = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(routingEvent).toBeDefined();
    expect(routingEvent!.destination?.kind).toBe("context");
    const cardCtxId = routingEvent!.destination?.context_id;
    expect(cardCtxId).toBeDefined();
    expect(typeof cardCtxId).toBe("string");

    // Card frontmatter must have context_id written
    const card = readCard(tmpDir, "card-a");
    expect(card!.context_id).toBe(cardCtxId);
  });

  it("stable context: two moves of the SAME card use the same card context_id", async () => {
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "Card A", column: "todo" }));

    const tools = createTools(makeCtx(tmpDir, bus));

    // Move card-a to agent-col
    await callTool(tools, "move_card", {
      card_id: "card-a",
      to_column_id: "agent-col",
      scope_id: SCOPE,
    });

    const firstCtxId = (bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column"
    ))?.destination?.context_id;
    expect(firstCtxId).toBeDefined();

    // Check all criteria so the move gate passes
    await callTool(tools, "check_criteria", { card_id: "card-a", scope_id: SCOPE, criterion_id: "ec-tests", checked: true });
    await callTool(tools, "check_criteria", { card_id: "card-a", scope_id: SCOPE, criterion_id: "ec-review", checked: true });

    // Move card-a to done
    bus.emittedEvents.length = 0;
    await callTool(tools, "move_card", { card_id: "card-a", to_column_id: "done", scope_id: SCOPE });

    // "done" has no assigned actors — no entered_column. Card context_id should persist.
    const card = readCard(tmpDir, "card-a");
    expect(card!.context_id).toBe(firstCtxId);
  });

  it("two different cards each get their own card context_id", async () => {
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "Card A", column: "todo" }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", title: "Card B", column: "todo", order: 1 }));

    const tools = createTools(makeCtx(tmpDir, bus));

    await callTool(tools, "move_card", { card_id: "card-a", to_column_id: "agent-col", scope_id: SCOPE });
    await callTool(tools, "move_card", { card_id: "card-b", to_column_id: "agent-col", scope_id: SCOPE });

    const cardA = readCard(tmpDir, "card-a");
    const cardB = readCard(tmpDir, "card-b");
    expect(cardA!.context_id).toBeDefined();
    expect(cardB!.context_id).toBeDefined();
    // Each card has its OWN context (not shared)
    expect(cardA!.context_id).not.toBe(cardB!.context_id);
  });

  it("move_card tool works when card already has context_id (no double context creation)", async () => {
    writeBoard(tmpDir);
    const existingCtxId = "ctx-pre-existing-card";
    bus.seedContext({
      context_id: existingCtxId,
      workspace_id: WS_ID,
      scope_id: SCOPE,
      created_at: new Date().toISOString(),
      title: "Card C",
      first_message_preview: null,
      participants: [],
    });
    writeCard(tmpDir, makeCardFile({ id: "card-c", title: "Card C", column: "todo", context_id: existingCtxId }));

    const tools = createTools(makeCtx(tmpDir, bus));
    await callTool(tools, "move_card", { card_id: "card-c", to_column_id: "agent-col", scope_id: SCOPE });

    const routing = bus.emittedEvents.find((e) => e.type === "snowball.card.entered_column");
    // Must reuse existing card context, not create a new one
    expect(routing?.destination?.context_id).toBe(existingCtxId);
    expect(bus.createdContexts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D-A context isolation: BeforeTurn overlay narrowing (fm/floe-ctx-iso)
// Slice C: injection narrows to COLUMN INSTRUCTIONS for the card's column
// (not card titles, since cards are no longer injected)
// ---------------------------------------------------------------------------

describe("D-A context isolation — BeforeTurn resolves instructions for card's column", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-ctx-iso-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("with origin.kind=context: injects done protocol + column instructions for the matched card's column", async () => {
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({
      id: "card-a",
      title: "Card A",
      column: "agent-col",
      context_id: "ctx_card_a",
      order: 0
    }));
    writeCard(tmpDir, makeCardFile({
      id: "card-b",
      title: "Card B",
      column: "agent-col",
      context_id: "ctx_card_b",
      order: 1
    }));

    // Delivery arrives on card A's context
    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID, {
      origin: { id: "ctx_card_a", kind: "context" }
    });

    expect(injection).not.toBeNull();
    // Done protocol must appear
    expect(injection).toContain("Done Protocol");
    // Column instructions must appear
    expect(injection).toContain("Review each card carefully before advancing.");
    // Card titles must NOT appear — agents use tools for live card state
    expect(injection).not.toContain("Card A");
    expect(injection).not.toContain("Card B");
  });

  it("with origin.kind=context: no injection when origin maps to no card", async () => {
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({
      id: "card-a",
      title: "Card A",
      column: "agent-col",
      context_id: "ctx_card_a",
    }));

    // Delivery on a context_id that matches no card
    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID, {
      origin: { id: "ctx_unknown_xyz", kind: "context" }
    });

    // No injection — the turn is not about a known card
    expect(injection).toBeNull();
  });

  it("without origin (no context): injects done protocol + owned column instructions only", async () => {
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "Card A", column: "agent-col", context_id: "ctx_card_a", order: 0 }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", title: "Card B", column: "agent-col", context_id: "ctx_card_b", order: 1 }));

    // Delivery with no origin (e.g. pulse event)
    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID);

    expect(injection).not.toBeNull();
    // Done protocol and column instructions must appear
    expect(injection).toContain("Done Protocol");
    expect(injection).toContain("Review each card carefully before advancing.");
    // Card titles must NOT appear
    expect(injection).not.toContain("Card A");
    expect(injection).not.toContain("Card B");
  });

  it("origin context: injects done protocol + column instructions (no criteria)", async () => {
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({
      id: "card-a",
      title: "Card A",
      column: "agent-col",
      context_id: "ctx_card_a",
    }));

    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID, {
      origin: { id: "ctx_card_a", kind: "context" }
    });

    expect(injection).not.toBeNull();
    // Column instructions must appear
    expect(injection).toContain("Review each card carefully before advancing.");
    // Criteria IDs must NOT appear — agents call get_board_state for live criteria
    expect(injection).not.toContain("ec-tests");
    expect(injection).not.toContain("ec-review");
  });

  it("system actor (snowball): injects column instructions, no board snapshot", async () => {
    writeBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "Card A", column: "agent-col", context_id: "ctx_card_a" }));

    const injection = await getBeforeTurnInjection(tmpDir, bus, "snowball");

    expect(injection).not.toBeNull();
    // Column instructions must appear
    expect(injection).toContain("Review each card carefully before advancing.");
    // Board snapshot / card list must NOT appear
    expect(injection).not.toContain("Card A");
    expect(injection).not.toContain("Board");
  });
});

