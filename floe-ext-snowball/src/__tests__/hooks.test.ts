/**
 * BeforeTurn hook injection tests — regression coverage for Issues #1 and #2.
 *
 * Issue #1: criteria not ticked, card doesn't move.
 *   Root fix: BeforeTurn injection now lists unchecked criteria IDs so the
 *   agent can call check_criteria without a separate get_board_state call.
 *
 * Issue #2: new context created on every card move.
 *   Root fix: move_card tool now does lazy board init before emitting
 *   entered_column, ensuring context_id is always set (stable context reuse).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { registerHooks } from "../hooks.js";
import { createTools } from "../tools/index.js";
import { saveSidecar, slugify } from "../sidecar.js";
import { writeCard, readCard } from "../card-file.js";
import {
  writeColumnFile,
  type ColumnFile,
} from "../column-file.js";
import { writeBoardFile } from "../board-file.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext, HookResult, HookName, HookHandler } from "../stub/extension-context.js";
import { SIDECAR_SCHEMA } from "../types.js";
import type { BoardSidecar, CardFile } from "../types.js";

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
  });
  return cols;
}

/**
 * More reliable injection capture using a promise.
 */
async function getBeforeTurnInjection(
  tmpDir: string,
  bus: StubBusClient,
  agentId: string
): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const ctx = makeCtx(tmpDir, bus);
    const endpointId = `actor:${WS_ID}:${agentId}`;

    const hookCtx: ExtensionContext = {
      ...ctx,
      hooks: {
        on: (_event: HookName, handler: HookHandler) => {
          (handler as (payload: Record<string, unknown>) => Promise<HookResult | void>)({ endpoint_id: endpointId }).then((result) => {
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
// Issue #1 regression: BeforeTurn injection includes criteria IDs
// ---------------------------------------------------------------------------

describe("Issue #1 regression — BeforeTurn injection includes criteria IDs", () => {
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
    saveSidecar(tmpDir, SCOPE, makeSidecar());
    writeCard(tmpDir, makeCardFile({ column: "agent-col" }));

    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID);
    expect(injection).not.toBeNull();
    expect(injection).toContain("Done Protocol");
  });

  it("injects column instructions for column worker", async () => {
    writeBoard(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar());
    writeCard(tmpDir, makeCardFile({ column: "agent-col" }));

    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID);
    expect(injection).not.toBeNull();
    expect(injection).toContain("Review each card carefully before advancing.");
  });

  it("injects card list with criteria count", async () => {
    writeBoard(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar());
    writeCard(tmpDir, makeCardFile({ id: "my-card", title: "My Task", column: "agent-col" }));

    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID);
    expect(injection).not.toBeNull();
    expect(injection).toContain("My Task");
    expect(injection).toContain("[0/2 criteria]");
  });

  it("lists unchecked criteria IDs in injection so agent can call check_criteria directly", async () => {
    // ISSUE #1 REGRESSION: Before fix, injection showed '[0/2 criteria]' but
    // did NOT include the criterion_id values. The agent had to call
    // get_board_state separately to discover the IDs. Now they are listed
    // inline so the agent can immediately call check_criteria.
    writeBoard(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar());
    writeCard(tmpDir, makeCardFile({ id: "my-card", title: "My Task", column: "agent-col" }));

    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID);
    expect(injection).not.toBeNull();
    // Both criterion IDs must appear in the injection
    expect(injection).toContain("ec-tests");
    expect(injection).toContain("ec-review");
    // Their descriptions must also appear
    expect(injection).toContain("Tests pass");
    expect(injection).toContain("Code reviewed");
  });

  it("does NOT list criteria IDs for already-checked criteria", async () => {
    writeBoard(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar());
    const now = new Date().toISOString();
    // One criterion checked, one not
    writeCard(tmpDir, makeCardFile({
      id: "my-card",
      title: "Partial Card",
      column: "agent-col",
      checks: {
        "agent-col": {
          "ec-tests": { checked: true, checked_at: now, checked_by: null },
        },
      },
    }));

    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID);
    expect(injection).not.toBeNull();
    // ec-review is unchecked → must appear
    expect(injection).toContain("ec-review");
    expect(injection).toContain("Code reviewed");
    // ec-tests is checked → must NOT appear in unchecked list
    // (it may still appear in the criteria count, but not as an unchecked criterion)
    const uncheckedSection = injection!.split("Unchecked criteria")[1] ?? "";
    expect(uncheckedSection).not.toContain("ec-tests");
  });

  it("full agent protocol loop: check_criteria then move_card advances the card", async () => {
    // ISSUE #1 FULL REGRESSION: agent calls check_criteria for all criteria,
    // then calls move_card. Card must advance to the next column.
    writeBoard(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar({ "agent-col": "ctx-agent-col", "done": "ctx-done" }));
    writeCard(tmpDir, makeCardFile({ id: "loop-card", title: "Loop Card", column: "agent-col" }));

    const tools = createTools(makeCtx(tmpDir, bus));

    // Step 1: BeforeTurn injection shows criteria IDs
    const injection = await getBeforeTurnInjection(tmpDir, bus, AGENT_ID);
    expect(injection).toContain("ec-tests");
    expect(injection).toContain("ec-review");

    // Step 2: Agent checks criterion ec-tests
    const check1 = await callTool(tools, "check_criteria", {
      card_id: "loop-card",
      scope_id: SCOPE,
      criterion_id: "ec-tests",
      checked: true,
      note: "All 47 assertions green",
    });
    expect(JSON.parse(check1.content[0].text).ok).toBe(true);

    // Step 3: Agent checks criterion ec-review
    const check2 = await callTool(tools, "check_criteria", {
      card_id: "loop-card",
      scope_id: SCOPE,
      criterion_id: "ec-review",
      checked: true,
      note: "Reviewed by senior dev",
    });
    expect(JSON.parse(check2.content[0].text).ok).toBe(true);

    // Step 4: Agent calls move_card — must succeed now that all criteria are checked
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
    saveSidecar(tmpDir, SCOPE, makeSidecar());
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
    saveSidecar(tmpDir, SCOPE, makeSidecar({}));
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
    saveSidecar(tmpDir, SCOPE, makeSidecar({}));
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
    saveSidecar(tmpDir, SCOPE, makeSidecar({}));
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
    saveSidecar(tmpDir, SCOPE, makeSidecar({}));
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
