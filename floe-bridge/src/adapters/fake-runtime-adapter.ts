import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";
import type { DeliveryBundle, EventEnvelope } from "../bus-client.js";

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly name = "fake";

  async handleBundle(context: RuntimeContext, bundle: DeliveryBundle): Promise<void> {
    const trigger = bundle.events[0];
    if (trigger.type === "wait_refresh") {
      await context.bus.updateEndpointStatus(bundle.endpoint_id, "waiting");
      return;
    }

    const destination = chooseReplyDestination(trigger);
    const text = firstText(trigger);
    const threadId = trigger.thread_id || `thr:${bundle.workspace_id}:fake`;

    await context.bus.emit({
      type: "progress",
      workspace_id: bundle.workspace_id,
      source_endpoint_id: bundle.endpoint_id,
      destination_endpoint_id: destination,
      thread_id: threadId,
      correlation_id: trigger.correlation_id,
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

    await context.bus.yield({
      type: "message",
      workspace_id: bundle.workspace_id,
      source_endpoint_id: bundle.endpoint_id,
      destination_endpoint_id: destination,
      thread_id: threadId,
      correlation_id: trigger.correlation_id,
      content: {
        text: `Fake Floe received: "${text}". I processed the local delivery bundle and am waiting for the next eligible event.`,
        data: {
          adapter: this.name,
          received_event_ids: bundle.events.map((event) => event.event_id)
        }
      },
      metadata: {
        turn_state: "waiting_for_input",
        delivery_id: bundle.delivery_id
      }
    }, {
      mode: "open",
      max_batch_events: 25
    });
  }
}

function chooseReplyDestination(event: EventEnvelope): string {
  if (event.source_endpoint_id) return event.source_endpoint_id;
  return `endpoint:${event.workspace_id}:user:operator`;
}

function firstText(event: EventEnvelope): string {
  const value = event.content?.text;
  return typeof value === "string" && value.trim() ? value.trim() : event.type;
}
