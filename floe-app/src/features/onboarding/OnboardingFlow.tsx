import React, { useState } from "react";
import type { WorkspaceRef } from "../../bus-client/types.ts";
import { ProviderAccess } from "../../providers/ProviderAccess.tsx";
import { CODEX_PROFILE_ID, preferredCodexModel, type CodexProviderStatus } from "../../providers/codexProvider.ts";
import { RegisterWorkspaceScreen } from "../../workspace/WorkspaceSwitcher.tsx";
import { tk } from "../../theme.ts";

type ReadySelection = {
  workspace: WorkspaceRef;
  profileId: string;
  model: string;
};

export function OnboardingFlow({
  workspaces,
  hasProvider,
  existingProfileId,
  existingModel,
  codexStatus,
  onReady,
}: {
  workspaces: WorkspaceRef[];
  hasProvider: boolean;
  existingProfileId?: string;
  existingModel?: string;
  codexStatus: CodexProviderStatus | null;
  onReady: (selection: ReadySelection) => Promise<void>;
}): React.ReactElement {
  const [step, setStep] = useState<"provider" | "workspace" | "finishing">(
    hasProvider ? "workspace" : "provider",
  );
  const [profileId, setProfileId] = useState(hasProvider ? existingProfileId || CODEX_PROFILE_ID : "");
  const [model, setModel] = useState(existingModel || (codexStatus ? preferredCodexModel(codexStatus) : ""));
  const [error, setError] = useState<string | null>(null);

  async function finish(workspace: WorkspaceRef, selection?: { profileId?: string; model?: string }) {
    setStep("finishing");
    setError(null);
    try {
      await onReady({
        workspace,
        profileId: selection?.profileId || profileId || CODEX_PROFILE_ID,
        model: selection?.model ?? model,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Floe could not finish setup");
      setStep("workspace");
    }
  }

  return (
    <div style={{ height: "100vh", background: tk.canvas, color: tk.ink, fontFamily: tk.fontUi, display: "flex", flexDirection: "column" }}>
      <header style={{ height: 58, display: "flex", alignItems: "center", padding: "0 22px", borderBottom: `1px solid ${tk.border}` }}>
        <span style={{ width: 28, height: 28, borderRadius: 8, background: tk.accent, color: "#0c1714", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 650 }}>F</span>
        <span style={{ marginLeft: 9, fontSize: 14, fontWeight: 560 }}>Floe</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, color: tk.ink4, fontSize: 11.5 }}>
          <Step label="Connect" active={step === "provider"} complete={step !== "provider"} />
          <span>→</span>
          <Step label="Workspace" active={step === "workspace"} complete={step === "finishing"} />
          <span>→</span>
          <Step label="Chat" active={step === "finishing"} complete={false} />
        </div>
      </header>

      {step === "provider" && (
        <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}>
          <div style={{ width: "min(680px, 100%)" }}>
            <div style={{ color: tk.accent, fontSize: 12, fontWeight: 590, marginBottom: 10 }}>Welcome to Floe</div>
            <h1 style={{ margin: "0 0 10px", color: tk.ink, fontSize: 34, lineHeight: 1.15, fontWeight: 520, letterSpacing: "-0.025em" }}>
              First, connect a model provider
            </h1>
            <p style={{ margin: "0 0 24px", color: tk.ink3, fontSize: 14, lineHeight: 1.55, maxWidth: 600 }}>
              Floe uses this connection across your workspaces. ChatGPT through OpenAI Codex is currently available; more providers can appear here without changing how you use Floe.
            </p>
            <ProviderAccess
              initialStatus={codexStatus}
              onReady={(status, selectedModel) => {
                setProfileId(CODEX_PROFILE_ID);
                setModel(selectedModel || preferredCodexModel(status));
                const existing = workspaces.find(workspace => workspace.selected_at !== null) ?? workspaces[0];
                if (existing) void finish(existing, { profileId: CODEX_PROFILE_ID, model: selectedModel || preferredCodexModel(status) });
                else setStep("workspace");
              }}
            />
          </div>
        </main>
      )}

      {step === "workspace" && (
        <>
          <RegisterWorkspaceScreen
            title="Choose where Floe should work"
            description="Open an existing folder or choose a new one. Floe keeps each workspace's work and defaults separate."
            submitLabel="Open workspace"
            embedded
            onRegistered={workspace => void finish(workspace)}
          />
          {error && <div role="alert" style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", color: tk.danger }}>{error}</div>}
        </>
      )}

      {step === "finishing" && (
        <main style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <span style={{ color: tk.ink, fontSize: 18 }}>Opening your workspace…</span>
          <span style={{ color: tk.ink3, fontSize: 13 }}>Floe is applying your model and preparing the conversation.</span>
        </main>
      )}
    </div>
  );
}

function Step({ label, active, complete }: { label: string; active: boolean; complete: boolean }): React.ReactElement {
  return <span style={{ color: active ? tk.ink : complete ? tk.accent : tk.ink4 }}>{complete ? "✓ " : ""}{label}</span>;
}
