import { describe, expect, it } from 'vitest';
import type { LootState, PlayerState, WorldSnapshot } from '../types';
import { SnapshotDeltaDecoder, SnapshotDeltaEncoder, diffLoot, diffPlayer, sameValue } from './delta';
import { decodeServerMessage, encodeQuantized, quantizeDeep, type WireSnapshot } from './messages';
import { makeLocal, makePlayer, makeSnapshot } from './testing';

/** Small deterministic PRNG for the fuzz test. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Through the real wire path: quantized JSON, decoded and shape-checked. */
function overWire(w: WireSnapshot): WireSnapshot {
  const m = decodeServerMessage(encodeQuantized({ t: 'snapshot', snap: w }));
  if (m?.t !== 'snapshot') throw new Error(`wire snapshot rejected: ${JSON.stringify(w).slice(0, 300)}`);
  return m.snap;
}

const loot = (id: number, over: Partial<LootState> = {}): LootState => ({ id, item: 'bandage', qty: 1, pos: { x: id, y: 0, z: 0 }, ...over });

describe('sameValue / diffPlayer / diffLoot', () => {
  it('compares nested plain data', () => {
    expect(sameValue({ a: { x: 1 } }, { a: { x: 1 } })).toBe(true);
    expect(sameValue({ a: { x: 1 } }, { a: { x: 2 } })).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue([1], { 0: 1 })).toBe(false);
  });

  it('a player patch holds only changed fields, nested objects whole', () => {
    const a = makePlayer(3);
    expect(diffPlayer(a, { ...a })).toBeNull();
    const b = { ...a, pos: { ...a.pos, x: 5 }, anim: { ...a.anim, moving: true } };
    expect(diffPlayer(a, b)).toEqual({ id: 3, pos: b.pos, anim: b.anim });
  });

  it('loot: new/replaced entries in add, gone ids in remove, qty-only changes in qty', () => {
    const base = new Map([1, 2, 3, 4].map((id) => [id, loot(id)]));
    const cur = [loot(1), loot(2, { qty: 5 }), loot(4, { tier: 'epic' }), loot(9)];
    expect(diffLoot(7, base, cur)).toEqual({ from: 7, add: [loot(4, { tier: 'epic' }), loot(9)], remove: [3], qty: [[2, 5]] });
  });
});

describe('SnapshotDeltaEncoder / SnapshotDeltaDecoder', () => {
  it('fuzz: 500 random snapshots rebuild exactly (players join/leave/change, loot add/remove/qty/replace)', () => {
    const r = rng(42);
    const enc = new SnapshotDeltaEncoder(true);
    const dec = new SnapshotDeltaDecoder();
    let players: PlayerState[] = [1, 2, 3, 4, 5].map((id) => makePlayer(id));
    let lootList: LootState[] = Array.from({ length: 40 }, (_, i) => loot(i + 1));
    let nextLoot = 41;
    let nextPlayer = 6;
    let lootVersion = 1;
    let fullLoot = 0;
    let deltas = 0;
    for (let tick = 1; tick <= 500; tick++) {
      players = players.map((p) =>
        r() < 0.7
          ? { ...p, pos: { x: p.pos.x + r() - 0.5, y: p.pos.y, z: p.pos.z + r() - 0.5 }, yaw: r() * 6 - 3, hp: r() < 0.1 ? Math.floor(r() * 100) : p.hp }
          : p,
      );
      if (r() < 0.02) players = players.filter((_, i) => i !== Math.floor(r() * players.length));
      if (r() < 0.02) players = [...players, makePlayer(nextPlayer++, { isBot: true })];
      if (r() < 0.2) {
        lootVersion++;
        const op = r();
        if (op < 0.3 && lootList.length > 0) lootList = lootList.filter((_, i) => i !== Math.floor(r() * lootList.length));
        else if (op < 0.6) lootList = [...lootList, loot(nextLoot++, { tier: 'rare', pos: { x: r() * 100, y: 1.23456, z: -0.0001 } })];
        else if (op < 0.85 && lootList.length > 0) {
          const i = Math.floor(r() * lootList.length);
          lootList = lootList.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l));
        } else if (op < 0.95 && lootList.length > 0) {
          const i = Math.floor(r() * lootList.length);
          lootList = lootList.map((l, j) => (j === i ? { ...l, item: 'medkit' } : l));
        } else {
          lootList = Array.from({ length: 30 }, () => loot(nextLoot++)); // new match: everything replaced
        }
      }
      const server: WorldSnapshot = quantizeDeep(
        makeSnapshot(tick, players, { lootVersion, loot: lootList, local: makeLocal(1, { lastProcessedInputSeq: tick }) }),
      );
      const wire = enc.encode(server);
      if (wire.loot && tick > 1) fullLoot++;
      if (wire.lootDelta) deltas++;
      const res = dec.apply(overWire(wire));
      if (!res.ok) throw new Error(`tick ${tick}: ${res.reason}`);
      expect(res.snap).toEqual(server);
    }
    expect(deltas).toBeGreaterThan(50);
    expect(fullLoot).toBeGreaterThan(0); // the "new match" case falls back to a full list
  });

  it('an unchanged player costs only its id; an idle world costs almost nothing', () => {
    const enc = new SnapshotDeltaEncoder(true);
    const players = Array.from({ length: 16 }, (_, i) => makePlayer(i + 1));
    const a = enc.encode(quantizeDeep(makeSnapshot(1, players)));
    const b = enc.encode(quantizeDeep(makeSnapshot(2, players)));
    expect(b.players).toEqual(players.map((p) => ({ id: p.id })));
    expect(b.loot).toBeUndefined();
    expect(JSON.stringify(b).length).toBeLessThan(JSON.stringify(a).length / 4);
  });

  it('rejects a delta against the wrong base, a stale loot version, and unknown ids; then needs a full snapshot', () => {
    const enc = new SnapshotDeltaEncoder(true);
    const s1 = quantizeDeep(makeSnapshot(1, [makePlayer(1)], { lootVersion: 1, loot: [loot(1), loot(2)] }));
    const s2 = quantizeDeep(makeSnapshot(2, [makePlayer(1, { hp: 50 })], { lootVersion: 2, loot: [loot(1)] }));
    const s3 = quantizeDeep(makeSnapshot(3, [makePlayer(1, { hp: 40 })], { lootVersion: 3, loot: [loot(1), loot(5)] }));
    const [w1, w2, w3] = [s1, s2, s3].map((s) => overWire(enc.encode(s)));

    const skipped = new SnapshotDeltaDecoder();
    expect(skipped.apply(w1!).ok).toBe(true);
    expect(skipped.apply(w3!)).toEqual({ ok: false, reason: 'players base 2 != 1' });
    expect(skipped.needsFull).toBe(true);
    expect(skipped.apply(w2!).ok).toBe(false); // reordered arrival after the reset also fails

    const lootGap = new SnapshotDeltaDecoder();
    lootGap.apply(w1!);
    expect(lootGap.apply({ ...w2!, lootDelta: { ...w2!.lootDelta!, from: 0 } })).toMatchObject({ ok: false });

    const unknown = new SnapshotDeltaDecoder();
    unknown.apply(w1!);
    expect(unknown.apply({ ...w2!, players: [{ id: 7, hp: 3 }] })).toEqual({ ok: false, reason: 'patch for unknown player 7' });

    const omitted = new SnapshotDeltaDecoder();
    omitted.apply(w1!);
    const { lootDelta: _d, ...noLoot } = w2!;
    expect(omitted.apply(noLoot)).toMatchObject({ ok: false }); // version 2 claimed unchanged, but we have 1

    // After the server resets (resync), a full snapshot restores everything.
    enc.reset();
    const full = overWire(enc.encode(s3));
    expect(full.base).toBeUndefined();
    expect(skipped.apply(full)).toEqual({ ok: true, snap: s3 });
  });

  it('non-delta mode keeps the M1 format', () => {
    const enc = new SnapshotDeltaEncoder(false);
    const s1 = makeSnapshot(1, [makePlayer(1)]);
    const w1 = enc.encode(s1);
    const w2 = enc.encode(makeSnapshot(2, [makePlayer(1)]));
    expect(w1).toEqual(s1);
    expect(w2.loot).toBeUndefined();
    expect(w2.base).toBeUndefined();
    expect(w2.players[0]).toEqual(makePlayer(1));
  });
});
