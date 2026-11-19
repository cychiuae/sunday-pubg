/**
 * M2a (PROTOCOL_VERSION 2, ADR 0004 §8, ARCHITECTURE §14 network-engineer): input coercion and rejection, the new
 * snapshot fields, grenades, the new events, and the snapshot-size budget with grenades in flight.
 */
import { describe, expect, it } from 'vitest';
import {
  ARMOR_IDS,
  ITEM_IDS,
  STANCES,
  WEAPON_IDS,
  type HeldId,
  type PlayerState,
  type SimEvent,
  type Stance,
  type WorldSnapshot,
} from '../types';
import { SnapshotDeltaDecoder, SnapshotDeltaEncoder, diffPlayer } from './delta';
import {
  decodeClientMessage,
  decodePlayerInput,
  decodeServerMessage,
  encode,
  encodeQuantized,
  isGrenade,
  isLoot,
  isPlayerState,
  isSimEvent,
  packAnim,
  privateEventRecipient,
  unpackAnim,
  ANIM_BITS,
  quantizeDeep,
} from './messages';
import { grenadeToRow } from './rows';
import { makeGrenade, makeInput, makeLocal, makeMatch, makePlayer, makeSnapshot } from './testing';

const v3 = { x: 1.5, y: 2, z: -3 };
const ANIM_MAX_FOR_TEST = 2 ** ANIM_BITS.length;
const inputFrame = (input: Record<string, unknown>) => JSON.stringify({ t: 'input', input });
const decodeSnap = (snap: unknown) => {
  const m = decodeServerMessage(JSON.stringify({ t: 'snapshot', snap }));
  return m?.t === 'snapshot' ? m.snap : null;
};

describe('M2a input fields', () => {
  const { ads: _a, stanceToggle: _s, ...m1Input } = makeInput({ seq: 3 });

  it('absent ads -> false and absent stanceToggle -> null', () => {
    expect(decodePlayerInput(m1Input)).toEqual(makeInput({ seq: 3 }));
  });

  it.each([
    [true, true],
    [false, false],
    [1, false],
    ['true', false],
    [null, false],
    [{}, false],
  ])('coerces ads %j to %j instead of dropping the frame', (ads, want) => {
    expect(decodePlayerInput({ ...m1Input, ads })?.ads).toBe(want);
  });

  it.each([['crouch'], ['prone'], [null]])('accepts stanceToggle %j', (stanceToggle) => {
    expect(decodePlayerInput({ ...m1Input, stanceToggle })?.stanceToggle).toBe(stanceToggle);
  });

  it.each([['stand'], ['jump'], ['CROUCH'], [''], [1], [true], [{}], [['crouch']]])(
    'rejects stanceToggle %j as a bad frame',
    (stanceToggle) => {
      expect(decodePlayerInput({ ...m1Input, stanceToggle })).toBeNull();
      expect(decodeClientMessage(inputFrame({ ...m1Input, stanceToggle }))).toBeNull();
    },
  );

  it.each([[-1], [0], [1], [2], [3]])('accepts selectSlot %j', (selectSlot) => {
    expect(decodePlayerInput({ ...m1Input, selectSlot })?.selectSlot).toBe(selectSlot);
  });

  it.each([[4], [-2], [1.5], ['3'], [null]])('rejects selectSlot %j', (selectSlot) => {
    expect(decodePlayerInput({ ...m1Input, selectSlot })).toBeNull();
  });

  it('round-trips every new input field', () => {
    const input = makeInput({ seq: 9, ads: true, stanceToggle: 'prone', selectSlot: 3, fire: true });
    expect(decodeClientMessage(encode({ t: 'input', input }))).toEqual({ t: 'input', input });
  });
});

describe('M2a PlayerState fields', () => {
  const full = makePlayer(1, {
    vestTier: 3,
    helmetTier: 1,
    weapon: 'grenade',
    stance: 'prone',
    stanceFrom: 'stand',
    stanceProgress: 0.25,
    anim: { ...makePlayer(1).anim, ads: true, cooking: true },
  });

  it('round-trips through the quantized server encoder', () => {
    const snap = makeSnapshot(2, [full]);
    expect(decodeServerMessage(encodeQuantized({ t: 'snapshot', snap }))).toEqual({ t: 'snapshot', snap: quantizeDeep(snap) });
  });

  it('accepts every held item and every stance pair', () => {
    for (const weapon of [...WEAPON_IDS, 'grenade'] as HeldId[]) expect(isPlayerState({ ...full, weapon })).toBe(true);
    for (const stance of STANCES) {
      for (const stanceFrom of STANCES) expect(isPlayerState({ ...full, stance, stanceFrom })).toBe(true);
    }
    for (const t of [0, 1, 2, 3]) expect(isPlayerState({ ...full, vestTier: t, helmetTier: t })).toBe(true);
    for (const p of [0, 1, 0.5]) expect(isPlayerState({ ...full, stanceProgress: p })).toBe(true);
  });

  it.each([
    ['vestTier 5', { vestTier: 5 }], // M2c: tier 4 is valid
    ['vestTier -1', { vestTier: -1 }],
    ['vestTier 1.5', { vestTier: 1.5 }],
    ['helmetTier "2"', { helmetTier: '2' }],
    ['helmetTier missing', { helmetTier: undefined }],
    ['stance "sit"', { stance: 'sit' }],
    ['stanceFrom null', { stanceFrom: null }],
    ['stanceProgress 1.01', { stanceProgress: 1.01 }],
    ['stanceProgress -0.1', { stanceProgress: -0.1 }],
    ['stanceProgress NaN', { stanceProgress: NaN }],
    ['weapon "rocket"', { weapon: 'rocket' }],
    ['anim without ads', { anim: { ...full.anim, ads: undefined } }],
    ['anim cooking number', { anim: { ...full.anim, cooking: 1 } }],
  ])('rejects %s', (_label, over) => {
    expect(isPlayerState({ ...full, ...over })).toBe(false);
  });

  it('rejects the M1 shape (armor instead of vestTier/helmetTier)', () => {
    const { vestTier: _v, helmetTier: _h, ...rest } = full;
    expect(isPlayerState({ ...rest, armor: 50 })).toBe(false);
  });
});

describe('M2a LocalPlayerState fields', () => {
  const local = makeLocal(1, {
    activeSlot: 3,
    movement: { ...makeLocal(1).movement, stance: 'crouch', stanceFrom: 'stand', stanceMs: 120.5, adsMs: 80 },
    ammo: { ammo_light: 1, ammo_heavy: 2, ammo_shell: 3, ammo_sniper: 4, ...{ ammo_rocket: 0 } },
    vest: { tier: 2, durability: 31.25 },
    helmet: { tier: 3, durability: 0.5 },
    grenades: 2,
    cookExplodesAt: 1234.5,
    throwRecoveryMs: 400,
  });
  const snap = makeSnapshot(3, [makePlayer(1)], { local });

  it('round-trips through the quantized server encoder', () => {
    expect(decodeServerMessage(encodeQuantized({ t: 'snapshot', snap }))).toEqual({ t: 'snapshot', snap: quantizeDeep(snap) });
  });

  it('accepts null armor and a null cook', () => {
    expect(decodeSnap({ ...snap, local: { ...local, vest: null, helmet: null, cookExplodesAt: null } })).not.toBeNull();
  });

  it.each([
    ['vest tier 0', { vest: { tier: 0, durability: 5 } }],
    ['vest tier 5', { vest: { tier: 5, durability: 5 } }], // M2c: tier 4 is valid
    ['vest durability 0', { vest: { tier: 1, durability: 0 } }],
    ['helmet durability negative', { helmet: { tier: 1, durability: -1 } }],
    ['helmet as a number', { helmet: 2 }],
    ['grenades -1', { grenades: -1 }],
    ['grenades 1.5', { grenades: 1.5 }],
    ['grenades missing', { grenades: undefined }],
    ['cookExplodesAt string', { cookExplodesAt: '1' }],
    ['throwRecoveryMs -1', { throwRecoveryMs: -1 }],
    ['ammo without ammo_sniper', { ammo: { ammo_light: 1, ammo_heavy: 2, ammo_shell: 3 } }],
    ['activeSlot 4', { activeSlot: 4 }],
    ['movement stance "sit"', { movement: { ...local.movement, stance: 'sit' } }],
    ['movement without adsMs', { movement: { ...local.movement, adsMs: undefined } }],
    ['movement stanceMs -1', { movement: { ...local.movement, stanceMs: -1 } }],
  ])('rejects %s', (_label, over) => {
    expect(decodeSnap({ ...snap, local: { ...local, ...over } })).toBeNull();
  });
});

describe('M2a loot', () => {
  it('accepts every ItemId, and durability > 0 when present', () => {
    for (const item of ITEM_IDS) expect(isLoot({ id: 1, item, qty: 1, pos: v3 })).toBe(true);
    for (const item of ARMOR_IDS) expect(isLoot({ id: 1, item, qty: 1, pos: v3, durability: 12.5 })).toBe(true);
  });

  it.each([
    ['M1 vest id', { item: 'vest' }],
    ['durability 0', { durability: 0 }],
    ['durability negative', { durability: -3 }],
    ['durability string', { durability: '3' }],
    ['durability null', { durability: null }],
  ])('rejects %s', (_label, over) => {
    expect(isLoot({ id: 1, item: 'vest_2', qty: 1, pos: v3, ...over })).toBe(false);
  });

  it('round-trips durability in the full list and in a loot delta (a durability change re-adds the entry)', () => {
    const others = [2, 3, 4, 5].map((id) => ({ id, item: 'medkit' as const, qty: 1, pos: v3 }));
    const helmet = { id: 1, item: 'helmet_2' as const, qty: 1, pos: v3 };
    const a = makeSnapshot(30, [makePlayer(1)], { serverTime: 1000, loot: [{ ...helmet, durability: 40 }, ...others] });
    const b = { ...a, tick: 31, lootVersion: 2, loot: [{ ...helmet, durability: 12.5 }, ...others] };
    const enc = new SnapshotDeltaEncoder(true);
    const dec = new SnapshotDeltaDecoder();
    const wa = enc.encode(quantizeDeep(a));
    const wb = enc.encode(quantizeDeep(b));
    expect(wb.lootDelta).toEqual({ from: 1, add: [b.loot[0]], remove: [], qty: [] });
    for (const [w, want] of [[wa, a], [wb, b]] as const) {
      const m = decodeServerMessage(encodeQuantized({ t: 'snapshot', snap: w }));
      if (m?.t !== 'snapshot') throw new Error('decode failed');
      const res = dec.apply(m.snap);
      expect(res.ok && res.snap).toEqual(want);
    }
  });
});

describe('M2a grenades in snapshots', () => {
  const grenades = [makeGrenade(1), makeGrenade(2, { ownerId: 4, vel: { x: 0, y: 0, z: 0 }, inWater: true })];
  const snap = makeSnapshot(5, [makePlayer(1)], { grenades });

  it('round-trips the full list', () => {
    expect(decodeServerMessage(encodeQuantized({ t: 'snapshot', snap }))).toEqual({ t: 'snapshot', snap: quantizeDeep(snap) });
  });

  it('requires the list (empty is fine) and validates every entry', () => {
    const { grenades: _g, ...noGrenades } = snap;
    expect(decodeSnap(noGrenades)).toBeNull();
    expect(decodeSnap({ ...snap, grenades: [] })).not.toBeNull();
    for (const bad of [
      { inWater: undefined },
      { inWater: 0 },
      { explodesAt: null },
      { vel: { x: 1, y: 2 } },
      { id: 1.5 },
      { ownerId: '3' },
    ]) {
      expect(isGrenade({ ...makeGrenade(1), ...bad })).toBe(false);
      expect(decodeSnap({ ...snap, grenades: [{ ...makeGrenade(1), ...bad }] })).toBeNull();
    }
  });

  it('is sent in full on every snapshot, also in delta format, and NetClient-side decoding keeps it as received', () => {
    const enc = new SnapshotDeltaEncoder(true);
    const dec = new SnapshotDeltaDecoder();
    const s1 = quantizeDeep(snap);
    const s2 = quantizeDeep({ ...snap, tick: 6, grenades: [makeGrenade(2, { pos: { x: 3, y: 0.1, z: 1 } })] });
    const s3 = quantizeDeep({ ...snap, tick: 7, grenades: [] });
    for (const s of [s1, s2, s3]) {
      const w = enc.encode(s);
      expect(w.grenades).toEqual(s.grenades);
      const res = dec.apply(w);
      expect(res.ok && res.snap.grenades).toEqual(s.grenades);
    }
  });
});

describe('M2a events', () => {
  const hit = { tier: 2, absorbed: 12.5, broken: false } as const;
  const events: SimEvent[] = [
    { type: 'shot', shooterId: 1, weapon: 'sniper', origin: v3, impacts: [{ point: v3, surface: 'player', playerId: 2, headshot: true }] },
    { type: 'shot', shooterId: 1, weapon: 'lmg', origin: v3, impacts: [] },
    { type: 'shot', shooterId: 1, weapon: 'dmr', origin: v3, impacts: [] },
    {
      type: 'damage', victimId: 2, attackerId: 1, amount: 150, headshot: true, cause: 'weapon', sourcePos: v3, hpAfter: 0,
      vest: null, helmet: { tier: 2, absorbed: 30, broken: true },
    },
    {
      type: 'damage', victimId: 2, attackerId: 1, amount: 60, headshot: false, cause: 'explosion', sourcePos: v3,
      hpAfter: 40, vest: hit, helmet: null, grenadeId: 7,
    },
    { type: 'damage', victimId: 2, attackerId: 1, amount: 40, headshot: true, cause: 'weapon', sourcePos: v3, hpAfter: 30, vest: hit, helmet: hit },
    { type: 'kill', victimId: 2, killerId: 1, weapon: 'grenade', cause: 'explosion', placement: 4, headshot: false },
    { type: 'pickup', playerId: 1, lootId: 3, item: 'helmet_3', qty: 1, pos: v3, durability: 70.5 },
    { type: 'pickup', playerId: 1, lootId: 4, item: 'grenade', qty: 2, pos: v3 },
    { type: 'pickup', playerId: 1, lootId: 5, item: 'ammo_sniper', qty: 10, pos: v3 },
    { type: 'weaponSwitch', playerId: 1, weapon: 'grenade', slot: 3 },
    { type: 'stanceChange', playerId: 1, from: 'stand', to: 'prone', forced: false, durationMs: 600 },
    { type: 'stanceChange', playerId: 1, from: 'prone', to: 'stand', forced: true, durationMs: 500 },
    { type: 'grenadeCook', playerId: 1, pos: v3, explodesAt: 4500.5, kind: 'grenade' },
    { type: 'grenadeThrown', id: 7, ownerId: 1, pos: v3, vel: { x: 10, y: 5, z: -2 }, explodesAt: 4500.5, dropped: false, kind: 'grenade' },
    { type: 'grenadeThrown', id: 8, ownerId: 1, pos: v3, vel: { x: 0, y: 0, z: 0 }, explodesAt: 4600, dropped: true, kind: 'grenade' },
    { type: 'grenadeBounce', id: 7, pos: v3, surface: 'water', speed: 3.25, kind: 'grenade' },
    { type: 'grenadeBounce', id: 7, pos: v3, surface: 'edge', speed: 1, kind: 'grenade' },
    { type: 'explosion', id: 7, ownerId: 1, pos: v3, radius: 7.5, inHand: false, source: 'grenade' },
    { type: 'explosion', id: 9, ownerId: 1, pos: v3, radius: 7.5, inHand: true, source: 'grenade' },
    { type: 'actionFailed', playerId: 1, action: 'swap', reason: 'noGrenades' },
    { type: 'actionFailed', playerId: 1, action: 'stance', reason: 'noHeadroom' },
    { type: 'actionFailed', playerId: 1, action: 'stance', reason: 'tooDeep' },
  ];

  it('round-trips every new event and field through the quantized encoder', () => {
    const msg = { t: 'events', tick: 1, serverTime: 33.333, events } as const;
    expect(decodeServerMessage(encodeQuantized(msg))).toEqual(msg);
  });

  it('every new event is public; actionFailed stays private', () => {
    for (const ev of events) expect(privateEventRecipient(ev)).toBe(ev.type === 'actionFailed' ? ev.playerId : null);
  });

  const damage = events[3] as Record<string, unknown>;
  const stance = events[11] as Record<string, unknown>;
  it.each([
    ['damage in the M1 shape (armorAfter, no vest/helmet)', { ...damage, vest: undefined, helmet: undefined, armorAfter: 0 }],
    ['damage vest tier 0', { ...damage, vest: { tier: 0, absorbed: 1, broken: false } }],
    ['damage helmet without broken', { ...damage, helmet: { tier: 1, absorbed: 1 } }],
    ['damage helmet absorbed negative', { ...damage, helmet: { tier: 1, absorbed: -1, broken: false } }],
    ['damage unknown cause', { ...damage, cause: 'drowning' }],
    ['kill weapon "rocket"', { type: 'kill', victimId: 2, killerId: 1, weapon: 'rocket', cause: 'weapon', placement: 2 }],
    ['pickup durability string', { ...(events[7] as object), durability: 'x' }],
    ['weaponSwitch slot 4', { type: 'weaponSwitch', playerId: 1, weapon: 'grenade', slot: 4 }],
    ['stanceChange to "sit"', { ...stance, to: 'sit' }],
    ['stanceChange forced missing', { ...stance, forced: undefined }],
    ['grenadeCook without explodesAt', { type: 'grenadeCook', playerId: 1, pos: v3, kind: 'grenade' }],
    ['grenadeThrown without dropped', { ...(events[14] as object), dropped: undefined }],
    ['grenadeBounce surface "player"', { type: 'grenadeBounce', id: 7, pos: v3, surface: 'player', speed: 1, kind: 'grenade' }],
    ['explosion radius -1', { ...(events[18] as object), radius: -1 }],
    ['explosion without inHand', { ...(events[18] as object), inHand: undefined }],
    ['actionFailed unknown reason', { type: 'actionFailed', playerId: 1, action: 'stance', reason: 'sleepy' }],
  ])('rejects %s', (_label, ev) => {
    expect(isSimEvent(ev)).toBe(false);
  });
});

describe('M2a anim bitmask on the wire', () => {
  const anims = [0, 1, 0b1100000000, ANIM_MAX_FOR_TEST - 1, 0b0101010101].map(unpackAnim);

  it('packs and unpacks every flag', () => {
    for (const a of anims) expect(unpackAnim(packAnim(a))).toEqual(a);
    expect(Object.keys(unpackAnim(0)).sort()).toEqual(Object.keys(makePlayer(1).anim).sort());
  });

  it('the server encoder sends anim as an integer; the decoder restores the object (full and patch entries)', () => {
    const anim = { ...makePlayer(1).anim, moving: true, ads: true, cooking: true };
    const snap = { ...makeSnapshot(1, [makePlayer(1, { anim })]), base: 0, players: [makePlayer(1, { anim }), { id: 2, anim }] };
    const raw = encodeQuantized({ t: 'snapshot', snap });
    expect(raw).not.toContain('"cooking"');
    expect(JSON.parse(raw).snap.players[1].anim).toBe(packAnim(anim));
    const m = decodeServerMessage(raw);
    expect(m?.t === 'snapshot' && m.snap.players.map((p) => p.anim)).toEqual([anim, anim]);
  });

  it('accepts the object form too (plain encode) and rejects out-of-range or fractional masks', () => {
    const snap = makeSnapshot(1, [makePlayer(1)]);
    expect(decodeServerMessage(encode({ t: 'snapshot', snap }))).toEqual({ t: 'snapshot', snap });
    for (const anim of [-1, ANIM_MAX_FOR_TEST, 1.5, '3']) {
      expect(decodeSnap({ ...snap, players: [{ ...makePlayer(1), anim }] })).toBeNull();
    }
  });

  it('leaves a raw object passed to the decoder untouched', () => {
    const raw = { t: 'snapshot', snap: { ...makeSnapshot(1, []), players: [{ ...makePlayer(1), anim: 3 }] } };
    decodeServerMessage(raw);
    expect(raw.snap.players[0]!.anim).toBe(3);
  });
});

describe('M2a player deltas', () => {
  const base = makePlayer(1, { vestTier: 2, helmetTier: 1, stance: 'crouch', stanceFrom: 'crouch', stanceProgress: 1 });

  it('a settled player costs nothing (no patch)', () => {
    expect(diffPlayer(base, { ...base })).toBeNull();
  });

  it('sends only the changed M2a fields', () => {
    const cur: PlayerState = { ...base, stance: 'prone', stanceFrom: 'crouch', stanceProgress: 0.2 };
    expect(diffPlayer(base, cur)).toEqual({ id: 1, stance: 'prone', stanceProgress: 0.2 });
    expect(diffPlayer(cur, { ...cur, stanceProgress: 0.6 })).toEqual({ id: 1, stanceProgress: 0.6 });
    expect(diffPlayer(base, { ...base, vestTier: 0 })).toEqual({ id: 1, vestTier: 0 });
    expect(diffPlayer(base, { ...base, helmetTier: 3, weapon: 'grenade' })).toEqual({ id: 1, helmetTier: 3, weapon: 'grenade' });
    const anim = { ...base.anim, ads: true };
    expect(diffPlayer(base, { ...base, anim })).toEqual({ id: 1, anim });
  });

  it('patches with the new fields rebuild exactly through encoder and decoder', () => {
    const stances: Stance[] = ['stand', 'crouch', 'prone'];
    const enc = new SnapshotDeltaEncoder(true);
    const dec = new SnapshotDeltaDecoder();
    let snap: WorldSnapshot = makeSnapshot(1, [base, makePlayer(2)]);
    for (let tick = 1; tick <= 20; tick++) {
      const p = snap.players[0] as PlayerState;
      const next: PlayerState = {
        ...p,
        stance: stances[tick % 3] as Stance,
        stanceFrom: stances[(tick + 1) % 3] as Stance,
        stanceProgress: (tick % 7) / 7,
        vestTier: (tick % 4) as PlayerState['vestTier'],
        anim: { ...p.anim, ads: tick % 2 === 0, cooking: tick % 5 === 0 },
      };
      snap = quantizeDeep({ ...snap, tick, players: [next, snap.players[1] as PlayerState], grenades: [makeGrenade(tick)] });
      const wire = enc.encode(snap);
      const m = decodeServerMessage(encodeQuantized({ t: 'snapshot', snap: wire }));
      if (m?.t !== 'snapshot') throw new Error(`tick ${tick}: wire snapshot did not decode`);
      const res = dec.apply(m.snap);
      expect(res.ok && res.snap).toEqual(snap);
    }
  });
});

/**
 * ARCHITECTURE §11 / §14: 16 players and 10 live grenades, everyone mid-transition and aiming, must stay under 8 KB per
 * snapshot without loot. Worst case on purpose: full PlayerStates (join/resync format), long names, armor, wide
 * coordinates with 3 decimals everywhere, and a busy local state.
 */
describe('M2a snapshot budget', () => {
  const BUDGET = 8 * 1024;
  const r = (i: number, k: number) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1) * 150; // spread, 3 dp

  function worstCase(): WorldSnapshot {
    const players: PlayerState[] = [];
    for (let i = 1; i <= 16; i++) {
      players.push(
        makePlayer(i, {
          name: `Castaway_${String(i).padStart(6, '0')}`.slice(0, 16),
          pos: { x: r(i, 1) + 0.123, y: Math.abs(r(i, 2)) / 20 + 0.456, z: r(i, 3) - 0.789 },
          velY: -3.217,
          yaw: 2.345,
          pitch: -0.321,
          hp: 87.654,
          vestTier: 3,
          helmetTier: 2,
          weapon: i % 2 === 0 ? 'sniper' : 'grenade',
          stance: 'prone',
          stanceFrom: 'stand',
          stanceProgress: 0.537,
          anim: {
            moving: true, sprinting: false, airborne: false, dropping: false, inWater: false, firing: true,
            reloading: false, healing: false, ads: true, cooking: i % 2 === 1,
          },
          isBot: i > 2,
          kills: 12,
        }),
      );
    }
    const grenades = Array.from({ length: 10 }, (_, k) =>
      makeGrenade(1000 + k, {
        ownerId: k + 1,
        pos: { x: r(k, 4) + 0.111, y: 3.333, z: r(k, 5) - 0.222 },
        vel: { x: -12.345, y: 7.891, z: 4.567 },
        explodesAt: 123456.789,
        inWater: k % 3 === 0,
      }),
    );
    return quantizeDeep(
      makeSnapshot(36000, players, {
        serverTime: 1_200_000.333,
        loot: [],
        // M2b: a live match carries its carrier route (fixed for the World) and the map id.
        match: makeMatch({
          matchId: 41, phaseEndsAt: null, aliveCount: 16, totalPlayers: 16, mapId: 'island01', aboardCount: 0,
          route: {
            mapId: 'island01', entry: { x: -187.654, z: 123.456 }, exit: { x: 176.543, z: -134.567 },
            eject: { x: 143.21, z: -110.987 }, altitude: 120.5, speed: 41.667, startsAt: 1_160_033.333,
            noJumpUntil: 1_161_533.333, ejectAt: 1_168_766.667, endsAt: 1_169_900.001,
          },
        }),
        zone: {
          phaseIndex: 3, phaseCount: 6, center: { x: 12.345, z: -67.891 }, radius: 45.678,
          targetCenter: { x: 10.123, z: -60.456 }, targetRadius: 20.789, phaseEndsAt: 1_234_567.891, shrinking: true, dps: 4,
        },
        grenades,
        local: makeLocal(1, {
          lastProcessedInputSeq: 123456,
          movement: {
            pos: { x: 123.456, y: 4.567, z: -98.765 }, vel: { x: 1.234, y: -0.567, z: 2.345 }, grounded: true,
            dropping: false, stance: 'prone', stanceFrom: 'stand', stanceMs: 321.5, adsMs: 0,
            // M2b (C-gate fields; on the wire these defaults are omitted and restored by the decoder).
            ...{ dropPhase: null, dropMs: 0 },
          },
          slots: [{ weapon: 'sniper', mag: 5 }, { weapon: 'lmg', mag: 100 }],
          activeSlot: 3,
          ammo: { ammo_light: 120, ammo_heavy: 240, ammo_shell: 32, ammo_sniper: 20, ...{ ammo_rocket: 2 } },
          heals: { bandage: 5, medkit: 2 },
          vest: { tier: 3, durability: 81.234 },
          helmet: { tier: 2, durability: 37.891 },
          grenades: 3,
          cookExplodesAt: 1_201_234.567,
          throwRecoveryMs: 0,
        }),
      }),
    );
  }

  it('16 players + 10 grenades, all in transitions and ADS, full format without loot: under 8 KB', () => {
    const snap = worstCase();
    const { loot: _l, ...noLoot } = snap;
    const bytes = encodeQuantized({ t: 'snapshot', snap: { ...noLoot, lootVersion: snap.lootVersion } }).length;
    if (process.env.SNAP_SIZES) console.info(`worst-case full snapshot without loot: ${bytes} B`);
    expect(bytes).toBeLessThan(BUDGET);
    // The grenade list itself is small: about 120-150 B each after quantisation (ADR 0004 §8), + 17 B for the M2c
    // `kind` in the object format. On the wire (rows) it is about half of that (m2c.test.ts).
    expect(JSON.stringify(snap.grenades).length / 10).toBeLessThan(180);
    // REVIEW-M2c N7: the wire form (rows) is the bound that matters; keep it tight.
    expect(JSON.stringify(snap.grenades.map(grenadeToRow)).length / 10).toBeLessThan(90);
  });

  it('the same scene as a delta (everyone mid-transition) is far smaller', () => {
    const a = worstCase();
    const b: WorldSnapshot = quantizeDeep({
      ...a,
      tick: a.tick + 1,
      players: a.players.map((p) => ({ ...p, stanceProgress: 0.62, pos: { ...p.pos, x: p.pos.x + 0.05 } })),
    });
    const enc = new SnapshotDeltaEncoder(true);
    enc.encode(a);
    const bytes = encodeQuantized({ t: 'snapshot', snap: enc.encode(b) }).length;
    if (process.env.SNAP_SIZES) console.info(`worst-case delta snapshot: ${bytes} B`);
    expect(bytes).toBeLessThan(BUDGET / 2);
  });
});
