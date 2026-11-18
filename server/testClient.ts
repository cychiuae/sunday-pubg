/**
 * Headless protocol client for integration tests and the load/lag tool (server/tools/bots.ts).
 * Speaks the real wire protocol over `ws`.
 */
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../src/shared/constants';
import { CAP_DELTA, SnapshotDeltaDecoder } from '../src/shared/protocol/delta';
import { decodeServerMessage, encode, type ClientMessage, type ServerMessage } from '../src/shared/protocol/messages';
import type { PlayerInput, WelcomeInfo, WorldSnapshot } from '../src/shared/types';

/** http(s) origin for a ws(s) URL, or null when it cannot be parsed. */
export function defaultOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  } catch {
    return null;
  }
}

export class TestClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  welcome: WelcomeInfo | null = null;
  latest: WorldSnapshot | null = null;
  bytesIn = 0;
  snapshotCount = 0;
  snapshotBytes = 0;
  maxSnapshotBytes = 0;
  /** Largest delta snapshot (players against a base; excludes full syncs at join, match start and resync). */
  maxDeltaSnapshotBytes = 0;
  /** Snapshots that carried complete players (join, resync) or a full loot list. */
  fullSnapshots = 0;
  lastRttMs = 0;
  closed: { code: number; reason: string } | null = null;
  private seq = 0;
  private readonly deltaDecoder = new SnapshotDeltaDecoder();
  /** Delta snapshots that could not be applied (each sends a resync). */
  resyncs = 0;
  private lastResyncAt = Number.NEGATIVE_INFINITY;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  /** Underlying TCP socket (for wire-level byte counts, which include permessage-deflate savings). */
  tcp: { bytesRead: number } | null = null;
  onMessage: ((msg: ServerMessage) => void) | null = null;

  /**
   * `keepMessages = false` for long load runs (waitFor then only sees future messages).
   * `origin`: the Origin header to send, like a browser would. Default: the http(s) form of `url`, which passes the
   * production `self` origin policy (server/origin.ts). Pass null to send none.
   * `deltas`: advertise `delta1` on join (like NetClient). Snapshot messages seen by `messages`, `onMessage` and
   * `waitFor` are always the rebuilt full snapshots (complete players and loot), whichever format the wire used.
   */
  constructor(
    url: string,
    private readonly keepMessages = true,
    origin: string | null = defaultOrigin(url),
    private readonly deltas = true,
  ) {
    this.ws = new WebSocket(url, origin === null ? {} : { origin });
    this.ws.on('upgrade', (res) => {
      this.tcp = res.socket;
    });
    this.ws.on('message', (data: WebSocket.RawData) => {
      const text = data.toString();
      this.bytesIn += text.length;
      let msg = decodeServerMessage(text);
      if (!msg) throw new Error(`invalid server frame: ${text.slice(0, 200)}`);
      if (msg.t === 'welcome') this.welcome = msg.welcome;
      if (msg.t === 'snapshot') {
        this.snapshotCount++;
        this.snapshotBytes += text.length;
        this.maxSnapshotBytes = Math.max(this.maxSnapshotBytes, text.length);
        if (msg.snap.base !== undefined && msg.snap.loot === undefined) {
          this.maxDeltaSnapshotBytes = Math.max(this.maxDeltaSnapshotBytes, text.length);
        } else this.fullSnapshots++;
        const res = this.deltaDecoder.apply(msg.snap);
        if (!res.ok) {
          this.resyncs++;
          const now = performance.now();
          if (now - this.lastResyncAt >= 1000) {
            this.lastResyncAt = now;
            this.send({ t: 'resync' });
          }
          return;
        }
        this.latest = res.snap;
        msg = { t: 'snapshot', snap: res.snap };
      }
      if (msg.t === 'pong') this.lastRttMs = performance.now() - msg.clientTime;
      if (this.keepMessages) this.messages.push(msg);
      this.onMessage?.(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
  }

  opened(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(msg: ClientMessage | string): void {
    this.ws.send(typeof msg === 'string' ? msg : encode(msg));
  }

  join(name: string): void {
    this.send({ t: 'join', name, protocolVersion: PROTOCOL_VERSION, ...(this.deltas ? { caps: [CAP_DELTA] } : {}) });
  }

  ping(): void {
    this.send({ t: 'ping', clientTime: performance.now() });
  }

  sendInput(over: Partial<PlayerInput> = {}): number {
    const input: PlayerInput = {
      seq: ++this.seq,
      dt: 1 / 30,
      moveForward: 0,
      moveRight: 0,
      yaw: 0,
      pitch: 0,
      sprint: false,
      fire: false,
      jump: false,
      reload: false,
      interact: false,
      useHeal: false,
      selectSlot: -1,
      ...over,
    };
    this.send({ t: 'input', input });
    return input.seq;
  }

  /** Resolves with the first future (or already received, if `pastToo`) message matching `pred`. */
  waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs?: number, pastToo?: boolean): Promise<T>;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs?: number, pastToo?: boolean): Promise<ServerMessage>;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = 5000, pastToo = true): Promise<ServerMessage> {
    if (pastToo) {
      const found = this.messages.find(pred);
      if (found) return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  waitClosed(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
      this.ws.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}
