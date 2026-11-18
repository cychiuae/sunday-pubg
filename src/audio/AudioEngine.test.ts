import { describe, expect, it, vi } from 'vitest';
import { BALANCE } from '../shared/balance';
import { EventBus, type GameEvents } from '../shared/events';
import { AudioEngine, resolveLowHealthHp } from './AudioEngine';
import { AUDIO_TUNING, CUES } from './cues';
import { FakeAudioContext, type FakeNode, seededRand } from './fakeAudioContext';

const ORIGIN = { x: 0, y: 0, z: 0 };

function setup(): { bus: EventBus<GameEvents>; ctx: FakeAudioContext; engine: AudioEngine; factory: ReturnType<typeof vi.fn> } {
  const bus = new EventBus<GameEvents>();
  const ctx = new FakeAudioContext();
  const factory = vi.fn(() => ctx.asAudioContext());
  const engine = new AudioEngine(bus, { createContext: factory, rand: seededRand(3), balance: BALANCE });
  return { bus, ctx, engine, factory };
}

const shot = (o: Partial<GameEvents['shotFired']> = {}): GameEvents['shotFired'] => ({
  shooterId: 2,
  weapon: 'smg',
  origin: { x: 10, y: 1, z: 0 },
  impacts: [],
  isLocal: false,
  ...o,
});

describe('AudioEngine', () => {
  it('creates no AudioContext before unlock and silently drops early events', () => {
    const { bus, engine, factory } = setup();
    bus.emit('shotFired', shot());
    engine.update(0.016);
    engine.setListener(ORIGIN, 0);
    engine.setVolume(0.5);
    expect(factory).not.toHaveBeenCalled();
    expect(engine.unlocked).toBe(false);
    expect(engine.voiceCount).toBe(0);
  });

  it('also works with the plain contract constructor in node (no AudioContext, no document)', () => {
    const bus = new EventBus<GameEvents>();
    const engine = new AudioEngine(bus);
    bus.emit('countdown', { secondsLeft: 3 });
    engine.update(0.1);
    engine.unlock(); // no Web Audio in node: logs and stays silent, never throws
    expect(engine.unlocked).toBe(false);
    engine.dispose();
  });

  it('unlock is idempotent, applies the stored volume and starts ambience', () => {
    const { engine, ctx, factory } = setup();
    engine.setVolume(0.5);
    engine.unlock();
    engine.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    const master = ctx.nodes.find((n) => n.kind === 'gain' && n.outputs.some((o) => (o as FakeNode).kind === 'compressor'));
    expect(master?.gain.value).toBeCloseTo(0.25, 6);
    expect(ctx.nodes.filter((n) => n.kind === 'bufferSource' && n.loop).length).toBeGreaterThanOrEqual(3);
    expect(engine.voiceCount).toBe(0);
  });

  it('resumes a suspended context on unlock', () => {
    const { engine, ctx } = setup();
    ctx.state = 'suspended';
    engine.unlock();
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');
  });

  it('plays a remote shot positionally through a panner and a distance low-pass', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    const before = ctx.nodes.length;
    engine.setListener(ORIGIN, 0);
    bus.emit('shotFired', shot({ origin: { x: 60, y: 0, z: 0 } }));
    expect(engine.voiceCount).toBe(1);
    const created = ctx.nodes.slice(before);
    const panner = created.find((n) => n.kind === 'panner');
    expect(panner).toBeDefined();
    expect(panner?.rolloffFactor).toBe(0);
    expect(panner?.positionX.value).toBe(60);
    expect(created.some((n) => n.kind === 'biquad' && n.outputs.includes(panner as FakeNode))).toBe(true);
  });

  it('culls positional sounds beyond their range without creating nodes', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    engine.setListener(ORIGIN, 0);
    const before = ctx.nodes.length;
    bus.emit('footstep', { playerId: 2, pos: { x: 500, y: 0, z: 0 }, surface: 'sand', sprinting: true, isLocal: false });
    bus.emit('shotFired', shot({ origin: { x: 0, y: 0, z: CUES['shot.smg.remote'].maxDistance + 1 } }));
    expect(ctx.nodes.length).toBe(before);
    expect(engine.voiceCount).toBe(0);
  });

  it('caps simultaneous instances of a cue and the whole pool', () => {
    const { bus, engine } = setup();
    engine.unlock();
    for (let i = 0; i < 100; i++) bus.emit('shotFired', shot({ shooterId: i, origin: { x: 5 + (i % 7), y: 0, z: 0 } }));
    expect(engine.voiceCount).toBe(CUES['shot.smg.remote'].maxInstances);
    for (let i = 0; i < 200; i++) {
      bus.emit('footstep', { playerId: i, pos: { x: i % 20, y: 0, z: 1 }, surface: 'grass', sprinting: false, isLocal: false });
      bus.emit('shotFired', shot({ weapon: (['pistol', 'rifle', 'shotgun'] as const)[i % 3], origin: { x: 3, y: 0, z: i % 9 } }));
    }
    expect(engine.voiceCount).toBeLessThanOrEqual(48);
  });

  it('reaps finished voices and disconnects every node they created', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    const before = ctx.nodes.length;
    bus.emit('shotFired', shot({ weapon: 'rifle', impacts: [{ point: { x: 2, y: 0, z: 0 }, surface: 'prop', playerId: null, headshot: false }] }));
    bus.emit('localHitConfirmed', { victimId: 3, amount: 30, headshot: true, killed: true, vest: null, helmet: null, cause: 'weapon' });
    expect(engine.voiceCount).toBeGreaterThanOrEqual(3);
    ctx.currentTime = 5;
    engine.update(0.016);
    expect(engine.voiceCount).toBe(0);
    for (const n of ctx.nodes.slice(before)) expect(n.disconnected, n.kind).toBeGreaterThan(0);
  });

  it('stops a keyed heal loop on finish (fade, then disconnect)', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    bus.emit('healStarted', { playerId: 1, item: 'bandage', durationMs: 2500, pos: ORIGIN, isLocal: true });
    expect(engine.voiceCount).toBe(2); // start + loop
    ctx.currentTime = 1;
    bus.emit('healFinished', { playerId: 1, item: 'bandage', hpAfter: 60, pos: ORIGIN, isLocal: true });
    // loop removed immediately; start one-shot ended; finish chime playing
    engine.update(0.016);
    expect(engine.voiceCount).toBe(1);
    ctx.currentTime = 2;
    engine.update(0.016);
    expect(engine.voiceCount).toBe(0);
  });

  it('honours per-cue cooldowns', () => {
    const { bus, engine } = setup();
    engine.unlock();
    bus.emit('dryFire', { weapon: 'pistol' });
    bus.emit('dryFire', { weapon: 'pistol' });
    expect(engine.voiceCount).toBe(1);
  });

  it('ducks the ambience bus on local damage and releases it later', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    bus.emit('playerDamaged', {
      victimId: 1, attackerId: 2, amount: 20, headshot: false, cause: 'weapon', sourcePos: ORIGIN, victimPos: ORIGIN,
      hpAfter: 80, vest: null, helmet: null, isLocalVictim: true, isLocalAttacker: false,
    });
    const targets = (): number => ctx.nodes.reduce((n, node) => n + node.gain.calls.filter((c) => c === 'target').length, 0);
    const t0 = targets();
    engine.update(0.016);
    expect(targets()).toBe(t0 + 1); // duck applied
    ctx.currentTime = 3;
    engine.update(0.016);
    expect(targets()).toBe(t0 + 2); // released
  });

  it('plays a heartbeat while low on health', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    bus.emit('playerDamaged', {
      victimId: 1, attackerId: 2, amount: 90, headshot: false, cause: 'weapon', sourcePos: ORIGIN, victimPos: ORIGIN,
      hpAfter: 10, vest: null, helmet: null, isLocalVictim: true, isLocalAttacker: false,
    });
    ctx.currentTime = 1;
    engine.update(0.016);
    expect(engine.voiceCount).toBe(1); // the heartbeat (damage thump has ended)
  });

  it('playUi plays contract UiSoundIds on the ui bus, only after unlock', () => {
    const { engine } = setup();
    engine.playUi('ui.click');
    expect(engine.voiceCount).toBe(0); // dropped before unlock
    engine.unlock();
    engine.playUi('ui.click');
    engine.playUi('ui.hover');
    engine.playUi('ui.slider');
    expect(engine.voiceCount).toBe(3);
    engine.playUi('ui.unknown' as never); // newer Ui, older engine: ignored, no throw
    expect(engine.voiceCount).toBe(3);
  });

  it('attaches no click/hover/gesture listeners to document (Ui calls playUi; main.ts calls unlock)', () => {
    const added: string[] = [];
    const fakeDoc = {
      visibilityState: 'visible',
      addEventListener: (type: string) => added.push(type),
      removeEventListener: () => undefined,
    };
    vi.stubGlobal('document', fakeDoc);
    try {
      const engine = new AudioEngine(new EventBus<GameEvents>(), { createContext: () => new FakeAudioContext().asAudioContext() });
      expect(added).toEqual(['visibilitychange']);
      engine.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('plays a soft nope on local actionFailed and a positional remote weapon switch', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    bus.emit('actionFailed', { playerId: 1, action: 'pickup', reason: 'inventoryFull', isLocal: true });
    expect(engine.voiceCount).toBe(1);
    const panners = (): number => ctx.nodes.filter((n) => n.kind === 'panner').length;
    const p0 = panners();
    bus.emit('weaponSwitched', { playerId: 2, weapon: 'rifle', slot: 0, isLocal: false, pos: { x: 4, y: 0, z: 0 } });
    expect(engine.voiceCount).toBe(2);
    expect(panners()).toBe(p0 + 1);
  });

  it('heartbeat threshold uses the injected option or falls back to AUDIO_TUNING.lowHealthHp', () => {
    expect(resolveLowHealthHp(42)).toBe(42);
    expect(resolveLowHealthHp(undefined)).toBe(AUDIO_TUNING.lowHealthHp);
    expect(resolveLowHealthHp(-1)).toBe(AUDIO_TUNING.lowHealthHp);
    expect(resolveLowHealthHp(Number.NaN)).toBe(AUDIO_TUNING.lowHealthHp);
    expect(AUDIO_TUNING.lowHealthHp).toBe(30);
  });

  it('injected lowHealthHp drives the heartbeat', () => {
    const bus = new EventBus<GameEvents>();
    const ctx = new FakeAudioContext();
    const engine = new AudioEngine(bus, { createContext: () => ctx.asAudioContext(), rand: seededRand(3), lowHealthHp: 50 });
    engine.unlock();
    bus.emit('playerDamaged', {
      victimId: 1, attackerId: 2, amount: 55, headshot: false, cause: 'weapon', sourcePos: ORIGIN, victimPos: ORIGIN,
      hpAfter: 45, vest: null, helmet: null, isLocalVictim: true, isLocalAttacker: false,
    });
    ctx.currentTime = 1;
    engine.update(0.016);
    expect(engine.voiceCount).toBe(1); // heartbeat at 45 HP because the threshold is 50
  });

  it('dispose unsubscribes, disconnects and closes the context', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    bus.emit('shotFired', shot());
    engine.dispose();
    expect(ctx.state).toBe('closed');
    expect(engine.voiceCount).toBe(0);
    const n = ctx.nodes.length;
    bus.emit('shotFired', shot());
    expect(ctx.nodes.length).toBe(n);
    engine.unlock();
    expect(engine.unlocked).toBe(false);
  });

  it('M2a: a close explosion plays the boom, the ear ring and sweeps the world muffle low-pass down and back', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    engine.setListener(ORIGIN, 0);
    // M2b: ducks -> muffle -> cabin -> master. The cabin is the biquad feeding the master; the muffle feeds the cabin.
    const cabin = ctx.nodes.find((n) => n.kind === 'biquad' && n.outputs.some((o) => (o as FakeNode).outputs?.some((x) => (x as FakeNode).kind === 'compressor')));
    const muffle = ctx.nodes.find((n) => n.kind === 'biquad' && n.outputs.includes(cabin as FakeNode));
    expect(muffle?.frequency.value).toBe(20000);
    bus.emit('explosion', { id: 1, ownerId: 2, pos: { x: 1, y: 0, z: 0 }, radius: 6, inHand: false, isLocalOwner: false, localDistance: 1 });
    expect(engine.voiceCount).toBe(2); // boom + ring
    const calls = muffle?.frequency.calls ?? [];
    expect(calls.filter((c) => c === 'target')).toHaveLength(2); // down, then recover
    expect(muffle?.frequency.value).toBe(20000); // the last scheduled target is the open filter
  });

  it('M2a: far explosions get the air low-pass; sniper fire also schedules the bolt voice', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    engine.setListener(ORIGIN, 0);
    const before = ctx.nodes.length;
    bus.emit('explosion', { id: 1, ownerId: 2, pos: { x: 100, y: 0, z: 0 }, radius: 6, inHand: false, isLocalOwner: false, localDistance: 100 });
    expect(engine.voiceCount).toBe(1);
    const created = ctx.nodes.slice(before);
    const panner = created.find((n) => n.kind === 'panner');
    expect(created.some((n) => n.kind === 'biquad' && n.outputs.includes(panner as FakeNode))).toBe(true);
    bus.emit('shotFired', shot({ weapon: 'sniper', origin: { x: 10, y: 0, z: 0 } }));
    expect(engine.voiceCount).toBe(3);
  });

  it('M2a: grenade cook tick is a keyed loop stopped by the throw; stance and ADS events are voiced', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    bus.emit('grenadeCooked', { playerId: 1, pos: ORIGIN, explodesAt: 5000, isLocal: true });
    expect(engine.voiceCount).toBe(2); // pin + tick loop
    ctx.currentTime = 1;
    bus.emit('grenadeThrown', { id: 1, ownerId: 1, pos: ORIGIN, vel: ORIGIN, explodesAt: 5000, dropped: false, isLocal: true });
    engine.update(0.016);
    expect(engine.voiceCount).toBe(1); // tick stopped, pin ended, whoosh playing
    ctx.currentTime = 3;
    engine.update(0.016);
    bus.emit('stanceChanged', { playerId: 1, from: 'stand', to: 'prone', forced: false, durationMs: 600, pos: ORIGIN, isLocal: true });
    bus.emit('localAdsChanged', { engaged: true, weapon: 'dmr', sight: 'scope_4x' });
    bus.emit('grenadeBounced', { id: 2, pos: { x: 3, y: 0, z: 0 }, surface: 'terrain', speed: 8 });
    expect(engine.voiceCount).toBe(3);
  });
});

// --- M2b ------------------------------------------------------------------------------------------------------
const ROUTE = {
  mapId: 'office', entry: { x: -100, z: 0 }, exit: { x: 100, z: 0 }, eject: { x: 80, z: 0 }, altitude: 25, speed: 10,
  startsAt: 1000, noJumpUntil: 2500, ejectAt: 19000, endsAt: 21000,
};
const mapEvent = (kind: 'island' | 'indoor', zoneTheme: GameEvents['mapChanged']['zoneTheme'] = kind === 'indoor' ? 'sprinklers' : 'tide'): GameEvents['mapChanged'] => ({
  mapId: kind === 'indoor' ? 'office' : 'island01',
  map: { kind, carrier: kind === 'indoor' ? 'drone' : 'seaplane' } as unknown as GameEvents['mapChanged']['map'],
  balance: BALANCE,
  zoneTheme,
});

/** Advances the fake clock and the engine by `seconds` at 60 fps. */
function advance(engine: AudioEngine, ctx: FakeAudioContext, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) {
    ctx.currentTime += 1 / 60;
    engine.update(1 / 60);
  }
}

describe('AudioEngine: M2b maps', () => {
  it('a mapChanged before unlock is kept: unlock builds the indoor scene with the reverb send', () => {
    const { bus, engine, ctx } = setup();
    bus.emit('mapChanged', mapEvent('indoor'));
    expect(ctx.nodes.length).toBe(0);
    engine.unlock();
    expect(engine.ambienceScene).toBe('indoor');
    expect(engine.reverbActive).toBe(true);
    const conv = ctx.nodes.find((n) => n.kind === 'convolver');
    expect(conv?.buffer?.numberOfChannels).toBe(2);
    // Indoor beds include the fluorescent buzz and mains hum oscillators; the island has none at audio rate.
    expect(ctx.nodes.some((n) => n.kind === 'oscillator' && n.frequency.value === 120)).toBe(true);
  });

  it('switching maps crossfades the scene, removes the reverb on the island and disposes the old bed', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    expect(engine.ambienceScene).toBe('island');
    expect(engine.reverbActive).toBe(false);
    const islandSources = ctx.nodes.filter((n) => n.kind === 'bufferSource' && n.loop);
    expect(islandSources.length).toBeGreaterThan(0);
    bus.emit('mapChanged', mapEvent('indoor'));
    expect(engine.reverbActive).toBe(true);
    for (const s of islandSources) expect(s.stopped).toBeNull(); // still fading out
    advance(engine, ctx, AUDIO_TUNING.sceneFadeS + 0.3);
    for (const s of islandSources) expect(s.stopped).not.toBeNull();
    bus.emit('mapChanged', mapEvent('island'));
    expect(engine.ambienceScene).toBe('island');
    expect(engine.reverbActive).toBe(false);
    expect(ctx.nodes.find((n) => n.kind === 'convolver')?.disconnected).toBeGreaterThan(0);
  });

  it('indoors the engine schedules distant typing instead of gulls', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    bus.emit('mapChanged', mapEvent('indoor'));
    let keys = 0;
    let gulls = 0;
    for (let i = 0; i < 60 * 30; i++) {
      ctx.currentTime += 1 / 60;
      engine.update(1 / 60);
      keys += engine.voicesOf('amb.keys');
      gulls += engine.voicesOf('amb.gull');
    }
    expect(keys).toBeGreaterThan(0);
    expect(gulls).toBe(0);
  });

  it('glass impacts and indoor footsteps play', () => {
    const { bus, engine } = setup();
    engine.unlock();
    engine.setListener(ORIGIN, 0);
    const glass = { point: { x: 3, y: 1, z: 0 }, surface: 'glass', playerId: null, headshot: false } as unknown as GameEvents['shotFired']['impacts'][number];
    bus.emit('shotFired', shot({ impacts: [glass] }));
    expect(engine.voicesOf('impact.glass')).toBe(1);
    bus.emit('footstep', { playerId: 2, pos: { x: 2, y: 0, z: 0 }, surface: 'tile', sprinting: false, isLocal: false, stance: 'stand' } as unknown as GameEvents['footstep']);
    expect(engine.voicesOf('foot.remote')).toBe(1);
  });
});

describe('AudioEngine: M2b carrier drop', () => {
  it('runs the positional carrier engine along the route on the server clock, with cabin and door wind aboard', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    bus.emit('mapChanged', mapEvent('indoor'));
    engine.setListener({ x: 0, y: 25, z: 10 }, 0);
    bus.emit('localPlayerSpawned', { playerId: 1, pos: ORIGIN });
    bus.emit('carrierDeparted', { route: ROUTE });
    engine.setGrenades([], 11000); // server clock: carrier at the middle of the route
    advance(engine, ctx, 1 / 60);
    const layers = engine.dropLayers;
    expect(layers?.active).toEqual({ engine: true, door: true, wind: false });
    expect(layers?.enginePanner?.positionX.value).toBeCloseTo(0, 6);
    expect(layers?.enginePanner?.positionY.value).toBe(25);
    // Without fresh setGrenades the clock advances with update(): 1 s later the drone is 10 m further.
    advance(engine, ctx, 1);
    expect(layers?.enginePanner?.positionX.value as number).toBeGreaterThan(8);
    // The cabin low-pass closes on the world while aboard.
    const cabin = ctx.nodes.find((n) => n.kind === 'biquad' && n.outputs.some((o) => (o as FakeNode).outputs?.some((x) => (x as FakeNode).kind === 'compressor')));
    expect(cabin?.frequency.value).toBe(AUDIO_TUNING.cabinLowpassHz);

    // Jump: whoosh, door wind fades, freefall wind starts, the cabin opens.
    bus.emit('playerJumped', { playerId: 1, pos: { x: 10, y: 25, z: 0 }, auto: false, isLocal: true });
    expect(engine.voicesOf('drop.jump')).toBe(1);
    advance(engine, ctx, 0.1);
    expect(layers?.active.wind).toBe(true);
    expect(cabin?.frequency.value).toBe(20000);
    bus.emit('parachuteOpened', { playerId: 1, pos: { x: 10, y: 10, z: 0 }, manual: false, isLocal: true });
    expect(engine.voicesOf('drop.chutePop')).toBe(1);
    bus.emit('land', { playerId: 1, pos: ORIGIN, fallSpeed: 8, surface: 'sand', isLocal: true });
    expect(engine.voicesOf('drop.land')).toBe(1);
    // After the route ends and everything is silent, every drop group releases its nodes.
    engine.setGrenades([], ROUTE.endsAt + 10);
    advance(engine, ctx, 2);
    expect(layers?.active).toEqual({ engine: false, door: false, wind: false });
  });

  it('a spectator hears the carrier but gets no cabin', () => {
    const { bus, engine, ctx } = setup();
    engine.unlock();
    bus.emit('carrierDeparted', { route: ROUTE }); // seeds the clock at route.startsAt
    advance(engine, ctx, 1 / 60);
    expect(engine.dropLayers?.active).toEqual({ engine: true, door: false, wind: false });
  });

  it('setGrenades plays positional fuse ticks for close grenades only', () => {
    const { engine, ctx } = setup();
    engine.unlock();
    engine.setListener(ORIGIN, 0);
    const g = (id: number, x: number) => ({ id, ownerId: 2, pos: { x, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, explodesAt: 5000, resting: true });
    engine.setGrenades([g(1, 3), g(2, 40)], 2000);
    expect(engine.voicesOf('grenade.fuseTick')).toBe(1);
    ctx.currentTime += 0.05;
    engine.setGrenades([g(1, 3), g(2, 40)], 2050); // not yet the next beat
    expect(engine.voicesOf('grenade.fuseTick')).toBe(1);
  });

  it('setGrenades before unlock only keeps the clock', () => {
    const { engine, factory } = setup();
    engine.setGrenades([{ id: 1, ownerId: 2, pos: ORIGIN, vel: ORIGIN, explodesAt: 5000, resting: true }], 2000);
    expect(factory).not.toHaveBeenCalled();
    expect(engine.voicesOf('grenade.fuseTick')).toBe(0);
  });
});
