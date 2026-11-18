/**
 * Turns GameEvents into audio commands. Holds the small amount of state the mapping needs (local HP for the
 * heartbeat, zone shrinking flag and theme, each player's last stance as a footstep fallback, each live grenade's last
 * contact surface for the water blast, the per-map balance, and the carrier-drop tracker). Pure: no Web Audio, no DOM,
 * so the whole mapping is unit-tested. Owner: audio-designer. The AudioEngine executes the commands.
 */
import type { Balance, ZoneTheme } from '../shared/balance';
import type { GameEvents } from '../shared/events';
import { stanceTransitionKey, type GrenadeId, type PlayerId, type Stance, type Vec3 } from '../shared/types';
import { AUDIO_TUNING, type BusId, type CueId } from './cues';
import { DropTracker } from './drop';
import {
  armorPieces,
  blastCloseness,
  bounceIntensity,
  confirmArmorCue,
  countdownIntensity,
  damageArmorCue,
  footCue,
  impactCue,
  isWaterBlast,
  itemClass,
  landIntensity,
  pickupCue,
  remoteHitVariant,
  sceneOf,
  selectImpacts,
  shotCue,
  zoneThemeCues,
  type AmbienceScene,
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
  /** Local player outside the safe zone: surf (island), spray (sprinklers) or dark (lights out) in the ambience. */
  | { kind: 'outside'; active: boolean }
  /** M2b: switch the ambience scene (and the indoor reverb) for a new map; `theme` picks the zone layers. */
  | { kind: 'map'; scene: AmbienceScene; theme: ZoneTheme }
  /** M2b: the persistent zone bed (indoor sprinkler rain once the first shrink has started). */
  | { kind: 'zoneBed'; active: boolean }
  /**
   * Low-pass the sfx + ambience buses (inside a blast radius): down to `cutoffHz` after `delayS`, held `holdS`, then
   * recovering. A newer muffle replaces an older one.
   */
  | { kind: 'muffle'; cutoffHz: number; delayS: number; holdS: number };

export type CommandSink = (cmd: AudioCommand) => void;

export const LOOP_KEY = {
  reload: (id: PlayerId): string => `reload:${id}`,
  heal: (id: PlayerId): string => `heal:${id}`,
  bolt: (id: PlayerId): string => `bolt:${id}`,
  cook: 'cook',
  /** The theme's zone loop while the zone shrinks (tide or sprinkler rain). */
  zone: 'zone',
} as const;

/** Ducking presets (dB, hold seconds). */
export const DUCKS = {
  localDamage: { bus: 'ambience', db: -9, holdS: 0.35 },
  zoneTick: { bus: 'ambience', db: -4, holdS: 0.2 },
  zoneWarning: { bus: 'ambience', db: -6, holdS: 2.2 },
  death: { bus: 'ambience', db: -10, holdS: 2.5 },
  victorySfx: { bus: 'sfx', db: -8, holdS: 3 },
  victoryAmb: { bus: 'ambience', db: -8, holdS: 3 },
  /** Blast inside 2 x radius but outside the radius. */
  explosionNear: { bus: 'ambience', db: -6, holdS: 0.8 },
  /** Blast inside the radius (with the muffle and the ear ring). */
  explosionClose: { bus: 'ambience', db: -14, holdS: 2 },
} as const satisfies Record<string, { bus: BusId; db: number; holdS: number }>;

export interface AudioDirectorOptions {
  /** Local HP at or below this (and above 0) runs the heartbeat. Default AUDIO_TUNING.lowHealthHp. */
  lowHealthHp?: number;
  /**
   * Sniper bolt timing and grenade fuse come from here until the first mapChanged, whose per-map balance replaces it
   * (REVIEW-M2a M5: no global BALANCE fallback). Without either, the bolt cycle and the cook tick are skipped.
   */
  balance?: Balance;
}

/** Cap on remembered grenade contacts (explosion events normally clear them). */
const MAX_TRACKED_GRENADES = 64;

export class AudioDirector {
  /** Last stance per player from stanceChanged (target stance). Absent = standing. */
  private readonly stances = new Map<PlayerId, Stance>();
  /** Last contact surface per live grenade (water blast variant). */
  private readonly grenadeContact = new Map<GrenadeId, string>();
  private localHp: number | null = null;
  private lowHealth = false;
  private zoneShrinking = false;
  /** The theme's persistent zone bed has been switched on this match. */
  private zoneBedOn = false;
  private outside = false;
  private lastPromptLoot: number | null = null;
  private theme: ZoneTheme = 'tide';

  private lowHealthHp: number;
  private boltCycleS: number | null = null;
  private fuseS: number | null = null;

  /** M2b: carrier and local drop state; the engine reads its per-frame mix. */
  readonly drop = new DropTracker();

  constructor(
    private readonly sink: CommandSink,
    options: AudioDirectorOptions = {},
  ) {
    const t = options.lowHealthHp;
    this.lowHealthHp = t !== undefined && Number.isFinite(t) && t > 0 ? t : AUDIO_TUNING.lowHealthHp;
    if (options.balance) this.setBalance(options.balance);
  }

  /** Effective balance for the current match (mapChanged.balance). */
  setBalance(b: Balance): void {
    const bolt = b.weapons.sniper.fireIntervalMs;
    const fuse = b.items.grenade.fuseMs;
    this.boltCycleS = Number.isFinite(bolt) && bolt > 0 ? bolt / 1000 : null;
    this.fuseS = Number.isFinite(fuse) && fuse > 0 ? fuse / 1000 : null;
    // Heartbeat threshold follows the per-map balance when it sets one (the injected value stays otherwise).
    const low = b.player.lowHpThreshold;
    if (low !== undefined && Number.isFinite(low) && low > 0) this.lowHealthHp = low;
  }

  /** Grenade fuse in ms from the current balance, or null before any balance (FuseTicker). */
  get fuseMs(): number | null {
    return this.fuseS === null ? null : this.fuseS * 1000;
  }

  get zoneTheme(): ZoneTheme {
    return this.theme;
  }

  // --- maps (M2b) -------------------------------------------------------------------------
  /**
   * The active map changed: per-map balance, zone theme, carrier model and ambience scene. Also a match boundary, so
   * every loop and tracked state is reset.
   */
  mapChanged(e: GameEvents['mapChanged']): void {
    this.setBalance(e.balance);
    this.resetMatchState();
    this.theme = e.zoneTheme;
    const indoor = e.map.kind === 'indoor';
    this.drop.setModel(e.map.carrier ?? (indoor ? 'drone' : 'seaplane'));
    this.sink({ kind: 'map', scene: sceneOf(e.map.kind), theme: e.zoneTheme });
  }

  // --- carrier drop (M2b) -----------------------------------------------------------------
  carrierDeparted(e: GameEvents['carrierDeparted']): void {
    this.drop.carrierDeparted(e.route);
  }

  /** Hatch whoosh: big and 2D for you (with the door rush), positional at the carrier for others. */
  playerJumped(e: GameEvents['playerJumped']): void {
    this.drop.jumped(e.playerId, e.isLocal);
    this.play('drop.jump', e.isLocal ? null : e.pos, { intensity: e.isLocal ? 1 : 0, variant: e.auto ? 'auto' : 'manual' });
  }

  /** Canopy pop (the flutter bed follows from the tracker). Remote pops are landing intel. */
  parachuteOpened(e: GameEvents['parachuteOpened']): void {
    this.drop.chuteOpened(e.playerId, e.isLocal);
    this.play('drop.chutePop', e.isLocal ? null : e.pos, { intensity: e.isLocal ? 1 : 0 });
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

  /** M2b: players spawn aboard the carrier; the drop sounds start from carrierDeparted / playerJumped. */
  localPlayerSpawned(e: GameEvents['localPlayerSpawned']): void {
    this.localHp = null;
    this.setLowHealth(false);
    this.stances.delete(e.playerId);
    this.drop.localSpawned(e.playerId);
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
    if (e.weapon === 'sniper' && this.boltCycleS !== null) {
      // The lock click lands exactly fireIntervalMs after the shot (combat.md: enemies can count the gap).
      this.play('weapon.bolt', e.isLocal ? null : e.origin, {
        variant: e.weapon,
        loopKey: LOOP_KEY.bolt(e.shooterId),
        durationS: this.boltCycleS,
      });
    }
  }

  dryFire(e: GameEvents['dryFire']): void {
    this.play('weapon.dryFire', null, { variant: e.weapon });
  }

  playerDamaged(e: GameEvents['playerDamaged']): void {
    const intensity = Math.min(1, e.amount / 40);
    const pieces = armorPieces(e);

    if (e.isLocalVictim) {
      if (e.cause === 'zone') {
        this.play('zone.hurtTick', null);
        this.duck(DUCKS.zoneTick);
      } else if (e.cause === 'fall') {
        this.play('damage.fall', null, { intensity });
        this.duck(DUCKS.localDamage);
      } else {
        // One cue per armor piece the hit touched (vest and helmet are separate sounds); bare hits thump the body.
        if (pieces.length === 0) this.play('damage.hp', null, { intensity, variant: e.headshot ? 'head' : 'body' });
        for (const [slot, hit] of pieces) this.play(damageArmorCue(slot, hit), null, { intensity, variant: `${slot}${hit.tier}` });
        this.duck(DUCKS.localDamage);
      }
      this.localHp = e.hpAfter;
      this.updateLowHealth();
    }
    if (e.isLocalAttacker && !e.isLocalVictim) return; // voiced by localHitConfirmed
    if (e.isLocalVictim) return;
    // Remote-on-remote: weapon hits thwack at the victim; blasts are loud enough already, except an armor break.
    const broke = e.vest?.broken === true || e.helmet?.broken === true;
    if (e.cause === 'weapon' || (e.cause === 'explosion' && broke)) {
      this.play('hit.remote', e.victimPos, { variant: remoteHitVariant(e), intensity });
    }
  }

  localHitConfirmed(e: GameEvents['localHitConfirmed']): void {
    const intensity = Math.min(1, e.amount / 40);
    if (e.killed) {
      this.play('hitConfirm.kill', null);
      if (e.headshot) this.play('hitConfirm.head', null, { gain: 0.7 });
      return;
    }
    const pieces = armorPieces(e);
    if (pieces.length > 0) {
      // Helmet "tonk" / vest clink (pitched by tier), or the per-piece break crack.
      for (const [slot, hit] of pieces) {
        this.play(confirmArmorCue(slot, hit), null, { intensity, variant: `${slot}${hit.tier}` });
      }
      return;
    }
    this.play(e.headshot ? 'hitConfirm.head' : 'hitConfirm.body', null, { intensity });
  }

  playerKilled(e: GameEvents['playerKilled']): void {
    this.stances.delete(e.victimId);
    this.drop.died(e.victimId, e.isLocalVictim);
    this.stop(LOOP_KEY.reload(e.victimId));
    this.stop(LOOP_KEY.heal(e.victimId));
    this.stop(LOOP_KEY.bolt(e.victimId));
    if (e.isLocalVictim) {
      this.stop(LOOP_KEY.cook);
      // Own reload/heal loops were stopped above; the zone loop keeps going for spectating.
      this.setLowHealth(false);
      this.setOutside(false);
      this.localHp = null;
      this.play('ui.defeat', null);
      this.duck(DUCKS.death);
    } else {
      // M1-fix: playerKilled.headshot (absent = unknown = body) adds a "tok" layer to the remote death.
      this.play('death.remote', e.victimPos, { gain: e.isLocalKiller ? 0.8 : 1, variant: e.headshot === true ? 'head' : 'body' });
    }
  }

  // --- items ------------------------------------------------------------------------------
  /** Armor: velcro for vests, strap click for helmets (variant = item id, pitched by tier). */
  itemPickedUp(e: GameEvents['itemPickedUp']): void {
    this.play(pickupCue(e.item), e.isLocal ? null : e.pos, { variant: e.item });
  }

  reloadStarted(e: GameEvents['reloadStarted']): void {
    if (e.weapon === 'sniper') this.stop(LOOP_KEY.bolt(e.playerId)); // last-round auto reload: no bolt cycle
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
    this.stop(LOOP_KEY.bolt(e.playerId));
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

  // --- zone (tide, sprinklers, lights out by mapChanged.zoneTheme) ----------------------------
  zoneChanged(e: GameEvents['zoneChanged']): void {
    const shrinking = e.zone.shrinking;
    const cues = zoneThemeCues(this.theme);
    if (shrinking && !this.zoneShrinking) {
      this.play(cues.start, null, { variant: cues.startVariant });
      if (cues.loop) this.play(cues.loop, null, { loopKey: LOOP_KEY.zone, durationS: AUDIO_TUNING.tideLoopMaxS });
      if (!this.zoneBedOn) {
        // From the first shrink on there is always an outside somewhere (indoor sprinkler rain bed).
        this.zoneBedOn = true;
        this.sink({ kind: 'zoneBed', active: true });
      }
    } else if (!shrinking && this.zoneShrinking) {
      this.stop(LOOP_KEY.zone);
    }
    this.zoneShrinking = shrinking;
  }

  /** Same sting family on every map: the conch on the island, a PA chime indoors, then the lifeguard whistles. */
  zoneWarning(e: GameEvents['zoneWarning']): void {
    this.play('zone.warning', null, { intensity: e.phaseIndex >= 2 ? 1 : 0, variant: this.theme });
    this.duck(DUCKS.zoneWarning);
  }

  localZoneStatusChanged(e: GameEvents['localZoneStatusChanged']): void {
    if (e.outside === this.outside) return;
    const cues = zoneThemeCues(this.theme);
    if (e.outside) this.play(cues.enter, null, { variant: cues.enterVariant });
    else this.play(cues.exit, null, { variant: cues.exitVariant });
    this.setOutside(e.outside);
  }

  // --- movement ---------------------------------------------------------------------------
  footstep(e: GameEvents['footstep']): void {
    const stance = this.stanceOf(e);
    const pos = e.isLocal ? null : e.pos;
    const cue = footCue(stance, e.isLocal);
    if (stance === 'prone') this.play(cue, pos, { variant: e.surface, intensity: 0.4 });
    else if (stance === 'crouch') this.play(cue, pos, { variant: e.surface, intensity: 0.2, gain: e.isLocal ? 0.6 : 1 });
    else this.play(cue, pos, { variant: e.surface, intensity: e.sprinting ? 1 : 0.55 });
  }

  /** M2a: cloth rustle at the start of a transition; the recipe adds the prone body thud at `durationMs`. */
  stanceChanged(e: GameEvents['stanceChanged']): void {
    this.stances.set(e.playerId, e.to);
    if (e.from === e.to) return;
    this.play('stance.change', e.isLocal ? null : e.pos, {
      variant: stanceTransitionKey(e.from, e.to),
      durationS: Math.max(0.05, e.durationMs / 1000),
      intensity: e.forced ? 1 : 0,
    });
  }

  /** M2a, local only: shoulder rustle in/out; scopes add the lens zoom. */
  localAdsChanged(e: GameEvents['localAdsChanged']): void {
    if (e.sight === 'none') return;
    this.play(e.engaged ? 'ads.in' : 'ads.out', null, { variant: e.sight });
  }

  // --- grenades ---------------------------------------------------------------------------
  grenadeCooked(e: GameEvents['grenadeCooked']): void {
    if (!e.isLocal) {
      this.play('grenade.pin', e.pos);
      return;
    }
    this.play('grenade.pin', null);
    // Fuse length from the per-map balance (no server clock here); stopped on throw, in-hand blast or death.
    if (this.fuseS === null) return;
    this.play('grenade.tick', null, { loopKey: LOOP_KEY.cook, durationS: this.fuseS + AUDIO_TUNING.cookTickSafetyS });
  }

  grenadeThrown(e: GameEvents['grenadeThrown']): void {
    if (e.isLocal) this.stop(LOOP_KEY.cook);
    if (!e.dropped) this.play('grenade.throw', e.isLocal ? null : e.pos);
  }

  grenadeBounced(e: GameEvents['grenadeBounced']): void {
    if (this.grenadeContact.size >= MAX_TRACKED_GRENADES && !this.grenadeContact.has(e.id)) this.grenadeContact.clear();
    this.grenadeContact.set(e.id, e.surface);
    this.play('grenade.bounce', e.pos, { variant: e.surface, intensity: bounceIntensity(e.speed) });
  }

  explosion(e: GameEvents['explosion']): void {
    const water = isWaterBlast(e.pos, this.grenadeContact.get(e.id));
    this.grenadeContact.delete(e.id);
    if (e.isLocalOwner && e.inHand) this.stop(LOOP_KEY.cook);
    this.play('explosion', e.pos, { variant: water ? 'water' : 'ground', intensity: e.inHand ? 1 : 0 });

    const close = blastCloseness(e.localDistance, e.radius);
    if (close !== null) {
      const T = AUDIO_TUNING;
      this.play('explosion.ring', null, { intensity: close });
      this.sink({
        kind: 'muffle',
        cutoffHz: T.muffleEdgeHz + (T.muffleCenterHz - T.muffleEdgeHz) * close,
        delayS: T.muffleDelayS,
        holdS: T.muffleEdgeHoldS + (T.muffleCenterHoldS - T.muffleEdgeHoldS) * close,
      });
      this.duck(DUCKS.explosionClose);
    } else if (e.localDistance !== null && e.localDistance <= e.radius * AUDIO_TUNING.explosionNearRadii) {
      this.duck(DUCKS.explosionNear);
    }
  }

  jump(e: GameEvents['jump']): void {
    this.play(e.isLocal ? 'jump.local' : 'jump.remote', e.isLocal ? null : e.pos);
  }

  /** Surface landing; a landing that ends a drop adds the canopy fold (drop.land). */
  land(e: GameEvents['land']): void {
    const endedDrop = this.drop.landed(e.playerId, e.isLocal);
    if (e.isLocal) {
      this.play('land.local', null, { variant: e.surface, intensity: landIntensity(e.fallSpeed) });
      if (endedDrop) this.play('drop.land', null, { variant: e.surface });
      return;
    }
    if (endedDrop) this.play('drop.land', e.pos, { variant: e.surface });
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
    this.stances.clear();
    this.grenadeContact.clear();
    this.localHp = null;
    this.setLowHealth(false);
    this.setOutside(false);
    if (this.zoneShrinking) this.stop(LOOP_KEY.zone);
    this.zoneShrinking = false;
    if (this.zoneBedOn) this.sink({ kind: 'zoneBed', active: false });
    this.zoneBedOn = false;
    this.drop.reset();
    this.sink({ kind: 'stopLoops' });
  }

  /**
   * Stance for a footstep: `footstep.stance` (REVIEW-M2a M4: local predicted, remote interpolated), else the last
   * stanceChanged for that player while a producer still omits it.
   */
  private stanceOf(e: GameEvents['footstep']): Stance {
    return e.stance ?? this.stances.get(e.playerId) ?? 'stand';
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

  private setOutside(active: boolean): void {
    if (active === this.outside) return;
    this.outside = active;
    this.sink({ kind: 'outside', active });
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
