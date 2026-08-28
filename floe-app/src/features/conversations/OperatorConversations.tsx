import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextRef, EndpointRef, EventEnvelope, ScopeRef } from "../../bus-client/types.ts";
import {
  createDirectContext,
  deleteContext,
  emit,
  listContextEvents,
  listContextsByParticipant,
  subscribeEvents,
} from "../../bus-client/client.ts";
import { ContextConversation } from "../../scope/ContextConversation.tsx";
import { FloeModelControl } from "../../workspace/FloeModelControl.tsx";
import { tk } from "../../theme.ts";
import { ContextWorkView } from "../work/ContextWorkView.tsx";
import { ScopeWorkView } from "../work/ScopeWorkView.tsx";
import type { RuntimeHealth } from "../../runtime/health.ts";
import { conversationAttachments, stageConversationAttachments } from "../../fs/conversationAttachments.ts";
import { appendAttachmentFiles, AttachmentPicker, pastedFiles } from "./AttachmentPicker.tsx";

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

export function findFloeEndpoint(endpoints: EndpointRef[]): EndpointRef | null {
  return endpoints.find(endpoint => endpoint.agent_id === "floe")
    ?? endpoints.find(endpoint => endpoint.endpoint_id.endsWith(":floe"))
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
  const attachmentPreview = conversationAttachments(message?.content)
    .map(attachment => `Attached ${attachment.name}`)
    .join(", ");
  const previewText = (typeof message?.content?.["text"] === "string" && message.content["text"].trim()
    ? message.content["text"]
    : null)
    ?? (attachmentPreview || null)
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

export function latestConversationWith(
  conversations: OperatorConversation[],
  endpointId: string,
): OperatorConversation | null {
  return conversations.find(conversation => conversation.context.participants.includes(endpointId)) ?? null;
}

export type OperatorConversationsProps = {
  workspaceId: string;
  workspaceLocator?: string;
  endpoints: EndpointRef[];
  scopes: ScopeRef[];
  selectedContextId: string | null;
  onOpenContext: (contextId: string) => void;
  onCloseContext: () => void;
  onOpenSettings?: () => void;
  runtimeHealth?: RuntimeHealth;
};

export function OperatorConversations({
  workspaceId,
  workspaceLocator,
  endpoints,
  scopes,
  selectedContextId,
  onOpenContext,
  onCloseContext,
  onOpenSettings,
  runtimeHealth,
}: OperatorConversationsProps): React.ReactElement {
  const operator = useMemo(() => findOperatorEndpoint(endpoints), [endpoints]);
  const floe = useMemo(() => findFloeEndpoint(endpoints), [endpoints]);
  const [conversations, setConversations] = useState<OperatorConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [draftTargetId, setDraftTargetId] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [conversationActionPending, setConversationActionPending] = useState(false);
  const [selectedSurface, setSelectedSurface] = useState<"conversation" | "work">("conversation");
  const [selectedScopeWorkId, setSelectedScopeWorkId] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const initialWorkspace = useRef<string | null>(null);
  const initialConversationChosen = useRef(false);
  const draftContextId = useRef<string | null>(null);

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
        const events = await listContextEvents(context.context_id, { all: true }).catch(() => []);
        return summarizeOperatorConversation(context, events, operator.endpoint_id, endpoints);
      }));
      if (sequence !== loadSequence.current) return;
      const sorted = summaries.sort((left, right) => right.activityAt.localeCompare(left.activityAt));
      setConversations(sorted);

      if (!initialConversationChosen.current) {
        initialConversationChosen.current = true;
        if (sorted.length === 0 && floe) {
          draftContextId.current = null;
          setDraftTargetId(floe.endpoint_id);
        }
      }
    } catch (loadError) {
      if (sequence !== loadSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load conversations");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [endpoints, floe, onOpenContext, operator, workspaceId]);

  useEffect(() => {
    if (initialWorkspace.current !== workspaceId) {
      initialWorkspace.current = workspaceId;
      initialConversationChosen.current = false;
      draftContextId.current = null;
      setDraftTargetId(null);
      setShowAll(false);
      setSelectedSurface("conversation");
      setSelectedScopeWorkId(null);
    }
    setLoading(true);
    void load();
  }, [load, workspaceId]);

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

  function openConversation(contextId: string) {
    setSelectedScopeWorkId(null);
    draftContextId.current = null;
    setDraftTargetId(null);
    setError(null);
    setSelectedSurface("conversation");
    onOpenContext(contextId);
  }

  function startNewWith(targetEndpointId: string) {
    setSelectedScopeWorkId(null);
    draftContextId.current = null;
    setDraftTargetId(targetEndpointId);
    setError(null);
    setSelectedSurface("conversation");
    onCloseContext();
  }

  async function startOutcome(text: string, files: File[]) {
    if (!operator || !draftTargetId || sending || !modelReady) return;
    setSending(true);
    setError(null);
    try {
      let contextId = draftContextId.current;
      if (!contextId) {
        const context = await createDirectContext(workspaceId, {
          participants: [operator.endpoint_id, draftTargetId],
          created_by_endpoint_id: operator.endpoint_id,
        });
        contextId = context.context_id;
        draftContextId.current = contextId;
      }
      const attachments = files.length > 0
        ? await stageConversationAttachments(
            { workspace_id: workspaceId, locator: workspaceLocator ?? "" },
            contextId,
            files,
          )
        : [];
      const content: Record<string, unknown> = {};
      if (text) content.text = text;
      if (attachments.length > 0) content.attachments = attachments;
      await emit({
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: operator.endpoint_id,
        destination: { kind: "endpoint", endpoint_id: draftTargetId },
        context_id: contextId,
        content,
        response: { expected: true },
        metadata: {},
      });
      setDraftTargetId(null);
      await load();
      onOpenContext(contextId);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Failed to start conversation");
    } finally {
      setSending(false);
    }
  }

  async function deleteCurrentConversation() {
    if (!selectedContextId || conversationActionPending) return;
    const confirmed = window.confirm(
      "Delete this conversation and its messages? Files and other work created in the workspace will remain.",
    );
    if (!confirmed) return;

    setConversationActionPending(true);
    setError(null);
    try {
      await deleteContext(selectedContextId);
      onCloseContext();
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete conversation");
    } finally {
      setConversationActionPending(false);
    }
  }

  const selectedConversation = conversations.find(
    conversation => conversation.context.context_id === selectedContextId,
  ) ?? null;
  const selectedTargetId = selectedConversation?.context.participants.find(
    participant => participant !== operator?.endpoint_id,
  ) ?? null;

  const selectedScopeWork = scopes.find((scope) => scope.scope_id === selectedScopeWorkId) ?? null;

  useEffect(() => {
    if (selectedScopeWork?.status === "retired") setSelectedScopeWorkId(null);
  }, [selectedScopeWork]);

  if (selectedScopeWork?.status !== "retired" && selectedScopeWork && operator) {
    return (
      <ScopeWorkView
        workspaceId={workspaceId}
        scope={selectedScopeWork}
        endpoints={endpoints}
        operatorEndpointId={operator.endpoint_id}
        onBack={() => setSelectedScopeWorkId(null)}
      />
    );
  }

  if (draftTargetId && operator) {
    return (
      <NewConversation
        workspaceId={workspaceId}
        attachmentsEnabled={!!workspaceLocator}
        collaboratorName={endpointName(draftTargetId, endpoints)}
        onOpenSettings={onOpenSettings}
        onReadyChange={setModelReady}
        onCancel={() => {
          draftContextId.current = null;
          setDraftTargetId(null);
          setError(null);
        }}
        onStart={startOutcome}
        sending={sending}
        modelReady={modelReady}
        error={error}
      />
    );
  }

  if (selectedContextId && operator) {
    if (selectedSurface === "work") {
      return (
        <ContextWorkView
          workspaceId={workspaceId}
          rootContextId={selectedContextId}
          endpoints={endpoints}
          operatorEndpointId={operator.endpoint_id}
          onBackToConversation={() => setSelectedSurface("conversation")}
        />
      );
    }
    return (
      <ContextConversation
        key={selectedContextId}
        contextId={selectedContextId}
        workspaceId={workspaceId}
        workspaceLocator={workspaceLocator}
        endpoints={endpoints}
        runtimeHealth={runtimeHealth}
        operatorEntry={{
          speakingAsEndpointId: operator.endpoint_id,
          showContextIdentity: true,
          onOpenSettings,
          onBackToConversations: onCloseContext,
          onOpenWork: () => setSelectedSurface("work"),
          onNewConversation: selectedTargetId ? () => startNewWith(selectedTargetId) : undefined,
          onDeleteConversation: deleteCurrentConversation,
          conversationActionsDisabled: conversationActionPending,
          conversationActionError: error,
        }}
      />
    );
  }

  const needsYou = conversations.filter(conversation => conversation.needsOperator);
  const recent = conversations.filter(conversation => !conversation.needsOperator);
  const visibleRecent = showAll ? recent : recent.slice(0, RECENT_LIMIT);
  const activeScopes = scopes.filter((scope) => scope.status !== "retired");

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "34px 32px 48px", fontFamily: tk.fontUi }}>
      <section style={{ width: "min(780px, 100%)", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 28 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: tk.accent, fontSize: 12, fontWeight: 590, marginBottom: 8 }}>Workspace</div>
            <h1 style={{
              margin: "0 0 8px", color: tk.ink, fontSize: 28, fontWeight: 510,
              letterSpacing: "-0.025em", lineHeight: 1.15,
            }}>
              Conversations
            </h1>
            <p style={{ margin: 0, color: tk.ink3, fontSize: 14, lineHeight: 1.5 }}>
              Resume work with Floe and the collaborators who need your input or judgement.
            </p>
          </div>
          {floe && (
            <button
              type="button"
              onClick={() => startNewWith(floe.endpoint_id)}
              style={{
                marginTop: 20, background: tk.accent, color: "#0c1714", border: "none",
                borderRadius: tk.r2, padding: "9px 13px", fontSize: 12.5,
                fontWeight: 590, cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              New with Floe
            </button>
          )}
        </div>

        {loading && <StatusText>Loading conversations…</StatusText>}
        {error && <div role="alert" style={{ color: tk.danger, fontSize: 13 }}>{error}</div>}

        {!loading && !error && !operator && (
          <StatusText>The workspace operator is not available yet.</StatusText>
        )}
        {!loading && !error && operator && conversations.length === 0 && (
          <StatusText>No conversations yet. Start with Floe and describe an outcome.</StatusText>
        )}

        {!loading && !error && operator && activeScopes.length > 0 && (
          <ScopeSection scopes={activeScopes} onOpen={setSelectedScopeWorkId} />
        )}

        {!loading && !error && needsYou.length > 0 && (
          <ConversationSection
            label="Needs you"
            conversations={needsYou}
            onOpenContext={openConversation}
            attention
          />
        )}

        {!loading && !error && visibleRecent.length > 0 && (
          <ConversationSection
            label="Recent"
            conversations={visibleRecent}
            onOpenContext={openConversation}
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

function ScopeSection({
  scopes,
  onOpen,
}: {
  scopes: ScopeRef[];
  onOpen: (scopeId: string) => void;
}): React.ReactElement {
  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{ marginBottom: 8, color: tk.ink3, fontSize: 10.5, fontWeight: 590, letterSpacing: "0.1em", textTransform: "uppercase" }}>
        Organised work
      </div>
      <div role="list" aria-label="Organised work" style={{ border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden", background: tk.surface }}>
        {scopes.map((scope, index) => (
          <div key={scope.scope_id} role="listitem">
            <button
              type="button"
              onClick={() => onOpen(scope.scope_id)}
              aria-label={`Open organised work ${scope.title || scope.scope_id}`}
              style={{
                width: "100%", display: "grid", gridTemplateColumns: "1fr auto", gap: 16,
                padding: "14px 16px", textAlign: "left", background: "transparent", border: "none",
                borderTop: index > 0 ? `1px solid ${tk.border2}` : "none", cursor: "pointer", color: tk.ink,
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14, fontWeight: 550 }}>{scope.title || scope.scope_id}</span>
                <span style={{ display: "block", color: tk.ink3, fontSize: 12.5, lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {scope.description || "Connected actors and events in this workspace"}
                </span>
              </span>
              <span style={{ alignSelf: "center", color: tk.ink4, fontSize: 11.5, whiteSpace: "nowrap" }}>
                View organisation →
              </span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function NewConversation({
  workspaceId,
  attachmentsEnabled,
  collaboratorName,
  onOpenSettings,
  onReadyChange,
  onCancel,
  onStart,
  sending,
  modelReady,
  error,
}: {
  workspaceId: string;
  attachmentsEnabled: boolean;
  collaboratorName: string;
  onOpenSettings?: () => void;
  onReadyChange: (ready: boolean) => void;
  onCancel: () => void;
  onStart: (text: string, files: File[]) => Promise<void>;
  sending: boolean;
  modelReady: boolean;
  error: string | null;
}): React.ReactElement {
  const [outcome, setOutcome] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const text = outcome.trim();
  const hasMessage = !!text || files.length > 0;

  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      padding: 32, background: tk.canvas,
    }}>
      <section style={{ width: "min(720px, 100%)" }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            margin: "0 0 24px", padding: 0, border: "none", background: "transparent",
            color: tk.ink3, fontSize: 12.5, cursor: "pointer",
          }}
        >
          ← Conversations
        </button>
        <div style={{ color: tk.accent, fontSize: 12, fontWeight: 590, marginBottom: 10 }}>
          New conversation with {collaboratorName}
        </div>
        <h1 style={{
          margin: "0 0 10px", color: tk.ink, fontSize: 34, fontWeight: 510,
          letterSpacing: "-0.025em", lineHeight: 1.15,
        }}>
          What do you want to make happen?
        </h1>
        <p style={{ margin: "0 0 22px", color: tk.ink3, fontSize: 14, lineHeight: 1.55 }}>
          Describe the outcome. {collaboratorName} will work out what is needed and involve you when your judgement matters.
        </p>
        <div style={{ marginBottom: 16 }}>
          <FloeModelControl
            workspaceId={workspaceId}
            onReadyChange={onReadyChange}
            onOpenSettings={onOpenSettings}
          />
        </div>
        {!modelReady && (
          <div role="status" style={{ marginBottom: 10, color: tk.ink3, fontSize: 12.5 }}>
            Choose a provider and model before starting a conversation.
          </div>
        )}
        {error && <div role="alert" style={{ marginBottom: 10, color: tk.danger, fontSize: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ flex: 1, display: "grid", gap: 8 }}>
            <textarea
              autoFocus
              aria-label="Outcome"
              value={outcome}
              onChange={event => setOutcome(event.target.value)}
              onPaste={event => {
                if (!attachmentsEnabled) return;
                const incoming = pastedFiles(event);
                if (incoming.length === 0) return;
                event.preventDefault();
                const result = appendAttachmentFiles(files, incoming);
                if (!result.error) setFiles(result.files);
              }}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (hasMessage && modelReady && !sending) void onStart(text, files);
                }
              }}
              placeholder={modelReady ? "Describe an outcome…" : "Choose a provider and model above"}
              disabled={sending || !modelReady}
              rows={4}
              style={{
                width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 104,
                background: tk.surface, color: tk.ink,
                border: `1px solid ${tk.border}`, borderRadius: tk.r3,
                padding: "13px 14px", fontSize: 14, fontFamily: tk.fontUi,
                lineHeight: 1.5, outline: "none",
              }}
            />
            {attachmentsEnabled && (
              <AttachmentPicker files={files} onChange={setFiles} disabled={sending || !modelReady} />
            )}
          </div>
          <button
            type="button"
            onClick={() => void onStart(text, files)}
            disabled={sending || !modelReady || !hasMessage}
            style={{
              background: tk.accent, color: "#0c1714", border: "none",
              borderRadius: tk.r2, padding: "10px 18px", fontSize: 13,
              fontWeight: 590, opacity: sending || !modelReady || !hasMessage ? 0.5 : 1,
            }}
          >
            {sending ? "Starting…" : "Start"}
          </button>
        </div>
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
