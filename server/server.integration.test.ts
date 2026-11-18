/**
 * End-to-end over real sockets: real World (src/shared/sim/World.ts), real ws server on a random port, M2b rooms.
 * NETCODE.md R7 "Real WebSocket integration": 3 rooms x 3 clients play a match at the same time, with no lag and with
 * 100 ms RTT + 20 ms jitter. A fast balance (short countdown, results, and a lethal one-phase zone) and the M1 spawn
 * (`worldDrop: false`) keep a whole match to a few seconds.
 *
 * BUG-006: every wait has its own timeout well inside the test's Vitest timeout (T below), so a slow machine fails
 * with "timed out waiting for X" rather than a Vitest-level timeout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WS_PATH } from '../src/shared/constants';
import type {
  ErrorMessage,
  RoomListDeltaMessage,
  RoomMessage,
  ServerMessage,
  SnapshotMessage,
  WelcomeMessage,
} from '../src/shared/protocol/messages';
import { createWorld } from '../src/shared/sim/World';
import { startServer, type RunningServer } from './app';
import { SILENT_LOGGER } from './common';
import { loadBalance } from './config';
import { TestClient } from './testClient';

const FAST = loadBalance(
  JSON.stringify({
    match: { countdownSeconds: 1, targetPlayers: 4, resultsSeconds: 1 },
    zone: { phases: [{ waitSeconds: 0.5, shrinkSeconds: 0.5, radiusFraction: 0.01, dps: 500 }] },
  }),
);
/** Per-wait and per-test timeouts (ms). A whole match is about 4 s of wall time; lag adds little. */
const T = { wait: 15_000, match: 30_000, test: 90_000 } as const;
/**
 * The real event-loop monitor refuses createRoom with server_busy while loop delay p99 > 20 ms. Under CPU contention
 * (the full suite next to QA's E2E) that rejected the creates in these tests, so they pin the reading to 0; the
 * server_busy path itself is covered in rooms.test.ts.
 */
const CALM = (): number => 0;

const isWelcome = (m: ServerMessage): m is WelcomeMessage => m.t === 'welcome';
const isError = (m: ServerMessage): m is ErrorMessage => m.t === 'error';
const playingSnap = (m: ServerMessage): m is SnapshotMessage => m.t === 'snapshot' && m.snap.match.phase === 'playing';
/** Back in the waiting room after a match (the `room` update that drops the World). */
const backToWaiting = (m: ServerMessage): m is RoomMessage =>
  m.t === 'room' && m.room.phase === 'waiting' && m.room.matchId === null && m.room.map === null;

async function connect(server: RunningServer, name: string): Promise<TestClient> {
  const c = new TestClient(`ws://127.0.0.1:${server.port}${WS_PATH}`);
  await c.opened();
  await c.helloAndWait(name);
  return c;
}

function driveInputs(clients: TestClient[], ms: number): Promise<void> {
  return new Promise((resolve) => {
    let yaw = 0;
    const timer = setInterval(() => {
      yaw += 0.05;
      for (const c of clients) if (c.welcome) c.sendInput({ moveForward: 1, yaw, sprint: true });
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
])('server integration, rooms (%s)', (_label, latencyMs) => {
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
      worldDrop: false,
      loopDelayP99Ms: CALM,
    });
    expect(server.port).not.toBe(8797);
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await server?.close();
  });

  it(
    '3 rooms x 3 clients play a match at once; no cross-room traffic; the list shows public rooms only; all return to their waiting rooms',
    async () => {
      const watcher = await connect(server, 'Watcher');
      clients.push(watcher);
      watcher.listRooms(true);
      await watcher.waitFor((m) => m.t === 'roomList', T.wait);

      const rooms: { code: string; id: string; members: TestClient[] }[] = [];
      for (let r = 0; r < 3; r++) {
        const host = await connect(server, `R${r}host`);
        clients.push(host);
        const state = await host.createAndWait({ visibility: r === 2 ? 'private' : 'public', fillBots: true, mapMode: 'island01' });
        const members = [host];
        for (let k = 1; k < 3; k++) {
          const c = await connect(server, `R${r}m${k}`);
          clients.push(c);
          // Room 0 by id (from the list), the others by code (typed in lower case with a dash: normalised).
          if (r === 0) {
            const res = await c.answer(c.joinRoomById(state.id), T.wait);
            expect(res.t).toBe('roomJoined');
          } else {
            await c.joinCodeAndWait(`${state.code.slice(0, 2)}-${state.code.slice(2)}`.toLowerCase());
          }
          members.push(c);
        }
        rooms.push({ code: state.code, id: state.id, members });
      }
      for (const room of rooms) room.members[0]!.startMatch();

      const all = rooms.flatMap((r) => r.members);
      const welcomes = await Promise.all(all.map((c) => c.waitFor(isWelcome, T.wait)));
      rooms.forEach((room, r) => {
        for (const c of room.members) {
          expect(c.welcome!.roomId).toBe(room.id);
          expect(c.welcome!.mapId).toBe('island01');
        }
        // Every member of a room is in the same match; rooms have their own match serials.
        expect(new Set(room.members.map((c) => c.welcome!.matchId)).size).toBe(1);
        expect(r).toBeGreaterThanOrEqual(0);
      });
      expect(welcomes).toHaveLength(9);

      const drive = driveInputs(all, 1500);
      await Promise.all(all.map((c) => c.waitFor(playingSnap, T.wait)));
      await drive;
      // Each socket only ever sees its own room's humans (names are unique per room; bots excluded).
      for (const [r, room] of rooms.entries()) {
        for (const c of room.members) {
          for (const m of c.messages) {
            if (m.t !== 'snapshot') continue;
            for (const p of m.snap.players) if (!p.isBot) expect((p.name ?? '').startsWith(`R${r}`)).toBe(true);
          }
        }
      }
      // Everyone returns to the same waiting room: same id and code, ready ticks reset, no World.
      const back = await Promise.all(all.map((c) => c.waitFor(backToWaiting, T.match, false)));
      rooms.forEach((room, r) => {
        for (let k = 0; k < 3; k++) {
          const st = back[r * 3 + k]!.room;
          expect(st.id).toBe(room.id);
          expect(st.code).toBe(room.code);
          expect(st.members).toHaveLength(3);
          expect(st.members.every((m) => !m.ready && m.status === 'waiting')).toBe(true);
        }
      });
      // The watcher's list: the public rooms went through 'playing'; the private one never appeared.
      await new Promise((r) => setTimeout(r, 700 + latencyMs));
      const deltas = watcher.messages.filter((m): m is RoomListDeltaMessage => m.t === 'roomListDelta');
      const seen = new Set(deltas.flatMap((d) => d.upsert.map((s) => `${s.id}:${s.phase}`)));
      expect(seen.has(`${rooms[0]!.id}:playing`)).toBe(true);
      expect(seen.has(`${rooms[1]!.id}:playing`)).toBe(true);
      expect([...seen].some((k) => k.startsWith(`${rooms[2]!.id}:`))).toBe(false);
      expect([...watcher.roomList.keys()].sort()).toEqual([rooms[0]!.id, rooms[1]!.id].sort());
      expect([...watcher.roomList.values()].every((s) => s.phase === 'waiting')).toBe(true);
    },
    T.test,
  );

  it('a bad code and an unknown code are rejected; the socket stays open', async () => {
    const c = await connect(server, 'Typo');
    clients.push(c);
    const bad = await c.answer(c.joinRoomByCode('0OIL1'), T.wait);
    expect(bad).toMatchObject({ t: 'reject', req: 'joinRoom', code: 'bad_code' });
    const missing = await c.answer(c.joinRoomByCode('ZZZZZ'), T.wait);
    expect(missing).toMatchObject({ t: 'reject', code: 'room_not_found' });
    c.ping();
    await c.waitFor((m) => m.t === 'pong', T.wait);
  }, T.test);

  it('deep link: hello and joinRoom { code } sent back to back', async () => {
    const host = await connect(server, 'Linker');
    clients.push(host);
    const room = await host.createAndWait({ visibility: 'private' });
    const guest = new TestClient(`ws://127.0.0.1:${server.port}${WS_PATH}`);
    clients.push(guest);
    await guest.opened();
    guest.hello('Guest');
    const rid = guest.joinRoomByCode(room.code);
    const res = await guest.answer(rid, T.wait);
    expect(res.t).toBe('roomJoined');
  }, T.test);

  it('a legacy join gets bad_version and the socket closes', async () => {
    const c = new TestClient(`ws://127.0.0.1:${server.port}${WS_PATH}`);
    await c.opened();
    c.join('Old');
    const err = await c.waitFor(isError, T.wait);
    expect(err.code).toBe('bad_version');
    await c.waitClosed(T.wait);
  }, T.test);

  it('closes a client that floods malformed frames', async () => {
    const c = await connect(server, 'Hax');
    for (let i = 0; i < 10; i++) c.send('{"t":"input","input":{"seq":"lol"}}');
    const err = await c.waitFor(isError, T.wait);
    expect(err.code).toBe('bad_message');
    const closed = await c.waitClosed(T.wait);
    expect(closed.code).toBe(1008);
  }, T.test);

  it('serves /healthz with per-room tick time and event-loop delay', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    const body = (await res.json()) as {
      ok: boolean;
      rooms: number;
      loopDelayP99Ms: number;
      perRoom: { id: string; avgTickMs: number; maxTickMs: number; ticks: number }[];
    };
    expect(body.ok).toBe(true);
    expect(body.rooms).toBeGreaterThanOrEqual(3);
    expect(body.loopDelayP99Ms).toBe(0); // pinned by CALM
    const played = body.perRoom.filter((r) => r.ticks > 0);
    expect(played.length).toBeGreaterThanOrEqual(3);
    for (const r of played) {
      expect(r.avgTickMs).toBeGreaterThan(0);
      expect(r.maxTickMs).toBeGreaterThanOrEqual(r.avgTickMs);
    }
  }, T.test);
});

describe('server shutdown', () => {
  it('members get roomLeft closed, then the socket closes with 1001', async () => {
    const server = await startServer({ createWorld, balance: FAST, port: 0, host: '127.0.0.1', log: SILENT_LOGGER, loopDelayP99Ms: CALM });
    const c = await connect(server, 'Last');
    await c.createAndWait();
    const left = c.waitFor((m) => m.t === 'roomLeft', T.wait);
    await server.close();
    expect(await left).toEqual({ t: 'roomLeft', reason: 'closed' });
    expect((await c.waitClosed(T.wait)).code).toBe(1001);
  }, T.test);
});
