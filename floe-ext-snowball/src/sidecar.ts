/**
 * Board sidecar — runtime state registry (column context map only).
 *
 * Slice 2 (fm/snowball-col-instr-s2):
 *   The sidecar has been slimmed to RUNTIME-ONLY state.
 *   Column DEFINITIONS (name, owner, exit_criteria, wip_limit, instructions)
 *   now live in committed markdown files at boards/<scopeSlug>/columns/<id>.md
 *   (see column-file.ts).
 *
 *   The sidecar now owns ONLY:
 *     column_contexts: column_id → bus Context id (created at board init)
 *
 *   State lives at: .floe/extensions/snowball/boards/<scope_id_slug>.yaml
 *   (gitignored — runtime scratch, NOT committed to the repo)
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
  type BoardSidecar,
  type BoardSnapshot,
  type Card,
  type CardCriterionCheck,
} from "./types.js";
import {
  listCards,
  cardCountsByColumnFromFiles,
  getUncheckedCriteriaForCard,
} from "./card-file.js";
import type { ColumnFile } from "./column-file.js";
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
  return join(workspacePath, ".floe", "extensions", "snowball", "runtime");
}

function sidecarPath(workspacePath: string, scopeId: string): string {
  return join(sidecarDir(workspacePath), `${slugify(scopeId)}.yaml`);
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load the sidecar for a scope.  If it does not exist, return an empty
 * runtime state with no column_contexts.
 *
 * Does NOT create column contexts — call initBoardContexts() separately.
 * Does NOT hold column definitions — those are in column-file.ts.
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
      column_contexts: {},
    };
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> & { columns?: unknown };
    // Strip any v2 `columns` field if present (migration: ignore, don't error)
    const { columns: _dropped, ...rest } = parsed;
    void _dropped;
    if (!rest["column_contexts"] || typeof rest["column_contexts"] !== "object") {
      rest["column_contexts"] = {};
    }
    return {
      schema: SIDECAR_SCHEMA,
      scope_id: (rest["scope_id"] as string | undefined) ?? scopeId,
      workspace_id: (rest["workspace_id"] as string | undefined) ?? "",
      column_contexts: rest["column_contexts"] as Record<string, string>,
    };
  } catch (err) {
    console.error(`[snowball] Failed to parse sidecar at ${path}: ${err}`);
    return {
      schema: SIDECAR_SCHEMA,
      scope_id: scopeId,
      workspace_id: "",
      column_contexts: {},
    };
  }
}

/**
 * Check if a sidecar file exists on disk for this scope.
 * Existence means column contexts have been created (board is initialized).
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
 * Compute the endpoint id for a workspace + actor ref.
 */
function agentEndpointId(workspaceId: string, actorRef: string): string {
  return `actor:${workspaceId}:${actorRef}`;
}

/**
 * Initialise column contexts in the bus and persist context_ids to sidecar.
 *
 * DORMANT since Slice 4: card contexts are now the routing target.
 * Column contexts are still created for backward compat but not used for routing.
 * Retired and removed in Slice 6.
 *
 * Takes the column definitions from committed column files (not the sidecar).
 * Creates one bus Context per column (scoped to the board scope_id) if the
 * column does not already have a context_id in the sidecar.  Idempotent.
 *
 * Call saveSidecar() after this function if changed is true.
 */
export async function initBoardContexts(
  sidecar: BoardSidecar,
  workspaceId: string,
  busClient: BusClient,
  columns: ColumnFile[]
): Promise<{ changed: boolean }> {
  let changed = false;

  for (const col of columns) {
    if (sidecar.column_contexts[col.id]) {
      // Already has a context — skip (idempotent)
      continue;
    }

    // Include all assigned actors as participants (uniform actor model)
    const participants: string[] = col.assigned_actors
      .map((a) => agentEndpointId(workspaceId, a.actor_ref));

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

/** Build a full board snapshot suitable for API responses and board injection. */
export function buildBoardSnapshot(
  workspacePath: string,
  sidecar: BoardSidecar,
  columns: ColumnFile[]
): BoardSnapshot {
  const colIds = columns.map((c) => c.id);
  const counts = cardCountsByColumnFromFiles(workspacePath, colIds);

  const snapshotColumns = columns.map((col) => ({
    id: col.id,
    name: col.name,
    wip_limit: col.wip_limit,
    card_count: counts[col.id] ?? 0,
    wip_exceeded:
      col.wip_limit !== null && (counts[col.id] ?? 0) > col.wip_limit,
    assigned_actors: col.assigned_actors,
    exit_criteria: col.exit_criteria,
    instructions: col.instructions,
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
  const colOrderMap = new Map(columns.map((c, i) => [c.id, i]));
  cards.sort((a, b) => {
    const colA = colOrderMap.get(a.column_id) ?? 999;
    const colB = colOrderMap.get(b.column_id) ?? 999;
    if (colA !== colB) return colA - colB;
    return a.order - b.order;
  });

  return {
    scope_id: sidecar.scope_id,
    workspace_id: sidecar.workspace_id,
    columns: snapshotColumns,
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
        ? ` (${col.card_count}/${col.wip_limit} WIP${col.wip_exceeded ? " \u26a0 EXCEEDED" : ""})`
        : ` (${col.card_count} cards)`;
    const actorsStr = col.assigned_actors.length > 0
      ? ` [${col.assigned_actors.map((a) => a.actor_ref).join(", ")}]`
      : " [unassigned]";
    lines.push(`## ${col.name}${wipStr}${actorsStr}`);

    const colCards = snapshot.cards.filter((c) => c.column_id === col.id);
    if (colCards.length === 0) {
      lines.push("  (empty)");
    } else {
      for (const card of colCards) {
        const checkedCount = card.criteria_checks.filter((c) => c.checked).length;
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
// Re-exports for backward compat
// ---------------------------------------------------------------------------

export type { ColumnFile };
