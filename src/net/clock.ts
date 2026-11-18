/**
 * Server clock estimation from ping/pong (ARCHITECTURE.md §6 "Clock sync").
 * offset sample = serverTime + rtt/2 - now; use the lowest-RTT sample of the last 5 (least queuing delay).
 * The applied offset slews toward that target so serverNow() is smooth and monotonic; big errors snap.
 */
export const CLOCK_SAMPLES = 5;
/** Larger corrections than this snap instead of slewing. */
export const CLOCK_SNAP_MS = 250;
/** Max slew: ms of correction per ms of wall time (5%). Keeps serverNow() strictly increasing. */
export const CLOCK_SLEW_RATE = 0.05;
/** EWMA weight for rttMs. */
export const RTT_SMOOTHING = 0.25;

interface Sample { rtt: number; offset: number }

export class ClockSync {
  private samples: Sample[] = [];
  private offset = 0;
  private target = 0;
  private lastNow = 0;
  private synced = false;
  private rough = false;
  rttMs = 0;

  /** True once at least one ping/pong sample exists. */
  get hasSample(): boolean {
    return this.synced;
  }

  reset(): void {
    this.samples = [];
    this.offset = 0;
    this.target = 0;
    this.lastNow = 0;
    this.synced = false;
    this.rough = false;
    this.rttMs = 0;
  }

  /** Pong received at local `now` for a ping sent at `clientTime`. */
  addSample(clientTime: number, serverTime: number, now: number): void {
    const rtt = now - clientTime;
    if (!Number.isFinite(rtt) || rtt < 0) return;
    this.rttMs = this.synced ? this.rttMs + (rtt - this.rttMs) * RTT_SMOOTHING : rtt;
    this.samples.push({ rtt, offset: serverTime + rtt / 2 - now });
    if (this.samples.length > CLOCK_SAMPLES) this.samples.shift();
    let best = this.samples[0] as Sample;
    for (const s of this.samples) if (s.rtt <= best.rtt) best = s; // ties: newest wins
    this.target = best.offset;
    if (!this.synced || Math.abs(this.target - this.currentOffset(now)) > CLOCK_SNAP_MS) {
      this.offset = this.target;
      this.lastNow = now;
    }
    this.synced = true;
  }

  /**
   * Lower-bound hint before any ping sample (welcome / first snapshot): the server clock is at least
   * `serverTime` now. Ignored once real samples exist.
   */
  roughSync(serverTime: number, now: number): void {
    if (this.synced) return;
    const off = serverTime - now;
    if (!this.rough || off > this.offset) {
      this.offset = off;
      this.target = off;
      this.lastNow = now;
      this.rough = true;
    }
  }

  serverNow(now: number): number {
    return now + this.currentOffset(now);
  }

  private currentOffset(now: number): number {
    const elapsed = Math.max(0, now - this.lastNow);
    this.lastNow = Math.max(this.lastNow, now);
    const diff = this.target - this.offset;
    if (diff !== 0) {
      const maxStep = elapsed * CLOCK_SLEW_RATE;
      this.offset += Math.abs(diff) <= maxStep ? diff : Math.sign(diff) * maxStep;
    }
    return this.offset;
  }
}
