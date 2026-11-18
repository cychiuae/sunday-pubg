import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/balance';
import { buildHudView, timerProgress, type HudBuildInput } from './hudBuilder';
import { makeLocal, makeMatch, makePlayer, makeSnapshot, makeZone, TEST_MAP } from './testFixtures';

function base(overrides: Partial<HudBuildInput> = {}): HudBuildInput {
  return {
    balance: BALANCE,
    map: TEST_MAP,
    connection: 'connected',
    joined: true,
    snapshot: null,
    now: 0,
    localId: 1,
    localName: 'Me',
    localPose: null,
    zone: null,
    outsideZone: false,
    spectateTarget: null,
    pointerLocked: false,
    crosshairSpreadDeg: 0,
    cameraFovDeg: 70,
    ...overrides,
  };
}

describe('buildHudView', () => {
  it('before any snapshot: lobby defaults, no local, minimap map is the same object', () => {
    const hud = buildHudView(base({ joined: false, connection: 'idle' }));
    expect(hud.phase).toBe('lobby');
    expect(hud.local).toBeNull();
    expect(hud.zone).toBeNull();
    expect(hud.minimap.map).toBe(TEST_MAP);
    expect(hud.minimap.self).toBeNull();
    expect(hud.targetPlayers).toBe(BALANCE.match.targetPlayers);
  });

  it('countdown and results seconds come from phaseEndsAt vs now (ceil, >= 0)', () => {
    const countdown = buildHudView(
      base({ snapshot: makeSnapshot({ match: makeMatch({ phase: 'countdown', phaseEndsAt: 10_000, lobbyCount: 3 }) }), now: 1_500 }),
    );
    expect(countdown.countdownSecondsLeft).toBe(9);
    expect(countdown.resultsSecondsLeft).toBeNull();
    expect(countdown.lobbyCount).toBe(3);

    const results = buildHudView(
      base({ snapshot: makeSnapshot({ match: makeMatch({ phase: 'results', phaseEndsAt: 5_000 }) }), now: 9_000 }),
    );
    expect(results.resultsSecondsLeft).toBe(0);
    expect(results.countdownSecondsLeft).toBeNull();
  });

  it('builds the local view: slots, active weapon mag/reserve, progress bars, pose', () => {
    const local = makeLocal(1, {
      slots: [{ weapon: 'smg', mag: 17 }, { weapon: 'shotgun', mag: 2 }],
      activeSlot: 0,
      ammo: { ammo_light: 60, ammo_heavy: 0, ammo_shell: 8 },
      heals: { bandage: 2, medkit: 1 },
      reloadRemainingMs: 1000,
      reloadTotalMs: 2000,
    });
    const snap = makeSnapshot({
      serverTime: 1_000,
      local,
      players: [makePlayer(1, { name: 'Me', weapon: 'smg', hp: 72.5, armor: 10, kills: 2 })],
    });
    const hud = buildHudView(
      base({ snapshot: snap, now: 1_500, localPose: { pos: { x: 1, y: 2, z: 3 }, yaw: 0.5, dropping: false }, outsideZone: true }),
    );
    const l = hud.local!;
    expect(l.name).toBe('Me');
    expect(l.hp).toBe(72.5);
    expect(l.maxHp).toBe(BALANCE.player.maxHp);
    expect(l.maxArmor).toBe(BALANCE.player.maxArmor);
    expect(l.kills).toBe(2);
    expect(l.slots).toEqual([
      { slot: 0, weapon: 'smg', mag: 17 },
      { slot: 1, weapon: 'shotgun', mag: 2 },
      { slot: 2, weapon: 'fists', mag: null },
    ]);
    expect(l.weapon).toBe('smg');
    expect(l.mag).toBe(17);
    expect(l.magSize).toBe(BALANCE.weapons.smg.magSize);
    expect(l.reserve).toBe(60);
    expect(l.ammoType).toBe(BALANCE.weapons.smg.ammo);
    expect(l.reserveMax).toBe(BALANCE.items.ammo_light.maxCarry);
    expect(l.healMax).toEqual({ bandage: BALANCE.items.bandage.maxStack, medkit: BALANCE.items.medkit.maxStack });
    expect(l.reloadProgress).toBeCloseTo(0.75); // 1000 left at t=1000, 500 ms later => 500 left of 2000
    expect(l.healProgress).toBeNull();
    expect(l.heals).toEqual({ bandage: 2, medkit: 1 });
    expect(l.pos).toEqual({ x: 1, y: 2, z: 3 });
    expect(l.yaw).toBe(0.5);
    expect(l.outsideZone).toBe(true);
    expect(hud.minimap.self).toEqual({ x: 1, z: 3, yaw: 0.5 });
  });

  it('fists: no mag, magSize or reserve', () => {
    const snap = makeSnapshot({ local: makeLocal(1), players: [makePlayer(1)] });
    const l = buildHudView(base({ snapshot: snap })).local!;
    expect(l.weapon).toBe('fists');
    expect(l.mag).toBeNull();
    expect(l.magSize).toBeNull();
    expect(l.reserve).toBeNull();
    expect(l.reserveMax).toBeNull();
    expect(l.ammoType).toBeNull();
  });

  it('lowHpThreshold comes from balance.player.lowHpThreshold and is omitted when the key is absent', () => {
    const snap = makeSnapshot({ local: makeLocal(1), players: [makePlayer(1)] });
    const withKey = { ...BALANCE, player: { ...BALANCE.player, lowHpThreshold: 27 } };
    expect(buildHudView(base({ snapshot: snap, balance: withKey })).local!.lowHpThreshold).toBe(27);
    const without = { ...BALANCE, player: { ...BALANCE.player } };
    delete without.player.lowHpThreshold;
    expect(buildHudView(base({ snapshot: snap, balance: without })).local!).not.toHaveProperty('lowHpThreshold');
  });

  it('frame-level revision 1 fields: camera FOV from the input, death screen seconds from balance', () => {
    const hud = buildHudView(base({ cameraFovDeg: 63 }));
    expect(hud.cameraFovDeg).toBe(63);
    expect(hud.deathScreenSeconds).toBe(BALANCE.match.deathScreenSeconds);
  });

  it('zone view: seconds left, final flag, circles', () => {
    const zone = makeZone({ phaseIndex: 6, phaseCount: 6, phaseEndsAt: 20_400, shrinking: true });
    const hud = buildHudView(base({ snapshot: makeSnapshot({ zone }), zone, now: 10_000 }));
    expect(hud.zone).toMatchObject({ phaseIndex: 6, isFinal: true, shrinking: true, secondsLeft: 11 });
  });

  it('spectate view and minimap marker follow the spectate target', () => {
    const target = makePlayer(9, { name: 'Crab', hp: 40, pos: { x: 4, y: 0, z: -2 }, yaw: 1 });
    const hud = buildHudView(base({ snapshot: makeSnapshot(), spectateTarget: target }));
    expect(hud.spectate).toEqual({ targetId: 9, targetName: 'Crab', targetHp: 40, targetMaxHp: BALANCE.player.maxHp });
    expect(hud.minimap.self).toEqual({ x: 4, z: -2, yaw: 1 });
  });
});

describe('timerProgress', () => {
  it('is null when idle and clamps to [0, 1]', () => {
    expect(timerProgress(0, 1000, 0, 0)).toBeNull();
    expect(timerProgress(1000, 1000, 0, 0)).toBe(0);
    expect(timerProgress(1000, 1000, 0, 5000)).toBe(1);
  });
});
