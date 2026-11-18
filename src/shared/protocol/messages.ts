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
import type {
  ActionFailReason,
  FailedAction,
  LootId,
  LootState,
  LootTier,
  MatchState,
  PlayerId,
  PlayerInput,
  PlayerState,
  SimEvent,
  SimEventType,
  SlotIndex,
  WelcomeInfo,
  WorldSnapshot,
  ZoneState,
} from '../types';

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------
export interface JoinMessage {
  t: 'join';
  name: string;
  protocolVersion: number;
  /** Optional capabilities (unknown ones are ignored). `delta1` = delta snapshots (protocol/delta.ts). */
  caps?: string[];
}
export interface InputMessage { t: 'input'; input: PlayerInput }
export interface PingMessage { t: 'ping'; clientTime: number }
/** Delta clients only: "I could not apply a snapshot; send the next one in full." */
export interface ResyncMessage { t: 'resync' }
export type ClientMessage = JoinMessage | InputMessage | PingMessage | ResyncMessage;

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
export type WireSnapshot = Omit<WorldSnapshot, 'loot' | 'players'> & {
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
export type ServerMessage = WelcomeMessage | SnapshotMessage | EventsMessage | PongMessage | ErrorMessage;

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
const quantize = (_key: string, v: unknown): unknown =>
  typeof v === 'number' && !Number.isInteger(v) && Number.isFinite(v) ? Math.round(v * QUANT) / QUANT : v;

/**
 * Server encoder: like `encode` but rounds non-integer numbers to WIRE_DECIMALS (about 40% smaller snapshots).
 * The error is far below anything visible, and reconciliation absorbs it (the server keeps full precision).
 * Client inputs stay exact (`encode`) so prediction and the server see the same aim.
 */
export function encodeQuantized(msg: ServerMessage): string {
  return JSON.stringify(msg, quantize);
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

const WEAPONS = ['fists', 'pistol', 'smg', 'shotgun', 'rifle'] as const;
const GUNS = ['pistol', 'smg', 'shotgun', 'rifle'] as const;
const AMMOS = ['ammo_light', 'ammo_heavy', 'ammo_shell'] as const;
const HEALS = ['bandage', 'medkit'] as const;
const ITEMS = [...GUNS, ...AMMOS, ...HEALS, 'vest'] as const;
const PHASES = ['lobby', 'countdown', 'playing', 'results'] as const;
const CAUSES = ['weapon', 'zone', 'fall'] as const;
const SURFACES = ['player', 'terrain', 'prop', 'water', 'none'] as const;
const SLOTS = [0, 1, 2] as const;
const TIERS = keysOf({ common: 1, rare: 1, epic: 1 } satisfies Record<LootTier, 1>);
const FAILED_ACTIONS = keysOf({ heal: 1, pickup: 1, reload: 1, fire: 1 } satisfies Record<FailedAction, 1>);
const FAIL_REASONS = keysOf(
  { noHeals: 1, fullHp: 1, inventoryFull: 1, betterArmor: 1, noAmmo: 1 } satisfies Record<ActionFailReason, 1>,
);

const isVec3 = (v: unknown): boolean => isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.z);
const isVec2 = (v: unknown): boolean => isObj(v) && isNum(v.x) && isNum(v.z);
const isSlot = (v: unknown): v is SlotIndex => (SLOTS as readonly unknown[]).includes(v);
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

/** Shape-checks a PlayerInput and returns a fresh object holding only known fields. */
export function decodePlayerInput(v: unknown): PlayerInput | null {
  if (!isObj(v)) return null;
  if (!isInt(v.seq) || v.seq < 1) return null;
  for (const k of INPUT_NUMS) if (!isNum(v[k])) return null;
  for (const k of INPUT_BOOLS) if (!isBool(v[k])) return null;
  const sel = v.selectSlot;
  if (sel !== -1 && !isSlot(sel)) return null;
  return {
    seq: v.seq,
    dt: v.dt as number,
    moveForward: v.moveForward as number,
    moveRight: v.moveRight as number,
    yaw: v.yaw as number,
    pitch: v.pitch as number,
    sprint: v.sprint === true,
    fire: v.fire === true,
    jump: v.jump === true,
    reload: v.reload === true,
    interact: v.interact === true,
    useHeal: v.useHeal === true,
    selectSlot: sel as SlotIndex | -1,
  };
}

/** Join capability list limits. */
const MAX_CAPS = 8;
const MAX_CAP_CHARS = 16;
/** Max raw name length accepted at decode (before sanitising); the server enforces MAX_NAME_LENGTH after. */
const MAX_RAW_NAME_CHARS = 64;

export function decodeClientMessage(raw: unknown): ClientMessage | null {
  try {
    const m = parse(raw, MAX_CLIENT_FRAME_CHARS);
    if (!isObj(m)) return null;
    switch (m.t) {
      case 'join': {
        if (!isStr(m.name) || m.name.length > MAX_RAW_NAME_CHARS || !isInt(m.protocolVersion)) return null;
        if (m.caps === undefined) return { t: 'join', name: m.name, protocolVersion: m.protocolVersion };
        const caps = m.caps;
        if (!Array.isArray(caps) || caps.length > MAX_CAPS || !caps.every((c) => isStr(c) && c.length <= MAX_CAP_CHARS)) {
          return null;
        }
        return { t: 'join', name: m.name, protocolVersion: m.protocolVersion, caps: [...(caps as string[])] };
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
        return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Server -> client (the server is trusted, but a bad frame must not crash the client)
// ---------------------------------------------------------------------------------------------
const isAnim = (v: unknown): boolean =>
  isObj(v) &&
  ['moving', 'sprinting', 'airborne', 'dropping', 'inWater', 'firing', 'reloading', 'healing'].every((k) => isBool(v[k]));

/** One check per PlayerState field; keyed by the type so a new field needs a check (compile error otherwise). */
const PLAYER_FIELDS: Record<keyof PlayerState, (v: unknown) => boolean> = {
  id: isInt,
  name: isStr,
  pos: isVec3,
  velY: isNum,
  yaw: isNum,
  pitch: isNum,
  hp: isNum,
  armor: isNum,
  alive: isBool,
  weapon: (w) => oneOf(w, WEAPONS),
  anim: isAnim,
  appearance: (a) => isObj(a) && isInt(a.skin) && isInt(a.outfit) && isInt(a.hair),
  isBot: isBool,
  kills: isInt,
};
const PLAYER_KEYS = Object.keys(PLAYER_FIELDS) as (keyof PlayerState)[];

export const isPlayerState = (v: unknown): v is PlayerState => isObj(v) && PLAYER_KEYS.every((k) => PLAYER_FIELDS[k](v[k]));
/** `id` plus any subset of valid PlayerState fields. */
export const isPlayerPatch = (v: unknown): v is PlayerPatch =>
  isObj(v) && isInt(v.id) && PLAYER_KEYS.every((k) => v[k] === undefined || PLAYER_FIELDS[k](v[k]));

export const isLoot = (v: unknown): v is LootState =>
  isObj(v) && isInt(v.id) && oneOf(v.item, ITEMS) && isInt(v.qty) && isVec3(v.pos) && opt(v.tier, (t) => oneOf(t, TIERS));

const isMatch = (v: unknown): v is MatchState =>
  isObj(v) &&
  isInt(v.matchId) &&
  oneOf(v.phase, PHASES) &&
  isNumOrNull(v.phaseEndsAt) &&
  isInt(v.lobbyCount) &&
  isInt(v.targetPlayers) &&
  isInt(v.aliveCount) &&
  isInt(v.totalPlayers) &&
  (v.winnerId === null || isInt(v.winnerId)) &&
  (v.winnerName === null || isStr(v.winnerName));

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

const isLocal = (v: unknown): boolean =>
  isObj(v) &&
  isInt(v.id) &&
  isInt(v.lastProcessedInputSeq) &&
  isObj(v.movement) &&
  isVec3(v.movement.pos) &&
  isVec3(v.movement.vel) &&
  isBool(v.movement.grounded) &&
  isBool(v.movement.dropping) &&
  Array.isArray(v.slots) &&
  v.slots.length === 2 &&
  v.slots.every(isWeaponSlot) &&
  isSlot(v.activeSlot) &&
  isCountRecord(v.ammo, AMMOS) &&
  isCountRecord(v.heals, HEALS) &&
  isNum(v.reloadRemainingMs) &&
  isNum(v.reloadTotalMs) &&
  isNum(v.healRemainingMs) &&
  isNum(v.healTotalMs) &&
  (v.healItem === null || oneOf(v.healItem, HEALS)) &&
  isNum(v.swapRemainingMs);

const isQtyPair = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && isInt(v[0]) && isInt(v[1]);
const isLootDelta = (v: unknown): v is LootDelta =>
  isObj(v) && isInt(v.from) && allOf(v.add, isLoot) && allOf(v.remove, isInt) && allOf(v.qty, isQtyPair);

const isSnapshot = (v: unknown): v is WireSnapshot =>
  isObj(v) &&
  isInt(v.tick) &&
  isNum(v.serverTime) &&
  isMatch(v.match) &&
  (v.zone === null || isZone(v.zone)) &&
  opt(v.base, isInt) &&
  allOf(v.players, v.base === undefined ? isPlayerState : isPlayerPatch) &&
  isInt(v.lootVersion) &&
  opt(v.loot, (l) => allOf(l, isLoot)) &&
  opt(v.lootDelta, isLootDelta) &&
  (v.loot === undefined || v.lootDelta === undefined) &&
  (v.local === null || isLocal(v.local));

const isImpact = (v: unknown): boolean =>
  isObj(v) && isVec3(v.point) && oneOf(v.surface, SURFACES) && (v.playerId === null || isInt(v.playerId)) && isBool(v.headshot);

const isStanding = (v: unknown): boolean =>
  isObj(v) && isInt(v.id) && isStr(v.name) && isBool(v.isBot) && isInt(v.kills) && isInt(v.placement);

const idOrNull = (v: unknown): boolean => v === null || isInt(v);

type EventCheck = (v: Obj) => boolean;
/**
 * One validator per sim event type. Keyed by `SimEventType` so a new event type in the shared union is a compile
 * error here until it gets a validator; without one, `decodeServerMessage` would filter it out on every client.
 * Optional fields (Contract revision 1: damage.armorBefore, kill.headshot) are checked when present.
 */
const EVENT_CHECKS: Record<SimEventType, EventCheck> = {
  spawn: (v) => isInt(v.playerId) && isVec3(v.pos),
  shot: (v) => isInt(v.shooterId) && oneOf(v.weapon, WEAPONS) && isVec3(v.origin) && allOf(v.impacts, isImpact),
  damage: (v) =>
    isInt(v.victimId) && idOrNull(v.attackerId) && isNum(v.amount) && isBool(v.headshot) && oneOf(v.cause, CAUSES) &&
    isVec3(v.sourcePos) && isNum(v.hpAfter) && isNum(v.armorAfter) && opt(v.armorBefore, isNum),
  kill: (v) =>
    isInt(v.victimId) && idOrNull(v.killerId) && (v.weapon === null || oneOf(v.weapon, WEAPONS)) &&
    oneOf(v.cause, CAUSES) && isInt(v.placement) && opt(v.headshot, isBool),
  pickup: (v) => isInt(v.playerId) && isInt(v.lootId) && oneOf(v.item, ITEMS) && isInt(v.qty) && isVec3(v.pos),
  reloadStart: (v) => isInt(v.playerId) && oneOf(v.weapon, GUNS) && isNum(v.durationMs),
  reloadEnd: (v) => isInt(v.playerId) && oneOf(v.weapon, GUNS) && isBool(v.completed),
  healStart: (v) => isInt(v.playerId) && oneOf(v.item, HEALS) && isNum(v.durationMs),
  healEnd: (v) => isInt(v.playerId) && oneOf(v.item, HEALS) && isBool(v.completed) && isNum(v.hpAfter),
  weaponSwitch: (v) => isInt(v.playerId) && oneOf(v.weapon, WEAPONS) && isSlot(v.slot),
  matchEnded: (v) => idOrNull(v.winnerId) && allOf(v.standings, isStanding),
  actionFailed: (v) => isInt(v.playerId) && oneOf(v.action, FAILED_ACTIONS) && oneOf(v.reason, FAIL_REASONS),
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

const isWelcome = (v: unknown): v is WelcomeInfo =>
  isObj(v) && isInt(v.playerId) && isStr(v.mapId) && isNum(v.serverTime) && isInt(v.matchId);

export function decodeServerMessage(raw: unknown, hooks?: DecodeHooks): ServerMessage | null {
  try {
    const m = parse(raw, MAX_SERVER_FRAME_CHARS);
    if (!isObj(m)) return null;
    switch (m.t) {
      case 'welcome':
        return isWelcome(m.welcome) ? { t: 'welcome', welcome: m.welcome } : null;
      case 'snapshot':
        return isSnapshot(m.snap) ? { t: 'snapshot', snap: m.snap } : null;
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
      default:
        return null;
    }
  } catch {
    return null;
  }
}
