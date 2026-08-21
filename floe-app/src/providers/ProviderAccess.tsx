import React, { useEffect, useState } from "react";
import { tk } from "../theme.ts";
import {
  connectCodexProvider,
  getCodexProviderStatus,
  preferredCodexModel,
  type CodexProviderStatus,
} from "./codexProvider.ts";

type ProviderAccessProps = {
  compact?: boolean;
  initialStatus?: CodexProviderStatus | null;
  onReady?: (status: CodexProviderStatus, model: string) => void;
};

export function ProviderAccess({ compact = false, initialStatus = null, onReady }: ProviderAccessProps): React.ReactElement {
  const [status, setStatus] = useState<CodexProviderStatus | null>(initialStatus);
  const [model, setModel] = useState(initialStatus ? preferredCodexModel(initialStatus) : "");
  const [loading, setLoading] = useState(initialStatus === null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialStatus) return;
    let cancelled = false;
    getCodexProviderStatus()
      .then(next => {
        if (cancelled) return;
        setStatus(next);
        setModel(preferredCodexModel(next));
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [initialStatus]);

  async function connect() {
    setConnecting(true);
    setError(null);
    try {
      const next = await connectCodexProvider(model || null);
      const selected = model || preferredCodexModel(next);
      setStatus(next);
      setModel(selected);
      onReady?.(next, selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  if (loading) {
    return <div style={{ color: tk.ink3, padding: compact ? 8 : 20 }}>Checking ChatGPT…</div>;
  }

  const unavailable = status && !status.available;
  const connected = status?.connected === true;

  return (
    <section style={{
      background: tk.surface,
      border: `1px solid ${connected ? "rgba(138,168,156,0.45)" : tk.border}`,
      borderRadius: tk.r3,
      padding: compact ? 16 : 20,
      maxWidth: 620,
    }} data-testid="codex-provider-card">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div style={{
          width: 38, height: 38, flex: "0 0 38px", borderRadius: 10,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(138,168,156,0.12)", color: tk.accent, fontWeight: 650,
        }}>C</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0, color: tk.ink, fontSize: 15, fontWeight: 560 }}>ChatGPT</h3>
            {connected && (
              <span style={{ color: tk.accent, fontSize: 11, padding: "2px 7px", borderRadius: 999, background: "rgba(138,168,156,0.12)" }}>
                Connected{status?.plan_type ? ` · ${status.plan_type}` : ""}
              </span>
            )}
          </div>
          <p style={{ margin: "5px 0 0", color: tk.ink3, fontSize: 12.5, lineHeight: 1.5 }}>
            Uses OpenAI Codex to sign in and run Floe with your ChatGPT subscription. OpenAI manages the login and credentials.
          </p>
        </div>
      </div>

      {!unavailable && status && status.models.length > 0 && (
        <label style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 16, color: tk.ink3, fontSize: 11.5 }}>
          Default model
          <select
            aria-label="ChatGPT default model"
            value={model}
            onChange={event => setModel(event.target.value)}
            disabled={connecting}
            style={{
              background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
              borderRadius: tk.r2, padding: "8px 10px", color: tk.ink, fontSize: 13,
            }}
          >
            {status.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      )}

      {unavailable && (
        <p role="alert" style={{ margin: "14px 0 0", color: tk.danger, fontSize: 12.5 }}>
          Codex is not available on this device. {status.error || "Install the official Codex application and try again."}
        </p>
      )}
      {error && <p role="alert" style={{ margin: "14px 0 0", color: tk.danger, fontSize: 12.5 }}>{error}</p>}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
        <button
          type="button"
          onClick={() => void connect()}
          disabled={connecting || unavailable === true}
          style={{
            border: "none", borderRadius: tk.r2, padding: "8px 14px",
            background: tk.accent, color: "#0c1714", fontWeight: 590, fontSize: 12.5,
            opacity: connecting || unavailable ? 0.55 : 1,
          }}
        >
          {connecting ? (connected ? "Saving…" : "Waiting for ChatGPT…") : connected ? "Use this account" : "Continue with ChatGPT"}
        </button>
        {connecting && !connected && <span style={{ color: tk.ink3, fontSize: 12 }}>Complete the sign-in in your browser.</span>}
      </div>
    </section>
  );
}
