import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

const RENDERER_PATTERN = /^[a-z][a-z0-9_-]*$/;

const ScopeProjectionLayoutIdSchema = z
  .string()
  .min(1)
  .max(200);

export const ScopeProjectionLayoutSchema = z.object({
  schema: z.literal("floe.field.layout.floeweb.v1"),
  field_id: ScopeProjectionLayoutIdSchema,
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number()
  }),
  items: z.record(
    z.object({
      x: z.number(),
      y: z.number(),
      width: z.number().optional(),
      height: z.number().optional(),
      collapsed: z.boolean().optional()
    })
  )
});

export type ScopeProjectionLayout = z.infer<typeof ScopeProjectionLayoutSchema>;

export class ScopeProjectionLayoutValidationError extends Error {
  constructor(message: string, readonly issues?: z.ZodIssue[]) {
    super(message);
    this.name = "ScopeProjectionLayoutValidationError";
  }
}

export class ScopeProjectionLayoutIdMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeProjectionLayoutIdMismatchError";
  }
}

export class ScopeProjectionLayoutRendererInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeProjectionLayoutRendererInvalidError";
  }
}

function layoutsDir(workspacePath: string): string {
  return join(workspacePath, ".floe", "scope-projection-layouts");
}

function layoutPath(workspacePath: string, scopeId: string, renderer: string): string {
  return join(layoutsDir(workspacePath), `${encodeURIComponent(scopeId)}.layout.${renderer}.yaml`);
}

function legacyFieldLayoutPath(workspacePath: string, scopeId: string, renderer: string): string {
  return join(workspacePath, ".floe", "fields", `${scopeId}.layout.${renderer}.yaml`);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function parseYamlFile<T>(path: string): T {
  const raw = readFileSync(path, "utf8");
  return YAML.parse(raw) as T;
}

function writeYamlFile(path: string, body: unknown): void {
  writeFileSync(path, YAML.stringify(body), "utf8");
}

function validateScopeId(scopeId: string): void {
  const parsed = ScopeProjectionLayoutIdSchema.safeParse(scopeId);
  if (!parsed.success) {
    throw new ScopeProjectionLayoutValidationError(
      `invalid scope id '${scopeId}': ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      parsed.error.issues
    );
  }
}

function validateRenderer(renderer: string): void {
  if (!RENDERER_PATTERN.test(renderer)) {
    throw new ScopeProjectionLayoutRendererInvalidError(
      `invalid renderer name '${renderer}': must match ^[a-z][a-z0-9_-]*$`
    );
  }
}

export function upsertScopeProjectionLayout(
  workspacePath: string,
  scopeId: string,
  renderer: string,
  body: unknown
): ScopeProjectionLayout {
  validateScopeId(scopeId);
  validateRenderer(renderer);

  const result = ScopeProjectionLayoutSchema.safeParse(body);
  if (!result.success) {
    throw new ScopeProjectionLayoutValidationError(
      `invalid layout body for scope '${scopeId}' renderer '${renderer}': ${result.error.issues.map((issue) => issue.message).join("; ")}`,
      result.error.issues
    );
  }
  const layout = result.data;

  if (layout.field_id !== scopeId) {
    throw new ScopeProjectionLayoutIdMismatchError(
      `layout field_id '${layout.field_id}' does not match path scope id '${scopeId}'`
    );
  }

  const path = layoutPath(workspacePath, scopeId, renderer);
  ensureDir(layoutsDir(workspacePath));
  writeYamlFile(path, layout);
  return layout;
}

export function loadScopeProjectionLayout(
  workspacePath: string,
  scopeId: string,
  renderer: string
): ScopeProjectionLayout | null {
  validateScopeId(scopeId);
  validateRenderer(renderer);

  const path = existsSync(layoutPath(workspacePath, scopeId, renderer))
    ? layoutPath(workspacePath, scopeId, renderer)
    : legacyFieldLayoutPath(workspacePath, scopeId, renderer);
  if (!existsSync(path)) return null;

  const parsed = parseYamlFile<unknown>(path);
  const result = ScopeProjectionLayoutSchema.safeParse(parsed);
  if (!result.success) {
    throw new ScopeProjectionLayoutValidationError(
      `invalid layout file '${path}': ${result.error.issues.map((issue) => issue.message).join("; ")}`,
      result.error.issues
    );
  }
  return result.data;
}
