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
import { saveSidecar, slugify, loadSidecar } from "../sidecar.js";
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
    checks: {},
    body: "",
    ...overrides,
  };
}

/**
 * Standard 3-column board: todo (human) → agent-col (agent, AGENT_ID, ec-tests) → done (human).
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
      owner: { kind: "human" },
      exit_criteria: [],
      instructions: "",
    },
    {
      id: "agent-col",
      name: "Agent Work",
      scope_id: SCOPE,
      wip_limit: null,
      order: 1,
      owner: { kind: "agent", agent_id: AGENT_ID },
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
      owner: { kind: "human" },
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
// Issue #2 regression: stable column context across moves (tools path)
// ---------------------------------------------------------------------------

describe("Issue #2 regression — move_card tool reuses stable column context", () => {
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

  it("lazy init: move_card tool creates and persists context_id on first move", async () => {
    // ISSUE #2 REGRESSION: Before fix, move_card tool read an empty sidecar and
    // emitted entered_column WITHOUT context_id → a NEW context was created every
    // time. Fix: tool now does lazy board init, writes context_id to sidecar.
    writeBoard(tmpDir);
    // Empty sidecar — no column contexts pre-created
    saveSidecar(tmpDir, SCOPE, makeSidecar({}));
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "Card A", column: "todo" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "card-a",
      to_column_id: "agent-col",
      scope_id: SCOPE,
    });
    expect(JSON.parse(result.content[0].text).ok).toBe(true);

    // entered_column event must have context_id set
    const routingEvent = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(routingEvent).toBeDefined();
    expect(routingEvent!.context_id).toBeDefined();
    expect(typeof routingEvent!.context_id).toBe("string");

    // Sidecar must now have the context_id persisted
    const sidecar = loadSidecar(tmpDir, SCOPE);
    expect(sidecar.column_contexts["agent-col"]).toBeDefined();
    expect(sidecar.column_contexts["agent-col"]).toBe(routingEvent!.context_id);
  });

  it("stable context: two moves to same agent column use the same context_id", async () => {
    writeBoard(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar({}));
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "Card A", column: "todo" }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", title: "Card B", column: "todo", order: 1 }));

    const tools = createTools(makeCtx(tmpDir, bus));

    // Move card-a to agent-col
    await callTool(tools, "move_card", {
      card_id: "card-a",
      to_column_id: "agent-col",
      scope_id: SCOPE,
    });

    const firstRouting = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column" &&
        (e.content.data as Record<string, unknown>)?.card_id === "card-a"
    );
    expect(firstRouting?.context_id).toBeDefined();

    // Move card-b to agent-col
    bus.emittedEvents.length = 0; // reset to make filtering easy
    await callTool(tools, "move_card", {
      card_id: "card-b",
      to_column_id: "agent-col",
      scope_id: SCOPE,
    });

    const secondRouting = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column" &&
        (e.content.data as Record<string, unknown>)?.card_id === "card-b"
    );
    expect(secondRouting?.context_id).toBeDefined();

    // Both routing events must use the SAME context_id (the stable column context)
    expect(secondRouting!.context_id).toBe(firstRouting!.context_id);
  });

  it("only ONE createContext call for a given agent column across multiple moves", async () => {
    writeBoard(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar({}));
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "Card A", column: "todo" }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", title: "Card B", column: "todo", order: 1 }));

    const tools = createTools(makeCtx(tmpDir, bus));

    await callTool(tools, "move_card", {
      card_id: "card-a",
      to_column_id: "agent-col",
      scope_id: SCOPE,
    });
    await callTool(tools, "move_card", {
      card_id: "card-b",
      to_column_id: "agent-col",
      scope_id: SCOPE,
    });

    // Only 1 createContext for agent-col (lazy init on first move; reused on second)
    const agentColContexts = bus.createdContexts.filter(
      (c) => c.title === "Column: Agent Work"
    );
    expect(agentColContexts).toHaveLength(1);
  });

  it("move_card tool still works when board was pre-initialized (sidecar has contexts)", async () => {
    writeBoard(tmpDir);
    saveSidecar(tmpDir, SCOPE, makeSidecar({ "agent-col": "ctx-pre-existing", "done": "ctx-done" }));
    writeCard(tmpDir, makeCardFile({ id: "card-c", title: "Card C", column: "todo" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    await callTool(tools, "move_card", {
      card_id: "card-c",
      to_column_id: "agent-col",
      scope_id: SCOPE,
    });

    const routing = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column"
    );
    // Must reuse pre-existing context, not create a new one
    expect(routing?.context_id).toBe("ctx-pre-existing");
    expect(bus.createdContexts).toHaveLength(0);
  });
});
