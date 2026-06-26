import React, { useState } from "react";
import type { EndpointRef } from "../../bus-client/types.ts";
import type { WorkspaceFsRef } from "../../fs/workspaceFs.ts";
import { tk } from "../../theme.ts";
import { ActorInspector, ActorContexts } from "../../actors/ActorInspector.tsx";
import { ContextConversation } from "../../scope/ContextConversation.tsx";

export type ActorViewProps = {
  actor: EndpointRef;
  workspaceId: string;
  workspace: WorkspaceFsRef;
  onSaved: (updated: EndpointRef) => void;
  onDeleted: (endpointId: string) => void;
  onOpenContext: (contextId: string) => void;
  endpoints: EndpointRef[];
};

export function ActorView({
  actor,
  workspaceId,
  workspace,
  onSaved,
  onDeleted,
  endpoints,
}: ActorViewProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<"conversations" | "configure">("conversations");
  const [selectedSubContextId, setSelectedSubContextId] = useState<string | null>(null);

  const actorName = actor.name || actor.endpoint_id;
  const initialGlyph = actorName.charAt(0).toUpperCase();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: tk.canvas }}>
      {/* Spacious Hero Header */}
      <header style={{
        flex: "0 0 auto",
        padding: "20px 32px 16px",
        borderBottom: `1px solid ${tk.border}`,
        background: "rgba(15,16,17,0.3)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyItems: "center", gap: 16 }}>
          {/* Large Avatar */}
          <div style={{
            width: 48, height: 48, borderRadius: tk.r3,
            background: tk.accentSoft2, color: tk.accentHov,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontWeight: 600, fontSize: 20, flexShrink: 0,
            border: `1px solid rgba(138,168,156,0.25)`,
          }}>
            {initialGlyph}
          </div>

          <div>
            <div style={{
              fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase",
              color: tk.ink3, fontWeight: 510, marginBottom: 2,
            }}>
              Actor
            </div>
            <h1 style={{
              fontWeight: 510, fontSize: 24, lineHeight: 1.1,
              letterSpacing: "-0.02em", color: tk.ink, margin: 0,
            }}>
              {actorName}
            </h1>
          </div>

          {/* Tab buttons */}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, background: tk.surface, padding: 3, borderRadius: tk.r2, border: `1px solid ${tk.border}` }}>
            <button
              onClick={() => setActiveTab("conversations")}
              style={{
                background: activeTab === "conversations" ? "rgba(255,255,255,0.06)" : "transparent",
                border: "none",
                borderRadius: tk.r1,
                padding: "6px 14px",
                color: activeTab === "conversations" ? tk.accent : tk.ink3,
                fontWeight: 510, fontSize: 12.5, cursor: "pointer",
                transition: "background 100ms ease, color 100ms ease",
              }}
            >
              Conversations
            </button>
            <button
              onClick={() => setActiveTab("configure")}
              style={{
                background: activeTab === "configure" ? "rgba(255,255,255,0.06)" : "transparent",
                border: "none",
                borderRadius: tk.r1,
                padding: "6px 14px",
                color: activeTab === "configure" ? tk.accent : tk.ink3,
                fontWeight: 510, fontSize: 12.5, cursor: "pointer",
                transition: "background 100ms ease, color 100ms ease",
              }}
            >
              ⚙ Configure Agent
            </button>
          </div>
        </div>
      </header>

      {/* Main Viewport Content */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {activeTab === "conversations" ? (
          <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
            {/* Left Split Pane: Conversations Master List */}
            <div style={{
              width: 320,
              flexShrink: 0,
              borderRight: `1px solid ${tk.border}`,
              background: "rgba(15,16,17,0.15)",
              display: "flex",
              flexDirection: "column",
              overflowY: "auto",
              padding: "16px 20px",
            }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 16 }}>
                <div>
                  <span style={{ fontSize: 10, color: tk.ink4, display: "block", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>Endpoint ID</span>
                  <code style={{ fontSize: 11, color: tk.ink2, background: "rgba(255,255,255,0.03)", padding: "2px 6px", borderRadius: 4, display: "inline-block" }}>{actor.endpoint_id}</code>
                </div>
                <div>
                  <span style={{ fontSize: 10, color: tk.ink4, display: "block", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>Status</span>
                  <span style={{ fontSize: 12, color: tk.ok, fontWeight: 510, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: tk.ok }} />
                    {actor.status}
                  </span>
                </div>
                {actor.agent_id && (
                  <div>
                    <span style={{ fontSize: 10, color: tk.ink4, display: "block", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>Agent Type</span>
                    <code style={{ fontSize: 11, color: tk.accentHov }}>{actor.agent_id}</code>
                  </div>
                )}
              </div>

              <hr style={{ border: "none", borderTop: `1px solid ${tk.border2}`, margin: "8px 0 16px" }} />

              <h2 style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: tk.ink3, margin: "0 0 10px" }}>
                Task Contexts ({endpoints.length ? "In Workspace" : "0"})
              </h2>
              
              <div style={{ flex: 1, overflowY: "auto", margin: "0 -10px", padding: "0 10px" }}>
                <ActorContexts
                  endpointId={actor.endpoint_id}
                  workspaceId={workspaceId}
                  onOpenContext={(contextId) => setSelectedSubContextId(contextId)}
                  endpoints={endpoints}
                />
              </div>
            </div>

            {/* Right Split Pane: Work Observatory details */}
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100%", background: tk.canvas }}>
              {selectedSubContextId ? (
                <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
                  {/* Context Active Bar */}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "8px 24px", background: "rgba(255,255,255,0.02)",
                    borderBottom: `1px solid ${tk.border2}`, flexShrink: 0,
                  }}>
                    <span style={{ fontSize: 11, color: tk.ink3 }}>Observing Context: <code style={{ color: tk.accent, fontSize: 11 }}>{selectedSubContextId}</code></span>
                    <button
                      onClick={() => setSelectedSubContextId(null)}
                      style={{
                        marginLeft: "auto", background: "transparent", border: `1px solid ${tk.border}`,
                        color: tk.ink3, borderRadius: tk.r2, padding: "3px 10px", fontSize: 11,
                        cursor: "pointer", transition: "background 100ms ease, color 100ms ease",
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)"; (e.currentTarget as HTMLButtonElement).style.color = tk.ink; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; (e.currentTarget as HTMLButtonElement).style.color = tk.ink3; }}
                    >
                      ✕ Close
                    </button>
                  </div>

                  {/* Context Detail Conversation */}
                  <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                    <ContextConversation
                      key={selectedSubContextId}
                      contextId={selectedSubContextId}
                      workspaceId={workspaceId}
                      endpoints={endpoints}
                    />
                  </div>
                </div>
              ) : (
                <div style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  height: "100%", padding: 40, textAlign: "center", color: tk.ink3,
                }}>
                  <div style={{
                    width: 60, height: 60, borderRadius: "50%", background: tk.accentSoft,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: tk.accent, fontSize: 24, marginBottom: 16,
                    border: `1px solid rgba(138,168,156,0.15)`,
                  }}>
                    ≋
                  </div>
                  <h3 style={{ fontSize: 16, fontWeight: 510, color: tk.ink, margin: "0 0 6px" }}>Observe Agent Work</h3>
                  <p style={{ fontSize: 13, color: tk.ink3, margin: 0, maxWidth: "42ch", lineHeight: 1.5 }}>
                    Select a task context from the list on the left to see conversation transcripts, tool use, and decisions in real-time.
                  </p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 32px 40px" }}>
            <div style={{ maxWidth: 900, background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden" }}>
              {/* Fully Reused Settings Form */}
              <ActorInspector
                actor={actor}
                workspaceId={workspaceId}
                workspace={workspace}
                onSaved={onSaved}
                onDeleted={onDeleted}
                onOpenContext={(contextId) => {
                  setSelectedSubContextId(contextId);
                  setActiveTab("conversations");
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
