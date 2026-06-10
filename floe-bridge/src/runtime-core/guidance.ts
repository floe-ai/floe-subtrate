/**
 * Floe Runtime Core — Substrate Guidance
 *
 * This module provides the standard substrate guidance text injected into
 * every runtime actor's instruction context. It teaches the agent
 * the actor/event/emit/turn model.
 */

import { readPromptAsset } from "../prompt-assets.js";
import { toNeutralRef } from "./neutral-ref.js";

/**
 * Standard substrate guidance for runtime actors.
 * This is appended to agent instructions before the processing cycle begins.
 */
export const SUBSTRATE_GUIDANCE = readPromptAsset("substrate-guidance.md");

/**
 * Build the complete system prompt for a runtime actor.
 *
 * Combines agent-authored instructions with substrate guidance.
 * The substrate guidance is always appended — it cannot be overridden
 * by agent instructions.
 */
export function buildSystemPrompt(agentInstructions: string): string {
  if (!agentInstructions.trim()) {
    return SUBSTRATE_GUIDANCE;
  }
  return `${agentInstructions.trim()}\n\n${SUBSTRATE_GUIDANCE}`;
}

/**
 * Render the destination context block for inclusion in the delivery prompt.
 * This gives the agent enough context to reply without hard-coded endpoint IDs.
 */
export function renderDestinationContext(context: {
  source_endpoint_id: string;
  reply_destination_endpoint_id: string;
  thread_id: string;
  correlation_id: string | null;
  response_expected: boolean;
  current_context_id?: string | null;
  current_context_participants?: string[];
}): string {
  const lines = [
    `[Delivery Context]`,
    `source_actor: ${toNeutralRef(context.source_endpoint_id)}`,
    `reply_actor: ${toNeutralRef(context.reply_destination_endpoint_id)}`,
    `thread: ${context.thread_id}`,
    `response_expected: ${context.response_expected}`,
  ];
  if (context.correlation_id) {
    lines.push(`correlation_id: ${context.correlation_id}`);
  }
  if (context.current_context_id) {
    lines.push(`current_context:`);
    lines.push(`  id: ${context.current_context_id}`);
    const participants = context.current_context_participants ?? [];
    if (participants.length > 0) {
      lines.push(`  participants:`);
      for (const p of participants) {
        lines.push(`    - ${toNeutralRef(p)}`);
      }
    } else {
      lines.push(`  participants: []`);
    }
  }
  return lines.join("\n");
}
