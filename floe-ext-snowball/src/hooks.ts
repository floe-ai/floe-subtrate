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
import { loadSidecar, saveSidecar, buildBoardSnapshot, renderCompactBoardSnapshot, getUncheckedCriteria } from "./sidecar.js";
import { asBusClient } from "./stub/bus-client.js";
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
    // Match both bare id (legacy) and the scoped form: `snowball:snowball-board-heartbeat:<slug>`
    if (!pulseId?.includes("snowball-board-heartbeat")) return;

    // The scope_id is injected into the pulse content by the per-scope registration
    const scopeId = (payload.content as Record<string, unknown> | undefined)?.scope_id as string | undefined;
    if (!scopeId) {
      console.warn("[snowball:overseer] heartbeat pulse missing scope_id in content — skipping");
      return;
    }

    console.info("[snowball:overseer] heartbeat cycle starting", { scope_id: scopeId });

    const sidecar = loadSidecar(workspacePath, scopeId);
    const bus = asBusClient(ctx.busClient);

    // Iterate agent-owned columns only (R7: overseer operates on full board)
    for (const col of sidecar.columns) {
      if (col.owner.kind !== "agent") continue;

      const colCards = Object.entries(sidecar.cards).filter(
        ([, c]) => c.column_id === col.id
      );

      for (const [cardId, card] of colCards) {
        // Hard gate: all exit criteria must be satisfied
        const unchecked = getUncheckedCriteria(card, col.id, col.exit_criteria);
        if (unchecked.length > 0) {
          console.info("[snowball:overseer] card held — unmet exit criteria", {
            card_id: cardId,
            card_title: card.title,
            column: col.name,
            unmet_criteria: unchecked.map((c) => c.id),
          });
          continue;
        }

        // Find next column (next in array order)
        const colIdx = sidecar.columns.indexOf(col);
        const nextCol = sidecar.columns[colIdx + 1];
        if (!nextCol) {
          console.info("[snowball:overseer] card is in the last column — no advance", {
            card_id: cardId,
            card_title: card.title,
          });
          continue;
        }

        // WIP limit on destination (hard block for agent too)
        if (nextCol.wip_limit !== null) {
          const currentCount = Object.values(sidecar.cards).filter(
            (c) => c.column_id === nextCol.id
          ).length;
          if (currentCount >= nextCol.wip_limit) {
            console.info("[snowball:overseer] card held — destination WIP limit", {
              card_id: cardId,
              card_title: card.title,
              to_column: nextCol.name,
              current: currentCount,
              limit: nextCol.wip_limit,
            });
            continue;
          }
        }

        // Advance the card
        const fromColumnId = card.column_id;
        const newOrder = Object.values(sidecar.cards).filter(
          (c) => c.column_id === nextCol.id
        ).length;
        card.column_id = nextCol.id;
        card.order = newOrder;
        saveSidecar(workspacePath, scopeId, sidecar);

        console.info("[snowball:overseer] card advanced", {
          card_id: cardId,
          card_title: card.title,
          from_column: col.name,
          to_column: nextCol.name,
          scope_id: scopeId,
        });

        // Emit move event (best-effort)
        try {
          await bus.emit({
            type: "snowball.card.moved",
            workspace_id: workspaceId,
            content: {
              text: `[overseer] Card "${card.title}" advanced from "${col.name}" to "${nextCol.name}" (all exit criteria satisfied)`,
              data: {
                card_context_id: cardId,
                card_title: card.title,
                from_column_id: fromColumnId,
                to_column_id: nextCol.id,
                board_scope_id: scopeId,
                source: "overseer",
                forced: false,
              },
            },
            metadata: { source: "snowball-overseer" },
          });
        } catch (err) {
          console.warn("[snowball:overseer] failed to emit card moved event", { error: String(err) });
        }

        // If the next column is also agent-owned, emit routing event
        if (nextCol.owner.kind === "agent" && nextCol.owner.agent_id) {
          try {
            const endpoints = await bus.listEndpoints(workspaceId);
            const agentEndpoint = endpoints.find(
              (ep) =>
                ep.endpoint_id.endsWith(`:${nextCol.owner.agent_id}`) ||
                ep.agent_id === nextCol.owner.agent_id
            );
            if (agentEndpoint) {
              await bus.emit({
                type: "snowball.card.entered_column",
                workspace_id: workspaceId,
                destination: {
                  kind: "endpoint",
                  endpoint_id: agentEndpoint.endpoint_id,
                },
                content: {
                  text: `Card "${card.title}" has entered column "${nextCol.name}" (overseer advance)`,
                  data: {
                    card_context_id: cardId,
                    card_title: card.title,
                    column_id: nextCol.id,
                    column_name: nextCol.name,
                    from_column_id: fromColumnId,
                    board_scope_id: scopeId,
                  },
                },
                response: { expected: true },
                metadata: { source: "snowball-overseer" },
              });
            }
          } catch (err) {
            console.warn("[snowball:overseer] failed to emit routing event", { error: String(err) });
          }
        }
      }
    }

    console.info("[snowball:overseer] heartbeat cycle complete", { scope_id: scopeId });
  });
}
