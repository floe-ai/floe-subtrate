/**
 * Extension loader — discovers, validates, loads, and returns extension tools.
 *
 * An extension lives in `{extensionsDir}/{name}/` and contains:
 * - `extension.json`  — manifest (schema, name, entry, optional pulses)
 * - entry point file  — default-exports a factory `(ctx) => AgentTool[]`
 *
 * Defensive: if one extension fails, it is recorded in `errors` and the
 * loader continues with the next extension.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExtensionManifest {
  schema: string;
  name: string;
  description?: string;
  entry: string;
  pulses?: ExtensionPulseConfig[];
}

export interface ExtensionPulseConfig {
  id: string;
  trigger: { type: string; at?: string; schedule?: string; timezone?: string };
  content?: Record<string, unknown>;
  subscribers?: string[];
}

export interface ExtensionContext {
  workspacePath: string;
  busClient: any;
  workspaceId: string;
  extensionName: string;
}

export interface LoadedExtension {
  name: string;
  tools: any[];
  pulses: ExtensionPulseConfig[];
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

  return {
    ok: true,
    manifest: {
      schema: obj.schema,
      name: obj.name,
      description: typeof obj.description === "string" ? obj.description : undefined,
      entry: obj.entry,
      pulses: Array.isArray(obj.pulses) ? (obj.pulses as ExtensionPulseConfig[]) : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

async function loadSingleExtension(
  dirName: string,
  extDir: string,
  context: Omit<ExtensionContext, "extensionName">
): Promise<LoadedExtension> {
  const errors: string[] = [];
  const result: LoadedExtension = { name: dirName, tools: [], pulses: [], errors };

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

  // 3. Resolve and import entry point
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

  // 4. Call factory
  const extContext: ExtensionContext = {
    ...context,
    extensionName: manifest.name,
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

  // 5. Prefix tool names
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
  context: Omit<ExtensionContext, "extensionName">
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
    const loaded = await loadSingleExtension(dirName, extDir, context);
    results.push(loaded);
  }

  return results;
}
