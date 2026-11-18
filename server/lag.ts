/**
 * Artificial network conditions for dev and tests (env LATENCY_MS / JITTER_MS).
 * The transport is TCP, so order is preserved: a message is never delivered before an earlier one.
 * Each direction gets half the configured round-trip latency.
 */
export interface LagConfig {
  /** Added round-trip ms (half inbound, half outbound). */
  latencyMs: number;
  /** Extra random one-way delay in [0, jitterMs] per message (order still preserved). */
  jitterMs: number;
}

export const NO_LAG: LagConfig = { latencyMs: 0, jitterMs: 0 };

export class LagQueue {
  private lastDeliverAt = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly oneWayMs: number,
    private readonly jitterMs: number,
    private readonly random: () => number = Math.random,
  ) {}

  get active(): boolean {
    return this.oneWayMs > 0 || this.jitterMs > 0;
  }

  /** Runs `fn` now if no lag is configured, otherwise after the simulated delay (in order). */
  run(fn: () => void): void {
    if (this.closed) return;
    if (!this.active) {
      fn();
      return;
    }
    const now = performance.now();
    const at = Math.max(this.lastDeliverAt, now + this.oneWayMs + this.random() * this.jitterMs);
    this.lastDeliverAt = at;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) fn();
    }, at - now);
    this.timers.add(timer);
  }

  /** Drops everything still in flight. */
  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
