import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../types';
import {
  MAX_CLIENT_FRAME_CHARS,
  decodeClientMessage,
  decodeServerMessage,
  encode,
  encodeQuantized,
  isLoot,
  isSimEvent,
  privateEventRecipient,
  quantizeDeep,
  type ClientMessage,
  type ServerMessage,
} from './messages';
import { makeInput, makeLocal, makePlayer, makeSnapshot } from './testing';

const v3 = { x: 1, y: 2, z: 3 };

describe('client messages', () => {
  const samples: ClientMessage[] = [
    { t: 'join', name: 'Coco', protocolVersion: 1 },
    { t: 'input', input: makeInput({ seq: 7, moveForward: 1, yaw: 2.5, fire: true, selectSlot: 2 }) },
    { t: 'input', input: makeInput({ seq: 8, ads: true, stanceToggle: 'prone', selectSlot: 3 }) },
    { t: 'input', input: makeInput({ seq: 9, stanceToggle: 'crouch' }) },
    { t: 'ping', clientTime: 1234.5 },
  ];
  it.each(samples)('round-trips $t', (msg) => {
    expect(decodeClientMessage(encode(msg))).toEqual(msg);
  });

  it('accepts already-parsed objects', () => {
    expect(decodeClientMessage({ t: 'ping', clientTime: 1 })).toEqual({ t: 'ping', clientTime: 1 });
  });

  it('strips unknown fields', () => {
    const raw = JSON.stringify({ t: 'input', extra: 1, input: { ...makeInput(), teleport: { x: 9 } } });
    const msg = decodeClientMessage(raw);
    expect(msg).toEqual({ t: 'input', input: makeInput() });
  });

  const bad: [string, unknown][] = [
    ['non-JSON', '{nope'],
    ['empty string', ''],
    ['null', 'null'],
    ['array', '[1,2]'],
    ['number', 42],
    ['unknown t', JSON.stringify({ t: 'teleport' })],
    ['missing t', JSON.stringify({ name: 'x' })],
    ['join name not string', JSON.stringify({ t: 'join', name: 5, protocolVersion: 1 })],
    ['join huge name', JSON.stringify({ t: 'join', name: 'x'.repeat(65), protocolVersion: 1 })],
    ['join float version', JSON.stringify({ t: 'join', name: 'a', protocolVersion: 1.5 })],
    ['ping string time', JSON.stringify({ t: 'ping', clientTime: '1' })],
    ['ping NaN (object)', { t: 'ping', clientTime: NaN }],
    ['input missing', JSON.stringify({ t: 'input' })],
    ['input seq 0', encode({ t: 'input', input: makeInput({ seq: 0 }) })],
    ['input seq float', encode({ t: 'input', input: makeInput({ seq: 1.5 }) })],
    ['input seq negative', encode({ t: 'input', input: makeInput({ seq: -3 }) })],
    ['input NaN yaw', { t: 'input', input: { ...makeInput(), yaw: NaN } }],
    ['input Infinity move', { t: 'input', input: { ...makeInput(), moveForward: Infinity } }],
    ['input string move', JSON.stringify({ t: 'input', input: { ...makeInput(), moveRight: '1' } })],
    ['input missing bool', JSON.stringify({ t: 'input', input: { ...makeInput(), fire: undefined } })],
    ['input bool as number', JSON.stringify({ t: 'input', input: { ...makeInput(), jump: 1 } })],
    ['input selectSlot 4', JSON.stringify({ t: 'input', input: { ...makeInput(), selectSlot: 4 } })],
    ['input selectSlot -2', JSON.stringify({ t: 'input', input: { ...makeInput(), selectSlot: -2 } })],
    ['input selectSlot "1"', JSON.stringify({ t: 'input', input: { ...makeInput(), selectSlot: '1' } })],
    ['oversize frame', JSON.stringify({ t: 'ping', clientTime: 1, pad: 'x'.repeat(MAX_CLIENT_FRAME_CHARS) })],
  ];
  it.each(bad)('rejects %s without throwing', (_label, raw) => {
    expect(() => decodeClientMessage(raw)).not.toThrow();
    expect(decodeClientMessage(raw)).toBeNull();
  });

  it('is not fooled by __proto__ keys', () => {
    const raw = '{"t":"ping","clientTime":1,"__proto__":{"polluted":true}}';
    expect(decodeClientMessage(raw)).toEqual({ t: 'ping', clientTime: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not throw on hostile getters', () => {
    const hostile = {
      t: 'ping',
      get clientTime(): number {
        throw new Error('boom');
      },
    };
    expect(decodeClientMessage(hostile)).toBeNull();
  });
});

describe('server messages', () => {
  const events: SimEvent[] = [
    { type: 'spawn', playerId: 1, pos: v3 },
    {
      type: 'shot',
      shooterId: 1,
      weapon: 'shotgun',
      origin: v3,
      impacts: [{ point: v3, surface: 'player', playerId: 2, headshot: true }],
    },
    {
      type: 'damage', victimId: 2, attackerId: 1, amount: 20, headshot: false, cause: 'weapon', sourcePos: v3,
      hpAfter: 80, vest: null, helmet: null,
    },
    { type: 'kill', victimId: 2, killerId: null, weapon: null, cause: 'zone', placement: 3 },
    { type: 'pickup', playerId: 1, lootId: 4, item: 'ammo_light', qty: 30, pos: v3 },
    { type: 'reloadStart', playerId: 1, weapon: 'smg', durationMs: 2000 },
    { type: 'reloadEnd', playerId: 1, weapon: 'smg', completed: true },
    { type: 'healStart', playerId: 1, item: 'bandage', durationMs: 2500 },
    { type: 'healEnd', playerId: 1, item: 'medkit', completed: false, hpAfter: 40 },
    { type: 'weaponSwitch', playerId: 1, weapon: 'fists', slot: 2 },
    { type: 'matchEnded', winnerId: 1, standings: [{ id: 1, name: 'A', isBot: false, kills: 2, placement: 1 }] },
  ];

  const snapWithLocal = makeSnapshot(10, [makePlayer(1), makePlayer(2, { isBot: true })], {
    local: makeLocal(1, { lastProcessedInputSeq: 42 }),
    zone: {
      phaseIndex: 0, phaseCount: 6, center: { x: 0, z: 0 }, radius: 125, targetCenter: { x: 3, z: 4 }, targetRadius: 77,
      phaseEndsAt: 60000, shrinking: false, dps: 1,
    },
  });
  const { loot: _loot, ...snapNoLoot } = snapWithLocal;

  const samples: ServerMessage[] = [
    { t: 'welcome', welcome: { playerId: 3, mapId: 'island01', serverTime: 100, matchId: 1, roomId: 'r1' } },
    { t: 'snapshot', snap: snapWithLocal },
    { t: 'snapshot', snap: snapNoLoot },
    { t: 'events', tick: 5, serverTime: 166.6, events },
    { t: 'pong', clientTime: 1, serverTime: 2 },
    { t: 'error', code: 'full' },
    { t: 'error', code: 'bad_version', message: 'server protocol 1' },
  ];
  it.each(samples)('round-trips $t', (msg) => {
    expect(decodeServerMessage(encode(msg))).toEqual(msg);
  });

  it('keeps loot omitted when absent', () => {
    const msg = decodeServerMessage(encode({ t: 'snapshot', snap: snapNoLoot }));
    expect(msg?.t === 'snapshot' && msg.snap.loot).toBeUndefined();
  });

  it('filters unknown event types instead of failing the batch', () => {
    const raw = JSON.stringify({ t: 'events', tick: 1, serverTime: 1, events: [events[0], { type: 'future' }] });
    const msg = decodeServerMessage(raw);
    expect(msg).toEqual({ t: 'events', tick: 1, serverTime: 1, events: [events[0]] });
  });

  const bad: [string, unknown][] = [
    ['garbage', 'xx'],
    ['unknown t', JSON.stringify({ t: 'hello' })],
    ['welcome missing map', JSON.stringify({ t: 'welcome', welcome: { playerId: 1, serverTime: 1, matchId: 1 } })],
    ['snapshot bad phase', encode({ t: 'snapshot', snap: makeSnapshot(1, [], { match: { ...snapWithLocal.match, phase: 'x' as never } }) })],
    ['snapshot player bad pos', JSON.stringify({ t: 'snapshot', snap: { ...snapNoLoot, players: [{ ...makePlayer(1), pos: { x: 1 } }] } })],
    ['snapshot local wrong slots', JSON.stringify({ t: 'snapshot', snap: { ...snapNoLoot, local: { ...makeLocal(1), slots: [null] } } })],
    ['error unknown code', JSON.stringify({ t: 'error', code: 'nope' })],
    ['pong missing serverTime', JSON.stringify({ t: 'pong', clientTime: 1 })],
  ];
  it.each(bad)('rejects %s without throwing', (_label, raw) => {
    expect(decodeServerMessage(raw)).toBeNull();
  });
});

describe('encodeQuantized', () => {
  it('rounds non-integers to 3 decimals, leaves integers/booleans/strings alone, still decodes', () => {
    const snap = makeSnapshot(3, [makePlayer(1, { pos: { x: 1.23456789, y: -0.0004, z: 100 }, yaw: Math.PI, name: '0.5' })], {
      serverTime: 100.00049,
    });
    const msg = decodeServerMessage(encodeQuantized({ t: 'snapshot', snap }));
    expect(msg?.t).toBe('snapshot');
    if (msg?.t !== 'snapshot') return;
    const p = msg.snap.players[0]!;
    expect(p.pos).toEqual({ x: 1.235, y: 0, z: 100 }); // JSON has no -0
    expect(p.yaw).toBe(3.142);
    expect(p.name).toBe('0.5');
    expect(msg.snap.serverTime).toBe(100);
    expect(msg.snap.tick).toBe(3);
  });
});

describe('Contract revision 1 fields', () => {
  const damage = {
    type: 'damage', victimId: 2, attackerId: 1, amount: 20, headshot: false, cause: 'weapon', sourcePos: v3,
    hpAfter: 80, vest: null, helmet: null,
  } as const;
  const kill = { type: 'kill', victimId: 2, killerId: 1, weapon: 'rifle', cause: 'weapon', placement: 3 } as const;
  const failed: SimEvent = { type: 'actionFailed', playerId: 1, action: 'heal', reason: 'fullHp' };
  const loot = { id: 1, item: 'medkit', qty: 1, pos: v3 } as const;

  it('accepts the new optional fields when present and when absent', () => {
    for (const ev of [damage, { ...damage, grenadeId: 4, cause: 'explosion' }, kill, { ...kill, headshot: true }]) {
      expect(isSimEvent(ev)).toBe(true);
    }
    for (const l of [loot, { ...loot, tier: 'common' }, { ...loot, tier: 'rare' }, { ...loot, tier: 'epic' }]) {
      expect(isLoot(l)).toBe(true);
    }
  });

  it.each([
    ['grenadeId string', { ...damage, grenadeId: '4' }],
    ['grenadeId null', { ...damage, grenadeId: null }],
    ['grenadeId float', { ...damage, grenadeId: 1.5 }],
    ['kill headshot number', { ...kill, headshot: 1 }],
    ['kill headshot null', { ...kill, headshot: null }],
  ])('rejects a mistyped optional field: %s', (_label, ev) => {
    expect(isSimEvent(ev)).toBe(false);
  });

  it.each([['legendary'], [null], [1], ['']])('rejects loot tier %j', (tier) => {
    expect(isLoot({ ...loot, tier })).toBe(false);
  });

  it('round-trips loot tiers and new event fields through the server encoder', () => {
    const snap = makeSnapshot(4, [makePlayer(1)], { loot: [{ ...loot, tier: 'epic' }, { ...loot, id: 2 }] });
    const msg = decodeServerMessage(encodeQuantized({ t: 'snapshot', snap }));
    expect(msg?.t === 'snapshot' && msg.snap.loot).toEqual([{ ...loot, tier: 'epic' }, { ...loot, id: 2 }]);
    const events: SimEvent[] = [{ ...damage, grenadeId: 10 }, { ...kill, headshot: true }, failed];
    const ev = decodeServerMessage(encodeQuantized({ t: 'events', tick: 9, serverTime: 300, events }));
    expect(ev).toEqual({ t: 'events', tick: 9, serverTime: 300, events });
  });

  it('a snapshot with a bad loot tier is rejected as a whole (shape is all-or-nothing)', () => {
    const raw = JSON.stringify({ t: 'snapshot', snap: makeSnapshot(1, [], { loot: [{ ...loot, tier: 'mythic' as never }] }) });
    expect(decodeServerMessage(raw)).toBeNull();
  });

  it('decodes actionFailed for every action and reason instead of filtering it', () => {
    const actions = ['heal', 'pickup', 'reload', 'fire', 'swap', 'stance'];
    const reasons = ['noHeals', 'fullHp', 'inventoryFull', 'betterArmor', 'noAmmo', 'noGrenades', 'tooDeep', 'noHeadroom'];
    const events = actions.flatMap((action) => reasons.map((reason) => ({ type: 'actionFailed', playerId: 3, action, reason })));
    const msg = decodeServerMessage(JSON.stringify({ t: 'events', tick: 1, serverTime: 1, events }));
    expect(msg?.t === 'events' && msg.events).toHaveLength(events.length);
  });

  it.each([
    ['unknown action', { ...failed, action: 'jump' }],
    ['unknown reason', { ...failed, reason: 'tired' }],
    ['float playerId', { ...failed, playerId: 1.5 }],
    ['missing playerId', { type: 'actionFailed', action: 'heal', reason: 'fullHp' }],
  ])('rejects actionFailed with %s', (_label, ev) => {
    expect(isSimEvent(ev)).toBe(false);
  });

  it('does not resolve event types through the prototype chain', () => {
    for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(isSimEvent({ type })).toBe(false);
  });

  it('reports filtered events through the optional hook, and a throwing hook cannot break decoding', () => {
    const dropped: unknown[] = [];
    const raw = JSON.stringify({ t: 'events', tick: 1, serverTime: 1, events: [failed, { type: 'future' }, { ...damage, amount: 'x' }] });
    const msg = decodeServerMessage(raw, { onDroppedEvent: (e) => dropped.push(e) });
    expect(msg).toEqual({ t: 'events', tick: 1, serverTime: 1, events: [failed] });
    expect(dropped).toHaveLength(2);
    const msg2 = decodeServerMessage(raw, {
      onDroppedEvent: () => {
        throw new Error('hook bug');
      },
    });
    expect(msg2).toEqual(msg);
  });

  it('marks actionFailed as private to its player; everything else is public', () => {
    expect(privateEventRecipient(failed)).toBe(1);
    expect(privateEventRecipient({ type: 'spawn', playerId: 1, pos: v3 })).toBeNull();
    expect(privateEventRecipient({ ...damage })).toBeNull();
  });
});

describe('delta protocol messages', () => {
  it('join caps and resync decode; bad caps are rejected', () => {
    expect(decodeClientMessage(encode({ t: 'join', name: 'A', protocolVersion: 1, caps: ['delta1', 'future'] }))).toEqual({
      t: 'join', name: 'A', protocolVersion: 1, caps: ['delta1', 'future'],
    });
    expect(decodeClientMessage('{"t":"resync","x":1}')).toEqual({ t: 'resync' });
    for (const caps of ['delta1', [1], Array(9).fill('a'), ['x'.repeat(17)]]) {
      expect(decodeClientMessage(JSON.stringify({ t: 'join', name: 'A', protocolVersion: 1, caps }))).toBeNull();
    }
  });

  const base = makeSnapshot(5, [makePlayer(1)]);
  const { loot: _l, ...noLoot } = base;
  it.each([
    ['patch players with base', { ...noLoot, base: 4, players: [{ id: 1 }, { id: 2, hp: 3, pos: v3 }] }, true],
    ['loot delta', { ...noLoot, lootDelta: { from: 1, add: [], remove: [2], qty: [[3, 4]] } }, true],
    ['patch players without base', { ...noLoot, players: [{ id: 1, hp: 3 }] }, false],
    ['patch with a bad field', { ...noLoot, base: 4, players: [{ id: 1, hp: 'x' }] }, false],
    ['patch without id', { ...noLoot, base: 4, players: [{ hp: 3 }] }, false],
    ['float base', { ...noLoot, base: 4.5, players: [] }, false],
    ['loot and lootDelta together', { ...base, lootDelta: { from: 1, add: [], remove: [], qty: [] } }, false],
    ['bad qty pair', { ...noLoot, lootDelta: { from: 1, add: [], remove: [], qty: [[3]] } }, false],
    ['bad remove id', { ...noLoot, lootDelta: { from: 1, add: [], remove: ['a'], qty: [] } }, false],
  ])('wire snapshot: %s', (_label, snap, ok) => {
    expect(decodeServerMessage(JSON.stringify({ t: 'snapshot', snap })) !== null).toBe(ok);
  });

  it('quantizeDeep matches the wire rounding and turns -0 into 0', () => {
    const v = { a: 1.23456, b: -0, c: [-0.0004, 2], d: 'x', e: null, f: true };
    expect(quantizeDeep(v)).toEqual(JSON.parse(encodeQuantized(v as never)));
    expect(Object.is(quantizeDeep(v).b, 0)).toBe(true);
    expect(Object.is(quantizeDeep(v).c[0], 0)).toBe(true);
  });
});
