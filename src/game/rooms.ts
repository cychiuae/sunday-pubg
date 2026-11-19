/**
 * Rooms view model (ADR 0006 §7, UI.md §12.10, rooms.md). Owner: game-developer.
 *
 * Turns the lobby messages NetClient hands over (hello reply, room list, joined, room state, left, reject) into
 * `HudView.rooms` every frame and the room GameEvents (discrete moments), and forwards the Ui's room intents to
 * INetClient. Every intent is ignored when it is not valid in the current state; create and join issued before the
 * hello reply (a `?room=` deep link right after name entry) are held and sent once the server has replied.
 * The server validates everything again (host-only, phases, rate limits).
 */
import type { Balance } from '../shared/balance';
import type {
  INetClient,
  MapVoteView,
  RoomJoinTarget,
  RoomListEntryView,
  RoomMemberView,
  RoomsView,
  RoomSettingsInput,
  RoomView,
  ServerHello,
} from '../shared/contracts';
import type { GameEvents } from '../shared/events';
import type { MapVoteOption, MemberId, RejectCode, RoomMember, RoomState, RoomSummary } from '../shared/types';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../shared/types';
import type { Bus } from './derived';

type Pending = RoomsView['pending'];
type JoinFail = GameEvents['roomJoinFailed']['reason'];
type CreateFail = GameEvents['roomCreateFailed']['reason'];

/** Lobby room methods of INetClient (optional until the C-gate). */
type RoomNet = Pick<
  INetClient,
  'listRooms' | 'createRoom' | 'joinRoom' | 'leaveRoom' | 'setRoomSettings' | 'startMatch' | 'cancelCountdown' | 'setReady' | 'vote' | 'kick'
>;

const JOIN_FAIL: Partial<Record<RejectCode, JoinFail>> = {
  room_not_found: 'notFound',
  room_full: 'full',
  bad_code: 'badCode',
  kicked: 'kicked',
  rate_limited: 'rateLimited',
  bad_state: 'closed',
};
const CREATE_FAIL: Partial<Record<RejectCode, CreateFail>> = {
  max_rooms: 'roomLimit',
  rate_limited: 'rateLimited',
  bad_settings: 'badSettings',
  server_busy: 'busy',
};

/** Whole seconds until `at` (ceil, >= 0). */
const secondsUntil = (at: number, now: number): number => Math.max(0, Math.ceil((at - now) / 1000));

/**
 * Renders a null room name (ADR 0006 Q5) from the host's name. src/game may not import the string table (§3), so
 * main.ts injects `(name) => t('room.create.nameDefault', { name })` (ClientGameOptions.defaultRoomName). Without it
 * the host's own name is shown (never hard-coded English).
 */
export type DefaultRoomName = (hostName: string) => string;
export const hostNameOnly: DefaultRoomName = (hostName) => hostName;

/** Display name of a room: the server's sanitised name, or the default template with the host's name. */
export function roomDisplayName(name: string | null, hostName: string, fmt: DefaultRoomName = hostNameOnly): string {
  return name !== null ? name : fmt(hostName);
}

/** Humans oldest first (joinedAt, ties by memberId): the host-migration order (ADR 0006 §4). */
export const membersByAge = (members: readonly RoomMember[]): RoomMember[] =>
  [...members].sort((a, b) => a.joinedAt - b.joinedAt || a.memberId - b.memberId);

export class RoomsModel {
  private location: RoomsView['location'] = 'none';
  private hello: ServerHello | null = null;
  private list: RoomSummary[] | null = null;
  private room: RoomState | null = null;
  private memberId: MemberId | null = null;
  private pending: Pending = null;
  private canCreate = true;
  private joinCode: string | null = null;
  /** Create/join issued before the hello reply. */
  private deferred: (() => void)[] = [];

  constructor(
    private readonly net: RoomNet,
    private readonly bus: Bus,
    private readonly defaultName: DefaultRoomName = hostNameOnly,
  ) {}

  get localMemberId(): MemberId | null {
    return this.memberId;
  }

  get state(): RoomState | null {
    return this.room;
  }

  get where(): RoomsView['location'] {
    return this.location;
  }

  /** New connection (or a disconnect): back to 'none'. */
  reset(): void {
    this.location = 'none';
    this.hello = null;
    this.list = null;
    this.room = null;
    this.memberId = null;
    this.pending = null;
    this.canCreate = true;
    this.joinCode = null;
    this.deferred = [];
  }

  // ---- net handlers (called from ClientGame.drainQueue, in order) ----

  onHello(hello: ServerHello): void {
    this.hello = hello;
    if (this.location === 'none') {
      this.location = 'browser';
      this.net.listRooms?.(true);
    }
    const run = this.deferred;
    this.deferred = [];
    for (const fn of run) fn();
  }

  onRoomList(rooms: RoomSummary[]): void {
    this.list = rooms;
  }

  onRoomJoined(room: RoomState, memberId: MemberId): void {
    this.location = 'room';
    this.room = room;
    this.memberId = memberId;
    this.pending = null;
    this.joinCode = null;
    const me = room.members.find((m) => m.memberId === memberId);
    this.bus.emit('roomJoined', { roomId: room.id, code: room.code, asHost: room.hostId === memberId, spectating: me?.status === 'spectating' });
  }

  onRoom(room: RoomState): void {
    const prev = this.room;
    if (!prev || prev.id !== room.id) {
      this.room = room;
      return;
    }
    this.room = room;
    const local = this.memberId;
    if (room.hostId !== prev.hostId) {
      this.bus.emit('roomHostChanged', { hostId: room.hostId, hostName: room.hostName, isLocal: room.hostId === local });
    }
    const before = new Map(prev.members.map((m) => [m.memberId, m]));
    const now = new Map(room.members.map((m) => [m.memberId, m]));
    for (const m of membersByAge(room.members)) {
      if (!before.has(m.memberId) && m.memberId !== local) {
        this.bus.emit('roomMemberChanged', { memberId: m.memberId, name: m.name, change: 'joined' });
      }
    }
    for (const m of membersByAge(prev.members)) {
      if (!now.has(m.memberId) && m.memberId !== local) {
        this.bus.emit('roomMemberChanged', { memberId: m.memberId, name: m.name, change: 'left' });
      }
    }
    if (!sameSettings(prev.settings, room.settings)) {
      if (room.hostId !== local) this.bus.emit('roomSettingsChanged', { byHost: true });
      if (this.pending === 'settings') this.pending = null;
    }
    if (room.map && (!prev.map || prev.map.id !== room.map.id || prev.matchId !== room.matchId)) {
      this.bus.emit('mapVoteLocked', { mapId: room.map.id, via: room.map.via });
    }
    if (room.phase !== prev.phase && (this.pending === 'start' || this.pending === 'cancel')) this.pending = null;
  }

  onRoomLeft(reason: GameEvents['roomLeft']['reason']): void {
    const wasInRoom = this.location === 'room';
    this.room = null;
    this.memberId = null;
    this.pending = null;
    if (this.hello) {
      this.location = 'browser';
      this.list = null;
      this.net.listRooms?.(true);
    } else {
      this.location = 'none';
    }
    if (wasInRoom) this.bus.emit('roomLeft', { reason });
  }

  onReject(req: string, code: RejectCode): void {
    if (req === 'createRoom') {
      if (code === 'max_rooms') this.canCreate = false;
      this.bus.emit('roomCreateFailed', { reason: CREATE_FAIL[code] ?? 'badSettings' });
    } else if (req === 'joinRoom') {
      this.bus.emit('roomJoinFailed', { reason: JOIN_FAIL[code] ?? 'notFound', code: this.joinCode });
      this.joinCode = null;
    }
    this.pending = null;
  }

  // ---- intents (UiCallbacks -> IClientGame -> here) ----

  refreshRooms(): void {
    if (this.location === 'browser') this.net.listRooms?.(true);
  }

  createRoom(settings: RoomSettingsInput): void {
    if (this.location === 'none') {
      this.deferred.push(() => this.createRoom(settings));
      return;
    }
    if (this.location !== 'browser' || this.pending !== null) return;
    this.pending = 'create';
    this.net.createRoom?.(settings);
  }

  joinRoom(target: RoomJoinTarget): void {
    if (this.location === 'none') {
      this.deferred.push(() => this.joinRoom(target));
      return;
    }
    if (this.location !== 'browser' || this.pending !== null) return;
    this.pending = 'join';
    this.joinCode = 'code' in target ? target.code : null;
    this.net.joinRoom?.(target);
  }

  leaveRoom(): void {
    if (this.location !== 'room' || this.pending === 'leave') return;
    this.pending = 'leave';
    this.net.leaveRoom?.();
  }

  setRoomSettings(patch: Partial<RoomSettingsInput>): void {
    if (!this.isHost() || this.room?.phase !== 'waiting') return;
    this.pending = 'settings';
    this.net.setRoomSettings?.(patch);
  }

  startMatch(): void {
    if (!this.isHost() || this.room?.phase !== 'waiting') return;
    this.pending = 'start';
    this.net.startMatch?.();
  }

  cancelCountdown(now: number): void {
    if (!this.isHost() || !this.canCancelAt(now)) return;
    this.pending = 'cancel';
    this.net.cancelCountdown?.();
  }

  setReady(ready: boolean): void {
    if (this.location !== 'room' || this.room?.phase !== 'waiting' || this.isHost()) return;
    this.net.setReady?.(ready);
  }

  vote(option: MapVoteOption | null): void {
    const r = this.room;
    if (!r || r.settings.mapMode !== 'vote' || r.pinnedMap !== null || r.map !== null) return;
    this.net.vote?.(option);
  }

  kick(memberId: MemberId): void {
    if (!this.isHost() || memberId === this.memberId) return;
    if (!this.room?.members.some((m) => m.memberId === memberId)) return;
    this.net.kick?.(memberId);
  }

  // ---- view ----

  view(balance: Balance, now: number, mapLoading: boolean): RoomsView {
    if (this.location === 'browser' && this.hello) {
      const h = this.hello;
      return {
        location: 'browser',
        browser: {
          loaded: this.list !== null,
          rooms: (this.list ?? []).map((r) => listEntry(r, now, this.defaultName)),
          canCreate: this.canCreate,
          limits: {
            roomNameMax: h.limits.roomNameMax,
            maxHumansMin: h.limits.maxHumansMin,
            maxHumansMax: h.limits.maxHumansMax,
            maxHumansDefault: h.limits.maxHumansDefault,
            fillBotsDefault: h.limits.fillBotsDefault,
            maps: [...h.maps],
            codeLength: ROOM_CODE_LENGTH,
            codeAlphabet: ROOM_CODE_ALPHABET,
            pinnedMapId: h.pinnedMap,
          },
        },
        room: null,
        pending: this.pending,
      };
    }
    if (this.location === 'room' && this.room) {
      return { location: 'room', browser: null, room: this.roomView(this.room, balance, now, mapLoading), pending: this.pending };
    }
    return { location: 'none', browser: null, room: null, pending: this.pending };
  }

  private isHost(): boolean {
    return this.location === 'room' && this.room !== null && this.room.hostId === this.memberId;
  }

  private canCancelAt(now: number): boolean {
    const r = this.room;
    return r !== null && r.phase === 'countdown' && (r.lockAt === null || now < r.lockAt);
  }

  private roomView(r: RoomState, balance: Balance, now: number, mapLoading: boolean): RoomView {
    const local = this.memberId;
    const me = r.members.find((m) => m.memberId === local) ?? null;
    const isHost = r.hostId === local;
    const members: RoomMemberView[] = membersByAge(r.members).map((m) => ({
      id: m.memberId,
      name: m.name,
      isHost: m.memberId === r.hostId,
      isLocal: m.memberId === local,
      ready: m.ready,
      inMatch: m.status === 'playing',
      spectating: m.status === 'spectating',
    }));
    const rules = balance.rooms;
    const humans = r.members.length;
    const minHumans = rules ? (r.settings.fillBots ? rules.minHumansToStartWithBots : rules.minHumansToStartWithoutBots) : 1;
    const waitingHost = isHost && r.phase === 'waiting';
    const blocked = waitingHost && !r.settings.fillBots && humans < minHumans;
    let vote: MapVoteView | null = null;
    if (r.settings.mapMode === 'vote') {
      const tally = new Map((r.votes ?? []).map((v) => [v.option, v.count]));
      const options: MapVoteOption[] = [...(this.hello?.maps ?? []), 'random'];
      vote = {
        options: options.map((option) => ({ option, count: tally.get(option) ?? 0 })),
        mine: me?.vote ?? null,
        locked: r.map !== null || r.pinnedMap !== null,
        pinned: r.pinnedMap !== null,
      };
    }
    return {
      id: r.id,
      code: r.code,
      name: roomDisplayName(r.settings.name, r.hostName, this.defaultName),
      settings: { ...r.settings },
      phase: r.phase,
      hostId: r.hostId,
      isLocalHost: isHost,
      members,
      botSeats: r.botSeats,
      localReady: me?.ready ?? false,
      localSpectating: me?.status === 'spectating',
      canStart: waitingHost && humans >= minHumans,
      startBlockedReason: blocked ? 'needTwoWithoutBots' : null,
      canCancel: isHost && this.canCancelAt(now),
      countdownSecondsLeft: r.phase === 'countdown' && r.countdownEndsAt !== null ? secondsUntil(r.countdownEndsAt, now) : null,
      autoStart: r.autoStart ? { reason: r.autoStart.reason, secondsLeft: secondsUntil(r.autoStart.at, now) } : null,
      vote,
      map: r.map ? { id: r.map.id, via: r.map.via } : null,
      mapLoading,
      // M2c (UI M2c §7.2): seed and look once the vote locked (map card look line).
      lockedLayout: r.map?.layout ? { seed: r.map.layout.seed, look: r.map.layout.look } : null,
    };
  }
}

function listEntry(r: RoomSummary, now: number, fmt: DefaultRoomName): RoomListEntryView {
  return {
    id: r.id,
    name: roomDisplayName(r.name, r.hostName, fmt),
    mapMode: r.mapMode,
    mapId: r.mapId,
    humans: r.humans,
    maxHumans: r.maxHumans,
    status: r.phase,
    elapsedSeconds: r.phase === 'playing' ? Math.max(0, Math.floor((now - r.phaseSince) / 1000)) : null,
  };
}

function sameSettings(a: RoomState['settings'], b: RoomState['settings']): boolean {
  return a.name === b.name && a.visibility === b.visibility && a.mapMode === b.mapMode && a.maxHumans === b.maxHumans && a.fillBots === b.fillBots;
}
