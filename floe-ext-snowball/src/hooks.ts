/**
 * Snowball extension hooks.
 *
 * Slice 6 (fm/snowball-ctx-retire):
 *   Sidecar eliminated. buildBoardSnapshot reads from board file + card files only.
 *   No loadSidecar call. buildBoardSnapshot signature updated.
 *
 * Slice 5 (fm/snowball-col-board-s5):
 *   Board discovery now reads board.md (via board-file.ts).
 *   column-file.ts is deleted; findBoardScopesForAgentFromFiles moved to board-file.ts.
 *
 * BeforeTurn injection:
 *  - Snowball (system steward): full board snapshot + all column instructions
 *  - Column workers: done protocol + column instructions + cards with unchecked criteria
 *  - Agents without board context receive no injection
 */

import type { ExtensionContext, HookResult } from "./stub/extension-context.js";
import { slugify } from "./board-file.js";
import { buildBoardSnapshot, renderCompactBoardSnapshot } from "./board-snapshot.js";
import {
  listColumnsFromBoard,
  findBoardScopesForAgentFromFiles,
  ensureBoardFile,
} from "./board-file.js";
import { listCards } from "./card-file.js";

const SNOWBALL_AGENT_ID = "snowball";

function agentIdFromEndpoint(endpointId: string): string {
  const parts = endpointId.split(":");
  return parts[parts.length - 1] ?? endpointId;
}

export function registerHooks(ctx: ExtensionContext): void {
  const { workspacePath, workspaceId } = ctx;

  ctx.hooks.on("BeforeTurn", async (payload): Promise<HookResult | void> => {
    const endpointId = (payload.endpoint_id as string | undefined) ?? "";
    if (!endpointId) return;
    const agentId = agentIdFromEndpoint(endpointId);

    const scopes = findBoardScopesForAgentFromFiles(workspacePath, agentId, SNOWBALL_AGENT_ID);
    if (scopes.length === 0) return;

    const lines: string[] = [];

    // D-A: extract typed origin reference — symmetric with emit destination.
    // When origin.kind === "context" (a card-context delivery), we narrow the
    // injected board view to ONLY that card. This enforces the invariant:
    // a turn built for context A sees no data from context B.
    const originRef = (payload as any).origin as { id: string; kind: string } | undefined;
    const originContextId: string | null =
      originRef?.kind === "context" && typeof originRef.id === "string"
        ? originRef.id
        : null;

    for (const scopeId of scopes) {
      const slug = slugify(scopeId);
      const columns = listColumnsFromBoard(workspacePath, slug);
      if (columns.length === 0) continue;

      const snapshot = buildBoardSnapshot(workspacePath, scopeId, workspaceId, columns);

      if (agentId === SNOWBALL_AGENT_ID) {
        // System steward: board-wide view — this is its job, not a leak.
        lines.push(renderCompactBoardSnapshot(snapshot));
        const colsWithInstructions = columns.filter((c) => c.instructions.trim().length > 0);
        if (colsWithInstructions.length > 0) {
          lines.push("## Column Instructions");
          for (const col of colsWithInstructions) {
            lines.push(`\n### ${col.name}`);
            lines.push(col.instructions.trim());
          }
        }
      } else if (originContextId !== null) {
        // D-A narrow path: origin identifies a specific context — inject only
        // the card whose context_id matches. The card file carries context_id in
        // its frontmatter (written at card-creation time, Slice 4 invariant).
        const allCardFiles = listCards(workspacePath);
        const matchingCard = allCardFiles.find((cf) => cf.context_id === originContextId);
        if (!matchingCard) continue; // delivery not about a known card — skip this scope

        const cardCol = columns.find((c) => c.id === matchingCard.column);
        if (!cardCol) continue; // card's column not in this board — skip

        // Done protocol (now that we know we have a matching card)
        const boardFile = ensureBoardFile(workspacePath, slug, scopeId);
        if (boardFile.done_protocol.trim().length > 0) {
          lines.push(boardFile.done_protocol.trim());
          lines.push("");
        }

        // Inject only this card's column instructions
        if (cardCol.instructions.trim().length > 0) {
          lines.push(`## Column Instructions: ${cardCol.name}`);
          lines.push(cardCol.instructions.trim());
          lines.push("");
        }

        // Inject only this card
        const colChecks = matchingCard.checks[matchingCard.column] ?? {};
        const checkedCount = Object.values(colChecks).filter((c) => c.checked).length;
        const totalCriteria = cardCol.exit_criteria.length;
        const criteriaStr = totalCriteria > 0 ? ` [${checkedCount}/${totalCriteria} criteria]` : "";
        lines.push(`Board ${scopeId} — current card:`);
        lines.push(`  - [${cardCol.name}] ${matchingCard.title}${criteriaStr} (${matchingCard.id})`);

        const uncheckedCriteria = cardCol.exit_criteria.filter((ec) => {
          return !colChecks[ec.id]?.checked;
        });
        if (uncheckedCriteria.length > 0) {
          lines.push(`    Unchecked criteria (call snowball_check_criteria for each):`);
          for (const ec of uncheckedCriteria) {
            lines.push(`      criterion_id="${ec.id}" — ${ec.description}`);
          }
        }
      } else {
        // No origin context: board-wide view for this agent's owned columns.
        // Used for pulse deliveries and other non-context-scoped events.
        const boardFile = ensureBoardFile(workspacePath, slug, scopeId);
        if (boardFile.done_protocol.trim().length > 0) {
          lines.push(boardFile.done_protocol.trim());
          lines.push("");
        }

        const ownedColumns = columns.filter(
          (col) => col.assigned_actors.some((a) => a.actor_ref === agentId)
        );
        const ownedColumnIds = new Set(ownedColumns.map((c) => c.id));
        const myCards = snapshot.cards.filter((c) => ownedColumnIds.has(c.column_id));

        for (const col of ownedColumns) {
          if (col.instructions.trim().length > 0) {
            lines.push(`## Column Instructions: ${col.name}`);
            lines.push(col.instructions.trim());
            lines.push("");
          }
        }

        if (myCards.length === 0) {
          lines.push(`Board ${scopeId}: no cards in your columns.`);
        } else {
          lines.push(`Board ${scopeId} — your cards:`);
          for (const card of myCards) {
            const col = columns.find((c) => c.id === card.column_id);
            const totalCriteria = col?.exit_criteria.length ?? 0;
            const checkedCount = card.criteria_checks.filter((c) => c.checked).length;
            const criteriaStr = totalCriteria > 0 ? ` [${checkedCount}/${totalCriteria} criteria]` : "";
            lines.push(`  - [${col?.name ?? card.column_id}] ${card.title}${criteriaStr} (${card.card_id})`);
            if (col && col.exit_criteria.length > 0) {
              const uncheckedCriteria = col.exit_criteria.filter((ec) => {
                const check = card.criteria_checks.find((c) => c.criterionId === ec.id);
                return !check?.checked;
              });
              if (uncheckedCriteria.length > 0) {
                lines.push(`    Unchecked criteria (call snowball_check_criteria for each):`);
                for (const ec of uncheckedCriteria) {
                  lines.push(`      criterion_id="${ec.id}" — ${ec.description}`);
                }
              }
            }
          }
        }
      }
    }

    const content = lines.join("\n").slice(0, 3800);
    if (!content) return;
    return { inject: { source: "snowball", content } };
  });
}
