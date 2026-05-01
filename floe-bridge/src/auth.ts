import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEnvApiKey, getModels, getProviders, type Model } from "@mariozechner/pi-ai";
import { getOAuthApiKey, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import YAML from "yaml";
import { z } from "zod";
import type { LocalConfig } from "./config.js";
import { resolveLocalPath } from "./config.js";

const ProfileSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  created_at: z.string().min(1).optional(),
  updated_at: z.string().min(1).optional()
});

const ProfilesDocumentSchema = z.object({
  version: z.literal(1),
  profiles: z.array(ProfileSchema)
});

const ModelsConfigSchema = z.object({
  providers: z.record(z.string(), z.object({
    apiKey: z.string().optional(),
    models: z.array(z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      api: z.string().optional(),
      baseUrl: z.string().optional(),
      reasoning: z.boolean().optional(),
      input: z.array(z.enum(["text", "image"])).optional(),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number()
      }).optional(),
      contextWindow: z.number().optional(),
      maxTokens: z.number().optional()
    })).optional()
  }))
});

type AuthProfile = z.infer<typeof ProfileSchema>;
type ProfilesDocument = z.infer<typeof ProfilesDocumentSchema>;

type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredential;
type AuthStorageData = Record<string, AuthCredential>;

const DEFAULT_PROFILES: ProfilesDocument = {
  version: 1,
  profiles: []
};

const DEFAULT_MODELS_CONFIG = {
  providers: {}
};

export type FloeAuthPaths = {
  authDir: string;
  authJsonPath: string;
  modelsJsonPath: string;
  profilesYamlPath: string;
};

export type BridgeAuthRuntime = {
  paths: FloeAuthPaths;
  authStorage: BridgeAuthStorage;
  modelRegistry: BridgeModelRegistry;
  profiles: ProfilesDocument;
};

export type AgentRuntimeConfig = {
  provider?: string;
  model?: string;
  auth_profile?: string;
  /** Source of the auth_profile selection. "agent_binding" and "workspace_binding" indicate
   *  a local override; project-declared provider/model do not take precedence in that case. */
  auth_profile_source?: string;
  /** Source of the model selection. "agent_binding" and "workspace_binding" indicate the model
   *  was explicitly chosen by the user and must not be stripped when providers differ. */
  model_source?: string;
};

export type RuntimeAuthErrorCode =
  | "runtime_profile_required"
  | "provider_auth_missing"
  | "runtime_provider_required"
  | "runtime_model_required"
  | "runtime_model_unknown"
  | "runtime_profile_provider_mismatch";

export type RuntimeAuthResolved = {
  provider: string;
  model: Model<any>;
  modelId: string;
  apiKey: string;
  authProfileId: string | null;
  usedEnvFallback: boolean;
};

export class RuntimeAuthError extends Error {
  constructor(readonly code: RuntimeAuthErrorCode, message: string) {
    super(message);
    this.name = "RuntimeAuthError";
  }
}

class BridgeAuthStorage {
  private data: AuthStorageData = {};
  private errors: Error[] = [];

  constructor(private readonly authPath: string) {
    this.reload();
  }

  reload(): void {
    try {
      this.data = JSON.parse(readFileSync(this.authPath, "utf8")) as AuthStorageData;
    } catch {
      this.data = {};
    }
  }

  async getApiKey(provider: string): Promise<string | undefined> {
    const credential = this.data[provider];
    if (credential?.type === "api_key") return credential.key.trim();
    if (credential?.type === "oauth") {
      try {
        const oauthCredentials: Record<string, OAuthCredentials> = {};
        for (const [key, value] of Object.entries(this.data)) {
          if (value.type === "oauth") oauthCredentials[key] = value;
        }
        const refreshed = await getOAuthApiKey(provider, oauthCredentials);
        if (!refreshed) return undefined;
        this.data[provider] = { type: "oauth", ...refreshed.newCredentials };
        this.save();
        return refreshed.apiKey;
      } catch (error) {
        this.errors.push(error instanceof Error ? error : new Error(String(error)));
        return undefined;
      }
    }
    if (process.env.FLOE_ALLOW_ENV_AUTH_FALLBACK === "1") return getEnvApiKey(provider);
    return undefined;
  }

  drainErrors(): Error[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  private save(): void {
    writeFileSync(this.authPath, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    chmodSafe(this.authPath, 0o600);
  }
}

class BridgeModelRegistry {
  private models: Model<any>[] = [];
  private providerApiKeys = new Map<string, string>();

  constructor(
    private readonly authStorage: BridgeAuthStorage,
    private readonly modelsPath: string
  ) {
    this.refresh();
  }

  refresh(): void {
    this.providerApiKeys.clear();
    const builtIn = getProviders().flatMap((provider) => getModels(provider as any)) as Model<any>[];
    this.models = [...builtIn];
    try {
      const parsed = ModelsConfigSchema.parse(JSON.parse(readFileSync(this.modelsPath, "utf8")));
      for (const [provider, config] of Object.entries(parsed.providers)) {
        if (config.apiKey && config.apiKey.trim()) this.providerApiKeys.set(provider, config.apiKey.trim());
        for (const modelDef of config.models ?? []) {
          const fallback = this.models.find((model) => model.provider === provider);
          const custom: Model<any> = {
            id: modelDef.id,
            name: modelDef.name ?? modelDef.id,
            api: (modelDef.api ?? fallback?.api ?? "openai-responses") as any,
            provider,
            baseUrl: modelDef.baseUrl ?? fallback?.baseUrl ?? "",
            reasoning: modelDef.reasoning ?? false,
            input: modelDef.input ?? ["text"],
            cost: modelDef.cost ?? fallback?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: modelDef.contextWindow ?? fallback?.contextWindow ?? 128000,
            maxTokens: modelDef.maxTokens ?? fallback?.maxTokens ?? 16384,
            headers: fallback?.headers,
            compat: fallback?.compat
          };
          const index = this.models.findIndex((model) => model.provider === provider && model.id === modelDef.id);
          if (index >= 0) this.models[index] = custom;
          else this.models.push(custom);
        }
      }
    } catch {
      // Keep built-ins on invalid models.json
    }
  }

  getAll(): Model<any>[] {
    return this.models;
  }

  find(provider: string, modelId: string): Model<any> | undefined {
    return this.models.find((model) => model.provider === provider && model.id === modelId);
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    const stored = await this.authStorage.getApiKey(provider);
    if (stored) return stored;
    const configured = this.providerApiKeys.get(provider);
    if (!configured) return undefined;
    return resolveConfiguredValue(configured);
  }
}

export function createBridgeAuthRuntime(configPath: string, config: LocalConfig): BridgeAuthRuntime {
  const paths = getFloeAuthPaths(configPath, config);
  ensureAuthFiles(paths);
  const authStorage = new BridgeAuthStorage(paths.authJsonPath);
  const modelRegistry = new BridgeModelRegistry(authStorage, paths.modelsJsonPath);
  const profiles = loadProfiles(paths.profilesYamlPath);
  return {
    paths,
    authStorage,
    modelRegistry,
    profiles
  };
}

export async function resolveRuntimeAuth(
  runtime: BridgeAuthRuntime,
  runtimeConfig: AgentRuntimeConfig | undefined,
  options?: {
    defaultAuthProfile?: string;
  }
): Promise<RuntimeAuthResolved> {
  const profileId = cleanValue(runtimeConfig?.auth_profile) ?? cleanValue(options?.defaultAuthProfile);
  if (!profileId) {
    throw new RuntimeAuthError(
      "runtime_profile_required",
      "Runtime auth profile is required. Select an auth profile for this workspace or agent."
    );
  }
  const profile = resolveProfile(runtime.profiles, profileId);
  if (!profile) {
    throw new RuntimeAuthError(
      "runtime_profile_required",
      `Unknown auth profile '${profileId}'. Run 'floe auth list' or 'floe login --profile ${profileId}'.`
    );
  }

  const projectProvider = cleanValue(runtimeConfig?.provider);
  const profileProvider = cleanValue(profile.provider);
  const isLocalBinding =
    runtimeConfig?.auth_profile_source === "agent_binding" ||
    runtimeConfig?.auth_profile_source === "workspace_binding";

  let provider: string | undefined;
  let modelId = cleanValue(runtimeConfig?.model);
  let usedEnvFallback = false;

  if (isLocalBinding) {
    // A local (workspace/agent) binding was selected: the profile's provider takes precedence.
    // If the project declared a conflicting provider, its model is likely incompatible too, so strip it —
    // but only if the model itself also came from the project, not from a user-selected binding.
    const modelFromBinding =
      runtimeConfig?.model_source === "agent_binding" ||
      runtimeConfig?.model_source === "workspace_binding";
    if (!modelFromBinding && projectProvider && projectProvider !== "configured_by_pi_ai" && projectProvider !== profileProvider) {
      modelId = undefined;
    }
    provider = profileProvider;
    if (!modelId && profile?.model) modelId = cleanValue(profile.model);
  } else {
    // No local binding. If project and profile declare different providers, that is a configuration
    // conflict that cannot be resolved automatically.
    if (
      projectProvider &&
      projectProvider !== "configured_by_pi_ai" &&
      profileProvider &&
      projectProvider !== profileProvider
    ) {
      throw new RuntimeAuthError(
        "runtime_profile_provider_mismatch",
        `Project runtime declares provider '${projectProvider}' but auth profile '${profileId}' is for provider '${profileProvider}'. ` +
        `Update the project runtime block to match the selected profile, or select a compatible profile.`
      );
    }
    provider = projectProvider !== "configured_by_pi_ai" ? projectProvider : undefined;
    if (!provider && profileProvider) provider = profileProvider;
    if (!modelId && profile?.model) modelId = cleanValue(profile.model);
  }

  if (modelId && modelId.includes("/")) {
    const [qualifiedProvider, ...rest] = modelId.split("/");
    if (!provider && qualifiedProvider && rest.length > 0) {
      provider = qualifiedProvider;
      modelId = rest.join("/");
    }
  }

  if (!provider || provider === "configured_by_pi_ai") {
    provider = cleanValue(process.env.FLOE_PI_PROVIDER);
    usedEnvFallback = usedEnvFallback || !!provider;
  }
  if (!modelId) {
    modelId = cleanValue(process.env.FLOE_PI_MODEL);
    usedEnvFallback = usedEnvFallback || !!modelId;
  }

  if (!provider) {
    throw new RuntimeAuthError(
      "runtime_provider_required",
      "No runtime provider configured. Set runtime.provider or configure it in the selected auth profile."
    );
  }
  if (!modelId) {
    throw new RuntimeAuthError(
      "runtime_model_required",
      `No runtime model configured for provider '${provider}'. Set runtime.model or configure it in the selected auth profile.`
    );
  }

  let model = runtime.modelRegistry.find(provider, modelId);
  if (!model && modelId.includes("/")) {
    const [qualifiedProvider, ...rest] = modelId.split("/");
    if (qualifiedProvider === provider && rest.length > 0) {
      modelId = rest.join("/");
      model = runtime.modelRegistry.find(provider, modelId);
    }
  }
  if (!model) {
    throw new RuntimeAuthError(
      "runtime_model_unknown",
      `Model '${provider}/${modelId}' is not present in local model registry.`
    );
  }

  const apiKey = await runtime.modelRegistry.getApiKeyForProvider(provider);
  if (!apiKey) {
    const profileHint = profileId ? ` for profile '${profileId}'` : "";
    throw new RuntimeAuthError(
      "provider_auth_missing",
      `Missing provider auth for '${provider}'${profileHint}. Run 'floe login --provider ${provider}'.`
    );
  }

  return {
    provider,
    model,
    modelId,
    apiKey,
    authProfileId: profile?.id ?? null,
    usedEnvFallback
  };
}

function getFloeAuthPaths(configPath: string, config: LocalConfig): FloeAuthPaths {
  const homeDir = resolveLocalPath(configPath, config.home, ".");
  const authDir = join(homeDir, "auth");
  return {
    authDir,
    authJsonPath: join(authDir, "auth.json"),
    modelsJsonPath: join(authDir, "models.json"),
    profilesYamlPath: join(authDir, "profiles.yaml")
  };
}

function ensureAuthFiles(paths: FloeAuthPaths): void {
  mkdirSync(paths.authDir, { recursive: true, mode: 0o700 });
  chmodSafe(paths.authDir, 0o700);
  if (!existsSync(paths.authJsonPath)) writeFileSync(paths.authJsonPath, "{}\n", "utf8");
  chmodSafe(paths.authJsonPath, 0o600);
  if (!existsSync(paths.modelsJsonPath)) {
    writeFileSync(paths.modelsJsonPath, JSON.stringify(DEFAULT_MODELS_CONFIG, null, 2) + "\n", "utf8");
  }
  chmodSafe(paths.modelsJsonPath, 0o600);
  if (!existsSync(paths.profilesYamlPath)) {
    writeFileSync(paths.profilesYamlPath, YAML.stringify(DEFAULT_PROFILES), "utf8");
  }
  chmodSafe(paths.profilesYamlPath, 0o600);
}

function loadProfiles(path: string): ProfilesDocument {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = raw.trim() ? YAML.parse(raw) : DEFAULT_PROFILES;
    return ProfilesDocumentSchema.parse(parsed);
  } catch {
    return { ...DEFAULT_PROFILES, profiles: [] };
  }
}

function resolveProfile(profiles: ProfilesDocument, profileId?: string): AuthProfile | undefined {
  const id = cleanValue(profileId);
  if (!id) return undefined;
  return profiles.profiles.find((profile) => profile.id === id);
}

function resolveConfiguredValue(value: string): string | undefined {
  if (value.startsWith("!")) {
    const output = execSync(value.slice(1), { encoding: "utf8", windowsHide: true }).trim();
    return output.length > 0 ? output : undefined;
  }
  const envValue = process.env[value];
  if (envValue && envValue.trim().length > 0) return envValue.trim();
  return value.length > 0 ? value : undefined;
}

function cleanValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function chmodSafe(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only.
  }
}
