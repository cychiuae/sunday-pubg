/**
 * Headless bot clients for load and lag testing (qa-tester, network-engineer).
 *
 *   npx tsx server/tools/bots.ts --url ws://127.0.0.1:8790/ws --clients 8 --seconds 30 [--origin https://host]
 *
 * Each client joins, random-walks with 30 Hz inputs (sometimes firing/jumping), and pings once a second.
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
  },
});
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
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
};
const fmt = (n: number, d = 0): string => (Number.isFinite(n) ? n.toFixed(d) : '-');

async function run(): Promise<void> {
  const all: Stats[] = [];
  for (let i = 0; i < count; i++) {
    const client = new TestClient(url, false, values.origin ?? defaultOrigin(url));
    const st: Stats = { name: `${values.prefix}${i + 1}`, client, sentAt: new Map(), ackLat: [], rtts: [], firstSnapAt: 0, phase: '?' };
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
    };
    await client.opened();
    client.join(st.name);
    all.push(st);
  }
  console.info(`${count} clients connected to ${url}; running ${seconds}s`);

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

  console.info('name          phase     snap/s  json KB/s  wire KB/s  maxSnap B  maxDelta B  full  rtt p50/p95   ack p50/p95 ms');
  let jsonSum = 0;
  let wireSum = 0;
  for (const st of all) {
    const c = st.client;
    const json = c.bytesIn / 1024 / elapsed;
    const wire = (c.tcp?.bytesRead ?? 0) / 1024 / elapsed;
    jsonSum += json;
    wireSum += wire;
    console.info(
      `${st.name.padEnd(13)} ${st.phase.padEnd(9)} ${fmt(c.snapshotCount / elapsed, 1).padStart(6)}  ${fmt(json, 1).padStart(9)}  ${fmt(wire, 1).padStart(9)}  ${String(c.maxSnapshotBytes).padStart(9)}  ${String(c.maxDeltaSnapshotBytes).padStart(10)}  ${String(c.fullSnapshots).padStart(4)}  ${fmt(pct(st.rtts, 50)).padStart(5)}/${fmt(pct(st.rtts, 95)).padEnd(5)}  ${fmt(pct(st.ackLat, 50)).padStart(5)}/${fmt(pct(st.ackLat, 95))}`,
    );
  }
  console.info(`avg per client: json ${fmt(jsonSum / all.length, 1)} KB/s, wire ${fmt(wireSum / all.length, 1)} KB/s`);
  for (const st of all) st.client.close();
  setTimeout(() => process.exit(0), 200);
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
