/**
 * Level-side geometry for indoor maps (office). Owner: level-designer.
 *
 * Plain data math over an IndoorMapData and its kit: placed collider prisms, footprint distances, walkable tops,
 * loot / spawn clearance rules (docs/design/levels/office.md §6, §7) and a coarse reachability flood per height
 * layer. The office generator uses it to nudge loot and spawns and to place clutter; the level tests use it to check
 * the invariants. It is NOT the sim's collision code (src/shared/sim/colliders.ts): it is deliberately simple,
 * conservative and dependency-free (no balance, no three.js).
 */
import type { IndoorMapData, IndoorPropPlacement, KitCollider, PropKit, Rect, Vec2, WallSegment } from '../../shared/types';
import { wallFrame } from '../../shared/maps';

/**
 * ADR 0005 §3 stair rule for kit ramps: the sim compiles a ramp to steps of rise <= 0.8 x movement.stepHeight
 * (0.35 today), i.e. 0.28 m. The whiteboard ramp becomes 24 steps of 0.2775 m (src/shared/kits/office.ts header).
 * Ramp climb-route waypoints sit on those steps.
 */
export const RAMP_STEP_RISE = 0.28;
/** office.md §6: loot keeps >= 0.75 m from prop footprints that rise above a step at its level. */
export const LOOT_PROP_CLEARANCE = 0.75;
/** office.md §7.1: drop targets keep >= 2.5 m (2D) from every collider. */
export const SPAWN_CLEARANCE = 2.5;
/** A raised top supports a point (loot, waypoint) only this far inside its footprint edge. */
export const SUPPORT_INSET = 0.3;

/** One collider part as a vertical prism in world space. */
export interface Solid {
  shape: 'box' | 'cyl' | 'ramp';
  /** Footprint centre. */
  cx: number;
  cz: number;
  /** Box / ramp half extents along the part's local X and Z (scaled). Cylinders: both = r. */
  hx: number;
  hz: number;
  /** Cylinder radius (0 for boxes and ramps). */
  r: number;
  /** cos / sin of the placement rotY (Three.js convention: local +X -> (cos, -sin), local +Z -> (sin, cos)). */
  cos: number;
  sin: number;
  y0: number;
  y1: number;
  /** `${kind}.${part}` for props, `wall.${material}` for walls. */
  label: string;
  /** Prop index (>= 0) or -1 - wall index. */
  prop: number;
}

/** A placed kit collider part. */
export function placedSolid(p: IndoorPropPlacement, c: KitCollider, prop: number): Solid {
  const s = p.scale;
  const cos = Math.cos(p.rotY);
  const sin = Math.sin(p.rotY);
  const label = `${p.kind}.${c.name}`;
  if (c.type === 'cylinder') {
    const lx = c.x * s;
    const lz = c.z * s;
    const r = c.r * s;
    return {
      shape: 'cyl', cx: p.x + lx * cos + lz * sin, cz: p.z - lx * sin + lz * cos, hx: r, hz: r, r, cos, sin,
      y0: p.y + c.y0 * s, y1: p.y + c.y1 * s, label, prop,
    };
  }
  const lx = ((c.min[0] + c.max[0]) / 2) * s;
  const lz = ((c.min[2] + c.max[2]) / 2) * s;
  return {
    shape: c.type === 'ramp' ? 'ramp' : 'box',
    cx: p.x + lx * cos + lz * sin,
    cz: p.z - lx * sin + lz * cos,
    hx: ((c.max[0] - c.min[0]) / 2) * s,
    hz: ((c.max[2] - c.min[2]) / 2) * s,
    r: 0,
    cos,
    sin,
    y0: p.y + c.min[1] * s,
    y1: p.y + c.max[1] * s,
    label,
    prop,
  };
}

/** A wall segment as a box prism (through the shared wallFrame, like the sim and the renderer). */
export function wallSolid(w: WallSegment, index: number): Solid {
  const f = wallFrame(w);
  return {
    shape: 'box', cx: f.cx, cz: f.cz, hx: f.halfLength, hz: f.halfThickness, r: 0,
    cos: Math.cos(f.rotY), sin: Math.sin(f.rotY), y0: w.bottom, y1: w.top, label: `wall.${w.material}`, prop: -1 - index,
  };
}

/** Every collider part of `props` (visual-only kinds have none). */
export function propSolids(kit: PropKit, props: readonly IndoorPropPlacement[], firstIndex = 0): Solid[] {
  const out: Solid[] = [];
  props.forEach((p, i) => {
    const entry = kit[p.kind];
    if (!entry) return;
    for (const c of entry.colliders) out.push(placedSolid(p, c, firstIndex + i));
  });
  return out;
}

/** Walls + props of an indoor map. */
export function mapSolids(map: IndoorMapData): Solid[] {
  return [...map.walls.map((w, i) => wallSolid(w, i)), ...propSolids(map.kit, map.props)];
}

/** World (x, z) into the solid's local frame (relative to its footprint centre). */
export function toLocal(s: Solid, x: number, z: number): [number, number] {
  const dx = x - s.cx;
  const dz = z - s.cz;
  return [dx * s.cos - dz * s.sin, dx * s.sin + dz * s.cos];
}

/** 2D distance from (x, z) to the solid's footprint (0 inside). */
export function footprintDist(s: Solid, x: number, z: number): number {
  if (s.shape === 'cyl') return Math.max(Math.hypot(x - s.cx, z - s.cz) - s.r, 0);
  const [lx, lz] = toLocal(s, x, z);
  return Math.hypot(Math.max(Math.abs(lx) - s.hx, 0), Math.max(Math.abs(lz) - s.hz, 0));
}

/** Is (x, z) inside the footprint, at least `inset` from its edge? */
export function footprintContains(s: Solid, x: number, z: number, inset = 0): boolean {
  if (s.shape === 'cyl') return Math.hypot(x - s.cx, z - s.cz) <= s.r - inset;
  const [lx, lz] = toLocal(s, x, z);
  return Math.abs(lx) <= s.hx - inset && Math.abs(lz) <= s.hz - inset;
}

/** Axis-aligned bounds of the footprint. */
export function solidAabb(s: Solid): Rect {
  const ex = s.shape === 'cyl' ? s.r : Math.abs(s.hx * s.cos) + Math.abs(s.hz * s.sin);
  const ez = s.shape === 'cyl' ? s.r : Math.abs(s.hx * s.sin) + Math.abs(s.hz * s.cos);
  return { minX: s.cx - ex, maxX: s.cx + ex, minZ: s.cz - ez, maxZ: s.cz + ez };
}

/**
 * Walkable top of the solid at (x, z) (assumes the point is inside the footprint). Ramps use the sim's stair
 * compilation (RAMP_STEP_RISE): the low edge is local +Z, the high edge local -Z.
 */
export function topAt(s: Solid, x: number, z: number): number {
  if (s.shape !== 'ramp') return s.y1;
  const h = s.y1 - s.y0;
  const n = Math.max(1, Math.ceil(h / RAMP_STEP_RISE - 1e-9));
  const tread = (2 * s.hz) / n;
  const [, lz] = toLocal(s, x, z);
  const step = Math.min(n, Math.max(1, Math.ceil((s.hz - lz) / tread - 1e-9)));
  return s.y0 + (step * h) / n;
}

/** Highest walkable top at (x, z) that is <= maxY (the floor, 0, when there is none). */
export function supportTop(solids: readonly Solid[], x: number, z: number, maxY: number, inset = 0.05): number {
  let best = 0;
  for (const s of solids) {
    if (s.y0 > maxY || !footprintContains(s, x, z, inset)) continue;
    const t = topAt(s, x, z);
    if (t <= maxY && t > best) best = t;
  }
  return best;
}

/** Is (x, y, z) standing on a raised flat top (box or cylinder) at height y? y <= 0.01 is the floor. */
export function supportedAt(solids: readonly Solid[], x: number, y: number, z: number, inset = SUPPORT_INSET): boolean {
  if (y <= 0.01) return true;
  return solids.some((s) => s.shape !== 'ramp' && Math.abs(s.y1 - y) <= 0.05 && footprintContains(s, x, z, inset));
}

const insideRect = (r: Rect, x: number, z: number, inset: number): boolean =>
  x >= r.minX + inset && x <= r.maxX - inset && z >= r.minZ + inset && z <= r.maxZ - inset;

/**
 * office.md §6 loot rule, null when fine:
 * - inside the floor (inset by the clearance), and on a walkable top at y (floor or a raised flat top);
 * - >= LOOT_PROP_CLEARANCE from every part that rises more than a step above y and starts below y + 1 m;
 * - not inside any lower part (a keyboard, a mug) that sits above its level.
 */
export function lootSpotIssue(solids: readonly Solid[], floor: Rect, x: number, y: number, z: number, stepHeight = 0.35): string | null {
  if (!insideRect(floor, x, z, LOOT_PROP_CLEARANCE)) return 'outside the floor';
  if (!supportedAt(solids, x, y, z)) return `no walkable top at y ${y}`;
  for (const s of solids) {
    if (s.y0 >= y + 1.0 || s.y1 <= y + 0.01) continue;
    const d = footprintDist(s, x, z);
    if (s.y1 > y + stepHeight) {
      if (d < LOOT_PROP_CLEARANCE) return `${s.label} only ${d.toFixed(2)} m away`;
    } else if (d <= 0) {
      return `inside ${s.label}`;
    }
  }
  return null;
}

/** office.md §7.1 drop-target rule, null when fine: >= SPAWN_CLEARANCE (2D) from every collider and the floor edge. */
export function spawnIssue(solids: readonly Solid[], floor: Rect, x: number, z: number): string | null {
  if (!insideRect(floor, x, z, SPAWN_CLEARANCE)) return 'too close to the floor edge';
  for (const s of solids) {
    const d = footprintDist(s, x, z);
    if (d < SPAWN_CLEARANCE) return `${s.label} only ${d.toFixed(2)} m away`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Reachability: a coarse occupancy grid per walkable height (the floor, the desk plateaus, ...)
// ---------------------------------------------------------------------------------------------
export interface LayerOptions {
  cell: number;
  /** Player radius: blockers are inflated by it. */
  radius: number;
  /** Player standing height: parts starting at or above y + this do not block. */
  standHeight: number;
  /** Parts whose top is at or below y + this are stepped over. */
  stepHeight: number;
}

export interface LayerGrid {
  y: number;
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  /** 1 = walkable cell (supported at y and not blocked). */
  free: Uint8Array;
}

function rasterize(g: LayerGrid, s: Solid, pad: number, strict: boolean, fn: (i: number) => void): void {
  const a = solidAabb(s);
  const i0 = Math.max(0, Math.floor((a.minX - pad - g.x0) / g.cell));
  const i1 = Math.min(g.nx - 1, Math.floor((a.maxX + pad - g.x0) / g.cell));
  const j0 = Math.max(0, Math.floor((a.minZ - pad - g.z0) / g.cell));
  const j1 = Math.min(g.nz - 1, Math.floor((a.maxZ + pad - g.z0) / g.cell));
  for (let j = j0; j <= j1; j++) {
    const z = g.z0 + (j + 0.5) * g.cell;
    for (let i = i0; i <= i1; i++) {
      const d = footprintDist(s, g.x0 + (i + 0.5) * g.cell, z);
      if (strict ? d < pad : d <= pad) fn(j * g.nx + i);
    }
  }
}

/**
 * Walkable cells at height y. y <= 0.01 is the floor (everything inside the rectangle); higher layers are the union
 * of flat tops at y (within 5 cm; footprints grown by 0.1 m so the 4 cm cracks between flush desks join).
 */
export function buildLayer(solids: readonly Solid[], floor: Rect, y: number, o: LayerOptions): LayerGrid {
  const nx = Math.ceil((floor.maxX - floor.minX) / o.cell);
  const nz = Math.ceil((floor.maxZ - floor.minZ) / o.cell);
  const g: LayerGrid = { y, x0: floor.minX, z0: floor.minZ, cell: o.cell, nx, nz, free: new Uint8Array(nx * nz) };
  if (y <= 0.01) g.free.fill(1);
  else {
    for (const s of solids) {
      if (s.shape === 'ramp' || Math.abs(s.y1 - y) > 0.05) continue;
      rasterize(g, s, 0.1, false, (i) => {
        g.free[i] = 1;
      });
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (!insideRect(floor, g.x0 + (i + 0.5) * o.cell, g.z0 + (j + 0.5) * o.cell, o.radius)) g.free[j * nx + i] = 0;
    }
  }
  for (const s of solids) {
    if (s.y0 >= y + o.standHeight || s.y1 <= y + o.stepHeight) continue;
    rasterize(g, s, o.radius, true, (i) => {
      g.free[i] = 0;
    });
  }
  return g;
}

/** Index of the nearest cell set in `mask` whose centre is within `within` of (x, z); -1 if none. */
export function nearCell(g: LayerGrid, mask: Uint8Array, x: number, z: number, within: number): number {
  const ci = Math.floor((x - g.x0) / g.cell);
  const cj = Math.floor((z - g.z0) / g.cell);
  const k = Math.ceil(within / g.cell) + 1;
  let best = -1;
  let bestD = Infinity;
  for (let j = cj - k; j <= cj + k; j++) {
    if (j < 0 || j >= g.nz) continue;
    for (let i = ci - k; i <= ci + k; i++) {
      if (i < 0 || i >= g.nx) continue;
      const idx = j * g.nx + i;
      if (!mask[idx]) continue;
      const d = Math.hypot(g.x0 + (i + 0.5) * g.cell - x, g.z0 + (j + 0.5) * g.cell - z);
      if (d <= within && d < bestD) {
        bestD = d;
        best = idx;
      }
    }
  }
  return best;
}

/** 4-neighbour flood over free cells from the free cells nearest to each seed (within `within`). */
export function flood(g: LayerGrid, seeds: readonly Vec2[], within = 1.0): Uint8Array {
  const reached = new Uint8Array(g.free.length);
  const queue = new Int32Array(g.free.length);
  let head = 0;
  let tail = 0;
  for (const s of seeds) {
    const i = nearCell(g, g.free, s.x, s.z, within);
    if (i >= 0 && !reached[i]) {
      reached[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % g.nx;
    const push = (n: number): void => {
      if (g.free[n] && !reached[n]) {
        reached[n] = 1;
        queue[tail++] = n;
      }
    };
    if (x > 0) push(i - 1);
    if (x < g.nx - 1) push(i + 1);
    if (i >= g.nx) push(i - g.nx);
    if (i + g.nx < g.free.length) push(i + g.nx);
  }
  return reached;
}
