/**
 * Board sidecar — column configuration and context registry.
 *
 * Foundation Slice 1 (fm/snowball-found-s1):
 *   The sidecar now owns:
 *    - Column definitions (id, name, wip_limit, owner, exit_criteria)
 *    - column_contexts map: column_id → bus Context id (created at board init)
 *
 *   Cards are no longer stored here — they live in tasks/<id>.md files.
 *   The sidecar is NOT the source of truth for card state.
 *
 * State lives at: .floe/extensions/snowball/boards/<scope_id_slug>.yaml
 *
 * Slug rule (R8): replace `:` and `/` and any chars illegal in filenames with `_`.
 * The mapping is deterministic: same scope_id → same slug always.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { BusClient } from "./stub/bus-client.js";
import {
  SIDECAR_SCHEMA,
  defaultColumns,
  type BoardSidecar,
  type SidecarColumn,
  type BoardSnapshot,
  type Card,
  type CardCriterionCheck,
} from "./types.js";
import {
  listCards,
  cardCountsByColumnFromFiles,
  getUncheckedCriteriaForCard,
} from "./card-file.js";
import type { CardFile } from "./types.js";
/**
 * Convert a scope_id to a safe filesystem slug.
 * Characters illegal in filenames on Windows/Unix (: / \ * ? " < > |) are
 * replaced with underscores.  The result is stable: same input → same slug.
 *
 * Example: "scope:workspace_id:feature-planning" → "scope_workspace_id_feature-planning"
 */
export function slugify(scopeId: string): string {
  return scopeId.replace(/[:/\\*?"<>|]/g, "_");
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function sidecarDir(workspacePath: string): string {
  return join(workspacePath, ".floe", "extensions", "snowball", "boards");
}

function sidecarPath(workspacePath: string, scopeId: string): string {
  return join(sidecarDir(workspacePath), `${slugify(scopeId)}.yaml`);
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load the sidecar for a scope.  If it does not exist, return a default board
 * with three columns and an empty column_contexts map.
 *
 * Does NOT create column contexts — call initBoardContexts() separately.
 */
export function loadSidecar(
  workspacePath: string,
  scopeId: string
): BoardSidecar {
  const path = sidecarPath(workspacePath, scopeId);

  if (!existsSync(path)) {
    return {
      schema: SIDECAR_SCHEMA,
      scope_id: scopeId,
      workspace_id: "",
      columns: defaultColumns(),
      column_contexts: {},
    };
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = parseYaml(raw) as BoardSidecar;
    if (!Array.isArray(parsed.columns)) parsed.columns = defaultColumns();
    if (!parsed.column_contexts || typeof parsed.column_contexts !== "object") {
      parsed.column_contexts = {};
    }
    return parsed;
  } catch (err) {
    console.error(`[snowball] Failed to parse sidecar at ${path}: ${err}`);
    return {
      schema: SIDECAR_SCHEMA,
      scope_id: scopeId,
      workspace_id: "",
      columns: defaultColumns(),
      column_contexts: {},
    };
  }
}

/**
 * Check if a sidecar file exists on disk for this scope.
 * A sidecar that exists means the board has been initialized (column contexts created).
 */
export function sidecarExists(
  workspacePath: string,
  scopeId: string
): boolean {
  return existsSync(sidecarPath(workspacePath, scopeId));
}

/**
 * Persist the sidecar to disk.  Creates parent directories as needed.
 */
export function saveSidecar(
  workspacePath: string,
  scopeId: string,
  sidecar: BoardSidecar
): void {
  const path = sidecarPath(workspacePath, scopeId);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    path,
    stringifyYaml(sidecar as unknown as Record<string, unknown>),
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// Board init — create column contexts
// ---------------------------------------------------------------------------

/**
 * Compute the snowball overseer endpoint id for a workspace.
 * The overseer is always added as a participant to ALL column contexts so
 * it can emit card-move events directly into the context.
 */
function overseerId(workspaceId: string): string {
  return `actor:${workspaceId}:snowball-overseer`;
}

/**
 * Compute the agent endpoint id for a workspace + agent.
 */
function agentEndpointId(workspaceId: string, agentId: string): string {
  return `actor:${workspaceId}:${agentId}`;
}

/**
 * Initialise column contexts in the bus and persist context_ids to sidecar.
 *
 * Creates one bus Context per column (scoped to the board scope_id) if the
 * column does not already have a context_id in the sidecar.  Idempotent:
 * already-created contexts are not touched.
 *
 * Participants per column:
 *  - snowball-overseer (always, so it can route card-move events into context)
 *  - column owner agent (if agent-owned; adds them as frozen participant)
 *
 * Call saveSidecar() after this function if changed is true.
 */
export async function initBoardContexts(
  sidecar: BoardSidecar,
  workspaceId: string,
  busClient: BusClient
): Promise<{ changed: boolean }> {
  let changed = false;
  const overseer = overseerId(workspaceId);

  for (const col of sidecar.columns) {
    if (sidecar.column_contexts[col.id]) {
      // Already has a context — skip (idempotent)
      continue;
    }

    const participants: string[] = [overseer];
    if (col.owner.kind === "agent" && col.owner.agent_id) {
      const agent = agentEndpointId(workspaceId, col.owner.agent_id);
      if (!participants.includes(agent)) participants.push(agent);
    }

    try {
      const contextId = await busClient.createContext({
        workspace_id: workspaceId,
        scope_id: sidecar.scope_id,
        participants,
        title: `Column: ${col.name}`,
      });
      sidecar.column_contexts[col.id] = contextId;
      changed = true;
    } catch (err) {
      console.error(
        `[snowball] Failed to create column context for "${col.name}": ${err}`
      );
    }
  }

  return { changed };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Return the unchecked exit criteria for a card in its current column. */
export function getUncheckedCriteria(
  card: CardFile,
  columnId: string,
  exitCriteria: Array<{ id: string; description: string; kind: string }>
): Array<{ id: string; description: string; kind: string }> {
  const colChecks = card.checks[columnId] ?? {};
  return exitCriteria.filter((ec) => !colChecks[ec.id]?.checked);
}

/** Count cards per column by reading card files. */
export function cardCountsByColumn(
  workspacePath: string,
  sidecar: BoardSidecar
): Record<string, number> {
  return cardCountsByColumnFromFiles(
    workspacePath,
    sidecar.columns.map((c) => c.id)
  );
}

/** Build a full board snapshot suitable for API responses and board injection. */
export function buildBoardSnapshot(
  workspacePath: string,
  sidecar: BoardSidecar
): BoardSnapshot {
  const counts = cardCountsByColumn(workspacePath, sidecar);
  const columns = sidecar.columns.map((col) => ({
    id: col.id,
    name: col.name,
    wip_limit: col.wip_limit,
    card_count: counts[col.id] ?? 0,
    wip_exceeded:
      col.wip_limit !== null && (counts[col.id] ?? 0) > col.wip_limit,
    owner: col.owner,
    exit_criteria: col.exit_criteria,
  }));

  const allCards = listCards(workspacePath);
  const cards: Card[] = allCards.map((cardFile): Card => {
    const colChecks = cardFile.checks[cardFile.column] ?? {};
    const criteria_checks: CardCriterionCheck[] = Object.entries(colChecks).map(
      ([criterionId, state]): CardCriterionCheck => ({
        columnId: cardFile.column,
        criterionId,
        checked: state.checked,
        checkedAt: state.checked_at ?? undefined,
        checkedBy: state.checked_by ?? undefined,
        note: state.note ?? undefined,
      })
    );
    return {
      card_id: cardFile.id,
      column_id: cardFile.column,
      order: cardFile.order,
      title: cardFile.title,
      created_at: cardFile.created_at,
      criteria_checks,
    };
  });

  // Sort cards by column order then card order
  const colOrderMap = new Map(sidecar.columns.map((c, i) => [c.id, i]));
  cards.sort((a, b) => {
    const colA = colOrderMap.get(a.column_id) ?? 999;
    const colB = colOrderMap.get(b.column_id) ?? 999;
    if (colA !== colB) return colA - colB;
    return a.order - b.order;
  });

  return {
    scope_id: sidecar.scope_id,
    workspace_id: sidecar.workspace_id,
    columns,
    cards,
  };
}

/**
 * Render a compact board snapshot as a string for BeforeTurn injection.
 * Stays well within the 4000-char limit for boards up to ~30 cards.
 */
export function renderCompactBoardSnapshot(snapshot: BoardSnapshot): string {
  const lines: string[] = [`Board: ${snapshot.scope_id}`, ""];

  for (const col of snapshot.columns) {
    const wipStr =
      col.wip_limit !== null
        ? ` (${col.card_count}/${col.wip_limit} WIP${col.wip_exceeded ? " ⚠ EXCEEDED" : ""})`
        : ` (${col.card_count} cards)`;
    const ownerStr =
      col.owner.kind === "agent"
        ? ` [agent:${col.owner.agent_id ?? "?"}]`
        : " [human]";
    lines.push(`## ${col.name}${wipStr}${ownerStr}`);

    const colCards = snapshot.cards.filter((c) => c.column_id === col.id);
    if (colCards.length === 0) {
      lines.push("  (empty)");
    } else {
      for (const card of colCards) {
        const checkedCount = card.criteria_checks.filter(
          (c) => c.checked
        ).length;
        const totalCriteria = col.exit_criteria.length;
        const criteriaStr =
          totalCriteria > 0
            ? ` [${checkedCount}/${totalCriteria} criteria]`
            : "";
        lines.push(`  - ${card.title}${criteriaStr} (${card.card_id})`);
      }
    }
    lines.push("");
  }

  const result = lines.join("\n");
  if (result.length > 3800) {
    return result.slice(0, 3750) + "\n\n[...board snapshot truncated]";
  }
  return result;
}

// ---------------------------------------------------------------------------
// Column management helpers
// ---------------------------------------------------------------------------

export { SidecarColumn };
