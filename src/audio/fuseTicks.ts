/**
 * Positional fuse tick of live grenades near the listener (ADR 0004 A2, IAudio.setGrenades). Pure scheduling: given
 * the frame's grenades and the server clock, decides which grenades tick now. The tick rate speeds up as the fuse runs
 * out, so a grenade at your feet tells you how long you have. Owner: audio-designer.
 */
import type { GrenadeView } from '../shared/contracts';
import type { GrenadeId, Vec3 } from '../shared/types';
import { AUDIO_TUNING } from './cues';
import { dist3 } from './spatial';

/** Seconds between ticks: slow with a full fuse, fast near the end. `left` = remaining / fuse, clamped 0..1. */
export function fuseTickIntervalS(left: number): number {
  const T = AUDIO_TUNING;
  const l = Number.isFinite(left) ? Math.min(1, Math.max(0, left)) : 0;
  return T.fuseTickFastS + (T.fuseTickSlowS - T.fuseTickFastS) * l;
}

export type FuseTickSink = (pos: Vec3, urgency: number) => void;

interface Entry {
  nextAt: number;
  seen: number;
  /** Remaining fuse when first seen (urgency reference while the balance fuse is unknown). */
  firstRemaining: number;
}

export class FuseTicker {
  private readonly next = new Map<GrenadeId, Entry>();
  private stamp = 0;

  /**
   * Plays due ticks through `sink`. `fuseMs` = balance items.grenade.fuseMs (null = unknown: urgency relative to the
   * remaining fuse when the grenade was first seen).
   * Grenades farther than AUDIO_TUNING.fuseTickRangeM are skipped but keep their schedule.
   */
  update(grenades: readonly GrenadeView[], serverTime: number, listener: Vec3, fuseMs: number | null, sink: FuseTickSink): void {
    if (!Number.isFinite(serverTime)) return;
    const stamp = ++this.stamp;
    for (const g of grenades) {
      const remaining = g.explodesAt - serverTime;
      if (!(remaining > 0)) continue;
      let e = this.next.get(g.id);
      if (!e) {
        // First sighting ticks at once (the bounce clink usually precedes it), then on its own beat.
        e = { nextAt: serverTime, seen: stamp, firstRemaining: remaining };
        this.next.set(g.id, e);
      }
      e.seen = stamp;
      if (serverTime < e.nextAt) continue;
      const fuse = fuseMs !== null && fuseMs > 0 ? fuseMs : e.firstRemaining;
      const left = remaining / fuse;
      e.nextAt = serverTime + fuseTickIntervalS(left) * 1000;
      if (dist3(listener, g.pos) > AUDIO_TUNING.fuseTickRangeM) continue;
      sink(g.pos, 1 - Math.min(1, Math.max(0, left)));
    }
    if (this.next.size > 0) this.next.forEach(this.prune);
  }

  /** Drops grenades not in this frame's list (stored callback: no per-frame closure). */
  private readonly prune = (e: Entry, id: GrenadeId): void => {
    if (e.seen !== this.stamp) this.next.delete(id);
  };

  reset(): void {
    this.next.clear();
  }

  /** Tracked grenades (tests). */
  get size(): number {
    return this.next.size;
  }
}
