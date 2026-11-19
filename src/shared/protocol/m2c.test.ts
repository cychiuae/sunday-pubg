/**
 * M2c protocol (ADR 0007 §9-§10, ARCHITECTURE §16.5 N1): the row codec, carry-forward of rockets / smokes /
 * brokenPanes, the C-gate staged M2c validators, the new events, welcome.layout, cycleScope, and the snapshot budgets
 * (24-player worst case < 8,192 B, 16-player M2b worst case < 6,500 B, worst delta < 4,096 B).
 *
 * `SNAP_SIZES=1 npx vitest run src/shared/protocol/m2c.test.ts` prints the measured sizes.
 */
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../constants';
import type { PlayerState, RocketState, SimEvent, SmokeCloudState, WorldSnapshot } from '../types';
import { SnapshotDeltaDecoder, SnapshotDeltaEncoder } from './delta';
import {
  M2C_FIELDS_REQUIRED,
  decodeClientMessage,
  decodeServerMessage,
  encode,
  encodeQuantized,
  isLayoutRef,
  isSimEvent,
  quantizeDeep,
  type SnapshotMessage,
  type WireSnapshot,
} from './messages';
import {
  GRENADE_COLUMNS,
  PLAYER_COLUMNS,
  ROCKET_COLUMNS,
  SMOKE_COLUMNS,
  grenadeToRow,
  playerToRow,
  rowToPlayer,
} from './rows';
import {
  makeGrenade,
  makeInput,
  makeLocal,
  makeMatch,
  makePlayer,
  makeRocket,
  makeSmoke,
  makeSnapshot,
  makeWelcome,
} from './testing';

const v3 = { x: 1.5, y: 2.25, z: -3.125 };
/** Copy without `keys` (typed as the input: these fields are optional before the C-gate and required after it). */
const without = <T extends object>(o: T, ...keys: string[]): T => {
  const c = { ...o } as Record<string, unknown>;
  for (const k of keys) delete c[k];
  return c as T;
};
const decode = (text: string) => decodeServerMessage(text) as SnapshotMessage | null;
/** Wire round trip through the real decoder path (decodeServerMessage + SnapshotDeltaDecoder). */
function roundTrip(dec: SnapshotDeltaDecoder, wire: WireSnapshot, rows = true): WorldSnapshot {
  const m = decode(encodeQuantized({ t: 'snapshot', snap: wire }, { rows }));
  if (!m) throw new Error('snapshot did not decode');
  const res = dec.apply(m.snap);
  if (!res.ok) throw new Error(res.reason);
  return res.snap;
}

describe('C-gate switch (M2c)', () => {
  it('M2C_FIELDS_REQUIRED follows PROTOCOL_VERSION 4 (the gate commit flips both at once)', () => {
    expect(M2C_FIELDS_REQUIRED).toBe(PROTOCOL_VERSION >= 4);
  });
});

describe('row codec', () => {
  const busy = makePlayer(7, {
    name: 'Row Player', pos: { x: 12.345, y: 1.5, z: -9.876 }, velY: -2.5, yaw: 1.25, pitch: -0.5, hp: 63.5,
    vestTier: 4 as PlayerState['vestTier'], helmetTier: 2, alive: false, weapon: 'sniper', stance: 'crouch', stanceFrom: 'prone',
    stanceProgress: 0.25, anim: { ...makePlayer(1).anim, moving: true, ads: true }, isBot: true, kills: 3,
    aboard: true, dropPhase: 'chute', weaponLevel: 3, sight: 'scope_4x',
  });

  it('column lists are the ADR 0007 §9 order (append only: this test pins it)', () => {
    expect(PLAYER_COLUMNS.join(',')).toBe(
      'id,name,x,y,z,velY,yaw,pitch,hp,vestTier,helmetTier,alive,weapon,weaponLevel,sight,stance,stanceFrom,' +
        'stanceProgress,anim,skin,outfit,hair,isBot,kills,aboard,dropPhase',
    );
    expect(GRENADE_COLUMNS.join(',')).toBe('id,ownerId,x,y,z,vx,vy,vz,explodesAt,inWater,kind');
    expect(ROCKET_COLUMNS.join(',')).toBe('id,ownerId,level,x,y,z,vx,vy,vz,firedAt');
    expect(SMOKE_COLUMNS.join(',')).toBe('id,ownerId,x,y,z,deployedAt,fadeAt');
  });

  it('a player row has one value per column; booleans, levels and drop phases are small integers', () => {
    const row = playerToRow(busy, 0b100000001);
    expect(row).toHaveLength(PLAYER_COLUMNS.length);
    const at = (c: (typeof PLAYER_COLUMNS)[number]) => row[PLAYER_COLUMNS.indexOf(c)];
    expect([at('alive'), at('isBot'), at('aboard'), at('dropPhase'), at('weaponLevel'), at('sight')]).toEqual([0, 1, 1, 2, 3, 'scope_4x']);
    expect(playerToRow(makePlayer(1), 0)[PLAYER_COLUMNS.indexOf('weaponLevel')]).toBe(0); // null -> 0
    expect(playerToRow(makePlayer(1, { dropPhase: 'freefall' }), 0)[PLAYER_COLUMNS.indexOf('dropPhase')]).toBe(1);
  });

  it('full snapshots round-trip exactly as rows (players, grenades, rockets, smokes)', () => {
    const snap = quantizeDeep(
      makeSnapshot(9, [makePlayer(1), busy], {
        grenades: [makeGrenade(3), makeGrenade(4, { kind: 'smoke', inWater: true })],
        rockets: [makeRocket(5, { level: 4 })],
        smokes: [makeSmoke(6)],
        brokenPanes: [0, 4, 9],
        local: makeLocal(1, { melee: { weapon: 'paddle', level: 2 }, smokes: 2, selectedThrowable: 'smoke', spareScope: 'scope_8x', scopeSwapRemainingMs: 120 }),
      }),
    );
    const text = encodeQuantized({ t: 'snapshot', snap });
    const parsed = JSON.parse(text) as { snap: Record<string, unknown[]> };
    for (const k of ['players', 'grenades', 'rockets', 'smokes']) expect(parsed.snap[k]!.every(Array.isArray)).toBe(true);
    expect(parsed.snap.brokenPanes).toEqual([0, 4, 9]);
    expect(decode(text)?.snap).toEqual(snap);
    expect(roundTrip(new SnapshotDeltaDecoder(), snap)).toEqual(snap);
  });

  it('fields absent before the C-gate stay absent (null columns), so M2b-shaped Worlds still round-trip', () => {
    const p = without(makePlayer(2), 'weaponLevel', 'sight');
    const g = without(makeGrenade(3), 'kind');
    expect(rowToPlayer(playerToRow(p, 0))).not.toHaveProperty('weaponLevel');
    expect(grenadeToRow(g).at(-1)).toBeNull();
    const snap = quantizeDeep(makeSnapshot(1, [p], { grenades: [g] }));
    const m = decode(encodeQuantized({ t: 'snapshot', snap }));
    if (M2C_FIELDS_REQUIRED) expect(m).toBeNull();
    else expect(m?.snap).toEqual(snap);
  });

  it('patches stay keyed objects; new players inside a delta stay objects too', () => {
    const enc = new SnapshotDeltaEncoder(true);
    const dec = new SnapshotDeltaDecoder();
    const a = quantizeDeep(makeSnapshot(1, [makePlayer(1)]));
    const b = quantizeDeep(makeSnapshot(2, [makePlayer(1, { hp: 50 }), makePlayer(2)]));
    roundTrip(dec, enc.encode(a));
    const wire = enc.encode(b);
    const parsed = JSON.parse(encodeQuantized({ t: 'snapshot', snap: wire })) as { snap: { players: unknown[] } };
    expect(parsed.snap.players).toEqual([{ id: 1, hp: 50 }, expect.objectContaining({ id: 2, name: 'P2' })]);
    const m = decode(encodeQuantized({ t: 'snapshot', snap: wire }));
    expect(dec.apply(m!.snap)).toEqual({ ok: true, snap: b });
  });

  it('the object format (sessions without CAP_ROWS) decodes to the same snapshot', () => {
    const snap = quantizeDeep(makeSnapshot(3, [makePlayer(1, { weaponLevel: 2, sight: 'iron', weapon: 'pistol' })], {
      grenades: [makeGrenade(4)], rockets: [makeRocket(5)], smokes: [makeSmoke(6)],
    }));
    expect(decode(encodeQuantized({ t: 'snapshot', snap }, { rows: false }))?.snap).toEqual(snap);
  });

  it.each([
    ['a short player row', (s: Record<string, unknown[]>) => (s.players![0] as unknown[]).pop()],
    ['a long grenade row', (s: Record<string, unknown[]>) => (s.grenades![0] as unknown[]).push(1)],
    ['alive = 2', (s: Record<string, unknown[]>) => ((s.players![0] as unknown[])[PLAYER_COLUMNS.indexOf('alive')] = 2)],
    ['dropPhase = 3', (s: Record<string, unknown[]>) => ((s.players![0] as unknown[])[PLAYER_COLUMNS.indexOf('dropPhase')] = 3)],
    ['weaponLevel = 5', (s: Record<string, unknown[]>) => ((s.players![0] as unknown[])[PLAYER_COLUMNS.indexOf('weaponLevel')] = 5)],
    ['anim mask out of range', (s: Record<string, unknown[]>) => ((s.players![0] as unknown[])[PLAYER_COLUMNS.indexOf('anim')] = 1 << 20)],
    ['rocket level 0', (s: Record<string, unknown[]>) => ((s.rockets![0] as unknown[])[2] = 0)],
    ['smoke fading before it deploys', (s: Record<string, unknown[]>) => ((s.smokes![0] as unknown[])[6] = 0)],
  ])('rejects %s', (_label, mutate) => {
    const snap = quantizeDeep(makeSnapshot(2, [makePlayer(1)], { grenades: [makeGrenade(3)], rockets: [makeRocket(4)], smokes: [makeSmoke(5)] }));
    const parsed = JSON.parse(encodeQuantized({ t: 'snapshot', snap })) as { t: string; snap: Record<string, unknown[]> };
    mutate(parsed.snap);
    expect(decodeServerMessage(JSON.stringify(parsed))).toBeNull();
  });
});

describe('carry-forward of rockets, smokes and brokenPanes (ADR 0007 §9.2)', () => {
  it('a delta omits each list while it equals the base; a change sends the list or { add, remove }; the decoder restores them', () => {
    const enc = new SnapshotDeltaEncoder(true);
    const dec = new SnapshotDeltaDecoder();
    const r1 = makeRocket(10);
    const r2 = makeRocket(11, { ownerId: 2 });
    const c1 = makeSmoke(12);
    const states = [
      makeSnapshot(1, [makePlayer(1)], { rockets: [r1], smokes: [c1], brokenPanes: [2] }),
      makeSnapshot(2, [makePlayer(1)], { rockets: [r1], smokes: [c1], brokenPanes: [2] }),
      makeSnapshot(3, [makePlayer(1)], { rockets: [r1, r2], smokes: [c1], brokenPanes: [2, 5] }),
      makeSnapshot(4, [makePlayer(1)], { rockets: [r2], smokes: [{ ...c1, fadeAt: 110_000 }], brokenPanes: [2, 5] }),
      makeSnapshot(5, [makePlayer(1)], { rockets: [], smokes: [], brokenPanes: [2, 5] }),
    ].map((s) => quantizeDeep(s));
    const present: string[][] = [];
    for (const s of states) {
      const wire = enc.encode(s);
      present.push((['rockets', 'rocketsDelta', 'smokes', 'smokesDelta', 'brokenPanes'] as const).filter((k) => wire[k] !== undefined));
      expect(roundTrip(dec, wire)).toEqual(s);
    }
    expect(present).toEqual([
      ['rockets', 'smokes', 'brokenPanes'], // full
      [], // unchanged
      ['rocketsDelta', 'brokenPanes'], // one rocket added: { add: [r2], remove: [] }
      ['rocketsDelta', 'smokes'], // r1 removed; a forced earlier fade replaces the only cloud (whole list is as small)
      ['rockets', 'smokes'], // empty lists ride whole
    ]);
  });

  it('the M1 format (no delta1) sends every list every time; a reset encoder sends them again', () => {
    const plain = new SnapshotDeltaEncoder(false);
    const s = quantizeDeep(makeSnapshot(1, [makePlayer(1)], { rockets: [makeRocket(1)] }));
    expect(plain.encode(s).rockets).toHaveLength(1);
    expect(plain.encode({ ...s, tick: 2 }).rockets).toHaveLength(1);
    const enc = new SnapshotDeltaEncoder(true);
    enc.encode(s);
    expect(enc.encode({ ...s, tick: 2 }).rockets).toBeUndefined();
    enc.reset();
    expect(enc.encode({ ...s, tick: 3 }).rockets).toHaveLength(1);
  });

  it('a delta may omit the lists (shape check); a full snapshot may not after the gate', () => {
    const s = without(makeSnapshot(1, [makePlayer(1)]), 'rockets', 'smokes', 'brokenPanes');
    expect(decodeServerMessage(encode({ t: 'snapshot', snap: { ...s, base: 0 } }))).not.toBeNull();
    const full = decodeServerMessage(encode({ t: 'snapshot', snap: s }));
    if (M2C_FIELDS_REQUIRED) expect(full).toBeNull();
    else expect(full).not.toBeNull();
    expect(decodeServerMessage(encode({ t: 'snapshot', snap: { ...s, brokenPanes: [3, 2] } }))).toBeNull(); // ascending
    expect(decodeServerMessage(encode({ t: 'snapshot', snap: { ...s, brokenPanes: [-1] } }))).toBeNull();
  });
});

describe('local delta (M2c)', () => {
  it('a delta carries only the changed local fields; null, a new local player and a lost key go whole', () => {
    const enc = new SnapshotDeltaEncoder(true);
    const dec = new SnapshotDeltaDecoder();
    const l1 = makeLocal(1);
    const moved = { ...l1, lastProcessedInputSeq: 5, movement: { ...l1.movement, pos: { x: 1.25, y: 0, z: -2.5 } } };
    const { aboard: _a, ...lost } = moved as typeof moved & { aboard?: boolean };
    const states = [
      makeSnapshot(1, [makePlayer(1)], { local: l1 }),
      makeSnapshot(2, [makePlayer(1)], { local: l1 }),
      makeSnapshot(3, [makePlayer(1)], { local: moved }),
      makeSnapshot(4, [makePlayer(1)], { local: null }),
      makeSnapshot(5, [makePlayer(1)], { local: moved }),
      makeSnapshot(6, [makePlayer(1), makePlayer(2)], { local: makeLocal(2) }),
      makeSnapshot(7, [makePlayer(1)], { local: lost as never }),
    ].map((x) => quantizeDeep(x));
    const shapes: string[] = [];
    for (const st of states) {
      const wire = enc.encode(st);
      shapes.push(wire.local === undefined ? `patch:${Object.keys(wire.localPatch ?? {}).sort().join('+')}` : wire.local === null ? 'null' : 'whole');
      if (st.tick === 7) continue; // a local without `aboard` fails the shape check by design (M2b field)
      expect(roundTrip(dec, wire)).toEqual(st);
    }
    expect(shapes).toEqual(['whole', 'patch:', 'patch:lastProcessedInputSeq+movement', 'null', 'whole', 'whole', 'whole']);
  });

  it('an encoder without localPatch (a delta1 client without rows1) always sends local whole', () => {
    const enc = new SnapshotDeltaEncoder(true, false);
    const s1 = quantizeDeep(makeSnapshot(1, [makePlayer(1)], { local: makeLocal(1) }));
    enc.encode(s1);
    const wire = enc.encode({ ...s1, tick: 2 });
    expect(wire.base).toBe(1);
    expect(wire.local).toEqual(s1.local);
    expect(wire.localPatch).toBeUndefined();
  });

  it('a local patch without a base, or one that breaks the local, is refused (and asks for a resync)', () => {
    const noBase = { ...makeSnapshot(1, [makePlayer(1)]), localPatch: { smokes: 1 } } as Record<string, unknown>;
    delete noBase.local;
    expect(decodeServerMessage(encode({ t: 'snapshot', snap: noBase as never }))).toBeNull();
    const enc = new SnapshotDeltaEncoder(true);
    const dec = new SnapshotDeltaDecoder();
    roundTrip(dec, enc.encode(quantizeDeep(makeSnapshot(1, [makePlayer(1)], { local: null }))));
    const orphan = { ...makeSnapshot(2, [makePlayer(1)]), base: 1, localPatch: { smokes: 1 } } as Record<string, unknown>;
    delete orphan.local;
    const m = decode(encode({ t: 'snapshot', snap: orphan as never }));
    expect(m && dec.apply(m.snap).ok).toBe(false);
    const bad = { ...makeSnapshot(2, [makePlayer(1)]), base: 1, localPatch: { smokes: -1 } } as Record<string, unknown>;
    delete bad.local;
    expect(decodeServerMessage(encode({ t: 'snapshot', snap: bad as never }))).toBeNull();
    const both = { ...makeSnapshot(2, [makePlayer(1)], { local: makeLocal(1) }), base: 1, localPatch: { smokes: 1 } };
    expect(decodeServerMessage(encode({ t: 'snapshot', snap: both as never }))).toBeNull();
  });
});

describe('M2c state validators', () => {
  const snapWith = (over: Parameters<typeof makeSnapshot>[2]) => decode(encodeQuantized({ t: 'snapshot', snap: makeSnapshot(1, [makePlayer(1)], over) }));

  it('accepts the new ids, levels, scopes and tier 4', () => {
    const p = makePlayer(1, { weapon: 'machete' as PlayerState['weapon'], weaponLevel: 4, sight: 'scope_2x', vestTier: 4 as PlayerState['vestTier'] });
    const local = makeLocal(1, {
      slots: [{ weapon: 'rpg' as never, mag: 1, level: 2, scope: null }, { weapon: 'revolver' as never, mag: 6, level: 1, scope: 'scope_red_dot' }],
      vest: { tier: 4 as never, durability: 80 },
      melee: { weapon: 'knife', level: 1 },
    });
    const loot = [
      { id: 1, item: 'dbshotgun' as never, qty: 1, pos: v3, level: 3 as const, scope: null },
      { id: 2, item: 'scope_8x' as never, qty: 1, pos: v3 },
      { id: 3, item: 'helmet_4' as never, qty: 1, pos: v3, durability: 90 },
    ];
    expect(decode(encodeQuantized({ t: 'snapshot', snap: makeSnapshot(1, [p], { local, loot }) }))).not.toBeNull();
  });

  it.each([
    ['weaponLevel 5', { players: [makePlayer(1, { weaponLevel: 5 as never })] }],
    ['sight scope_3x', { players: [makePlayer(1, { sight: 'scope_3x' as never })] }],
    ['slot level 0', { local: makeLocal(1, { slots: [{ weapon: 'pistol', mag: 1, level: 0 as never }, null] }) }],
    ['slot scope on a bad id', { local: makeLocal(1, { slots: [{ weapon: 'pistol', mag: 1, scope: 'scope_9x' as never }, null] }) }],
    ['melee gun', { local: makeLocal(1, { melee: { weapon: 'pistol' as never, level: 1 } }) }],
    ['smokes -1', { local: makeLocal(1, { smokes: -1 }) }],
    ['selectedThrowable medkit', { local: makeLocal(1, { selectedThrowable: 'medkit' as never }) }],
    ['spareScope iron', { local: makeLocal(1, { spareScope: 'iron' as never }) }],
    ['loot level 1.5', { loot: [{ id: 1, item: 'pistol', qty: 1, pos: v3, level: 1.5 as never }] }],
    ['grenade kind rock', { grenades: [makeGrenade(1, { kind: 'rock' as never })] }],
    ['vestTier 5', { players: [makePlayer(1, { vestTier: 5 as never })] }],
  ])('rejects %s', (_label, over) => {
    const players = (over as { players?: PlayerState[] }).players ?? [makePlayer(1)];
    expect(decode(encodeQuantized({ t: 'snapshot', snap: makeSnapshot(1, players, over as never) }))).toBeNull();
  });

  it('gated local fields and ammo_rocket are required only after the gate', () => {
    const l = without(makeLocal(1), 'smokes');
    const ammo = without(l.ammo, 'ammo_rocket');
    const m = snapWith({ local: { ...l, ammo } as never });
    if (M2C_FIELDS_REQUIRED) expect(m).toBeNull();
    else expect(m).not.toBeNull();
  });
});

describe('M2c events', () => {
  const ok: SimEvent[] = [
    { type: 'meleeSwing', playerId: 1, weapon: 'knife', level: 2, pos: v3, hitAt: 1234.5, cycleMs: 450 },
    { type: 'meleeHit', attackerId: 1, weapon: 'paddle', level: 1, pos: v3, surface: 'player', victimId: 2, headshot: false, knockback: true },
    { type: 'meleeHit', attackerId: 1, weapon: 'machete', level: 4, pos: v3, surface: 'glass', victimId: null, headshot: false, knockback: false },
    { type: 'rocketFired', ...makeRocket(9) },
    { type: 'rocketDud', id: 9, ownerId: 1, pos: v3, surface: 'range', victimId: null },
    { type: 'smokeDeployed', ...makeSmoke(8) },
    { type: 'glassBroken', paneId: 3, pos: v3, byId: null, cause: 'rocket' },
    { type: 'scopeChanged', playerId: 1, slot: 1, gun: 'dbshotgun', from: null, to: 'scope_red_dot', auto: true, pos: v3 },
    {
      type: 'damage', victimId: 2, attackerId: 1, amount: 40, headshot: false, cause: 'rocket', sourcePos: v3, hpAfter: 60,
      vest: { tier: 4, absorbed: 5, broken: false }, helmet: null, grenadeId: 9, weapon: 'rpg', weaponLevel: 3,
    },
    { type: 'kill', victimId: 2, killerId: 1, weapon: 'knife', cause: 'melee', placement: 3, weaponLevel: 1, direct: false },
    { type: 'pickup', playerId: 1, lootId: 4, item: 'revolver', qty: 1, pos: v3, level: 2, scope: 'scope_2x' },
    { type: 'reloadStart', playerId: 1, weapon: 'dbshotgun', durationMs: 900, rounds: 2 },
    { type: 'weaponSwitch', playerId: 1, weapon: 'smoke', slot: 3, level: null },
    { type: 'grenadeThrown', id: 5, ownerId: 1, pos: v3, vel: v3, explodesAt: 3000, dropped: false, kind: 'smoke' },
    { type: 'explosion', id: 9, ownerId: 1, pos: v3, radius: 6, inHand: false, source: 'rocket', direct: true, airburst: false },
    { type: 'actionFailed', playerId: 1, action: 'scope', reason: 'scopePouchFull' },
  ] as unknown as SimEvent[];

  it('accepts the 7 new event types and the new fields, and keeps them through the events frame', () => {
    for (const e of ok) expect(isSimEvent(e), e.type).toBe(true);
    const m = decodeServerMessage(encodeQuantized({ t: 'events', tick: 1, serverTime: 2, events: ok }));
    expect(m?.t === 'events' && m.events).toEqual(quantizeDeep(ok));
  });

  it.each([
    ['meleeSwing with a gun', { type: 'meleeSwing', playerId: 1, weapon: 'pistol', level: 1, pos: v3, hitAt: 1, cycleMs: 1 }],
    ['meleeHit without knockback', { type: 'meleeHit', attackerId: 1, weapon: 'knife', level: 1, pos: v3, surface: 'player', victimId: 2, headshot: false }],
    ['rocketFired level 0', { type: 'rocketFired', ...makeRocket(1, { level: 0 as never }) }],
    ['rocketDud on "sky"', { type: 'rocketDud', id: 1, ownerId: 1, pos: v3, surface: 'sky', victimId: null }],
    ['smokeDeployed without fadeAt', { type: 'smokeDeployed', id: 1, ownerId: 1, pos: v3, deployedAt: 1 }],
    ['glassBroken by a bullet', { type: 'glassBroken', paneId: 1, pos: v3, byId: 1, cause: 'weapon' }],
    ['glassBroken pane -1', { type: 'glassBroken', paneId: -1, pos: v3, byId: 1, cause: 'melee' }],
    ['scopeChanged on slot 2', { type: 'scopeChanged', playerId: 1, slot: 2, gun: 'rifle', from: null, to: null, auto: false, pos: v3 }],
    ['scopeChanged on a knife', { type: 'scopeChanged', playerId: 1, slot: 0, gun: 'knife', from: null, to: null, auto: false, pos: v3 }],
    ['damage weaponLevel 7', { ...ok[8], weaponLevel: 7 }],
    ['kill direct "yes"', { ...ok[9], direct: 'yes' }],
    ['pickup scope on a bad id', { ...ok[10], scope: 'x' }],
    ['explosion source smoke', { ...ok[14], source: 'smoke' }],
    ['grenadeThrown kind rock', { ...ok[13], kind: 'rock' }],
  ])('rejects %s', (_label, ev) => {
    expect(isSimEvent(ev)).toBe(false);
  });

  it('kind and source are required only after the gate', () => {
    const { kind: _k, ...thrown } = ok[13] as unknown as Record<string, unknown>;
    const { source: _s, ...boom } = ok[14] as unknown as Record<string, unknown>;
    expect(isSimEvent(thrown)).toBe(!M2C_FIELDS_REQUIRED);
    expect(isSimEvent(boom)).toBe(!M2C_FIELDS_REQUIRED);
  });
});

describe('welcome.layout and RoomState.map.layout', () => {
  it('welcome: uint32 seed and hash, integer version, known look', () => {
    expect(decodeServerMessage(encode({ t: 'welcome', welcome: makeWelcome() }))).toEqual({ t: 'welcome', welcome: makeWelcome() });
    const big = makeWelcome({ layout: { seed: 0xffffffff, version: 1, hash: 0xffffffff, look: 'afterHours' } });
    expect(decodeServerMessage(encode({ t: 'welcome', welcome: big }))).not.toBeNull();
    for (const layout of [
      { seed: -1, version: 1, hash: 1, look: 'noon' },
      { seed: 2 ** 32, version: 1, hash: 1, look: 'noon' },
      { seed: 1.5, version: 1, hash: 1, look: 'noon' },
      { seed: 1, version: 1.5, hash: 1, look: 'noon' },
      { seed: 1, version: 1, hash: -5, look: 'noon' },
      { seed: 1, version: 1, hash: 1, look: 'midnight' },
      { seed: 1, version: 1, look: 'noon' },
    ]) {
      expect(isLayoutRef(layout)).toBe(false);
      expect(decodeServerMessage(encode({ t: 'welcome', welcome: makeWelcome({ layout: layout as never }) }))).toBeNull();
    }
    const { layout: _l, ...noLayout } = makeWelcome();
    expect(decodeServerMessage(JSON.stringify({ t: 'welcome', welcome: noLayout })) === null).toBe(M2C_FIELDS_REQUIRED);
  });

  it('room map layout: optional; seed and look checked when present', () => {
    const room = {
      id: 'r1', code: 'ABCD', settings: { name: null, visibility: 'public', mapMode: 'vote', maxHumans: 8, fillBots: true },
      hostId: 1, hostName: 'H', members: [], phase: 'countdown', phaseSince: 0, pinnedMap: null,
      map: { id: 'office', via: 'vote', layout: { seed: 123, look: 'evening' } }, countdownEndsAt: 10, lockAt: 7,
      autoStart: null, votes: null, botSeats: 0, matchId: null,
    };
    expect(decodeServerMessage(JSON.stringify({ t: 'room', room }))).not.toBeNull();
    expect(decodeServerMessage(JSON.stringify({ t: 'room', room: { ...room, map: { id: 'office', via: 'vote' } } }))).not.toBeNull();
    expect(decodeServerMessage(JSON.stringify({ t: 'room', room: { ...room, map: { ...room.map, layout: { seed: 1, look: 'dusk' } } } }))).toBeNull();
    expect(decodeServerMessage(JSON.stringify({ t: 'room', room: { ...room, map: { ...room.map, layout: { seed: -1, look: 'day' } } } }))).toBeNull();
  });
});

describe('cycleScope input edge', () => {
  const frame = (input: Record<string, unknown>) => decodeClientMessage(JSON.stringify({ t: 'input', input }));
  it('absent = false; only true counts', () => {
    const { cycleScope: _c, ...old } = makeInput();
    expect(frame(old)).toEqual({ t: 'input', input: makeInput({ cycleScope: false }) });
    expect(frame({ ...old, cycleScope: true })).toEqual({ t: 'input', input: makeInput({ cycleScope: true }) });
    expect(frame({ ...old, cycleScope: 'yes' })).toEqual({ t: 'input', input: makeInput({ cycleScope: false }) });
  });
});

/**
 * ADR 0007 §9.5 budgets, measured with the M2a worst-case method: full PlayerStates (join/resync format), no loot,
 * long names, armor, wide coordinates with 3 decimals everywhere, everyone mid-transition and aiming, M2c fields set,
 * and a busy local state.
 */
describe('M2c snapshot budget (rows)', () => {
  const r = (i: number, k: number) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1) * 150; // spread, 3 dp

  function players(n: number): PlayerState[] {
    const out: PlayerState[] = [];
    for (let i = 1; i <= n; i++) {
      out.push(
        makePlayer(i, {
          name: `Castaway_${String(i).padStart(6, '0')}`.slice(0, 16),
          pos: { x: r(i, 1) + 0.123, y: Math.abs(r(i, 2)) / 20 + 0.456, z: r(i, 3) - 0.789 },
          velY: -3.217, yaw: 2.345, pitch: -0.321, hp: 87.654, vestTier: 3, helmetTier: 2,
          weapon: i % 2 === 0 ? 'sniper' : 'grenade', stance: 'prone', stanceFrom: 'stand', stanceProgress: 0.537,
          anim: {
            moving: true, sprinting: false, airborne: false, dropping: false, inWater: false, firing: true,
            reloading: false, healing: false, ads: true, cooking: i % 2 === 1,
          },
          isBot: i > 2, kills: 12, weaponLevel: i % 2 === 0 ? 3 : null, sight: i % 2 === 0 ? 'scope_8x' : 'none',
        }),
      );
    }
    return out;
  }

  function worstCase(n: number, grenades: number, rockets: number, smokes: number, panes: number): WorldSnapshot {
    return quantizeDeep(
      makeSnapshot(36000, players(n), {
        serverTime: 1_200_000.333,
        loot: [],
        match: makeMatch({
          matchId: 41, phaseEndsAt: null, aliveCount: n, totalPlayers: n, mapId: 'island01', aboardCount: 0,
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
        grenades: Array.from({ length: grenades }, (_, k) =>
          makeGrenade(1000 + k, {
            ownerId: k + 1, pos: { x: r(k, 4) + 0.111, y: 3.333, z: r(k, 5) - 0.222 }, vel: { x: -12.345, y: 7.891, z: 4.567 },
            explodesAt: 1_203_456.789, inWater: k % 3 === 0, kind: k % 4 === 0 ? 'smoke' : 'grenade',
          }),
        ),
        rockets: Array.from({ length: rockets }, (_, k) =>
          makeRocket(2000 + k, {
            ownerId: k + 1, level: 4, pos: { x: r(k, 6) + 0.321, y: 4.567, z: r(k, 7) - 0.654 },
            vel: { x: 43.211, y: -2.345, z: -51.987 }, firedAt: 1_199_876.543,
          }),
        ),
        smokes: Array.from({ length: smokes }, (_, k) =>
          makeSmoke(3000 + k, { ownerId: k + 1, pos: { x: r(k, 8) + 0.987, y: 1.234, z: r(k, 9) - 0.456 }, deployedAt: 1_190_123.333, fadeAt: 1_207_123.333 }),
        ),
        brokenPanes: Array.from({ length: panes }, (_, k) => k * 7 + 3),
        local: makeLocal(1, {
          lastProcessedInputSeq: 123456,
          movement: {
            pos: { x: 123.456, y: 4.567, z: -98.765 }, vel: { x: 1.234, y: -0.567, z: 2.345 }, grounded: true,
            dropping: false, stance: 'prone', stanceFrom: 'stand', stanceMs: 321.5, adsMs: 0, ...{ dropPhase: null, dropMs: 0 },
          },
          slots: [{ weapon: 'sniper', mag: 5, level: 4, scope: 'scope_8x' }, { weapon: 'lmg', mag: 100, level: 3, scope: 'scope_2x' }],
          activeSlot: 3,
          ammo: { ammo_light: 120, ammo_heavy: 240, ammo_shell: 32, ammo_sniper: 20, ...{ ammo_rocket: 3 } },
          heals: { bandage: 5, medkit: 2 },
          vest: { tier: 3, durability: 81.234 },
          helmet: { tier: 2, durability: 37.891 },
          grenades: 3,
          cookExplodesAt: 1_201_234.567,
          throwRecoveryMs: 0,
          melee: { weapon: 'machete', level: 4 },
          smokes: 2,
          selectedThrowable: 'smoke',
          spareScope: 'scope_red_dot',
          scopeSwapRemainingMs: 123.456,
        }),
      }),
    );
  }
  const fullBytes = (s: WorldSnapshot, rows = true) => {
    const { loot: _l, ...noLoot } = s;
    return encodeQuantized({ t: 'snapshot', snap: { ...noLoot } }, { rows }).length;
  };
  const log = (label: string, bytes: number, objects?: number) => {
    if (process.env.SNAP_SIZES) console.info(`${label}: ${bytes} B${objects !== undefined ? ` (objects ${objects} B)` : ''}`);
  };

  it('24 players, 16 grenades, 16 rockets, 12 clouds, 12 broken panes (worst case): full format without loot < 8,192 B', () => {
    const s = worstCase(24, 16, 16, 12, 12);
    const bytes = fullBytes(s);
    log('24p worst case full', bytes, fullBytes(s, false));
    expect(bytes).toBeLessThan(8192);
    const m = decode(encodeQuantized({ t: 'snapshot', snap: { ...s } }));
    expect(m?.snap).toEqual(s); // and it decodes exactly
  });

  it('16 players, 10 grenades, M2c fields (the M2b worst case): < 6,500 B', () => {
    const s = worstCase(16, 10, 0, 0, 0);
    const bytes = fullBytes(s);
    log('16p M2b worst case full', bytes, fullBytes(s, false));
    expect(bytes).toBeLessThan(6500);
  });

  /** Next tick of `a`: players changed by `change`, every grenade moved (grenades ride whole in every snapshot). */
  function nextTick(a: WorldSnapshot, base: WorldSnapshot, change: (p: PlayerState, i: number) => Partial<PlayerState>): WorldSnapshot {
    return quantizeDeep({
      ...base,
      tick: a.tick + 1,
      serverTime: a.serverTime + 33.333,
      players: base.players.map((p, i) => ({ ...p, ...change(p, i) })),
      grenades: base.grenades.map((g) => ({
        ...g, pos: { x: g.pos.x + 0.411, y: g.pos.y + 0.263, z: g.pos.z - 0.152 }, vel: { ...g.vel, y: g.vel.y - 0.327 },
      })),
    });
  }
  function deltaBytes(a: WorldSnapshot, b: WorldSnapshot, label: string): { bytes: number; wire: WireSnapshot } {
    const enc = new SnapshotDeltaEncoder(true);
    enc.encode(a);
    const wire = enc.encode(b);
    const bytes = encodeQuantized({ t: 'snapshot', snap: wire }).length;
    log(label, bytes, encodeQuantized({ t: 'snapshot', snap: wire }, { rows: false }).length);
    // The decoder rebuilds b exactly from the same pair.
    const enc2 = new SnapshotDeltaEncoder(true);
    const dec = new SnapshotDeltaDecoder();
    roundTrip(dec, enc2.encode(a));
    expect(roundTrip(dec, enc2.encode(b))).toEqual(b);
    return { bytes, wire };
  }
  const moving = (p: PlayerState): Partial<PlayerState> => ({
    pos: { x: p.pos.x + 0.051, y: p.pos.y, z: p.pos.z - 0.047 },
    stanceProgress: 0.621,
  });

  it('worst-case delta (the M2a method at 24 players): everyone moving mid-transition, 16 grenades in flight, 16 rockets, 12 clouds and 12 panes carried: < 4,096 B', () => {
    const a = worstCase(24, 16, 16, 12, 12);
    const b = nextTick(a, a, moving);
    const { bytes, wire } = deltaBytes(a, b, '24p worst delta (M2a method)');
    expect([wire.rockets, wire.smokes, wire.brokenPanes, wire.local]).toEqual([undefined, undefined, undefined, undefined]);
    expect(bytes).toBeLessThan(4096);
  });

  it('the tick a 16th rocket is fired sends only the new record (rocketsDelta, REVIEW-M2c SF4): < 4,096 B', () => {
    const a = worstCase(24, 16, 15, 12, 12);
    const { bytes, wire } = deltaBytes(a, nextTick(a, worstCase(24, 16, 16, 12, 12), moving), '24p delta, rocket list changed');
    expect(wire.rockets).toBeUndefined();
    expect(wire.rocketsDelta).toEqual({ add: [expect.objectContaining({ id: 2015 })], remove: [] });
    expect(wire.smokes).toBeUndefined();
    expect(bytes).toBeLessThan(4096);
  });

  it('measured, not budgeted: everyone also aiming and falling, and the extreme "every field changes" tick', () => {
    const a = worstCase(24, 16, 16, 12, 12);
    const aiming = nextTick(a, a, (p) => ({ ...moving(p), pos: { ...p.pos, x: p.pos.x + 0.05, y: p.pos.y + 0.012, z: p.pos.z - 0.04 }, velY: -4.321, yaw: 2.512, pitch: -0.287 }));
    const all = nextTick(a, a, (p, i) => ({
      ...moving(p), velY: -4.321, yaw: 2.512, pitch: -0.287, hp: 71.234, anim: { ...p.anim, firing: false, sprinting: true },
      stance: 'crouch', kills: 13, weapon: i % 2 === 0 ? 'sniper' : 'grenade', weaponLevel: i % 2 === 0 ? 3 : null,
      sight: i % 2 === 0 ? 'scope_8x' : 'none',
    }));
    // Bounds that catch a regression (e.g. patches or grenades losing their compact form); see NETCODE.md "Rows".
    expect(deltaBytes(a, aiming, '24p delta, all moving + aiming').bytes).toBeLessThan(6144);
    expect(deltaBytes(a, all, '24p delta, every field changes').bytes).toBeLessThan(8192);
  });

  /**
   * REVIEW-M2c SF4: match.maxPlayers is 16, and at 16 the realistic deltas fit the 4 KB budget. Raising maxPlayers
   * above 16 needs more compaction first (NETCODE.md "Raising maxPlayers").
   */
  const aimingChange = (p: PlayerState): Partial<PlayerState> => ({
    ...moving(p), pos: { x: p.pos.x + 0.05, y: p.pos.y + 0.012, z: p.pos.z - 0.04 }, velY: -4.321, yaw: 2.512, pitch: -0.287,
  });
  it('16 players (maxPlayers), everyone moving and aiming, 16 grenades in flight, lists carried: < 4,096 B', () => {
    const a = worstCase(16, 16, 16, 12, 12);
    const { bytes, wire } = deltaBytes(a, nextTick(a, a, aimingChange), '16p delta, all moving + aiming');
    expect(wire.rockets).toBeUndefined();
    expect(bytes).toBeLessThan(4096);
  });

  it('16 players moving and aiming on the tick a 16th rocket fires: < 4,096 B', () => {
    const a = worstCase(16, 16, 15, 12, 12);
    const { bytes, wire } = deltaBytes(a, nextTick(a, worstCase(16, 16, 16, 12, 12), aimingChange), '16p delta, aiming + rocket list changed');
    expect(wire.rocketsDelta?.add).toHaveLength(1);
    expect(bytes).toBeLessThan(4096);
  });

  it('record deltas: a remove of an unknown id, or a delta in a full snapshot, is refused', () => {
    const enc = new SnapshotDeltaEncoder(true);
    const dec = new SnapshotDeltaDecoder();
    roundTrip(dec, enc.encode(quantizeDeep(makeSnapshot(1, [makePlayer(1)], { rockets: [makeRocket(5)] }))));
    const bad = { ...makeSnapshot(2, [makePlayer(1)]), base: 1, rocketsDelta: { add: [], remove: [99] } } as Record<string, unknown>;
    delete bad.rockets;
    const m = decode(encodeQuantized({ t: 'snapshot', snap: bad as never }));
    expect(m && dec.apply(m.snap).ok).toBe(false);
    const full = { ...makeSnapshot(2, [makePlayer(1)]), rocketsDelta: { add: [], remove: [] } };
    expect(decodeServerMessage(encode({ t: 'snapshot', snap: full as never }))).toBeNull();
    const both = { ...makeSnapshot(2, [makePlayer(1)]), base: 1, rocketsDelta: { add: [], remove: [] } };
    expect(decodeServerMessage(encode({ t: 'snapshot', snap: both as never }))).toBeNull();
  });
});
