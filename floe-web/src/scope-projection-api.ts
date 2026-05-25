import type { FieldLayoutFloeweb } from "./fields";
import type { ScopeProjection, ScopeRecord } from "./scope-projection";

export type ScopeProjectionStreamEvent = {
  type: "scope_projection.layout.upserted";
  payload: {
    workspace_id: string;
    scope_id: string;
    source: "api";
    renderer: string;
  };
  at?: string;
};

export class ScopeProjectionApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "ScopeProjectionApiError";
    this.status = status;
    this.body = body;
  }
}

function workspaceBase(busUrl: string, workspaceId: string): string {
  return `${busUrl.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

function scopesBase(busUrl: string, workspaceId: string): string {
  return `${workspaceBase(busUrl, workspaceId)}/scopes`;
}

function scopeProjectionPath(busUrl: string, workspaceId: string, scopeId: string): string {
  return `${scopesBase(busUrl, workspaceId)}/${encodeURIComponent(scopeId)}/projection`;
}

function scopeProjectionLayoutPath(busUrl: string, workspaceId: string, scopeId: string): string {
  return `${scopeProjectionPath(busUrl, workspaceId, scopeId)}/layout/floeweb`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseScopeProjectionStreamMessage(data: string): ScopeProjectionStreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "scope_projection.layout.upserted" || !isRecord(parsed.payload)) {
    return null;
  }
  const payload = parsed.payload;
  if (
    typeof payload.workspace_id !== "string" ||
    typeof payload.scope_id !== "string" ||
    payload.source !== "api" ||
    typeof payload.renderer !== "string"
  ) {
    return null;
  }
  const at = typeof parsed.at === "string" ? parsed.at : undefined;
  return {
    type: "scope_projection.layout.upserted",
    payload: {
      workspace_id: payload.workspace_id,
      scope_id: payload.scope_id,
      source: payload.source,
      renderer: payload.renderer
    },
    ...(at ? { at } : {})
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    throw new ScopeProjectionApiError(
      response.status,
      body,
      `${init?.method ?? "GET"} ${url}: ${response.status} ${text}`
    );
  }
  return response.json() as Promise<T>;
}

export async function listScopes(busUrl: string, workspaceId: string): Promise<ScopeRecord[]> {
  const result = await request<{ scopes: ScopeRecord[] }>(scopesBase(busUrl, workspaceId));
  return result.scopes;
}

export async function getScopeProjection(
  busUrl: string,
  workspaceId: string,
  scopeId: string
): Promise<ScopeProjection> {
  const result = await request<{ projection: ScopeProjection }>(
    scopeProjectionPath(busUrl, workspaceId, scopeId)
  );
  return result.projection;
}

export async function getScopeProjectionLayout(
  busUrl: string,
  workspaceId: string,
  scopeId: string
): Promise<FieldLayoutFloeweb | null> {
  try {
    const result = await request<{ layout: FieldLayoutFloeweb }>(
      scopeProjectionLayoutPath(busUrl, workspaceId, scopeId)
    );
    return result.layout;
  } catch (caught) {
    if (caught instanceof ScopeProjectionApiError && caught.status === 404) return null;
    throw caught;
  }
}

export async function putScopeProjectionLayout(
  busUrl: string,
  workspaceId: string,
  scopeId: string,
  layout: FieldLayoutFloeweb
): Promise<FieldLayoutFloeweb> {
  const result = await request<{ layout: FieldLayoutFloeweb }>(
    scopeProjectionLayoutPath(busUrl, workspaceId, scopeId),
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(layout)
    }
  );
  return result.layout;
}

export async function createScope(
  busUrl: string,
  workspaceId: string,
  input: { scope_id?: string; title: string; description?: string | null }
): Promise<ScopeRecord> {
  const result = await request<{ scope: ScopeRecord }>(scopesBase(busUrl, workspaceId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  return result.scope;
}

export async function renameScope(
  busUrl: string,
  workspaceId: string,
  scopeId: string,
  input: { title?: string; description?: string | null }
): Promise<ScopeRecord> {
  const result = await request<{ scope: ScopeRecord }>(
    `${scopesBase(busUrl, workspaceId)}/${encodeURIComponent(scopeId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  );
  return result.scope;
}
