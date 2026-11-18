/**
 * Voice bookkeeping with priority-based stealing. Pure (no Web Audio): the engine stores its node handles in `T`.
 * Owner: audio-designer.
 *
 * Admission rules for a new voice of cue C at priority P:
 * 1. If C already has `maxInstances` live voices: steal the lowest-priority (then oldest) instance of C if its
 *    priority <= P, otherwise reject. Rapid fire therefore recycles its own voices instead of evicting others.
 * 2. Else if the pool is full: steal the lowest-priority (then oldest) voice overall if its priority <= P,
 *    otherwise reject.
 * 3. Else admit.
 */

export interface PoolVoice<T> {
  readonly id: number;
  readonly cue: string;
  readonly priority: number;
  readonly startTime: number;
  /** Context time when the voice is finished. Infinity = until stopped. */
  endTime: number;
  readonly handle: T;
}

export type Admission<T> = { kind: 'admit' } | { kind: 'steal'; victim: PoolVoice<T> } | { kind: 'reject' };

const ADMIT = { kind: 'admit' } as const;
const REJECT = { kind: 'reject' } as const;

/** True if a should be stolen before b (lower priority first, then older). */
const worse = <T>(a: PoolVoice<T>, b: PoolVoice<T>): boolean =>
  a.priority < b.priority || (a.priority === b.priority && a.startTime < b.startTime);

export class VoicePool<T> {
  private readonly voices: PoolVoice<T>[] = [];
  private nextId = 1;

  constructor(readonly maxVoices: number) {
    if (!(maxVoices >= 1)) throw new Error('VoicePool: maxVoices must be >= 1');
  }

  get size(): number {
    return this.voices.length;
  }

  countOf(cue: string): number {
    let n = 0;
    for (const v of this.voices) if (v.cue === cue) n++;
    return n;
  }

  admit(cue: string, priority: number, maxInstances: number): Admission<T> {
    let sameCount = 0;
    let sameWorst: PoolVoice<T> | null = null;
    let worst: PoolVoice<T> | null = null;
    for (const v of this.voices) {
      if (v.cue === cue) {
        sameCount++;
        if (!sameWorst || worse(v, sameWorst)) sameWorst = v;
      }
      if (!worst || worse(v, worst)) worst = v;
    }
    if (sameCount >= Math.max(1, maxInstances)) {
      return sameWorst && sameWorst.priority <= priority ? { kind: 'steal', victim: sameWorst } : REJECT;
    }
    if (this.voices.length >= this.maxVoices) {
      return worst && worst.priority <= priority ? { kind: 'steal', victim: worst } : REJECT;
    }
    return ADMIT;
  }

  add(cue: string, priority: number, startTime: number, endTime: number, handle: T): PoolVoice<T> {
    const v: PoolVoice<T> = { id: this.nextId++, cue, priority, startTime, endTime, handle };
    this.voices.push(v);
    return v;
  }

  /** Removes the voice (swap-pop). Returns false if it was not in the pool. */
  remove(voice: PoolVoice<T>): boolean {
    const i = this.voices.indexOf(voice);
    if (i < 0) return false;
    const last = this.voices.pop() as PoolVoice<T>;
    if (i < this.voices.length) this.voices[i] = last;
    return true;
  }

  has(voice: PoolVoice<T>): boolean {
    return this.voices.includes(voice);
  }

  /** Removes every voice with endTime <= now, calling onEnded for each. Allocation-free. */
  reap(now: number, onEnded: (v: PoolVoice<T>) => void): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i] as PoolVoice<T>;
      if (v.endTime <= now) {
        const last = this.voices.pop() as PoolVoice<T>;
        if (i < this.voices.length) this.voices[i] = last;
        onEnded(v);
      }
    }
  }

  /** Removes everything, calling onEnded for each (dispose). */
  clear(onEnded: (v: PoolVoice<T>) => void): void {
    while (this.voices.length > 0) onEnded(this.voices.pop() as PoolVoice<T>);
  }
}
