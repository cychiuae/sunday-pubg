/**
 * Client-derived bus events (ARCHITECTURE §7 "Client-derived"): phase changes, countdown ticks, zone changes and
 * warnings, zone in/out, interact prompt, footsteps and remote jump/land. Each tracker is small, pure state plus
 * an emit; ClientGame calls them at fixed points in update().
 */
import type { EventBus, GameEvents } from '../shared/events';
import type { LootState, MatchState, PlayerId, PlayerState, Surface, Vec3, ZoneState } from '../shared/types';
import { secondsUntil } from './zoneView';

export type Bus = Pick<EventBus<GameEvents>, 'emit'>;
export type SurfaceFn = (x: number, z: number) => Surface;

/** matchPhaseChanged on every phase transition, and once on the first snapshot (prev = null). */
export class PhaseTracker {
  private prev: MatchState['phase'] | null = null;

  get phase(): MatchState['phase'] | null {
    return this.prev;
  }

  onSnapshot(match: MatchState, bus: Bus): void {
    if (match.phase === this.prev) return;
    const prev = this.prev;
    this.prev = match.phase;
    bus.emit('matchPhaseChanged', { phase: match.phase, prev, endsAt: match.phaseEndsAt });
  }

  reset(): void {
    this.prev = null;
  }
}

/** countdown once per whole second N..1 while `endsAt` is set (countdown phase). */
export class CountdownTracker {
  private last: number | null = null;
  private endsAt: number | null = null;

  update(endsAt: number | null, now: number, bus: Bus): void {
    if (endsAt === null) {
      this.last = null;
      this.endsAt = null;
      return;
    }
    if (endsAt !== this.endsAt) {
      this.endsAt = endsAt;
      this.last = null;
    }
    const s = secondsUntil(endsAt, now);
    // Only count down (ignore clock-sync jitter that would make the value bounce up by one).
    if (this.last !== null && s >= this.last) return;
    this.last = s;
    if (s >= 1) bus.emit('countdown', { secondsLeft: s });
  }
}

/** zoneChanged (first zone, phaseIndex change, shrinking flag change) and zoneWarning (once per phase). */
export class ZoneTracker {
  private prevPhase: number | null = null;
  private prevShrinking = false;
  private warnedKey: string | null = null;

  onSnapshot(zone: ZoneState | null, bus: Bus): void {
    if (!zone) {
      this.prevPhase = null;
      return;
    }
    if (this.prevPhase === null || zone.phaseIndex !== this.prevPhase || zone.shrinking !== this.prevShrinking) {
      bus.emit('zoneChanged', { zone });
    }
    this.prevPhase = zone.phaseIndex;
    this.prevShrinking = zone.shrinking;
  }

  /** `warningSeconds` = balance.zone.warningSecondsBeforeShrink. Covers the final collapse hold too. */
  updateWarning(zone: ZoneState | null, now: number, matchId: number, warningSeconds: number, bus: Bus): void {
    if (!zone || zone.shrinking || zone.phaseIndex < 0 || zone.phaseIndex > zone.phaseCount) return;
    const secs = (zone.phaseEndsAt - now) / 1000;
    if (secs <= 0 || secs > warningSeconds) return;
    const key = `${matchId}:${zone.phaseIndex}`;
    if (this.warnedKey === key) return;
    this.warnedKey = key;
    bus.emit('zoneWarning', { phaseIndex: zone.phaseIndex, secondsUntilShrink: Math.ceil(secs) });
  }

  reset(): void {
    this.prevPhase = null;
    this.prevShrinking = false;
    this.warnedKey = null;
  }
}

/** localZoneStatusChanged on each crossing of the safe-zone edge. Starts "inside". */
export class ZoneStatusTracker {
  private outside = false;

  get isOutside(): boolean {
    return this.outside;
  }

  set(outside: boolean, bus: Bus): void {
    if (outside === this.outside) return;
    this.outside = outside;
    bus.emit('localZoneStatusChanged', { outside });
  }
}

/** Nearest loot within `range` (3D distance from the feet, GDD §7.5), or null. */
export function findNearestLoot(loot: readonly LootState[], pos: Vec3, range: number): LootState | null {
  let best: LootState | null = null;
  let bestD = range * range;
  for (const l of loot) {
    const d = (l.pos.x - pos.x) ** 2 + (l.pos.y - pos.y) ** 2 + (l.pos.z - pos.z) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = l;
    }
  }
  return best;
}

/** interactPromptChanged when the nearest pickable loot (id, item or qty) changes. */
export class InteractPromptTracker {
  private lootId: number | null = null;
  private item: LootState['item'] | null = null;
  private qty = 0;

  get currentLootId(): number | null {
    return this.lootId;
  }

  set(loot: LootState | null, bus: Bus): void {
    const id = loot ? loot.id : null;
    const item = loot ? loot.item : null;
    const qty = loot ? loot.qty : 0;
    if (id === this.lootId && item === this.item && qty === this.qty) return;
    this.lootId = id;
    this.item = item;
    this.qty = qty;
    bus.emit('interactPromptChanged', { lootId: id, item, qty });
  }
}

/** Distance-based footstep cadence per player. */
export class StrideCounter {
  private readonly acc = new Map<PlayerId, number>();

  /** Adds horizontal distance; returns true when a footstep should play. */
  add(id: PlayerId, distance: number, stride: number): boolean {
    if (!(stride > 0)) return false;
    const total = (this.acc.get(id) ?? 0) + distance;
    if (total >= stride) {
      this.acc.set(id, total % stride);
      return true;
    }
    this.acc.set(id, total);
    return false;
  }

  clear(id: PlayerId): void {
    this.acc.delete(id);
  }

  reset(): void {
    this.acc.clear();
  }
}

export interface MotionTuning {
  footstepStrideWalk: number;
  footstepStrideSprint: number;
  maxFrameTravel: number;
}

interface RemoteSample {
  pos: Vec3;
  airborne: boolean;
  velY: number;
  alive: boolean;
}

/**
 * Remote footstep/jump/land from interpolated states frame to frame (ARCHITECTURE §7: remotes from
 * anim.airborne and position deltas).
 */
export class RemoteMotionTracker {
  private readonly prev = new Map<PlayerId, RemoteSample>();
  private readonly strides = new StrideCounter();

  update(players: readonly PlayerState[], skipId: PlayerId | null, surfaceAt: SurfaceFn, tuning: MotionTuning, bus: Bus): void {
    const seen = new Set<PlayerId>();
    for (const p of players) {
      if (p.id === skipId) continue;
      seen.add(p.id);
      const before = this.prev.get(p.id);
      this.prev.set(p.id, { pos: { ...p.pos }, airborne: p.anim.airborne, velY: p.velY, alive: p.alive });
      if (!before || !p.alive || !before.alive) continue;

      if (!before.airborne && p.anim.airborne && !p.anim.dropping && p.velY > 0) {
        bus.emit('jump', { playerId: p.id, pos: { ...p.pos }, isLocal: false });
      }
      if (before.airborne && !p.anim.airborne) {
        bus.emit('land', {
          playerId: p.id,
          pos: { ...p.pos },
          fallSpeed: Math.max(0, -before.velY),
          surface: surfaceAt(p.pos.x, p.pos.z),
          isLocal: false,
        });
        this.strides.clear(p.id);
      }
      if (p.anim.airborne || p.anim.dropping) continue;
      const dist = Math.hypot(p.pos.x - before.pos.x, p.pos.z - before.pos.z);
      if (dist > tuning.maxFrameTravel) continue;
      const stride = p.anim.sprinting ? tuning.footstepStrideSprint : tuning.footstepStrideWalk;
      if (this.strides.add(p.id, dist, stride)) {
        bus.emit('footstep', {
          playerId: p.id,
          pos: { ...p.pos },
          surface: surfaceAt(p.pos.x, p.pos.z),
          sprinting: p.anim.sprinting,
          isLocal: false,
        });
      }
    }
    for (const id of [...this.prev.keys()]) {
      if (!seen.has(id)) {
        this.prev.delete(id);
        this.strides.clear(id);
      }
    }
  }

  reset(): void {
    this.prev.clear();
    this.strides.reset();
  }
}
