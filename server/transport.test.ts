/**
 * Real sockets, scripted world: exercises http/ws wiring, lag simulation, compression, heartbeat-free paths
 * and edge validation independently of the sim. server.integration.test.ts covers the real World.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BALANCE } from '../src/shared/balance';
import { WS_PATH } from '../src/shared/constants';
import type { SnapshotMessage } from '../src/shared/protocol/messages';
import { makeLocal, makeMatch, makePlayer, makeSnapshot } from '../src/shared/protocol/testing';
import type { MapData, MatchState, PlayerId, PlayerInput, SimEvent, WorldSnapshot } from '../src/shared/types';
import { startServer, type RunningServer } from './app';
import { SAME_ORIGIN, parseOriginPolicy } from './origin';
import { SILENT_LOGGER, type SimWorld } from './Room';
import { TestClient } from './testClient';

/** lobby -> countdown (2 humans) -> playing after 300 ms; echoes the last input seq per player. */
class ScriptedWorld implements SimWorld {
  tick = 0;
  timeMs = 0;
  map = { id: 'island01' } as MapData;
  private humans = new Map<PlayerId, { name: string; seq: number; x: number }>();
  private nextId = 1;
  private phase: MatchState['phase'] = 'lobby';
  private countdownEnds = 0;
  addPlayer(name: string): PlayerId | null {
    if (this.humans.size >= 4) return null;
    const id = this.nextId++;
    this.humans.set(id, { name, seq: 0, x: 0 });
    return id;
  }
  removePlayer(id: PlayerId): void {
    this.humans.delete(id);
  }
  applyInput(id: PlayerId, input: PlayerInput): void {
    const h = this.humans.get(id);
    if (!h) return;
    h.seq = input.seq;
    h.x += input.moveForward * input.dt * 5;
  }
  step(dt: number): SimEvent[] {
    this.tick++;
    this.timeMs = this.tick * dt * 1000;
    if (this.phase === 'lobby' && this.humans.size >= 2) {
      this.phase = 'countdown';
      this.countdownEnds = this.timeMs + 300;
    }
    if (this.phase === 'countdown' && this.timeMs >= this.countdownEnds) {
      this.phase = 'playing';
      return [...this.humans.keys()].map((id) => ({ type: 'spawn' as const, playerId: id, pos: { x: 0, y: 30, z: 0 } }));
    }
    return [];
  }
  snapshotFor(viewerId: PlayerId | null): WorldSnapshot {
    const players = this.phase === 'playing'
      ? [...this.humans].map(([id, h]) => makePlayer(id, { name: h.name, pos: { x: h.x, y: 0, z: 0 } }))
      : [];
    const me = viewerId !== null ? this.humans.get(viewerId) : undefined;
    return makeSnapshot(this.tick, players, {
      serverTime: this.timeMs,
      match: this.getMatch(),
      local: me && this.phase === 'playing' ? makeLocal(viewerId as number, { lastProcessedInputSeq: me.seq }) : null,
    });
  }
  getMatch(): MatchState {
    return makeMatch({ phase: this.phase, lobbyCount: this.humans.size });
  }
}

const playing = (m: { t: string }): m is SnapshotMessage =>
  m.t === 'snapshot' && (m as SnapshotMessage).snap.match.phase === 'playing';

describe.each([0, 150])('transport with %i ms simulated RTT', (latencyMs) => {
  let server: RunningServer;
  const url = (): string => `ws://127.0.0.1:${server.port}${WS_PATH}`;

  beforeAll(async () => {
    server = await startServer({
      createWorld: () => new ScriptedWorld(),
      balance: BALANCE,
      port: 0,
      host: '127.0.0.1',
      log: SILENT_LOGGER,
      lag: { latencyMs, jitterMs: latencyMs ? 30 : 0 },
    });
  });
  afterAll(() => server.close());

  it('join -> welcome -> playing; inputs acknowledged; RTT reflects the simulated lag', async () => {
    const a = new TestClient(url());
    const b = new TestClient(url());
    await Promise.all([a.opened(), b.opened()]);
    a.join('Alice');
    b.join('Bob');
    await Promise.all([a.waitFor((m) => m.t === 'welcome'), b.waitFor((m) => m.t === 'welcome')]);

    const t0 = performance.now();
    a.ping();
    await a.waitFor((m) => m.t === 'pong');
    const rtt = performance.now() - t0;
    expect(rtt).toBeGreaterThanOrEqual(latencyMs);
    expect(rtt).toBeLessThan(latencyMs + 150);

    await a.waitFor(playing, 3000);
    let lastSeq = 0;
    const sentAt = new Map<number, number>();
    const acks: number[] = [];
    a.onMessage = (m) => {
      if (m.t !== 'snapshot' || !m.snap.local) return;
      for (const [seq, at] of sentAt) {
        if (seq > m.snap.local.lastProcessedInputSeq) break;
        acks.push(performance.now() - at);
        sentAt.delete(seq);
      }
    };
    await new Promise<void>((resolve) => {
      let n = 0;
      const timer = setInterval(() => {
        lastSeq = a.sendInput({ moveForward: 1 });
        sentAt.set(lastSeq, performance.now());
        if (++n === 30) {
          clearInterval(timer);
          resolve();
        }
      }, 1000 / 30);
    });
    await a.waitFor((m) => m.t === 'snapshot' && (m.snap.local?.lastProcessedInputSeq ?? 0) >= lastSeq, 2000, false);
    const sorted = acks.sort((x, y) => x - y);
    const p50 = sorted[Math.floor(sorted.length / 2)]!;
    // ack = RTT + up to one tick of queueing + up to one snapshot interval.
    expect(p50).toBeGreaterThanOrEqual(latencyMs);
    expect(p50).toBeLessThan(latencyMs + 200);
    expect(a.latest!.players.find((p) => p.id === a.welcome!.playerId)!.pos.x).toBeGreaterThan(0);

    // Snapshots compressed on the wire (permessage-deflate): wire bytes well under JSON bytes.
    expect(a.tcp!.bytesRead).toBeLessThan(a.bytesIn);
    a.close();
    b.close();
  });

  it('rejects upgrades on other paths and serves /healthz', async () => {
    const bad = new TestClient(`ws://127.0.0.1:${server.port}/nope`);
    await expect(bad.opened()).rejects.toThrow(/404/);
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);
  });
});

describe('WebSocket origin policy (production default)', () => {
  let server: RunningServer;
  const url = (): string => `ws://127.0.0.1:${server.port}${WS_PATH}`;
  const warnings: string[] = [];

  beforeAll(async () => {
    server = await startServer({
      createWorld: () => new ScriptedWorld(),
      balance: BALANCE,
      port: 0,
      host: '127.0.0.1',
      log: { ...SILENT_LOGGER, warn: (m: string) => warnings.push(m) },
      originPolicy: SAME_ORIGIN,
    });
  });
  afterAll(() => server.close());

  it('accepts a same-origin upgrade (the page served by this process)', async () => {
    const ok = new TestClient(url()); // sends Origin http://127.0.0.1:<port>, like the served page would
    await ok.opened();
    ok.join('Same');
    await ok.waitFor((m) => m.t === 'welcome');
    ok.close();
  });

  it('rejects cross-site and Origin-less upgrades with 403 and logs them', async () => {
    const evil = new TestClient(url(), true, 'https://evil.example');
    await expect(evil.opened()).rejects.toThrow(/403/);
    const none = new TestClient(url(), true, null);
    await expect(none.opened()).rejects.toThrow(/403/);
    const otherPort = new TestClient(url(), true, 'http://127.0.0.1:1');
    await expect(otherPort.opened()).rejects.toThrow(/403/);
    expect(warnings.filter((w) => w.includes('rejected upgrade'))).toHaveLength(3);
    expect(server.room.stats().connections).toBe(0);
  });

  it('an explicit list admits a separate client origin', async () => {
    const other = await startServer({
      createWorld: () => new ScriptedWorld(),
      balance: BALANCE,
      port: 0,
      host: '127.0.0.1',
      log: SILENT_LOGGER,
      originPolicy: parseOriginPolicy('https://play.example.com', true),
    });
    try {
      const u = `ws://127.0.0.1:${other.port}${WS_PATH}`;
      const ok = new TestClient(u, true, 'https://play.example.com');
      await ok.opened();
      ok.close();
      await expect(new TestClient(u).opened()).rejects.toThrow(/403/);
    } finally {
      await other.close();
    }
  });
});
