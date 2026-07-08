/**
 * Extension loader — discovers, validates, loads, and returns extension tools.
 *
 * An extension lives in `{extensionsDir}/{name}/` and contains:
 * - `extension.json`  — manifest (schema, name, entry, optional pulses/views/agents)
 * - entry point file  — default-exports a factory `(ctx) => AgentTool[]`
 *
 * Defensive: if one extension fails, it is recorded in `errors` and the
 * loader continues with the next extension.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { HookRegistry, HookName, HookHandler } from "./hooks.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExtensionViewConfig {
  /** Currently the only supported slot. Others may be added in Phase 3. */
  slot: "scope-detail-tab";
  /** Label shown in the tab button, e.g. "Board" */
  label: string;
  /** Monorepo package specifier or relative path — future dynamic-loading metadata */
  component: string;
}

export interface BundledAgentConfig {
  agent_id: string;
  label: string;
  /** Path relative to extension directory — must be a .md file */
  instructions_path: string;
  runtime?: { engine: string };
  extensions?: string[];
  pulse?: { inherit: boolean };
}

export interface ExtensionManifest {
  schema: string;
  name: string;
  description?: string;
  entry: string;
  pulses?: ExtensionPulseConfig[];
  /** Extension views declared by this extension (optional) */
  views?: ExtensionViewConfig[];
  /** Bundled agents to auto-provision on load (optional) */
  agents?: BundledAgentConfig[];
}

export interface ExtensionPulseConfig {
  id: string;
  persistence?: "workspace" | "local";
  scope_id?: string;
  trigger: { type: string; at?: string; schedule?: string; timezone?: string };
  content?: Record<string, unknown>;
  subscribers?: string[];
}

/** Registry of extension HTTP handlers (bridge-local; not persisted to bus) */
export interface ExtensionHttpHandler {
  method: "GET" | "POST";
  /** Path relative to extension namespace, e.g. "/board" */
  path: string;
  handler: (req: { method: string; path: string; query: Record<string, string>; body: unknown }) => Promise<{ status: number; body: unknown }>;
}

export interface ExtensionContext {
  workspacePath: string;
  busClient: any;
  workspaceId: string;
  extensionName: string;
  hooks: {
    on<Name extends HookName>(hook: Name, handler: HookHandler<Name>): void;
  };
  /**
   * Register an HTTP handler for this extension.
   * The handler will be invokable via `GET|POST /v1/extensions/{extensionName}/{path}`
   * once the bridge reports relay_url to the bus via reportExtensions().
   */
  registerHttpHandler(
    method: "GET" | "POST",
    path: string,
    handler: (req: { method: string; path: string; query: Record<string, string>; body: unknown }) => Promise<{ status: number; body: unknown }>
  ): void;
}

/**
 * A bundled agent with its instruction body loaded into memory.
 * The body is read from `instructions_path` relative to the extension directory
 * at load time — it is never written to the workspace's committed `.floe/` tree.
 */
export interface LoadedBundledAgent extends BundledAgentConfig {
  /** Instructions body loaded from instructions_path (in-memory only, no disk write) */
  body: string;
}

export interface LoadedExtension {
  name: string;
  tools: any[];
  pulses: ExtensionPulseConfig[];
  /** Declared views from manifest (empty array when none declared) */
  views: ExtensionViewConfig[];
  /** Bundled agents with instructions loaded in memory (never written to workspace disk) */
  bundledAgents: LoadedBundledAgent[];
  /** HTTP handlers registered by the extension factory (bridge-local) */
  httpHandlers: ExtensionHttpHandler[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

const SUPPORTED_SCHEMA = "floe.extension.v1";

function validateManifest(raw: unknown): { ok: true; manifest: ExtensionManifest } | { ok: false; error: string } {
  if (raw == null || typeof raw !== "object") {
    return { ok: false, error: "extension.json is not a valid JSON object" };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.schema !== "string" || obj.schema !== SUPPORTED_SCHEMA) {
    return { ok: false, error: `Invalid or unsupported schema: expected "${SUPPORTED_SCHEMA}", got "${obj.schema}"` };
  }
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    return { ok: false, error: "Missing or empty required field: name" };
  }
  if (typeof obj.entry !== "string" || obj.entry.length === 0) {
    return { ok: false, error: "Missing or empty required field: entry" };
  }

  const views: ExtensionViewConfig[] = [];
  if (Array.isArray(obj.views)) {
    for (const v of obj.views) {
      if (v && typeof v === "object" && typeof (v as any).slot === "string" && typeof (v as any).label === "string" && typeof (v as any).component === "string") {
        views.push({ slot: (v as any).slot as "scope-detail-tab", label: (v as any).label, component: (v as any).component });
      }
    }
  }

  const agents: BundledAgentConfig[] = [];
  if (Array.isArray(obj.agents)) {
    for (const a of obj.agents) {
      if (a && typeof a === "object" &&
          typeof (a as any).agent_id === "string" &&
          typeof (a as any).label === "string" &&
          typeof (a as any).instructions_path === "string") {
        agents.push({
          agent_id: (a as any).agent_id,
          label: (a as any).label,
          instructions_path: (a as any).instructions_path,
          runtime: (a as any).runtime,
          extensions: Array.isArray((a as any).extensions) ? (a as any).extensions : undefined,
          pulse: (a as any).pulse
        });
      }
    }
  }

  return {
    ok: true,
    manifest: {
      schema: obj.schema,
      name: obj.name,
      description: typeof obj.description === "string" ? obj.description : undefined,
      entry: obj.entry,
      pulses: Array.isArray(obj.pulses) ? (obj.pulses as ExtensionPulseConfig[]) : undefined,
      views: views.length > 0 ? views : undefined,
      agents: agents.length > 0 ? agents : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Bundled-agent in-memory loading
//
// Reads each bundled agent's instruction body from the extension directory.
// Never writes to the workspace's committed .floe/ tree — callers register
// the agents dynamically with the bus instead.
// ---------------------------------------------------------------------------

async function loadBundledAgentsInMemory(
  manifest: ExtensionManifest,
  extDir: string,
  errors: string[]
): Promise<LoadedBundledAgent[]> {
  const result: LoadedBundledAgent[] = [];
  for (const agentDef of (manifest.agents ?? [])) {
    const instructionsAbsPath = resolve(extDir, agentDef.instructions_path);
    let instructions = "";
    try {
      instructions = readFileSync(instructionsAbsPath, "utf-8");
    } catch (err: any) {
      errors.push(`[bundled-agent] Failed to read agent instructions "${agentDef.instructions_path}": ${err.message}`);
      continue;
    }
    result.push({ ...agentDef, body: instructions });
    console.log(`[bridge] loaded bundled agent in memory: ${agentDef.agent_id}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

async function loadSingleExtension(
  dirName: string,
  extDir: string,
  context: Omit<ExtensionContext, "extensionName" | "hooks" | "registerHttpHandler">,
  hookRegistry?: HookRegistry
): Promise<LoadedExtension> {
  const errors: string[] = [];
  const httpHandlers: ExtensionHttpHandler[] = [];
  const result: LoadedExtension = { name: dirName, tools: [], pulses: [], views: [], bundledAgents: [], httpHandlers, errors };

  // 1. Read manifest
  const manifestPath = join(extDir, "extension.json");
  let manifest: ExtensionManifest;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const validation = validateManifest(raw);
    if (!validation.ok) {
      errors.push(validation.error);
      return result;
    }
    manifest = validation.manifest;
  } catch (err: any) {
    errors.push(`Failed to read extension.json: ${err.message}`);
    return result;
  }

  // Use manifest name as the canonical extension name
  result.name = manifest.name;

  // 2. Extract pulses
  if (manifest.pulses) {
    result.pulses = manifest.pulses;
  }

  // 3. Extract views
  result.views = manifest.views ?? [];

  // 4. Load bundled agent instructions into memory (no disk writes to the workspace)
  if (manifest.agents && manifest.agents.length > 0) {
    result.bundledAgents = await loadBundledAgentsInMemory(manifest, extDir, errors);
  }

  // 5. Resolve and import entry point
  const entryPath = resolve(extDir, manifest.entry);
  let factory: (ctx: ExtensionContext) => any[];
  try {
    const entryUrl = pathToFileURL(entryPath).href;
    const mod = await import(entryUrl);
    factory = mod.default;
    if (typeof factory !== "function") {
      errors.push(`Entry point default export is not a function (got ${typeof factory})`);
      return result;
    }
  } catch (err: any) {
    errors.push(`Failed to import entry point "${manifest.entry}": ${err.message}`);
    return result;
  }

  // 6. Call factory
  const extContext: ExtensionContext = {
    ...context,
    extensionName: manifest.name,
    hooks: {
      on<Name extends HookName>(hook: Name, handler: HookHandler<Name>) {
        hookRegistry?.on(hook, manifest.name, handler);
      }
    },
    registerHttpHandler(method: "GET" | "POST", path: string, handler: ExtensionHttpHandler["handler"]) {
      httpHandlers.push({ method, path, handler });
    }
  };

  let rawTools: any[];
  try {
    rawTools = factory(extContext);
    if (!Array.isArray(rawTools)) {
      errors.push(`Factory did not return an array (got ${typeof rawTools})`);
      return result;
    }
  } catch (err: any) {
    errors.push(`Factory threw: ${err.message}`);
    return result;
  }

  // 7. Prefix tool names
  result.tools = rawTools.map((tool) => ({
    ...tool,
    name: `${manifest.name}_${tool.name}`,
  }));

  return result;
}

/**
 * Discover, validate, load, and return all extensions from the given directory.
 *
 * Each subdirectory of `extensionsDir` is treated as a potential extension.
 * Extensions that fail to load are included in the result with their errors
 * recorded — they never prevent other extensions from loading.
 */
export async function loadExtensions(
  extensionsDir: string,
  context: Omit<ExtensionContext, "extensionName" | "hooks" | "registerHttpHandler">,
  hookRegistry?: HookRegistry
): Promise<LoadedExtension[]> {
  // Handle missing or empty directory
  let entries: string[];
  try {
    entries = readdirSync(extensionsDir);
  } catch {
    return [];
  }

  // Filter to subdirectories only
  const subdirs = entries.filter((entry) => {
    try {
      return statSync(join(extensionsDir, entry)).isDirectory();
    } catch {
      return false;
    }
  });

  if (subdirs.length === 0) return [];

  const results: LoadedExtension[] = [];
  for (const dirName of subdirs) {
    const extDir = join(extensionsDir, dirName);
    const loaded = await loadSingleExtension(dirName, extDir, context, hookRegistry);
    results.push(loaded);
  }

  return results;
}
