/**
 * Spectate target selection (GDD §4.4): follow the killer if alive, otherwise any alive player, humans first.
 * Space/click cycles. When the followed player dies, follow their killer if alive. Pure; no events here
 * (ClientGame emits spectateTargetChanged when `update`/`next` report a change).
 */
import type { PlayerId, PlayerState } from '../shared/types';

export type SpectateCandidate = Pick<PlayerState, 'id' | 'alive' | 'isBot'>;

/** Alive players other than `excludeId`, humans first, then by id (stable cycling order). */
export function spectateOrder<T extends SpectateCandidate>(players: readonly T[], excludeId: PlayerId | null): T[] {
  return players
    .filter((p) => p.alive && p.id !== excludeId)
    .sort((a, b) => (a.isBot === b.isBot ? a.id - b.id : a.isBot ? 1 : -1));
}

export class SpectateController {
  private target: PlayerId | null = null;
  private preferred: PlayerId | null = null;

  get targetId(): PlayerId | null {
    return this.target;
  }

  /**
   * A kill happened. If the local player or the current target died, prefer the killer next.
   * (The target switches once the interpolated view shows the victim dead.)
   */
  onKill(victimId: PlayerId, killerId: PlayerId | null, localId: PlayerId | null): void {
    if (victimId === localId || victimId === this.target) this.preferred = killerId;
  }

  /**
   * `candidates` = spectateOrder(...) when spectating, or null when not spectating.
   * Keeps a valid target, otherwise picks the preferred (killer) then the first candidate.
   * Returns true when the target changed.
   */
  update(candidates: readonly SpectateCandidate[] | null): boolean {
    const before = this.target;
    if (candidates === null) {
      this.target = null;
    } else if (!candidates.some((c) => c.id === this.target)) {
      const preferred = candidates.find((c) => c.id === this.preferred);
      this.target = preferred ? preferred.id : (candidates[0]?.id ?? null);
      if (preferred) this.preferred = null;
    }
    return this.target !== before;
  }

  /** Cycle to the next candidate (wraps). Returns true when the target changed. */
  next(candidates: readonly SpectateCandidate[]): boolean {
    if (candidates.length === 0) return false;
    const before = this.target;
    const idx = candidates.findIndex((c) => c.id === this.target);
    this.target = (candidates[(idx + 1) % candidates.length] as SpectateCandidate).id;
    this.preferred = null;
    return this.target !== before;
  }

  /** Forget everything (new match, disconnect). Does not report a change; call update(null) for that. */
  clearPreference(): void {
    this.preferred = null;
  }
}
