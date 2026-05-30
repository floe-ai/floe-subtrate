export type ContextAssignmentResult = {
  ok: true;
  context: {
    context_id: string;
    scope_id: string | null;
    participants: string[];
  };
  audit_event: unknown;
};

type AssignContextToScopeInput = {
  scopeId: string;
  actorId?: string | null;
};

const ERROR_MESSAGES: Record<string, string> = {
  scope_required: "Choose a real Scope before assigning this Context.",
  scope_not_found: "That Scope no longer exists. Refresh Workspace Home and choose another Scope.",
  context_not_found: "That Context no longer exists. Refresh Workspace Home.",
  context_already_scoped: "This Context is already assigned to a Scope.",
  context_anchor_required: "Only actor-anchored Workspace Contexts can be assigned to a Scope.",
  context_scope_assignment_invalid: "Only actor-anchored Workspace Contexts can be assigned to a Scope."
};

export class ContextAssignmentApiError extends Error {
  status: number;
  code: string | null;
  body: unknown;

  constructor(status: number, code: string | null, body: unknown, fallbackMessage: string) {
    super(code ? ERROR_MESSAGES[code] ?? fallbackMessage : fallbackMessage);
    this.name = "ContextAssignmentApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function assignmentPath(busUrl: string, workspaceId: string, contextId: string): string {
  return `${busUrl.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts/${encodeURIComponent(contextId)}/assign-scope`;
}

function readErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>;
    if (typeof error.code === "string") return error.code;
  }
  return null;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function assignContextToScope(
  busUrl: string,
  workspaceId: string,
  contextId: string,
  input: AssignContextToScopeInput
): Promise<ContextAssignmentResult> {
  const body: { scope_id: string; assigned_by?: string } = { scope_id: input.scopeId };
  if (input.actorId) body.assigned_by = input.actorId;

  const response = await fetch(assignmentPath(busUrl, workspaceId, contextId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const responseBody = await readResponseBody(response);

  if (!response.ok) {
    const code = readErrorCode(responseBody);
    throw new ContextAssignmentApiError(
      response.status,
      code,
      responseBody,
      `Unable to assign Context to Scope (${response.status}).`
    );
  }

  return responseBody as ContextAssignmentResult;
}
