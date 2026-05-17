import type { AgentRuntimeConfig } from "../auth.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";
import type { DeliveryBundle, EventEnvelope } from "../bus-client.js";

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly name = "fake";

  async handleBundle(context: RuntimeContext, bundle: DeliveryBundle, _runtimeConfig?: AgentRuntimeConfig): Promise<void> {
    const trigger = bundle.events[0];
    const destination = chooseReplyDestination(trigger);
    const text = firstText(trigger);
    const threadId = trigger.thread_id || `thr:${bundle.workspace_id}:fake`;

    await context.bus.appendRuntimeTelemetry({
      workspace_id: bundle.workspace_id,
      endpoint_id: bundle.endpoint_id,
      delivery_id: bundle.delivery_id,
      kind: "visible_output",
      payload: {
        text: `Fake runtime accepted ${bundle.events.length} event(s).`
      }
    });

    await context.bus.emit({
      type: "progress",
      workspace_id: bundle.workspace_id,
      source_endpoint_id: bundle.endpoint_id,
      destination: { kind: "endpoint", endpoint_id: destination },
      thread_id: threadId,
      correlation_id: trigger.correlation_id,
      current_delivery_context_id: trigger.context_id ?? null,
      content: {
        text: `Fake Floe is processing ${bundle.events.length} event(s).`,
        data: {
          adapter: this.name,
          trigger_event_id: trigger.event_id
        }
      },
      metadata: {
        delivery_id: bundle.delivery_id
      }
    });

    await context.bus.emit({
      type: "message",
      workspace_id: bundle.workspace_id,
      source_endpoint_id: bundle.endpoint_id,
      destination: { kind: "endpoint", endpoint_id: destination },
      thread_id: threadId,
      correlation_id: trigger.correlation_id,
      current_delivery_context_id: trigger.context_id ?? null,
      content: {
        text: `Fake Floe received: "${text}". I processed the local delivery bundle and ended the turn normally.`,
        data: {
          adapter: this.name,
          received_event_ids: bundle.events.map((event) => event.event_id)
        }
      },
      metadata: {
        delivery_id: bundle.delivery_id
      }
    });
  }
}

function chooseReplyDestination(event: EventEnvelope): string {
  if (event.source_endpoint_id) return event.source_endpoint_id;
  return `actor:${event.workspace_id}:operator`;
}

function firstText(event: EventEnvelope): string {
  const value = event.content?.text;
  return typeof value === "string" && value.trim() ? value.trim() : event.type;
}
