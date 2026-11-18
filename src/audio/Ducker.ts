/**
 * Ducking state per bus. Pure (no Web Audio). Owner: audio-designer.
 * Each duck request lowers a bus by `db` (negative) until `now + holdS`. Overlapping ducks do not stack: the deepest
 * active one wins. The engine reads `targetDb` once per frame and ramps a dedicated duck GainNode toward it
 * (fast attack, slow release).
 */
import type { BusId } from './cues';

interface DuckEntry {
  db: number;
  until: number;
}

const MAX_ENTRIES = 8;

export class Ducker {
  private readonly entries: Record<BusId, DuckEntry[]> = { sfx: [], ui: [], ambience: [] };

  duck(bus: BusId, db: number, now: number, holdS: number): void {
    const list = this.entries[bus];
    const entry = { db: Math.min(0, db), until: now + Math.max(0, holdS) };
    if (list.length >= MAX_ENTRIES) {
      // Replace the one that ends soonest.
      let k = 0;
      for (let i = 1; i < list.length; i++) if ((list[i] as DuckEntry).until < (list[k] as DuckEntry).until) k = i;
      list[k] = entry;
    } else list.push(entry);
  }

  /** Deepest active duck in dB (<= 0); 0 when none. Prunes expired entries in place. */
  targetDb(bus: BusId, now: number): number {
    const list = this.entries[bus];
    let db = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i] as DuckEntry;
      if (e.until <= now) {
        list[i] = list[list.length - 1] as DuckEntry;
        list.pop();
      } else if (e.db < db) db = e.db;
    }
    return db;
  }

  clear(): void {
    this.entries.sfx.length = 0;
    this.entries.ui.length = 0;
    this.entries.ambience.length = 0;
  }
}
