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

export type FieldStreamEvent =
  | {
      type: "field.upserted";
      payload: {
        workspace_id: string;
        field_id: string;
        source: "api" | "watcher";
        changed?: "semantic" | "layout";
        renderer?: string;
      };
      at?: string;
    }
  | {
      type: "field.deleted";
      payload: {
        workspace_id: string;
        field_id: string;
      };
      at?: string;
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

function streamPath(busUrl: string): string {
  return `${busUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "")}/v1/events/stream`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseFieldStreamMessage(data: string): FieldStreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string" || !isRecord(parsed.payload)) {
    return null;
  }
  const at = typeof parsed.at === "string" ? parsed.at : undefined;
  const payload = parsed.payload;
  if (
    parsed.type === "field.upserted" &&
    typeof payload.workspace_id === "string" &&
    typeof payload.field_id === "string" &&
    (payload.source === "api" || payload.source === "watcher")
  ) {
    const changed = payload.changed === "semantic" || payload.changed === "layout"
      ? payload.changed
      : undefined;
    const renderer = typeof payload.renderer === "string" ? payload.renderer : undefined;
    return {
      type: "field.upserted",
      payload: {
        workspace_id: payload.workspace_id,
        field_id: payload.field_id,
        source: payload.source,
        ...(changed ? { changed } : {}),
        ...(renderer ? { renderer } : {})
      },
      ...(at ? { at } : {})
    };
  }
  if (
    parsed.type === "field.deleted" &&
    typeof payload.workspace_id === "string" &&
    typeof payload.field_id === "string"
  ) {
    return {
      type: "field.deleted",
      payload: {
        workspace_id: payload.workspace_id,
        field_id: payload.field_id
      },
      ...(at ? { at } : {})
    };
  }
  return null;
}

export function subscribeToFieldEvents(
  busUrl: string,
  onEvent: (event: FieldStreamEvent) => void,
  options: { reconnectDelayMs?: number } = {}
): () => void {
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    socket = new WebSocket(streamPath(busUrl));
    socket.onmessage = (event) => {
      const fieldEvent = parseFieldStreamMessage(String(event.data));
      if (fieldEvent) onEvent(fieldEvent);
    };
    socket.onerror = () => {
      socket?.close();
    };
    socket.onclose = () => {
      if (closed) return;
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
    };
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    socket = null;
  };
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
  semantic: FieldSemantic,
  options: { ifAbsent?: boolean } = {}
): Promise<FieldSemantic> {
  const url = `${fieldPath(busUrl, workspaceId, fieldId)}${options.ifAbsent ? "?if_absent=true" : ""}`;
  const result = await request<{ semantic: FieldSemantic }>(
    url,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(semantic)
    }
  );
  return result.semantic;
}

export async function putFieldLayout(
  busUrl: string,
  workspaceId: string,
  fieldId: string,
  layout: FieldLayoutFloeweb
): Promise<FieldLayoutFloeweb> {
  const result = await request<{ layout: FieldLayoutFloeweb }>(
    `${fieldPath(busUrl, workspaceId, fieldId)}/layout/floeweb`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(layout)
    }
  );
  return result.layout;
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
