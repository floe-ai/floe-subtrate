import React, { useState } from "react";
import type { ScopeRef, EndpointRef } from "../../bus-client/types.ts";
import { tk } from "../../theme.ts";

export type NavView = "home" | "activity";

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
};

export function LeftNav({
  view, scopes, selectedScopeId, actors, selectedActorId,
  onView, onSelectScope, onSelectActor, onNewScope, onNewActor, showNewActor,
  appMode, onViewSystem,
}: NavProps): React.ReactElement {
  const isSystemActive = appMode === "system";

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
      {/* Home */}
      <NavRow
        label="Home"
        glyph="⌂"
        isOn={!isSystemActive && view === "home" && selectedScopeId === null}
        onClick={() => { onView("home"); onSelectScope(""); /* empty string → null in handleSelectScope */ }}
      />
      {/* Activity */}
      <NavRow
        label="Activity"
        glyph="≋"
        isOn={!isSystemActive && view === "activity"}
        onClick={() => { onView("activity"); onSelectScope(""); /* empty string → null in handleSelectScope; also clears context/actor/settings */ }}
      />

      {/* Scopes section */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "16px 14px 6px",
        fontWeight: 510, fontSize: 10.5, letterSpacing: "0.10em",
        textTransform: "uppercase", color: tk.ink3,
      }}>
        <span>Scopes</span>
        <span style={{ marginLeft: "auto", color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontVariantNumeric: "tabular-nums", fontSize: 11 }}>
          {scopes.length}
        </span>
      </div>

      {scopes.map(s => (
        <NavRow
          key={s.scope_id}
          label={s.title || s.scope_id}
          glyph={(s.title || s.scope_id).charAt(0).toUpperCase()}
          isOn={!isSystemActive && selectedScopeId === s.scope_id}
          onClick={() => onSelectScope(s.scope_id)}
        />
      ))}

      <NavRow
        label="New scope"
        glyph="+"
        isOn={false}
        onClick={onNewScope}
        faint
      />

      {/* Actors section */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "16px 14px 6px",
        fontWeight: 510, fontSize: 10.5, letterSpacing: "0.10em",
        textTransform: "uppercase", color: tk.ink3,
      }}>
        <span>Actors</span>
        <span style={{ marginLeft: "auto", color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontVariantNumeric: "tabular-nums", fontSize: 11 }}>
          {actors.length}
        </span>
      </div>

      {actors.map(a => (
        <NavRow
          key={a.endpoint_id}
          label={a.name || a.endpoint_id}
          glyph={(a.name || a.endpoint_id).charAt(0).toUpperCase()}
          isOn={!isSystemActive && selectedActorId === a.endpoint_id}
          onClick={() => onSelectActor(a.endpoint_id)}
        />
      ))}

      {actors.length === 0 && (
        <div style={{ padding: "4px 14px", fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>
          No actors registered
        </div>
      )}

      <NavRow
        label="New actor"
        glyph="+"
        isOn={!isSystemActive && showNewActor}
        onClick={onNewActor}
        faint
      />

      {/* Flexible Spacer to push settings to bottom */}
      <div style={{ flex: "1 1 auto", minHeight: 16 }} />

      {/* Substrate / System Settings Rule and Option */}
      <hr style={{ border: "none", borderTop: `1px solid ${tk.border2}`, margin: "8px 0" }} />
      <NavRow
        label="Substrate Settings"
        glyph="⚙"
        isOn={isSystemActive}
        onClick={onViewSystem}
      />
    </aside>
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
