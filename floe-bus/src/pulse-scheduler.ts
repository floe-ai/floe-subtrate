/**
 * Floe Bus — Pulse Scheduler
 *
 * Event-driven priority scheduler using a single active setTimeout.
 * Zero CPU cost when no pulses are approaching.
 *
 * The scheduler maintains a sorted list of upcoming fire times and
 * sets one timeout for the nearest pulse. When it fires, the callback
 * is invoked and the scheduler advances to the next pulse.
 */

type PulseEntry = {
  pulseId: string;
  fireAt: Date;
};

export class PulseScheduler {
  private entries: PulseEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly onFire: (pulseId: string) => void) {}

  start(): void {
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  addPulse(pulseId: string, fireAt: Date): void {
    // Remove existing entry for same pulse id
    this.entries = this.entries.filter((e) => e.pulseId !== pulseId);
    this.entries.push({ pulseId, fireAt });
    this.entries.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
    if (this.running) this.scheduleNext();
  }

  removePulse(pulseId: string): void {
    this.entries = this.entries.filter((e) => e.pulseId !== pulseId);
    if (this.running) this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.entries.length === 0) return;

    const next = this.entries[0];
    const delay = Math.max(0, next.fireAt.getTime() - Date.now());

    this.timer = setTimeout(() => {
      this.timer = null;
      // Remove the fired entry
      this.entries.shift();
      this.onFire(next.pulseId);
      // Schedule the next one
      if (this.running) this.scheduleNext();
    }, delay);
  }
}
