import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

const FIELD_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const REF_PATTERN = /^[a-z][a-z0-9_]*:\S+$/;
const RENDERER_PATTERN = /^[a-z][a-z0-9_-]*$/;
const ISO_DATETIME = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  { message: "must be an ISO 8601 timestamp" }
);

const FieldIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(FIELD_ID_PATTERN, "field id must be a slug matching ^[a-z0-9][a-z0-9_-]*$");

const FieldItemSchema = z.object({
  item_id: z.string().regex(ITEM_ID_PATTERN, "item_id must match ^[a-z0-9][a-z0-9_-]*$"),
  ref: z.string().regex(REF_PATTERN, "ref must look like '<kind>:<id>'")
});

const FieldConnectionSchema = z.object({
  id: z.string().regex(CONNECTION_ID_PATTERN, "connection id must match ^[a-z0-9][a-z0-9_-]*$"),
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const FieldSemanticSchema = z.object({
  schema: z.literal("floe.field.v1"),
  id: FieldIdSchema,
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  items: z.array(FieldItemSchema),
  connections: z.array(FieldConnectionSchema),
  metadata: z.record(z.unknown()).optional(),
  created_at: ISO_DATETIME,
  updated_at: ISO_DATETIME
});

export const FieldLayoutSchema = z.object({
  schema: z.literal("floe.field.layout.floeweb.v1"),
  field_id: FieldIdSchema,
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

export type FieldSemantic = z.infer<typeof FieldSemanticSchema>;
export type FieldLayout = z.infer<typeof FieldLayoutSchema>;

export type FieldSummary = {
  id: string;
  title: string;
  item_count: number;
  connection_count: number;
  parent_count: number;
  updated_at: string;
};

export type LoadedField = {
  semantic: FieldSemantic;
  layout?: FieldLayout;
};

export type UpsertFieldOptions = {
  ifAbsent?: boolean;
};

export class FieldValidationError extends Error {
  constructor(message: string, readonly issues?: z.ZodIssue[]) {
    super(message);
    this.name = "FieldValidationError";
  }
}

export class FieldIdMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldIdMismatchError";
  }
}

export class FieldAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldAlreadyExistsError";
  }
}

export class FieldRendererInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldRendererInvalidError";
  }
}

function fieldsDir(workspacePath: string): string {
  return join(workspacePath, ".floe", "fields");
}

function fieldRefTarget(ref: string): string | null {
  if (!ref.startsWith("field:")) return null;
  const id = ref.slice("field:".length);
  return FIELD_ID_PATTERN.test(id) ? id : null;
}

function semanticPath(workspacePath: string, fieldId: string): string {
  return join(fieldsDir(workspacePath), `${fieldId}.yaml`);
}

function layoutPath(workspacePath: string, fieldId: string, renderer: string): string {
  return join(fieldsDir(workspacePath), `${fieldId}.layout.${renderer}.yaml`);
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

function validateFieldId(fieldId: string): void {
  const parsed = FieldIdSchema.safeParse(fieldId);
  if (!parsed.success) {
    throw new FieldValidationError(
      `invalid field id '${fieldId}': ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      parsed.error.issues
    );
  }
}

function crossValidateSemantic(semantic: FieldSemantic): void {
  const itemIds = new Set<string>();
  for (const item of semantic.items) {
    if (itemIds.has(item.item_id)) {
      throw new FieldValidationError(
        `duplicate item_id '${item.item_id}' in field '${semantic.id}'`
      );
    }
    itemIds.add(item.item_id);
  }

  const connectionIds = new Set<string>();
  for (const conn of semantic.connections) {
    if (connectionIds.has(conn.id)) {
      throw new FieldValidationError(
        `duplicate connection id '${conn.id}' in field '${semantic.id}'`
      );
    }
    connectionIds.add(conn.id);

    if (!itemIds.has(conn.from)) {
      throw new FieldValidationError(
        `connection '${conn.id}' references unknown 'from' item_id '${conn.from}' in field '${semantic.id}'`
      );
    }
    if (!itemIds.has(conn.to)) {
      throw new FieldValidationError(
        `connection '${conn.id}' references unknown 'to' item_id '${conn.to}' in field '${semantic.id}'`
      );
    }
  }
}

function findLayoutFiles(workspacePath: string, fieldId: string): string[] {
  const dir = fieldsDir(workspacePath);
  if (!existsSync(dir)) return [];
  const prefix = `${fieldId}.layout.`;
  const suffix = ".yaml";
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => join(dir, name));
}

function loadLayoutFromAnyRenderer(workspacePath: string, fieldId: string): FieldLayout | undefined {
  const files = findLayoutFiles(workspacePath, fieldId);
  if (files.length === 0) return undefined;
  const parsed = parseYamlFile<unknown>(files[0]);
  const result = FieldLayoutSchema.safeParse(parsed);
  if (!result.success) {
    throw new FieldValidationError(
      `invalid layout file '${files[0]}': ${result.error.issues.map((i) => i.message).join("; ")}`,
      result.error.issues
    );
  }
  return result.data;
}

export function loadField(workspacePath: string, fieldId: string): LoadedField | null {
  validateFieldId(fieldId);
  const path = semanticPath(workspacePath, fieldId);
  if (!existsSync(path)) return null;

  const parsed = parseYamlFile<unknown>(path);
  const result = FieldSemanticSchema.safeParse(parsed);
  if (!result.success) {
    throw new FieldValidationError(
      `invalid semantic file for field '${fieldId}': ${result.error.issues.map((i) => i.message).join("; ")}`,
      result.error.issues
    );
  }
  crossValidateSemantic(result.data);

  const layout = loadLayoutFromAnyRenderer(workspacePath, fieldId);
  return layout ? { semantic: result.data, layout } : { semantic: result.data };
}

export function loadAllFields(workspacePath: string): FieldSummary[] {
  const dir = fieldsDir(workspacePath);
  if (!existsSync(dir)) return [];

  const fields: FieldSemantic[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".yaml")) continue;
    if (name.includes(".layout.")) continue;
    const id = name.slice(0, -".yaml".length);
    if (!FIELD_ID_PATTERN.test(id) || id.length > 100) continue;

    const parsed = parseYamlFile<unknown>(join(dir, name));
    const result = FieldSemanticSchema.safeParse(parsed);
    if (!result.success) {
      throw new FieldValidationError(
        `invalid semantic file '${name}': ${result.error.issues.map((i) => i.message).join("; ")}`,
        result.error.issues
      );
    }
    fields.push(result.data);
  }

  const fieldIds = new Set(fields.map((field) => field.id));
  const parentCounts = new Map<string, Set<string>>();
  for (const field of fields) {
    const referencedChildren = new Set<string>();
    for (const item of field.items) {
      const childId = fieldRefTarget(item.ref);
      if (childId && fieldIds.has(childId)) referencedChildren.add(childId);
    }
    for (const childId of referencedChildren) {
      const parents = parentCounts.get(childId) ?? new Set<string>();
      parents.add(field.id);
      parentCounts.set(childId, parents);
    }
  }

  const summaries: FieldSummary[] = fields.map((field) => ({
    id: field.id,
    title: field.title,
    item_count: field.items.length,
    connection_count: field.connections.length,
    parent_count: parentCounts.get(field.id)?.size ?? 0,
    updated_at: field.updated_at
  }));
  summaries.sort((a, b) => a.id.localeCompare(b.id));
  return summaries;
}

export function upsertFieldSemantic(
  workspacePath: string,
  fieldId: string,
  body: unknown,
  options: UpsertFieldOptions = {}
): FieldSemantic {
  validateFieldId(fieldId);

  const result = FieldSemanticSchema.safeParse(body);
  if (!result.success) {
    throw new FieldValidationError(
      `invalid semantic body for field '${fieldId}': ${result.error.issues.map((i) => i.message).join("; ")}`,
      result.error.issues
    );
  }
  const semantic = result.data;

  if (semantic.id !== fieldId) {
    throw new FieldIdMismatchError(
      `body id '${semantic.id}' does not match path field id '${fieldId}'`
    );
  }

  crossValidateSemantic(semantic);

  const path = semanticPath(workspacePath, fieldId);
  const fileExists = existsSync(path);

  if (options.ifAbsent && fileExists) {
    throw new FieldAlreadyExistsError(
      `field '${fieldId}' already exists at ${path}`
    );
  }

  let createdAt = semantic.created_at;
  if (fileExists) {
    try {
      const existing = parseYamlFile<unknown>(path);
      const existingResult = FieldSemanticSchema.safeParse(existing);
      if (existingResult.success) {
        createdAt = existingResult.data.created_at;
      }
    } catch {
      // ignore parse errors on existing file; we are about to overwrite it
    }
  }

  const next: FieldSemantic = {
    ...semantic,
    created_at: createdAt,
    updated_at: new Date().toISOString()
  };

  ensureDir(fieldsDir(workspacePath));
  writeYamlFile(path, next);
  return next;
}

export function upsertFieldLayout(
  workspacePath: string,
  fieldId: string,
  renderer: string,
  body: unknown
): FieldLayout {
  validateFieldId(fieldId);

  if (!RENDERER_PATTERN.test(renderer)) {
    throw new FieldRendererInvalidError(
      `invalid renderer name '${renderer}': must match ^[a-z][a-z0-9_-]*$`
    );
  }

  const result = FieldLayoutSchema.safeParse(body);
  if (!result.success) {
    throw new FieldValidationError(
      `invalid layout body for field '${fieldId}' renderer '${renderer}': ${result.error.issues.map((i) => i.message).join("; ")}`,
      result.error.issues
    );
  }
  const layout = result.data;

  if (layout.field_id !== fieldId) {
    throw new FieldIdMismatchError(
      `layout field_id '${layout.field_id}' does not match path field id '${fieldId}'`
    );
  }

  const path = layoutPath(workspacePath, fieldId, renderer);
  ensureDir(fieldsDir(workspacePath));
  writeYamlFile(path, layout);
  return layout;
}

export function deleteField(
  workspacePath: string,
  fieldId: string
): { semanticDeleted: boolean; layoutsDeleted: string[] } {
  validateFieldId(fieldId);

  const path = semanticPath(workspacePath, fieldId);
  let semanticDeleted = false;
  if (existsSync(path)) {
    rmSync(path);
    semanticDeleted = true;
  }

  const layoutsDeleted: string[] = [];
  for (const layoutFile of findLayoutFiles(workspacePath, fieldId)) {
    rmSync(layoutFile);
    layoutsDeleted.push(layoutFile);
  }

  return { semanticDeleted, layoutsDeleted };
}
