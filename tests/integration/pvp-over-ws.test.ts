/**
 * Cross-module integration over real sockets (owner: qa-tester): real ws server (server/app.ts) + real World +
 * two protocol clients (server/testClient.ts). No bots.
 *
 * M2b: clients say `hello` and meet in a room (A creates a private no-bot room on island01, B joins by code, A starts).
 * `worldDrop: false` keeps the M1 spawn drop (dropHeight 2), so the carrier drop does not slow the fight down; the
 * carrier drop is covered by tests/e2e/m2b.spec.ts and the sim tests.
 *
 * Scenario: A and B drop, A walks to the nearest gun and presses interact, B walks up to A, A aims at B's chest and
 * fires until B dies. Checks pickup, hitscan damage, kill credit, the match ending with A as winner, and the
 * standings both clients receive. A second suite covers a cheating client (speed hack, fire-rate hack, garbage).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../server/app';
import { loadBalance } from '../../server/config';
import { SILENT_LOGGER } from '../../server/common';
import { TestClient } from '../../server/testClient';
import { WS_PATH } from '../../src/shared/constants';
import type { EventsMessage, SnapshotMessage } from '../../src/shared/protocol/messages';
import { createWorld } from '../../src/shared/sim/World';
import type { PlayerInput, PlayerState, SimEvent, Vec3 } from '../../src/shared/types';

const GUNS = new Set(['pistol', 'smg', 'shotgun', 'rifle']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const d2 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
const yawTo = (a: Vec3, b: Vec3): number => Math.atan2(-(b.x - a.x), -(b.z - a.z));

function events(c: TestClient): SimEvent[] {
  return c.messages.filter((m): m is EventsMessage => m.t === 'events').flatMap((m) => m.events);
}

/** Drives one client at 30 Hz with whatever `next()` returns (held fields), like the browser client does. */
class Driver {
  held: Partial<PlayerInput> = {};
  private timer: NodeJS.Timeout;
  constructor(readonly c: TestClient) {
    this.timer = setInterval(() => {
      this.c.sendInput(this.held);
      // Edge fields are one-shot.
      this.held = { ...this.held, jump: false, interact: false, reload: false, useHeal: false, selectSlot: -1 };
    }, 1000 / 30);
  }
  stop(): void {
    clearInterval(this.timer);
  }
}

function me(c: TestClient): PlayerState {
  const id = c.welcome!.playerId;
  const p = c.latest?.players.find((x) => x.id === id);
  if (!p) throw new Error('not in snapshot');
  return p;
}

async function until(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(30);
  }
}

/** Walk toward `target()` until within `stopAt` m; hops when stuck on a prop. */
async function walkTo(drv: Driver, target: () => Vec3, stopAt: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  let lastPos = me(drv.c).pos;
  let lastProgressAt = Date.now();
  let side = 1;
  while (Date.now() < end) {
    const p = me(drv.c);
    const t = target();
    if (d2(p.pos, t) <= stopAt) {
      drv.held = { ...drv.held, moveForward: 0, moveRight: 0, sprint: false };
      return true;
    }
    const stuck = Date.now() - lastProgressAt > 700;
    drv.held = { ...drv.held, yaw: yawTo(p.pos, t), moveForward: 1, moveRight: stuck ? side : 0, jump: stuck, sprint: true };
    if (d2(p.pos, lastPos) > 0.5) {
      lastPos = p.pos;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > 1500) {
      side = -side;
      lastProgressAt = Date.now();
    }
    await sleep(50);
  }
  drv.held = { ...drv.held, moveForward: 0, moveRight: 0 };
  return false;
}

/** M2b handshake: A says hello and creates a private, bot-free island room; B says hello and joins by code; A starts. */
async function pair(server: RunningServer, nameA: string, nameB: string): Promise<{ a: TestClient; b: TestClient }> {
  const url = `ws://127.0.0.1:${server.port}${WS_PATH}`;
  const a = new TestClient(url);
  const b = new TestClient(url);
  await Promise.all([a.opened(), b.opened()]);
  await a.helloAndWait(nameA);
  await b.helloAndWait(nameB);
  const room = await a.createAndWait({ visibility: 'private', fillBots: false, mapMode: 'island01' });
  const joined = await b.joinCodeAndWait(room.code);
  expect(joined.id).toBe(room.id);
  const rid = a.startMatch();
  // Success has no direct answer (the room goes to countdown); a reject for this rid fails fast.
  await until(() => a.room?.phase === 'countdown' || a.messages.some((m) => m.t === 'reject' && m.rid === rid), 5000, 'countdown');
  const rej = a.messages.find((m) => m.t === 'reject' && m.rid === rid);
  if (rej) throw new Error(`startMatch rejected: ${JSON.stringify(rej)}`);
  return { a, b };
}

describe('PvP over real sockets: A picks up a gun and kills B', () => {
  let server: RunningServer;
  let a: TestClient;
  let b: TestClient;
  let da: Driver;
  let db: Driver;

  beforeAll(async () => {
    const balance = loadBalance(
      JSON.stringify({
        match: { countdownSeconds: 0.5, minHumansToStart: 2, targetPlayers: 2, resultsSeconds: 2, dropHeight: 2 },
        loot: { spawnChance: 1 },
      }),
    );
    server = await startServer({ createWorld, balance, port: 0, host: '127.0.0.1', log: SILENT_LOGGER, seed: 20261118, worldDrop: false });
    ({ a, b } = await pair(server, 'Shooter', 'Target'));
    await until(() => !!a.welcome && !!b.welcome, 5000, 'welcome');
    da = new Driver(a);
    db = new Driver(b);
  });

  afterAll(async () => {
    da?.stop();
    db?.stop();
    a?.close();
    b?.close();
    await server?.close();
  });

  it('runs the whole fight and ends the match with the shooter as winner', async () => {
    await until(() => a.latest?.match.phase === 'playing' && b.latest?.match.phase === 'playing', 5000, 'playing');
    expect(a.latest!.players.map((p) => p.name).sort()).toEqual(['Shooter', 'Target']);
    await until(() => !me(a).anim.dropping && !me(b).anim.dropping, 8000, 'landed');

    // 1. A walks to the nearest gun and presses interact.
    const start = me(a).pos;
    const guns = a.latest!.loot.filter((l) => GUNS.has(l.item)).sort((x, y) => d2(start, x.pos) - d2(start, y.pos));
    expect(guns.length).toBeGreaterThan(0);
    let gotGun: string | null = null;
    for (const gun of guns.slice(0, 3)) {
      const reached = await walkTo(da, () => gun.pos, 1.0, 15_000);
      if (!reached) continue;
      da.held = { ...da.held, interact: true };
      await sleep(400);
      const pickup = events(a).find((e) => e.type === 'pickup' && e.playerId === a.welcome!.playerId && e.lootId === gun.id);
      if (pickup) {
        gotGun = gun.item;
        break;
      }
    }
    expect(gotGun, 'A picked up a gun').not.toBeNull();
    await until(() => me(a).weapon === gotGun, 2000, 'gun in hand');
    const local = a.latest!.local!;
    expect(local.slots[0]?.weapon).toBe(gotGun);
    expect(local.slots[0]!.mag).toBeGreaterThan(0);

    // 2. A and B close the distance (spawns can be 150+ m apart on the beach ring).
    const [bReached] = await Promise.all([walkTo(db, () => me(a).pos, 4, 45_000), walkTo(da, () => me(b).pos, 5, 45_000)]);
    expect(bReached, `B reaches A (gap ${d2(me(a).pos, me(b).pos).toFixed(1)} m)`).toBe(true);
    da.held = { ...da.held, moveForward: 0, moveRight: 0, sprint: false };
    await sleep(300);

    // 3. A aims at B's chest and fires (toggling fire so semi-autos fire too) until B dies.
    const bId = b.welcome!.playerId;
    const aId = a.welcome!.playerId;
    const hp0 = me(b).hp;
    const end = Date.now() + 15_000;
    let fire = false;
    while (Date.now() < end && !events(a).some((e) => e.type === 'kill' && e.victimId === bId)) {
      const pa = me(a);
      const pb = me(b);
      const dist = d2(pa.pos, pb.pos);
      const dy = pb.pos.y + 0.65 - (pa.pos.y + 1.05);
      fire = !fire;
      da.held = { ...da.held, yaw: yawTo(pa.pos, pb.pos), pitch: Math.atan2(dy, dist), fire, reload: me(a).weapon === gotGun && a.latest!.local!.slots[0]!.mag === 0 };
      await sleep(1000 / 30);
    }
    da.held = { ...da.held, fire: false };

    const evA = events(a);
    const shots = evA.filter((e) => e.type === 'shot' && e.shooterId === aId);
    const hits = evA.filter((e) => e.type === 'damage' && e.attackerId === aId && e.victimId === bId);
    const kill = evA.find((e) => e.type === 'kill' && e.victimId === bId);
    expect(shots.length).toBeGreaterThan(0);
    expect(hits.length, `hits ${hits.length} / shots ${shots.length}`).toBeGreaterThan(0);
    expect(hp0).toBe(100);
    expect(kill, 'B was killed').toBeDefined();
    expect(kill!.type === 'kill' && kill!.killerId).toBe(aId);
    // B saw the same kill (events are broadcast).
    await until(() => events(b).some((e) => e.type === 'kill' && e.victimId === bId), 2000, 'B sees own death');

    // 4. Match ends: A wins with 1 kill; both clients receive the same standings.
    await until(() => events(a).some((e) => e.type === 'matchEnded') && events(b).some((e) => e.type === 'matchEnded'), 5000, 'matchEnded');
    const endA = events(a).find((e) => e.type === 'matchEnded');
    const endB = events(b).find((e) => e.type === 'matchEnded');
    expect(endA).toEqual(endB);
    if (endA?.type !== 'matchEnded') throw new Error('unreachable');
    expect(endA.winnerId).toBe(aId);
    const sa = endA.standings.find((s) => s.id === aId)!;
    const sb = endA.standings.find((s) => s.id === bId)!;
    expect(sa.placement).toBe(1);
    expect(sa.kills).toBe(1);
    expect(sb.placement).toBe(2);
    // The results snapshot can arrive one tick after the matchEnded event.
    await until(() => a.latest?.match.phase === 'results', 2000, 'results phase');

    // 5. M2b: after resultsSeconds both return to the same waiting room (rooms.md AT8/AT9); the host starts again.
    const roomId = a.room!.id;
    await until(() => a.room?.phase === 'waiting' && b.room?.phase === 'waiting' && a.room.matchId === null, 8000, 'back to waiting');
    expect(b.room!.id).toBe(roomId);
    expect(a.room!.members.every((m) => !m.ready)).toBe(true);
    const matchId = a.latest!.match.matchId;
    a.startMatch();
    await until(() => (a.latest?.match.matchId ?? 0) !== matchId && a.latest?.match.phase === 'playing', 10_000, 'next match');
    const snap = (await a.waitFor((m) => m.t === 'snapshot', 2000, false)) as SnapshotMessage;
    expect(snap.snap.players.filter((p) => p.alive)).toHaveLength(2);
  }, 120_000);
});

describe('cheating client: the server clamps and drops what a hacked client sends', () => {
  let server: RunningServer;
  let cheat: TestClient;
  let honest: TestClient;

  beforeAll(async () => {
    const balance = loadBalance(
      JSON.stringify({ match: { countdownSeconds: 0.5, minHumansToStart: 2, targetPlayers: 2, dropHeight: 2 } }),
    );
    server = await startServer({ createWorld, balance, port: 0, host: '127.0.0.1', log: SILENT_LOGGER, seed: 99, worldDrop: false });
    ({ a: cheat, b: honest } = await pair(server, 'Cheater', 'Honest'));
    await until(() => cheat.latest?.match.phase === 'playing', 6000, 'playing');
    // Keep both sockets "alive" in the World with idle inputs until landed.
    const idle = setInterval(() => {
      cheat.sendInput();
      honest.sendInput();
    }, 1000 / 30);
    await until(() => !!cheat.latest && !me(cheat).anim.dropping, 8000, 'landed');
    clearInterval(idle);
  }, 20_000);

  afterAll(async () => {
    cheat?.close();
    honest?.close();
    await server?.close();
  });

  it('speed hack: 200 inputs/s with moveForward 1000 and dt 5 moves no faster than sprint', async () => {
    const p0 = me(cheat).pos;
    const t0 = Date.now();
    const timer = setInterval(() => cheat.sendInput({ moveForward: 1000, moveRight: 1000, sprint: true, dt: 5 }), 5);
    await sleep(2000);
    clearInterval(timer);
    await sleep(200);
    const secs = (Date.now() - t0) / 1000;
    const moved = d2(p0, me(cheat).pos);
    // sprintSpeed 7.2 m/s; allow 15% for snapshot timing.
    expect(moved / secs, `moved ${moved.toFixed(1)} m in ${secs.toFixed(2)} s`).toBeLessThanOrEqual(7.2 * 1.15);
    expect(cheat.closed).toBeNull();
  }, 15_000); // 2.2 s of wall-clock sleeps: the 5 s default flakes under CPU load (M2a D1 flake hunt)

  it('fire-rate hack: fists fire no faster than fireIntervalMs even when fire toggles every input', async () => {
    const id = cheat.welcome!.playerId;
    const before = events(cheat).filter((e) => e.type === 'shot' && e.shooterId === id).length;
    let fire = false;
    const timer = setInterval(() => {
      fire = !fire;
      cheat.sendInput({ fire });
    }, 1000 / 60);
    await sleep(3000);
    clearInterval(timer);
    await sleep(200);
    const shots = events(cheat).filter((e) => e.type === 'shot' && e.shooterId === id).length - before;
    // fists fireIntervalMs 450 => at most ceil(3000 / 450) + 1 = 8 in 3 s.
    expect(shots).toBeLessThanOrEqual(8);
  }, 15_000); // 3.2 s of wall-clock sleeps against a 5 s default timeout

  it('garbage in valid frames (null numbers, huge seq jumps, bad slot) never crashes the room', async () => {
    // M2b /healthz: manager stats with one entry per room (this suite has exactly one room).
    type Health = { ok: boolean; perRoom: { tick: number }[] };
    const before = (await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json()) as Health;
    const raw = [
      '{"t":"input","input":{"seq":999999,"dt":null,"moveForward":"x","moveRight":0,"yaw":0,"pitch":0,"sprint":0,"fire":0,"jump":0,"reload":0,"interact":0,"useHeal":0,"selectSlot":9}}',
      '{"t":"input","input":{"seq":1e400,"dt":0.03}}',
      '{"t":"input","input":{"__proto__":{"polluted":true},"seq":1000000,"dt":0.03,"moveForward":0,"moveRight":0,"yaw":1e308,"pitch":-1e308,"sprint":false,"fire":false,"jump":false,"reload":false,"interact":false,"useHeal":false,"selectSlot":-1}}',
      '{"t":"join","name":"again","protocolVersion":1}',
      '{"t":"hello","name":"again","protocolVersion":3}',
      '{"t":"startMatch","rid":7}',
      '{"t":"kick","memberId":-1,"rid":8}',
      '{"t":"vote","choice":"moon"}',
    ];
    for (const r of raw) cheat.send(r);
    await sleep(500);
    const after = (await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json()) as Health;
    expect(after.ok).toBe(true);
    expect(after.perRoom).toHaveLength(1);
    expect(after.perRoom[0]!.tick).toBeGreaterThan(before.perRoom[0]!.tick);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The honest client is still being served snapshots.
    const s = await honest.waitFor((m) => m.t === 'snapshot', 2000, false);
    expect(s.t).toBe('snapshot');
    // The extreme yaw/pitch input (if accepted) must not produce NaN positions.
    const p = me(cheat);
    expect(Number.isFinite(p.pos.x) && Number.isFinite(p.yaw) && Number.isFinite(p.pitch)).toBe(true);
  }, 15_000);
});
