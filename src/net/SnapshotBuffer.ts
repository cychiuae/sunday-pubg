/**
 * Snapshot ring for remote-entity interpolation (ARCHITECTURE.md §6 "Remote interpolation").
 * Positions lerp, yaw/pitch take the shortest arc, discrete fields come from the newer snapshot.
 * M2a: `stanceProgress` lerps within one transition (see `interpStanceProgress`). Grenades are not interpolated:
 * ClientGame extrapolates them from `latestSnapshot().grenades` (ADR 0004 §3).
 * Clamps to the oldest/newest snapshot (no extrapolation, per INetClient.getInterpolated).
 */
import type { InterpolatedWorld } from '../shared/contracts';
import { lerp, lerpAngle } from '../shared/math';
import type { PlayerState, WorldSnapshot } from '../shared/types';

/** How much history to keep (ms of server time). */
export const BUFFER_KEEP_MS = 1000;
/**
 * A player that moved further than this between two snapshots teleported (drop spawn, new match);
 * show the newer position instead of sliding across the map. Max legit speed is ~10 m/s, so even a
 * 500 ms gap stays under this.
 */
export const TELEPORT_DIST = 8;

/**
 * M2a: stance transition progress at `t` between two snapshots (contracts.ts `InterpolatedWorld`).
 * Lerped only while both snapshots show the same transition (same `stance` and `stanceFrom`) and progress did not
 * go backwards (a new transition with the same endpoints started in between). Otherwise the newer value is used, so a
 * remote never shows a blend between two different transitions.
 */
export function interpStanceProgress(a: PlayerState, b: PlayerState, t: number): number {
  if (a.stance !== b.stance || a.stanceFrom !== b.stanceFrom || b.stanceProgress < a.stanceProgress) {
    return b.stanceProgress;
  }
  return lerp(a.stanceProgress, b.stanceProgress, t);
}

export function interpolatePlayer(a: PlayerState, b: PlayerState, t: number): PlayerState {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const dz = b.pos.z - a.pos.z;
  if (dx * dx + dy * dy + dz * dz > TELEPORT_DIST * TELEPORT_DIST) return b;
  return {
    ...b,
    pos: { x: lerp(a.pos.x, b.pos.x, t), y: lerp(a.pos.y, b.pos.y, t), z: lerp(a.pos.z, b.pos.z, t) },
    velY: lerp(a.velY, b.velY, t),
    yaw: lerpAngle(a.yaw, b.yaw, t),
    pitch: lerpAngle(a.pitch, b.pitch, t),
    stanceProgress: interpStanceProgress(a, b, t),
  };
}

/** Players of `b` lerped from `a` by t in [0, 1]; players in only one snapshot are taken as-is. */
export function interpolatePlayers(a: readonly PlayerState[], b: readonly PlayerState[], t: number): PlayerState[] {
  const fromA = new Map<number, PlayerState>();
  for (const p of a) fromA.set(p.id, p);
  const out: PlayerState[] = [];
  for (const pb of b) {
    const pa = fromA.get(pb.id);
    out.push(pa ? interpolatePlayer(pa, pb, t) : pb);
    fromA.delete(pb.id);
  }
  for (const pa of fromA.values()) out.push(pa);
  return out;
}

export class SnapshotBuffer {
  private snaps: WorldSnapshot[] = [];

  constructor(private readonly keepMs = BUFFER_KEEP_MS) {}

  get size(): number {
    return this.snaps.length;
  }

  clear(): void {
    this.snaps = [];
  }

  latest(): WorldSnapshot | null {
    return this.snaps[this.snaps.length - 1] ?? null;
  }

  /** Adds a snapshot. Duplicates/out-of-order ticks are ignored (returns false). A tick reset clears history. */
  push(s: WorldSnapshot): boolean {
    const last = this.latest();
    if (last) {
      if (s.tick === last.tick) return false;
      if (s.tick < last.tick) {
        // Older than the newest: either a stale reorder (ignore) or the server restarted (tick far back).
        if (last.tick - s.tick < 30) return false;
        this.snaps = [];
      }
    }
    this.snaps.push(s);
    const cutoff = s.serverTime - this.keepMs;
    let drop = 0;
    while (drop < this.snaps.length - 2 && (this.snaps[drop] as WorldSnapshot).serverTime < cutoff) drop++;
    if (drop > 0) this.snaps.splice(0, drop);
    return true;
  }

  sample(renderTime: number): InterpolatedWorld | null {
    const n = this.snaps.length;
    if (n === 0) return null;
    const first = this.snaps[0] as WorldSnapshot;
    const last = this.snaps[n - 1] as WorldSnapshot;
    if (renderTime <= first.serverTime) return { renderTime, players: first.players.slice() };
    if (renderTime >= last.serverTime) return { renderTime, players: last.players.slice() };
    // Newest-first scan: renderTime is normally near the end of the buffer.
    for (let i = n - 1; i > 0; i--) {
      const a = this.snaps[i - 1] as WorldSnapshot;
      if (a.serverTime <= renderTime) {
        const b = this.snaps[i] as WorldSnapshot;
        const span = b.serverTime - a.serverTime;
        const t = span > 0 ? (renderTime - a.serverTime) / span : 1;
        return { renderTime, players: interpolatePlayers(a.players, b.players, t) };
      }
    }
    return { renderTime, players: first.players.slice() };
  }
}
