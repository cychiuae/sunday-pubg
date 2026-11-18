/**
 * Snapshot bandwidth for a real World, offline and deterministic (dev tool, network-engineer).
 *
 *   npx tsx server/tools/measure-snapshot.ts [--players 16] [--seed 7] [--seconds 0] [--hz 20] [--synthetic-grenades 0]
 *
 * Runs a whole match (or --seconds of it) with sim bots and one AFK human viewer. Every snapshot goes through the same
 * path as the Room: quantizeDeep -> SnapshotDeltaEncoder (delta1) -> encodeQuantized. Event frames (public events,
 * as broadcast) are included. Wire bytes are estimated with one stateful raw-deflate stream per client, using the
 * server's permessage-deflate settings (level 4, memLevel 7, 13 window bits, sync flush per frame, frames < 256 B
 * uncompressed), so the result is close to `server/tools/bots.ts` wire KB/s without needing a running server.
 *
 * `--synthetic-grenades N` overlays N always-live grenades on every playing snapshot (ballistic flight from a random
 * live player, rest on landing, explode after the fuse, then a fresh one with a new id; `grenadeThrown` and `explosion`
 * events included). Use it to bound the grenade cost when the bots in the current build throw few or none.
 *
 * Prints: whole-match averages, the same split by "grenades live / none", the largest delta and full snapshots, and
 * the size of the busiest snapshot in full format without loot (the ARCHITECTURE §11 8 KB budget).
 */
import { parseArgs } from 'node:util';
import { constants as Z, createDeflateRaw, type DeflateRaw } from 'node:zlib';
import { keysWithPrefix, t } from '../../src/content/strings';
import { DEFAULT_MAP_ID, getMap } from '../../src/game/levels';
import { SIM_DT, SIM_HZ } from '../../src/shared/constants';
import { SnapshotDeltaEncoder } from '../../src/shared/protocol/delta';
import { encodeQuantized, privateEventRecipient, quantizeDeep } from '../../src/shared/protocol/messages';
import { createWorld } from '../../src/shared/sim/World';
import type { GrenadeState, PlayerState, SimEvent, WorldSnapshot } from '../../src/shared/types';
import { loadBalance } from '../config';

const { values } = parseArgs({
  options: {
    players: { type: 'string', default: '16' },
    seed: { type: 'string', default: '7' },
    /** 0 = until the match reaches results. */
    seconds: { type: 'string', default: '0' },
    hz: { type: 'string', default: '20' },
    'synthetic-grenades': { type: 'string', default: '0' },
  },
});
const players = Math.max(2, Number(values.players));
const seconds = Number(values.seconds);
const snapHz = Number(values.hz);
const synthetic = Math.max(0, Number(values['synthetic-grenades']));

/** Deterministic synthetic grenades (wire-cost stand-ins, not physics). */
class SyntheticGrenades {
  private nextId = 100_000;
  private rng = 12345;
  private list: GrenadeState[] = [];
  constructor(private readonly n: number, private readonly fuseMs: number) {}
  private rand(): number {
    this.rng = (this.rng * 1103515245 + 12345) % 2147483648;
    return this.rng / 2147483648;
  }
  step(dt: number, timeMs: number, snap: WorldSnapshot): SimEvent[] {
    const out: SimEvent[] = [];
    const alive = snap.players.filter((p) => p.alive);
    for (const g of this.list) {
      if (g.explodesAt <= timeMs) out.push({ type: 'explosion', id: g.id, ownerId: g.ownerId, pos: g.pos, radius: 7, inHand: false });
    }
    this.list = this.list.filter((g) => g.explodesAt > timeMs);
    while (this.list.length < this.n && alive.length > 0) {
      const p = alive[Math.floor(this.rand() * alive.length)] as PlayerState;
      const a = this.rand() * Math.PI * 2;
      const g: GrenadeState = {
        id: this.nextId++,
        ownerId: p.id,
        pos: { x: p.pos.x, y: p.pos.y + 1.4, z: p.pos.z },
        vel: { x: Math.sin(a) * 12, y: 6 + this.rand() * 4, z: Math.cos(a) * 12 },
        explodesAt: timeMs + this.fuseMs * (0.5 + this.rand() * 0.5),
        inWater: false,
      };
      this.list.push(g);
      out.push({ type: 'grenadeThrown', id: g.id, ownerId: g.ownerId, pos: g.pos, vel: g.vel, explodesAt: g.explodesAt, dropped: false });
    }
    for (const g of this.list) {
      if (g.vel.x === 0 && g.vel.y === 0 && g.vel.z === 0) continue;
      const y = g.pos.y + g.vel.y * dt;
      if (y <= 0.1) g.vel = { x: 0, y: 0, z: 0 }; // rests (bytes are what matter here)
      else {
        g.pos = { x: g.pos.x + g.vel.x * dt, y, z: g.pos.z + g.vel.z * dt };
        g.vel = { ...g.vel, y: g.vel.y - 9.81 * dt };
      }
    }
    return out;
  }
  get grenades(): GrenadeState[] {
    return this.list.map((g) => ({ ...g, pos: { ...g.pos }, vel: { ...g.vel } })).sort((a, b) => a.id - b.id);
  }
}

/** One client's permessage-deflate context (server -> client, context takeover). */
class WireMeter {
  private readonly z: DeflateRaw = createDeflateRaw({ level: 4, memLevel: 7, windowBits: 13 });
  private chunks: Buffer[] = [];
  bytes = 0;
  constructor() {
    this.z.on('data', (c: Buffer) => this.chunks.push(c));
  }
  async frame(text: string): Promise<number> {
    const raw = Buffer.byteLength(text);
    let n: number;
    if (raw < 256) n = raw; // ws threshold: small frames go uncompressed
    else {
      this.chunks = [];
      this.z.write(text);
      await new Promise<void>((r) => this.z.flush(Z.Z_SYNC_FLUSH, () => r()));
      n = Buffer.concat(this.chunks).length - 4; // permessage-deflate strips the 00 00 ff ff tail
    }
    this.bytes += n + (n < 126 ? 2 : 4); // ws frame header
    return n;
  }
}

interface Bucket { snaps: number; json: number; wire: number; ms: number }
const bucket = (): Bucket => ({ snaps: 0, json: 0, wire: 0, ms: 0 });

async function main(): Promise<void> {
  const balance = loadBalance(JSON.stringify({ match: { countdownSeconds: 0.2, targetPlayers: players } }));
  const world = createWorld({
    map: getMap(DEFAULT_MAP_ID),
    balance,
    seed: Number(values.seed),
    botNames: keysWithPrefix('bot.name').map((k) => t(k)),
  });
  const me = world.addPlayer('Measure');
  if (me === null) throw new Error('could not join');
  const enc = new SnapshotDeltaEncoder(true);
  const meter = new WireMeter();
  const all = bucket();
  const withG = bucket();
  const noG = bucket();
  let events = { frames: 0, json: 0, wire: 0 };
  let maxDelta = 0;
  let maxFull = 0;
  let maxGrenades = 0;
  let busiest: { snap: WorldSnapshot; score: number } | null = null;
  let lastSnapIdx = -1;
  let playing = false;
  const maxTicks = seconds > 0 ? seconds * SIM_HZ : 60 * 20 * SIM_HZ;
  const fake = synthetic > 0 ? new SyntheticGrenades(synthetic, balance.items.grenade.fuseMs) : null;

  for (let tick = 0; tick < maxTicks; tick++) {
    const evs = world.step(SIM_DT);
    const phase = world.getMatch().phase;
    if (phase === 'playing') playing = true;
    if (playing && phase === 'results') break;
    if (playing && fake) evs.push(...fake.step(SIM_DT, world.timeMs, world.snapshotFor(null)));
    const pub = evs.filter((e) => privateEventRecipient(e) === null || privateEventRecipient(e) === me);
    if (playing && pub.length > 0) {
      const text = encodeQuantized({ t: 'events', tick: world.tick, serverTime: world.timeMs, events: pub });
      events = { frames: events.frames + 1, json: events.json + text.length, wire: events.wire + (await meter.frame(text)) };
    }
    const snapIdx = Math.floor((world.tick * snapHz) / SIM_HZ);
    if (snapIdx === lastSnapIdx) continue;
    lastSnapIdx = snapIdx;
    const raw = world.snapshotFor(me);
    if (playing && fake) raw.grenades = [...(raw.grenades ?? []), ...fake.grenades];
    const snap = quantizeDeep(raw);
    const wire = enc.encode(snap);
    const text = encodeQuantized({ t: 'snapshot', snap: wire });
    const w = await meter.frame(text);
    if (!playing) continue;
    const isFull = wire.base === undefined || wire.loot !== undefined;
    if (isFull) maxFull = Math.max(maxFull, text.length);
    else maxDelta = Math.max(maxDelta, text.length);
    const g = (snap.grenades ?? []).length; // tolerate a pre-M2a World
    maxGrenades = Math.max(maxGrenades, g);
    for (const b of [all, g > 0 ? withG : noG]) {
      b.snaps++;
      b.json += text.length;
      b.wire += w;
      b.ms += 1000 / snapHz;
    }
    const moving = snap.players.filter((p) => p.alive).length + 4 * g;
    if (!busiest || moving > busiest.score) busiest = { snap, score: moving };
  }

  const kbs = (bytes: number, ms: number) => (ms > 0 ? (bytes / 1024 / (ms / 1000)).toFixed(2) : '-');
  const row = (name: string, b: Bucket) =>
    console.info(
      `${name.padEnd(16)} snaps ${String(b.snaps).padStart(5)}  avg ${String(Math.round(b.json / Math.max(1, b.snaps))).padStart(5)} B json ` +
        `${String(Math.round(b.wire / Math.max(1, b.snaps))).padStart(4)} B wire  snapshots ${kbs(b.json, b.ms)} KB/s json, ${kbs(b.wire, b.ms)} KB/s wire`,
    );
  console.info(
    `players ${players}, seed ${values.seed}, ${(all.ms / 1000).toFixed(0)} s of play at ${snapHz} Hz` +
      (synthetic > 0 ? `, +${synthetic} synthetic grenades always live` : ''),
  );
  row('whole match', all);
  row('grenades live', withG);
  row('no grenades', noG);
  console.info(
    `events           frames ${events.frames}, ${kbs(events.json, all.ms)} KB/s json, ${kbs(events.wire, all.ms)} KB/s wire`,
  );
  console.info(
    `total per client ${kbs(all.json + events.json, all.ms)} KB/s json, ${kbs(meter.bytes, all.ms)} KB/s wire (incl. pre-match and ws headers)`,
  );
  console.info(`largest delta snapshot ${maxDelta} B, largest full snapshot ${maxFull} B, max live grenades ${maxGrenades}`);
  if (busiest) {
    const { loot: _loot, ...noLoot } = busiest.snap;
    const full = encodeQuantized({ t: 'snapshot', snap: { ...noLoot, players: busiest.snap.players } });
    console.info(
      `busiest snapshot (${busiest.snap.players.filter((p) => p.alive).length} alive, ${(busiest.snap.grenades ?? []).length} grenades) ` +
        `full format without loot: ${full.length} B (budget 8192)`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
