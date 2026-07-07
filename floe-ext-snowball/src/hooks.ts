/**
 * Snowball extension hooks.
 *
 * BeforeTurn (§4.3, R7):
 *  - Overseer receives full board snapshot (all columns + all cards)
 *  - Column workers receive only the cards in their owned column
 *  - Agents without a board context receive no injection
 *
 * Pulse (§4.3):
 *  - On `snowball-board-heartbeat`: run machine criteria checks for all boards
 */

import type { ExtensionContext, HookResult } from "./stub/extension-context.js";
import { loadSidecar, buildBoardSnapshot, renderCompactBoardSnapshot } from "./sidecar.js";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "./sidecar.js";

const OVERSEER_AGENT_ID = "snowball-overseer";
const BOARDS_DIR = (workspacePath: string): string =>
  join(workspacePath, ".floe", "extensions", "snowball", "boards");

/** Extract the agent_id from an endpoint_id (last colon-segment). */
function agentIdFromEndpoint(endpointId: string): string {
  const parts = endpointId.split(":");
  return parts[parts.length - 1] ?? endpointId;
}

/**
 * Enumerate all board sidecar files and return the set of scope_ids they
 * represent (un-slugified — we store slug→scope mapping in the sidecar itself).
 */
function listAllSidecars(workspacePath: string): Array<{ path: string; scopeId: string }> {
  const dir = BOARDS_DIR(workspacePath);
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    return files.map((f) => ({
      path: join(dir, f),
      scopeId: "", // will be populated from the sidecar's scope_id field
    }));
  } catch {
    return [];
  }
}

/**
 * Find the board scope that an agent is associated with.
 * The overseer is associated with ALL boards.
 * A column worker is associated with any board where their agent_id appears as
 * a column owner.
 */
async function findBoardScopesForAgent(
  workspacePath: string,
  agentId: string,
  workspaceId: string
): Promise<string[]> {
  const dir = BOARDS_DIR(workspacePath);
  if (!existsSync(dir)) return [];

  const { parse: parseYaml } = await import("yaml");
  const { readFileSync } = await import("node:fs");

  const scopes: string[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  } catch {
    return [];
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const sidecar = parseYaml(raw) as { scope_id?: string; workspace_id?: string; columns?: Array<{ owner?: { kind: string; agent_id?: string } }> };
      if (!sidecar.scope_id) continue;
      if (sidecar.workspace_id && sidecar.workspace_id !== workspaceId) continue;

      if (agentId === OVERSEER_AGENT_ID) {
        // Overseer sees all boards in this workspace
        scopes.push(sidecar.scope_id);
      } else {
        // Column workers only see boards where they own a column
        const ownsColumn = (sidecar.columns ?? []).some(
          (col) => col.owner?.kind === "agent" && col.owner.agent_id === agentId
        );
        if (ownsColumn) scopes.push(sidecar.scope_id);
      }
    } catch {
      // Ignore malformed sidecar files
    }
  }
  return scopes;
}

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

export function registerHooks(ctx: ExtensionContext): void {
  const { workspacePath, workspaceId } = ctx;

  // ── BeforeTurn ────────────────────────────────────────────────────────
  ctx.hooks.on("BeforeTurn", async (payload): Promise<HookResult | void> => {
    const endpointId = (payload.endpoint_id as string | undefined) ?? "";
    if (!endpointId) return;

    const agentId = agentIdFromEndpoint(endpointId);
    const scopes = await findBoardScopesForAgent(workspacePath, agentId, workspaceId);
    if (scopes.length === 0) return;

    // Build injection content
    const lines: string[] = [];
    for (const scopeId of scopes) {
      const sidecar = loadSidecar(workspacePath, scopeId);
      const snapshot = buildBoardSnapshot(sidecar);

      if (agentId === OVERSEER_AGENT_ID) {
        // Overseer: full board snapshot
        lines.push(renderCompactBoardSnapshot(snapshot));
      } else {
        // Column worker: only their cards (R7)
        const ownedColumns = sidecar.columns.filter(
          (col) => col.owner.kind === "agent" && col.owner.agent_id === agentId
        );
        const ownedColumnIds = new Set(ownedColumns.map((c) => c.id));
        const myCards = snapshot.cards.filter((c) => ownedColumnIds.has(c.column_id));

        if (myCards.length === 0) {
          lines.push(`Board ${scopeId}: no cards in your columns.`);
        } else {
          lines.push(`Board ${scopeId} — your cards:`);
          for (const card of myCards) {
            const col = sidecar.columns.find((c) => c.id === card.column_id);
            const totalCriteria = col?.exit_criteria.length ?? 0;
            const checkedCount = card.criteria_checks.filter((c) => c.checked).length;
            const criteriaStr =
              totalCriteria > 0
                ? ` [${checkedCount}/${totalCriteria} criteria]`
                : "";
            lines.push(`  - [${col?.name ?? card.column_id}] ${card.title}${criteriaStr} (${card.card_id})`);
          }
        }
      }
    }

    const content = lines.join("\n").slice(0, 3800); // hard cap per source
    if (!content) return;

    return {
      inject: {
        source: "snowball",
        content,
      },
    };
  });

  // ── Pulse ────────────────────────────────────────────────────────────
  ctx.hooks.on("Pulse", async (payload): Promise<void> => {
    const pulseId = payload.pulse_id as string | undefined;
    if (pulseId !== "snowball-board-heartbeat") return;

    // On heartbeat: nothing to do in the hook itself — the overseer agent
    // handles machine criteria evaluation in its turn (it calls
    // snowball_check_criteria and snowball_move_card tools directly).
    // The board state is already injected via BeforeTurn.
    // We log for observability only.
    console.info("[snowball] Board heartbeat pulse received — overseer will evaluate");
  });
}
