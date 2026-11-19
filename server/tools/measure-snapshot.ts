/**
 * Snapshot bandwidth for a real World, offline and deterministic (dev tool, network-engineer).
 *
 *   npx tsx server/tools/measure-snapshot.ts [--players 16] [--seed 7] [--seconds 0] [--hz 20] [--synthetic-grenades 0]
 *     [--synthetic-rockets 0] [--synthetic-smokes 0] [--synthetic-panes 0]
 *
 * Runs a whole match (or --seconds of it) with sim bots and one AFK human viewer. Every snapshot goes through the same
 * path as the Room: quantizeDeep -> SnapshotDeltaEncoder (delta1) -> encodeQuantized, in BOTH wire formats side by side
 * (M2c rows for CAP_ROWS clients, ADR 0007 §9; the object format for the others). Event frames (public events, as
 * broadcast) are included. Wire bytes are estimated with one stateful raw-deflate stream per client and format, using
 * the server's permessage-deflate settings (level 4, memLevel 7, 13 window bits, sync flush per frame, frames < 256 B
 * uncompressed), so the result is close to `server/tools/bots.ts` wire KB/s without needing a running server.
 *
 * `--synthetic-grenades N` overlays N always-live grenades on every playing snapshot (ballistic flight from a random
 * live player, rest on landing, explode after the fuse, then a fresh one with a new id; `grenadeThrown` and `explosion`
 * events included). Use it to bound the grenade cost when the bots in the current build throw few or none.
 * M2c: `--synthetic-rockets N` keeps N live rocket records (each lives 1.5 s, then a new one with a new id),
 * `--synthetic-smokes N` keeps N clouds (each lives 20 s), `--synthetic-panes N` breaks one pane every 5 s up to N.
 * They show the carry-forward rule: deltas pay for these lists only on the snapshot where they change.
 *
 * Prints: whole-match averages, the same split by "grenades live / none", the largest delta and full snapshots, and
 * the size of the busiest snapshot in full format without loot (the 8 KB budget), each as rows and as objects.
 */
import { parseArgs } from 'node:util';
import { constants as Z, createDeflateRaw, type DeflateRaw } from 'node:zlib';
import { keysWithPrefix, t } from '../../src/content/strings';
import { DEFAULT_MAP_ID, getMap } from '../../src/game/levels';
import { SIM_DT, SIM_HZ } from '../../src/shared/constants';
import { SnapshotDeltaEncoder } from '../../src/shared/protocol/delta';
import { encodeQuantized, privateEventRecipient, quantizeDeep, type SnapshotMessage } from '../../src/shared/protocol/messages';
import { createWorld } from '../../src/shared/sim/World';
import type { GrenadeState, PlayerState, RocketState, SimEvent, SmokeCloudState, WorldSnapshot } from '../../src/shared/types';
import { loadBalance } from '../config';

const { values } = parseArgs({
  options: {
    players: { type: 'string', default: '16' },
    seed: { type: 'string', default: '7' },
    /** 0 = until the match reaches results. */
    seconds: { type: 'string', default: '0' },
    hz: { type: 'string', default: '20' },
    'synthetic-grenades': { type: 'string', default: '0' },
    'synthetic-rockets': { type: 'string', default: '0' },
    'synthetic-smokes': { type: 'string', default: '0' },
    'synthetic-panes': { type: 'string', default: '0' },
  },
});
const players = Math.max(2, Number(values.players));
const seconds = Number(values.seconds);
const snapHz = Number(values.hz);
const synthetic = Math.max(0, Number(values['synthetic-grenades']));
const synthRockets = Math.max(0, Number(values['synthetic-rockets']));
const synthSmokes = Math.max(0, Number(values['synthetic-smokes']));
const synthPanes = Math.max(0, Number(values['synthetic-panes']));

/** M2c snapshot fields of a World (optional before the C-gate). */
type M2cLists = { rockets?: RocketState[]; smokes?: SmokeCloudState[]; brokenPanes?: number[] };

/** Deterministic synthetic M2c records (wire-cost stand-ins): rockets, smoke clouds and broken panes. */
class SyntheticM2c {
  private nextId = 200_000;
  private rng = 777;
  private rockets: RocketState[] = [];
  private smokes: SmokeCloudState[] = [];
  private panes: number[] = [];
  private nextPaneAt = 0;
  private rand(): number {
    this.rng = (this.rng * 1103515245 + 12345) % 2147483648;
    return this.rng / 2147483648;
  }
  step(timeMs: number, snap: WorldSnapshot): SimEvent[] {
    const out: SimEvent[] = [];
    const alive = snap.players.filter((p) => p.alive);
    this.rockets = this.rockets.filter((r) => timeMs - r.firedAt < 1500);
    this.smokes = this.smokes.filter((c) => timeMs < c.fadeAt + 3000);
    while (this.rockets.length < synthRockets && alive.length > 0) {
      const p = alive[Math.floor(this.rand() * alive.length)] as PlayerState;
      const a = this.rand() * Math.PI * 2;
      const r: RocketState = {
        id: this.nextId++, ownerId: p.id, level: 1 + Math.floor(this.rand() * 4) as RocketState['level'],
        pos: { x: p.pos.x + 0.123, y: p.pos.y + 1.456, z: p.pos.z - 0.789 },
        vel: { x: Math.sin(a) * 55.123, y: 1.234, z: Math.cos(a) * 55.123 }, firedAt: timeMs,
      };
      this.rockets.push(r);
      out.push({ type: 'rocketFired', ...r } as unknown as SimEvent);
    }
    while (this.smokes.length < synthSmokes && alive.length > 0) {
      const p = alive[Math.floor(this.rand() * alive.length)] as PlayerState;
      const c: SmokeCloudState = {
        id: this.nextId++, ownerId: p.id, pos: { x: p.pos.x + 5.321, y: p.pos.y + 0.111, z: p.pos.z - 4.987 },
        deployedAt: timeMs, fadeAt: timeMs + 17_000,
      };
      this.smokes.push(c);
      out.push({ type: 'smokeDeployed', ...c } as unknown as SimEvent);
    }
    if (this.panes.length < synthPanes && timeMs >= this.nextPaneAt) {
      this.panes.push(this.panes.length * 3 + 7);
      this.nextPaneAt = timeMs + 5000;
      out.push({ type: 'glassBroken', paneId: this.panes.at(-1), pos: { x: 1.5, y: 1.2, z: -3.5 }, byId: null, cause: 'rocket' } as unknown as SimEvent);
    }
    return out;
  }
  apply(snap: WorldSnapshot & M2cLists): void {
    if (synthRockets > 0) snap.rockets = [...(snap.rockets ?? []), ...this.rockets.map((r) => ({ ...r }))];
    if (synthSmokes > 0) snap.smokes = [...(snap.smokes ?? []), ...this.smokes.map((c) => ({ ...c }))];
    if (synthPanes > 0) snap.brokenPanes = [...(snap.brokenPanes ?? []), ...this.panes];
  }
}

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
      if (g.explodesAt <= timeMs) {
        out.push({ type: 'explosion', id: g.id, ownerId: g.ownerId, pos: g.pos, radius: 7, inHand: false, source: 'grenade' });
      }
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
        kind: 'grenade',
      };
      this.list.push(g);
      out.push({
        type: 'grenadeThrown', id: g.id, ownerId: g.ownerId, pos: g.pos, vel: g.vel, explodesAt: g.explodesAt, dropped: false,
        kind: 'grenade',
      });
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

/** Per wire format: the meter (one deflate stream per client) and the stats. */
class Format {
  readonly meter = new WireMeter();
  readonly all = bucket();
  readonly withG = bucket();
  readonly noG = bucket();
  maxDelta = 0;
  maxFull = 0;
  constructor(readonly name: string, readonly rows: boolean) {}
  async snapshot(msg: SnapshotMessage, playing: boolean, grenades: number, ms: number): Promise<void> {
    const text = encodeQuantized(msg, { rows: this.rows });
    const w = await this.meter.frame(text);
    if (!playing) return;
    const isFull = msg.snap.base === undefined || msg.snap.loot !== undefined;
    if (isFull) this.maxFull = Math.max(this.maxFull, text.length);
    else this.maxDelta = Math.max(this.maxDelta, text.length);
    for (const b of [this.all, grenades > 0 ? this.withG : this.noG]) {
      b.snaps++;
      b.json += text.length;
      b.wire += w;
      b.ms += ms;
    }
  }
}

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
  const formats = [new Format('rows', true), new Format('objects', false)] as const;
  let events = { frames: 0, json: 0, wire: 0 };
  let maxGrenades = 0;
  let busiest: { snap: WorldSnapshot; score: number } | null = null;
  let lastSnapIdx = -1;
  let playing = false;
  const maxTicks = seconds > 0 ? seconds * SIM_HZ : 60 * 20 * SIM_HZ;
  const fake = synthetic > 0 ? new SyntheticGrenades(synthetic, balance.items.grenade.fuseMs) : null;
  const m2c = synthRockets + synthSmokes + synthPanes > 0 ? new SyntheticM2c() : null;

  for (let tick = 0; tick < maxTicks; tick++) {
    const evs = world.step(SIM_DT);
    const phase = world.getMatch().phase;
    if (phase === 'playing') playing = true;
    if (playing && phase === 'results') break;
    if (playing && fake) evs.push(...fake.step(SIM_DT, world.timeMs, world.snapshotFor(null)));
    if (playing && m2c) evs.push(...m2c.step(world.timeMs, world.snapshotFor(null)));
    const pub = evs.filter((e) => privateEventRecipient(e) === null || privateEventRecipient(e) === me);
    if (playing && pub.length > 0) {
      const text = encodeQuantized({ t: 'events', tick: world.tick, serverTime: world.timeMs, events: pub });
      // Event frames are the same in both formats; counted once (on the rows meter's stream).
      events = { frames: events.frames + 1, json: events.json + text.length, wire: events.wire + (await formats[0].meter.frame(text)) };
      await formats[1].meter.frame(text);
    }
    const snapIdx = Math.floor((world.tick * snapHz) / SIM_HZ);
    if (snapIdx === lastSnapIdx) continue;
    lastSnapIdx = snapIdx;
    const raw = world.snapshotFor(me);
    if (playing && fake) raw.grenades = [...(raw.grenades ?? []), ...fake.grenades];
    if (playing && m2c) m2c.apply(raw);
    const snap = quantizeDeep(raw);
    const wire = enc.encode(snap);
    const g = (snap.grenades ?? []).length; // tolerate a pre-M2a World
    for (const f of formats) await f.snapshot({ t: 'snapshot', snap: wire }, playing, g, 1000 / snapHz);
    if (!playing) continue;
    maxGrenades = Math.max(maxGrenades, g);
    const lists = snap as WorldSnapshot & M2cLists;
    const moving = snap.players.filter((p) => p.alive).length + 4 * g + 2 * ((lists.rockets?.length ?? 0) + (lists.smokes?.length ?? 0));
    if (!busiest || moving > busiest.score) busiest = { snap, score: moving };
  }

  const kbs = (bytes: number, ms: number) => (ms > 0 ? (bytes / 1024 / (ms / 1000)).toFixed(2) : '-');
  const row = (name: string, b: Bucket) =>
    console.info(
      `  ${name.padEnd(14)} snaps ${String(b.snaps).padStart(5)}  avg ${String(Math.round(b.json / Math.max(1, b.snaps))).padStart(5)} B json ` +
        `${String(Math.round(b.wire / Math.max(1, b.snaps))).padStart(4)} B wire  snapshots ${kbs(b.json, b.ms)} KB/s json, ${kbs(b.wire, b.ms)} KB/s wire`,
    );
  const all = formats[0].all;
  console.info(
    `players ${players}, seed ${values.seed}, ${(all.ms / 1000).toFixed(0)} s of play at ${snapHz} Hz` +
      (synthetic > 0 ? `, +${synthetic} synthetic grenades always live` : '') +
      (synthRockets > 0 ? `, +${synthRockets} rockets` : '') +
      (synthSmokes > 0 ? `, +${synthSmokes} clouds` : '') +
      (synthPanes > 0 ? `, up to ${synthPanes} broken panes` : ''),
  );
  for (const f of formats) {
    console.info(`${f.name}:`);
    row('whole match', f.all);
    row('grenades live', f.withG);
    row('no grenades', f.noG);
    console.info(
      `  total per client ${kbs(f.all.json + events.json, f.all.ms)} KB/s json, ${kbs(f.meter.bytes, f.all.ms)} KB/s wire (incl. events, pre-match and ws headers)`,
    );
    console.info(`  largest delta snapshot ${f.maxDelta} B, largest full snapshot ${f.maxFull} B`);
  }
  console.info(
    `events           frames ${events.frames}, ${kbs(events.json, all.ms)} KB/s json, ${kbs(events.wire, all.ms)} KB/s wire; max live grenades ${maxGrenades}`,
  );
  if (busiest) {
    const { loot: _loot, ...noLoot } = busiest.snap;
    const msg: SnapshotMessage = { t: 'snapshot', snap: { ...noLoot, players: busiest.snap.players } };
    const rows = encodeQuantized(msg, { rows: true }).length;
    const objects = encodeQuantized(msg, { rows: false }).length;
    console.info(
      `busiest snapshot (${busiest.snap.players.filter((p) => p.alive).length} alive, ${(busiest.snap.grenades ?? []).length} grenades) ` +
        `full format without loot: rows ${rows} B, objects ${objects} B (budget 8192)`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
