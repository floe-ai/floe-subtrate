/**
 * Snowball extension hooks.
 *
 * Slice 2 (fm/snowball-col-instr-s2):
 *   - Board discovery now reads committed column files (boards/<slug>/columns/)
 *     instead of the gitignored sidecar directory.
 *   - BeforeTurn injection now includes the column's agent instructions:
 *       - Column workers: their column's instructions + their cards
 *       - Overseer: full board snapshot + all columns' instructions
 *
 * BeforeTurn (§4.3, R7):
 *  - Overseer receives full board snapshot (all columns + all cards + all instructions)
 *  - Column workers receive only the cards in their owned columns + column instructions
 *  - Agents without a board context receive no injection
 */

import type { ExtensionContext, HookResult } from "./stub/extension-context.js";
import {
  loadSidecar,
  slugify,
  buildBoardSnapshot,
  renderCompactBoardSnapshot,
} from "./sidecar.js";
import {
  listColumnFiles,
  findBoardScopesForAgentFromFiles,
} from "./column-file.js";

const OVERSEER_AGENT_ID = "snowball-overseer";

/** Extract the agent_id from an endpoint_id (last colon-segment). */
function agentIdFromEndpoint(endpointId: string): string {
  const parts = endpointId.split(":");
  return parts[parts.length - 1] ?? endpointId;
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

    // Board discovery: scan committed boards/<slug>/columns/ directory.
    // Works after a fresh clone (no sidecar needed).
    const scopes = findBoardScopesForAgentFromFiles(
      workspacePath,
      agentId,
      OVERSEER_AGENT_ID
    );
    if (scopes.length === 0) return;

    const lines: string[] = [];
    for (const scopeId of scopes) {
      const slug = slugify(scopeId);
      const columns = listColumnFiles(workspacePath, slug);
      if (columns.length === 0) continue;

      const sidecar = loadSidecar(workspacePath, scopeId);
      const snapshot = buildBoardSnapshot(workspacePath, sidecar, columns);

      if (agentId === OVERSEER_AGENT_ID) {
        // Overseer: full board snapshot + all column instructions
        lines.push(renderCompactBoardSnapshot(snapshot));

        // Append column instructions for any column that has them
        const colsWithInstructions = columns.filter(
          (c) => c.instructions.trim().length > 0
        );
        if (colsWithInstructions.length > 0) {
          lines.push("## Column Instructions");
          for (const col of colsWithInstructions) {
            lines.push(`\n### ${col.name}`);
            lines.push(col.instructions.trim());
          }
        }
      } else {
        // Column worker: only their cards + their column's instructions (R7)
        const ownedColumns = columns.filter(
          (col) =>
            col.owner.kind === "agent" && col.owner.agent_id === agentId
        );
        const ownedColumnIds = new Set(ownedColumns.map((c) => c.id));
        const myCards = snapshot.cards.filter((c) =>
          ownedColumnIds.has(c.column_id)
        );

        // Inject column instructions first
        for (const col of ownedColumns) {
          if (col.instructions.trim().length > 0) {
            lines.push(`## Column Instructions: ${col.name}`);
            lines.push(col.instructions.trim());
            lines.push("");
          }
        }

        // Then inject card list
        if (myCards.length === 0) {
          lines.push(`Board ${scopeId}: no cards in your columns.`);
        } else {
          lines.push(`Board ${scopeId} — your cards:`);
          for (const card of myCards) {
            const col = columns.find((c) => c.id === card.column_id);
            const totalCriteria = col?.exit_criteria.length ?? 0;
            const checkedCount = card.criteria_checks.filter(
              (c) => c.checked
            ).length;
            const criteriaStr =
              totalCriteria > 0
                ? ` [${checkedCount}/${totalCriteria} criteria]`
                : "";
            lines.push(
              `  - [${col?.name ?? card.column_id}] ${card.title}${criteriaStr} (${card.card_id})`
            );
          }
        }
      }
    }

    const content = lines.join("\n").slice(0, 3800);
    if (!content) return;

    return {
      inject: {
        source: "snowball",
        content,
      },
    };
  });
}
