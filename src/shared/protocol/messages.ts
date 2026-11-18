/**
 * Wire protocol (JSON text frames, one message per frame). Owner: network-engineer.
 * Spec: docs/tech/ARCHITECTURE.md §5, docs/tech/NETCODE.md.
 *
 * Only imports types from src/shared (dependency rule §3). Semantic clamping that needs engine constants
 * (pitch limits, SIM_DT, name length, protocol version) happens in server/validate.ts; this module guarantees
 * SHAPE: right types, finite numbers, known enums, no extra fields carried through.
 *
 * `decode*` never throws: anything malformed returns null.
 */
import type { RoomSettingsInput, ServerHello } from '../contracts';
import type {
  ActionFailReason,
  AmmoId,
  ArmorTier,
  DeathCause,
  DropMovementFields,
  DropPhase,
  DropRoute,
  DropSimEvent,
  FailedAction,
  GlassSurface,
  GrenadeContactSurface,
  GrenadeState,
  GunId,
  HealId,
  HeldId,
  ImpactSurface,
  ItemId,
  LocalDropFields,
  LocalPlayerState,
  LootId,
  LootState,
  LootTier,
  MapVoteOption,
  MatchMapFields,
  MatchPhase,
  MatchState,
  MemberId,
  MovementState,
  PlayerAnim,
  PlayerDropFields,
  PlayerId,
  PlayerInput,
  PlayerState,
  RejectCode,
  RoomId,
  RoomMember,
  RoomPhase,
  RoomSettings,
  RoomState,
  RoomSummary,
  SimEvent,
  SimEventType,
  SlotIndex,
  Stance,
  StanceRequest,
  WeaponId,
  WelcomeInfo,
  WorldSnapshot,
  ZoneState,
} from '../types';

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------
/**
 * M1/M2a handshake. M2b (ADR 0006 §6): replaced by `hello`. The server still decodes it, only to answer
 * `error bad_version` so a stale cached client shows "please refresh" instead of hanging.
 */
export interface JoinMessage {
  t: 'join';
  name: string;
  protocolVersion: number;
  /** Optional capabilities (unknown ones are ignored). `delta1` = delta snapshots (protocol/delta.ts). */
  caps?: string[];
}
/** M2b handshake: the first frame of every session. Server replies `hello` (ServerHello) or a fatal `error`. */
export interface HelloMessage {
  t: 'hello';
  name: string;
  protocolVersion: number;
  /**
   * Per-browser random token (CLIENT_TOKEN_STORAGE_KEY); keys only the kick rejoin cooldown (ADR 0006 §5). The
   * decoder keeps any short string; the server treats one that is not 16-64 `[A-Za-z0-9_-]` as absent.
   */
  clientToken?: string;
  caps?: string[];
}
export interface InputMessage { t: 'input'; input: PlayerInput }
export interface PingMessage { t: 'ping'; clientTime: number }
/** Delta clients only: "I could not apply a snapshot; send the next one in full." */
export interface ResyncMessage { t: 'resync' }

/**
 * M2b lobby requests (NETCODE.md "Rooms"). Every one may carry `rid` (a safe integer 0..2^31), echoed in the
 * matching `reject` (and in `roomJoined`). Settings are partial on the wire: `createRoom` fills the rest from the
 * `rooms` balance defaults; semantic checks (map ids, ranges, name length) are the server's (`reject bad_settings`).
 */
export interface ListRoomsMessage { t: 'listRooms'; subscribe: boolean; rid?: number }
export interface CreateRoomMessage { t: 'createRoom'; settings: Partial<RoomSettingsInput>; rid?: number }
export type JoinRoomMessage =
  | { t: 'joinRoom'; roomId: RoomId; rid?: number }
  | { t: 'joinRoom'; code: string; rid?: number };
export interface LeaveRoomMessage { t: 'leaveRoom'; rid?: number }
export interface SetRoomSettingsMessage { t: 'setRoomSettings'; settings: Partial<RoomSettingsInput>; rid?: number }
export interface StartMatchMessage { t: 'startMatch'; rid?: number }
export interface CancelCountdownMessage { t: 'cancelCountdown'; rid?: number }
export interface SetReadyMessage { t: 'setReady'; ready: boolean; rid?: number }
/** `choice: null` withdraws the vote. */
export interface VoteMessage { t: 'vote'; choice: MapVoteOption | null; rid?: number }
export interface KickMessage { t: 'kick'; memberId: MemberId; rid?: number }
export type LobbyRequest =
  | ListRoomsMessage | CreateRoomMessage | JoinRoomMessage | LeaveRoomMessage | SetRoomSettingsMessage
  | StartMatchMessage | CancelCountdownMessage | SetReadyMessage | VoteMessage | KickMessage;
export type LobbyRequestType = LobbyRequest['t'];
export const LOBBY_REQUEST_TYPES = Object.keys({
  listRooms: 1, createRoom: 1, joinRoom: 1, leaveRoom: 1, setRoomSettings: 1, startMatch: 1, cancelCountdown: 1,
  setReady: 1, vote: 1, kick: 1,
} satisfies Record<LobbyRequestType, 1>) as readonly LobbyRequestType[];

export type ClientMessage =
  | JoinMessage | HelloMessage | InputMessage | PingMessage | ResyncMessage | LobbyRequest;

/** A player in a delta snapshot: `id` plus the fields that changed since the base (nested objects are whole). */
export type PlayerPatch = { id: PlayerId } & Partial<Omit<PlayerState, 'id'>>;
/** Loot changes from version `from` to the snapshot's `lootVersion`. `add` also replaces an entry in place. */
export interface LootDelta { from: number; add: LootState[]; remove: LootId[]; qty: [LootId, number][] }

/**
 * Snapshot on the wire (NETCODE.md "Snapshot deltas"):
 * - `base` absent: `players` are complete PlayerStates. Present (delta clients): each entry is a PlayerPatch against
 *   the snapshot of tick `base`; a complete entry replaces. Membership is always complete (absent = gone).
 * - Loot: `loot` (full list), `lootDelta` (delta clients), or neither (unchanged since the recipient's version).
 */
/**
 * M2b wire compaction (NETCODE.md "M2b snapshot fields"):
 * - in a snapshot without `base` (full format), players' `aboard: false` and `dropPhase: null` are omitted and the
 *   decoder restores them (`DROP_DEFAULTS`); patches always carry the keys they change;
 * - in a delta snapshot, `match.route` is omitted while it equals the route of the base snapshot (it is fixed for a
 *   World), and the delta decoder carries it forward.
 */
export type WireMatch = Omit<MatchState, 'route'> & { route?: DropRoute | null };
export type WireSnapshot = Omit<WorldSnapshot, 'loot' | 'players' | 'match'> & {
  match: WireMatch;
  base?: number;
  players: (PlayerState | PlayerPatch)[];
  loot?: LootState[];
  lootDelta?: LootDelta;
};
export type ErrorCode = 'bad_version' | 'bad_name' | 'full' | 'bad_message';
export const ERROR_CODES: readonly ErrorCode[] = ['bad_version', 'bad_name', 'full', 'bad_message'];

export interface WelcomeMessage { t: 'welcome'; welcome: WelcomeInfo }
export interface SnapshotMessage { t: 'snapshot'; snap: WireSnapshot }
export interface EventsMessage { t: 'events'; tick: number; serverTime: number; events: SimEvent[] }
export interface PongMessage { t: 'pong'; clientTime: number; serverTime: number }
export interface ErrorMessage { t: 'error'; code: ErrorCode; message?: string }

// M2b rooms (ADR 0006 §6, NETCODE.md "Rooms").
/** Reply to the client's `hello`. */
export interface ServerHelloMessage { t: 'hello'; hello: ServerHello }
/** Full public list at revision `rev` (on subscribe, and as the base for later deltas). */
export interface RoomListMessage { t: 'roomList'; rev: number; rooms: RoomSummary[] }
/** Changes from revision `from` to `rev` (`rev = from + 1`). A client at another revision re-subscribes. */
export interface RoomListDeltaMessage { t: 'roomListDelta'; from: number; rev: number; upsert: RoomSummary[]; remove: RoomId[] }
/** You are in the room (BROWSER -> ROOM). */
export interface RoomJoinedMessage { t: 'roomJoined'; rid?: number; room: RoomState; memberId: MemberId }
/** Room state changed (coalesced to <= 5/s per room). */
export interface RoomMessage { t: 'room'; room: RoomState }
export type RoomLeftReason = 'left' | 'kicked' | 'closed';
export interface RoomLeftMessage { t: 'roomLeft'; reason: RoomLeftReason }
/** Non-fatal refusal of a lobby request; the socket stays open. `req` is the request's `t`. */
export interface RejectMessage { t: 'reject'; rid?: number; req: string; code: RejectCode; retryAfterMs?: number }

export type ServerMessage =
  | WelcomeMessage | SnapshotMessage | EventsMessage | PongMessage | ErrorMessage
  | ServerHelloMessage | RoomListMessage | RoomListDeltaMessage | RoomJoinedMessage | RoomMessage | RoomLeftMessage
  | RejectMessage;

/** Client frames larger than this (UTF-16 length, a lower bound on bytes) are dropped by the server. */
export const MAX_CLIENT_FRAME_CHARS = 4096;
/** Hard cap the ws server enforces before our code sees the frame (closes the socket). */
export const MAX_CLIENT_FRAME_BYTES_HARD = 16 * 1024;
/** Sanity cap for server frames decoded on the client (a full 16-player snapshot with loot is ~10 KB). */
export const MAX_SERVER_FRAME_CHARS = 1024 * 1024;

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/** Wire precision for non-integer numbers in server frames: 1 mm, 0.001 rad (0.06 deg), 0.001 ms / HP. */
export const WIRE_DECIMALS = 3;
const QUANT = 10 ** WIRE_DECIMALS;

/**
 * M2a wire packing of `PlayerState.anim`: bit i = ANIM_BITS[i]. 10 booleans cost ~175 B of JSON per player; the
 * bitmask costs 1-4 B, which is what keeps a full 16-player snapshot with grenades under the 8 KB budget
 * (NETCODE.md "Bandwidth"). The order is part of the protocol: append only, and bump PROTOCOL_VERSION.
 * The `satisfies` makes a new PlayerAnim key a compile error here.
 */
export const ANIM_BITS = [
  'moving', 'sprinting', 'airborne', 'dropping', 'inWater', 'firing', 'reloading', 'healing', 'ads', 'cooking',
] as const satisfies readonly (keyof PlayerAnim)[];
type AnimBitsExhaustive = Exclude<keyof PlayerAnim, (typeof ANIM_BITS)[number]> extends never ? true : never;
const _animBitsExhaustive: AnimBitsExhaustive = true;
void _animBitsExhaustive;
const ANIM_MAX = 2 ** ANIM_BITS.length;

export function packAnim(a: PlayerAnim): number {
  let n = 0;
  for (let i = 0; i < ANIM_BITS.length; i++) if (a[ANIM_BITS[i] as keyof PlayerAnim]) n |= 1 << i;
  return n;
}
export function unpackAnim(n: number): PlayerAnim {
  const out = {} as Record<keyof PlayerAnim, boolean>;
  for (let i = 0; i < ANIM_BITS.length; i++) out[ANIM_BITS[i] as keyof PlayerAnim] = (n & (1 << i)) !== 0;
  return out;
}
const isAnimObject = (v: unknown): v is PlayerAnim =>
  typeof v === 'object' && v !== null && !Array.isArray(v) &&
  Object.keys(v).length === ANIM_BITS.length && ANIM_BITS.every((k) => typeof (v as Record<string, unknown>)[k] === 'boolean');

const quantize = (key: string, v: unknown): unknown => {
  if (typeof v === 'number') return !Number.isInteger(v) && Number.isFinite(v) ? Math.round(v * QUANT) / QUANT : v;
  if (key === 'anim' && isAnimObject(v)) return packAnim(v);
  return v;
};

/**
 * Server encoder: like `encode` but rounds non-integer numbers to WIRE_DECIMALS (about 40% smaller snapshots) and
 * packs every `anim` object into its bitmask (M2a). The rounding error is far below anything visible, and
 * reconciliation absorbs it (the server keeps full precision). Client inputs stay exact (`encode`) so prediction
 * and the server see the same aim. `decodeServerMessage` accepts `anim` in either form.
 */
export function encodeQuantized(msg: ServerMessage): string {
  if (msg.t === 'snapshot') {
    const snap = msg.snap;
    const stripPlayers = snap.base === undefined && snap.players.some(hasDropDefaults);
    const local = snap.local === null ? null : stripLocalDropDefaults(snap.local);
    if (stripPlayers || local !== snap.local) {
      msg = {
        ...msg,
        snap: { ...snap, players: stripPlayers ? snap.players.map(stripDropDefaults) : snap.players, local },
      };
    }
  }
  return JSON.stringify(msg, quantize);
}

/**
 * M2b: `local` (sent whole in every snapshot) omits `aboard: false`, `movement.dropPhase: null` and
 * `movement.dropMs: 0`; the decoder restores them.
 */
type LooseLocal = LocalPlayerState & Partial<LocalDropFields> & { movement: MovementState & Partial<DropMovementFields> };
function stripLocalDropDefaults(l: LocalPlayerState): LocalPlayerState {
  const o = l as LooseLocal;
  const m = o.movement;
  const mDefault = m.dropPhase === null && m.dropMs === 0;
  if (o.aboard !== false && !mDefault) return l;
  const { aboard, movement, ...rest } = o;
  const out: Record<string, unknown> = { ...rest };
  if (aboard !== false && aboard !== undefined) out.aboard = aboard;
  if (mDefault) {
    const { dropPhase: _p, dropMs: _ms, ...mv } = movement;
    out.movement = mv;
  } else out.movement = movement;
  return out as unknown as LocalPlayerState;
}
function fillLocalDropDefaults(l: unknown): unknown {
  if (!isObj(l) || !isObj(l.movement)) return l;
  const m = l.movement;
  if (l.aboard !== undefined && m.dropPhase !== undefined && m.dropMs !== undefined) return l;
  return {
    ...l,
    aboard: l.aboard ?? false,
    movement: { ...m, dropPhase: m.dropPhase === undefined ? null : m.dropPhase, dropMs: m.dropMs ?? 0 },
  };
}

/** M2b: PlayerState drop fields at their resting values; omitted from full-format players on the wire. */
export const DROP_DEFAULTS: Readonly<PlayerDropFields> = { aboard: false, dropPhase: null };
const hasDropDefaults = (p: object): boolean => {
  const o = p as Partial<PlayerDropFields>;
  return o.aboard === false || o.dropPhase === null;
};
function stripDropDefaults<T extends object>(p: T): T {
  const o = p as T & Partial<PlayerDropFields>;
  if (o.aboard !== false && o.dropPhase !== null) return p;
  const { aboard, dropPhase, ...rest } = o;
  const out: Partial<PlayerDropFields> & Record<string, unknown> = rest;
  if (aboard !== false && aboard !== undefined) out.aboard = aboard;
  if (dropPhase !== null && dropPhase !== undefined) out.dropPhase = dropPhase;
  return out as unknown as T;
}
/** Decoder side: a full-format player entry gets the omitted drop defaults back (before the shape check). */
// (local: see fillLocalDropDefaults)
function fillDropDefaults(p: unknown): unknown {
  if (!isObj(p) || (p.aboard !== undefined && p.dropPhase !== undefined)) return p;
  return { ...p, aboard: p.aboard ?? DROP_DEFAULTS.aboard, dropPhase: p.dropPhase === undefined ? DROP_DEFAULTS.dropPhase : p.dropPhase };
}

/**
 * Deep copy with the same rounding as `encodeQuantized` (and -0 -> 0, as JSON does), so the server's delta base
 * holds exactly the values the client decodes. Plain JSON data only.
 */
export function quantizeDeep<T>(v: T): T {
  if (typeof v === 'number') {
    if (v === 0) return 0 as T; // -0 serialises as 0
    if (Number.isInteger(v) || !Number.isFinite(v)) return v;
    const r = Math.round(v * QUANT) / QUANT;
    return (r === 0 ? 0 : r) as T;
  }
  if (Array.isArray(v)) return v.map(quantizeDeep) as T;
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = quantizeDeep(x);
    return out as T;
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => isStr(v) && (list as readonly string[]).includes(v);
/** Optional field (Contract revision 1 and later): absent is fine; present must pass `pred`. JSON has no undefined. */
const opt = (v: unknown, pred: (x: unknown) => boolean): boolean => v === undefined || pred(v);
/**
 * Enum list from a key set. The `satisfies Record<T, 1>` at each call site makes adding a value to the shared union
 * a compile error here until the decoder learns it (otherwise the new value would be filtered silently).
 */
const keysOf = <T extends string>(o: Record<T, 1>): readonly T[] => Object.keys(o) as T[];

// Enum lists. Every one is built with `keysOf(... satisfies Record<Union, 1>)`, so a value added to a shared union is
// a compile error here until the decoder learns it.
const WEAPONS = keysOf({
  fists: 1, pistol: 1, smg: 1, shotgun: 1, rifle: 1, lmg: 1, dmr: 1, sniper: 1,
} satisfies Record<WeaponId, 1>);
const GUNS = WEAPONS.filter((w): w is GunId => w !== 'fists');
/** M2a: what a player can hold (`PlayerState.weapon`, `weaponSwitch`, `kill.weapon`). */
const HELD = keysOf({
  fists: 1, pistol: 1, smg: 1, shotgun: 1, rifle: 1, lmg: 1, dmr: 1, sniper: 1, grenade: 1,
} satisfies Record<HeldId, 1>);
const AMMOS = keysOf({ ammo_light: 1, ammo_heavy: 1, ammo_shell: 1, ammo_sniper: 1 } satisfies Record<AmmoId, 1>);
const HEALS = keysOf({ bandage: 1, medkit: 1 } satisfies Record<HealId, 1>);
const ITEMS = keysOf({
  pistol: 1, smg: 1, shotgun: 1, rifle: 1, lmg: 1, dmr: 1, sniper: 1,
  ammo_light: 1, ammo_heavy: 1, ammo_shell: 1, ammo_sniper: 1,
  bandage: 1, medkit: 1,
  vest_1: 1, vest_2: 1, vest_3: 1, helmet_1: 1, helmet_2: 1, helmet_3: 1,
  grenade: 1,
} satisfies Record<ItemId, 1>);
const PHASES = keysOf({ lobby: 1, countdown: 1, playing: 1, results: 1 } satisfies Record<MatchPhase, 1>);
const CAUSES = keysOf({ weapon: 1, zone: 1, fall: 1, explosion: 1 } satisfies Record<DeathCause, 1>);
/**
 * M2b: 'glass' (ADR 0005 §2) is listed apart so these tables compile both before the C-gate (when the shared unions do
 * not have it yet) and after it (when they do); the Exclude keeps every other value exhaustive.
 */
const GLASS = keysOf({ glass: 1 } satisfies Record<GlassSurface, 1>);
const SURFACES: readonly string[] = [
  ...keysOf({ player: 1, terrain: 1, prop: 1, water: 1, none: 1 } satisfies Record<Exclude<ImpactSurface, GlassSurface>, 1>),
  ...GLASS,
];
const GRENADE_SURFACES: readonly string[] = [
  ...keysOf({ terrain: 1, prop: 1, water: 1, edge: 1 } satisfies Record<Exclude<GrenadeContactSurface, GlassSurface>, 1>),
  ...GLASS,
];
const DROP_PHASES = keysOf({ freefall: 1, chute: 1 } satisfies Record<DropPhase, 1>);
const ROOM_PHASE_LIST = keysOf({ waiting: 1, countdown: 1, playing: 1, results: 1 } satisfies Record<RoomPhase, 1>);
const REJECT_CODES = keysOf({
  room_not_found: 1, bad_code: 1, room_full: 1, max_rooms: 1, server_busy: 1, not_host: 1, bad_state: 1,
  bad_settings: 1, already_in_room: 1, not_in_room: 1, kicked: 1, rate_limited: 1, vote_closed: 1, too_few_humans: 1,
} satisfies Record<RejectCode, 1>);
const MAP_PICK_VIA = keysOf({ pinned: 1, fixed: 1, vote: 1, random: 1, rotation: 1 } satisfies Record<NonNullable<RoomState['map']>['via'], 1>);
const MEMBER_STATUS = keysOf({ waiting: 1, playing: 1, spectating: 1 } satisfies Record<RoomMember['status'], 1>);
const ROOM_LEFT_REASONS = keysOf({ left: 1, kicked: 1, closed: 1 } satisfies Record<RoomLeftReason, 1>);
const STANCE_LIST = keysOf({ stand: 1, crouch: 1, prone: 1 } satisfies Record<Stance, 1>);
const STANCE_REQUESTS = keysOf({ crouch: 1, prone: 1 } satisfies Record<StanceRequest, 1>);
/** M2a: 3 = grenade slot. */
const SLOTS = [0, 1, 2, 3] as const satisfies readonly SlotIndex[];
const TIERS = keysOf({ common: 1, rare: 1, epic: 1 } satisfies Record<LootTier, 1>);
const FAILED_ACTIONS = keysOf(
  { heal: 1, pickup: 1, reload: 1, fire: 1, swap: 1, stance: 1 } satisfies Record<FailedAction, 1>,
);
const FAIL_REASONS = keysOf(
  {
    noHeals: 1, fullHp: 1, inventoryFull: 1, betterArmor: 1, noAmmo: 1, noGrenades: 1, tooDeep: 1, noHeadroom: 1,
  } satisfies Record<ActionFailReason, 1>,
);
const ARMOR_TIERS = [1, 2, 3] as const satisfies readonly ArmorTier[];

const isVec3 = (v: unknown): boolean => isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.z);
const isVec2 = (v: unknown): boolean => isObj(v) && isNum(v.x) && isNum(v.z);

/**
 * C-GATE SWITCH (ADR 0005 §1, ARCHITECTURE §15.1). While false, the M2b snapshot and event fields (drop, route, map
 * id, welcome.roomId) are checked when present and may be absent, so an M2a-shaped World still decodes. Flip it to
 * true together with PROTOCOL_VERSION 3 (messages.test.ts pins `M2B_FIELDS_REQUIRED === (PROTOCOL_VERSION >= 3)`);
 * from then on every one of them is required, exactly like the merged types.
 */
export const M2B_FIELDS_REQUIRED: boolean = true;
const gated = (pred: (x: unknown) => boolean) => (v: unknown): boolean => (M2B_FIELDS_REQUIRED ? pred(v) : opt(v, pred));
const isDropPhaseOrNull = (v: unknown): boolean => v === null || oneOf(v, DROP_PHASES);

/** M2b `MatchState.route` (drop.md): finite numbers and startsAt <= noJumpUntil <= ejectAt <= endsAt. */
export const isDropRoute = (v: unknown): v is DropRoute =>
  isObj(v) &&
  isStr(v.mapId) &&
  isVec2(v.entry) &&
  isVec2(v.exit) &&
  isVec2(v.eject) &&
  isNum(v.altitude) &&
  isNum(v.speed) &&
  isNum(v.startsAt) &&
  isNum(v.noJumpUntil) &&
  isNum(v.ejectAt) &&
  isNum(v.endsAt) &&
  v.startsAt <= v.noJumpUntil &&
  v.noJumpUntil <= v.ejectAt &&
  v.ejectAt <= v.endsAt;
const isSlot = (v: unknown): v is SlotIndex => (SLOTS as readonly unknown[]).includes(v);
const isArmorTier = (v: unknown): v is ArmorTier => (ARMOR_TIERS as readonly unknown[]).includes(v);
/** 0 = none, else 1..3 (`PlayerState.vestTier` / `helmetTier`). */
const isTierOrNone = (v: unknown): boolean => v === 0 || isArmorTier(v);
const isStance = (v: unknown): v is Stance => oneOf(v, STANCE_LIST);
const isNonNeg = (v: unknown): boolean => isNum(v) && v >= 0;
const isPos = (v: unknown): boolean => isNum(v) && v > 0;
const isUnit = (v: unknown): boolean => isNum(v) && v >= 0 && v <= 1;
const allOf = (v: unknown, pred: (x: unknown) => boolean): boolean => Array.isArray(v) && v.every(pred);

/** Accepts a JSON string (size-capped), or an already-parsed value. Returns undefined on failure. */
function parse(raw: unknown, maxChars: number): unknown {
  if (typeof raw !== 'string') return raw;
  if (raw.length > maxChars) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Client -> server (strict: this is the untrusted edge)
// ---------------------------------------------------------------------------------------------
const INPUT_BOOLS = ['sprint', 'fire', 'jump', 'reload', 'interact', 'useHeal'] as const;
const INPUT_NUMS = ['dt', 'moveForward', 'moveRight', 'yaw', 'pitch'] as const;

/**
 * M2a `stanceToggle`: absent -> null; null, 'crouch' or 'prone' pass; anything else is a bad frame (undefined here).
 * Exported so server/validate.ts applies the identical rule as defence in depth.
 */
export function decodeStanceToggle(v: unknown): StanceRequest | null | undefined {
  if (v === undefined || v === null) return null;
  return oneOf(v, STANCE_REQUESTS) ? v : undefined;
}

/**
 * Shape-checks a PlayerInput and returns a fresh object holding only known fields.
 * M2a (ADR 0004 §8): `ads` is coerced to a boolean (only `true` counts; absent or anything else = false) because a
 * wrong held bit is harmless; a bad `stanceToggle` or `selectSlot` (outside {-1, 0, 1, 2, 3}) rejects the frame.
 */
export function decodePlayerInput(v: unknown): PlayerInput | null {
  if (!isObj(v)) return null;
  if (!isInt(v.seq) || v.seq < 1) return null;
  for (const k of INPUT_NUMS) if (!isNum(v[k])) return null;
  for (const k of INPUT_BOOLS) if (!isBool(v[k])) return null;
  const sel = v.selectSlot;
  if (sel !== -1 && !isSlot(sel)) return null;
  const stanceToggle = decodeStanceToggle(v.stanceToggle);
  if (stanceToggle === undefined) return null;
  return {
    seq: v.seq,
    dt: v.dt as number,
    moveForward: v.moveForward as number,
    moveRight: v.moveRight as number,
    yaw: v.yaw as number,
    pitch: v.pitch as number,
    sprint: v.sprint === true,
    fire: v.fire === true,
    ads: v.ads === true,
    jump: v.jump === true,
    reload: v.reload === true,
    interact: v.interact === true,
    useHeal: v.useHeal === true,
    selectSlot: sel as SlotIndex | -1,
    stanceToggle,
  };
}

/** Join capability list limits. */
const MAX_CAPS = 8;
const MAX_CAP_CHARS = 16;
/** Max raw name length accepted at decode (before sanitising); the server enforces MAX_NAME_LENGTH after. */
const MAX_RAW_NAME_CHARS = 64;

/** Raw string caps for lobby fields (shape only; the server applies the real rules). */
const MAX_RAW_ROOM_NAME_CHARS = 96;
const MAX_ID_CHARS = 32;
const MAX_TOKEN_CHARS = 128;
/** `rid` range: a safe integer 0..2^31. */
const MAX_RID = 2 ** 31;

const isShortStr = (v: unknown, max: number): v is string => isStr(v) && v.length <= max;
const isCapList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= MAX_CAPS && v.every((c) => isShortStr(c, MAX_CAP_CHARS));

/** `rid` absent -> {}; valid -> { rid }; anything else -> null (bad frame). */
function decodeRid(v: unknown): { rid?: number } | null {
  if (v === undefined) return {};
  return isInt(v) && v >= 0 && v <= MAX_RID ? { rid: v } : null;
}

/**
 * Partial room settings: every key optional, each present one must have the right primitive shape. Unknown keys
 * are dropped. `name` may be null (= the default name).
 */
function decodeSettingsPatch(v: unknown): Partial<RoomSettingsInput> | null {
  if (!isObj(v)) return null;
  const out: Partial<RoomSettingsInput> = {};
  if (v.name !== undefined) {
    if (v.name !== null && !isShortStr(v.name, MAX_RAW_ROOM_NAME_CHARS)) return null;
    out.name = v.name;
  }
  if (v.visibility !== undefined) {
    if (v.visibility !== 'public' && v.visibility !== 'private') return null;
    out.visibility = v.visibility;
  }
  if (v.mapMode !== undefined) {
    if (!isShortStr(v.mapMode, MAX_ID_CHARS)) return null;
    out.mapMode = v.mapMode;
  }
  if (v.maxHumans !== undefined) {
    if (!isInt(v.maxHumans)) return null;
    out.maxHumans = v.maxHumans;
  }
  if (v.fillBots !== undefined) {
    if (!isBool(v.fillBots)) return null;
    out.fillBots = v.fillBots;
  }
  return out;
}

function decodeLobbyRequest(m: Obj): LobbyRequest | null {
  const r = decodeRid(m.rid);
  if (!r) return null;
  switch (m.t) {
    case 'listRooms':
      return isBool(m.subscribe) ? { t: 'listRooms', subscribe: m.subscribe, ...r } : null;
    case 'createRoom': {
      const settings = decodeSettingsPatch(m.settings ?? {});
      return settings ? { t: 'createRoom', settings, ...r } : null;
    }
    case 'setRoomSettings': {
      const settings = decodeSettingsPatch(m.settings);
      return settings ? { t: 'setRoomSettings', settings, ...r } : null;
    }
    case 'joinRoom': {
      // Exactly one of roomId | code.
      const hasId = m.roomId !== undefined;
      const hasCode = m.code !== undefined;
      if (hasId === hasCode) return null;
      if (hasId) return isShortStr(m.roomId, MAX_ID_CHARS) ? { t: 'joinRoom', roomId: m.roomId, ...r } : null;
      return isShortStr(m.code, MAX_ID_CHARS) ? { t: 'joinRoom', code: m.code, ...r } : null;
    }
    case 'leaveRoom':
      return { t: 'leaveRoom', ...r };
    case 'startMatch':
      return { t: 'startMatch', ...r };
    case 'cancelCountdown':
      return { t: 'cancelCountdown', ...r };
    case 'setReady':
      return isBool(m.ready) ? { t: 'setReady', ready: m.ready, ...r } : null;
    case 'vote':
      return m.choice === null || isShortStr(m.choice, MAX_ID_CHARS) ? { t: 'vote', choice: m.choice, ...r } : null;
    case 'kick':
      return isInt(m.memberId) ? { t: 'kick', memberId: m.memberId, ...r } : null;
    default:
      return null;
  }
}

export function decodeClientMessage(raw: unknown): ClientMessage | null {
  try {
    const m = parse(raw, MAX_CLIENT_FRAME_CHARS);
    if (!isObj(m)) return null;
    switch (m.t) {
      case 'join': {
        if (!isStr(m.name) || m.name.length > MAX_RAW_NAME_CHARS || !isInt(m.protocolVersion)) return null;
        if (m.caps === undefined) return { t: 'join', name: m.name, protocolVersion: m.protocolVersion };
        const caps = m.caps;
        if (!isCapList(caps)) return null;
        return { t: 'join', name: m.name, protocolVersion: m.protocolVersion, caps: [...caps] };
      }
      case 'hello': {
        if (!isShortStr(m.name, MAX_RAW_NAME_CHARS) || !isInt(m.protocolVersion)) return null;
        if (m.caps !== undefined && !isCapList(m.caps)) return null;
        const out: HelloMessage = { t: 'hello', name: m.name, protocolVersion: m.protocolVersion };
        // A malformed token is not a bad frame: the server treats the session as anonymous (ADR 0006 §5).
        if (isShortStr(m.clientToken, MAX_TOKEN_CHARS)) out.clientToken = m.clientToken;
        if (m.caps !== undefined) out.caps = [...m.caps];
        return out;
      }
      case 'resync':
        return { t: 'resync' };
      case 'input': {
        const input = decodePlayerInput(m.input);
        return input ? { t: 'input', input } : null;
      }
      case 'ping':
        return isNum(m.clientTime) ? { t: 'ping', clientTime: m.clientTime } : null;
      default:
        return decodeLobbyRequest(m);
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Server -> client (the server is trusted, but a bad frame must not crash the client)
// ---------------------------------------------------------------------------------------------
const ANIM_KEYS = keysOf({
  moving: 1, sprinting: 1, airborne: 1, dropping: 1, inWater: 1, firing: 1, reloading: 1, healing: 1, ads: 1, cooking: 1,
} satisfies Record<keyof PlayerAnim, 1>);
const isAnim = (v: unknown): boolean => isObj(v) && ANIM_KEYS.every((k) => isBool(v[k]));

/** M2b drop fields (C-gate staged: see M2B_FIELDS_REQUIRED). Spread into the per-type tables below. */
const PLAYER_DROP_CHECKS: Record<keyof PlayerDropFields, (v: unknown) => boolean> = {
  aboard: gated(isBool),
  dropPhase: gated(isDropPhaseOrNull),
};
const MOVEMENT_DROP_CHECKS: Record<keyof DropMovementFields, (v: unknown) => boolean> = {
  dropPhase: gated(isDropPhaseOrNull),
  dropMs: gated(isNonNeg),
};
const LOCAL_DROP_CHECKS: Record<keyof LocalDropFields, (v: unknown) => boolean> = {
  aboard: gated(isBool),
};
const MATCH_MAP_CHECKS: Record<keyof MatchMapFields, (v: unknown) => boolean> = {
  mapId: gated(isStr),
  route: gated((r) => r === null || isDropRoute(r)),
  aboardCount: gated((n) => isInt(n) && n >= 0),
};
const MATCH_MAP_KEYS = Object.keys(MATCH_MAP_CHECKS) as (keyof MatchMapFields)[];

/** One check per PlayerState field; keyed by the type so a new field needs a check (compile error otherwise). */
const PLAYER_FIELDS: Record<keyof PlayerState, (v: unknown) => boolean> = {
  id: isInt,
  name: isStr,
  pos: isVec3,
  velY: isNum,
  yaw: isNum,
  pitch: isNum,
  hp: isNum,
  vestTier: isTierOrNone,
  helmetTier: isTierOrNone,
  alive: isBool,
  weapon: (w) => oneOf(w, HELD),
  stance: isStance,
  stanceFrom: isStance,
  stanceProgress: isUnit,
  anim: isAnim,
  appearance: (a) => isObj(a) && isInt(a.skin) && isInt(a.outfit) && isInt(a.hair),
  isBot: isBool,
  kills: isInt,
  ...PLAYER_DROP_CHECKS,
};
const PLAYER_KEYS = Object.keys(PLAYER_FIELDS) as (keyof PlayerState)[];

export const isPlayerState = (v: unknown): v is PlayerState => isObj(v) && PLAYER_KEYS.every((k) => PLAYER_FIELDS[k](v[k]));
/** `id` plus any subset of valid PlayerState fields. */
export const isPlayerPatch = (v: unknown): v is PlayerPatch =>
  isObj(v) && isInt(v.id) && PLAYER_KEYS.every((k) => v[k] === undefined || PLAYER_FIELDS[k](v[k]));

/** M2a: `durability` (armor pickups only) is a number > 0 when present. */
export const isLoot = (v: unknown): v is LootState =>
  isObj(v) &&
  isInt(v.id) &&
  oneOf(v.item, ITEMS) &&
  isInt(v.qty) &&
  isVec3(v.pos) &&
  opt(v.tier, (t) => oneOf(t, TIERS)) &&
  opt(v.durability, isPos);

/** M2a (ADR 0004 §3): a live grenade. */
export const isGrenade = (v: unknown): v is GrenadeState =>
  isObj(v) && isInt(v.id) && isInt(v.ownerId) && isVec3(v.pos) && isVec3(v.vel) && isNum(v.explodesAt) && isBool(v.inWater);

const isMatch = (v: unknown, routeMayBeOmitted = false): v is MatchState =>
  isObj(v) &&
  isInt(v.matchId) &&
  oneOf(v.phase, PHASES) &&
  isNumOrNull(v.phaseEndsAt) &&
  isInt(v.lobbyCount) &&
  isInt(v.targetPlayers) &&
  isInt(v.aliveCount) &&
  isInt(v.totalPlayers) &&
  (v.winnerId === null || isInt(v.winnerId)) &&
  (v.winnerName === null || isStr(v.winnerName)) &&
  MATCH_MAP_KEYS.every((k) => (k === 'route' && routeMayBeOmitted && v[k] === undefined) || MATCH_MAP_CHECKS[k](v[k]));

const isZone = (v: unknown): v is ZoneState =>
  isObj(v) &&
  isInt(v.phaseIndex) &&
  isInt(v.phaseCount) &&
  isVec2(v.center) &&
  isNum(v.radius) &&
  isVec2(v.targetCenter) &&
  isNum(v.targetRadius) &&
  isNum(v.phaseEndsAt) &&
  isBool(v.shrinking) &&
  isNum(v.dps);

const isCountRecord = (v: unknown, keys: readonly string[]): boolean => isObj(v) && keys.every((k) => isNum(v[k]));
const isWeaponSlot = (v: unknown): boolean => v === null || (isObj(v) && oneOf(v.weapon, GUNS) && isInt(v.mag));
/** M2a: a worn piece, `null` or `{ tier 1-3, durability > 0 }`. */
const isArmorPiece = (v: unknown): boolean => v === null || (isObj(v) && isArmorTier(v.tier) && isPos(v.durability));

const MOVEMENT_FIELDS: Record<keyof MovementState, (v: unknown) => boolean> = {
  pos: isVec3,
  vel: isVec3,
  grounded: isBool,
  dropping: isBool,
  stance: isStance,
  stanceFrom: isStance,
  stanceMs: isNonNeg,
  adsMs: isNonNeg,
  ...MOVEMENT_DROP_CHECKS,
};
const MOVEMENT_KEYS = Object.keys(MOVEMENT_FIELDS) as (keyof MovementState)[];
const isMovement = (v: unknown): boolean => isObj(v) && MOVEMENT_KEYS.every((k) => MOVEMENT_FIELDS[k](v[k]));

/** One check per LocalPlayerState field (keyed by the type, like PLAYER_FIELDS). */
const LOCAL_FIELDS: Record<keyof LocalPlayerState, (v: unknown) => boolean> = {
  id: isInt,
  lastProcessedInputSeq: isInt,
  movement: isMovement,
  slots: (s) => Array.isArray(s) && s.length === 2 && s.every(isWeaponSlot),
  activeSlot: isSlot,
  ammo: (a) => isCountRecord(a, AMMOS),
  heals: (h) => isCountRecord(h, HEALS),
  vest: isArmorPiece,
  helmet: isArmorPiece,
  grenades: (g) => isInt(g) && g >= 0,
  cookExplodesAt: isNumOrNull,
  throwRecoveryMs: isNonNeg,
  reloadRemainingMs: isNum,
  reloadTotalMs: isNum,
  healRemainingMs: isNum,
  healTotalMs: isNum,
  healItem: (h) => h === null || oneOf(h, HEALS),
  swapRemainingMs: isNum,
  ...LOCAL_DROP_CHECKS,
};
const LOCAL_KEYS = Object.keys(LOCAL_FIELDS) as (keyof LocalPlayerState)[];
const isLocal = (v: unknown): boolean => isObj(v) && LOCAL_KEYS.every((k) => LOCAL_FIELDS[k](v[k]));

const isQtyPair = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && isInt(v[0]) && isInt(v[1]);
const isLootDelta = (v: unknown): v is LootDelta =>
  isObj(v) && isInt(v.from) && allOf(v.add, isLoot) && allOf(v.remove, isInt) && allOf(v.qty, isQtyPair);

const isSnapshot = (v: unknown): v is WireSnapshot =>
  isObj(v) &&
  isInt(v.tick) &&
  isNum(v.serverTime) &&
  isMatch(v.match, v.base !== undefined) &&
  (v.zone === null || isZone(v.zone)) &&
  opt(v.base, isInt) &&
  allOf(v.players, v.base === undefined ? isPlayerState : isPlayerPatch) &&
  isInt(v.lootVersion) &&
  opt(v.loot, (l) => allOf(l, isLoot)) &&
  opt(v.lootDelta, isLootDelta) &&
  (v.loot === undefined || v.lootDelta === undefined) &&
  allOf(v.grenades, isGrenade) &&
  (v.local === null || isLocal(v.local));

const isImpact = (v: unknown): boolean =>
  isObj(v) && isVec3(v.point) && oneOf(v.surface, SURFACES) && (v.playerId === null || isInt(v.playerId)) && isBool(v.headshot);

const isStanding = (v: unknown): boolean =>
  isObj(v) && isInt(v.id) && isStr(v.name) && isBool(v.isBot) && isInt(v.kills) && isInt(v.placement);

const idOrNull = (v: unknown): boolean => v === null || isInt(v);
/** M2a `damage.vest` / `damage.helmet`: null or `{ tier 1-3, absorbed >= 0, broken }`. */
const isArmorHit = (v: unknown): boolean =>
  v === null || (isObj(v) && isArmorTier(v.tier) && isNonNeg(v.absorbed) && isBool(v.broken));

type EventCheck = (v: Obj) => boolean;
/** M2b drop events (public). Spread into EVENT_CHECKS so the table compiles before and after the C-gate. */
const DROP_EVENT_CHECKS: Record<DropSimEvent['type'], EventCheck> = {
  dropJump: (v) => isInt(v.playerId) && isVec3(v.pos) && isBool(v.auto),
  chuteOpen: (v) => isInt(v.playerId) && isVec3(v.pos) && isBool(v.manual),
};
/**
 * One validator per sim event type. Keyed by `SimEventType` so a new event type in the shared union is a compile
 * error here until it gets a validator; without one, `decodeServerMessage` would filter it out on every client.
 * Optional fields (kill.headshot, M2a damage.grenadeId and pickup.durability) are checked when present.
 */
const EVENT_CHECKS: Record<SimEventType, EventCheck> = {
  spawn: (v) => isInt(v.playerId) && isVec3(v.pos),
  shot: (v) => isInt(v.shooterId) && oneOf(v.weapon, WEAPONS) && isVec3(v.origin) && allOf(v.impacts, isImpact),
  damage: (v) =>
    isInt(v.victimId) && idOrNull(v.attackerId) && isNum(v.amount) && isBool(v.headshot) && oneOf(v.cause, CAUSES) &&
    isVec3(v.sourcePos) && isNum(v.hpAfter) && isArmorHit(v.vest) && isArmorHit(v.helmet) && opt(v.grenadeId, isInt),
  kill: (v) =>
    isInt(v.victimId) && idOrNull(v.killerId) && (v.weapon === null || oneOf(v.weapon, HELD)) &&
    oneOf(v.cause, CAUSES) && isInt(v.placement) && opt(v.headshot, isBool),
  pickup: (v) =>
    isInt(v.playerId) && isInt(v.lootId) && oneOf(v.item, ITEMS) && isInt(v.qty) && isVec3(v.pos) &&
    opt(v.durability, isNum),
  reloadStart: (v) => isInt(v.playerId) && oneOf(v.weapon, GUNS) && isNum(v.durationMs),
  reloadEnd: (v) => isInt(v.playerId) && oneOf(v.weapon, GUNS) && isBool(v.completed),
  healStart: (v) => isInt(v.playerId) && oneOf(v.item, HEALS) && isNum(v.durationMs),
  healEnd: (v) => isInt(v.playerId) && oneOf(v.item, HEALS) && isBool(v.completed) && isNum(v.hpAfter),
  weaponSwitch: (v) => isInt(v.playerId) && oneOf(v.weapon, HELD) && isSlot(v.slot),
  matchEnded: (v) => idOrNull(v.winnerId) && allOf(v.standings, isStanding),
  stanceChange: (v) =>
    isInt(v.playerId) && isStance(v.from) && isStance(v.to) && isBool(v.forced) && isNonNeg(v.durationMs),
  grenadeCook: (v) => isInt(v.playerId) && isVec3(v.pos) && isNum(v.explodesAt),
  grenadeThrown: (v) =>
    isInt(v.id) && isInt(v.ownerId) && isVec3(v.pos) && isVec3(v.vel) && isNum(v.explodesAt) && isBool(v.dropped),
  grenadeBounce: (v) => isInt(v.id) && isVec3(v.pos) && oneOf(v.surface, GRENADE_SURFACES) && isNonNeg(v.speed),
  explosion: (v) => isInt(v.id) && isInt(v.ownerId) && isVec3(v.pos) && isNonNeg(v.radius) && isBool(v.inHand),
  actionFailed: (v) => isInt(v.playerId) && oneOf(v.action, FAILED_ACTIONS) && oneOf(v.reason, FAIL_REASONS),
  ...DROP_EVENT_CHECKS,
};
const hasCheck = (t: unknown): t is keyof typeof EVENT_CHECKS => isStr(t) && Object.hasOwn(EVENT_CHECKS, t);

export function isSimEvent(v: unknown): v is SimEvent {
  return isObj(v) && hasCheck(v.type) && EVENT_CHECKS[v.type](v);
}

/**
 * Sim events that only their own player may receive (the server routes them; Contract revision 1 #5). Returns the
 * recipient, or null for public events. `actionFailed` would leak an opponent's empty mag or heal stock.
 */
export function privateEventRecipient(ev: SimEvent): PlayerId | null {
  return ev.type === 'actionFailed' ? ev.playerId : null;
}

/** Optional hooks for `decodeServerMessage` (diagnostics only; decoding never depends on them). */
export interface DecodeHooks {
  /** Called for each event filtered out of an `events` batch (unknown type or bad shape). */
  onDroppedEvent?: (ev: unknown) => void;
}

function filterEvents(raw: unknown[], hooks: DecodeHooks | undefined): SimEvent[] {
  const out: SimEvent[] = [];
  for (const ev of raw) {
    if (isSimEvent(ev)) out.push(ev);
    else if (hooks?.onDroppedEvent) {
      try {
        hooks.onDroppedEvent(ev);
      } catch {
        // diagnostics must never break decoding
      }
    }
  }
  return out;
}

/**
 * Copy of a raw wire snapshot whose integer `anim` fields (encodeQuantized's bitmask) are expanded to objects.
 * Anything else is left as is for the shape check (an out-of-range mask stays a number and fails it).
 */
function unpackPlayerAnims(snap: unknown): unknown {
  if (!isObj(snap) || !Array.isArray(snap.players)) return snap;
  // M2b: full-format players may omit the drop defaults. Before the C-gate only a World that fills the M2b match
  // fields (`mapId`) produces drop fields at all, so only then are they restored.
  const m2b = M2B_FIELDS_REQUIRED || (isObj(snap.match) && snap.match.mapId !== undefined);
  const fill = m2b && snap.base === undefined;
  const local = m2b ? fillLocalDropDefaults(snap.local) : snap.local;
  if (!fill && local === snap.local && !snap.players.some((p) => isObj(p) && typeof p.anim === 'number')) return snap;
  const players = snap.players.map((p: unknown) => {
    const q = fill ? fillDropDefaults(p) : p;
    return isObj(q) && isInt(q.anim) && q.anim >= 0 && q.anim < ANIM_MAX ? { ...q, anim: unpackAnim(q.anim) } : q;
  });
  return { ...snap, players, local };
}

const isWelcome = (v: unknown): v is WelcomeInfo =>
  isObj(v) && isInt(v.playerId) && isStr(v.mapId) && isNum(v.serverTime) && isInt(v.matchId) && gated(isStr)(v.roomId);

// M2b rooms -------------------------------------------------------------------------------------
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const isNonNegInt = (v: unknown): v is number => isInt(v) && v >= 0;

const isRoomSettings = (v: unknown): v is RoomSettings =>
  isObj(v) &&
  isStrOrNull(v.name) &&
  (v.visibility === 'public' || v.visibility === 'private') &&
  isStr(v.mapMode) &&
  isNonNegInt(v.maxHumans) &&
  isBool(v.fillBots);

export const isRoomSummary = (v: unknown): v is RoomSummary =>
  isObj(v) &&
  isStr(v.id) &&
  isStrOrNull(v.name) &&
  isStr(v.hostName) &&
  isStr(v.mapMode) &&
  isStrOrNull(v.mapId) &&
  isNonNegInt(v.humans) &&
  isNonNegInt(v.maxHumans) &&
  oneOf(v.phase, ROOM_PHASE_LIST) &&
  isNum(v.phaseSince);

const isRoomMember = (v: unknown): v is RoomMember =>
  isObj(v) &&
  isInt(v.memberId) &&
  isStr(v.name) &&
  isBool(v.ready) &&
  isStrOrNull(v.vote) &&
  oneOf(v.status, MEMBER_STATUS) &&
  isNum(v.joinedAt);

const isVoteTally = (v: unknown): boolean => isObj(v) && isStr(v.option) && isNonNegInt(v.count);

export const isRoomState = (v: unknown): v is RoomState =>
  isObj(v) &&
  isStr(v.id) &&
  isStr(v.code) &&
  isRoomSettings(v.settings) &&
  isInt(v.hostId) &&
  isStr(v.hostName) &&
  allOf(v.members, isRoomMember) &&
  oneOf(v.phase, ROOM_PHASE_LIST) &&
  isNum(v.phaseSince) &&
  isStrOrNull(v.pinnedMap) &&
  (v.map === null || (isObj(v.map) && isStr(v.map.id) && oneOf(v.map.via, MAP_PICK_VIA))) &&
  isNumOrNull(v.countdownEndsAt) &&
  isNumOrNull(v.lockAt) &&
  (v.autoStart === null ||
    (isObj(v.autoStart) && (v.autoStart.reason === 'allReady' || v.autoStart.reason === 'timer') && isNum(v.autoStart.at))) &&
  (v.votes === null || allOf(v.votes, isVoteTally)) &&
  isNonNegInt(v.botSeats) &&
  (v.matchId === null || isInt(v.matchId));

const isServerHello = (v: unknown): v is ServerHello =>
  isObj(v) &&
  isNum(v.serverTime) &&
  allOf(v.maps, isStr) &&
  isStrOrNull(v.pinnedMap) &&
  isObj(v.limits) &&
  isNonNegInt(v.limits.maxRooms) &&
  isNonNegInt(v.limits.roomNameMax) &&
  isNonNegInt(v.limits.maxHumansMin) &&
  isNonNegInt(v.limits.maxHumansMax) &&
  isNonNegInt(v.limits.maxHumansDefault) &&
  isBool(v.limits.fillBotsDefault);

const ridOf = (v: unknown): { rid?: number } => (isInt(v) ? { rid: v } : {});

export function decodeServerMessage(raw: unknown, hooks?: DecodeHooks): ServerMessage | null {
  try {
    const m = parse(raw, MAX_SERVER_FRAME_CHARS);
    if (!isObj(m)) return null;
    switch (m.t) {
      case 'welcome':
        return isWelcome(m.welcome) ? { t: 'welcome', welcome: m.welcome } : null;
      case 'snapshot': {
        const snap = unpackPlayerAnims(m.snap);
        return isSnapshot(snap) ? { t: 'snapshot', snap } : null;
      }
      case 'events':
        // Unknown event types (newer server) are filtered rather than failing the whole batch.
        if (!isInt(m.tick) || !isNum(m.serverTime) || !Array.isArray(m.events)) return null;
        return { t: 'events', tick: m.tick, serverTime: m.serverTime, events: filterEvents(m.events, hooks) };
      case 'pong':
        return isNum(m.clientTime) && isNum(m.serverTime)
          ? { t: 'pong', clientTime: m.clientTime, serverTime: m.serverTime }
          : null;
      case 'error':
        if (!oneOf(m.code, ERROR_CODES)) return null;
        return isStr(m.message) ? { t: 'error', code: m.code, message: m.message } : { t: 'error', code: m.code };
      case 'hello':
        return isServerHello(m.hello) ? { t: 'hello', hello: m.hello } : null;
      case 'roomList':
        return isNonNegInt(m.rev) && allOf(m.rooms, isRoomSummary) ? { t: 'roomList', rev: m.rev, rooms: m.rooms as RoomSummary[] } : null;
      case 'roomListDelta':
        return isNonNegInt(m.from) && isNonNegInt(m.rev) && allOf(m.upsert, isRoomSummary) && allOf(m.remove, isStr)
          ? { t: 'roomListDelta', from: m.from, rev: m.rev, upsert: m.upsert as RoomSummary[], remove: m.remove as RoomId[] }
          : null;
      case 'roomJoined':
        return isRoomState(m.room) && isInt(m.memberId)
          ? { t: 'roomJoined', ...ridOf(m.rid), room: m.room, memberId: m.memberId }
          : null;
      case 'room':
        return isRoomState(m.room) ? { t: 'room', room: m.room } : null;
      case 'roomLeft':
        return oneOf(m.reason, ROOM_LEFT_REASONS) ? { t: 'roomLeft', reason: m.reason } : null;
      case 'reject': {
        if (!isStr(m.req) || !oneOf(m.code, REJECT_CODES)) return null;
        const out: RejectMessage = { t: 'reject', ...ridOf(m.rid), req: m.req, code: m.code };
        if (isNonNeg(m.retryAfterMs)) out.retryAfterMs = m.retryAfterMs as number;
        return out;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
