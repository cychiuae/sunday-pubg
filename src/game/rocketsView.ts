/**
 * M2c rockets on the client (rpg.md, ADR 0007 §4, §9.2). Owner: game-developer.
 *
 * A rocket is its immutable launch record (`RocketState`); its position at any server time is the shared closed form
 * `rocketPosAt` (src/shared/rocket.ts), the same function the sim samples every tick, so there is no extrapolation
 * drift and no per-tick rocket data. Sources: `WorldSnapshot.rockets` (late joiners, carried forward) and the
 * `rocketFired` event (arrives before the next snapshot). A rocket ends on its `explosion` (source 'rocket') or
 * `rocketDud` event; ended ids never come back from a stale list. Safety net: a rocket is dropped once it is older than
 * its max flight time (range / speed) plus ROCKET_END_GRACE_MS (the end event was lost).
 */
import type { Balance } from '../shared/balance';
import type { RocketView } from '../shared/contracts';
import { rocketPosAt, rocketVelAt } from '../shared/rocket';
import type { RocketId, RocketState } from '../shared/types';

/** Extra ms past the max flight time before a rocket whose end event never arrived is dropped (not a feel number). */
export const ROCKET_END_GRACE_MS = 1000;

export class RocketTracker {
  private readonly live = new Map<RocketId, RocketState>();
  private readonly ended = new Set<RocketId>();

  reset(): void {
    this.live.clear();
    this.ended.clear();
  }

  get size(): number {
    return this.live.size;
  }

  /** WorldSnapshot.rockets at `serverTime`: adds unknown rockets and removes those the server no longer lists. */
  onSnapshot(rockets: readonly RocketState[], serverTime: number): void {
    const listed = new Set<RocketId>();
    for (const r of rockets) {
      listed.add(r.id);
      if (!this.ended.has(r.id) && !this.live.has(r.id)) this.live.set(r.id, cloneRocket(r));
    }
    // A rocket fired after this snapshot's tick (event first) is not in the list yet: keep it.
    for (const [id, r] of this.live) if (!listed.has(id) && r.firedAt <= serverTime) this.live.delete(id);
  }

  /** SimEvent rocketFired (= the launch record). */
  onFired(r: RocketState): void {
    if (!this.ended.has(r.id)) this.live.set(r.id, cloneRocket(r));
  }

  /** explosion (source 'rocket') or rocketDud. */
  onEnded(id: RocketId): void {
    this.live.delete(id);
    this.ended.add(id);
  }

  /** Every live rocket at server time `now`, sorted by id. */
  views(now: number, balance: Balance): RocketView[] {
    const rpg = balance.weapons.rpg;
    const g = rpg.rocket.gravity;
    const maxFlightMs = rpg.rocket.speed > 0 ? (rpg.range / rpg.rocket.speed) * 1000 + ROCKET_END_GRACE_MS : Infinity;
    const out: RocketView[] = [];
    for (const [id, r] of this.live) {
      if (now - r.firedAt > maxFlightMs) {
        this.live.delete(id);
        continue;
      }
      out.push({
        id: r.id,
        ownerId: r.ownerId,
        level: r.level,
        pos: rocketPosAt(r, now, g),
        vel: rocketVelAt(r, now, g),
        origin: { ...r.pos },
        firedAt: r.firedAt,
      });
    }
    return out.sort((a, b) => a.id - b.id);
  }
}

const cloneRocket = (r: RocketState): RocketState => ({
  id: r.id,
  ownerId: r.ownerId,
  level: r.level,
  pos: { ...r.pos },
  vel: { ...r.vel },
  firedAt: r.firedAt,
});
