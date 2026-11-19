/**
 * Headless protocol client for integration tests and the load/lag tool (server/tools/bots.ts).
 * Speaks the real wire protocol over `ws`.
 */
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../src/shared/constants';
import { CAP_DELTA, SnapshotDeltaDecoder } from '../src/shared/protocol/delta';
import { CAP_ROWS } from '../src/shared/protocol/rows';
import type { RoomSettingsInput } from '../src/shared/contracts';
import {
  decodeServerMessage,
  encode,
  type ClientMessage,
  type RejectMessage,
  type RoomJoinedMessage,
  type ServerMessage,
} from '../src/shared/protocol/messages';
import type { MapVoteOption, MemberId, PlayerInput, RoomState, RoomSummary, WelcomeInfo, WorldSnapshot } from '../src/shared/types';

/** http(s) origin for a ws(s) URL, or null when it cannot be parsed. */
export function defaultOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Default wait for lobby replies. Generous on purpose: under CPU contention (the full suite beside E2E) a reply can
 * take seconds; callers' test timeouts must exceed it (BUG-006).
 */
export const LOBBY_WAIT_MS = 12_000;

/** Random 22-char base64url client token (like NetClient's per-browser token). */
export function randomToken(): string {
  return Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64url');
}

export class TestClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  welcome: WelcomeInfo | null = null;
  /** M2b: the room this client is in (latest state), its memberId, and the rebuilt public room list. */
  room: RoomState | null = null;
  memberId: MemberId | null = null;
  readonly roomList = new Map<string, RoomSummary>();
  listRev = -1;
  private rid = 0;
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
   * `deltas`: advertise `delta1` and `rows1` on hello (like NetClient). Snapshot messages seen by `messages`, `onMessage` and
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
      if (msg.t === 'welcome') {
        this.welcome = msg.welcome;
        // A new World restarts ticks: forget the delta base (NetClient does the same).
        this.deltaDecoder.reset();
        this.latest = null;
      }
      if (msg.t === 'roomJoined') {
        this.room = msg.room;
        this.memberId = msg.memberId;
      }
      if (msg.t === 'room') this.room = msg.room;
      if (msg.t === 'roomLeft') {
        this.room = null;
        this.memberId = null;
        this.welcome = null;
      }
      if (msg.t === 'roomList') {
        this.roomList.clear();
        for (const r of msg.rooms) this.roomList.set(r.id, r);
        this.listRev = msg.rev;
      }
      if (msg.t === 'roomListDelta') {
        if (msg.from !== this.listRev) this.send({ t: 'listRooms', subscribe: true });
        else {
          for (const id of msg.remove) this.roomList.delete(id);
          for (const r of msg.upsert) this.roomList.set(r.id, r);
          this.listRev = msg.rev;
        }
      }
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

  /**
   * @deprecated M1/M2a handshake. Since M2b (ADR 0006 §6) the server answers it with `error bad_version`; kept only so
   * older callers compile. Use `hello` plus `createRoom` / `joinRoom*` / `quickPlay`.
   */
  join(name: string): void {
    this.send({ t: 'join', name, protocolVersion: PROTOCOL_VERSION, ...(this.deltas ? { caps: [CAP_DELTA] } : {}) });
  }

  /** M2b handshake (replaces `join`). */
  hello(name: string, clientToken: string | null = randomToken()): void {
    this.send({
      t: 'hello',
      name,
      protocolVersion: PROTOCOL_VERSION,
      ...(clientToken !== null ? { clientToken } : {}),
      // A modern client (deltas) also takes M2c rows, like NetClient; `deltas = false` is the plain object format.
      ...(this.deltas ? { caps: [CAP_DELTA, CAP_ROWS] } : {}),
    });
  }

  /** hello and wait for the server's hello reply. */
  async helloAndWait(name: string, clientToken?: string | null, timeoutMs = LOBBY_WAIT_MS): Promise<void> {
    this.hello(name, clientToken);
    await this.waitFor((m) => m.t === 'hello', timeoutMs, false);
  }

  nextRid(): number {
    return ++this.rid;
  }

  createRoom(settings: Partial<RoomSettingsInput> = {}): number {
    const rid = this.nextRid();
    this.send({ t: 'createRoom', settings, rid });
    return rid;
  }

  joinRoomById(roomId: string): number {
    const rid = this.nextRid();
    this.send({ t: 'joinRoom', roomId, rid });
    return rid;
  }

  joinRoomByCode(code: string): number {
    const rid = this.nextRid();
    this.send({ t: 'joinRoom', code, rid });
    return rid;
  }

  /** Waits for the `roomJoined` (or `reject`) answering request `rid`. */
  async answer(rid: number, timeoutMs = LOBBY_WAIT_MS): Promise<RoomJoinedMessage | RejectMessage> {
    const m = await this.waitFor(
      (x) => (x.t === 'roomJoined' || x.t === 'reject') && x.rid === rid,
      timeoutMs,
    );
    return m as RoomJoinedMessage | RejectMessage;
  }

  /** Creates a room and resolves with its state (throws on a reject). */
  async createAndWait(settings: Partial<RoomSettingsInput> = {}): Promise<RoomState> {
    const res = await this.answer(this.createRoom(settings));
    if (res.t === 'reject') throw new Error(`createRoom rejected: ${res.code}`);
    return res.room;
  }

  /** Joins by code and resolves with the room state (throws on a reject). */
  async joinCodeAndWait(code: string): Promise<RoomState> {
    const res = await this.answer(this.joinRoomByCode(code));
    if (res.t === 'reject') throw new Error(`joinRoom rejected: ${res.code}`);
    return res.room;
  }

  /**
   * NETCODE R6.4 quick play: hello, then join the first public waiting room with space, else create one. Resolves
   * with the room state.
   */
  async quickPlay(name: string, settings: Partial<RoomSettingsInput> = {}): Promise<RoomState> {
    await this.helloAndWait(name);
    this.listRooms(true);
    await this.waitFor((m) => m.t === 'roomList', LOBBY_WAIT_MS, false);
    this.listRooms(false);
    const open = [...this.roomList.values()].find((r) => r.phase === 'waiting' && r.humans < r.maxHumans);
    if (open) {
      const res = await this.answer(this.joinRoomById(open.id));
      if (res.t === 'roomJoined') return res.room;
    }
    return this.createAndWait(settings);
  }

  listRooms(subscribe: boolean): void {
    this.send({ t: 'listRooms', subscribe, rid: this.nextRid() });
  }

  leaveRoom(): void {
    this.send({ t: 'leaveRoom', rid: this.nextRid() });
  }

  setRoomSettings(settings: Partial<RoomSettingsInput>): number {
    const rid = this.nextRid();
    this.send({ t: 'setRoomSettings', settings, rid });
    return rid;
  }

  startMatch(): number {
    const rid = this.nextRid();
    this.send({ t: 'startMatch', rid });
    return rid;
  }

  cancelCountdown(): void {
    this.send({ t: 'cancelCountdown', rid: this.nextRid() });
  }

  setReady(ready: boolean): void {
    this.send({ t: 'setReady', ready });
  }

  vote(choice: MapVoteOption | null): void {
    this.send({ t: 'vote', choice });
  }

  kick(memberId: MemberId): void {
    this.send({ t: 'kick', memberId, rid: this.nextRid() });
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
      ads: false,
      jump: false,
      reload: false,
      interact: false,
      useHeal: false,
      selectSlot: -1,
      stanceToggle: null,
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
