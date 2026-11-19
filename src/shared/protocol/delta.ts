/**
 * Snapshot delta encoding (NETCODE.md "Snapshot deltas"). Owner: network-engineer.
 *
 * The wire is WebSocket over TCP: frames arrive complete and in order, so the base of each delta is the previous
 * snapshot the server actually sent on that socket (an implicit ack). The client still checks every base it is
 * given (`base` tick for players, `lootDelta.from` for loot). On any mismatch it drops the snapshot, forgets its
 * state and asks for a full snapshot (`{ t: 'resync' }`); the server then resets this encoder.
 *
 * M2a (PROTOCOL_VERSION 2): the new PlayerState fields (vestTier, helmetTier, stance, stanceFrom, stanceProgress,
 * anim.ads, anim.cooking) go through `diffPlayer` like every other field, so a settled player costs nothing. Loot
 * `durability` is part of an entry (a change re-adds it). `grenades` is NOT delta-encoded: the full list rides in every
 * snapshot (NETCODE.md "Grenades on the wire").
 *
 * M2c: `local` is delta-encoded too (it was about 0.9 KB in every snapshot): in a delta snapshot `local` is omitted
 * while the base's `local` is an object for the same player, and `localPatch` carries only the top-level fields that
 * changed (nested objects such as `movement` whole; absent = nothing changed). `local: null` and a different or new
 * local player are sent whole, as is a local that lost a key. Only for encoders built with `localPatch` (the server
 * enables it for sessions that advertise CAP_ROWS, so an older delta1 client keeps getting a whole `local`).
 *
 * M2c (ADR 0007 §9): `rockets`, `smokes` and `brokenPanes` (immutable records and a grow-only list) are omitted from a
 * delta snapshot while equal to the base, like `match.route`; a change sends the whole list, or for rockets and smokes `{ add, remove }` when smaller. The decoder carries them
 * forward. (Rows are a text-level encoding in messages.ts and do not concern this module.)
 *
 * Only clients that join with the `delta1` capability get deltas. Others get the M1 format (full players, loot
 * omitted when the version is unchanged), so a stale cached client keeps working.
 *
 * Imports only shared types and the protocol module (dependency rule §3).
 */
import type { LocalPlayerState, LootId, LootState, PlayerId, PlayerState, WorldSnapshot } from '../types';
import { M2C_FIELDS_REQUIRED, isLocalPlayerState, isPlayerState, type RecordDelta, type LootDelta, type PlayerPatch, type WireMatch, type WireSnapshot } from './messages';

/** M2b: `match.route` (C-gate field; read loosely so this compiles before and after the gate). */
const routeOf = (m: object): unknown => (m as { route?: unknown }).route;

/** M2c snapshot lists carried forward in deltas while unchanged (optional before the C-gate, required after). */
const CARRIED = ['rockets', 'smokes', 'brokenPanes'] as const;
type CarriedKey = (typeof CARRIED)[number];
type Carried = Partial<Record<CarriedKey, unknown>>;
/** Id-keyed record lists that may ride as { add, remove } (REVIEW-M2c SF4). */
const RECORD_LISTS = [
  ['rockets', 'rocketsDelta'],
  ['smokes', 'smokesDelta'],
] as const;
type Rec = { id: number };

/** { add, remove } from `base` to `cur` (both sorted by id); null when the whole list is not larger (send it whole). */
export function diffRecords(base: readonly Rec[], cur: readonly Rec[]): RecordDelta<Rec> | null {
  const before = new Map(base.map((r) => [r.id, r]));
  const now = new Set(cur.map((r) => r.id));
  const add = cur.filter((r) => !sameValue(before.get(r.id), r));
  const remove = base.filter((r) => !now.has(r.id)).map((r) => r.id);
  return add.length < cur.length ? { add, remove } : null;
}

/** Applies a record delta; null when it removes an unknown id. Result sorted by id. */
export function applyRecords(base: readonly Rec[], d: RecordDelta<Rec>): Rec[] | null {
  const m = new Map(base.map((r) => [r.id, r]));
  for (const id of d.remove) if (!m.delete(id)) return null;
  for (const r of d.add) m.set(r.id, r);
  return [...m.values()].sort((a, b) => a.id - b.id);
}

const carriedOf = (s: object): Carried => {
  const o = s as Carried;
  return { rockets: o.rockets, smokes: o.smokes, brokenPanes: o.brokenPanes };
};

/** Join capability that enables delta snapshots. */
export const CAP_DELTA = 'delta1';

/** Rough JSON bytes per loot entry and per removed id / qty pair, for choosing delta vs. full list. */
const LOOT_ENTRY_BYTES = 70;
const LOOT_ID_BYTES = 5;
const LOOT_QTY_BYTES = 10;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

/** Deep equality for the small plain-data values in snapshots (numbers, strings, booleans, null, small objects). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !sameValue(a[k], b[k])) return false;
  return true;
}

/** Equal apart from `qty`. */
function sameExceptQty(a: LootState, b: LootState): boolean {
  return sameValue({ ...a, qty: 0 }, { ...b, qty: 0 });
}

/** Patch with only the fields of `cur` that differ from `prev`; null when nothing changed; `cur` itself when a field disappeared. */
export function diffPlayer(prev: PlayerState, cur: PlayerState): PlayerPatch | PlayerState | null {
  const p = prev as unknown as Obj;
  const c = cur as unknown as Obj;
  for (const k of Object.keys(p)) if (!Object.hasOwn(c, k)) return cur; // a merge cannot delete a key
  let patch: Obj | null = null;
  for (const k of Object.keys(c)) {
    if (k === 'id' || sameValue(p[k], c[k])) continue;
    (patch ??= { id: cur.id })[k] = c[k];
  }
  return patch as PlayerPatch | null;
}

/**
 * M2c: changed top-level fields of `cur` against `prev` (same player); `{}` when nothing changed; null when `cur`
 * must be sent whole (a key disappeared).
 */
export function diffLocal(prev: LocalPlayerState, cur: LocalPlayerState): Partial<LocalPlayerState> | null {
  const p = prev as unknown as Obj;
  const c = cur as unknown as Obj;
  for (const k of Object.keys(p)) if (!Object.hasOwn(c, k)) return null;
  const patch: Obj = {};
  for (const k of Object.keys(c)) if (!sameValue(p[k], c[k])) patch[k] = c[k];
  return patch as Partial<LocalPlayerState>;
}

// -------------------------------------------------------------------------------------------------
// Server side
// -------------------------------------------------------------------------------------------------
export class SnapshotDeltaEncoder {
  private players: Map<PlayerId, PlayerState> | null = null;
  private tick = -1;
  /** match.route of the base snapshot (undefined = none yet). */
  private route: unknown = undefined;
  /** M2c lists of the base snapshot. */
  private carried: Carried = {};
  /** M2c: `local` of the base snapshot. */
  private local: LocalPlayerState | null = null;
  private loot: Map<LootId, LootState> | null = null;
  private lootVersion: number | null = null;

  /** `localPatch`: M2c local patches (protocol/rows.ts CAP_ROWS clients); default true. */
  constructor(
    readonly deltas: boolean,
    readonly localPatch = true,
  ) {}

  /** Forget the base: the next snapshot is sent in full (newly joined, or the client asked for a resync). */
  reset(): void {
    this.players = null;
    this.tick = -1;
    this.route = undefined;
    this.carried = {};
    this.local = null;
    this.loot = null;
    this.lootVersion = null;
  }

  /**
   * Wire form of `snap` for this connection, recorded as the new base. Call it only for snapshots that are really
   * sent. `snap` should already be quantized (`quantizeDeep`) so the base equals what the client decodes.
   */
  encode(snap: WorldSnapshot): WireSnapshot {
    // `rest` carries match, zone, local and the full `grenades` list unchanged in both formats.
    const { loot, players, ...rest } = snap;
    if (!this.deltas) {
      // M1 format: full players; loot omitted when this socket already has the version.
      const sameLoot = this.lootVersion === snap.lootVersion;
      this.lootVersion = snap.lootVersion;
      return sameLoot ? { ...rest, players } : { ...rest, players, loot };
    }
    const wire: WireSnapshot = { ...rest, players };
    // Players: patches against the previous snapshot sent on this socket.
    if (this.players !== null) {
      // M2b: the route is fixed for a World; omit it while it equals the base's (the decoder carries it forward).
      const route = routeOf(rest.match);
      if (route !== undefined && sameValue(route, this.route)) {
        const { route: _r, ...matchNoRoute } = rest.match as WireMatch;
        wire.match = matchNoRoute;
      }
      // M2c: immutable records and the grow-only pane list ride only when they change.
      for (const k of CARRIED) {
        const v = wire[k];
        if (v !== undefined && sameValue(v, this.carried[k])) delete wire[k];
      }
      // A changed record list rides as { add, remove } when that is smaller (one new rocket, not all 16).
      for (const [k, dk] of RECORD_LISTS) {
        const cur = wire[k];
        const prev = this.carried[k];
        if (cur === undefined || !Array.isArray(prev)) continue;
        const d = diffRecords(prev as Rec[], cur);
        if (d !== null) {
          delete wire[k];
          (wire as Record<string, unknown>)[dk] = d;
        }
      }
      // M2c: the local player as a patch against the base's local.
      const prevLocal = this.local;
      if (this.localPatch && snap.local !== null && prevLocal !== null && prevLocal.id === snap.local.id) {
        const patch = diffLocal(prevLocal, snap.local);
        if (patch !== null) {
          delete wire.local;
          if (Object.keys(patch).length > 0) wire.localPatch = patch;
        }
      }
      const patches: (PlayerPatch | PlayerState)[] = [];
      for (const cur of players) {
        const prev = this.players.get(cur.id);
        patches.push(prev ? (diffPlayer(prev, cur) ?? { id: cur.id }) : cur);
      }
      wire.base = this.tick;
      wire.players = patches;
    }
    // Loot: unchanged (omitted), delta, or full list, whichever is smaller.
    if (this.loot === null || this.lootVersion === null) {
      wire.loot = loot;
    } else if (snap.lootVersion !== this.lootVersion) {
      const delta = diffLoot(this.lootVersion, this.loot, loot);
      const deltaBytes =
        delta.add.length * LOOT_ENTRY_BYTES + delta.remove.length * LOOT_ID_BYTES + delta.qty.length * LOOT_QTY_BYTES;
      if (deltaBytes < loot.length * LOOT_ENTRY_BYTES) wire.lootDelta = delta;
      else wire.loot = loot;
    }
    this.players = new Map(players.map((p) => [p.id, p]));
    this.tick = snap.tick;
    this.route = routeOf(snap.match);
    this.carried = carriedOf(snap);
    this.local = snap.local;
    if (this.lootVersion !== snap.lootVersion || this.loot === null) {
      this.loot = new Map(loot.map((l) => [l.id, l]));
      this.lootVersion = snap.lootVersion;
    }
    return wire;
  }
}

/**
 * Changes from `base` to `cur`. An entry whose item, position, tier or (M2a) durability changed is re-added (replaced
 * in place); only a pure quantity change goes in `qty`.
 */
export function diffLoot(from: number, base: ReadonlyMap<LootId, LootState>, cur: readonly LootState[]): LootDelta {
  const add: LootState[] = [];
  const qty: [LootId, number][] = [];
  const seen = new Set<LootId>();
  for (const l of cur) {
    seen.add(l.id);
    const prev = base.get(l.id);
    if (!prev) add.push(l);
    else if (sameValue(prev, l)) continue;
    else if (sameExceptQty(prev, l)) qty.push([l.id, l.qty]);
    else add.push(l);
  }
  const remove: LootId[] = [];
  for (const id of base.keys()) if (!seen.has(id)) remove.push(id);
  return { from, add, remove, qty };
}

// -------------------------------------------------------------------------------------------------
// Client side
// -------------------------------------------------------------------------------------------------
export type DeltaDecodeResult = { ok: true; snap: WorldSnapshot } | { ok: false; reason: string };

export class SnapshotDeltaDecoder {
  private players: Map<PlayerId, PlayerState> | null = null;
  private tick = -1;
  private route: unknown = undefined;
  private carried: Carried = {};
  private local: LocalPlayerState | null = null;
  private loot: Map<LootId, LootState> | null = null;
  private lootList: LootState[] = [];
  private lootVersion: number | null = null;

  /** Forget all state (new session, or after a failed decode). */
  reset(): void {
    this.players = null;
    this.tick = -1;
    this.route = undefined;
    this.carried = {};
    this.local = null;
    this.loot = null;
    this.lootList = [];
    this.lootVersion = null;
  }

  /** True when the next snapshot must be a full one (nothing to apply deltas to). */
  get needsFull(): boolean {
    return this.players === null;
  }

  /**
   * Rebuilds the full snapshot from a shape-checked wire snapshot. On failure the decoder resets itself (every
   * following delta fails too) and the caller should request a resync.
   */
  apply(w: WireSnapshot): DeltaDecodeResult {
    const res = this.tryApply(w);
    if (!res.ok) this.reset();
    return res;
  }

  private tryApply(w: WireSnapshot): DeltaDecodeResult {
    const { base, lootDelta, loot: wireLoot, players: wirePlayers, match: wireMatch, local: wireLocal, localPatch, ...rest } = w;
    // M2b: a delta snapshot omits an unchanged route; restore it from the base.
    let match = wireMatch as WorldSnapshot['match'];
    if (base !== undefined && routeOf(wireMatch) === undefined && this.route !== undefined) {
      match = { ...wireMatch, route: this.route } as WorldSnapshot['match'];
    }
    // M2c: likewise rockets, smokes and brokenPanes (checked against the base tick below, with the players).
    const out: Record<string, unknown> = rest;
    for (const [k, dk] of RECORD_LISTS) {
      const d = out[dk] as RecordDelta<Rec> | undefined;
      if (d === undefined) continue;
      delete out[dk];
      const prev = this.carried[k];
      const next = base !== undefined && Array.isArray(prev) ? applyRecords(prev as Rec[], d) : null;
      if (next === null) return { ok: false, reason: `${dk} does not apply to the base` };
      out[k] = next;
    }
    for (const k of CARRIED) {
      if (out[k] === undefined && base !== undefined && this.carried[k] !== undefined) out[k] = this.carried[k];
      if (out[k] === undefined && M2C_FIELDS_REQUIRED) return { ok: false, reason: `${k} missing` };
    }
    // M2c: `local` omitted = the base's local plus `localPatch` (the shape check allowed it only with a base).
    let local: LocalPlayerState | null;
    if (wireLocal !== undefined) local = wireLocal;
    else {
      if (base === undefined || this.local === null) return { ok: false, reason: 'local patch without a base local' };
      local = localPatch === undefined ? this.local : ({ ...this.local, ...localPatch } as LocalPlayerState);
      if (local !== this.local && !isLocalPlayerState(local)) return { ok: false, reason: 'bad local patch' };
    }
    // Players.
    const players: PlayerState[] = [];
    const seen = new Set<PlayerId>();
    if (base !== undefined && (this.players === null || base !== this.tick)) {
      return { ok: false, reason: `players base ${base} != ${this.players === null ? 'none' : this.tick}` };
    }
    for (const entry of wirePlayers) {
      if (seen.has(entry.id)) return { ok: false, reason: `duplicate player ${entry.id}` };
      seen.add(entry.id);
      if (isPlayerState(entry)) {
        players.push(entry);
        continue;
      }
      const prev = base !== undefined ? this.players?.get(entry.id) : undefined;
      if (!prev) return { ok: false, reason: `patch for unknown player ${entry.id}` };
      const merged = Object.keys(entry).length === 1 ? prev : ({ ...prev, ...entry } as PlayerState);
      if (merged !== prev && !isPlayerState(merged)) return { ok: false, reason: `bad patch for player ${entry.id}` };
      players.push(merged);
    }
    // Loot.
    let lootMap = this.loot;
    let lootList = this.lootList;
    if (wireLoot !== undefined) {
      lootMap = new Map(wireLoot.map((l) => [l.id, l]));
      if (lootMap.size !== wireLoot.length) return { ok: false, reason: 'duplicate loot id' };
      lootList = wireLoot;
    } else if (lootDelta !== undefined) {
      if (this.loot === null || lootDelta.from !== this.lootVersion) {
        return { ok: false, reason: `loot base ${lootDelta.from} != ${this.lootVersion ?? 'none'}` };
      }
      lootMap = new Map(this.loot);
      for (const id of lootDelta.remove) if (!lootMap.delete(id)) return { ok: false, reason: `remove unknown loot ${id}` };
      for (const l of lootDelta.add) lootMap.set(l.id, l); // replaces in place, appends when new
      for (const [id, qty] of lootDelta.qty) {
        const l = lootMap.get(id);
        if (!l) return { ok: false, reason: `qty for unknown loot ${id}` };
        lootMap.set(id, { ...l, qty });
      }
      lootList = [...lootMap.values()];
    } else if (this.loot === null || w.lootVersion !== this.lootVersion) {
      return { ok: false, reason: `loot omitted for version ${w.lootVersion}, have ${this.lootVersion ?? 'none'}` };
    }
    this.players = new Map(players.map((p) => [p.id, p]));
    this.tick = w.tick;
    this.route = routeOf(match);
    this.carried = carriedOf(out);
    this.local = local;
    this.loot = lootMap;
    this.lootList = lootList;
    this.lootVersion = w.lootVersion;
    return { ok: true, snap: { ...out, match, players, local, loot: lootList } as WorldSnapshot };
  }
}
