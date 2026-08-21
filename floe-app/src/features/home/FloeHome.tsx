import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ContextRef, EndpointRef } from "../../bus-client/types.ts";
import { createDirectContext, emit, listContexts } from "../../bus-client/client.ts";
import { ContextConversation } from "../../scope/ContextConversation.tsx";
import { FloeModelControl } from "../../workspace/FloeModelControl.tsx";
import { tk } from "../../theme.ts";

export type FloePair = {
  operator: EndpointRef;
  floe: EndpointRef;
};

/** Resolve the two conventional actors without making their endpoint IDs a client contract. */
export function findFloePair(endpoints: EndpointRef[]): FloePair | null {
  const operator = endpoints.find(endpoint => endpoint.agent_id === "operator")
    ?? endpoints.find(endpoint => endpoint.endpoint_id.endsWith(":operator"));
  const floe = endpoints.find(endpoint => endpoint.agent_id === "floe")
    ?? endpoints.find(endpoint => endpoint.endpoint_id.endsWith(":floe"));
  return operator && floe ? { operator, floe } : null;
}

export function latestFloeContext(contexts: ContextRef[], pair: FloePair): ContextRef | null {
  return contexts
    .filter(context => context.participants.includes(pair.operator.endpoint_id)
      && context.participants.includes(pair.floe.endpoint_id))
    .sort((a, b) => {
      const aTime = a.last_event_at ?? a.created_at;
      const bTime = b.last_event_at ?? b.created_at;
      return bTime.localeCompare(aTime);
    })[0] ?? null;
}

export type FloeHomeProps = {
  workspaceId: string;
  endpoints: EndpointRef[];
  onOpenSettings?: () => void;
};

export function FloeHome({ workspaceId, endpoints, onOpenSettings }: FloeHomeProps): React.ReactElement {
  const pair = useMemo(() => findFloePair(endpoints), [endpoints]);
  const [contextId, setContextId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [outcome, setOutcome] = useState("");
  const [sending, setSending] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftContextId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContextId(null);
    setError(null);
    draftContextId.current = null;

    if (!pair) {
      setLoading(false);
      return () => { cancelled = true; };
    }

    setLoading(true);
    listContexts(workspaceId, { scope: "all" })
      .then(contexts => {
        if (!cancelled) setContextId(latestFloeContext(contexts, pair)?.context_id ?? null);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to open Floe");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [workspaceId, pair]);

  async function startOutcome() {
    const text = outcome.trim();
    if (!text || !pair || sending || !modelReady) return;

    setSending(true);
    setError(null);
    try {
      let id = draftContextId.current;
      if (!id) {
        const context = await createDirectContext(workspaceId, {
          participants: [pair.operator.endpoint_id, pair.floe.endpoint_id],
          created_by_endpoint_id: pair.operator.endpoint_id,
        });
        id = context.context_id;
        draftContextId.current = id;
      }

      await emit({
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: pair.operator.endpoint_id,
        destination: { kind: "endpoint", endpoint_id: pair.floe.endpoint_id },
        context_id: id,
        content: { text },
        response: { expected: true },
        metadata: {},
      });
      setContextId(id);
      setOutcome("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send outcome");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return <CenteredMessage>Opening Floe…</CenteredMessage>;
  }

  if (!pair) {
    return (
      <CenteredMessage>
        <span>Floe is not available in this workspace yet.</span>
        <span style={{ color: tk.ink4, fontSize: 12 }}>Developer tools remain available in the sidebar.</span>
      </CenteredMessage>
    );
  }

  if (contextId) {
    return (
      <ContextConversation
        contextId={contextId}
        workspaceId={workspaceId}
        endpoints={endpoints}
        operatorEntry={{ speakingAsEndpointId: pair.operator.endpoint_id, onOpenSettings }}
      />
    );
  }

  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      padding: 32, background: tk.canvas,
    }}>
      <section style={{ width: "min(720px, 100%)" }}>
        <div style={{ color: tk.accent, fontSize: 12, fontWeight: 590, marginBottom: 10 }}>Floe</div>
        <h1 style={{
          margin: "0 0 10px", color: tk.ink, fontSize: 34, fontWeight: 510,
          letterSpacing: "-0.025em", lineHeight: 1.15,
        }}>
          What do you want to make happen?
        </h1>
        <p style={{ margin: "0 0 22px", color: tk.ink3, fontSize: 14, lineHeight: 1.55 }}>
          Describe the outcome. Floe will work out what it needs and involve you when your judgement matters.
        </p>
        <div style={{ marginBottom: 16 }}>
          <FloeModelControl
            workspaceId={workspaceId}
            onReadyChange={setModelReady}
            onOpenSettings={onOpenSettings}
          />
        </div>
        {!modelReady && (
          <div role="status" style={{ marginBottom: 10, color: tk.ink3, fontSize: 12.5 }}>
            Choose a provider and model before talking to Floe.
          </div>
        )}
        {error && <div role="alert" style={{ marginBottom: 10, color: tk.danger, fontSize: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <textarea
            autoFocus
            aria-label="Outcome"
            value={outcome}
            onChange={event => setOutcome(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void startOutcome();
              }
            }}
            placeholder={modelReady ? "Describe an outcome…" : "Choose a provider and model above"}
            disabled={sending || !modelReady}
            rows={4}
            style={{
              flex: 1, resize: "vertical", minHeight: 104,
              background: tk.surface, color: tk.ink,
              border: `1px solid ${tk.border}`, borderRadius: tk.r3,
              padding: "13px 14px", fontSize: 14, fontFamily: tk.fontUi,
              lineHeight: 1.5, outline: "none",
            }}
          />
          <button
            type="button"
            onClick={() => void startOutcome()}
            disabled={sending || !modelReady || !outcome.trim()}
            style={{
              background: tk.accent, color: "#0c1714", border: "none",
              borderRadius: tk.r2, padding: "10px 18px", fontSize: 13,
              fontWeight: 590, opacity: sending || !modelReady || !outcome.trim() ? 0.5 : 1,
            }}
          >
            {sending ? "Starting…" : "Start"}
          </button>
        </div>
      </section>
    </div>
  );
}

function CenteredMessage({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column", gap: 6,
      alignItems: "center", justifyContent: "center", color: tk.ink3,
    }}>
      {children}
    </div>
  );
}
