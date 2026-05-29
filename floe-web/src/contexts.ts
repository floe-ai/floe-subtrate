// Pure helpers for the per-agent context list and chat-rendering flow.
//
// These functions encode the FloeWeb side of the Actor-Neutral Context contract
// (Slice 5). Keep them free of React, fetch, and DOM concerns so they can be
// exercised by vitest unit tests.

export type ContextSummary = {
  context_id: string;
  workspace_id: string;
  scope_id: string | null;
  parent_context_id: string | null;
  created_by_endpoint_id: string | null;
  created_at: string;
  last_event_at: string | null;
  participants: string[];
  first_message_preview: string | null;
};

export type ContextEvent = {
  event_id: string;
  type: string;
  context_id: string;
  source_endpoint_id: string | null;
  destination_json: { kind: "endpoint" | "broadcast"; endpoint_id?: string };
  content: { text?: string; data?: Record<string, unknown> };
  metadata?: Record<string, unknown> & {
    trigger_kind?: string;
    pulse_name?: string;
  };
  created_at: string;
};

export function contextLabel(
  ctx: ContextSummary,
  firstEvent: ContextEvent | null | undefined
): string {
  const preview = ctx.first_message_preview?.trim();
  if (preview) return preview;
  if (firstEvent && firstEvent.metadata?.trigger_kind === "pulse") {
    const name =
      typeof firstEvent.metadata.pulse_name === "string"
        ? firstEvent.metadata.pulse_name
        : "pulse";
    return `Pulse: ${name}`;
  }
  return "Conversation";
}

export function findDefaultContextId(
  contexts: ContextSummary[],
  operatorEndpointId: string,
  agentEndpointId: string
): string | null {
  const matching = contexts.filter((c) => {
    if (c.participants.length !== 2) return false;
    const set = new Set(c.participants);
    return set.has(operatorEndpointId) && set.has(agentEndpointId);
  });
  if (matching.length === 0) return null;
  const sorted = [...matching].sort((a, b) =>
    a.created_at.localeCompare(b.created_at)
  );
  return sorted[0].context_id;
}

export function sortContextsForAgent(
  contexts: ContextSummary[],
  operatorEndpointId: string,
  selectedActorEndpointId: string
): { sorted: ContextSummary[]; defaultContextId: string | null } {
  // Only show contexts where both self AND selected actor participate
  const relevant = contexts.filter(c =>
    c.participants.includes(operatorEndpointId) && c.participants.includes(selectedActorEndpointId)
  );
  const defaultContextId = findDefaultContextId(
    relevant,
    operatorEndpointId,
    selectedActorEndpointId
  );
  const byActivity = [...relevant].sort((a, b) => {
    const at = a.last_event_at ?? a.created_at;
    const bt = b.last_event_at ?? b.created_at;
    return bt.localeCompare(at);
  });
  return { sorted: byActivity, defaultContextId };
}

export function sortWorkspaceContexts(contexts: ContextSummary[]): ContextSummary[] {
  return [...contexts].sort((a, b) => {
    const at = a.last_event_at ?? a.created_at;
    const bt = b.last_event_at ?? b.created_at;
    return bt.localeCompare(at);
  });
}

export function workspaceContextLabel(ctx: ContextSummary): string {
  const preview = ctx.first_message_preview?.trim();
  if (preview) return preview;
  return ctx.scope_id ? "Scoped Context" : "Workspace-level Context";
}

export type EmitBody = {
  type: "message";
  workspace_id: string;
  source_endpoint_id: string;
  destination: { kind: "endpoint"; endpoint_id: string };
  context_id?: string;
  content: { text: string; data?: Record<string, unknown> };
  response: { expected: false };
  metadata: Record<string, unknown>;
};

export function buildEmitBody(args: {
  workspaceId: string;
  source: string;
  agentEndpointId: string;
  selectedContextId: string | null;
  text: string;
  contextLabelText?: string;
}): EmitBody {
  const content: EmitBody["content"] = { text: args.text };
  if (args.contextLabelText) {
    content.data = { context: args.contextLabelText };
  }
  return {
    type: "message",
    workspace_id: args.workspaceId,
    source_endpoint_id: args.source,
    destination: { kind: "endpoint", endpoint_id: args.agentEndpointId },
    ...(args.selectedContextId ? { context_id: args.selectedContextId } : {}),
    content,
    response: { expected: false },
    metadata: { submitted_by: "floe-web", channel: "floe" }
  };
}
