/**
 * End-to-end over real sockets: real World (src/shared/sim/World.ts), real ws server on a random port.
 * Uses a fast balance override so the countdown is short.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WS_PATH } from '../src/shared/constants';
import type { ErrorMessage, PongMessage, SnapshotMessage, WelcomeMessage } from '../src/shared/protocol/messages';
import { createWorld } from '../src/shared/sim/World';
import { startServer, type RunningServer } from './app';
import { loadBalance } from './config';
import { SILENT_LOGGER } from './Room';
import { TestClient } from './testClient';

const FAST = loadBalance(
  JSON.stringify({ match: { countdownSeconds: 0.5, minHumansToStart: 2, targetPlayers: 6, resultsSeconds: 1 } }),
);

const isWelcome = (m: { t: string }): m is WelcomeMessage => m.t === 'welcome';
const isPong = (m: { t: string }): m is PongMessage => m.t === 'pong';
const isError = (m: { t: string }): m is ErrorMessage => m.t === 'error';
const playingSnap = (m: { t: string }): m is SnapshotMessage =>
  m.t === 'snapshot' && (m as SnapshotMessage).snap.match.phase === 'playing';

async function client(server: RunningServer, name: string): Promise<TestClient> {
  const c = new TestClient(`ws://127.0.0.1:${server.port}${WS_PATH}`);
  await c.opened();
  c.join(name);
  return c;
}

function driveInputs(clients: TestClient[], ms: number): Promise<void> {
  return new Promise((resolve) => {
    let yaw = 0;
    const timer = setInterval(() => {
      yaw += 0.05;
      for (const c of clients) c.sendInput({ moveForward: 1, yaw, sprint: true });
    }, 1000 / 30);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, ms);
  });
}

describe.each([
  ['no lag', 0],
  ['100 ms simulated RTT + 20 ms jitter', 100],
])('server integration (%s)', (_label, latencyMs) => {
  let server: RunningServer;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startServer({
      createWorld,
      balance: FAST,
      port: 0,
      host: '127.0.0.1',
      log: SILENT_LOGGER,
      lag: { latencyMs, jitterMs: latencyMs > 0 ? 20 : 0 },
      seed: 1234,
    });
    expect(server.port).not.toBe(8797);
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await server?.close();
  });

  it('two clients join, get welcome + snapshots, and the match reaches playing', async () => {
    const a = await client(server, 'Alice');
    const b = await client(server, 'Bob');
    clients.push(a, b);

    const [wa, wb] = await Promise.all([a.waitFor(isWelcome), b.waitFor(isWelcome)]);
    expect(wa.welcome.mapId).toBe('island01');
    expect(wa.welcome.playerId).not.toBe(wb.welcome.playerId);

    // Clock sync: pong round-trip includes the simulated latency.
    a.ping();
    const pong = await a.waitFor(isPong);
    expect(pong.serverTime).toBeGreaterThanOrEqual(0);
    expect(a.lastRttMs).toBeGreaterThanOrEqual(latencyMs);

    const drive = driveInputs([a, b], 2500);
    const [sa] = await Promise.all([a.waitFor(playingSnap, 6000), b.waitFor(playingSnap, 6000)]);
    await drive;

    const snap = a.latest!;
    expect(sa.snap.match.phase).toBe('playing');
    expect(snap.players.length).toBeGreaterThanOrEqual(2); // humans + bots
    const ids = snap.players.map((p) => p.id);
    expect(ids).toContain(wa.welcome.playerId);
    expect(ids).toContain(wb.welcome.playerId);
    expect(snap.local?.id).toBe(wa.welcome.playerId);
    expect(snap.local!.lastProcessedInputSeq).toBeGreaterThan(0);
    expect(snap.loot.length).toBeGreaterThan(0);

    // Snapshot rate ~20 Hz and size budget (< 8 KB without loot per ARCHITECTURE §11).
    expect(a.snapshotCount).toBeGreaterThan(30);
    const withoutLoot = JSON.stringify({ t: 'snapshot', snap: { ...snap, loot: undefined } }).length;
    expect(withoutLoot).toBeLessThan(8 * 1024);

    // Events arrive (spawn at match start).
    expect(a.messages.some((m) => m.t === 'events' && m.events.some((e) => e.type === 'spawn'))).toBe(true);
  });

  it('a late joiner spectates (local = null) until the next lobby', async () => {
    const c = await client(server, 'Late');
    clients.push(c);
    await c.waitFor(isWelcome);
    const s = (await c.waitFor((m) => m.t === 'snapshot', 3000)) as SnapshotMessage;
    expect(s.snap.local).toBeNull();
  });

  it('rejects a bad protocol version and closes', async () => {
    const c = new TestClient(`ws://127.0.0.1:${server.port}${WS_PATH}`);
    await c.opened();
    c.send({ t: 'join', name: 'Old', protocolVersion: 999 });
    const err = await c.waitFor(isError);
    expect(err.code).toBe('bad_version');
    await c.waitClosed();
  });

  it('closes a client that floods malformed frames', async () => {
    const c = await client(server, 'Hax');
    await c.waitFor(isWelcome);
    for (let i = 0; i < 10; i++) c.send('{"t":"input","input":{"seq":"lol"}}');
    const err = await c.waitFor(isError);
    expect(err.code).toBe('bad_message');
    const closed = await c.waitClosed();
    expect(closed.code).toBe(1008);
  });

  it('disconnect removes the player from the match', async () => {
    const [a, b] = clients;
    const bId = b!.welcome!.playerId;
    b!.close();
    await b!.waitClosed();
    await new Promise((r) => setTimeout(r, 300 + latencyMs));
    const ids = a!.latest!.players.filter((p) => p.alive).map((p) => p.id);
    expect(ids).not.toContain(bId);
  });

  it('serves /healthz', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    const body = (await res.json()) as { ok: boolean; tick: number };
    expect(body.ok).toBe(true);
    expect(body.tick).toBeGreaterThan(0);
  });
});
