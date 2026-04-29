export type EventEnvelope = {
  event_id: string;
  type: string;
  workspace_id: string;
  source_endpoint_id: string;
  destination_endpoint_id: string;
  thread_id: string;
  correlation_id: string | null;
  content: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type DeliveryBundle = {
  delivery_id: string;
  wait_id: string | null;
  endpoint_id: string;
  workspace_id: string;
  resume_reason: string;
  trigger_event_id: string;
  events: EventEnvelope[];
  delivered_at: string;
};

export type EventCommand = Omit<EventEnvelope, "event_id" | "created_at" | "metadata" | "correlation_id"> & {
  correlation_id?: string | null;
  metadata?: Record<string, unknown>;
  idempotency_key?: string | null;
};

export class BusClient {
  constructor(readonly baseUrl: string) {}

  async health(): Promise<unknown> {
    return this.get("/health");
  }

  async registerBridge(bridgeId: string, capabilities: Record<string, unknown>): Promise<void> {
    await this.post("/v1/bridges/register", { bridge_id: bridgeId, capabilities });
  }

  async reportBridgeLiveness(bridgeId: string): Promise<void> {
    await this.post(`/v1/bridges/${encodeURIComponent(bridgeId)}/liveness`, {});
  }

  async listWorkspaces(): Promise<any[]> {
    const result = await this.get("/v1/workspaces") as { workspaces: any[] };
    return result.workspaces;
  }

  async listConfigs(): Promise<any[]> {
    const result = await this.get("/v1/configs") as { configs: any[] };
    return result.configs;
  }

  async listEndpoints(workspaceId: string): Promise<any[]> {
    const result = await this.get(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`) as { endpoints: any[] };
    return result.endpoints;
  }

  async registerEndpoint(input: Record<string, unknown>): Promise<void> {
    await this.post("/v1/endpoints/register", input);
  }

  async updateEndpointStatus(endpointId: string, status: string): Promise<void> {
    await this.post(`/v1/endpoints/${encodeURIComponent(endpointId)}/status`, { status });
  }

  async reportAttachment(workspaceId: string, input: Record<string, unknown>): Promise<void> {
    await this.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/attachment-result`, input);
  }

  async importConfigSnapshot(workspaceId: string, snapshot: Record<string, unknown>): Promise<void> {
    await this.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/import-config`, snapshot);
  }

  async claimDeliveries(bridgeId: string): Promise<DeliveryBundle[]> {
    const result = await this.get(`/v1/delivery/claim?bridge_id=${encodeURIComponent(bridgeId)}&limit=10`) as { deliveries: DeliveryBundle[] };
    return result.deliveries;
  }

  async reportDeliveryStatus(
    bridgeId: string,
    deliveryId: string,
    state: "injected_to_runtime" | "acknowledged" | "failed" | "dead_lettered",
    error?: string
  ): Promise<void> {
    await this.post(`/v1/delivery/${encodeURIComponent(deliveryId)}/status`, {
      bridge_id: bridgeId,
      state,
      error: error ?? null
    });
  }

  async emit(event: EventCommand): Promise<void> {
    await this.post("/v1/events/emit", event);
  }

  async yield(event: EventCommand, wait?: Record<string, unknown>): Promise<void> {
    await this.post("/v1/events/yield", { event, wait });
  }

  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`);
    return response.json();
  }
}
