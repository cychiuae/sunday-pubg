/**
 * Rate-limited console warnings for the client network layer. A bad server build or a protocol mismatch produces
 * the same warning 20-30 times a second; this logs the first one per key at once, then at most one per interval,
 * with the number suppressed in between.
 */
export type WarnSink = (msg: string, ...rest: unknown[]) => void;

export class LogLimiter {
  private readonly keys = new Map<string, { last: number; suppressed: number }>();

  constructor(
    private readonly now: () => number,
    private readonly intervalMs = 5000,
    private readonly sink: WarnSink = (msg, ...rest) => console.warn(msg, ...rest),
  ) {}

  /** Logs `msg` under `key` unless that key logged within the interval. Returns true if it logged. */
  warn(key: string, msg: string, ...rest: unknown[]): boolean {
    const t = this.now();
    const k = this.keys.get(key);
    if (k && t - k.last < this.intervalMs) {
      k.suppressed++;
      return false;
    }
    const extra = k && k.suppressed > 0 ? ` (+${k.suppressed} similar in the last ${Math.round((t - k.last) / 1000)} s)` : '';
    this.keys.set(key, { last: t, suppressed: 0 });
    this.sink(msg + extra, ...rest);
    return true;
  }

  /** Forget all keys (new session). */
  reset(): void {
    this.keys.clear();
  }
}
