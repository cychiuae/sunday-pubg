/**
 * M2c audio (docs/audio/M2c.md §12): melee, guns, rockets, smoke, levels, scopes and look presets. Pure mappings
 * against the director, behaviour against the engine with the structural fake context.
 */
import { describe, expect, it, vi } from 'vitest';
import { BALANCE } from '../shared/balance';
import type { RocketView, SmokeCloudView } from '../shared/contracts';
import { EventBus, type GameEvents } from '../shared/events';
import {
  ISLAND_LOOK_IDS,
  OFFICE_LOOK_IDS,
  type ArmorHit,
  type ArmorTier,
  type GunId,
  type ItemId,
  type M2cGunId,
  type M2cItemId,
  type M2cWeaponId,
  type WeaponId,
} from '../shared/types';
import { AudioDirector, LOOP_KEY, type AudioCommand, type PlayCommand } from './AudioDirector';
import { AudioEngine } from './AudioEngine';
import { AUDIO_TUNING, CUES } from './cues';
import { FakeAudioContext, seededRand } from './fakeAudioContext';
import {
  adsSweepS,
  blastSize,
  dopplerRatio,
  lookOf,
  meleePeakS,
  meleeRangeFade,
  pickupLevel,
  resolveLookId,
  smokeRemainingS,
  smokeShape,
} from './soundMap';

const P = { x: 10, y: 0, z: 5 };
const O = { x: 0, y: 0, z: 0 };
const hit = (tier: ArmorTier, broken = false): ArmorHit => ({ tier, absorbed: 10, broken });
/** Pre-gate the live unions lack the M2c ids; these casts compile before and after the C-gate. */
const W = (w: M2cWeaponId): WeaponId => w as WeaponId;
const G = (g: M2cGunId): GunId => g as GunId;
const I = (i: M2cItemId): ItemId => i as ItemId;

function director(): { d: AudioDirector; cmds: AudioCommand[]; plays: () => PlayCommand[]; take: () => AudioCommand[] } {
  const cmds: AudioCommand[] = [];
  const d = new AudioDirector((c) => cmds.push(c), { balance: BALANCE });
  return { d, cmds, plays: () => cmds.filter((c): c is PlayCommand => c.kind === 'play'), take: () => cmds.splice(0, cmds.length) };
}

const dmg = (o: Partial<GameEvents['playerDamaged']>): GameEvents['playerDamaged'] => ({
  victimId: 2, attackerId: 1, amount: 20, headshot: false, cause: 'weapon', sourcePos: P, victimPos: P, hpAfter: 80,
  vest: null, helmet: null, isLocalVictim: false, isLocalAttacker: false, ...o,
});

const meleeHit = (o: Partial<GameEvents['meleeHit']>): GameEvents['meleeHit'] => ({
  attackerId: 1, weapon: 'machete', level: 1, pos: P, surface: 'prop', victimId: null, headshot: false, knockback: false,
  isLocalAttacker: false, isLocalVictim: false, ...o,
});

const SMOKE_CFG = BALANCE.items.smoke?.cloud;
const cloud = (id: number, deployedAt: number, o: Partial<SmokeCloudView> = {}): SmokeCloudView => ({
  id, ownerId: 3, pos: P, center: { x: P.x, y: P.y + 1.2, z: P.z }, radius: 6.5, deployedAt,
  fadeAt: deployedAt + (SMOKE_CFG ? SMOKE_CFG.growMs + SMOKE_CFG.holdMs : 19500), ...o,
});

describe('M2c soundMap helpers', () => {
  it('doppler: above 1 approaching, below 1 receding, clamped', () => {
    expect(dopplerRatio({ x: 10, y: 0, z: 0 }, { x: -45, y: 0, z: 0 }, O)).toBeGreaterThan(1);
    expect(dopplerRatio({ x: 10, y: 0, z: 0 }, { x: 45, y: 0, z: 0 }, O)).toBeLessThan(1);
    expect(dopplerRatio({ x: 10, y: 0, z: 0 }, { x: -1000, y: 0, z: 0 }, O)).toBe(AUDIO_TUNING.rocketDopplerMax);
    expect(dopplerRatio({ x: 10, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, O)).toBe(AUDIO_TUNING.rocketDopplerMin);
    expect(dopplerRatio(O, { x: 45, y: 0, z: 0 }, O)).toBe(1);
  });

  it('blast size follows the radius (6 m = 1), clamped 0.8..1.5', () => {
    expect(blastSize(6)).toBe(1);
    expect(blastSize(1)).toBe(0.8);
    expect(blastSize(30)).toBe(1.5);
  });

  it('melee peak clamps windupMs; swing range: knife < machete < paddle', () => {
    expect(meleePeakS(100)).toBeCloseTo(0.1, 6);
    expect(meleePeakS(5)).toBe(AUDIO_TUNING.meleePeakMinS);
    expect(meleePeakS(5000)).toBe(AUDIO_TUNING.meleePeakMaxS);
    expect(meleeRangeFade('knife', 15)).toBeLessThan(meleeRangeFade('machete', 15));
    expect(meleeRangeFade('knife', 14)).toBeCloseTo(0, 9);
    expect(meleeRangeFade('paddle', 15)).toBe(1);
  });

  it('pickup level: weapons use the event level, armor the tier in its id; nothing else sparkles', () => {
    expect(pickupLevel('rifle', 3)).toBe(3);
    expect(pickupLevel('knife', 2)).toBe(2);
    expect(pickupLevel('vest_4', undefined)).toBe(4);
    expect(pickupLevel('helmet_2', null)).toBe(2);
    expect(pickupLevel('rifle', undefined)).toBeNull();
    expect(pickupLevel('ammo_rocket', 4)).toBeNull();
    expect(pickupLevel('smoke', 4)).toBeNull();
    expect(pickupLevel('scope_4x', 4)).toBeNull();
  });

  it('smoke shape: grow / hold / fade from the cloud record and balance; offset for late joiners', () => {
    const c = { deployedAt: 1000, fadeAt: 1000 + 1500 + 18000 };
    const s = smokeShape(c, 1000, { growMs: 1500, fadeMs: 3000 });
    expect(s).toEqual({ growS: 1.5, holdS: 18, fadeS: 3, offsetS: 0 });
    expect(smokeRemainingS(s)).toBeCloseTo(22.5, 6);
    expect(smokeRemainingS(smokeShape(c, 11000, { growMs: 1500, fadeMs: 3000 }))).toBeCloseTo(12.5, 6);
    // A forced early fade (maxActive) shortens the hold; without a balance the audio fallbacks apply.
    expect(smokeShape({ deployedAt: 0, fadeAt: 1000 }, 0, { growMs: 1500, fadeMs: 3000 }).growS).toBe(1);
    expect(smokeShape(c, 1000, null).fadeS).toBe(AUDIO_TUNING.smokeFallbackFadeS);
  });

  it('ADS sweep: iron and red dot none, then 2x < 4x < 8x', () => {
    expect(adsSweepS('iron')).toBe(0);
    expect(adsSweepS('red_dot')).toBe(0);
    expect(adsSweepS('scope_2x')).toBeLessThan(adsSweepS('scope_4x'));
    expect(adsSweepS('scope_4x')).toBeLessThan(adsSweepS('scope_8x'));
  });

  it('every look id maps to its scene; unknown or cross-map ids fall back to noon / day', () => {
    for (const id of ISLAND_LOOK_IDS) expect(lookOf('island', id).scene).toBe('island');
    for (const id of OFFICE_LOOK_IDS) expect(lookOf('indoor', id).scene).toBe('indoor');
    expect(resolveLookId('island', 'afterHours')).toBe('noon');
    expect(resolveLookId('indoor', 'golden')).toBe('day');
    expect(resolveLookId('island', undefined)).toBe('noon');
    expect(lookOf('island', 'noon').details).toHaveLength(0);
    expect(lookOf('indoor', 'day').details).toHaveLength(0);
  });

  it('look rules: no detail cue outside the ambience bus or above decoration priority; beds stay near baseline', () => {
    for (const [scene, ids] of [['island', ISLAND_LOOK_IDS], ['indoor', OFFICE_LOOK_IDS]] as const) {
      for (const id of ids) {
        const l = lookOf(scene, id);
        for (const d of l.details) {
          expect(CUES[d.cue].bus).toBe('ambience');
          expect(CUES[d.cue].priority).toBeLessThanOrEqual(10);
          expect(d.minS).toBeGreaterThan(1); // never a rhythm (footstep range is 1.5 to 3 Hz)
        }
        // Bed level within -2 / +1.5 dB-ish of the baseline (wave/hvac are the dominant layers).
        const level = l.scene === 'island' ? l.wave : l.hvac;
        expect(20 * Math.log10(level)).toBeGreaterThan(-3.2);
        expect(20 * Math.log10(level)).toBeLessThan(1.6);
      }
    }
  });
});

describe('M2c AudioDirector', () => {
  it('melee swing: 2D local with the peak at the hit frame; remote positional', () => {
    const { d, plays } = director();
    d.meleeSwing({ playerId: 1, weapon: 'paddle', level: 2, pos: P, windupMs: 350, cycleMs: 900, isLocal: true });
    d.meleeSwing({ playerId: 2, weapon: 'knife', level: 1, pos: P, windupMs: 100, cycleMs: 400, isLocal: false });
    expect(plays().map((p) => [p.cue, p.pos, p.variant, p.durationS])).toEqual([
      ['melee.swing.local', null, 'paddle', 0.35],
      ['melee.swing.remote', P, 'knife', 0.1],
    ]);
  });

  it('melee surfaces: contact by material; a miss is never voiced (no event)', () => {
    const { d, plays } = director();
    d.meleeHit(meleeHit({ surface: 'prop', isLocalAttacker: true }));
    d.meleeHit(meleeHit({ weapon: 'paddle', surface: 'glass' }));
    d.meleeHit(meleeHit({ weapon: 'knife', surface: 'terrain' }));
    expect(plays().map((p) => [p.cue, p.pos, p.variant])).toEqual([
      ['melee.hit', null, 'machete.wall'],
      ['melee.hit', P, 'paddle.glass'],
      ['melee.hit', P, 'knife.ground'],
    ]);
  });

  it('melee on players: from damage events once they carry `weapon` (armor tier included), replacing hit.remote', () => {
    const { d, plays, take } = director();
    // Before any damage event with `weapon`: the meleeHit voices a body/head contact itself.
    d.meleeHit(meleeHit({ surface: 'player', victimId: 2, headshot: true }));
    expect(plays().map((p) => p.variant)).toEqual(['machete.head']);
    take();
    d.playerDamaged(dmg({ cause: 'weapon', weapon: 'paddle', helmet: hit(3), headshot: true }));
    d.meleeHit(meleeHit({ weapon: 'paddle', surface: 'player', victimId: 2, headshot: true }));
    expect(plays().map((p) => [p.cue, p.variant, p.pos])).toEqual([['melee.hit', 'paddle.helmet3', P]]);
    take();
    // Guns still thwack remotely.
    d.playerDamaged(dmg({ weapon: 'rifle' }));
    expect(plays().map((p) => p.cue)).toEqual(['hit.remote']);
  });

  it('paddle knockback: keyed per victim, local victim 2D with the ambience duck', () => {
    const { d, cmds } = director();
    d.meleeHit(meleeHit({ weapon: 'paddle', surface: 'player', victimId: 7, knockback: true, isLocalVictim: true }));
    const kb = cmds.find((c): c is PlayCommand => c.kind === 'play' && c.cue === 'melee.knockback');
    expect(kb?.pos).toBeNull();
    expect(kb?.loopKey).toBe(LOOP_KEY.knockback(7));
    expect(kb?.durationS).toBe(AUDIO_TUNING.knockbackThudS);
    expect(cmds.some((c) => c.kind === 'duck' && c.bus === 'ambience')).toBe(true);
  });

  it('obscured hit confirms are silent except the kill', () => {
    const { d, plays } = director();
    const base = { victimId: 2, amount: 20, headshot: false, vest: null, helmet: null, cause: 'weapon' as const, obscured: true };
    d.localHitConfirmed({ ...base, killed: false });
    expect(plays()).toHaveLength(0);
    d.localHitConfirmed({ ...base, killed: true });
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.kill']);
  });

  it('guns: dbshotgun and revolver shots; rpg shotFired is silent (rocketFired voices it); rounds reach the reload', () => {
    const { d, plays } = director();
    d.shotFired({ shooterId: 1, weapon: W('dbshotgun'), origin: P, impacts: [], isLocal: true });
    d.shotFired({ shooterId: 2, weapon: W('revolver'), origin: P, impacts: [], isLocal: false });
    d.shotFired({ shooterId: 2, weapon: W('rpg'), origin: P, impacts: [], isLocal: false });
    d.reloadStarted({ playerId: 1, weapon: G('dbshotgun'), durationMs: 2400, pos: P, isLocal: true, rounds: 1 });
    expect(plays().map((p) => [p.cue, p.params])).toEqual([
      ['shot.dbshotgun.local', undefined],
      ['shot.revolver.remote', undefined],
      ['reload.start', [1]],
    ]);
  });

  it('rockets: launch once, tracked for the fallback; a rocket blast cuts the whistle and keeps ring and muffle', () => {
    const { d, cmds, plays } = director();
    d.rocketFired({ id: 9, ownerId: 1, level: 2, pos: P, vel: { x: 45, y: 0, z: 0 }, firedAt: 1000, isLocal: true });
    const fired = cmds.find((c) => c.kind === 'rocketFired');
    expect(fired && fired.kind === 'rocketFired' && fired.gravity).toBe(BALANCE.weapons.rpg?.rocket.gravity);
    expect(fired && fired.kind === 'rocketFired' && fired.maxFlightMs).toBeCloseTo((120 / 45) * 1000, 3);
    d.explosion({ id: 9, ownerId: 1, pos: P, radius: 5, inHand: false, isLocalOwner: true, localDistance: 2, source: 'rocket' });
    expect(cmds.some((c) => c.kind === 'rocketGone' && c.id === 9)).toBe(true);
    const cues = plays().map((p) => p.cue);
    expect(cues).toEqual(['rocket.launch.local', 'explosion.rocket', 'explosion.ring']);
    expect(plays()[1]?.params?.[0]).toBeCloseTo(5 / 6, 6);
    expect(cmds.some((c) => c.kind === 'muffle')).toBe(true);
  });

  it('rocket dud: a clunk and the whistle stops', () => {
    const { d, cmds, plays } = director();
    d.rocketDud({ id: 4, ownerId: 1, pos: P, surface: 'prop', victimId: null, isLocalOwner: false });
    expect(plays().map((p) => p.cue)).toEqual(['rocket.dud']);
    expect(cmds.some((c) => c.kind === 'rocketGone' && c.id === 4)).toBe(true);
  });

  it('smoke throw cycle never uses frag sounds', () => {
    const { d, plays } = director();
    d.grenadeCooked({ playerId: 1, pos: P, explodesAt: 9000, isLocal: true, kind: 'smoke' });
    d.grenadeThrown({ id: 5, ownerId: 1, pos: P, vel: P, explodesAt: 9000, dropped: false, isLocal: true, kind: 'smoke' });
    // Kind remembered from the throw (pre-gate producers may omit it on the bounce).
    d.grenadeBounced({ id: 5, pos: P, surface: 'terrain', speed: 6 } as GameEvents['grenadeBounced']);
    const cues = plays().map((p) => [p.cue, p.variant]);
    expect(cues).toEqual([
      ['smoke.pin', undefined],
      ['grenade.throw', 'smoke'],
      ['smoke.bounce', 'terrain'],
    ]);
  });

  it('smokeDeployed: pop + a keyed hiss shaped by the balance; setSmokes starts late joiners without the pop', () => {
    const { d, plays, take } = director();
    const c = cloud(5, 1000);
    d.smokeDeployed({ ...c, isLocalOwner: false });
    const [pop, hiss] = plays();
    expect(pop?.cue).toBe('smoke.pop');
    expect(hiss?.cue).toBe('smoke.hiss');
    expect(hiss?.loopKey).toBe(LOOP_KEY.smoke(5));
    expect(hiss?.durationS).toBeCloseTo(22.5, 3);
    take();
    d.smokesSeen([c], 5000); // already running: nothing
    expect(plays()).toHaveLength(0);
    d.smokesSeen([cloud(6, 1000)], 11000); // a late joiner 10 s into a cloud
    expect(plays().map((p) => [p.cue, p.params?.[3]])).toEqual([['smoke.hiss', 10]]);
    take();
    d.smokesSeen([{ ...c, fadeAt: 6000 }], 5000); // forced into its fade early: restarted
    expect(plays().map((p) => p.cue)).toEqual(['smoke.hiss']);
  });

  it('level sparkle for local levelled pickups only; scope pickups and mounts', () => {
    const { d, plays } = director();
    d.itemPickedUp({ playerId: 1, item: 'rifle', qty: 1, pos: P, isLocal: true, level: 4 });
    d.itemPickedUp({ playerId: 2, item: 'rifle', qty: 1, pos: P, isLocal: false, level: 4 });
    d.itemPickedUp({ playerId: 1, item: 'ammo_light', qty: 30, pos: P, isLocal: true });
    d.itemPickedUp({ playerId: 1, item: I('scope_4x'), qty: 1, pos: P, isLocal: true });
    d.scopeChanged({ playerId: 1, slot: 0, gun: 'rifle', from: null, to: 'scope_4x', auto: true, pos: P, isLocal: true });
    d.scopeChanged({ playerId: 2, slot: 1, gun: 'dmr', from: 'scope_4x', to: null, auto: false, pos: P, isLocal: false });
    expect(plays().map((p) => [p.cue, p.variant, p.pos, p.delayS])).toEqual([
      ['pickup.weapon', 'rifle', null, undefined],
      ['pickup.level', '4', null, undefined],
      ['pickup.weapon', 'rifle', P, undefined],
      ['pickup.ammo', 'ammo_light', null, undefined],
      ['pickup.scope', 'scope_4x', null, undefined],
      ['scope.mount', 'scope_4x', null, AUDIO_TUNING.scopeAutoMountDelayS],
      ['scope.unmount', 'scope_4x', P, undefined],
    ]);
  });

  it('glass shatter at the pane; throwable cycle plays the switch of the new type', () => {
    const { d, plays } = director();
    d.glassBroken({ paneId: 3, pos: P, byId: 1, cause: 'melee', isLocal: true });
    d.throwableCycled({ from: 'grenade', to: 'smoke' });
    expect(plays().map((p) => [p.cue, p.pos, p.variant])).toEqual([
      ['glass.shatter', P, undefined],
      ['weapon.switch', null, 'smoke'],
    ]);
  });

  it('mapChanged passes the resolved look (unknown = default)', () => {
    const { d, cmds } = director();
    const ev = (kind: 'island' | 'indoor', look: string | undefined): GameEvents['mapChanged'] => ({
      mapId: kind === 'indoor' ? 'office' : 'island01',
      map: { kind, carrier: kind === 'indoor' ? 'drone' : 'seaplane' } as unknown as GameEvents['mapChanged']['map'],
      balance: BALANCE,
      zoneTheme: kind === 'indoor' ? 'sprinklers' : 'tide',
      layout: null,
      look: look as GameEvents['mapChanged']['look'],
    });
    d.mapChanged(ev('island', 'golden'));
    d.mapChanged(ev('indoor', 'afterHours'));
    d.mapChanged(ev('indoor', undefined));
    expect(cmds.filter((c) => c.kind === 'map').map((c) => c.kind === 'map' && c.look)).toEqual(['golden', 'afterHours', 'day']);
  });
});

// --- Engine ----------------------------------------------------------------------------------------------------------

function engineSetup(): { bus: EventBus<GameEvents>; ctx: FakeAudioContext; engine: AudioEngine } {
  const bus = new EventBus<GameEvents>();
  const ctx = new FakeAudioContext();
  const engine = new AudioEngine(bus, { createContext: vi.fn(() => ctx.asAudioContext()), rand: seededRand(7), balance: BALANCE });
  engine.unlock();
  engine.setListener(O, 0);
  return { bus, ctx, engine };
}

const rocket = (id: number, x: number, vx = -45): RocketView => ({
  id, ownerId: 2, level: 1, pos: { x, y: 0, z: 0 }, vel: { x: vx, y: 0, z: 0 }, origin: { x: 100, y: 0, z: 0 }, firedAt: 0,
});

describe('M2c AudioEngine', () => {
  it('rockets: only the 3 nearest in range get a whistle; an explosion cuts its emitter', () => {
    const { bus, engine } = engineSetup();
    engine.setRockets([rocket(1, 10), rocket(2, 20), rocket(3, 30), rocket(4, 40), rocket(5, 200)], 1000);
    expect(engine.rocketLayers?.voiced.sort()).toEqual([1, 2, 3]);
    bus.emit('explosion', { id: 2, ownerId: 2, pos: { x: 20, y: 0, z: 0 }, radius: 5, inHand: false, isLocalOwner: false, localDistance: 20, source: 'rocket' });
    expect(engine.rocketLayers?.voiced.sort()).toEqual([1, 3]);
    engine.setRockets([rocket(1, 9), rocket(3, 29), rocket(4, 39)], 1016);
    expect(engine.rocketLayers?.voiced.sort()).toEqual([1, 3, 4]);
    expect(engine.voicesOf('explosion.rocket')).toBe(1);
  });

  it('rockets: a fly-by inside 6 m plays once; a far pass does not', () => {
    const { engine } = engineSetup();
    let t = 1000;
    for (const x of [12, 6, 2, -2, -6, -10]) engine.setRockets([{ ...rocket(1, x), pos: { x, y: 0, z: 1 } }], (t += 16));
    expect(engine.voicesOf('rocket.flyby')).toBe(1);
    const far = engineSetup();
    for (const x of [12, 6, 2, -2, -6]) far.engine.setRockets([{ ...rocket(2, x), pos: { x, y: 0, z: 9 } }], (t += 16));
    expect(far.engine.voicesOf('rocket.flyby')).toBe(0);
  });

  it('rockets: without setRockets the engine dead-reckons rocketFired until the blast', () => {
    const { bus, engine } = engineSetup();
    bus.emit('carrierDeparted', {
      route: { mapId: 'island01', entry: { x: 0, z: 0 }, exit: { x: 1, z: 0 }, eject: { x: 1, z: 0 }, altitude: 100, speed: 1, startsAt: 0, noJumpUntil: 0, ejectAt: 0, endsAt: 0 },
    });
    bus.emit('rocketFired', { id: 8, ownerId: 2, level: 1, pos: { x: 30, y: 1, z: 0 }, vel: { x: -45, y: 0, z: 0 }, firedAt: 0, isLocal: false });
    expect(engine.trackedRocketCount).toBe(1);
    engine.update(0.1);
    expect(engine.rocketLayers?.voiced).toEqual([8]);
    bus.emit('rocketDud', { id: 8, ownerId: 2, pos: P, surface: 'prop', victimId: null, isLocalOwner: false });
    expect(engine.trackedRocketCount).toBe(0);
    expect(engine.rocketLayers?.voiced).toEqual([]);
  });

  it('smoke: setSmokes starts a late joiner hiss and closes the ambience cocoon inside a cloud only', () => {
    const { engine } = engineSetup();
    engine.setSmokes([cloud(1, 0, { center: { x: 50, y: 1, z: 0 } })], 5000);
    expect(engine.voicesOf('smoke.hiss')).toBe(1);
    expect(engine.voicesOf('smoke.pop')).toBe(0); // 5 s in: no pop
    expect(engine.inSmokeCocoon).toBe(false);
    engine.setSmokes([cloud(1, 0, { center: { x: 1, y: 0, z: 0 } })], 5016);
    expect(engine.inSmokeCocoon).toBe(true);
    expect(engine.voicesOf('smoke.hiss')).toBe(1); // not restarted
    engine.setSmokes([], 5032);
    expect(engine.inSmokeCocoon).toBe(false);
  });

  it('smoke canisters never fuse-tick', () => {
    const { engine } = engineSetup();
    engine.setGrenades([{ id: 1, ownerId: 2, pos: { x: 1, y: 0, z: 0 }, vel: O, explodesAt: 5000, resting: true, kind: 'smoke' }], 2000);
    expect(engine.voicesOf('grenade.fuseTick')).toBe(0);
    engine.setGrenades([{ id: 2, ownerId: 2, pos: { x: 1, y: 0, z: 0 }, vel: O, explodesAt: 5000, resting: true, kind: 'grenade' }], 2000);
    expect(engine.voicesOf('grenade.fuseTick')).toBe(1);
  });

  it('looks: mapChanged with a look rebuilds the bed and schedules its detail one-shots', () => {
    const { bus, ctx, engine } = engineSetup();
    const map = (look: GameEvents['mapChanged']['look']): GameEvents['mapChanged'] => ({
      mapId: 'island01',
      map: { kind: 'island', carrier: 'seaplane' } as unknown as GameEvents['mapChanged']['map'],
      balance: BALANCE, zoneTheme: 'tide', layout: null, look,
    });
    bus.emit('mapChanged', map('morning'));
    expect(engine.ambienceLook).toBe('morning');
    let birds = 0;
    for (let i = 0; i < 60 * 30; i++) {
      ctx.currentTime += 1 / 60;
      engine.update(1 / 60);
      birds = Math.max(birds, engine.voicesOf('amb.bird'));
    }
    expect(birds).toBeGreaterThan(0);
    bus.emit('mapChanged', map('noon'));
    expect(engine.ambienceLook).toBe('noon');
  });
});
