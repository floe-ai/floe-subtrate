import type { ScopeProjection, ScopeRecord } from "./scope-projection";

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
    `${scopesBase(busUrl, workspaceId)}/${encodeURIComponent(scopeId)}/projection`
  );
  return result.projection;
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
