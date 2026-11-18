/**
 * Cue table: every sound the engine can play, with its bus, priority, voice limit and spatial settings.
 * Owner: audio-designer. Spec: docs/audio/AUDIO.md. Pure data (no Web Audio here) so tests run in node.
 *
 * Naming: `<group>.<name>[.<local|remote>]`. A request with `pos === null` (or a cue with `spatial: false`) plays 2D;
 * otherwise it is positional at `pos`.
 */

export type BusId = 'sfx' | 'ui' | 'ambience';

export const CUE_IDS = [
  // Weapons
  'shot.fists.local',
  'shot.fists.remote',
  'shot.pistol.local',
  'shot.pistol.remote',
  'shot.smg.local',
  'shot.smg.remote',
  'shot.shotgun.local',
  'shot.shotgun.remote',
  'shot.rifle.local',
  'shot.rifle.remote',
  'shot.lmg.local',
  'shot.lmg.remote',
  'shot.dmr.local',
  'shot.dmr.remote',
  'shot.sniper.local',
  'shot.sniper.remote',
  'weapon.bolt',
  'weapon.dryFire',
  'weapon.switch',
  'reload.start',
  'reload.finish',
  // Aim down sights (local only)
  'ads.in',
  'ads.out',
  // Impacts and hits
  'impact.ground',
  'impact.prop',
  'impact.water',
  'impact.glass',
  'hit.remote',
  'hitConfirm.body',
  'hitConfirm.head',
  'hitConfirm.vest',
  'hitConfirm.helmet',
  'hitConfirm.vestBreak',
  'hitConfirm.helmetBreak',
  'hitConfirm.kill',
  'damage.hp',
  'damage.vest',
  'damage.helmet',
  'damage.vestBreak',
  'damage.helmetBreak',
  'damage.fall',
  'death.remote',
  'heartbeat',
  // Movement
  'foot.local',
  'foot.remote',
  'foot.crouch.remote',
  'foot.crawl.local',
  'foot.crawl.remote',
  'stance.change',
  'jump.local',
  'jump.remote',
  'land.local',
  'land.remote',
  // Carrier drop (M2b; the engine drone, cabin, door wind, freefall wind and canopy flutter are DropLayers beds)
  'drop.jump',
  'drop.chutePop',
  'drop.land',
  // Items
  'pickup.weapon',
  'pickup.ammo',
  'pickup.heal',
  'pickup.vest',
  'pickup.helmet',
  'pickup.grenade',
  'heal.start',
  'heal.loop',
  'heal.finish',
  'heal.cancel',
  // Grenades
  'grenade.pin',
  'grenade.tick',
  'grenade.throw',
  'grenade.bounce',
  'grenade.fuseTick',
  'explosion',
  'explosion.ring',
  // Tide
  'zone.warning',
  'zone.tideRising',
  'zone.tideLoop',
  'zone.hurtTick',
  'zone.enterSurf',
  'zone.exitSurf',
  // Office zone themes (M2b): sprinklers, lightsOut
  'zone.sprinklerStart',
  'zone.sprinklerLoop',
  'zone.enterSpray',
  'zone.exitSpray',
  'zone.lights',
  // UI
  'ui.click',
  'ui.hover',
  'ui.slider',
  'ui.countdown',
  'ui.matchStart',
  'ui.victory',
  'ui.defeat',
  'ui.results',
  'ui.prompt',
  'ui.spectate',
  'ui.error',
  'ui.nope',
  // Ambience one-shots
  'amb.gull',
  'amb.keys',
] as const;

export type CueId = (typeof CUE_IDS)[number];

export interface CueDef {
  bus: BusId;
  /** 0..100. Higher survives voice stealing. Spatial cues get up to +5 for closeness (spatial.effectivePriority). */
  priority: number;
  /** Simultaneous instances of this cue. The lowest-priority / oldest instance is stolen past this. */
  maxInstances: number;
  /** false = always 2D, even if a position is supplied. */
  spatial: boolean;
  /** Linear gain into the bus before distance attenuation. */
  gain: number;
  /** Metres: full volume inside this distance. */
  refDistance: number;
  /** Metres: silent (and culled before any node is created) beyond this distance. */
  maxDistance: number;
  /** Inverse-distance rolloff factor (same meaning as PannerNode 'inverse'). */
  rolloff: number;
  /** +- random pitch in semitones per play. */
  pitchJitter: number;
  /** +- random gain in dB per play. */
  gainJitterDb: number;
  /** Seconds: a second request for this cue inside this window is dropped (anti-machine-gun for impacts etc.). */
  cooldownS: number;
}

type Partial2D = Omit<CueDef, 'spatial' | 'refDistance' | 'maxDistance' | 'rolloff'>;
type Partial3D = Omit<CueDef, 'spatial'>;

/** 2D-only cue (UI, local-only feedback). */
const flat = (d: Partial2D): CueDef => ({ ...d, spatial: false, refDistance: 1, maxDistance: Infinity, rolloff: 0 });
/** Cue that is positional when the request has a position (remote players, world). 2D when pos is null (local). */
const world = (d: Partial3D): CueDef => ({ ...d, spatial: true });

const SHOT_LOCAL = { bus: 'sfx', priority: 80, gain: 0.9, pitchJitter: 0.6, gainJitterDb: 1, cooldownS: 0 } as const;
const SHOT_REMOTE = { bus: 'sfx', priority: 70, pitchJitter: 0.8, gainJitterDb: 1.5, cooldownS: 0, refDistance: 6, rolloff: 0.8 } as const;

export const CUES: Record<CueId, CueDef> = {
  'shot.fists.local': flat({ ...SHOT_LOCAL, maxInstances: 2, gain: 0.7 }),
  'shot.fists.remote': world({ ...SHOT_REMOTE, maxInstances: 3, gain: 0.7, refDistance: 2, maxDistance: 25, rolloff: 1.2 }),
  'shot.pistol.local': flat({ ...SHOT_LOCAL, maxInstances: 3 }),
  'shot.pistol.remote': world({ ...SHOT_REMOTE, maxInstances: 4, gain: 0.9, maxDistance: 130 }),
  'shot.smg.local': flat({ ...SHOT_LOCAL, maxInstances: 4, gain: 0.75 }),
  'shot.smg.remote': world({ ...SHOT_REMOTE, maxInstances: 6, gain: 0.8, maxDistance: 130 }),
  'shot.shotgun.local': flat({ ...SHOT_LOCAL, maxInstances: 2, gain: 1 }),
  'shot.shotgun.remote': world({ ...SHOT_REMOTE, maxInstances: 3, gain: 1, maxDistance: 140 }),
  'shot.rifle.local': flat({ ...SHOT_LOCAL, maxInstances: 3, gain: 0.85 }),
  'shot.rifle.remote': world({ ...SHOT_REMOTE, maxInstances: 5, gain: 0.95, maxDistance: 180 }),
  'shot.lmg.local': flat({ ...SHOT_LOCAL, maxInstances: 4, gain: 0.85 }),
  'shot.lmg.remote': world({ ...SHOT_REMOTE, maxInstances: 6, gain: 0.95, maxDistance: 180 }),
  'shot.dmr.local': flat({ ...SHOT_LOCAL, maxInstances: 2, gain: 0.9 }),
  'shot.dmr.remote': world({ ...SHOT_REMOTE, maxInstances: 4, gain: 1, maxDistance: 200 }),
  // The loudest gun: heard across most of the island, with a long tail and bay echo.
  'shot.sniper.local': flat({ ...SHOT_LOCAL, priority: 82, maxInstances: 2, gain: 1 }),
  'shot.sniper.remote': world({ ...SHOT_REMOTE, priority: 74, maxInstances: 3, gain: 1, refDistance: 8, maxDistance: 260, rolloff: 0.6 }),
  // Sniper bolt cycle: the lock lands at fireIntervalMs, so enemies can count the gap (combat.md).
  'weapon.bolt': world({
    bus: 'sfx', priority: 62, maxInstances: 3, gain: 0.6, pitchJitter: 0.2, gainJitterDb: 1, cooldownS: 0,
    refDistance: 2, maxDistance: 30, rolloff: 1.1,
  }),
  'weapon.dryFire': flat({ bus: 'sfx', priority: 75, maxInstances: 1, gain: 0.6, pitchJitter: 0.3, gainJitterDb: 0, cooldownS: 0.08 }),
  // 2D for the local player; positional at weaponSwitched.pos for remotes (Contract revision 1 #3).
  'weapon.switch': world({
    bus: 'sfx', priority: 60, maxInstances: 3, gain: 0.6, pitchJitter: 0.4, gainJitterDb: 1, cooldownS: 0.05,
    refDistance: 2, maxDistance: 15, rolloff: 1.2,
  }),
  'reload.start': world({
    bus: 'sfx', priority: 60, maxInstances: 4, gain: 0.6, pitchJitter: 0.3, gainJitterDb: 1, cooldownS: 0,
    refDistance: 2, maxDistance: 18, rolloff: 1.2,
  }),
  'reload.finish': world({
    bus: 'sfx', priority: 60, maxInstances: 4, gain: 0.65, pitchJitter: 0.3, gainJitterDb: 1, cooldownS: 0,
    refDistance: 2, maxDistance: 18, rolloff: 1.2,
  }),

  'ads.in': flat({ bus: 'sfx', priority: 50, maxInstances: 1, gain: 0.4, pitchJitter: 0.4, gainJitterDb: 1, cooldownS: 0.05 }),
  'ads.out': flat({ bus: 'sfx', priority: 48, maxInstances: 1, gain: 0.3, pitchJitter: 0.4, gainJitterDb: 1, cooldownS: 0.05 }),

  'impact.ground': world({
    bus: 'sfx', priority: 40, maxInstances: 6, gain: 0.45, pitchJitter: 2, gainJitterDb: 2, cooldownS: 0.02,
    refDistance: 2, maxDistance: 30, rolloff: 1.2,
  }),
  'impact.prop': world({
    bus: 'sfx', priority: 40, maxInstances: 5, gain: 0.5, pitchJitter: 2, gainJitterDb: 2, cooldownS: 0.02,
    refDistance: 2, maxDistance: 35, rolloff: 1.2,
  }),
  'impact.water': world({
    bus: 'sfx', priority: 38, maxInstances: 5, gain: 0.45, pitchJitter: 2, gainJitterDb: 2, cooldownS: 0.02,
    refDistance: 2, maxDistance: 30, rolloff: 1.2,
  }),
  // M2b: toy-glass pane: a dull thunk with a short glassy ring (walls and glass kit parts).
  'impact.glass': world({
    bus: 'sfx', priority: 41, maxInstances: 5, gain: 0.55, pitchJitter: 1.5, gainJitterDb: 2, cooldownS: 0.02,
    refDistance: 2, maxDistance: 40, rolloff: 1.1,
  }),
  'hit.remote': world({
    bus: 'sfx', priority: 55, maxInstances: 4, gain: 0.6, pitchJitter: 1, gainJitterDb: 1.5, cooldownS: 0.03,
    refDistance: 3, maxDistance: 45, rolloff: 1,
  }),
  'hitConfirm.body': flat({ bus: 'sfx', priority: 92, maxInstances: 2, gain: 0.7, pitchJitter: 0.3, gainJitterDb: 0.5, cooldownS: 0.03 }),
  'hitConfirm.head': flat({ bus: 'sfx', priority: 94, maxInstances: 2, gain: 0.65, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0.03 }),
  'hitConfirm.vest': flat({ bus: 'sfx', priority: 92, maxInstances: 2, gain: 0.65, pitchJitter: 0.3, gainJitterDb: 0.5, cooldownS: 0.03 }),
  'hitConfirm.helmet': flat({ bus: 'sfx', priority: 93, maxInstances: 2, gain: 0.65, pitchJitter: 0.2, gainJitterDb: 0.5, cooldownS: 0.03 }),
  'hitConfirm.vestBreak': flat({ bus: 'sfx', priority: 95, maxInstances: 1, gain: 0.8, pitchJitter: 0.2, gainJitterDb: 0, cooldownS: 0.1 }),
  'hitConfirm.helmetBreak': flat({ bus: 'sfx', priority: 95, maxInstances: 1, gain: 0.8, pitchJitter: 0.2, gainJitterDb: 0, cooldownS: 0.1 }),
  'hitConfirm.kill': flat({ bus: 'sfx', priority: 98, maxInstances: 2, gain: 0.85, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0.05 }),
  'damage.hp': flat({ bus: 'sfx', priority: 96, maxInstances: 2, gain: 0.95, pitchJitter: 0.8, gainJitterDb: 1, cooldownS: 0.05 }),
  'damage.vest': flat({ bus: 'sfx', priority: 96, maxInstances: 2, gain: 0.85, pitchJitter: 0.8, gainJitterDb: 1, cooldownS: 0.05 }),
  'damage.helmet': flat({ bus: 'sfx', priority: 96, maxInstances: 2, gain: 0.8, pitchJitter: 0.4, gainJitterDb: 1, cooldownS: 0.05 }),
  'damage.vestBreak': flat({ bus: 'sfx', priority: 97, maxInstances: 1, gain: 0.95, pitchJitter: 0.2, gainJitterDb: 0, cooldownS: 0.1 }),
  'damage.helmetBreak': flat({ bus: 'sfx', priority: 97, maxInstances: 1, gain: 0.95, pitchJitter: 0.2, gainJitterDb: 0, cooldownS: 0.1 }),
  'damage.fall': flat({ bus: 'sfx', priority: 90, maxInstances: 1, gain: 0.9, pitchJitter: 0.5, gainJitterDb: 0, cooldownS: 0.1 }),
  'death.remote': world({
    bus: 'sfx', priority: 75, maxInstances: 3, gain: 0.75, pitchJitter: 1, gainJitterDb: 1, cooldownS: 0,
    refDistance: 4, maxDistance: 70, rolloff: 0.9,
  }),
  heartbeat: flat({ bus: 'sfx', priority: 88, maxInstances: 1, gain: 0.7, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0.3 }),

  'foot.local': flat({ bus: 'sfx', priority: 45, maxInstances: 2, gain: 0.32, pitchJitter: 1.5, gainJitterDb: 2, cooldownS: 0.08 }),
  'foot.remote': world({
    // Footsteps are critical PvP intel: priority above impacts and most item sounds.
    bus: 'sfx', priority: 65, maxInstances: 8, gain: 0.75, pitchJitter: 1.5, gainJitterDb: 2, cooldownS: 0,
    refDistance: 2, maxDistance: 30, rolloff: 0.9,
  }),
  // Crouch steps: quieter and a shorter range than standing ones (stance.md). Local crouch reuses foot.local.
  'foot.crouch.remote': world({
    bus: 'sfx', priority: 64, maxInstances: 6, gain: 0.45, pitchJitter: 1.5, gainJitterDb: 2, cooldownS: 0,
    refDistance: 2, maxDistance: 18, rolloff: 1,
  }),
  // Prone crawl: a slow drag per "step", quieter still and only audible up close.
  'foot.crawl.local': flat({ bus: 'sfx', priority: 44, maxInstances: 2, gain: 0.22, pitchJitter: 1, gainJitterDb: 2, cooldownS: 0.15 }),
  'foot.crawl.remote': world({
    bus: 'sfx', priority: 63, maxInstances: 6, gain: 0.4, pitchJitter: 1, gainJitterDb: 2, cooldownS: 0,
    refDistance: 1.5, maxDistance: 12, rolloff: 1,
  }),
  // Stance transition: cloth rustle at the start, body thud at the end of a prone drop (~15 m for others).
  'stance.change': world({
    bus: 'sfx', priority: 57, maxInstances: 4, gain: 0.55, pitchJitter: 0.8, gainJitterDb: 1, cooldownS: 0,
    refDistance: 2, maxDistance: 15, rolloff: 1.2,
  }),
  'jump.local': flat({ bus: 'sfx', priority: 50, maxInstances: 1, gain: 0.45, pitchJitter: 0.8, gainJitterDb: 1, cooldownS: 0.1 }),
  'jump.remote': world({
    bus: 'sfx', priority: 58, maxInstances: 3, gain: 0.6, pitchJitter: 1, gainJitterDb: 1, cooldownS: 0,
    refDistance: 2, maxDistance: 25, rolloff: 1,
  }),
  'land.local': flat({ bus: 'sfx', priority: 55, maxInstances: 1, gain: 0.55, pitchJitter: 0.8, gainJitterDb: 1, cooldownS: 0.1 }),
  'land.remote': world({
    bus: 'sfx', priority: 60, maxInstances: 3, gain: 0.75, pitchJitter: 1, gainJitterDb: 1, cooldownS: 0,
    refDistance: 2, maxDistance: 30, rolloff: 1,
  }),
  // M2b drop one-shots. Jump: door rush + whoosh (local 2D, remote at the carrier). Chute pops are landing intel.
  'drop.jump': world({
    bus: 'sfx', priority: 66, maxInstances: 3, gain: 0.7, pitchJitter: 0.8, gainJitterDb: 1, cooldownS: 0,
    refDistance: 4, maxDistance: 60, rolloff: 0.9,
  }),
  'drop.chutePop': world({
    bus: 'sfx', priority: 64, maxInstances: 3, gain: 0.75, pitchJitter: 0.8, gainJitterDb: 1, cooldownS: 0,
    refDistance: 4, maxDistance: 90, rolloff: 0.8,
  }),
  // Canopy fold + soft thud when a drop ends (the surface step is the normal land cue).
  'drop.land': world({
    bus: 'sfx', priority: 60, maxInstances: 3, gain: 0.6, pitchJitter: 0.6, gainJitterDb: 1, cooldownS: 0,
    refDistance: 2, maxDistance: 25, rolloff: 1,
  }),

  'pickup.weapon': world({
    bus: 'sfx', priority: 62, maxInstances: 2, gain: 0.6, pitchJitter: 0.5, gainJitterDb: 1, cooldownS: 0.04,
    refDistance: 2, maxDistance: 15, rolloff: 1.2,
  }),
  'pickup.ammo': world({
    bus: 'sfx', priority: 55, maxInstances: 2, gain: 0.55, pitchJitter: 0.8, gainJitterDb: 1, cooldownS: 0.04,
    refDistance: 2, maxDistance: 12, rolloff: 1.2,
  }),
  'pickup.heal': world({
    bus: 'sfx', priority: 55, maxInstances: 2, gain: 0.55, pitchJitter: 0.5, gainJitterDb: 1, cooldownS: 0.04,
    refDistance: 2, maxDistance: 12, rolloff: 1.2,
  }),
  'pickup.vest': world({
    bus: 'sfx', priority: 60, maxInstances: 2, gain: 0.6, pitchJitter: 0.5, gainJitterDb: 1, cooldownS: 0.04,
    refDistance: 2, maxDistance: 15, rolloff: 1.2,
  }),
  'pickup.helmet': world({
    bus: 'sfx', priority: 60, maxInstances: 2, gain: 0.6, pitchJitter: 0.5, gainJitterDb: 1, cooldownS: 0.04,
    refDistance: 2, maxDistance: 15, rolloff: 1.2,
  }),
  'pickup.grenade': world({
    bus: 'sfx', priority: 58, maxInstances: 2, gain: 0.55, pitchJitter: 0.6, gainJitterDb: 1, cooldownS: 0.04,
    refDistance: 2, maxDistance: 12, rolloff: 1.2,
  }),
  'heal.start': world({
    bus: 'sfx', priority: 58, maxInstances: 3, gain: 0.55, pitchJitter: 0.5, gainJitterDb: 1, cooldownS: 0,
    refDistance: 2, maxDistance: 18, rolloff: 1.2,
  }),
  'heal.loop': world({
    bus: 'sfx', priority: 52, maxInstances: 4, gain: 0.35, pitchJitter: 0.3, gainJitterDb: 0, cooldownS: 0,
    refDistance: 2, maxDistance: 14, rolloff: 1.2,
  }),
  'heal.finish': world({
    bus: 'sfx', priority: 70, maxInstances: 2, gain: 0.55, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0,
    refDistance: 2, maxDistance: 14, rolloff: 1.2,
  }),
  'heal.cancel': flat({ bus: 'sfx', priority: 70, maxInstances: 1, gain: 0.5, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0.1 }),

  // Grenades. Bounces are incoming-grenade intel: priority above footsteps.
  'grenade.pin': world({
    bus: 'sfx', priority: 76, maxInstances: 3, gain: 0.6, pitchJitter: 0.4, gainJitterDb: 1, cooldownS: 0,
    refDistance: 2, maxDistance: 12, rolloff: 1.2,
  }),
  // Local-only fuse tick while cooking (keyed loop, stopped on throw / explosion / death).
  'grenade.tick': flat({ bus: 'sfx', priority: 70, maxInstances: 1, gain: 0.25, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0 }),
  // M2b (IAudio.setGrenades): positional fuse tick of live grenades within ~8 m; faster as the fuse runs out.
  'grenade.fuseTick': world({
    bus: 'sfx', priority: 77, maxInstances: 4, gain: 0.5, pitchJitter: 0.2, gainJitterDb: 0.5, cooldownS: 0,
    refDistance: 1.5, maxDistance: 10, rolloff: 1.2,
  }),
  'grenade.throw': world({
    bus: 'sfx', priority: 68, maxInstances: 3, gain: 0.55, pitchJitter: 0.8, gainJitterDb: 1, cooldownS: 0,
    refDistance: 2, maxDistance: 25, rolloff: 1.1,
  }),
  'grenade.bounce': world({
    bus: 'sfx', priority: 78, maxInstances: 4, gain: 0.7, pitchJitter: 1.5, gainJitterDb: 1.5, cooldownS: 0.02,
    refDistance: 2, maxDistance: 30, rolloff: 1,
  }),
  // The loudest world sound. The recipe delays itself by distance / speed of sound (flash first, bang later).
  'explosion': world({
    bus: 'sfx', priority: 99, maxInstances: 3, gain: 1, pitchJitter: 1, gainJitterDb: 1, cooldownS: 0,
    refDistance: 8, maxDistance: 150, rolloff: 0.5,
  }),
  // Ear ringing inside the blast radius. On the ui bus so the muffle filter on sfx/ambience does not dull it.
  'explosion.ring': flat({ bus: 'ui', priority: 97, maxInstances: 1, gain: 0.16, pitchJitter: 0.3, gainJitterDb: 0, cooldownS: 0.5 }),

  'zone.warning': flat({ bus: 'sfx', priority: 90, maxInstances: 1, gain: 0.75, pitchJitter: 0, gainJitterDb: 0, cooldownS: 1 }),
  'zone.tideRising': flat({ bus: 'ambience', priority: 70, maxInstances: 1, gain: 0.9, pitchJitter: 0, gainJitterDb: 0, cooldownS: 1 }),
  'zone.tideLoop': flat({ bus: 'ambience', priority: 60, maxInstances: 1, gain: 0.6, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0 }),
  'zone.hurtTick': flat({ bus: 'sfx', priority: 93, maxInstances: 1, gain: 0.7, pitchJitter: 0.4, gainJitterDb: 0, cooldownS: 0.2 }),
  'zone.enterSurf': flat({ bus: 'sfx', priority: 80, maxInstances: 1, gain: 0.7, pitchJitter: 0.5, gainJitterDb: 0, cooldownS: 0.3 }),
  'zone.exitSurf': flat({ bus: 'sfx', priority: 75, maxInstances: 1, gain: 0.55, pitchJitter: 0.5, gainJitterDb: 0, cooldownS: 0.3 }),
  // Sprinklers (office): pipe knock + pressure hiss on the first shrink, a distant rain loop while shrinking, a spray
  // burst when you step into the rain and a drip-off when you leave it.
  'zone.sprinklerStart': flat({ bus: 'ambience', priority: 70, maxInstances: 1, gain: 0.9, pitchJitter: 0, gainJitterDb: 0, cooldownS: 1 }),
  'zone.sprinklerLoop': flat({ bus: 'ambience', priority: 60, maxInstances: 1, gain: 0.55, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0 }),
  'zone.enterSpray': flat({ bus: 'sfx', priority: 80, maxInstances: 1, gain: 0.7, pitchJitter: 0.5, gainJitterDb: 0, cooldownS: 0.3 }),
  'zone.exitSpray': flat({ bus: 'sfx', priority: 75, maxInstances: 1, gain: 0.55, pitchJitter: 0.5, gainJitterDb: 0, cooldownS: 0.3 }),
  // Lights Out theme (data-switchable): variant 'down' (shrink starts), 'enter' / 'exit' (crossing into the dark).
  'zone.lights': flat({ bus: 'sfx', priority: 78, maxInstances: 1, gain: 0.6, pitchJitter: 0.3, gainJitterDb: 0, cooldownS: 0.3 }),

  'ui.click': flat({ bus: 'ui', priority: 85, maxInstances: 2, gain: 0.5, pitchJitter: 0.3, gainJitterDb: 0, cooldownS: 0.03 }),
  'ui.hover': flat({ bus: 'ui', priority: 30, maxInstances: 1, gain: 0.18, pitchJitter: 0.3, gainJitterDb: 0, cooldownS: 0.05 }),
  'ui.slider': flat({ bus: 'ui', priority: 30, maxInstances: 1, gain: 0.4, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0.07 }),
  'ui.countdown': flat({ bus: 'ui', priority: 86, maxInstances: 1, gain: 0.55, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0.3 }),
  'ui.matchStart': flat({ bus: 'ui', priority: 90, maxInstances: 1, gain: 0.7, pitchJitter: 0, gainJitterDb: 0, cooldownS: 1 }),
  'ui.victory': flat({ bus: 'ui', priority: 99, maxInstances: 1, gain: 0.75, pitchJitter: 0, gainJitterDb: 0, cooldownS: 1 }),
  'ui.defeat': flat({ bus: 'ui', priority: 99, maxInstances: 1, gain: 0.65, pitchJitter: 0, gainJitterDb: 0, cooldownS: 1 }),
  'ui.results': flat({ bus: 'ui', priority: 90, maxInstances: 1, gain: 0.55, pitchJitter: 0, gainJitterDb: 0, cooldownS: 1 }),
  'ui.prompt': flat({ bus: 'ui', priority: 35, maxInstances: 1, gain: 0.22, pitchJitter: 0.2, gainJitterDb: 0, cooldownS: 0.12 }),
  'ui.spectate': flat({ bus: 'ui', priority: 60, maxInstances: 1, gain: 0.35, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0.2 }),
  'ui.error': flat({ bus: 'ui', priority: 90, maxInstances: 1, gain: 0.5, pitchJitter: 0, gainJitterDb: 0, cooldownS: 0.5 }),
  // Soft refusal (actionFailed: pickup refused, no heals, full HP, no ammo). Gentle so key-mashing never grates.
  'ui.nope': flat({ bus: 'ui', priority: 72, maxInstances: 1, gain: 0.45, pitchJitter: 0.3, gainJitterDb: 0.5, cooldownS: 0.25 }),

  'amb.gull': world({
    bus: 'ambience', priority: 10, maxInstances: 2, gain: 0.5, pitchJitter: 2, gainJitterDb: 2, cooldownS: 0.5,
    refDistance: 15, maxDistance: 120, rolloff: 0.6,
  }),
  // Office: a short burst of distant keyboard typing somewhere on the floor (indoor maps only).
  'amb.keys': world({
    bus: 'ambience', priority: 10, maxInstances: 2, gain: 0.35, pitchJitter: 1, gainJitterDb: 2, cooldownS: 0.3,
    refDistance: 6, maxDistance: 50, rolloff: 0.8,
  }),
};

/** M2b: persistent carrier engine bed per model (DropLayers). Distances in metres, like CueDef. */
export interface CarrierSoundDef {
  gain: number;
  refDistance: number;
  maxDistance: number;
  rolloff: number;
}

/** Engine-wide audio tuning (feedback/mix numbers, not gameplay balance). */
export const AUDIO_TUNING = {
  /** Total simultaneous one-shot + loop voices (ambience beds are outside the pool). */
  maxVoices: 48,
  busGain: { sfx: 0.9, ui: 0.7, ambience: 0.5 } satisfies Record<BusId, number>,
  /**
   * Default local HP at or below which (and above 0) the heartbeat runs. Matches the HUD low-HP stripes
   * (src/ui/hud.ts LOW_HP = 0.3 of maxHp 100). main.ts injects balance `player.lowHpThreshold` (ADR 0003).
   */
  lowHealthHp: 30,
  heartbeatIntervalS: 0.85,
  gullMinIntervalS: 7,
  gullMaxIntervalS: 18,
  /** Seconds added to heal/reload loop lengths as a safety stop if the end event never arrives. */
  loopSafetyS: 0.5,
  tideLoopMaxS: 120,
  /** Below this fall speed (m/s) remote landings are silent (stepping off rocks). */
  remoteLandMinSpeed: 1.5,
  /** Fall speed (m/s) that maps to full landing intensity. */
  landFullSpeed: 15,
  /** At most this many impact sounds per shot (shotguns fire many pellets). */
  maxImpactsPerShot: 2,
  /** Fades used when a voice is stolen or a loop is stopped. */
  stealFadeS: 0.02,
  loopStopFadeS: 0.12,
  /** Seconds added to the cook tick loop past the balance fuse (safety stop if no throw/explosion event arrives). */
  cookTickSafetyS: 0.3,
  /** Grenade bounce speed (m/s) that maps to full clink intensity. */
  bounceFullSpeed: 12,
  /** m/s. Far explosions are delayed by distance / speedOfSound (capped) so the flash comes first. */
  speedOfSound: 343,
  maxSoundDelayS: 0.45,
  /**
   * World y of the sea surface (balance.movement.stances: water depth = max(0, -terrainHeight)). An explosion below it
   * uses the water variant.
   */
  seaLevelY: 0,
  /** Inside the blast radius: low-pass cutoff of the sfx+ambience muffle, from the radius edge to point blank. */
  muffleEdgeHz: 1800,
  muffleCenterHz: 450,
  /** Muffle hold, seconds, from the radius edge to point blank; then it recovers with muffleRecoverTc. */
  muffleEdgeHoldS: 0.6,
  muffleCenterHoldS: 2,
  muffleRecoverTc: 0.5,
  /** Muffle starts this long after the blast so the bang itself stays punchy. */
  muffleDelayS: 0.1,
  /** Within this many blast radii (but outside the radius) a blast still briefly ducks the ambience. */
  explosionNearRadii: 2,

  // --- M2b ------------------------------------------------------------------------------------------------------
  /** Distant office typing bursts (indoor maps), seconds between, and distance from the listener (m). */
  keysMinIntervalS: 2.5,
  keysMaxIntervalS: 7,
  keysMinRadius: 12,
  keysMaxRadius: 38,
  /** Grenade fuse ticks (IAudio.setGrenades): range and tick spacing from a full fuse to the last moment. */
  fuseTickRangeM: 8,
  fuseTickSlowS: 0.55,
  fuseTickFastS: 0.11,
  /** Fall speed (m/s, measured from the listener) that maps to full freefall wind (the island freefall). */
  windFullSpeed: 30,
  /** Wind floor in freefall (if the listener barely moves, e.g. a spectate camera), chute scale / floor / cap. */
  freefallWindFloor: 0.4,
  chuteWindScale: 0.6,
  chuteWindFloor: 0.12,
  chuteWindMax: 0.45,
  /** Speed smoothing time constant (s) and the per-frame jump treated as a teleport (m). */
  windSmoothTc: 0.2,
  listenerTeleportM: 15,
  /** Aboard counts until route.ejectAt plus this (ms), in case the jump event is late. */
  carrierEjectGraceMs: 1000,
  carrier: {
    // Seaplane: heard across the island (120 m up). Drone: a toy under a 27 m ceiling.
    seaplane: { gain: 0.8, refDistance: 25, maxDistance: 480, rolloff: 0.6 },
    drone: { gain: 0.6, refDistance: 6, maxDistance: 170, rolloff: 0.8 },
  } satisfies Record<'seaplane' | 'drone', CarrierSoundDef>,
  /** Aboard: exterior engine share, cabin low-pass on the world (sfx + ambience), extra ambience duck. */
  aboardExteriorGain: 0.35,
  cabinLowpassHz: 700,
  cabinAmbienceDb: -8,
  /** Indoor reverb (ConvolverNode, generated impulse): length, pre-delay and the sfx send level. */
  reverbSeconds: 2.4,
  reverbPreDelayS: 0.02,
  reverbSend: 0.22,
  /** Ambience scene crossfade on map change, seconds. */
  sceneFadeS: 1.5,
} as const;
