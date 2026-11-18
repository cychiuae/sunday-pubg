import { describe, expect, it } from 'vitest';
import { makePlayer, makeSnapshot } from '../shared/protocol/testing';
import { BUFFER_KEEP_MS, SnapshotBuffer, TELEPORT_DIST, interpolatePlayers } from './SnapshotBuffer';

const at = (tick: number, serverTime: number, x: number, yaw = 0) =>
  makeSnapshot(tick, [makePlayer(1, { pos: { x, y: 0, z: -x }, yaw, velY: x })], { serverTime });

describe('SnapshotBuffer.sample', () => {
  it('returns null when empty', () => {
    expect(new SnapshotBuffer().sample(0)).toBeNull();
  });

  it('lerps position between the bracketing snapshots', () => {
    const b = new SnapshotBuffer();
    b.push(at(1, 1000, 0));
    b.push(at(2, 1050, 2));
    b.push(at(3, 1100, 4));
    const r = b.sample(1075)!;
    expect(r.renderTime).toBe(1075);
    expect(r.players[0]!.pos.x).toBeCloseTo(3);
    expect(r.players[0]!.pos.z).toBeCloseTo(-3);
    expect(r.players[0]!.velY).toBeCloseTo(3);
  });

  it('interpolates yaw along the shortest arc across +-PI', () => {
    const b = new SnapshotBuffer();
    b.push(at(1, 0, 0, Math.PI - 0.1));
    b.push(at(2, 100, 0, -Math.PI + 0.1));
    const yaw = b.sample(50)!.players[0]!.yaw;
    // Halfway along the 0.2 rad arc through PI, not back through 0.
    expect(Math.abs(Math.abs(yaw) - Math.PI)).toBeLessThan(1e-9);
  });

  it('takes discrete fields from the newer snapshot', () => {
    const b = new SnapshotBuffer();
    b.push(makeSnapshot(1, [makePlayer(1, { hp: 100, weapon: 'fists' })], { serverTime: 0 }));
    b.push(makeSnapshot(2, [makePlayer(1, { hp: 60, weapon: 'smg', alive: false })], { serverTime: 100 }));
    const p = b.sample(10)!.players[0]!;
    expect(p.hp).toBe(60);
    expect(p.weapon).toBe('smg');
    expect(p.alive).toBe(false);
  });

  it('clamps before the oldest and after the newest (no extrapolation)', () => {
    const b = new SnapshotBuffer();
    b.push(at(1, 1000, 0));
    b.push(at(2, 1050, 2));
    expect(b.sample(500)!.players[0]!.pos.x).toBe(0);
    expect(b.sample(5000)!.players[0]!.pos.x).toBe(2);
  });

  it('bridges a gap (lost/late snapshots) by lerping across it', () => {
    const b = new SnapshotBuffer();
    b.push(at(1, 1000, 0));
    b.push(at(9, 1400, 4)); // 7 snapshots missing
    expect(b.sample(1100)!.players[0]!.pos.x).toBeCloseTo(1);
  });

  it('snaps instead of sliding when a player teleports', () => {
    const b = new SnapshotBuffer();
    b.push(at(1, 0, 0));
    b.push(at(2, 50, TELEPORT_DIST + 1));
    expect(b.sample(25)!.players[0]!.pos.x).toBe(TELEPORT_DIST + 1);
  });

  it('includes players present in only one snapshot as-is', () => {
    const a = [makePlayer(1, { pos: { x: 0, y: 0, z: 0 } }), makePlayer(2, { pos: { x: 5, y: 0, z: 0 } })];
    const b = [makePlayer(1, { pos: { x: 2, y: 0, z: 0 } }), makePlayer(3, { pos: { x: 9, y: 0, z: 0 } })];
    const out = interpolatePlayers(a, b, 0.5);
    expect(out.map((p) => [p.id, p.pos.x])).toEqual([
      [1, 1],
      [3, 9],
      [2, 5],
    ]);
  });

  it('ignores duplicate and out-of-order snapshots, resets on a server restart', () => {
    const b = new SnapshotBuffer();
    expect(b.push(at(100, 3333, 0))).toBe(true);
    expect(b.push(at(100, 3333, 1))).toBe(false);
    expect(b.push(at(99, 3300, 1))).toBe(false);
    expect(b.push(at(1, 33, 7))).toBe(true); // tick far back = new server
    expect(b.size).toBe(1);
    expect(b.latest()!.tick).toBe(1);
  });

  it('keeps about BUFFER_KEEP_MS of history', () => {
    const b = new SnapshotBuffer();
    for (let i = 0; i < 100; i++) b.push(at(i + 1, i * 50, i));
    const newest = 99 * 50;
    expect(b.size).toBeLessThanOrEqual(BUFFER_KEEP_MS / 50 + 2);
    expect(b.sample(newest - BUFFER_KEEP_MS + 10)!.players[0]!.pos.x).toBeCloseTo((newest - BUFFER_KEEP_MS + 10) / 50);
  });
});
