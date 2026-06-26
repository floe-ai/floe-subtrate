import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEnvApiKey, getModels, getProviders, type Model } from "@earendil-works/pi-ai/compat";
import {
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderId
} from "@earendil-works/pi-ai/oauth";
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

export type AuthProfile = z.infer<typeof ProfileSchema>;
export type ProfilesDocument = z.infer<typeof ProfilesDocumentSchema>;

type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredential;
type AuthStorageData = Record<string, AuthCredential>;

export type AuthStatus = {
  configured: boolean;
  source?: "stored" | "environment" | "models_json_key" | "models_json_command";
  label?: string;
};

export type FloeAuthPaths = {
  authDir: string;
  authJsonPath: string;
  modelsJsonPath: string;
  profilesYamlPath: string;
};

export type AuthRuntime = {
  paths: FloeAuthPaths;
  authStorage: FloeAuthStorage;
  modelRegistry: FloeModelRegistry;
  profiles: ProfilesDocument;
  profilesLoadError?: string;
};

export type ProviderOption = {
  id: string;
  name: string;
  auth_type: "oauth" | "api_key";
};

const DEFAULT_PROFILES: ProfilesDocument = {
  version: 1,
  profiles: []
};

const DEFAULT_MODELS_CONFIG = {
  providers: {}
};

export class FloeAuthStorage {
  private data: AuthStorageData = {};
  private errors: Error[] = [];

  constructor(private readonly authPath: string) {
    this.reload();
  }

  reload(): void {
    try {
      const raw = readFileSync(this.authPath, "utf8");
      this.data = JSON.parse(raw) as AuthStorageData;
    } catch {
      this.data = {};
    }
  }

  get(provider: string): AuthCredential | undefined {
    return this.data[provider];
  }

  set(provider: string, credential: AuthCredential): void {
    this.data[provider] = credential;
    this.save();
  }

  remove(provider: string): void {
    delete this.data[provider];
    this.save();
  }

  logout(provider: string): void {
    this.remove(provider);
  }

  list(): string[] {
    return Object.keys(this.data).sort();
  }

  getOAuthProviders() {
    return getOAuthProviders();
  }

  async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
    const provider = getOAuthProvider(providerId);
    if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
    const credentials = await provider.login(callbacks);
    this.set(providerId, { type: "oauth", ...credentials });
  }

  async getApiKey(provider: string): Promise<string | undefined> {
    const credential = this.data[provider];
    if (credential?.type === "api_key") {
      return credential.key.trim();
    }
    if (credential?.type === "oauth") {
      try {
        const oauthCredentials = this.getOAuthCredentials();
        const refreshed = await getOAuthApiKey(provider, oauthCredentials);
        if (!refreshed) return undefined;
        this.data[provider] = {
          type: "oauth",
          ...refreshed.newCredentials
        };
        this.save();
        return refreshed.apiKey;
      } catch (error) {
        this.errors.push(error instanceof Error ? error : new Error(String(error)));
        return undefined;
      }
    }
    return getEnvApiKey(provider);
  }

  getAuthStatus(provider: string): AuthStatus {
    if (this.data[provider]) return { configured: true, source: "stored" };
    const envKey = getEnvApiKey(provider);
    if (envKey) return { configured: true, source: "environment", label: "environment" };
    return { configured: false };
  }

  drainErrors(): Error[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  private getOAuthCredentials(): Record<string, OAuthCredentials> {
    const result: Record<string, OAuthCredentials> = {};
    for (const [provider, credential] of Object.entries(this.data)) {
      if (credential.type === "oauth") result[provider] = credential;
    }
    return result;
  }

  private save(): void {
    writeFileSync(this.authPath, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    chmodSafe(this.authPath, 0o600);
  }
}

export class FloeModelRegistry {
  private models: Model<any>[] = [];
  private providerApiKeys = new Map<string, string>();
  private loadError?: string;

  constructor(
    private readonly authStorage: FloeAuthStorage,
    private readonly modelsPath: string
  ) {
    this.refresh();
  }

  refresh(): void {
    this.providerApiKeys.clear();
    this.loadError = undefined;
    const builtInProviders = getProviders();
    const builtInModels = builtInProviders.flatMap((provider) => getModels(provider as any)) as Model<any>[];
    this.models = [...builtInModels];

    try {
      const raw = readFileSync(this.modelsPath, "utf8");
      const parsed = ModelsConfigSchema.parse(JSON.parse(raw));
      for (const [provider, config] of Object.entries(parsed.providers)) {
        if (typeof config.apiKey === "string" && config.apiKey.trim().length > 0) {
          this.providerApiKeys.set(provider, config.apiKey.trim());
        }
        for (const modelDef of config.models ?? []) {
          const existingIndex = this.models.findIndex((model) => model.provider === provider && model.id === modelDef.id);
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
          if (existingIndex >= 0) this.models[existingIndex] = custom;
          else this.models.push(custom);
        }
      }
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  getError(): string | undefined {
    return this.loadError;
  }

  getAll(): Model<any>[] {
    return this.models;
  }

  find(provider: string, modelId: string): Model<any> | undefined {
    return this.models.find((model) => model.provider === provider && model.id === modelId);
  }

  getProviderAuthStatus(provider: string): AuthStatus {
    const stored = this.authStorage.getAuthStatus(provider);
    if (stored.configured) return stored;
    const value = this.providerApiKeys.get(provider);
    if (!value) return stored;
    return {
      configured: true,
      source: value.startsWith("!") ? "models_json_command" : "models_json_key"
    };
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    const stored = await this.authStorage.getApiKey(provider);
    if (stored) return stored;
    const configured = this.providerApiKeys.get(provider);
    if (!configured) return undefined;
    return resolveConfiguredValue(configured);
  }
}

export function getFloeAuthPaths(configPath: string, config: LocalConfig): FloeAuthPaths {
  const homeDir = resolveLocalPath(configPath, config.home, ".");
  const authDir = join(homeDir, "auth");
  return {
    authDir,
    authJsonPath: join(authDir, "auth.json"),
    modelsJsonPath: join(authDir, "models.json"),
    profilesYamlPath: join(authDir, "profiles.yaml")
  };
}

export function createAuthRuntime(configPath: string, config: LocalConfig): AuthRuntime {
  const paths = getFloeAuthPaths(configPath, config);
  ensureAuthFiles(paths);
  const authStorage = new FloeAuthStorage(paths.authJsonPath);
  const modelRegistry = new FloeModelRegistry(authStorage, paths.modelsJsonPath);
  const loaded = loadProfiles(paths.profilesYamlPath);
  return {
    paths,
    authStorage,
    modelRegistry,
    profiles: loaded.profiles,
    profilesLoadError: loaded.error
  };
}

export function saveProfiles(path: string, profiles: ProfilesDocument): void {
  writeFileSync(path, YAML.stringify(profiles), "utf8");
  chmodSafe(path, 0o600);
}

export function findProfile(profiles: ProfilesDocument, id: string): AuthProfile | undefined {
  return profiles.profiles.find((profile) => profile.id === id);
}

export function upsertProfile(profiles: ProfilesDocument, next: AuthProfile): ProfilesDocument {
  const now = new Date().toISOString();
  const existing = profiles.profiles.find((profile) => profile.id === next.id);
  if (existing) {
    existing.provider = next.provider;
    existing.model = next.model;
    existing.label = next.label;
    existing.updated_at = now;
    return profiles;
  }
  profiles.profiles.push({
    ...next,
    created_at: now,
    updated_at: now
  });
  profiles.profiles.sort((a, b) => a.id.localeCompare(b.id));
  return profiles;
}

export function removeProfile(profiles: ProfilesDocument, id: string): AuthProfile | undefined {
  const index = profiles.profiles.findIndex((profile) => profile.id === id);
  if (index < 0) return undefined;
  const removed = profiles.profiles[index];
  profiles.profiles.splice(index, 1);
  return removed;
}

export function listProviderOptions(runtime: AuthRuntime): ProviderOption[] {
  const options: ProviderOption[] = [];
  const oauthProviders = runtime.authStorage.getOAuthProviders();
  const oauthById = new Map(oauthProviders.map((provider) => [provider.id, provider]));
  for (const provider of oauthProviders) {
    options.push({
      id: provider.id,
      name: provider.name,
      auth_type: "oauth"
    });
  }
  const providerIds = new Set(runtime.modelRegistry.getAll().map((model) => model.provider));
  for (const providerId of providerIds) {
    if (oauthById.has(providerId)) continue;
    options.push({
      id: providerId,
      name: providerId,
      auth_type: "api_key"
    });
  }
  options.sort((a, b) => a.name.localeCompare(b.name));
  return options;
}

export function suggestProfileId(profiles: ProfilesDocument, provider: string): string {
  const base = `${slug(provider)}-personal`;
  if (!profiles.profiles.some((profile) => profile.id === base)) return base;
  let i = 2;
  while (profiles.profiles.some((profile) => profile.id === `${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

export function validateProfileId(value: string): string {
  const normalized = slug(value);
  if (!normalized) throw new Error("Profile id must include letters or numbers.");
  return normalized;
}

export function getAuthStatusLabel(status: AuthStatus): string {
  switch (status.source) {
    case "stored":
      return "stored";
    case "environment":
      return status.label ?? "environment";
    case "models_json_key":
      return "models.json key";
    case "models_json_command":
      return "models.json command";
    default:
      return "missing";
  }
}

function ensureAuthFiles(paths: FloeAuthPaths): void {
  mkdirSync(paths.authDir, { recursive: true, mode: 0o700 });
  chmodSafe(paths.authDir, 0o700);
  if (!existsSync(paths.authJsonPath)) {
    writeFileSync(paths.authJsonPath, "{}\n", "utf8");
  }
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

function loadProfiles(path: string): { profiles: ProfilesDocument; error?: string } {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = raw.trim() ? YAML.parse(raw) : DEFAULT_PROFILES;
    return { profiles: ProfilesDocumentSchema.parse(parsed) };
  } catch (error) {
    return {
      profiles: { ...DEFAULT_PROFILES, profiles: [] },
      error: error instanceof Error ? error.message : String(error)
    };
  }
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

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function chmodSafe(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort only; Windows and some filesystems do not support POSIX modes.
  }
}
