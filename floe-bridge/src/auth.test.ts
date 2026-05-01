import { describe, expect, it } from "vitest";
import { resolveRuntimeAuth, RuntimeAuthError } from "./auth.js";
import type { BridgeAuthRuntime } from "./auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(provider: string, modelId: string) {
  return {
    id: modelId,
    name: modelId,
    api: "openai-responses" as const,
    provider,
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096
  };
}

function makeAuthRuntime(
  profiles: Array<{ id: string; provider: string; model?: string }>,
  apiKeysByProvider: Record<string, string>,
  modelsByProviderAndId: Record<string, Record<string, ReturnType<typeof makeModel>>>
): BridgeAuthRuntime {
  return {
    paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
    authStorage: {} as any,
    modelRegistry: {
      find(provider: string, modelId: string) {
        return modelsByProviderAndId[provider]?.[modelId];
      },
      async getApiKeyForProvider(provider: string) {
        return apiKeysByProvider[provider];
      }
    } as any,
    profiles: {
      version: 1,
      profiles
    }
  } as BridgeAuthRuntime;
}

const copilotProfile = { id: "copilot-atvi", provider: "github-copilot", model: "copilot-model-1" };
const codexProfile = { id: "codex-default", provider: "openai-codex", model: "gpt-5.4-mini" };

const copilotModel = makeModel("github-copilot", "copilot-model-1");
const codexModel = makeModel("openai-codex", "gpt-5.4-mini");

const authRuntime = makeAuthRuntime(
  [copilotProfile, codexProfile],
  { "github-copilot": "ghp_fake", "openai-codex": "sk_fake" },
  {
    "github-copilot": { "copilot-model-1": copilotModel },
    "openai-codex": { "gpt-5.4-mini": codexModel }
  }
);

// ---------------------------------------------------------------------------
// Issue 1 tests
// ---------------------------------------------------------------------------

describe("resolveRuntimeAuth – provider/profile coherence (Issue 1)", () => {
  it("resolves coherently when workspace binding provides copilot-atvi profile (no project provider)", async () => {
    // Simulates: no project provider/model, local workspace binding selected copilot-atvi
    const result = await resolveRuntimeAuth(authRuntime, {
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("copilot-model-1");
    expect(result.authProfileId).toBe("copilot-atvi");
    expect(result.apiKey).toBe("ghp_fake");
  });

  it("resolves coherently when agent binding provides copilot-atvi profile (no project provider)", async () => {
    // Simulates: no project provider/model, agent-level binding selected copilot-atvi
    const result = await resolveRuntimeAuth(authRuntime, {
      auth_profile: "copilot-atvi",
      auth_profile_source: "agent_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("copilot-model-1");
    expect(result.authProfileId).toBe("copilot-atvi");
  });

  it("local binding wins: project openai-codex provider does NOT leak when workspace binding is copilot-atvi", async () => {
    // Simulates the reported bug: project file has provider=openai-codex, but workspace binding selected copilot-atvi
    const result = await resolveRuntimeAuth(authRuntime, {
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding"
    });

    // Local binding wins: provider must come from the copilot-atvi profile
    expect(result.provider).toBe("github-copilot");
    expect(result.provider).not.toBe("openai-codex");
    // Incompatible project model is stripped; profile model is used
    expect(result.modelId).toBe("copilot-model-1");
    expect(result.authProfileId).toBe("copilot-atvi");
    expect(result.apiKey).toBe("ghp_fake");
  });

  it("local binding wins: agent override copilot-atvi overrides project openai-codex", async () => {
    const result = await resolveRuntimeAuth(authRuntime, {
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      auth_profile: "copilot-atvi",
      auth_profile_source: "agent_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.provider).not.toBe("openai-codex");
    expect(result.authProfileId).toBe("copilot-atvi");
  });

  it("project runtime with provider matching profile resolves correctly with no local binding", async () => {
    // Project declares openai-codex and selects codex-default profile — compatible
    const result = await resolveRuntimeAuth(authRuntime, {
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      auth_profile: "codex-default",
      auth_profile_source: "project_runtime"
    });

    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-5.4-mini");
    expect(result.authProfileId).toBe("codex-default");
  });

  it("surfaces runtime_profile_provider_mismatch when project provider conflicts with profile provider (no local binding)", async () => {
    // Project explicitly declares openai-codex provider AND copilot-atvi profile (different provider) — error case
    await expect(
      resolveRuntimeAuth(authRuntime, {
        provider: "openai-codex",
        auth_profile: "copilot-atvi"
        // auth_profile_source absent → not a local binding
      })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof RuntimeAuthError && e.code === "runtime_profile_provider_mismatch";
    });
  });

  it("throws runtime_profile_required when no auth_profile is configured at all", async () => {
    await expect(
      resolveRuntimeAuth(authRuntime, { provider: "github-copilot" })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof RuntimeAuthError && e.code === "runtime_profile_required";
    });
  });

  it("throws runtime_profile_required for an unknown profile id", async () => {
    await expect(
      resolveRuntimeAuth(authRuntime, { auth_profile: "nonexistent-profile" })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof RuntimeAuthError && e.code === "runtime_profile_required";
    });
  });

  it("resolved provider comes from profile when project runtime is provider-neutral (engine-only)", async () => {
    // Fresh default agent: runtime: { engine: pi } only — no provider/model in project file
    const result = await resolveRuntimeAuth(authRuntime, {
      // provider: undefined, model: undefined — provider-neutral project
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("copilot-model-1");
  });

  it("configured_by_pi_ai placeholder provider is treated as absent and profile provider wins", async () => {
    const result = await resolveRuntimeAuth(authRuntime, {
      provider: "configured_by_pi_ai",
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding"
    });

    expect(result.provider).toBe("github-copilot");
  });
});

// ---------------------------------------------------------------------------
// Model selection tests
// ---------------------------------------------------------------------------

describe("resolveRuntimeAuth – model selection (model discovery)", () => {
  const copilotWithoutDefaultModel = { id: "copilot-atvi", provider: "github-copilot" };
  const claudeModel = makeModel("github-copilot", "claude-sonnet-4.6");
  const haiku = makeModel("github-copilot", "claude-haiku-4.5");

  const runtimeNoProfileModel = makeAuthRuntime(
    [copilotWithoutDefaultModel],
    { "github-copilot": "ghp_fake" },
    { "github-copilot": { "claude-sonnet-4.6": claudeModel, "claude-haiku-4.5": haiku } }
  );

  it("throws runtime_model_required when auth profile has no model and binding provides no model", async () => {
    await expect(
      resolveRuntimeAuth(runtimeNoProfileModel, {
        auth_profile: "copilot-atvi",
        auth_profile_source: "workspace_binding"
        // model: undefined — nothing selected
      })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof RuntimeAuthError && e.code === "runtime_model_required";
    });
  });

  it("binding model resolves correctly when workspace binding specifies model", async () => {
    const result = await resolveRuntimeAuth(runtimeNoProfileModel, {
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding",
      model: "claude-sonnet-4.6",
      model_source: "workspace_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("claude-sonnet-4.6");
    expect(result.model.id).toBe("claude-sonnet-4.6");
    expect(result.apiKey).toBe("ghp_fake");
  });

  it("binding model resolves correctly when agent binding specifies model", async () => {
    const result = await resolveRuntimeAuth(runtimeNoProfileModel, {
      auth_profile: "copilot-atvi",
      auth_profile_source: "agent_binding",
      model: "claude-haiku-4.5",
      model_source: "agent_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("claude-haiku-4.5");
  });

  it("binding model takes priority over profile model", async () => {
    const runtimeWithProfileModel = makeAuthRuntime(
      [{ id: "copilot-atvi", provider: "github-copilot", model: "claude-haiku-4.5" }],
      { "github-copilot": "ghp_fake" },
      { "github-copilot": { "claude-sonnet-4.6": claudeModel, "claude-haiku-4.5": haiku } }
    );

    const result = await resolveRuntimeAuth(runtimeWithProfileModel, {
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding",
      model: "claude-sonnet-4.6",  // binding explicitly selects sonnet
      model_source: "workspace_binding"
    });

    expect(result.modelId).toBe("claude-sonnet-4.6");  // binding wins over profile's haiku
  });

  it("binding model is NOT stripped when project provider conflicts with profile provider", async () => {
    // User selected copilot-atvi profile (github-copilot) AND explicitly chose a model via the binding.
    // Even though the project file declared openai-codex, the binding model must be preserved.
    const result = await resolveRuntimeAuth(runtimeNoProfileModel, {
      provider: "openai-codex",  // project-declared provider (conflicts)
      auth_profile: "copilot-atvi",
      auth_profile_source: "workspace_binding",
      model: "claude-sonnet-4.6",  // explicitly selected via UI
      model_source: "workspace_binding"
    });

    expect(result.provider).toBe("github-copilot");
    expect(result.modelId).toBe("claude-sonnet-4.6");  // NOT stripped
  });

  it("throws runtime_model_unknown for a model id not in the registry", async () => {
    await expect(
      resolveRuntimeAuth(runtimeNoProfileModel, {
        auth_profile: "copilot-atvi",
        auth_profile_source: "workspace_binding",
        model: "nonexistent-model-xyz",
        model_source: "workspace_binding"
      })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof RuntimeAuthError && e.code === "runtime_model_unknown";
    });
  });
});
