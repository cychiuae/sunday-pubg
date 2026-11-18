/**
 * M2b map helpers (ADR 0005). Owner: tech-lead. Pure geometry on MapData and DropRoute that sim, game, render, ui and
 * the server share, so each rule has one implementation. Physics (collision, raycasts, heights) stays in
 * src/shared/sim (game-developer); this file only answers questions about the data.
 */
import type { AnyMapData, DropRoute, IndoorMapData, Rect, Vec2, WallSegment } from './types';

/** Narrowing helper: `if (isIndoor(map))`. Anything that is not 'indoor' is the island. */
export const isIndoor = (map: AnyMapData): map is IndoorMapData => map.kind === 'indoor';

/**
 * Axis-aligned bounds of everything playable: island = the worldRadius square; indoor = the floor rectangle. Use it
 * for spatial grids, camera limits, nav grids and the minimap frame. It is NOT the movement boundary on the island
 * (that stays the worldRadius circle).
 */
export function mapBounds(map: AnyMapData): Rect {
  if (isIndoor(map)) return { ...map.floor };
  const r = map.worldRadius;
  return { minX: -r, minZ: -r, maxX: r, maxZ: r };
}

/** Radius of the smallest origin-centred circle that contains mapBounds (orbit camera distance, collider grid). */
export function mapExtent(map: AnyMapData): number {
  if (!isIndoor(map)) return map.worldRadius;
  const f = map.floor;
  return Math.hypot(Math.max(-f.minX, f.maxX), Math.max(-f.minZ, f.maxZ));
}

/**
 * A wall as a box: centre, half-length along the wall, half-thickness across, and rotY (Three.js convention: local
 * +X runs from (x1, z1) to (x2, z2)). Sim colliders, render meshes and the minimap all use this.
 */
export interface WallFrame {
  cx: number;
  cz: number;
  halfLength: number;
  halfThickness: number;
  rotY: number;
}
export function wallFrame(w: WallSegment): WallFrame {
  const dx = w.x2 - w.x1;
  const dz = w.z2 - w.z1;
  return {
    cx: (w.x1 + w.x2) / 2,
    cz: (w.z1 + w.z2) / 2,
    halfLength: Math.hypot(dx, dz) / 2,
    halfThickness: w.thickness / 2,
    // Three.js rotation.y = t maps local +X to (cos t, 0, -sin t); we want that to equal (dx, dz) / L.
    rotY: Math.atan2(-dz, dx),
  };
}

/** Carrier ground position at server time `now` (clamped to entry before startsAt and to exit after endsAt). */
export function carrierPosAt(route: DropRoute, now: number, out: Vec2 = { x: 0, z: 0 }): Vec2 {
  const span = route.endsAt - route.startsAt;
  const t = span > 0 ? Math.min(1, Math.max(0, (now - route.startsAt) / span)) : 0;
  out.x = route.entry.x + (route.exit.x - route.entry.x) * t;
  out.z = route.entry.z + (route.exit.z - route.entry.z) * t;
  return out;
}

/** Carrier heading as a yaw (types.ts convention: yaw 0 looks toward -Z, forward = (-sin yaw, -cos yaw)). */
export function carrierHeading(route: DropRoute): number {
  return Math.atan2(-(route.exit.x - route.entry.x), -(route.exit.z - route.entry.z));
}

/** Max rise between consecutive climb-route points that a jump can clear (maps.md 2.4 hard cap). */
export const CLIMB_JUMP_RISE_MAX = 0.95;

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRect = (r: Rect, x: number, z: number): boolean => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;

/**
 * Data checks for an indoor level (level tests and server startup; ADR 0005 §2). Returns one message per problem,
 * empty when valid. `stepHeight` = balance movement.stepHeight (climb-route rises). Geometry that needs colliders
 * (spawns inside props, reachability) is checked by the sim's level tests, not here.
 */
export function validateIndoorMap(map: IndoorMapData, stepHeight: number): string[] {
  const e: string[] = [];
  const f = map.floor;
  if (![f.minX, f.minZ, f.maxX, f.maxZ].every(fin) || !(f.minX < f.maxX && f.minZ < f.maxZ)) e.push('floor: bad rectangle');
  if (!(fin(map.ceilingHeight) && map.ceilingHeight > 0)) e.push('ceilingHeight must be > 0');
  map.walls.forEach((w, i) => {
    const p = `walls[${i}]`;
    if (![w.x1, w.z1, w.x2, w.z2, w.thickness, w.bottom, w.top].every(fin)) e.push(`${p}: non-finite number`);
    else {
      if (!(Math.hypot(w.x2 - w.x1, w.z2 - w.z1) > 0)) e.push(`${p}: zero length`);
      if (!(w.thickness > 0)) e.push(`${p}: thickness must be > 0`);
      if (!(w.bottom >= 0 && w.top > w.bottom)) e.push(`${p}: need 0 <= bottom < top`);
    }
    if (w.material !== 'solid' && w.material !== 'glass') e.push(`${p}: material must be solid|glass`);
  });
  map.floorZones.forEach((z, i) => {
    if (!(z.minX < z.maxX && z.minZ < z.maxZ)) e.push(`floorZones[${i}]: bad rectangle`);
  });
  map.props.forEach((p, i) => {
    if (!Object.prototype.hasOwnProperty.call(map.kit, p.kind)) e.push(`props[${i}]: kind "${p.kind}" is not in the kit`);
    if (![p.x, p.y, p.z, p.rotY, p.scale].every(fin) || !(p.scale > 0)) e.push(`props[${i}]: bad transform`);
  });
  const inside = (what: string, pts: readonly Vec2[]): void =>
    pts.forEach((pt, i) => {
      if (!inRect(f, pt.x, pt.z)) e.push(`${what}[${i}] is outside the floor`);
    });
  inside('playerSpawns', map.playerSpawns);
  inside('lootSpawns', map.lootSpawns);
  inside('zoneCenters', map.zoneCenters);
  inside('pois', map.pois);
  const ids = new Set<string>();
  for (const r of map.climbRoutes) {
    if (ids.has(r.id)) e.push(`climbRoutes: duplicate id "${r.id}"`);
    ids.add(r.id);
    if (r.points.length < 2) e.push(`climbRoutes.${r.id}: needs >= 2 points`);
    for (let k = 1; k < r.points.length; k++) {
      const rise = r.points[k]!.y - r.points[k - 1]!.y;
      if (rise > CLIMB_JUMP_RISE_MAX + 1e-9) e.push(`climbRoutes.${r.id}[${k}]: rise ${rise.toFixed(3)} > ${CLIMB_JUMP_RISE_MAX}`);
    }
  }
  if (!(stepHeight > 0)) e.push('stepHeight must be > 0');
  return e;
}
