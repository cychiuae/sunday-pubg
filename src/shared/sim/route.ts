/**
 * Carrier route generation (docs/design/systems/drop.md "Route generation", ADR 0005 §8). Pure: the World passes its
 * seeded route Rng and the server time of the first 'playing' tick.
 *
 * - Play area: island = the circle of `islandRadius` around (0, 0); indoor = the `floor` rectangle (its centre is the
 *   map centre). support(n) = the play area's half-width along the unit normal n.
 * - Draw: heading theta uniform in [0, 360) deg, d = (sin theta, cos theta), n = (cos theta, -sin theta); lateral offset
 *   o uniform in [-f, f] x support(n) (f = drop.routeLateralFraction). Line P(s) = centre + o n + s d.
 * - Entry / exit: where the line crosses the play area expanded by drop.routeEntryMargin. Eject: where it leaves the
 *   play area inset by drop.ejectInset.
 * - Window = s_eject - (s_entry + carrierSpeed x noJumpMs / 1000) must be >= drop.minJumpWindowMetres; else redraw,
 *   up to drop.routeMaxTries draws; if every draw fails, the last heading with o = 0.
 */
import type { Balance } from '../balance';
import { isIndoor } from '../maps';
import type { Rng } from '../math';
import type { AnyMapData, DropRoute, Vec2 } from '../types';

interface PlayArea {
  cx: number;
  cz: number;
  /** Circle radius (kind 'circle') or rectangle half extents. */
  kind: 'circle' | 'rect';
  r: number;
  hx: number;
  hz: number;
}

function playArea(map: AnyMapData): PlayArea {
  if (isIndoor(map)) {
    const f = map.floor;
    return { kind: 'rect', cx: (f.minX + f.maxX) / 2, cz: (f.minZ + f.maxZ) / 2, r: 0, hx: (f.maxX - f.minX) / 2, hz: (f.maxZ - f.minZ) / 2 };
  }
  return { kind: 'circle', cx: 0, cz: 0, r: map.islandRadius, hx: 0, hz: 0 };
}

/** Half-width of the area along unit normal (nx, nz). */
function support(a: PlayArea, nx: number, nz: number): number {
  return a.kind === 'circle' ? a.r : a.hx * Math.abs(nx) + a.hz * Math.abs(nz);
}

/**
 * [sIn, sOut] where the line q + s d (q relative to the area centre) is inside the area grown by `grow` (negative =
 * inset), or null when it misses.
 */
function chord(a: PlayArea, qx: number, qz: number, dx: number, dz: number, grow: number): [number, number] | null {
  if (a.kind === 'circle') {
    const R = a.r + grow;
    if (R <= 0) return null;
    const b = qx * dx + qz * dz;
    const c = qx * qx + qz * qz - R * R;
    const disc = b * b - c;
    if (disc <= 0) return null;
    const sq = Math.sqrt(disc);
    return [-b - sq, -b + sq];
  }
  const hx = a.hx + grow;
  const hz = a.hz + grow;
  if (hx <= 0 || hz <= 0) return null;
  let t0 = -Infinity;
  let t1 = Infinity;
  const slab = (o: number, d: number, h: number): boolean => {
    if (Math.abs(d) < 1e-12) return Math.abs(o) <= h;
    let u = (-h - o) / d;
    let v = (h - o) / d;
    if (u > v) [u, v] = [v, u];
    if (u > t0) t0 = u;
    if (v < t1) t1 = v;
    return t0 < t1;
  };
  if (!slab(qx, dx, hx) || !slab(qz, dz, hz)) return null;
  return [t0, t1];
}

export interface RouteGeometry {
  heading: number;
  offset: number;
  entry: Vec2;
  exit: Vec2;
  eject: Vec2;
  /** Jump-window length on the ground track, metres (may be < minJumpWindowMetres only for the o = 0 fallback). */
  window: number;
}

function tryRoute(a: PlayArea, b: Balance, theta: number, o: number): (RouteGeometry & { sEntry: number; sExit: number; sEject: number }) | null {
  const d = b.drop;
  const dx = Math.sin(theta);
  const dz = Math.cos(theta);
  const nx = Math.cos(theta);
  const nz = -Math.sin(theta);
  const qx = o * nx;
  const qz = o * nz;
  const outer = chord(a, qx, qz, dx, dz, d.routeEntryMargin);
  const inner = chord(a, qx, qz, dx, dz, -d.ejectInset);
  if (!outer || !inner) return null;
  const [sEntry, sExit] = outer;
  const sEject = inner[1];
  const at = (s: number): Vec2 => ({ x: a.cx + qx + dx * s, z: a.cz + qz + dz * s });
  const window = sEject - (sEntry + (d.carrierSpeed * d.noJumpMs) / 1000);
  return { heading: theta, offset: o, entry: at(sEntry), exit: at(sExit), eject: at(sEject), window, sEntry, sExit, sEject };
}

/** Route geometry only (tests, tools). Consumes the same Rng draws as drawDropRoute. */
export function drawRouteGeometry(map: AnyMapData, b: Balance, rng: Rng): RouteGeometry & { sEntry: number; sExit: number; sEject: number } {
  const d = b.drop;
  const a = playArea(map);
  const tries = Math.max(1, Math.floor(d.routeMaxTries));
  let theta = 0;
  for (let i = 0; i < tries; i++) {
    theta = rng.next() * Math.PI * 2;
    const nx = Math.cos(theta);
    const nz = -Math.sin(theta);
    const o = (rng.next() * 2 - 1) * d.routeLateralFraction * support(a, nx, nz);
    const r = tryRoute(a, b, theta, o);
    if (r && r.window >= d.minJumpWindowMetres) return r;
  }
  const r = tryRoute(a, b, theta, 0);
  if (r) return r;
  // Degenerate play area (inset larger than the area): fly through the centre, eject at the centre.
  const fb = tryRoute(a, { ...b, drop: { ...d, ejectInset: 0 } }, theta, 0)!;
  return { ...fb, eject: { x: a.cx, z: a.cz }, sEject: 0, window: -(fb.sEntry + (d.carrierSpeed * d.noJumpMs) / 1000) };
}

/** The full route with server times (startsAt = the first tick of 'playing'). */
export function drawDropRoute(map: AnyMapData, b: Balance, rng: Rng, startsAt: number): DropRoute {
  const d = b.drop;
  const g = drawRouteGeometry(map, b, rng);
  const v = d.carrierSpeed > 0 ? d.carrierSpeed : 1;
  const msAt = (s: number): number => startsAt + ((s - g.sEntry) / v) * 1000;
  const noJumpUntil = startsAt + Math.max(0, d.noJumpMs);
  const endsAt = Math.max(noJumpUntil, msAt(g.sExit));
  const ejectAt = Math.min(endsAt, Math.max(noJumpUntil, msAt(g.sEject)));
  return {
    mapId: map.id,
    entry: g.entry,
    exit: g.exit,
    eject: g.eject,
    altitude: d.carrierAltitude,
    speed: d.carrierSpeed,
    startsAt,
    noJumpUntil,
    ejectAt,
    endsAt,
  };
}

/** Same route moved in time (a legacy World whose first 'playing' tick differs from the planned start). */
export function shiftRoute(r: DropRoute, startsAt: number): DropRoute {
  const k = startsAt - r.startsAt;
  return { ...r, startsAt, noJumpUntil: r.noJumpUntil + k, ejectAt: r.ejectAt + k, endsAt: r.endsAt + k };
}
