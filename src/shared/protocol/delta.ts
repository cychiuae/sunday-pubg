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
 * snapshot (NETCODE.md "Grenades on the wire"). `local` is always sent whole.
 *
 * Only clients that join with the `delta1` capability get deltas. Others get the M1 format (full players, loot
 * omitted when the version is unchanged), so a stale cached client keeps working.
 *
 * Imports only shared types and the protocol module (dependency rule §3).
 */
import type { LootId, LootState, PlayerId, PlayerState, WorldSnapshot } from '../types';
import { isPlayerState, type LootDelta, type PlayerPatch, type WireMatch, type WireSnapshot } from './messages';

/** M2b: `match.route` (C-gate field; read loosely so this compiles before and after the gate). */
const routeOf = (m: object): unknown => (m as { route?: unknown }).route;

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

// -------------------------------------------------------------------------------------------------
// Server side
// -------------------------------------------------------------------------------------------------
export class SnapshotDeltaEncoder {
  private players: Map<PlayerId, PlayerState> | null = null;
  private tick = -1;
  /** match.route of the base snapshot (undefined = none yet). */
  private route: unknown = undefined;
  private loot: Map<LootId, LootState> | null = null;
  private lootVersion: number | null = null;

  constructor(readonly deltas: boolean) {}

  /** Forget the base: the next snapshot is sent in full (newly joined, or the client asked for a resync). */
  reset(): void {
    this.players = null;
    this.tick = -1;
    this.route = undefined;
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
  private loot: Map<LootId, LootState> | null = null;
  private lootList: LootState[] = [];
  private lootVersion: number | null = null;

  /** Forget all state (new session, or after a failed decode). */
  reset(): void {
    this.players = null;
    this.tick = -1;
    this.route = undefined;
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
    const { base, lootDelta, loot: wireLoot, players: wirePlayers, match: wireMatch, ...rest } = w;
    // M2b: a delta snapshot omits an unchanged route; restore it from the base.
    let match = wireMatch as WorldSnapshot['match'];
    if (base !== undefined && routeOf(wireMatch) === undefined && this.route !== undefined) {
      match = { ...wireMatch, route: this.route } as WorldSnapshot['match'];
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
    this.loot = lootMap;
    this.lootList = lootList;
    this.lootVersion = w.lootVersion;
    return { ok: true, snap: { ...rest, match, players, loot: lootList } };
  }
}
