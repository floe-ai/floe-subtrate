import React, { useState } from "react";
import type { ScopeRef, EndpointRef } from "../../bus-client/types.ts";
import type { RuntimeHealth } from "../../runtime/health.ts";
import { tk } from "../../theme.ts";

export type NavView = "conversations" | "home" | "activity";

export type NavProps = {
  view: NavView;
  scopes: ScopeRef[];
  selectedScopeId: string | null;
  actors: EndpointRef[];
  selectedActorId: string | null;
  onView: (v: NavView) => void;
  onSelectScope: (id: string) => void;
  onSelectActor: (id: string) => void;
  onNewScope: () => void;
  onNewActor: () => void;
  showNewActor: boolean;
  appMode: "workspace" | "system";
  onViewSystem: () => void;
  runtimeHealth?: RuntimeHealth;
  onRestartRuntime?: () => void;
};

export function LeftNav({
  view, scopes, selectedScopeId, actors, selectedActorId,
  onView, onSelectScope, onSelectActor, onNewScope, onNewActor, showNewActor,
  appMode, onViewSystem, runtimeHealth, onRestartRuntime,
}: NavProps): React.ReactElement {
  const isSystemActive = appMode === "system";
  const [developerOpen, setDeveloperOpen] = useState(false);

  return (
    <aside style={{
      flex: "0 0 240px",
      width: 240,
      height: "100%",
      background: tk.surface,
      borderRight: `1px solid ${tk.border}`,
      overflowY: "auto",
      padding: "8px 0",
      display: "flex", flexDirection: "column",
    }}>
      {/* Normal operator entry */}
      <NavRow
        label="Conversations"
        glyph="◌"
        isOn={!isSystemActive && view === "conversations"}
        onClick={() => { onView("conversations"); onSelectScope(""); }}
      />

      {/* Existing observatory, deliberately secondary. */}
      <div style={{ marginTop: 10, borderTop: `1px solid ${tk.border2}`, paddingTop: 6 }}>
        <button
          type="button"
          aria-expanded={developerOpen}
          onClick={() => setDeveloperOpen(open => !open)}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            width: "100%", padding: "6px 14px",
            border: "none", background: "transparent",
            color: tk.ink3, fontSize: 11.5, textAlign: "left",
          }}
        >
          <span style={{ width: 16, color: tk.ink4 }}>{developerOpen ? "▾" : "▸"}</span>
          <span>Developer tools</span>
        </button>

        {developerOpen && (
          <>
            <NavRow
              label="Workspace overview"
              glyph="⌂"
              isOn={!isSystemActive && view === "home" && selectedScopeId === null && selectedActorId === null}
              onClick={() => { onView("home"); onSelectScope(""); }}
            />
            <NavRow
              label="Activity"
              glyph="≋"
              isOn={!isSystemActive && view === "activity"}
              onClick={() => { onView("activity"); onSelectScope(""); }}
            />

            <NavSection label="Scopes" count={scopes.length} />
            {scopes.map(s => (
              <NavRow
                key={s.scope_id}
                label={`${s.title || s.scope_id}${s.status === "retired" ? " (retired)" : ""}`}
                glyph={(s.title || s.scope_id).charAt(0).toUpperCase()}
                isOn={!isSystemActive && selectedScopeId === s.scope_id}
                onClick={() => onSelectScope(s.scope_id)}
                faint={s.status === "retired"}
                title={s.status === "retired" ? "Historical Scope; routing is inactive" : undefined}
              />
            ))}
            <NavRow label="New scope" glyph="+" isOn={false} onClick={onNewScope} faint />

            <NavSection label="Actors" count={actors.length} />
            {actors.map(a => (
              <NavRow
                key={a.endpoint_id}
                label={`${a.name || a.endpoint_id}${a.status === "retired" ? " (retired)" : ""}`}
                glyph={(a.name || a.endpoint_id).charAt(0).toUpperCase()}
                isOn={!isSystemActive && selectedActorId === a.endpoint_id}
                onClick={() => onSelectActor(a.endpoint_id)}
                faint={a.status === "retired"}
                title={a.status === "retired" ? "Historical actor identity; no longer available for work" : undefined}
              />
            ))}
            {actors.length === 0 && (
              <div style={{ padding: "4px 14px", fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>
                No actors registered
              </div>
            )}
            <NavRow label="New actor" glyph="+" isOn={!isSystemActive && showNewActor} onClick={onNewActor} faint />

            <NavRow label="Substrate Settings" glyph="⚙" isOn={isSystemActive} onClick={onViewSystem} />
          </>
        )}
      </div>

      {runtimeHealth && (
        <RuntimeHealthIndicator health={runtimeHealth} onRestart={onRestartRuntime} />
      )}
    </aside>
  );
}

export function RuntimeHealthIndicator({
  health,
  onRestart,
}: {
  health: RuntimeHealth;
  onRestart?: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const color = health.state === "healthy"
    ? tk.ok
    : health.state === "offline"
      ? tk.danger
      : "#d2a85e";

  return (
    <div style={{ marginTop: "auto", paddingTop: 8, borderTop: `1px solid ${tk.border2}` }}>
      {open && (
        <div
          role="status"
          style={{
            margin: "0 10px 7px",
            padding: "10px 11px",
            background: tk.surfaceSunk,
            border: `1px solid ${tk.border}`,
            borderRadius: tk.r2,
          }}
        >
          <div style={{ color: tk.ink, fontSize: 12.5, fontWeight: 560 }}>{health.label}</div>
          <div style={{ color: tk.ink3, fontSize: 11.5, marginTop: 4, lineHeight: 1.45 }}>
            {health.detail}
          </div>
          {health.technicalDetail && (
            <details style={{ marginTop: 7, color: tk.ink4, fontSize: 11 }}>
              <summary style={{ cursor: "pointer", color: tk.ink3 }}>Technical detail</summary>
              <pre style={{
                marginTop: 5,
                maxHeight: 96,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
                fontSize: 10.5,
              }}>
                {health.technicalDetail}
              </pre>
            </details>
          )}
          {health.state === "offline" && onRestart && (
            <button
              type="button"
              onClick={onRestart}
              style={{
                marginTop: 9,
                padding: "5px 8px",
                borderRadius: tk.r2,
                border: `1px solid ${tk.border}`,
                background: tk.surfaceHov,
                color: tk.ink2,
                fontSize: 11.5,
              }}
            >
              Restart local services
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Floe status: ${health.label}`}
        title={`${health.label}. ${health.detail}`}
        onClick={() => setOpen(value => !value)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "7px 14px",
          border: "none",
          background: open ? "rgba(255,255,255,0.03)" : "transparent",
          color: tk.ink3,
          textAlign: "left",
          fontSize: 11.5,
        }}
      >
        <span style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 0 3px ${color}1f`,
          flexShrink: 0,
        }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {health.label}
        </span>
        <span aria-hidden="true" style={{ marginLeft: "auto", color: tk.ink4 }}>{open ? "▾" : "▴"}</span>
      </button>
    </div>
  );
}

function NavSection({ label, count }: { label: string; count: number }): React.ReactElement {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "16px 14px 6px",
      fontWeight: 510, fontSize: 10.5, letterSpacing: "0.10em",
      textTransform: "uppercase", color: tk.ink3,
    }}>
      <span>{label}</span>
      <span style={{ marginLeft: "auto", color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontVariantNumeric: "tabular-nums", fontSize: 11 }}>
        {count}
      </span>
    </div>
  );
}

export type NavRowProps = {
  label: string;
  glyph: string;
  isOn: boolean;
  onClick: () => void;
  faint?: boolean;
  disabled?: boolean;
  title?: string;
};

export function NavRow({
  label, glyph, isOn, onClick, faint, disabled, title,
}: NavRowProps): React.ReactElement {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "5px 14px",
        background: isOn ? "rgba(255,255,255,0.04)" : hov ? "rgba(255,255,255,0.03)" : "transparent",
        border: "none",
        borderLeft: isOn ? `2px solid ${tk.accent}` : "2px solid transparent",
        color: faint ? tk.ink4 : isOn ? tk.ink : hov ? tk.ink : tk.ink2,
        fontSize: 13, cursor: disabled ? "not-allowed" : "pointer",
        textAlign: "left", width: "100%",
        opacity: disabled ? 0.4 : 1,
        transition: "background 120ms ease, color 120ms ease",
        flexShrink: 0,
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      <span style={{
        width: 16, display: "inline-flex", alignItems: "center", justifyContent: "center",
        color: isOn ? tk.accent : faint ? tk.ink4 : tk.ink4, fontSize: 12, flexShrink: 0,
      }}>{glyph}</span>
      <span>{label}</span>
    </button>
  );
}
