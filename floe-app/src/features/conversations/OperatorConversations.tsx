import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextRef, EndpointRef, EventEnvelope } from "../../bus-client/types.ts";
import {
  listContextEvents,
  listContextsByParticipant,
  subscribeEvents,
} from "../../bus-client/client.ts";
import { tk } from "../../theme.ts";

const RECENT_LIMIT = 6;

export type OperatorConversation = {
  context: ContextRef;
  collaborators: string;
  preview: string;
  needsOperator: boolean;
  activityAt: string;
};

export function findOperatorEndpoint(endpoints: EndpointRef[]): EndpointRef | null {
  return endpoints.find(endpoint => endpoint.agent_id === "operator")
    ?? endpoints.find(endpoint => endpoint.endpoint_id.endsWith(":operator"))
    ?? null;
}

function endpointName(endpointId: string, endpoints: EndpointRef[]): string {
  const endpoint = endpoints.find(candidate => candidate.endpoint_id === endpointId);
  return endpoint?.name || endpoint?.agent_id || endpointId.split(":").at(-1) || "Collaborator";
}

function latestMessage(events: EventEnvelope[]): EventEnvelope | null {
  return [...events].reverse().find(event => event.type === "message") ?? null;
}

export function summarizeOperatorConversation(
  context: ContextRef,
  events: EventEnvelope[],
  operatorEndpointId: string,
  endpoints: EndpointRef[],
): OperatorConversation {
  const message = latestMessage(events);
  const destination = message?.destination_json;
  const needsOperator = !!message
    && message.source_endpoint_id !== operatorEndpointId
    && destination?.kind === "endpoint"
    && destination.endpoint_id === operatorEndpointId
    && message.response.expected;
  const collaborators = context.participants
    .filter(participant => participant !== operatorEndpointId)
    .map(participant => endpointName(participant, endpoints))
    .join(", ") || "Workspace conversation";
  const previewText = (typeof message?.content?.["text"] === "string" ? message.content["text"] : null)
    ?? context.first_message_preview
    ?? "No messages yet";

  return {
    context,
    collaborators,
    preview: previewText.replace(/\s+/g, " ").trim(),
    needsOperator,
    activityAt: context.last_event_at ?? context.created_at,
  };
}

export type OperatorConversationsProps = {
  workspaceId: string;
  endpoints: EndpointRef[];
  onOpenContext: (contextId: string) => void;
};

export function OperatorConversations({
  workspaceId,
  endpoints,
  onOpenContext,
}: OperatorConversationsProps): React.ReactElement {
  const operator = useMemo(() => findOperatorEndpoint(endpoints), [endpoints]);
  const [conversations, setConversations] = useState<OperatorConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    if (!operator) {
      setConversations([]);
      setLoading(false);
      return;
    }
    const sequence = ++loadSequence.current;
    setError(null);
    try {
      const contexts = await listContextsByParticipant({
        participant: operator.endpoint_id,
        workspace_id: workspaceId,
      });
      const summaries = await Promise.all(contexts.map(async context => {
        const events = await listContextEvents(context.context_id, { limit: 500 }).catch(() => []);
        return summarizeOperatorConversation(context, events, operator.endpoint_id, endpoints);
      }));
      if (sequence !== loadSequence.current) return;
      setConversations(summaries.sort((left, right) => right.activityAt.localeCompare(left.activityAt)));
    } catch (loadError) {
      if (sequence !== loadSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load conversations");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [endpoints, operator, workspaceId]);

  useEffect(() => {
    setLoading(true);
    setShowAll(false);
    void load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = subscribeEvents(message => {
      if (message.type === "event_submitted") {
        const event = (message.payload as { event?: { workspace_id?: string } }).event;
        if (event?.workspace_id === workspaceId) void load();
      }
      if (message.type === "context_created" || message.type === "context_deleted") {
        const context = (message.payload as { context?: { workspace_id?: string }; workspace_id?: string }).context;
        const messageWorkspaceId = context?.workspace_id
          ?? (message.payload as { workspace_id?: string }).workspace_id;
        if (messageWorkspaceId === workspaceId) void load();
      }
    });
    return unsubscribe;
  }, [load, workspaceId]);

  const needsYou = conversations.filter(conversation => conversation.needsOperator);
  const recent = conversations.filter(conversation => !conversation.needsOperator);
  const visibleRecent = showAll ? recent : recent.slice(0, RECENT_LIMIT);

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "34px 32px 48px", fontFamily: tk.fontUi }}>
      <section style={{ width: "min(780px, 100%)", margin: "0 auto" }}>
        <div style={{ color: tk.accent, fontSize: 12, fontWeight: 590, marginBottom: 8 }}>Workspace</div>
        <h1 style={{
          margin: "0 0 8px", color: tk.ink, fontSize: 28, fontWeight: 510,
          letterSpacing: "-0.025em", lineHeight: 1.15,
        }}>
          Conversations
        </h1>
        <p style={{ margin: "0 0 28px", color: tk.ink3, fontSize: 14, lineHeight: 1.5 }}>
          Conversations where your input or judgement belongs. Operational actor work stays out of this list.
        </p>

        {loading && <StatusText>Loading conversations…</StatusText>}
        {error && <div role="alert" style={{ color: tk.danger, fontSize: 13 }}>{error}</div>}

        {!loading && !error && !operator && (
          <StatusText>The workspace operator is not available yet.</StatusText>
        )}
        {!loading && !error && operator && conversations.length === 0 && (
          <StatusText>No conversations yet. Start with Floe and describe an outcome.</StatusText>
        )}

        {!loading && !error && needsYou.length > 0 && (
          <ConversationSection
            label="Needs you"
            conversations={needsYou}
            onOpenContext={onOpenContext}
            attention
          />
        )}

        {!loading && !error && visibleRecent.length > 0 && (
          <ConversationSection
            label="Recent"
            conversations={visibleRecent}
            onOpenContext={onOpenContext}
          />
        )}

        {!loading && !error && recent.length > RECENT_LIMIT && (
          <button
            type="button"
            onClick={() => setShowAll(show => !show)}
            style={{
              marginTop: 12, background: "transparent", border: "none", color: tk.ink3,
              fontSize: 12.5, cursor: "pointer", padding: "6px 0",
            }}
          >
            {showAll ? "Show fewer" : `Show ${recent.length - RECENT_LIMIT} more`}
          </button>
        )}
      </section>
    </div>
  );
}

function ConversationSection({
  label,
  conversations,
  onOpenContext,
  attention = false,
}: {
  label: string;
  conversations: OperatorConversation[];
  onOpenContext: (contextId: string) => void;
  attention?: boolean;
}): React.ReactElement {
  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{
        marginBottom: 8, color: attention ? tk.accent : tk.ink3,
        fontSize: 10.5, fontWeight: 590, letterSpacing: "0.1em", textTransform: "uppercase",
      }}>
        {label}
      </div>
      <div role="list" aria-label={label} style={{
        border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden", background: tk.surface,
      }}>
        {conversations.map((conversation, index) => (
          <div key={conversation.context.context_id} role="listitem">
            <button
              type="button"
              onClick={() => onOpenContext(conversation.context.context_id)}
              aria-label={`Open conversation with ${conversation.collaborators}`}
              style={{
                width: "100%", display: "grid", gridTemplateColumns: "1fr auto", gap: 16,
                padding: "14px 16px", textAlign: "left", background: "transparent", border: "none",
                borderTop: index > 0 ? `1px solid ${tk.border2}` : "none", cursor: "pointer",
                color: tk.ink,
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 550 }}>{conversation.context.title || conversation.collaborators}</span>
                  {conversation.needsOperator && (
                    <span style={{
                      color: tk.accent, background: "rgba(151,185,172,0.10)", borderRadius: 999,
                      padding: "2px 7px", fontSize: 10.5, fontWeight: 590,
                    }}>
                      Needs you
                    </span>
                  )}
                </span>
                <span style={{
                  display: "block", color: tk.ink3, fontSize: 12.5, lineHeight: 1.45,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {conversation.preview}
                </span>
              </span>
              <span style={{ color: tk.ink4, fontSize: 11.5, whiteSpace: "nowrap", paddingTop: 2 }}>
                {formatActivityTime(conversation.activityAt)}
              </span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

function StatusText({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ padding: "24px 0", color: tk.ink3, fontSize: 13 }}>{children}</div>;
}
