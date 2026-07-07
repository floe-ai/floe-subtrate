/**
 * Sidecar — board/column/card state management.
 *
 * State lives at: .floe/extensions/snowball/boards/<scope_id_slug>.yaml
 *
 * Slug rule (R8): replace `:` and `/` and any chars illegal in filenames with `_`.
 * The mapping is deterministic: same scope_id → same slug always.
 *
 * Reconcile rules (§3.4):
 *  - Context in bus but not sidecar → recover into first column
 *  - Context in sidecar but not bus → remove (context was deleted)
 *  - Card references unknown column → move to first column, warn
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { BusClient } from "./stub/bus-client.js";
import {
  SIDECAR_SCHEMA,
  defaultColumns,
  type BoardSidecar,
  type SidecarCard,
  type BoardSnapshot,
  type Card,
  type CardCriterionCheck,
} from "./types.js";

// ---------------------------------------------------------------------------
// Slug — deterministic, safe filename from scope_id
// ---------------------------------------------------------------------------

/**
 * Convert a scope_id to a safe filesystem slug.
 * Characters illegal in filenames on Windows/Unix (: / \ * ? " < > |) are
 * replaced with underscores.  The result is stable: same input → same slug.
 *
 * Example: "scope:workspace_id:feature-planning" → "scope_workspace_id_feature-planning"
 */
export function slugify(scopeId: string): string {
  // Replace characters illegal on Windows and/or problematic on Unix
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
 * Load the sidecar for a scope.  If it does not exist, create and return a
 * default board with three columns (To Do / In Progress / Done).
 *
 * Does NOT run reconciliation — call reconcileSidecar() separately when needed.
 */
export function loadSidecar(
  workspacePath: string,
  scopeId: string
): BoardSidecar {
  const path = sidecarPath(workspacePath, scopeId);

  if (!existsSync(path)) {
    // Return in-memory default; caller must saveSidecar() to persist.
    return {
      schema: SIDECAR_SCHEMA,
      scope_id: scopeId,
      workspace_id: "", // filled in by caller on first save
      columns: defaultColumns(),
      cards: {},
    };
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = parseYaml(raw) as BoardSidecar;
    // Normalise: ensure cards object exists
    if (!parsed.cards) parsed.cards = {};
    if (!Array.isArray(parsed.columns)) parsed.columns = defaultColumns();
    return parsed;
  } catch (err) {
    console.error(`[snowball] Failed to parse sidecar at ${path}: ${err}`);
    return {
      schema: SIDECAR_SCHEMA,
      scope_id: scopeId,
      workspace_id: "",
      columns: defaultColumns(),
      cards: {},
    };
  }
}

/**
 * Check if a sidecar file exists on disk for this scope.
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
  writeFileSync(path, stringifyYaml(sidecar as unknown as Record<string, unknown>), "utf-8");
}

// ---------------------------------------------------------------------------
// Reconcile (§3.4)
// ---------------------------------------------------------------------------

/**
 * Reconcile sidecar cards with the bus context list for this scope.
 * Modifies the sidecar in-place and returns it.
 * Caller should saveSidecar() afterwards if any changes occurred.
 */
export async function reconcileSidecar(
  sidecar: BoardSidecar,
  busClient: BusClient,
  workspaceId: string
): Promise<{ sidecar: BoardSidecar; changed: boolean }> {
  let changed = false;
  const busContexts = await busClient.listContextsForScope(
    workspaceId,
    sidecar.scope_id
  );
  const busIds = new Set(busContexts.map((c) => c.context_id));
  const sidecarIds = new Set(Object.keys(sidecar.cards));
  const firstColumn = sidecar.columns[0];

  // Rule 1: Context in bus but not in sidecar → recover into first column
  for (const ctx of busContexts) {
    if (!sidecarIds.has(ctx.context_id)) {
      if (firstColumn) {
        const order = Object.values(sidecar.cards).filter(
          (c) => c.column_id === firstColumn.id
        ).length;
        sidecar.cards[ctx.context_id] = {
          column_id: firstColumn.id,
          order,
          title: ctx.first_message_preview ?? ctx.context_id,
          created_at: ctx.created_at,
          checks: {},
        };
        console.warn(
          `[snowball] Recovered orphaned context ${ctx.context_id} → first column`
        );
        changed = true;
      }
    }
  }

  // Rule 2: Context in sidecar but not in bus → remove (context deleted)
  for (const ctxId of sidecarIds) {
    if (!busIds.has(ctxId)) {
      delete sidecar.cards[ctxId];
      console.warn(
        `[snowball] Removed sidecar entry ${ctxId} (context not found in bus)`
      );
      changed = true;
    }
  }

  // Rule 3: Card references unknown column → move to first column
  const validColIds = new Set(sidecar.columns.map((c) => c.id));
  for (const [ctxId, card] of Object.entries(sidecar.cards)) {
    if (!validColIds.has(card.column_id)) {
      if (firstColumn) {
        console.warn(
          `[snowball] Card ${ctxId} references unknown column '${card.column_id}' → moved to first column`
        );
        card.column_id = firstColumn.id;
        card.order = 0;
        changed = true;
      }
    }
  }

  return { sidecar, changed };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Return the unchecked exit criteria for a card leaving the given column. */
export function getUncheckedCriteria(
  card: SidecarCard,
  columnId: string,
  exitCriteria: Array<{ id: string; description: string; kind: string }>
): Array<{ id: string; description: string; kind: string }> {
  const colChecks = card.checks[columnId] ?? {};
  return exitCriteria.filter((ec) => !colChecks[ec.id]?.checked);
}

/** Count cards per column. */
export function cardCountsByColumn(
  sidecar: BoardSidecar
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const col of sidecar.columns) {
    counts[col.id] = 0;
  }
  for (const card of Object.values(sidecar.cards)) {
    if (counts[card.column_id] !== undefined) {
      counts[card.column_id]++;
    }
  }
  return counts;
}

/** Build a full board snapshot suitable for API responses and board injection. */
export function buildBoardSnapshot(sidecar: BoardSidecar): BoardSnapshot {
  const counts = cardCountsByColumn(sidecar);
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

  const cards: Card[] = Object.entries(sidecar.cards).map(
    ([ctxId, card]): Card => {
      const colChecks = card.checks[card.column_id] ?? {};
      const criteria_checks: CardCriterionCheck[] = Object.entries(
        colChecks
      ).map(
        ([criterionId, state]): CardCriterionCheck => ({
          columnId: card.column_id,
          criterionId,
          checked: state.checked,
          checkedAt: state.checked_at ?? undefined,
          checkedBy: state.checked_by ?? undefined,
          note: state.note ?? undefined,
        })
      );
      return {
        card_id: ctxId,
        column_id: card.column_id,
        order: card.order,
        title: card.title,
        created_at: card.created_at,
        criteria_checks,
      };
    }
  );

  // Sort cards by column order then card order
  cards.sort((a, b) => {
    const colA = sidecar.columns.findIndex((c) => c.id === a.column_id);
    const colB = sidecar.columns.findIndex((c) => c.id === b.column_id);
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
  // Safety cap: if over 3800 chars, truncate with notice
  if (result.length > 3800) {
    return result.slice(0, 3750) + "\n\n[...board snapshot truncated]";
  }
  return result;
}
