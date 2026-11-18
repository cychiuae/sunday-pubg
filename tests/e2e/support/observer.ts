/**
 * Server-side observer for E2E specs (owner: qa-tester): a raw `ws` client that joins the test stack's game server
 * and keeps the latest snapshot. Joined after the match starts it is a spectator (snapshot.local = null) and sees every
 * participant's position and the loot list, which lets a spec steer the browser player and verify outcomes against
 * the authoritative state. Deliberately imports nothing from src/ so Playwright's loader stays simple; the shapes
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

export interface Vec3 { x: number; y: number; z: number }
export interface ObsPlayer {
  id: number;
  name: string;
  pos: Vec3;
  velY: number;
  yaw: number;
  pitch: number;
  hp: number;
  armor: number;
  alive: boolean;
  weapon: string;
  isBot: boolean;
  kills: number;
  anim: { moving: boolean; sprinting: boolean; airborne: boolean; dropping: boolean; inWater: boolean; firing: boolean; reloading: boolean; healing: boolean };
}
export interface ObsLoot { id: number; item: string; qty: number; pos: Vec3 }
export interface ObsSnapshot {
  tick: number;
  serverTime: number;
  match: { matchId: number; phase: string; aliveCount: number; totalPlayers: number };
  zone: { phaseIndex: number; center: { x: number; z: number }; radius: number; shrinking: boolean; dps: number } | null;
  players: ObsPlayer[];
  loot: ObsLoot[];
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
        if (msg.snap.loot) this.loot = msg.snap.loot;
        this.latest = { ...msg.snap, loot: this.loot };
        this.history.push({ ...msg.snap, loot: [] });
        if (this.history.length > 2000) this.history.splice(0, 500);
      } else if (msg.t === 'events' && msg.events) {
        this.events.push(...msg.events);
      }
    });
  }

  static async connect(serverPort: number, name = 'QA Observer'): Promise<Observer> {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    ws.send(JSON.stringify({ t: 'join', name, protocolVersion: PROTOCOL_VERSION }));
    const o = new Observer(ws);
    const until = Date.now() + 5000;
    while (!o.latest && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return o;
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
