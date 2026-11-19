/**
 * M2c compact rows (ADR 0007 §9, NETCODE.md "Rows"). Owner: network-engineer.
 *
 * In the wire form of a snapshot, full-format entity lists are JSON arrays in a fixed column order instead of keyed
 * objects: complete players (a snapshot without `base`), and the `grenades`, `rockets` and `smokes` lists (always
 * whole lists). A 24-player worst-case snapshot drops from about 16.6 KB to under 8 KB. Delta player patches stay
 * keyed objects (they carry only changed fields). The decoder turns rows back into objects BEFORE the shape check,
 * so in-memory types and every consumer are unchanged.
 *
 * THE COLUMN ORDER IS PROTOCOL: append only, and bump PROTOCOL_VERSION. A row must have exactly the column count of
 * its list; anything else is left as an array, which the shape check rejects.
 *
 * Column encodings: booleans 0/1; `weaponLevel` 0 = null; `dropPhase` 0 = null, 1 = freefall, 2 = chute; `anim` is
 * the ANIM_BITS mask (packed by messages.ts, which owns ANIM_BITS); `pos`/`vel` and `appearance` are flattened. A field
 * absent from the object (an M2c field before the C-gate) is `null` in its column and absent again after decoding.
 * Values the codec does not recognise are passed through unchanged so the shape check rejects them.
 *
 * Rows are sent only to sessions that advertise CAP_ROWS (NetClient, server/testClient); others keep the object
 * format, so raw-frame tools and stale clients keep working. Pure; imports only types (dependency rule §3).
 */
import type { DropPhase, GrenadeState, PlayerDropFields, PlayerM2cFields, PlayerState, RocketState, SmokeCloudState } from '../types';

/**
 * Hello capability "M2c wire compaction": full-format entity lists as rows, and `local` as a patch in delta snapshots
 * (protocol/delta.ts). Clients without it get the object format and a whole `local`.
 */
export const CAP_ROWS = 'rows1';

export const PLAYER_COLUMNS = [
  'id', 'name', 'x', 'y', 'z', 'velY', 'yaw', 'pitch', 'hp', 'vestTier', 'helmetTier', 'alive', 'weapon', 'weaponLevel',
  'sight', 'stance', 'stanceFrom', 'stanceProgress', 'anim', 'skin', 'outfit', 'hair', 'isBot', 'kills', 'aboard',
  'dropPhase',
] as const;
export const GRENADE_COLUMNS = ['id', 'ownerId', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'explodesAt', 'inWater', 'kind'] as const;
export const ROCKET_COLUMNS = ['id', 'ownerId', 'level', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'firedAt'] as const;
export const SMOKE_COLUMNS = ['id', 'ownerId', 'x', 'y', 'z', 'deployedAt', 'fadeAt'] as const;

// Compile-time coverage: a new field on any of these types is an error here until it gets a column (append only).
type WirePlayer = PlayerState & PlayerDropFields & PlayerM2cFields;
type PlayerRowFields =
  | 'id' | 'name' | 'pos' | 'velY' | 'yaw' | 'pitch' | 'hp' | 'vestTier' | 'helmetTier' | 'alive' | 'weapon'
  | 'weaponLevel' | 'sight' | 'stance' | 'stanceFrom' | 'stanceProgress' | 'anim' | 'appearance' | 'isBot' | 'kills'
  | 'aboard' | 'dropPhase';
type Covered<T, K> = Exclude<keyof T, K> extends never ? true : never;
const _players: Covered<WirePlayer, PlayerRowFields> = true;
const _grenades: Covered<GrenadeState, 'id' | 'ownerId' | 'pos' | 'vel' | 'explodesAt' | 'inWater' | 'kind'> = true;
const _rockets: Covered<RocketState, 'id' | 'ownerId' | 'level' | 'pos' | 'vel' | 'firedAt'> = true;
const _smokes: Covered<SmokeCloudState, 'id' | 'ownerId' | 'pos' | 'deployedAt' | 'fadeAt'> = true;
void [_players, _grenades, _rockets, _smokes];

/** `dropPhase` codes (index = code). */
const DROP_PHASE_CODES = [null, 'freefall', 'chute'] as const;
const _dropPhases: Exclude<DropPhase, (typeof DROP_PHASE_CODES)[number]> extends never ? true : never = true;
void _dropPhases;

type Row = unknown[];
type Obj = Record<string, unknown>;

const b01 = (v: unknown): unknown => (v === true ? 1 : v === false ? 0 : v);
const fromB01 = (v: unknown): unknown => (v === 1 ? true : v === 0 ? false : v);
/** Absent (undefined) -> null on the wire. */
const orNull = (v: unknown): unknown => (v === undefined ? null : v);
/** Sets `o[k] = v` unless the column was null (field absent on the sender). */
const setPresent = (o: Obj, k: string, v: unknown): void => {
  if (v !== null) o[k] = v;
};

/** Complete player -> row. `anim` must already be packed (messages.ts packAnim). */
export function playerToRow(p: PlayerState, anim: number): Row {
  const o = p as WirePlayer & Partial<PlayerM2cFields> & Partial<PlayerDropFields>;
  const lvl = o.weaponLevel === undefined ? null : o.weaponLevel === null ? 0 : o.weaponLevel;
  const dp = DROP_PHASE_CODES.indexOf((o.dropPhase ?? null) as (typeof DROP_PHASE_CODES)[number]);
  return [
    o.id, o.name, o.pos.x, o.pos.y, o.pos.z, o.velY, o.yaw, o.pitch, o.hp, o.vestTier, o.helmetTier, b01(o.alive),
    o.weapon, lvl, orNull(o.sight), o.stance, o.stanceFrom, o.stanceProgress, anim, o.appearance.skin,
    o.appearance.outfit, o.appearance.hair, b01(o.isBot), o.kills, o.aboard === true ? 1 : 0, dp >= 0 ? dp : o.dropPhase,
  ];
}

/** Row -> player object (anim stays the raw mask; messages.ts expands it). null when the row has the wrong length. */
export function rowToPlayer(r: Row): Obj | null {
  if (r.length !== PLAYER_COLUMNS.length) return null;
  const o: Obj = {
    id: r[0],
    name: r[1],
    pos: { x: r[2], y: r[3], z: r[4] },
    velY: r[5],
    yaw: r[6],
    pitch: r[7],
    hp: r[8],
    vestTier: r[9],
    helmetTier: r[10],
    alive: fromB01(r[11]),
    weapon: r[12],
  };
  const lvl = r[13];
  if (lvl !== null) o.weaponLevel = lvl === 0 ? null : lvl;
  setPresent(o, 'sight', r[14]);
  o.stance = r[15];
  o.stanceFrom = r[16];
  o.stanceProgress = r[17];
  o.anim = r[18];
  o.appearance = { skin: r[19], outfit: r[20], hair: r[21] };
  o.isBot = fromB01(r[22]);
  o.kills = r[23];
  o.aboard = fromB01(r[24]);
  const dp = r[25];
  o.dropPhase = typeof dp === 'number' && Number.isInteger(dp) && dp >= 0 && dp < DROP_PHASE_CODES.length ? DROP_PHASE_CODES[dp] : dp;
  return o;
}

export function grenadeToRow(g: GrenadeState): Row {
  return [g.id, g.ownerId, g.pos.x, g.pos.y, g.pos.z, g.vel.x, g.vel.y, g.vel.z, g.explodesAt, b01(g.inWater), orNull(g.kind)];
}
export function rowToGrenade(r: Row): Obj | null {
  if (r.length !== GRENADE_COLUMNS.length) return null;
  const o: Obj = {
    id: r[0],
    ownerId: r[1],
    pos: { x: r[2], y: r[3], z: r[4] },
    vel: { x: r[5], y: r[6], z: r[7] },
    explodesAt: r[8],
    inWater: fromB01(r[9]),
  };
  setPresent(o, 'kind', r[10]);
  return o;
}

export function rocketToRow(k: RocketState): Row {
  return [k.id, k.ownerId, k.level, k.pos.x, k.pos.y, k.pos.z, k.vel.x, k.vel.y, k.vel.z, k.firedAt];
}
export function rowToRocket(r: Row): Obj | null {
  if (r.length !== ROCKET_COLUMNS.length) return null;
  return {
    id: r[0],
    ownerId: r[1],
    level: r[2],
    pos: { x: r[3], y: r[4], z: r[5] },
    vel: { x: r[6], y: r[7], z: r[8] },
    firedAt: r[9],
  };
}

export function smokeToRow(c: SmokeCloudState): Row {
  return [c.id, c.ownerId, c.pos.x, c.pos.y, c.pos.z, c.deployedAt, c.fadeAt];
}
export function rowToSmoke(r: Row): Obj | null {
  if (r.length !== SMOKE_COLUMNS.length) return null;
  return { id: r[0], ownerId: r[1], pos: { x: r[2], y: r[3], z: r[4] }, deployedAt: r[5], fadeAt: r[6] };
}

/** Decoder helper: every array entry of `list` through `fromRow` (wrong length: left as the array); objects untouched. */
export function expandRows(list: unknown, fromRow: (r: Row) => Obj | null): unknown {
  if (!Array.isArray(list) || !list.some(Array.isArray)) return list;
  return list.map((e: unknown) => (Array.isArray(e) ? (fromRow(e) ?? e) : e));
}
