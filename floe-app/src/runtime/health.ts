export type RuntimeHealthState = "starting" | "healthy" | "degraded" | "offline";

export type RuntimeHealth = {
  state: RuntimeHealthState;
  label: string;
  detail: string;
  technicalDetail?: string | null;
};

export type SubstrateHealthEvent = {
  state: "starting" | "offline";
  detail: string;
  technicalDetail?: string | null;
};

export const STARTING_RUNTIME_HEALTH: RuntimeHealth = {
  state: "starting",
  label: "Starting Floe",
  detail: "Connecting to Floe's local services.",
};
