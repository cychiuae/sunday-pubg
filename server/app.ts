/**
 * HTTP + WebSocket server wiring. `startServer` is used by server/index.ts (process entry) and by tests.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { t, keysWithPrefix } from '../src/content/strings';
import { DEFAULT_MAP_ID, getMap } from '../src/game/levels';
import type { Balance } from '../src/shared/balance';
import { INPUT_HZ, SIM_HZ, SNAPSHOT_HZ, WS_PATH } from '../src/shared/constants';
import { MAX_CLIENT_FRAME_BYTES_HARD } from '../src/shared/protocol/messages';
import type { LagConfig } from './lag';
import { ANY_ORIGIN, isOriginAllowed, type OriginPolicy } from './origin';
import { Room, type Logger, type WorldFactory } from './Room';
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
  seed?: number;
  log?: Logger;
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
  readonly room: Room;
  readonly http: Server;
  close(): Promise<void>;
}

const HEARTBEAT_MS = 10_000;

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

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const log = opts.log ?? console;
  const mapId = DEFAULT_MAP_ID;
  const room = new Room({
    createWorld: opts.createWorld,
    map: getMap(mapId),
    mapId,
    balance: opts.balance,
    seed: opts.seed ?? Math.floor(Math.random() * 0xffffffff),
    botNames: keysWithPrefix('bot.name').map((k) => t(k)),
    simHz: opts.simHz ?? SIM_HZ,
    snapshotHz: opts.snapshotHz ?? SNAPSHOT_HZ,
    inputHz: opts.inputHz ?? INPUT_HZ,
    lag: opts.lag,
    log,
  });

  const staticHandler = opts.serveStatic && opts.distDir ? createStaticHandler(opts.distDir) : null;
  const http = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ...room.stats() }));
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
  const maxPerIp = opts.maxConnsPerIp ?? 32;
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
      const conn = room.connect(ws, ip);
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
  room.start();
  const port = (http.address() as AddressInfo).port;

  let closed = false;
  return {
    port,
    room,
    http,
    close: async () => {
      if (closed) return;
      closed = true;
      room.stop();
      room.closeAll();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
