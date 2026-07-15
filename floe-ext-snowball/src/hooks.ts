/**
 * Snowball extension hooks.
 *
 * Slice C (fm/floe-instruction-inject-once):
 *   BeforeTurn now returns ONLY resolved instructions (done_protocol + column
 *   instructions for the turn's card-context). No per-turn card list, no board
 *   snapshot. Agents call snowball_get_board_state for live card state.
 *
 *   The substrate inject-once dedup (InjectionBaseline in floe-bridge) ensures
 *   these instructions are injected only when the content changes — not every turn.
 *   If instructions are edited, the next turn sees the fresh resolved text and
 *   re-injects; no wake is needed.
 *
 * Slice 6 (fm/snowball-ctx-retire):
 *   Sidecar eliminated. buildBoardSnapshot reads from board file + card files only.
 *   No loadSidecar call. buildBoardSnapshot signature updated.
 *
 * Slice 5 (fm/snowball-col-board-s5):
 *   Board discovery now reads board.md (via board-file.ts).
 *   column-file.ts is deleted; findBoardScopesForAgentFromFiles moved to board-file.ts.
 *
 * BeforeTurn injection (post Slice C):
 *  - Snowball (system steward): all column instructions only (no snapshot)
 *  - Column workers with card-context origin: done protocol + column instructions
 *  - Column workers with no origin (e.g. pulse): done protocol + owned column instructions
 *  - Agents without board context receive no injection
 *
 * Card list / criteria are intentionally NOT injected. Agents call tools for live state.
 */

import type { ExtensionContext, HookResult } from "./stub/extension-context.js";
import { slugify } from "./board-file.js";
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

    // Slice C (F4): extract typed origin reference.
    // When origin.kind === "context" (a card-context delivery), we resolve
    // instructions for that card's column only. This enforces the invariant:
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

      if (agentId === SNOWBALL_AGENT_ID) {
        // System steward: inject all column instructions so the overseer knows
        // the board's operational rules. No board snapshot — call
        // snowball_get_board_state for live card state.
        const colsWithInstructions = columns.filter((c) => c.instructions.trim().length > 0);
        if (colsWithInstructions.length > 0) {
          lines.push("## Column Instructions");
          for (const col of colsWithInstructions) {
            lines.push(`\n### ${col.name}`);
            lines.push(col.instructions.trim());
          }
        }
      } else if (originContextId !== null) {
        // Slice C (F4) narrow path: origin identifies a specific card context.
        // Resolve instructions for that card's column only.
        // The card file carries context_id in its frontmatter (Slice 4 invariant).
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

        // Column instructions for this card's column only
        if (cardCol.instructions.trim().length > 0) {
          lines.push(`## Column Instructions: ${cardCol.name}`);
          lines.push(cardCol.instructions.trim());
          lines.push("");
        }

        // No card list — agents call snowball_get_board_state for live card state
      } else {
        // No origin context: inject resolved instructions for owned columns.
        // Used for pulse deliveries and other non-context-scoped events.
        // No card list — agents call tools for live state.
        const boardFile = ensureBoardFile(workspacePath, slug, scopeId);
        if (boardFile.done_protocol.trim().length > 0) {
          lines.push(boardFile.done_protocol.trim());
          lines.push("");
        }

        const ownedColumns = columns.filter(
          (col) => col.assigned_actors.some((a) => a.actor_ref === agentId)
        );

        for (const col of ownedColumns) {
          if (col.instructions.trim().length > 0) {
            lines.push(`## Column Instructions: ${col.name}`);
            lines.push(col.instructions.trim());
            lines.push("");
          }
        }
      }
    }

    const content = lines.join("\n").slice(0, 3800);
    if (!content) return;
    return { inject: { source: "snowball", content } };
  });
}
