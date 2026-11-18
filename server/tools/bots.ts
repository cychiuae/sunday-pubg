/**
 * Headless bot clients for load and lag testing (qa-tester, network-engineer).
 *
 *   npx tsx server/tools/bots.ts --url ws://127.0.0.1:8790/ws --clients 8 --seconds 30 [--origin https://host]
 *   npx tsx server/tools/bots.ts --url ws://127.0.0.1:8851/ws --rooms 8 --clients 64 --seconds 60
 *   npx tsx server/tools/bots.ts --url ws://127.0.0.1:8851/ws --code BCD23 --clients 3
 *
 * M2b rooms: clients are spread over `--rooms N` rooms (client i goes to room i % N). The first client of each room
 * creates it (public, fill with bots, `--map` mode or vote) and is its host; the others join it by code. Hosts press
 * Start whenever their room is waiting, so rooms keep playing match after match. `--code` joins every client to an
 * existing room instead (nobody creates; whoever is host starts). `--private` creates private rooms.
 * At the end the tool reads the server's /healthz (per-room tick time, event-loop delay).
 *
 * Each client random-walks with 30 Hz inputs (sometimes firing/jumping; M2a: holding ADS, toggling crouch and
 * prone, and selecting the grenade slot), and pings once a second.
 * Prints per-client and aggregate: snapshot rate, JSON bytes/s, wire bytes/s (after permessage-deflate),
 * largest snapshot, RTT, and input->ack latency (send of seq N until a snapshot acknowledges N).
 * Pair with a server started with LATENCY_MS / JITTER_MS to see netcode under lag.
 */
import { parseArgs } from 'node:util';
import { TestClient, defaultOrigin } from '../testClient';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:8797/ws' },
    clients: { type: 'string', default: '4' },
    seconds: { type: 'string', default: '20' },
    prefix: { type: 'string', default: 'Loadbot' },
    /** Origin header to send (default: the http(s) form of --url, which a production server accepts). */
    origin: { type: 'string' },
    rooms: { type: 'string', default: '1' },
    code: { type: 'string' },
    map: { type: 'string', default: 'vote' },
    private: { type: 'boolean', default: false },
    /** Do not press Start (rooms then wait for the public auto-start or a human host). */
    'no-start': { type: 'boolean', default: false },
  },
});
const roomCount = Math.max(1, Number(values.rooms));
const url = values.url;
const count = Math.max(1, Number(values.clients));
const seconds = Math.max(1, Number(values.seconds));

interface Stats {
  name: string;
  client: TestClient;
  sentAt: Map<number, number>;
  ackLat: number[];
  rtts: number[];
  firstSnapAt: number;
  phase: string;
  roomIndex: number;
  startSent: boolean;
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
};
const fmt = (n: number, d = 0): string => (Number.isFinite(n) ? n.toFixed(d) : '-');

async function run(): Promise<void> {
  const all: Stats[] = [];
  const codes = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const client = new TestClient(url, false, values.origin ?? defaultOrigin(url));
    const roomIndex = i % roomCount;
    const st: Stats = { name: `${values.prefix}${i + 1}`, client, sentAt: new Map(), ackLat: [], rtts: [], firstSnapAt: 0, phase: '?', roomIndex, startSent: false };
    client.onMessage = (m) => {
      const now = performance.now();
      if (m.t === 'pong') st.rtts.push(now - m.clientTime);
      if (m.t === 'snapshot') {
        if (!st.firstSnapAt) st.firstSnapAt = now;
        st.phase = m.snap.match.phase;
        const ack = m.snap.local?.lastProcessedInputSeq ?? 0;
        for (const [seq, at] of st.sentAt) {
          if (seq > ack) break;
          st.ackLat.push(now - at);
          st.sentAt.delete(seq);
        }
      }
      if (m.t === 'error') console.error(`${st.name}: server error ${m.code}`);
      if (m.t === 'reject') console.error(`${st.name}: ${m.req} rejected: ${m.code}`);
      if (m.t === 'room' || m.t === 'roomJoined') {
        // Hosts start once per waiting period (match after match). Under lag several `room` updates of the same
        // waiting period can arrive after the Start went out, so only the first one starts.
        const r = m.room;
        if (r.phase !== 'waiting') st.startSent = false;
        else if (!values['no-start'] && !st.startSent && r.hostId === client.memberId) {
          st.startSent = true;
          client.startMatch();
        }
      }
    };
    await client.opened();
    await client.helloAndWait(st.name);
    const code = values.code ?? codes.get(roomIndex);
    if (code) await client.joinCodeAndWait(code);
    else {
      const room = await client.createAndWait({
        visibility: values.private ? 'private' : 'public',
        mapMode: values.map,
        fillBots: true,
        maxHumans: 16,
      });
      codes.set(roomIndex, room.code);
    }
    all.push(st);
  }
  console.info(
    `${count} clients connected to ${url} in ${values.code ? `room ${values.code}` : `${codes.size} rooms (${[...codes.values()].join(' ')})`}; running ${seconds}s`,
  );

  const start = performance.now();
  let yaw = 0;
  let forward = 1;
  let right = 0;
  let tick = 0;
  const inputTimer = setInterval(() => {
    tick++;
    if (tick % 45 === 0) {
      forward = Math.random() * 2 - 1;
      right = Math.random() * 2 - 1;
    }
    yaw += 0.03;
    for (const st of all) {
      if (st.client.welcome === null || st.client.closed) continue;
      const seq = st.client.sendInput({
        moveForward: forward,
        moveRight: right,
        yaw,
        sprint: tick % 90 < 60,
        fire: tick % 60 < 10,
        jump: tick % 70 === 0,
        ads: tick % 120 >= 60 && tick % 120 < 100,
        stanceToggle: tick % 150 === 0 ? (tick % 300 === 0 ? 'prone' : 'crouch') : null,
        selectSlot: tick % 400 === 0 ? 3 : tick % 400 === 200 ? 0 : -1,
      });
      // Only time inputs the World will process (participant, alive); lobby inputs are ignored by design.
      const me = st.client.latest?.players.find((p) => p.id === st.client.welcome?.playerId);
      if (st.client.latest?.local && me?.alive) st.sentAt.set(seq, performance.now());
      if (st.sentAt.size > 300) st.sentAt.delete(st.sentAt.keys().next().value as number);
    }
  }, 1000 / 30);
  const pingTimer = setInterval(() => all.forEach((s) => s.client.ws.readyState === 1 && s.client.ping()), 1000);

  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(inputTimer);
  clearInterval(pingTimer);
  const elapsed = (performance.now() - start) / 1000;

  console.info('name          room phase     snap/s  json KB/s  wire KB/s  maxSnap B  maxDelta B  full  rtt p50/p95   ack p50/p95 ms');
  let jsonSum = 0;
  let wireSum = 0;
  for (const st of all) {
    const c = st.client;
    const json = c.bytesIn / 1024 / elapsed;
    const wire = (c.tcp?.bytesRead ?? 0) / 1024 / elapsed;
    jsonSum += json;
    wireSum += wire;
    console.info(
      `${st.name.padEnd(13)} ${String(st.client.room?.id ?? '-').padEnd(4)} ${st.phase.padEnd(9)} ${fmt(c.snapshotCount / elapsed, 1).padStart(6)}  ${fmt(json, 1).padStart(9)}  ${fmt(wire, 1).padStart(9)}  ${String(c.maxSnapshotBytes).padStart(9)}  ${String(c.maxDeltaSnapshotBytes).padStart(10)}  ${String(c.fullSnapshots).padStart(4)}  ${fmt(pct(st.rtts, 50)).padStart(5)}/${fmt(pct(st.rtts, 95)).padEnd(5)}  ${fmt(pct(st.ackLat, 50)).padStart(5)}/${fmt(pct(st.ackLat, 95))}`,
    );
  }
  console.info(`avg per client: json ${fmt(jsonSum / all.length, 1)} KB/s, wire ${fmt(wireSum / all.length, 1)} KB/s`);
  await printHealth();
  for (const st of all) st.client.close();
  setTimeout(() => process.exit(0), 200);
}

/** Per-room tick cost and event-loop delay from the server's /healthz. */
async function printHealth(): Promise<void> {
  try {
    const u = new URL(url);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/healthz';
    const h = (await (await fetch(u)).json()) as {
      rooms: number;
      connections: number;
      loopDelayP99Ms: number;
      loopDelayMaxMs: number;
      perRoom: { id: string; phase: string; humans: number; avgTickMs: number; maxTickMs: number; droppedTicks: number }[];
    };
    console.info(`server: ${h.rooms} rooms, ${h.connections} connections, event loop p99 ${h.loopDelayP99Ms} ms, max ${h.loopDelayMaxMs} ms`);
    for (const r of h.perRoom) {
      console.info(`  ${r.id.padEnd(4)} ${r.phase.padEnd(9)} humans ${String(r.humans).padStart(2)}  tick avg ${r.avgTickMs} ms  max ${r.maxTickMs} ms  dropped ${r.droppedTicks}`);
    }
  } catch (err) {
    console.warn(`(could not read /healthz: ${(err as Error).message})`);
  }
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
