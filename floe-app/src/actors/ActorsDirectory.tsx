/**
 * ActorsDirectory — lists ALL endpoints uniformly. No type hierarchy.
 * No special Floe treatment. Name, endpoint_id, status (label+dot), agent/bridge.
 */
import React, { useEffect, useState } from "react";
import type { EndpointRef } from "../bus-client/types.ts";
import { listEndpoints, listEvents } from "../bus-client/client.ts";
import { colors, space, font } from "../theme.ts";

export type ActorsDirectoryProps = {
  workspaceId: string;
  onOpenContext?: (contextId: string) => void;
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

export function ActorsDirectory({
  workspaceId,
  onOpenContext,
}: ActorsDirectoryProps): React.ReactElement {
  const [endpoints, setEndpoints] = useState<EndpointRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });

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

  if (endpoints.length === 0) {
    return (
      <div role="status" style={{ padding: space.xl, color: colors.muted, font: font.body }}>
        No actors registered in this workspace.
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
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: `${space.sm}px ${space.lg}px`,
            borderBottom: `1px solid ${colors.border}`,
            fontSize: font.meta,
            color: colors.muted,
            fontWeight: font.h,
          }}
        >
          {endpoints.length} actor{endpoints.length !== 1 ? "s" : ""}
        </div>

        {endpoints.map((ep) => {
          const isSelected = selectedId === ep.endpoint_id;
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
                <span style={{ fontWeight: font.h, fontSize: 14, color: colors.text }}>
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
              <h2 style={{ fontSize: 18, fontWeight: font.h, marginBottom: space.md }}>
                {ep.name || ep.endpoint_id}
              </h2>
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
