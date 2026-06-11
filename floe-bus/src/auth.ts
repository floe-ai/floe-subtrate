/**
 * @invariant This module is the bus-local read model for Floe auth metadata.
 * It must merge pi-ai built-ins with local auth overlays from models.json and profiles.yaml
 * without exposing credentials, commands, or other secret-bearing auth state to the web.
 * Live model-list intersection (filtering retired pi catalog entries) is applied at list time
 * via live-model-probe. All failure modes are fail-open: a probe error never shrinks the list.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModels, getProviders, type Model } from "@mariozechner/pi-ai";
import { getOAuthApiKey } from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import YAML from "yaml";
import { z } from "zod";
import type { LocalConfig } from "./config.js";
import { resolveLocalPath } from "./config.js";
import { fetchLiveModelIds, intersectWithLive } from "./live-model-probe.js";
import type { FetchFn, ResolvedCredential } from "./live-model-probe.js";

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

const DEFAULT_PROFILES = {
  version: 1,
  profiles: []
} satisfies z.infer<typeof ProfilesDocumentSchema>;

const DEFAULT_MODELS_CONFIG = {
  providers: {}
} satisfies z.infer<typeof ModelsConfigSchema>;

export type AuthProfileRecord = z.infer<typeof ProfileSchema>;

export type AuthModelRecord = {
  id: string;
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
};

type FloeAuthPaths = {
  authDir: string;
  authJsonPath: string;
  modelsJsonPath: string;
  profilesYamlPath: string;
};

/** Credential shape stored in ~/.floe/auth/auth.json (subset used for probing). */
type StoredCredential =
  | { type: "api_key"; key: string }
  | { type: "oauth"; refresh: string; access: string; expires: number; [key: string]: unknown };

type AuthStorageData = Record<string, StoredCredential>;

export function listAuthProfiles(configPath: string, config: LocalConfig): AuthProfileRecord[] {
  const paths = getFloeAuthPaths(configPath, config);
  ensureAuthFiles(paths);
  try {
    const raw = readFileSync(paths.profilesYamlPath, "utf8");
    const parsed = raw.trim() ? YAML.parse(raw) : DEFAULT_PROFILES;
    return ProfilesDocumentSchema.parse(parsed).profiles;
  } catch {
    return [];
  }
}

export async function listAuthModels(
  configPath: string,
  config: LocalConfig,
  provider?: string,
  fetchFn?: FetchFn,
): Promise<AuthModelRecord[]> {
  const paths = getFloeAuthPaths(configPath, config);
  ensureAuthFiles(paths);
  const authData = readAuthStorage(paths.authJsonPath);
  const registry = new BusModelRegistry(paths.modelsJsonPath);
  return registry.list(provider, authData, paths.authJsonPath, fetchFn);
}

function readAuthStorage(authJsonPath: string): AuthStorageData {
  try {
    return JSON.parse(readFileSync(authJsonPath, "utf8")) as AuthStorageData;
  } catch {
    return {};
  }
}

function writeAuthStorage(authJsonPath: string, data: AuthStorageData): void {
  writeFileSync(authJsonPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  chmodSafe(authJsonPath, 0o600);
}

/**
 * Resolve a stored credential to a probe-ready token.
 * For OAuth credentials: calls pi's getOAuthApiKey which refreshes expired tokens.
 * Persists refreshed credentials back to auth.json (same 0600 care as ensureAuthFiles).
 * Returns undefined (fail-open) on any error.
 */
async function resolveStoredCredential(
  provider: string,
  credential: StoredCredential | undefined,
  authJsonPath: string,
  authData: AuthStorageData,
): Promise<ResolvedCredential | undefined> {
  if (!credential) return undefined;
  if (credential.type === "api_key") {
    const token = credential.key.trim();
    return token ? { token, isOAuth: false } : undefined;
  }
  if (credential.type === "oauth") {
    try {
      const oauthCredentials: Record<string, OAuthCredentials> = {};
      for (const [key, value] of Object.entries(authData)) {
        if (value.type === "oauth") oauthCredentials[key] = value;
      }
      const refreshed = await getOAuthApiKey(provider, oauthCredentials);
      if (!refreshed) return undefined;
      // Persist refreshed credentials back to auth.json if token changed
      if (refreshed.newCredentials.access !== credential.access) {
        authData[provider] = { type: "oauth", ...refreshed.newCredentials };
        writeAuthStorage(authJsonPath, authData);
      }
      const token = refreshed.apiKey.trim();
      return token ? { token, isOAuth: true } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
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

class BusModelRegistry {
  private readonly models: Model<any>[] = [];
  /** Keys of models that came from models.json custom entries — never filtered out. */
  private readonly customModelKeys = new Set<string>();

  constructor(private readonly modelsPath: string) {
    const builtIns = getProviders().flatMap((provider) => getModels(provider as any)) as Model<any>[];
    this.models.push(...builtIns);
    this.applyOverlays();
  }

  async list(provider: string | undefined, authData: AuthStorageData, authJsonPath: string, fetchFn?: FetchFn): Promise<AuthModelRecord[]> {
    // Group models by provider so we do at most one probe per provider.
    const providerSet = provider
      ? new Set([provider])
      : new Set(this.models.map((m) => m.provider));

    // Resolve credentials (refreshing expired OAuth tokens) then probe concurrently.
    // Failures return undefined (fail-open) at both the resolve and probe stages.
    const liveIdsByProvider = new Map<string, Set<string> | undefined>();
    await Promise.all(
      [...providerSet].map(async (prov) => {
        const rawCredential = authData[prov] as StoredCredential | undefined;
        const resolved = await resolveStoredCredential(prov, rawCredential, authJsonPath, authData);
        const liveIds = await fetchLiveModelIds(prov, resolved, fetchFn);
        liveIdsByProvider.set(prov, liveIds);
      }),
    );

    return this.models
      .filter((model) => !provider || model.provider === provider)
      .filter((model) => {
        const liveIds = liveIdsByProvider.get(model.provider);
        return intersectWithLive([model], this.customModelKeys, liveIds).length > 0;
      })
      .map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        api: model.api,
        reasoning: !!model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input
      }));
  }

  private applyOverlays(): void {
    try {
      const parsed = ModelsConfigSchema.parse(JSON.parse(readFileSync(this.modelsPath, "utf8")));
      for (const [provider, config] of Object.entries(parsed.providers)) {
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
          const existingIndex = this.models.findIndex((model) => model.provider === provider && model.id === modelDef.id);
          if (existingIndex >= 0) this.models[existingIndex] = custom;
          else this.models.push(custom);
          this.customModelKeys.add(`${provider}/${modelDef.id}`);
        }
      }
    } catch {
      // Keep built-ins only when models.json is unreadable or invalid.
    }
  }
}

function chmodSafe(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only.
  }
}
