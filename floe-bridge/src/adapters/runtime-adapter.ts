import type { BusClient, DeliveryBundle } from "../bus-client.js";

export type RuntimeContext = {
  bridge_id: string;
  bus: BusClient;
};

export interface RuntimeAdapter {
  readonly name: string;
  handleBundle(context: RuntimeContext, bundle: DeliveryBundle): Promise<void>;
}
