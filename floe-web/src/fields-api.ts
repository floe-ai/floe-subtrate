// Thin HTTP client for the Field substrate bus endpoints.
// No React, no DOM, no localStorage — vitest-mockable via global fetch.

import type { FieldSummary, FieldSemantic, FieldLayoutFloeweb } from "./fields";

export type LoadedField = {
  semantic: FieldSemantic;
  layout: FieldLayoutFloeweb | null;
};

export type DeleteFieldResult = {
  semanticDeleted: boolean;
  layoutsDeleted: string[];
};

export class FieldsApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "FieldsApiError";
    this.status = status;
    this.body = body;
  }
}

function fieldsBase(busUrl: string, workspaceId: string): string {
  return `${busUrl.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(workspaceId)}/fields`;
}

function fieldPath(busUrl: string, workspaceId: string, fieldId: string): string {
  return `${fieldsBase(busUrl, workspaceId)}/${encodeURIComponent(fieldId)}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    throw new FieldsApiError(
      response.status,
      body,
      `${init?.method ?? "GET"} ${url}: ${response.status} ${text}`
    );
  }
  return response.json() as Promise<T>;
}

export async function listFields(busUrl: string, workspaceId: string): Promise<FieldSummary[]> {
  const result = await request<{ fields: FieldSummary[] }>(fieldsBase(busUrl, workspaceId));
  return result.fields;
}

export async function getField(
  busUrl: string,
  workspaceId: string,
  fieldId: string
): Promise<LoadedField> {
  const result = await request<{ semantic: FieldSemantic; layout: FieldLayoutFloeweb | null }>(
    fieldPath(busUrl, workspaceId, fieldId)
  );
  return { semantic: result.semantic, layout: result.layout ?? null };
}

export async function putFieldSemantic(
  busUrl: string,
  workspaceId: string,
  fieldId: string,
  semantic: FieldSemantic
): Promise<FieldSemantic> {
  const result = await request<{ semantic: FieldSemantic }>(
    fieldPath(busUrl, workspaceId, fieldId),
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(semantic)
    }
  );
  return result.semantic;
}

export async function deleteField(
  busUrl: string,
  workspaceId: string,
  fieldId: string
): Promise<DeleteFieldResult> {
  return request<DeleteFieldResult>(fieldPath(busUrl, workspaceId, fieldId), {
    method: "DELETE"
  });
}
