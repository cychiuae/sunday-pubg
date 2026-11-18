import { describe, expect, it, vi } from 'vitest';
import { EventBus, type GameEvents } from '../shared/events';
import { AudioEngine, resolveLowHealthHp } from './AudioEngine';
import { AUDIO_TUNING, CUES } from './cues';
import { FakeAudioContext, type FakeNode, seededRand } from './fakeAudioContext';

const ORIGIN = { x: 0, y: 0, z: 0 };

function setup(): { bus: EventBus<GameEvents>; ctx: FakeAudioContext; engine: AudioEngine; factory: ReturnType<typeof vi.fn> } {
  const bus = new EventBus<GameEvents>();
  const ctx = new FakeAudioContext();
  const factory = vi.fn(() => ctx.asAudioContext());
  const engine = new AudioEngine(bus, { createContext: factory, rand: seededRand(3) });
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
    bus.emit('localHitConfirmed', { victimId: 3, amount: 30, headshot: true, killed: true });
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
      hpAfter: 80, armorAfter: 0, isLocalVictim: true, isLocalAttacker: false,
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
      hpAfter: 10, armorAfter: 0, isLocalVictim: true, isLocalAttacker: false,
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
      hpAfter: 45, armorAfter: 0, isLocalVictim: true, isLocalAttacker: false,
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
});
