/**
 * Turns GameEvents into audio commands. Holds the small amount of state the mapping needs (last armor per victim as
 * a fallback when `playerDamaged.armorBefore` is absent, local HP for the heartbeat, tide shrinking flag). Pure: no Web Audio, no DOM, so the whole mapping is unit-tested.
 * Owner: audio-designer. The AudioEngine executes the commands.
 */
import type { GameEvents } from '../shared/events';
import type { PlayerId, Vec3 } from '../shared/types';
import { AUDIO_TUNING, type BusId, type CueId } from './cues';
import {
  countdownIntensity,
  hitKind,
  impactCue,
  itemClass,
  landIntensity,
  pickupCue,
  selectImpacts,
  shotCue,
  type HitKind,
} from './soundMap';

export interface PlayCommand {
  kind: 'play';
  cue: CueId;
  /** null = 2D (local / UI). */
  pos: Vec3 | null;
  /** Recipe variant: weapon id, surface, item id, hit kind... */
  variant?: string;
  /** 0..1 recipe intensity (sprint, landing speed, last countdown seconds...). */
  intensity?: number;
  /** Extra linear gain multiplier. */
  gain?: number;
  /** Starting a keyed voice stops the previous voice with the same key. */
  loopKey?: string;
  /** Length for loops / timed voices, seconds. */
  durationS?: number;
}

export type AudioCommand =
  | PlayCommand
  | { kind: 'stop'; loopKey: string }
  | { kind: 'stopLoops' }
  | { kind: 'duck'; bus: BusId; db: number; holdS: number }
  | { kind: 'lowHealth'; active: boolean }
  | { kind: 'surf'; active: boolean };

export type CommandSink = (cmd: AudioCommand) => void;

export const LOOP_KEY = {
  reload: (id: PlayerId): string => `reload:${id}`,
  heal: (id: PlayerId): string => `heal:${id}`,
  drop: 'drop',
  tide: 'tide',
} as const;

/** Ducking presets (dB, hold seconds). */
export const DUCKS = {
  localDamage: { bus: 'ambience', db: -9, holdS: 0.35 },
  zoneTick: { bus: 'ambience', db: -4, holdS: 0.2 },
  zoneWarning: { bus: 'ambience', db: -6, holdS: 2.2 },
  death: { bus: 'ambience', db: -10, holdS: 2.5 },
  victorySfx: { bus: 'sfx', db: -8, holdS: 3 },
  victoryAmb: { bus: 'ambience', db: -8, holdS: 3 },
} as const satisfies Record<string, { bus: BusId; db: number; holdS: number }>;

export interface AudioDirectorOptions {
  /** Local HP at or below this (and above 0) runs the heartbeat. Default AUDIO_TUNING.lowHealthHp. */
  lowHealthHp?: number;
}

export class AudioDirector {
  /** Fallback only: last known armor per victim, used when playerDamaged.armorBefore is absent. */
  private readonly armor = new Map<PlayerId, number>();
  private readonly pendingHit = new Map<PlayerId, HitKind>();
  private localHp: number | null = null;
  private lowHealth = false;
  private zoneShrinking = false;
  private outside = false;
  private lastPromptLoot: number | null = null;

  private readonly lowHealthHp: number;

  constructor(
    private readonly sink: CommandSink,
    options: AudioDirectorOptions = {},
  ) {
    const t = options.lowHealthHp;
    this.lowHealthHp = t !== undefined && Number.isFinite(t) && t > 0 ? t : AUDIO_TUNING.lowHealthHp;
  }

  // --- match flow -------------------------------------------------------------------------
  matchPhaseChanged(e: GameEvents['matchPhaseChanged']): void {
    if (e.phase === 'playing' && e.prev === 'countdown') this.play('ui.matchStart', null);
    if (e.phase === 'lobby' || e.phase === 'results') this.resetMatchState();
  }

  countdown(e: GameEvents['countdown']): void {
    if (e.secondsLeft <= 0) return;
    this.play('ui.countdown', null, { intensity: countdownIntensity(e.secondsLeft) });
  }

  localPlayerSpawned(_e: GameEvents['localPlayerSpawned']): void {
    this.localHp = null;
    this.setLowHealth(false);
    this.armor.clear();
    this.pendingHit.clear();
    this.play('drop.wind', null, { loopKey: LOOP_KEY.drop, durationS: AUDIO_TUNING.dropWindMaxS });
  }

  matchEnded(e: GameEvents['matchEnded']): void {
    if (e.isLocalWinner) {
      this.play('ui.victory', null);
      this.duck(DUCKS.victorySfx);
      this.duck(DUCKS.victoryAmb);
    } else if (e.localPlacement !== null) {
      this.play('ui.results', null);
    }
  }

  // --- combat -----------------------------------------------------------------------------
  shotFired(e: GameEvents['shotFired']): void {
    this.play(shotCue(e.weapon, e.isLocal), e.isLocal ? null : e.origin, { variant: e.weapon });
    for (const imp of selectImpacts(e.impacts)) {
      const cue = impactCue(imp.surface);
      if (cue) this.play(cue, imp.point, { variant: e.weapon });
    }
  }

  dryFire(e: GameEvents['dryFire']): void {
    this.play('weapon.dryFire', null, { variant: e.weapon });
  }

  playerDamaged(e: GameEvents['playerDamaged']): void {
    // M1-fix: armorBefore (Contract revision 1 #2) is authoritative; the per-victim tracking is the fallback.
    const before = e.armorBefore !== undefined && Number.isFinite(e.armorBefore) ? e.armorBefore : this.armor.get(e.victimId);
    const kind = hitKind(before, e.armorAfter);
    this.armor.set(e.victimId, e.armorAfter);
    const intensity = Math.min(1, e.amount / 40);

    if (e.isLocalVictim) {
      if (e.cause === 'zone') {
        this.play('zone.hurtTick', null);
        this.duck(DUCKS.zoneTick);
      } else if (e.cause === 'fall') {
        this.play('damage.fall', null, { intensity });
        this.duck(DUCKS.localDamage);
      } else {
        const cue: CueId = kind === 'armor' ? 'damage.armor' : kind === 'armorBreak' ? 'damage.armorBreak' : 'damage.hp';
        this.play(cue, null, { intensity, variant: e.headshot ? 'head' : 'body' });
        this.duck(DUCKS.localDamage);
      }
      this.localHp = e.hpAfter;
      this.updateLowHealth();
    }
    if (e.isLocalAttacker && !e.isLocalVictim) {
      this.pendingHit.set(e.victimId, kind);
    } else if (!e.isLocalVictim && e.cause === 'weapon') {
      this.play('hit.remote', e.victimPos, { variant: kind, intensity });
    }
  }

  localHitConfirmed(e: GameEvents['localHitConfirmed']): void {
    const kind = this.pendingHit.get(e.victimId) ?? 'body';
    this.pendingHit.delete(e.victimId);
    const intensity = Math.min(1, e.amount / 40);
    if (e.killed) {
      this.play('hitConfirm.kill', null);
      if (e.headshot) this.play('hitConfirm.head', null, { gain: 0.7 });
      return;
    }
    if (kind === 'armorBreak') {
      this.play('hitConfirm.armorBreak', null);
      if (e.headshot) this.play('hitConfirm.head', null, { gain: 0.7 });
    } else if (e.headshot) this.play('hitConfirm.head', null, { intensity });
    else if (kind === 'armor') this.play('hitConfirm.armor', null, { intensity });
    else this.play('hitConfirm.body', null, { intensity });
  }

  playerKilled(e: GameEvents['playerKilled']): void {
    this.armor.delete(e.victimId);
    this.pendingHit.delete(e.victimId);
    this.stop(LOOP_KEY.reload(e.victimId));
    this.stop(LOOP_KEY.heal(e.victimId));
    if (e.isLocalVictim) {
      // Own reload/heal loops were stopped above; the tide loop keeps going for spectating.
      this.stop(LOOP_KEY.drop);
      this.setLowHealth(false);
      this.setSurf(false);
      this.localHp = null;
      this.play('ui.defeat', null);
      this.duck(DUCKS.death);
    } else {
      // M1-fix: playerKilled.headshot (absent = unknown = body) adds a "tok" layer to the remote death.
      this.play('death.remote', e.victimPos, { gain: e.isLocalKiller ? 0.8 : 1, variant: e.headshot === true ? 'head' : 'body' });
    }
  }

  // --- items ------------------------------------------------------------------------------
  itemPickedUp(e: GameEvents['itemPickedUp']): void {
    this.play(pickupCue(e.item), e.isLocal ? null : e.pos, { variant: e.item });
  }

  reloadStarted(e: GameEvents['reloadStarted']): void {
    this.play('reload.start', e.isLocal ? null : e.pos, {
      variant: e.weapon,
      loopKey: LOOP_KEY.reload(e.playerId),
      // Shotgun shells are scheduled across this; stopped early on cancel.
      durationS: e.durationMs / 1000,
    });
  }

  reloadFinished(e: GameEvents['reloadFinished']): void {
    this.stop(LOOP_KEY.reload(e.playerId));
    if (e.completed) this.play('reload.finish', e.isLocal ? null : e.pos, { variant: e.weapon });
  }

  healStarted(e: GameEvents['healStarted']): void {
    const pos = e.isLocal ? null : e.pos;
    this.play('heal.start', pos, { variant: e.item });
    this.play('heal.loop', pos, {
      variant: e.item,
      loopKey: LOOP_KEY.heal(e.playerId),
      durationS: e.durationMs / 1000 + AUDIO_TUNING.loopSafetyS,
    });
  }

  healFinished(e: GameEvents['healFinished']): void {
    this.stop(LOOP_KEY.heal(e.playerId));
    this.play('heal.finish', e.isLocal ? null : e.pos, { variant: e.item });
    if (e.isLocal) {
      this.localHp = e.hpAfter;
      this.updateLowHealth();
    }
  }

  healCancelled(e: GameEvents['healCancelled']): void {
    this.stop(LOOP_KEY.heal(e.playerId));
    if (e.isLocal) this.play('heal.cancel', null, { variant: e.item });
  }

  weaponSwitched(e: GameEvents['weaponSwitched']): void {
    // M1-fix: remote switches are positional at `pos` (Contract revision 1 #3); silent while `pos` is absent.
    if (e.isLocal) this.play('weapon.switch', null, { variant: e.weapon });
    else if (e.pos) this.play('weapon.switch', e.pos, { variant: e.weapon });
  }

  /** M1-fix (Contract revision 1 #5): soft refusal cue for the local player's refused edge actions. */
  actionFailed(e: GameEvents['actionFailed']): void {
    // 'fire' refusals are voiced by the local dryFire event; never double them.
    if (!e.isLocal || e.action === 'fire') return;
    this.play('ui.nope', null, { variant: e.reason });
  }

  // --- tide -------------------------------------------------------------------------------
  zoneChanged(e: GameEvents['zoneChanged']): void {
    const shrinking = e.zone.shrinking;
    if (shrinking && !this.zoneShrinking) {
      this.play('zone.tideRising', null);
      this.play('zone.tideLoop', null, { loopKey: LOOP_KEY.tide, durationS: AUDIO_TUNING.tideLoopMaxS });
    } else if (!shrinking && this.zoneShrinking) {
      this.stop(LOOP_KEY.tide);
    }
    this.zoneShrinking = shrinking;
  }

  zoneWarning(e: GameEvents['zoneWarning']): void {
    this.play('zone.warning', null, { intensity: e.phaseIndex >= 2 ? 1 : 0 });
    this.duck(DUCKS.zoneWarning);
  }

  localZoneStatusChanged(e: GameEvents['localZoneStatusChanged']): void {
    if (e.outside === this.outside) return;
    this.play(e.outside ? 'zone.enterSurf' : 'zone.exitSurf', null);
    this.setSurf(e.outside);
  }

  // --- movement ---------------------------------------------------------------------------
  footstep(e: GameEvents['footstep']): void {
    this.play(e.isLocal ? 'foot.local' : 'foot.remote', e.isLocal ? null : e.pos, {
      variant: e.surface,
      intensity: e.sprinting ? 1 : 0.55,
    });
  }

  jump(e: GameEvents['jump']): void {
    this.play(e.isLocal ? 'jump.local' : 'jump.remote', e.isLocal ? null : e.pos);
  }

  land(e: GameEvents['land']): void {
    if (e.isLocal) {
      this.stop(LOOP_KEY.drop);
      this.play('land.local', null, { variant: e.surface, intensity: landIntensity(e.fallSpeed) });
      return;
    }
    if (e.fallSpeed < AUDIO_TUNING.remoteLandMinSpeed) return;
    this.play('land.remote', e.pos, { variant: e.surface, intensity: landIntensity(e.fallSpeed) });
  }

  // --- UI-ish -----------------------------------------------------------------------------
  interactPromptChanged(e: GameEvents['interactPromptChanged']): void {
    if (e.lootId !== null && e.lootId !== this.lastPromptLoot && e.item !== null) {
      this.play('ui.prompt', null, { variant: itemClass(e.item) });
    }
    this.lastPromptLoot = e.lootId;
  }

  spectateTargetChanged(e: GameEvents['spectateTargetChanged']): void {
    if (e.targetId !== null) this.play('ui.spectate', null);
  }

  connectionStatus(e: GameEvents['connectionStatus']): void {
    if (e.status === 'disconnected' || e.status === 'error') this.play('ui.error', null);
  }

  /** Current local HP as tracked from events (null = unknown/full). For tests and debugging. */
  get trackedLocalHp(): number | null {
    return this.localHp;
  }

  reset(): void {
    this.resetMatchState();
    this.lastPromptLoot = null;
  }

  // --- internals --------------------------------------------------------------------------
  private resetMatchState(): void {
    this.armor.clear();
    this.pendingHit.clear();
    this.localHp = null;
    this.setLowHealth(false);
    this.setSurf(false);
    if (this.zoneShrinking) this.stop(LOOP_KEY.tide);
    this.zoneShrinking = false;
    this.sink({ kind: 'stopLoops' });
  }

  private updateLowHealth(): void {
    const hp = this.localHp;
    this.setLowHealth(hp !== null && hp > 0 && hp <= this.lowHealthHp);
  }

  private setLowHealth(active: boolean): void {
    if (active === this.lowHealth) return;
    this.lowHealth = active;
    this.sink({ kind: 'lowHealth', active });
  }

  private setSurf(active: boolean): void {
    if (active === this.outside) return;
    this.outside = active;
    this.sink({ kind: 'surf', active });
  }

  private play(cue: CueId, pos: Vec3 | null, opts?: Omit<PlayCommand, 'kind' | 'cue' | 'pos'>): void {
    this.sink({ kind: 'play', cue, pos, ...opts });
  }

  private stop(loopKey: string): void {
    this.sink({ kind: 'stop', loopKey });
  }

  private duck(d: { bus: BusId; db: number; holdS: number }): void {
    this.sink({ kind: 'duck', bus: d.bus, db: d.db, holdS: d.holdS });
  }
}
