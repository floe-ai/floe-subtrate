import React, { useState } from "react";
import type { ScopeRef, EndpointRef } from "../../bus-client/types.ts";
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
};

export function LeftNav({
  view, scopes, selectedScopeId, actors, selectedActorId,
  onView, onSelectScope, onSelectActor, onNewScope, onNewActor, showNewActor,
  appMode, onViewSystem,
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
                label={s.title || s.scope_id}
                glyph={(s.title || s.scope_id).charAt(0).toUpperCase()}
                isOn={!isSystemActive && selectedScopeId === s.scope_id}
                onClick={() => onSelectScope(s.scope_id)}
              />
            ))}
            <NavRow label="New scope" glyph="+" isOn={false} onClick={onNewScope} faint />

            <NavSection label="Actors" count={actors.length} />
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
            <NavRow label="New actor" glyph="+" isOn={!isSystemActive && showNewActor} onClick={onNewActor} faint />

            <NavRow label="Substrate Settings" glyph="⚙" isOn={isSystemActive} onClick={onViewSystem} />
          </>
        )}
      </div>
    </aside>
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
