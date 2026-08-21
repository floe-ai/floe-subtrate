import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getSupportedThinkingLevels,
  type AuthEvent,
  type AuthPrompt,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import YAML from "yaml";

// Pi keeps browser/device OAuth implementations behind bundler-opaque imports.
// The packaged desktop companion is a standalone bundle, so register Pi's
// static loaders before any provider attempts login or token refresh.
registerBunOAuthFlows();

type Profile = {
  id: string;
  provider: string;
  model?: string;
  label?: string;
  created_at?: string;
  updated_at?: string;
};

type ProfileDocument = { version: 1; profiles: Profile[] };

type ProviderModel = {
  id: string;
  name: string;
  is_default: boolean;
  reasoning_efforts: string[];
};

type ProviderStatus = {
  type: "provider_status";
  provider: string;
  name: string;
  auth_name: string;
  connected: boolean;
  profile_id: string;
  models: ProviderModel[];
};

type HelperEvent = AuthEvent | { type: "provider_statuses"; providers: ProviderStatus[] } | ProviderStatus;

class FloeCredentialStore implements CredentialStore {
  constructor(private readonly path: string) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const data = this.load();
    const next = await fn(data[providerId]);
    if (next !== undefined) {
      data[providerId] = next;
      this.save(data);
    }
    return next;
  }

  async delete(providerId: string): Promise<void> {
    const data = this.load();
    delete data[providerId];
    this.save(data);
  }

  private load(): Record<string, Credential> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Credential>;
    } catch {
      return {};
    }
  }

  private save(data: Record<string, Credential>): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    chmodSafe(temporary, 0o600);
    renameSync(temporary, this.path);
    chmodSafe(this.path, 0o600);
  }
}

function emit(message: HelperEvent): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function displayName(providerId: string, fallback: string): string {
  if (providerId === "openai-codex") return "ChatGPT";
  if (providerId === "anthropic") return "Claude";
  if (providerId === "kimi-coding") return "Kimi";
  if (providerId === "xai") return "Grok";
  return fallback;
}

function readProfiles(path: string): ProfileDocument {
  try {
    const parsed = YAML.parse(readFileSync(path, "utf8")) as Partial<ProfileDocument>;
    return { version: 1, profiles: Array.isArray(parsed?.profiles) ? parsed.profiles : [] };
  } catch {
    return { version: 1, profiles: [] };
  }
}

function saveProfiles(path: string, document: ProfileDocument): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, YAML.stringify(document), "utf8");
  chmodSafe(temporary, 0o600);
  renameSync(temporary, path);
  chmodSafe(path, 0o600);
}

function upsertSubscriptionProfile(authDir: string, providerId: string, label: string, model?: string): Profile {
  const path = join(authDir, "profiles.yaml");
  const document = readProfiles(path);
  const now = new Date().toISOString();
  const existing = document.profiles.find(profile => profile.provider === providerId);
  const profile: Profile = existing
    ? { ...existing, label, model: existing.model || model, updated_at: now }
    : {
        id: `${providerId}-subscription`,
        provider: providerId,
        label,
        model,
        created_at: now,
        updated_at: now,
      };
  const index = document.profiles.findIndex(item => item.id === profile.id);
  if (index >= 0) document.profiles[index] = profile;
  else document.profiles.push(profile);
  document.profiles.sort((left, right) => left.id.localeCompare(right.id));
  saveProfiles(path, document);
  return profile;
}

async function statuses(authDir: string): Promise<ProviderStatus[]> {
  const storage = new FloeCredentialStore(join(authDir, "auth.json"));
  const models = builtinModels({ credentials: storage });
  const credentials = new Set((await storage.list()).filter(item => item.type === "oauth").map(item => item.providerId));
  const profiles = readProfiles(join(authDir, "profiles.yaml"));

  const result: ProviderStatus[] = [];
  for (const provider of models.getProviders().filter(item => item.auth.oauth?.isSubscription === true)) {
      const profile = profiles.profiles.find(item => item.provider === provider.id);
      const credential = await storage.read(provider.id);
      const available = provider.filterModels?.(provider.getModels(), credential) ?? provider.getModels();
      result.push({
        type: "provider_status" as const,
        provider: provider.id,
        name: displayName(provider.id, provider.name),
        auth_name: provider.auth.oauth?.name ?? provider.name,
        connected: credentials.has(provider.id),
        profile_id: profile?.id ?? `${provider.id}-subscription`,
        models: available.map((model, index) => modelStatus(model, profile?.model, index)),
      });
  }
  return result;
}

function modelStatus(model: Model<any>, selected: string | undefined, index: number): ProviderModel {
  return {
    id: model.id,
    name: model.name,
    is_default: selected ? model.id === selected : index === 0,
    reasoning_efforts: getSupportedThinkingLevels(model).filter(level => level !== "off"),
  };
}

async function login(authDir: string, providerId: string): Promise<ProviderStatus> {
  const storage = new FloeCredentialStore(join(authDir, "auth.json"));
  const models = builtinModels({ credentials: storage });
  const provider = models.getProviders().find(item => item.id === providerId && item.auth.oauth?.isSubscription === true);
  if (!provider) throw new Error(`Unsupported subscription provider: ${providerId}`);

  await models.login(providerId, "oauth", {
    notify: event => {
      emit(event);
      if (event.type === "auth_url") openExternal(event.url);
      if (event.type === "device_code") openExternal(event.verificationUri);
    },
    prompt: prompt => answerDesktopPrompt(prompt),
  });

  const available = await models.getAvailable(providerId);
  const fallbackModels = available.length > 0 ? available : provider.getModels();
  upsertSubscriptionProfile(authDir, providerId, displayName(provider.id, provider.name), fallbackModels[0]?.id);
  const status = (await statuses(authDir)).find(item => item.provider === providerId);
  if (!status) throw new Error(`Provider disappeared after login: ${providerId}`);
  return status;
}

async function answerDesktopPrompt(prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") return preferredDesktopAuthOption(prompt.options);
  if (prompt.type === "text") return "";
  if (prompt.type === "secret") throw new Error("This desktop flow supports subscriptions; API keys remain in advanced settings");
  return new Promise<string>((_resolve, reject) => {
    const signal = prompt.signal;
    const abort = () => reject(signal?.reason ?? new Error("Browser sign-in completed"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export function preferredDesktopAuthOption(options: readonly { id: string }[]): string {
  // A local callback is convenient in a terminal, but desktop retries can leave
  // its fixed port owned by an older helper. Device auth keeps each attempt
  // independent and is already represented by the Floe provider screen.
  return options.find(option => option.id === "device_code")?.id ?? options[0]?.id ?? "";
}

function openExternal(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.toString()] : [url.toString()];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function chmodSafe(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* Windows does not implement POSIX modes. */ }
}

export async function runAuthHelper(args: string[]): Promise<void> {
  const [command, authDirArgument, providerId] = args;
  if (!authDirArgument) throw new Error("Floe auth directory is required");
  const authDir = authDirArgument;
  mkdirSync(authDir, { recursive: true });
  const authPath = join(authDir, "auth.json");
  if (!existsSync(authPath)) writeFileSync(authPath, "{}\n", "utf8");
  const profilesPath = join(authDir, "profiles.yaml");
  if (!existsSync(profilesPath)) saveProfiles(profilesPath, { version: 1, profiles: [] });

  if (command === "providers") {
    emit({ type: "provider_statuses", providers: await statuses(authDir) });
    return;
  }
  if (command === "login" && providerId) {
    emit(await login(authDir, providerId));
    return;
  }
  throw new Error("Usage: floe-desktop auth <providers AUTH_DIR|login AUTH_DIR PROVIDER>");
}
