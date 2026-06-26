import React, { useState, useEffect } from "react";
import type { AuthProfileRecord } from "../../bus-client/types.ts";
import { tk } from "../../theme.ts";

type ActiveTab = "auth" | "models" | "mcp" | "workspaces" | "diagnostics";

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export function SubstrateSettingsView(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<ActiveTab>("auth");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: tk.canvas }}>
      {/* Spacious Hero Header */}
      <header style={{
        flex: "0 0 auto",
        padding: "24px 32px 16px",
        borderBottom: `1px solid ${tk.border}`,
        background: "rgba(15,16,17,0.3)",
      }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{
            fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase",
            color: tk.ink3, fontWeight: 510, marginBottom: 2,
          }}>
            Global System (Tauri-Native)
          </div>
          <h1 style={{
            fontWeight: 510, fontSize: 24, lineHeight: 1.1,
            letterSpacing: "-0.02em", color: tk.ink, margin: "0 0 6px",
          }}>
            Substrate Settings
          </h1>
          <p style={{ color: tk.ink3, fontSize: 13, margin: 0 }}>
            Configure global daemon services, model definitions, and API authentication credentials natively from your host.
          </p>
        </div>
      </header>

      {/* Main Container Split layout: Settings Nav + Inner Content */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" }}>
        {/* Left Settings Tabs */}
        <nav style={{
          width: 200,
          flexShrink: 0,
          borderRight: `1px solid ${tk.border}`,
          background: "rgba(15,16,17,0.15)",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}>
          <TabButton id="auth" label="🔑 Authentication" active={activeTab === "auth"} onClick={() => setActiveTab("auth")} />
          <TabButton id="models" label="🤖 Model Registry" active={activeTab === "models"} onClick={() => setActiveTab("models")} isStub />
          <TabButton id="mcp" label="🔌 MCP Manager" active={activeTab === "mcp"} onClick={() => setActiveTab("mcp")} isStub />
          <TabButton id="workspaces" label="📁 Workspace Catalog" active={activeTab === "workspaces"} onClick={() => setActiveTab("workspaces")} isStub />
          <TabButton id="diagnostics" label="⚡ Diagnostics" active={activeTab === "diagnostics"} onClick={() => setActiveTab("diagnostics")} isStub />
        </nav>

        {/* Right Settings Content */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 32px 48px" }}>
          {activeTab === "auth" ? (
            <AuthenticationPillar />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyItems: "center", padding: 40, color: tk.ink3, textAlign: "center" }}>
              <span style={{ fontSize: 28, marginBottom: 12 }}>⚡</span>
              <h3 style={{ fontSize: 15, fontWeight: 510, color: tk.ink, margin: "0 0 4px" }}>Pillar Coming Soon</h3>
              <p style={{ fontSize: 12.5, color: tk.ink4, margin: 0, maxWidth: "36ch" }}>
                This Substrate settings module is scheduled for development in a subsequent phase.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar Tab Button Helper
// ---------------------------------------------------------------------------

type TabButtonProps = {
  id: ActiveTab;
  label: string;
  active: boolean;
  onClick: () => void;
  isStub?: boolean;
};

function TabButton({ id, label, active, onClick, isStub }: TabButtonProps): React.ReactElement {
  const [hov, setHov] = useState(false);

  return (
    <button
      onClick={isStub ? undefined : onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", alignItems: "center",
        width: "100%", padding: "6px 10px", borderRadius: tk.r2,
        border: "none",
        background: active ? "rgba(255,255,255,0.05)" : hov && !isStub ? "rgba(255,255,255,0.02)" : "transparent",
        color: active ? tk.accent : isStub ? tk.ink4 : tk.ink2,
        fontSize: 12.5, cursor: isStub ? "not-allowed" : "pointer",
        fontWeight: active ? 510 : 400,
        textAlign: "left",
        opacity: isStub ? 0.5 : 1,
        transition: "background 100ms ease, color 100ms ease",
      }}
      title={isStub ? `${label} (Coming Soon)` : label}
    >
      <span>{label}</span>
      {isStub && (
        <span style={{ marginLeft: "auto", fontSize: 9, color: tk.ink4, background: "rgba(255,255,255,0.03)", padding: "1px 4px", borderRadius: 3 }}>
          Soon
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Authentication & Credentials Pillar — Tauri Native
// ---------------------------------------------------------------------------

function AuthenticationPillar(): React.ReactElement {
  const [profiles, setProfiles] = useState<AuthProfileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [newId, setNewId] = useState("");
  const [newProvider, setNewProvider] = useState("openai");
  const [newModel, setNewModel] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveState] = useState<string | null>(null);

  // Delete State
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");

  const loadProfiles = () => {
    setLoading(true);
    invokeTauri<{ profiles: AuthProfileRecord[]; default_auth_profile: string | null }>("get_substrate_auth_profiles")
      .then((res) => {
        setProfiles(res.profiles);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  };

  useEffect(() => {
    loadProfiles();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = newId.trim().toLowerCase();
    const provider = newProvider.trim();
    const model = newModel.trim();
    const apiKey = newApiKey.trim();

    if (!id || !provider) return;
    setSaving(true);
    setSaveState(null);

    try {
      await invokeTauri<void>("save_substrate_auth_profile", {
        profile: {
          id,
          provider,
          model: model || null,
          label: null,
        },
        apiKey: apiKey || null,
      });
      setShowAddForm(false);
      setNewId("");
      setNewModel("");
      setNewApiKey("");
      loadProfiles();
    } catch (err) {
      setSaveState(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (deleteConfirmInput !== id) return;
    try {
      await invokeTauri<void>("delete_substrate_auth_profile", { profileId: id });
      setDeletingId(null);
      setDeleteConfirmInput("");
      loadProfiles();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ maxWidth: 800, display: "flex", flexDirection: "column", gap: 28 }}>
      {/* Intro */}
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 510, color: tk.ink, margin: "0 0 6px" }}>Authentication Profiles (Tauri-Native)</h2>
        <p style={{ fontSize: 13, color: tk.ink3, margin: 0, lineHeight: 1.5 }}>
          Create and manage host credentials and API profiles. This desktop app writes natively and securely directly to your machine's YAML/JSON configurations, bypass-routing the daemon entirely for maximum security.
        </p>
      </section>

      {/* Profiles list */}
      <section style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${tk.border2}`, display: "flex", alignItems: "center" }}>
          <h3 style={{ fontSize: 13, fontWeight: 510, margin: 0, color: tk.ink }}>Registered Profiles</h3>
          {!showAddForm && (
            <button
              onClick={() => setShowAddForm(true)}
              style={{
                marginLeft: "auto", background: tk.accent, color: "#0c1714", border: "none",
                borderRadius: tk.r2, padding: "5px 12px", fontSize: 11.5, fontWeight: 510,
                cursor: "pointer",
              }}
            >
              + Add Profile
            </button>
          )}
        </div>

        {loading ? (
          <div style={{ padding: 24, textAlign: "center", color: tk.ink3 }}>Loading profiles…</div>
        ) : error ? (
          <div role="alert" style={{ padding: 24, color: tk.danger }}>{error}</div>
        ) : profiles.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: tk.ink4, fontStyle: "italic" }}>
            No auth profiles configured. Click "+ Add Profile" to register API credentials.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {profiles.map((p) => (
              <div
                key={p.id}
                style={{
                  display: "flex", alignItems: "center", padding: "14px 20px",
                  borderBottom: `1px solid ${tk.border2}`, gap: 16,
                }}
              >
                <div>
                  <code style={{ fontSize: 13, fontWeight: 550, color: tk.ink }}>{p.id}</code>
                  <span style={{ fontSize: 11, color: tk.ink4, marginLeft: 12 }}>Provider:</span>
                  <span style={{ fontSize: 12, color: tk.ink2, marginLeft: 4, textTransform: "capitalize" }}>{p.provider}</span>
                  {p.model && (
                    <>
                      <span style={{ fontSize: 11, color: tk.ink4, marginLeft: 12 }}>Default Model:</span>
                      <code style={{ fontSize: 11, color: tk.accentHov, marginLeft: 4 }}>{p.model}</code>
                    </>
                  )}
                </div>

                {deletingId === p.id ? (
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: tk.danger }}>Type "{p.id}" to delete:</span>
                    <input
                      aria-label="Confirm profile ID"
                      placeholder={p.id}
                      value={deleteConfirmInput}
                      onChange={(e) => setDeleteConfirmInput(e.target.value)}
                      style={{
                        background: "rgba(255,255,255,0.03)", border: `1px solid ${tk.danger}`,
                        borderRadius: tk.r1, padding: "3px 6px", fontSize: 11, color: tk.ink, outline: "none",
                        width: 100,
                      }}
                    />
                    <button
                      onClick={() => void handleDelete(p.id)}
                      disabled={deleteConfirmInput !== p.id}
                      style={{
                        background: deleteConfirmInput === p.id ? tk.danger : "rgba(184,90,90,0.3)",
                        color: "#fff", border: "none", borderRadius: tk.r1, padding: "4px 8px", fontSize: 11,
                        cursor: deleteConfirmInput === p.id ? "pointer" : "not-allowed",
                      }}
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => { setDeletingId(null); setDeleteConfirmInput(""); }}
                      style={{
                        background: "transparent", border: `1px solid ${tk.border}`,
                        color: tk.ink3, borderRadius: tk.r1, padding: "3px 8px", fontSize: 11, cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeletingId(p.id)}
                    style={{
                      marginLeft: "auto", background: "transparent", border: `1px solid ${tk.border}`,
                      color: tk.ink3, borderRadius: tk.r2, padding: "4px 10px", fontSize: 11,
                      cursor: "pointer", transition: "background 100ms ease, color 100ms ease",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = tk.danger; (e.currentTarget as HTMLButtonElement).style.color = tk.danger; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = tk.border; (e.currentTarget as HTMLButtonElement).style.color = tk.ink3; }}
                  >
                    ✕ Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Add form */}
      {showAddForm && (
        <form
          onSubmit={handleSave}
          style={{
            background: tk.surface, border: `1px solid ${tk.accent}`, borderRadius: tk.r3,
            padding: 20, display: "flex", flexDirection: "column", gap: 14,
          }}
        >
          <h3 style={{ fontSize: 13, fontWeight: 510, margin: "0 0 4px", color: tk.accent }}>Add Authentication Profile</h3>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: tk.ink3 }}>
              Profile ID (unique, lowercase)
              <input
                required
                autoFocus
                placeholder="openai-personal"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                style={inputStyle}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: tk.ink3 }}>
              Provider
              <select
                value={newProvider}
                onChange={(e) => setNewProvider(e.target.value)}
                style={selectStyle}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google Gemini</option>
                <option value="github-copilot">GitHub Copilot</option>
                <option value="cohere">Cohere</option>
                <option value="custom">Custom (Ollama / Local)</option>
              </select>
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: tk.ink3 }}>
              Default Model (optional)
              <input
                placeholder="gpt-4o"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                style={inputStyle}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: tk.ink3 }}>
              API Key / Auth Token (securely stored in auth.json)
              <input
                type="password"
                placeholder="••••••••••••••••"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                style={inputStyle}
              />
            </label>
          </div>

          {saveError && <p role="alert" style={{ color: tk.danger, fontSize: 12, margin: 0 }}>{saveError}</p>}

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button
              type="submit"
              disabled={saving}
              style={{
                background: tk.accent, color: "#0c1714", border: "none",
                borderRadius: tk.r2, padding: "6px 14px", fontSize: 12, fontWeight: 510,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              {saving ? "Registering…" : "Register Profile"}
            </button>
            <button
              type="button"
              onClick={() => { setShowAddForm(false); setSaveState(null); }}
              style={{
                background: "transparent", border: `1px solid ${tk.border}`,
                color: tk.ink3, borderRadius: tk.r2, padding: "6px 14px", fontSize: 12,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: `1px solid ${tk.border}`,
  borderRadius: tk.r2,
  padding: "7px 10px",
  fontSize: 13,
  color: tk.ink,
  outline: "none",
};

const selectStyle: React.CSSProperties = { ...inputStyle };
