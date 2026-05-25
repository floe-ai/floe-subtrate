export type PulseSubscriber =
  | { kind: "context"; context_id: string }
  | { kind?: "endpoint"; endpoint_ref: string; context_id?: string | null };

export class PulseApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "PulseApiError";
    this.status = status;
    this.body = body;
  }
}

function pulsePath(busUrl: string, pulseId: string, action: "subscribe" | "unsubscribe"): string {
  return `${busUrl.replace(/\/$/, "")}/v1/pulses/${encodeURIComponent(pulseId)}/${action}`;
}

async function request(url: string, subscriber: PulseSubscriber): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscriber)
  });
  if (!response.ok) {
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    throw new PulseApiError(response.status, body, `POST ${url}: ${response.status} ${text}`);
  }
}

export async function subscribePulse(busUrl: string, pulseId: string, subscriber: PulseSubscriber): Promise<void> {
  return request(pulsePath(busUrl, pulseId, "subscribe"), subscriber);
}

export async function unsubscribePulse(busUrl: string, pulseId: string, subscriber: PulseSubscriber): Promise<void> {
  return request(pulsePath(busUrl, pulseId, "unsubscribe"), subscriber);
}
