import React, { useState, useEffect, useRef } from "react";
import type { WorkspaceRef } from "../bus-client/types.ts";
import { registerWorkspace, listWorkspaces, DirectoryNotFoundError } from "../bus-client/client.ts";
import { FolderPicker } from "./FolderPicker.tsx";
import { tk } from "../theme.ts";

export type WsSwitcherProps = {
  workspaces: WorkspaceRef[];
  active: WorkspaceRef;
  onSwitch: (id: string) => void;
  onAdd: (locator: string, name: string, create_directory?: boolean) => Promise<void>;
  addErr: string | null;
};

export function WorkspaceSwitcher({
  workspaces, active, onSwitch, onAdd, addErr,
}: WsSwitcherProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [locator, setLocator] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowAdd(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  async function handleAdd() {
    if (!locator.trim()) return;
    setAdding(true);
    try {
      await onAdd(locator.trim(), name.trim());
      setLocator("");
      setName("");
      setShowAdd(false);
      setOpen(false);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => { setOpen(v => !v); setShowAdd(false); }}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          background: "transparent", border: `1px solid transparent`,
          padding: "4px 8px", borderRadius: tk.r2,
          fontFamily: tk.fontUi, fontWeight: 510, fontSize: 13,
          color: tk.ink, cursor: "pointer",
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)";
          (e.currentTarget as HTMLButtonElement).style.borderColor = tk.border;
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          (e.currentTarget as HTMLButtonElement).style.borderColor = "transparent";
        }}
        aria-label="Switch workspace"
        aria-expanded={open}
      >
        <span>{active.name || active.workspace_id}</span>
        <span style={{ color: tk.ink4, fontSize: 9 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0,
          minWidth: 260, background: tk.surfaceHov,
          border: `1px solid ${tk.border}`,
          borderRadius: tk.r3,
          boxShadow: "0 0 0 1px rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.6)",
          padding: 4, zIndex: 60,
        }}>
          {workspaces.map(ws => (
            <button
              key={ws.workspace_id}
              onClick={() => { onSwitch(ws.workspace_id); setOpen(false); }}
              style={{
                display: "grid", gridTemplateColumns: "18px 1fr auto",
                gap: 8, alignItems: "center",
                width: "100%", padding: "8px 10px", borderRadius: tk.r2,
                background: "transparent", border: "none",
                textAlign: "left", fontSize: 13, color: tk.ink, cursor: "pointer",
              }}
              onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.05)"}
              onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = "transparent"}
            >
              <span style={{ color: ws.workspace_id === active.workspace_id ? tk.accent : tk.ink4, fontSize: 11 }}>
                {ws.workspace_id === active.workspace_id ? "✓" : ""}
              </span>
              <span>{ws.name || ws.workspace_id}</span>
              <span style={{ color: tk.ink4, fontSize: 11, fontFamily: "monospace" }}>
                {ws.workspace_id.slice(0, 8)}
              </span>
            </button>
          ))}

          {/* Add workspace */}
          {!showAdd ? (
            <button
              onClick={() => setShowAdd(true)}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "8px 10px", borderRadius: tk.r2,
                background: "transparent", border: "none",
                textAlign: "left", fontSize: 13, color: tk.accentHov, cursor: "pointer",
              }}
              onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)"}
              onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = "transparent"}
            >
              <span style={{ width: 18, textAlign: "center", color: tk.accentHov }}>+</span>
              <span>Register workspace…</span>
            </button>
          ) : (
            <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
              <input
                autoFocus
                placeholder="Workspace path"
                value={locator}
                onChange={e => setLocator(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void handleAdd(); if (e.key === "Escape") setShowAdd(false); }}
                style={{
                  background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
                  borderRadius: tk.r2, padding: "5px 8px", fontSize: 12, color: tk.ink,
                }}
              />
              {!showPicker ? (
                <button
                  onClick={() => setShowPicker(true)}
                  style={{
                    alignSelf: "flex-start",
                    background: "transparent", border: `1px solid ${tk.border}`,
                    color: tk.accentHov, borderRadius: tk.r2, padding: "4px 10px", fontSize: 11.5,
                    cursor: "pointer",
                  }}
                >
                  Browse…
                </button>
              ) : (
                <FolderPicker
                  onSelect={(path) => { setLocator(path); setShowPicker(false); }}
                  onCancel={() => setShowPicker(false)}
                />
              )}
              <input
                placeholder="Name (optional)"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void handleAdd(); if (e.key === "Escape") setShowAdd(false); }}
                style={{
                  background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
                  borderRadius: tk.r2, padding: "5px 8px", fontSize: 12, color: tk.ink,
                }}
              />
              {addErr && <p style={{ color: tk.danger, fontSize: 11, margin: 0 }}>{addErr}</p>}
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => void handleAdd()}
                  disabled={adding || !locator.trim()}
                  style={{
                    background: tk.accent, color: "#0c1714", border: "none",
                    borderRadius: tk.r2, padding: "4px 10px", fontSize: 12, cursor: "pointer",
                  }}
                >
                  {adding ? "Registering…" : "Register"}
                </button>
                <button
                  onClick={() => setShowAdd(false)}
                  style={{
                    background: "transparent", border: `1px solid ${tk.border}`,
                    color: tk.ink3, borderRadius: tk.r2, padding: "4px 10px", fontSize: 12,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function RegisterWorkspaceScreen({
  onRegistered,
}: {
  onRegistered: (ws: WorkspaceRef) => void;
}): React.ReactElement {
  const [locator, setLocator] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  async function handleRegister() {
    if (!locator.trim()) return;
    setAdding(true);
    setErr(null);
    try {
      const ws = await registerWorkspace({ locator: locator.trim(), name: name.trim() || undefined, init_authorized: true });
      onRegistered(ws);
    } catch (e) {
      if (e instanceof DirectoryNotFoundError) {
        if (window.confirm(`Directory does not exist: ${locator.trim()}\nWould you like to create it?`)) {
          try {
            const ws = await registerWorkspace({ locator: locator.trim(), name: name.trim() || undefined, init_authorized: true, create_directory: true });
            onRegistered(ws);
            return;
          } catch (e2) {
             setErr(e2 instanceof Error ? e2.message : "Failed to register workspace");
          }
        } else {
          setErr(e.message);
        }
        return;
      }
      setErr(e instanceof Error ? e.message : "Failed to register workspace");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      height: "100vh", background: tk.canvas, color: tk.ink3,
      fontFamily: tk.fontUi, fontSize: 13,
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 340 }}>
        <p style={{ color: tk.ink3, marginBottom: 4 }}>No workspaces. Register one to get started.</p>
        <input
          autoFocus
          placeholder="Workspace path"
          value={locator}
          onChange={e => setLocator(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void handleRegister(); }}
          style={{
            background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
            borderRadius: tk.r2, padding: "7px 10px", fontSize: 13, color: tk.ink, outline: "none",
          }}
        />
        {!showPicker ? (
          <button
            onClick={() => setShowPicker(true)}
            style={{
              alignSelf: "flex-start",
              background: "transparent", border: `1px solid ${tk.border}`,
              color: tk.accentHov, borderRadius: tk.r2, padding: "5px 10px", fontSize: 12,
              cursor: "pointer",
            }}
          >
            Browse…
          </button>
        ) : (
          <FolderPicker
            onSelect={(path) => { setLocator(path); setShowPicker(false); }}
            onCancel={() => setShowPicker(false)}
          />
        )}
        <input
          placeholder="Name (optional)"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void handleRegister(); }}
          style={{
            background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
            borderRadius: tk.r2, padding: "7px 10px", fontSize: 13, color: tk.ink, outline: "none",
          }}
        />
        {err && <p style={{ color: tk.danger, fontSize: 12 }}>{err}</p>}
        <button
          onClick={() => void handleRegister()}
          disabled={adding || !locator.trim()}
          style={{
            background: tk.accent, color: "#0c1714", border: "none",
            borderRadius: tk.r2, padding: "7px 16px", fontSize: 13, cursor: "pointer", fontWeight: 510,
          }}
        >
          {adding ? "Registering…" : "Register workspace"}
        </button>
      </div>
    </div>
  );
}
