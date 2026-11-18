/**
 * Server-side observer for E2E specs (owner: qa-tester): a raw `ws` client that says `hello` (M2b, ADR 0006 §6), joins
 * a room by its code and keeps the latest snapshot. Joined after the room's match started it is a spectator
 * (snapshot.local = null) and sees every participant's position and the loot list, which lets a spec steer the browser
 * player and verify outcomes against the authoritative state. It never advertises deltas, so every snapshot is full. Deliberately imports nothing from src/ so Playwright's loader stays simple; the shapes
 * mirror src/shared/types.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PROTOCOL_VERSION = Number(
  /PROTOCOL_VERSION\s*=\s*(\d+)/.exec(readFileSync(join(ROOT, 'src/shared/constants.ts'), 'utf8'))?.[1] ?? '1',
);
/**
 * M2a: the server packs `PlayerState.anim` into a bitmask (bit i = ANIM_BITS[i] in src/shared/protocol/messages.ts).
 * The bit order is read from the source so the observer stays import-free and in step with the protocol.
 */
const ANIM_BITS: string[] = (() => {
  const src = readFileSync(join(ROOT, 'src/shared/protocol/messages.ts'), 'utf8');
  const m = /ANIM_BITS\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!m) throw new Error('observer: ANIM_BITS not found in messages.ts');
  return [...m[1]!.matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1]!);
})();
const unpackAnim = (n: number): ObsPlayer['anim'] => {
  const out: Record<string, boolean> = {};
  ANIM_BITS.forEach((k, i) => (out[k] = (n & (1 << i)) !== 0));
  return out as unknown as ObsPlayer['anim'];
};

export interface Vec3 { x: number; y: number; z: number }
export interface ObsPlayer {
  id: number;
  name: string;
  pos: Vec3;
  velY: number;
  yaw: number;
  pitch: number;
  hp: number;
  /** M2a: worn tiers (0 = none); durability is owner-only and never reaches the observer. */
  vestTier: number;
  helmetTier: number;
  stance: 'stand' | 'crouch' | 'prone';
  stanceFrom: 'stand' | 'crouch' | 'prone';
  stanceProgress: number;
  alive: boolean;
  weapon: string;
  isBot: boolean;
  kills: number;
  /** M2b: aboard the carrier (omitted on the wire when false). */
  aboard: boolean;
  /** M2b: 'freefall' | 'chute' while dropping, else null (omitted on the wire when null). */
  dropPhase: 'freefall' | 'chute' | null;
  anim: {
    moving: boolean; sprinting: boolean; airborne: boolean; dropping: boolean; inWater: boolean; firing: boolean;
    reloading: boolean; healing: boolean; ads: boolean; cooking: boolean;
  };
}
export interface ObsGrenade { id: number; ownerId: number; pos: Vec3; vel?: Vec3; inWater: boolean; explodesAt: number }
export interface ObsLoot { id: number; item: string; qty: number; pos: Vec3; durability?: number }
export interface ObsSnapshot {
  tick: number;
  serverTime: number;
  match: {
    matchId: number; phase: string; aliveCount: number; totalPlayers: number; mapId?: string; aboardCount?: number;
    route?: { startsAt: number; noJumpUntil: number; ejectAt: number; endsAt: number; altitude: number };
  };
  zone: { phaseIndex: number; center: { x: number; z: number }; radius: number; shrinking: boolean; dps: number } | null;
  players: ObsPlayer[];
  loot: ObsLoot[];
  /** M2a: live grenades (sent in full every snapshot). */
  grenades: ObsGrenade[];
}
export interface ObsEvent { type: string; [k: string]: unknown }

export class Observer {
  latest: ObsSnapshot | null = null;
  /** Every snapshot received (players only, loot stripped), newest last; capped. */
  readonly history: ObsSnapshot[] = [];
  readonly events: ObsEvent[] = [];
  private loot: ObsLoot[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { t: string; snap?: ObsSnapshot & { loot?: ObsLoot[] }; events?: ObsEvent[] };
      if (msg.t === 'snapshot' && msg.snap) {
        for (const p of msg.snap.players) {
          const raw = p as unknown as { anim: unknown };
          if (typeof raw.anim === 'number') p.anim = unpackAnim(raw.anim);
          // M2b wire compaction omits resting drop fields.
          p.aboard ??= false;
          p.dropPhase ??= null;
        }
        if (msg.snap.loot) this.loot = msg.snap.loot;
        this.latest = { ...msg.snap, loot: this.loot };
        this.history.push({ ...msg.snap, loot: [] });
        if (this.history.length > 2000) this.history.splice(0, 500);
      } else if (msg.t === 'events' && msg.events) {
        this.events.push(...msg.events);
      } else {
        this.control.push(msg as unknown as { t: string; [k: string]: unknown });
        if (this.control.length > 500) this.control.splice(0, 100);
      }
    });
  }

  /** Raw server messages other than snapshots and events (room, roomJoined, reject, welcome, ...), newest last. */
  readonly control: { t: string; [k: string]: unknown }[] = [];

  /**
   * M2b: hello, then join the room with `code`. Resolves once the room join is answered and (when the room is in a
   * match) the first snapshot arrived. Throws on a reject.
   */
  static async connect(serverPort: number, code: string, name = 'QA Observer'): Promise<Observer> {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`, { origin: `http://127.0.0.1:${serverPort}` });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    const o = new Observer(ws);
    const token = `qa-observer-${Math.random().toString(36).slice(2, 14).padEnd(12, 'x')}`;
    ws.send(JSON.stringify({ t: 'hello', name, protocolVersion: PROTOCOL_VERSION, clientToken: token }));
    await o.waitControl((m) => m.t === 'hello', 5000);
    ws.send(JSON.stringify({ t: 'joinRoom', code, rid: 1 }));
    const ans = await o.waitControl((m) => (m.t === 'roomJoined' || m.t === 'reject') && m.rid === 1, 5000);
    if (ans.t === 'reject') throw new Error(`observer join rejected: ${JSON.stringify(ans)}`);
    const room = ans.room as { phase: string };
    if (room.phase === 'playing' || room.phase === 'results') {
      const until = Date.now() + 5000;
      while (!o.latest && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    }
    return o;
  }

  async waitControl(pred: (m: { t: string; [k: string]: unknown }) => boolean, timeoutMs: number): Promise<{ t: string; [k: string]: unknown }> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const m = this.control.find(pred);
      if (m) return m;
      if (Date.now() > until) throw new Error(`observer: no matching control message in ${timeoutMs} ms; got ${this.control.map((x) => x.t).join(',')}`);
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  player(name: string): ObsPlayer | undefined {
    return this.latest?.players.find((p) => p.name === name);
  }

  /** Wait for the next snapshot after now. */
  async fresh(): Promise<ObsSnapshot> {
    const tick = this.latest?.tick ?? -1;
    const until = Date.now() + 3000;
    while ((this.latest?.tick ?? -1) <= tick && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    if (!this.latest) throw new Error('no snapshot');
    return this.latest;
  }

  /** Snapshots of `name` with tick > `sinceTick` (server-time ordered). */
  track(name: string, sinceTick: number): { tick: number; serverTime: number; p: ObsPlayer }[] {
    return this.history
      .filter((s) => s.tick > sinceTick)
      .flatMap((s) => {
        const p = s.players.find((x) => x.name === name);
        return p ? [{ tick: s.tick, serverTime: s.serverTime, p }] : [];
      });
  }

  /** Horizontal speed (m/s of server time) of `name` over snapshots after `sinceTick`. */
  speed(name: string, sinceTick: number): number {
    const t = this.track(name, sinceTick);
    if (t.length < 2) return NaN;
    const a = t[0]!;
    const b = t[t.length - 1]!;
    return dist2(a.p.pos, b.p.pos) / ((b.serverTime - a.serverTime) / 1000);
  }

  /** Highest horizontal speed of `name` over any window of >= `windowMs` server time after `sinceTick`. */
  peakSpeed(name: string, sinceTick: number, windowMs = 500): number {
    const t = this.track(name, sinceTick);
    let best = NaN;
    for (let i = 0, j = 0; i < t.length; i++) {
      while (j < t.length && t[j]!.serverTime - t[i]!.serverTime < windowMs) j++;
      if (j >= t.length) break;
      const v = dist2(t[i]!.p.pos, t[j]!.p.pos) / ((t[j]!.serverTime - t[i]!.serverTime) / 1000);
      if (!(v <= best)) best = v;
    }
    return best;
  }

  eventsOf(type: string): ObsEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  close(): void {
    this.ws.close();
  }
}

export const dist2 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
/** Yaw that faces from `a` toward `b` (yaw 0 looks toward -Z; forward = (-sin yaw, 0, -cos yaw)). */
export const yawTo = (a: Vec3, b: Vec3): number => Math.atan2(-(b.x - a.x), -(b.z - a.z));
export const wrap = (r: number): number => Math.atan2(Math.sin(r), Math.cos(r));
