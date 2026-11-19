/**
 * HTTP + WebSocket server wiring. `startServer` is used by server/index.ts (process entry) and by tests.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { t, keysWithPrefix } from '../src/content/strings';
import { balanceForMap, type Balance } from '../src/shared/balance';
import { INPUT_HZ, SIM_HZ, SNAPSHOT_HZ, WS_PATH } from '../src/shared/constants';
import { isIndoor, validateIndoorMap } from '../src/shared/maps';
import { MAX_CLIENT_FRAME_BYTES_HARD } from '../src/shared/protocol/messages';
import { resolveMapChoice } from '../src/shared/sim/mapVote';
import { prepareMap } from '../src/shared/sim/movement';
import { applyLayout, buildMatchLayout, pickVariants } from '../src/game/levels/layout';
import type { LayoutGenerator } from './layoutLock';
import type { Logger, WorldFactory } from './common';
import { getMap } from '../src/game/levels';
import { levelIds, mapVoteLockSeconds, roomsBalance } from './config';
import type { LagConfig } from './lag';
import { ANY_ORIGIN, isOriginAllowed, type OriginPolicy } from './origin';
import { RoomManager } from './RoomManager';
import { createStaticHandler } from './static';

export interface StartOptions {
  createWorld: WorldFactory;
  balance: Balance;
  /** 0 = pick a free port. */
  port: number;
  host?: string;
  /** Serve `distDir` statically (production). */
  serveStatic?: boolean;
  distDir?: string;
  lag?: LagConfig;
  /** SEED: deterministic room seeds (mixSeed(SEED, roomSerial)). Absent/null = random. */
  seed?: number | null;
  log?: Logger;
  /** MAX_ROOMS (default 8). */
  maxRooms?: number;
  /** MAX_CONNECTIONS (default maxRooms x match.maxPlayers + 32). */
  maxConnections?: number;
  /** MAP pin (already validated by readConfig; an unknown id here throws). */
  mapPin?: string | null;
  /** M2c LAYOUT_SEED pin (already parsed by readConfig; 0 = baseline). Absent/null = a fresh layout per match. */
  layoutSeed?: number | null;
  /** M2c per-match layouts. Default true (the level generator); false = every match on the base map (tests). */
  layouts?: boolean;
  /** WorldOptions.drop (tests: false = the M1 spawn, no carrier flight). */
  worldDrop?: boolean;
  /** Tests: fixed event-loop delay reading (server_busy). */
  loopDelayP99Ms?: () => number;
  maxConnsPerIp?: number;
  /** WebSocket upgrade Origin policy (server/origin.ts). Default: any origin (tests, dev). */
  originPolicy?: OriginPolicy;
  trustProxy?: boolean;
  /** permessage-deflate for server->client frames (snapshots compress ~5-8x). Default true. */
  compression?: boolean;
  /** Override tick rates (tests). Defaults are the engine constants. */
  simHz?: number;
  snapshotHz?: number;
  inputHz?: number;
}

export interface RunningServer {
  readonly port: number;
  readonly manager: RoomManager;
  readonly http: Server;
  close(): Promise<void>;
}

const HEARTBEAT_MS = 10_000;

/** The level-designer's generator (ADR 0007 §1.2), server side: no decor. */
export const LEVEL_LAYOUTS: LayoutGenerator = {
  build: (base, seed) => buildMatchLayout(base, seed, { decor: false }),
  apply: (base, layout) => applyLayout(base, layout),
  picks: (base, seed) => pickVariants(base, seed),
};

function remoteAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

const rawToString = (data: RawData): string =>
  Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');

/**
 * Startup data checks (ARCHITECTURE §15.4): every indoor level passes validateIndoorMap, and once the balance has a
 * `maps` block, every level id has an entry. Throws (fail fast) with every problem listed.
 */
export function checkLevels(balance: Balance, ids: readonly string[] = levelIds()): void {
  const problems: string[] = [];
  for (const id of ids) {
    const map = getMap(id);
    if (isIndoor(map)) {
      for (const p of validateIndoorMap(map, balance.movement.stepHeight)) problems.push(`${id}: ${p}`);
    }
    if (balance.maps && !Object.hasOwn(balance.maps, id)) problems.push(`${id}: no maps.${id} entry in the balance`);
  }
  if (problems.length > 0) throw new Error(`level data check failed:\n  ${problems.join('\n  ')}`);
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const log = opts.log ?? console;
  const maps = levelIds();
  checkLevels(opts.balance, maps);
  const pin = opts.mapPin ?? null;
  if (pin !== null && !maps.includes(pin)) throw new Error(`MAP pin "${pin}" is not a level id`);
  const maxRooms = opts.maxRooms ?? 8;
  const manager = new RoomManager({
    balance: opts.balance,
    rooms: roomsBalance(opts.balance),
    lockSeconds: mapVoteLockSeconds(opts.balance),
    createWorld: opts.createWorld,
    getMap,
    maps,
    pin,
    balanceForMap,
    prepareMap: (map, balance) => prepareMap(map, balance),
    resolveMapChoice,
    botNames: keysWithPrefix('bot.name').map((k) => t(k)),
    ...(opts.worldDrop !== undefined ? { worldDrop: opts.worldDrop } : {}),
    layoutPin: opts.layoutSeed ?? null,
    ...(opts.layouts !== false ? { layouts: LEVEL_LAYOUTS } : {}),
    maxRooms,
    maxConnections: opts.maxConnections ?? maxRooms * opts.balance.match.maxPlayers + 32,
    simHz: opts.simHz ?? SIM_HZ,
    snapshotHz: opts.snapshotHz ?? SNAPSHOT_HZ,
    inputHz: opts.inputHz ?? INPUT_HZ,
    seed: opts.seed ?? null,
    ...(opts.lag ? { lag: opts.lag } : {}),
    log,
    ...(opts.loopDelayP99Ms ? { loopDelayP99Ms: opts.loopDelayP99Ms } : {}),
  });

  const staticHandler = opts.serveStatic && opts.distDir ? createStaticHandler(opts.distDir) : null;
  const http = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(manager.stats()));
      return;
    }
    if (staticHandler) {
      void staticHandler(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Game server. WebSocket endpoint: ${WS_PATH}. In dev, open the Vite client instead.`);
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_FRAME_BYTES_HARD,
    perMessageDeflate:
      opts.compression === false
        ? false
        : { threshold: 256, serverMaxWindowBits: 13, concurrencyLimit: 4, zlibDeflateOptions: { level: 4, memLevel: 7 } },
  });

  const perIp = new Map<string, number>();
  const maxPerIp = opts.maxConnsPerIp ?? 128;
  const originPolicy = opts.originPolicy ?? ANY_ORIGIN;
  let rejectedOrigins = 0;

  http.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== WS_PATH) return rejectUpgrade(socket, 404, 'Not Found');
    if (!isOriginAllowed(originPolicy, req.headers, opts.trustProxy ?? false)) {
      rejectedOrigins++;
      if (rejectedOrigins <= 10 || rejectedOrigins % 1000 === 0) {
        const origin = String(req.headers.origin ?? '(none)').slice(0, 100);
        log.warn(`[ws] rejected upgrade from origin ${origin} (host ${String(req.headers.host ?? '?').slice(0, 100)}; #${rejectedOrigins})`);
      }
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    const ip = remoteAddress(req, opts.trustProxy ?? false);
    const count = perIp.get(ip) ?? 0;
    if (maxPerIp > 0 && count >= maxPerIp) return rejectUpgrade(socket, 429, 'Too Many Requests');

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      const conn = manager.connect(ws, ip);
      let alive = true;
      const release = (): void => {
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ip);
        else perIp.set(ip, n);
      };
      if (!conn) {
        ws.once('close', release);
        return;
      }
      // Transport-level liveness: browsers answer ping frames even in throttled background tabs.
      const heartbeat = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, HEARTBEAT_MS);
      ws.on('pong', () => {
        alive = true;
      });
      ws.on('message', (data, isBinary) => conn.onMessage(isBinary ? null : rawToString(data)));
      ws.on('error', (err) => log.warn(`[ws] ${ip}: ${err.message}`));
      ws.once('close', () => {
        clearInterval(heartbeat);
        release();
        conn.onClose();
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const port = (http.address() as AddressInfo).port;

  let closed = false;
  return {
    port,
    manager,
    http,
    close: async () => {
      if (closed) return;
      closed = true;
      manager.closeAll();
      // Let the close handshakes (after `roomLeft closed`) finish, then cut whatever is left.
      await Promise.race([
        Promise.all([...wss.clients].map((ws) => new Promise<void>((r) => (ws.readyState === ws.CLOSED ? r() : ws.once('close', () => r()))))),
        new Promise<void>((r) => setTimeout(r, 500).unref()),
      ]);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
