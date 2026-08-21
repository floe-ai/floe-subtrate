/** Structured runtime failure surfaced by the bridge through the originating Context. */
export class TurnFailedError extends Error {
  readonly code = "turn_failed" as const;
  constructor(
    readonly delivery_id: string,
    readonly source_endpoint_id: string,
    readonly workspace_id: string,
    readonly context_id: string | null,
    readonly thread_id: string,
    readonly model_id: string,
    readonly provider: string,
    readonly http_status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "TurnFailedError";
  }
}
