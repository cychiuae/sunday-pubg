/**
 * Third-person camera placement + collision. Owner: graphics-engineer.
 *
 * Pure math (no three.js) so it is unit-testable: `desiredCameraPosition` turns a CameraView into a world point,
 * `CameraObstacles.segmentFraction` finds how far along pivot -> camera the view is free of terrain, water and
 * prop cylinders. `CameraRig` adds smoothing (snap in, ease out) and is the only stateful part.
 */
import type { CameraView } from '../shared/contracts';
import type { Rect, Vec3 } from '../shared/types';

export type HeightFn = (x: number, z: number) => number;

/**
 * Vertical prism obstacle (world space): a cylinder of radius `r`, or, when `box` is set, an oriented box. For boxes
 * `r` must be the bounding radius (used for grid bucketing only). Same frame as the sim's BoxCollider: local X ->
 * world (cos, -sin), local Z -> world (sin, cos).
 */
export interface CameraCollider {
  x: number;
  z: number;
  r: number;
  bottom: number;
  top: number;
  box?: { hx: number; hz: number; sin: number; cos: number };
}

/**
 * Entry parameter t in [0, 1] of the 2D segment (ax, az) + t (dx, dz) into the box padded by `pad`, or -1 if it misses
 * or the start point is already inside (pivot inside: ignored, as for cylinders). Pure; exported for tests.
 */
export function segmentBoxEntry(
  c: CameraCollider & { box: NonNullable<CameraCollider['box']> },
  ax: number, az: number, dx: number, dz: number, pad: number,
): number {
  const { hx, hz, sin, cos } = c.box;
  const px = ax - c.x, pz = az - c.z;
  // World -> local: lx = x cos - z sin, lz = x sin + z cos.
  const lx = px * cos - pz * sin, lz = px * sin + pz * cos;
  const ldx = dx * cos - dz * sin, ldz = dx * sin + dz * cos;
  const ex = hx + pad, ez = hz + pad;
  if (Math.abs(lx) <= ex && Math.abs(lz) <= ez) return -1;
  let t0 = 0, t1 = 1;
  if (Math.abs(ldx) < 1e-12) {
    if (Math.abs(lx) > ex) return -1;
  } else {
    let ta = (-ex - lx) / ldx, tb = (ex - lx) / ldx;
    if (ta > tb) { const k = ta; ta = tb; tb = k; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
  }
  if (Math.abs(ldz) < 1e-12) {
    if (Math.abs(lz) > ez) return -1;
  } else {
    let ta = (-ez - lz) / ldz, tb = (ez - lz) / ldz;
    if (ta > tb) { const k = ta; ta = tb; tb = k; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
  }
  return t0 <= t1 ? t0 : -1;
}

export interface CameraCollisionOptions {
  /** Metres the camera keeps above terrain. */
  terrainClearance: number;
  /** Lowest camera y over open water (sea level + this). */
  waterClearance: number;
  /** Camera sphere radius used to pad collisions (near plane + margin). */
  radius: number;
  /** Shortest allowed distance from the pivot after a pull-in. */
  minDistance: number;
}

export const DEFAULT_CAMERA_COLLISION: CameraCollisionOptions = {
  terrainClearance: 0.3,
  waterClearance: 0.25,
  radius: 0.2,
  minDistance: 0.35,
};

/** Writes the un-collided camera position for `cam` into `out` and returns it. */
export function desiredCameraPosition(cam: CameraView, out: Vec3): Vec3 {
  const cp = Math.cos(cam.pitch);
  // aim = (-sin yaw * cos pitch, sin pitch, -cos yaw * cos pitch); right = (cos yaw, 0, -sin yaw)
  const ax = -Math.sin(cam.yaw) * cp;
  const ay = Math.sin(cam.pitch);
  const az = -Math.cos(cam.yaw) * cp;
  const rx = Math.cos(cam.yaw);
  const rz = -Math.sin(cam.yaw);
  out.x = cam.target.x + rx * cam.shoulderOffset - ax * cam.distance;
  out.y = cam.target.y - ay * cam.distance;
  out.z = cam.target.z + rz * cam.shoulderOffset - az * cam.distance;
  return out;
}

/**
 * Static obstacle set for camera collision: terrain height function + vertical cylinders bucketed in a uniform
 * grid. Allocation-free queries.
 */
export class CameraObstacles {
  /** M2b indoor: highest camera y (the ceiling plane minus a clearance), or Infinity outdoors. */
  ceiling = Infinity;
  /** M2b indoor: the camera stays inside this rectangle (the floor inset by the camera radius), or null. */
  bounds: Rect | null = null;
  private readonly cells: Int32Array[];
  private readonly n: number;
  private readonly origin: number;
  private readonly cellSize: number;
  private readonly stamp: Int32Array;
  private query = 0;

  constructor(
    private readonly heightAt: HeightFn,
    private readonly colliders: readonly CameraCollider[],
    extent: number,
    cellSize = 8,
    private readonly opts: CameraCollisionOptions = DEFAULT_CAMERA_COLLISION,
  ) {
    this.cellSize = cellSize;
    this.n = Math.max(1, Math.ceil((extent * 2) / cellSize));
    this.origin = -extent;
    const lists: number[][] = Array.from({ length: this.n * this.n }, () => []);
    colliders.forEach((c, i) => {
      const x0 = this.cellOf(c.x - c.r), x1 = this.cellOf(c.x + c.r);
      const z0 = this.cellOf(c.z - c.r), z1 = this.cellOf(c.z + c.r);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) lists[cz * this.n + cx].push(i);
    });
    this.cells = lists.map((l) => Int32Array.from(l));
    this.stamp = new Int32Array(colliders.length);
  }

  private cellOf(v: number): number {
    const c = Math.floor((v - this.origin) / this.cellSize);
    return c < 0 ? 0 : c >= this.n ? this.n - 1 : c;
  }

  /**
   * M2b indoor limits: the camera stays `clearance` below `ceilingY` (nothing renders above the ceiling) and inside
   * `rect` inset by `clearance`. Pass null / Infinity to clear.
   */
  setLimits(ceilingY: number, rect: Rect | null, clearance = 0.6): void {
    this.ceiling = Number.isFinite(ceilingY) ? ceilingY - clearance : Infinity;
    this.bounds = rect
      ? { minX: rect.minX + clearance, minZ: rect.minZ + clearance, maxX: rect.maxX - clearance, maxZ: rect.maxZ - clearance }
      : null;
  }

  /** Clamp a camera point to the ceiling and bounds limits (in place). */
  clampLimits(p: Vec3): void {
    if (p.y > this.ceiling) p.y = this.ceiling;
    const b = this.bounds;
    if (!b) return;
    if (p.x < b.minX) p.x = b.minX;
    else if (p.x > b.maxX) p.x = b.maxX;
    if (p.z < b.minZ) p.z = b.minZ;
    else if (p.z > b.maxZ) p.z = b.maxZ;
  }

  /** Lowest allowed camera y at (x, z). */
  floorAt(x: number, z: number): number {
    const h = this.heightAt(x, z) + this.opts.terrainClearance;
    const w = this.opts.waterClearance;
    return h > w ? h : w;
  }

  /**
   * Fraction in [0, 1] of the segment a -> b that the camera can travel before hitting terrain/water or a collider
   * (already padded by the camera radius). 1 = unobstructed.
   */
  segmentFraction(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return 1;
    let best = 1;

    // Terrain / water: march, then bisect the first crossing.
    const steps = Math.max(4, Math.ceil(len / 0.25));
    let prevT = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (ay + dy * t < this.floorAt(ax + dx * t, az + dz * t)) {
        let lo = prevT, hi = t;
        for (let k = 0; k < 6; k++) {
          const mid = (lo + hi) * 0.5;
          if (ay + dy * mid < this.floorAt(ax + dx * mid, az + dz * mid)) hi = mid;
          else lo = mid;
        }
        best = lo;
        break;
      }
      prevT = t;
    }

    // Prisms (2D segment vs circle or oriented box, then height check at the entry point).
    if (this.colliders.length > 0) {
      this.query++;
      const pad = this.opts.radius;
      const minX = Math.min(ax, bx) - pad, maxX = Math.max(ax, bx) + pad;
      const minZ = Math.min(az, bz) - pad, maxZ = Math.max(az, bz) + pad;
      const x0 = this.cellOf(minX), x1 = this.cellOf(maxX), z0 = this.cellOf(minZ), z1 = this.cellOf(maxZ);
      const a2 = dx * dx + dz * dz;
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const list = this.cells[cz * this.n + cx];
          for (let j = 0; j < list.length; j++) {
            const idx = list[j];
            if (this.stamp[idx] === this.query) continue;
            this.stamp[idx] = this.query;
            const c = this.colliders[idx];
            if (c.box) {
              const t = segmentBoxEntry(c as CameraCollider & { box: NonNullable<CameraCollider['box']> }, ax, az, dx, dz, pad);
              if (t < 0 || t >= best) continue;
              const y = ay + dy * t;
              if (y < c.bottom - pad || y > c.top + pad) continue;
              best = t;
              continue;
            }
            const r = c.r + pad;
            const fx = ax - c.x, fz = az - c.z;
            const cc = fx * fx + fz * fz - r * r;
            if (cc <= 0) continue; // pivot inside (visual collider larger than sim's): ignore
            if (a2 < 1e-9) continue;
            const bq = 2 * (fx * dx + fz * dz);
            const disc = bq * bq - 4 * a2 * cc;
            if (disc < 0) continue;
            const t = (-bq - Math.sqrt(disc)) / (2 * a2);
            if (t < 0 || t >= best) continue;
            const y = ay + dy * t;
            if (y < c.bottom - pad || y > c.top + pad) continue;
            best = t;
          }
        }
      }
    }
    return best;
  }
}

/** Metres kept above the floor (terrain + clearance) when the boom slides along it. */
const FLOOR_SLIDE_MARGIN = 0.1;

/**
 * BUG-003: looking up swings the boom end below the ground. Pulling the camera in along the boom would drag it to the
 * pivot (neck height, head filling the screen). Instead, keep the boom length and slide its end along the floor,
 * farther behind the player: the camera sits low and behind, looking up past the character, as in most third-person
 * shooters. Continuous with the normal boom at the pitch where the boom end first touches the floor. Leaves `d` alone
 * when the pivot itself is at or below the floor (wading, walls, hills behind): normal collision handles those.
 * Writes into `d`. Exported for tests.
 */
export function slideAlongFloor(cam: CameraView, d: Vec3, obstacles: CameraObstacles): void {
  const t = cam.target;
  let floor = obstacles.floorAt(d.x, d.z) + FLOOR_SLIDE_MARGIN;
  if (d.y >= floor) return;
  const len = Math.hypot(d.x - t.x, d.y - t.y, d.z - t.z);
  let hx = d.x - t.x;
  let hz = d.z - t.z;
  let hl = Math.hypot(hx, hz);
  if (hl < 1e-4) {
    // Straight up with no shoulder offset: "behind" is -aim projected, i.e. (sin yaw, cos yaw).
    hx = Math.sin(cam.yaw);
    hz = Math.cos(cam.yaw);
    hl = 1;
  }
  // Two passes so the end settles on sloped ground (the floor is re-read at the new spot).
  for (let k = 0; k < 2; k++) {
    const h = t.y - floor;
    if (h <= 0.05) return;
    const horiz = Math.sqrt(Math.max(len * len - h * h, 0));
    const s = Math.max(horiz, hl) / hl;
    d.x = t.x + hx * s;
    d.z = t.z + hz * s;
    d.y = floor;
    floor = obstacles.floorAt(d.x, d.z) + FLOOR_SLIDE_MARGIN;
  }
  if (d.y < floor) d.y = floor;
}

/**
 * M2b indoor: looking down at the subject swings the boom end above the ceiling (the carrier orbit flies 2 m under
 * it). Same idea as slideAlongFloor: keep the boom length, put the end on the ceiling clamp and move it farther out
 * horizontally, so the subject stays framed instead of the camera collapsing onto it. Writes into `d`. Exported for
 * tests.
 */
export function slideAlongCeiling(cam: CameraView, d: Vec3, obstacles: CameraObstacles): void {
  const ceil = obstacles.ceiling;
  const t = cam.target;
  if (!(d.y > ceil) || t.y >= ceil) return;
  const len = Math.hypot(d.x - t.x, d.y - t.y, d.z - t.z);
  let hx = d.x - t.x, hz = d.z - t.z;
  let hl = Math.hypot(hx, hz);
  if (hl < 1e-4) {
    hx = Math.sin(cam.yaw);
    hz = Math.cos(cam.yaw);
    hl = 1;
  }
  const h = ceil - t.y;
  const horiz = Math.sqrt(Math.max(len * len - h * h, 0));
  const s = Math.max(horiz, hl) / hl;
  d.x = t.x + hx * s;
  d.z = t.z + hz * s;
  d.y = ceil;
}

/**
 * Stateful wrapper: resolves the camera position each frame. Pull-ins snap immediately (never clip), releases
 * ease back out so the camera does not pop when an obstacle passes.
 */
export class CameraRig {
  /** Current allowed fraction of the requested boom length. */
  private fraction = 1;
  private readonly desired: Vec3 = { x: 0, y: 0, z: 0 };
  readonly position: Vec3 = { x: 0, y: 0, z: 0 };
  /** Distance from the pivot after collision (m). */
  actualDistance = 0;

  constructor(
    private obstacles: CameraObstacles | null,
    private readonly releaseRate = 4,
    private readonly opts: CameraCollisionOptions = DEFAULT_CAMERA_COLLISION,
  ) {}

  setObstacles(obstacles: CameraObstacles | null): void {
    this.obstacles = obstacles;
  }

  /** Snap (no easing) on the next update, e.g. after a teleport or mode change. */
  reset(): void {
    this.fraction = -1;
  }

  /**
   * @param collide false for the title/lobby orbit: its pivot may be underground (island centre at y = 0), so only
   *        the terrain/water floor clamp applies.
   */
  update(cam: CameraView, dt: number, collide = true): Vec3 {
    const d = desiredCameraPosition(cam, this.desired);
    if (collide && this.obstacles) {
      slideAlongFloor(cam, d, this.obstacles);
      slideAlongCeiling(cam, d, this.obstacles);
    }
    const t = cam.target;
    const len = Math.hypot(d.x - t.x, d.y - t.y, d.z - t.z);
    let allowed = 1;
    if (collide && this.obstacles && len > 1e-4) {
      allowed = this.obstacles.segmentFraction(t.x, t.y, t.z, d.x, d.y, d.z);
      // Keep a little gap in front of the obstacle, but never closer than minDistance.
      if (allowed < 1) allowed = Math.max(Math.min(this.opts.minDistance / len, 1), allowed - this.opts.radius / len);
    }
    if (this.fraction < 0 || allowed < this.fraction) this.fraction = allowed;
    else this.fraction += (allowed - this.fraction) * (1 - Math.exp(-this.releaseRate * dt));

    const f = this.fraction;
    const p = this.position;
    p.x = t.x + (d.x - t.x) * f;
    p.y = t.y + (d.y - t.y) * f;
    p.z = t.z + (d.z - t.z) * f;
    // Final safety: never below terrain/water even if the pivot itself is low (e.g. wading); M2b: never above the
    // ceiling or outside the indoor floor.
    if (this.obstacles) {
      this.obstacles.clampLimits(p);
      const floor = this.obstacles.floorAt(p.x, p.z);
      if (p.y < floor) p.y = floor;
    }
    this.actualDistance = len * f;
    return p;
  }
}
