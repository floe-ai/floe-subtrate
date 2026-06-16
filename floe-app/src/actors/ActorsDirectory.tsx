/**
 * ActorsDirectory — lists ALL endpoints uniformly. No type hierarchy.
 * Supports adding and deleting actors. Human and agent actors are the same shape.
 */
import React, { useEffect, useState } from "react";
import type { EndpointRef } from "../bus-client/types.ts";
import {
  listEndpoints,
  listEvents,
  registerEndpoint,
  deleteEndpoint,
} from "../bus-client/client.ts";
import { colors, space, font } from "../theme.ts";

export type ActorsDirectoryProps = {
  workspaceId: string;
  onOpenContext?: (contextId: string) => void;
  onActorsChange?: (endpoints: EndpointRef[]) => void;
};

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; recentContextIds: string[] }
  | { status: "error"; message: string };

/** Status dot — conveys both shape+color and text label (WCAG) */
function StatusIndicator({ status }: { status: string }): React.ReactElement {
  const dotColor =
    status === "active" ? colors.accent
    : status === "idle"  ? "#5A9E6F"
    : status === "runtime_unconfigured" ? colors.danger
    : colors.muted;

  return (
    <span
      aria-hidden="true"
      title={status}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: dotColor,
        marginRight: 4,
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    />
  );
}

type NewActorForm = {
  name: string;
  endpoint_id: string;
};

function generateId(): string {
  return crypto.randomUUID();
}

export function ActorsDirectory({
  workspaceId,
  onOpenContext,
  onActorsChange,
}: ActorsDirectoryProps): React.ReactElement {
  const [endpoints, setEndpoints] = useState<EndpointRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });

  // New actor form state
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<NewActorForm>({ name: "", endpoint_id: generateId() });
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // Delete state
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    setError(null);
    listEndpoints(workspaceId)
      .then((rows) => {
        setEndpoints(rows);
        setLoading(false);
        onActorsChange?.(rows);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load endpoints");
        setLoading(false);
      });
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listEndpoints(workspaceId)
      .then((rows) => {
        if (cancelled) return;
        setEndpoints(rows);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load endpoints");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [workspaceId]);

  function selectActor(endpointId: string) {
    if (selectedId === endpointId) {
      setSelectedId(null);
      setDetail({ status: "idle" });
      return;
    }
    setSelectedId(endpointId);
    setDetail({ status: "loading" });

    listEvents({ workspace_id: workspaceId, limit: 20 })
      .then(({ events }) => {
        const myEvents = events.filter(
          (e) => e.source_endpoint_id === endpointId
        );
        const ctxIds = [
          ...new Set(myEvents.map((e) => e.context_id).filter(Boolean) as string[]),
        ];
        setDetail({ status: "loaded", recentContextIds: ctxIds });
      })
      .catch((err) => {
        setDetail({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load events",
        });
      });
  }

  async function handleCreate() {
    const name = form.name.trim();
    if (!name) return;
    setCreating(true);
    setCreateErr(null);
    try {
      await registerEndpoint({
        endpoint_id: form.endpoint_id || generateId(),
        workspace_id: workspaceId,
        name,
      });
      setShowForm(false);
      setForm({ name: "", endpoint_id: generateId() });
      reload();
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : "Failed to create actor");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(endpointId: string) {
    if (!window.confirm("Delete this actor? This cannot be undone.")) return;
    setDeletingId(endpointId);
    try {
      await deleteEndpoint(endpointId);
      if (selectedId === endpointId) {
        setSelectedId(null);
        setDetail({ status: "idle" });
      }
      reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete actor");
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return (
      <div role="status" aria-live="polite" style={{ padding: space.xl, color: colors.muted, font: font.body }}>
        Loading actors…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" style={{ padding: space.xl, color: colors.danger, font: font.body }}>
        Error: {error}
      </div>
    );
  }

  return (
    <div
      data-testid="actors-directory"
      style={{ display: "flex", height: "100%", font: font.body, overflow: "hidden" }}
    >
      {/* List */}
      <div
        role="list"
        aria-label="Actors"
        style={{
          width: 320,
          flexShrink: 0,
          borderRight: `1px solid ${colors.border}`,
          overflowY: "auto",
          background: colors.surface,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: `${space.sm}px ${space.lg}px`,
            borderBottom: `1px solid ${colors.border}`,
            display: "flex",
            alignItems: "center",
            gap: space.sm,
          }}
        >
          <span style={{ fontSize: font.meta, color: colors.muted, fontWeight: font.h, flex: 1 }}>
            {endpoints.length} actor{endpoints.length !== 1 ? "s" : ""}
          </span>
          <button
            onClick={() => { setShowForm((v) => !v); setCreateErr(null); }}
            aria-label="Add actor"
            style={{
              background: showForm ? colors.accent : "none",
              color: showForm ? colors.accentText : colors.accent,
              border: `1px solid ${colors.accent}`,
              borderRadius: 4,
              padding: "2px 10px",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "system-ui, sans-serif",
            }}
          >
            {showForm ? "Cancel" : "+ Add actor"}
          </button>
        </div>

        {/* New actor form */}
        {showForm && (
          <div
            style={{
              padding: `${space.md}px ${space.lg}px`,
              borderBottom: `1px solid ${colors.border}`,
              background: colors.canvas,
              display: "flex",
              flexDirection: "column",
              gap: space.sm,
            }}
          >
            <input
              aria-label="Actor name"
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
              autoFocus
              style={{
                background: colors.surface,
                color: colors.text,
                border: `1px solid ${colors.border}`,
                borderRadius: 4,
                padding: "4px 8px",
                fontSize: 13,
                fontFamily: "system-ui, sans-serif",
              }}
            />
            <div style={{ display: "flex", gap: space.xs, alignItems: "center" }}>
              <label style={{ fontSize: 11, color: colors.muted, flexShrink: 0 }}>ID</label>
              <input
                aria-label="Endpoint ID (optional)"
                value={form.endpoint_id}
                onChange={(e) => setForm((f) => ({ ...f, endpoint_id: e.target.value }))}
                style={{
                  background: colors.surface,
                  color: colors.muted,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 4,
                  padding: "2px 6px",
                  fontSize: 11,
                  fontFamily: "monospace",
                  flex: 1,
                  minWidth: 0,
                }}
              />
            </div>
            {createErr && (
              <p role="alert" style={{ color: colors.danger, fontSize: 12, margin: 0 }}>{createErr}</p>
            )}
            <button
              onClick={() => void handleCreate()}
              disabled={creating || !form.name.trim()}
              style={{
                background: colors.accent,
                color: colors.accentText,
                border: "none",
                borderRadius: 4,
                padding: "4px 12px",
                cursor: "pointer",
                fontSize: 13,
                fontFamily: "system-ui, sans-serif",
                alignSelf: "flex-start",
              }}
            >
              {creating ? "Creating…" : "Create actor"}
            </button>
          </div>
        )}

        {/* Empty state */}
        {endpoints.length === 0 && !showForm && (
          <div style={{ padding: space.xl, color: colors.muted, fontStyle: "italic", fontSize: 13 }}>
            No actors registered. Add one above.
          </div>
        )}

        {/* Actor rows */}
        {endpoints.map((ep) => {
          const isSelected = selectedId === ep.endpoint_id;
          const isDeleting = deletingId === ep.endpoint_id;
          return (
            <div
              key={ep.endpoint_id}
              role="listitem"
              data-testid={`actor-row-${ep.endpoint_id}`}
              onClick={() => selectActor(ep.endpoint_id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectActor(ep.endpoint_id);
                }
              }}
              tabIndex={0}
              aria-selected={isSelected}
              aria-label={`${ep.name || ep.endpoint_id}, status: ${ep.status}`}
              style={{
                padding: `${space.md}px ${space.lg}px`,
                borderBottom: `1px solid ${colors.border}`,
                cursor: "pointer",
                background: isSelected ? colors.bubbleOwn : "transparent",
                borderLeft: isSelected ? `3px solid ${colors.accent}` : "3px solid transparent",
                transition: "background 0.08s",
                opacity: isDeleting ? 0.5 : 1,
              }}
              onFocus={(e) => {
                (e.currentTarget as HTMLDivElement).style.outline = `2px solid ${colors.accent}`;
                (e.currentTarget as HTMLDivElement).style.outlineOffset = "-2px";
              }}
              onBlur={(e) => {
                (e.currentTarget as HTMLDivElement).style.outline = "none";
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: space.xs, marginBottom: 2 }}>
                <StatusIndicator status={ep.status} />
                <span style={{ fontWeight: font.h, fontSize: 14, color: colors.text, flex: 1 }}>
                  {ep.name || ep.endpoint_id}
                </span>
              </div>
              <div style={{ fontSize: font.meta, color: colors.muted }}>
                <span>{ep.status}</span>
                {ep.agent_id && <span> · agent: {ep.agent_id}</span>}
                {ep.bridge_id && <span> · bridge: {ep.bridge_id}</span>}
              </div>
              <div style={{ fontSize: font.meta, color: colors.muted, marginTop: 1 }}>
                <code style={{ fontSize: 11 }}>{ep.endpoint_id}</code>
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail panel */}
      <div style={{ flex: 1, overflowY: "auto", padding: space.xl }}>
        {!selectedId && (
          <p style={{ color: colors.muted, fontStyle: "italic" }}>
            Select an actor to see details.
          </p>
        )}

        {selectedId && (() => {
          const ep = endpoints.find((e) => e.endpoint_id === selectedId);
          if (!ep) return null;
          return (
            <div>
              <div style={{ display: "flex", alignItems: "flex-start", gap: space.md, marginBottom: space.md }}>
                <h2 style={{ fontSize: 18, fontWeight: font.h, margin: 0, flex: 1 }}>
                  {ep.name || ep.endpoint_id}
                </h2>
                <button
                  onClick={() => void handleDelete(ep.endpoint_id)}
                  disabled={deletingId === ep.endpoint_id}
                  aria-label={`Delete actor ${ep.name || ep.endpoint_id}`}
                  style={{
                    background: "none",
                    border: `1px solid ${colors.danger}`,
                    color: colors.danger,
                    borderRadius: 4,
                    padding: "3px 10px",
                    cursor: "pointer",
                    fontSize: 12,
                    fontFamily: "system-ui, sans-serif",
                    flexShrink: 0,
                  }}
                >
                  {deletingId === ep.endpoint_id ? "Deleting…" : "Delete actor"}
                </button>
              </div>

              <dl style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: `${space.xs}px ${space.lg}px`, fontSize: 13 }}>
                <dt style={{ color: colors.muted }}>Endpoint ID</dt>
                <dd><code>{ep.endpoint_id}</code></dd>
                <dt style={{ color: colors.muted }}>Status</dt>
                <dd>
                  <StatusIndicator status={ep.status} />
                  {ep.status}
                </dd>
                {ep.agent_id && <>
                  <dt style={{ color: colors.muted }}>Agent</dt>
                  <dd><code>{ep.agent_id}</code></dd>
                </>}
                {ep.bridge_id && <>
                  <dt style={{ color: colors.muted }}>Bridge</dt>
                  <dd><code>{ep.bridge_id}</code></dd>
                </>}
                <dt style={{ color: colors.muted }}>Created</dt>
                <dd>{new Date(ep.created_at).toLocaleString()}</dd>
              </dl>

              <h3 style={{ fontSize: 14, fontWeight: font.h, marginTop: space.xl, marginBottom: space.sm }}>
                Recent contexts
              </h3>

              {detail.status === "loading" && (
                <p role="status" style={{ color: colors.muted }}>Loading…</p>
              )}
              {detail.status === "error" && (
                <p role="alert" style={{ color: colors.danger }}>{detail.message}</p>
              )}
              {detail.status === "loaded" && detail.recentContextIds.length === 0 && (
                <p style={{ color: colors.muted, fontStyle: "italic" }}>No recent activity.</p>
              )}
              {detail.status === "loaded" && detail.recentContextIds.length > 0 && (
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {detail.recentContextIds.map((ctxId) => (
                    <li key={ctxId} style={{ marginBottom: space.xs }}>
                      {onOpenContext ? (
                        <button
                          onClick={() => onOpenContext(ctxId)}
                          style={{
                            background: "none",
                            border: "none",
                            color: colors.accent,
                            cursor: "pointer",
                            fontSize: 13,
                            padding: 0,
                            textDecoration: "underline",
                          }}
                        >
                          <code>{ctxId}</code>
                        </button>
                      ) : (
                        <code style={{ fontSize: 12 }}>{ctxId}</code>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
