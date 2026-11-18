/**
 * Indoor bot navigation (ADR 0005 §6, maps.md §4). Owner: game-developer (bots/nav).
 *
 * A layered grid graph over every walkable surface of an indoor map: the floor (y = 0) and every collider top a
 * standing chibi fits on (desk plateaus, cabinets, room tables, perch towers). Cells are `bots.nav.cellSize` wide.
 * - **Nodes.** One per (cell, surface). A surface exists where the movement ground rule (the highest collider top at
 *   or below feet + stepHeight that contains the cell centre, or the floor) is stable and the standing body, inflated
 *   by player.radius + NAV_AI.clearanceMargin, overlaps no collider that spans standing height (bottom below the head,
 *   top above feet + stepHeight).
 * - **Walk links** to the 8 neighbours whose ground (for feet at this node's height) is a node within stepHeight. No
 *   corner cutting: a diagonal needs both orthogonal links.
 * - **Drop links** (one way, orthogonal): walking off an edge onto a lower node, when the fall is clear and deals no
 *   fall damage (impact speed <= movement.fallDamageMinSpeed of the effective balance).
 * - **Climb links** from `map.climbRoutes`: bottom -> top costs route length x `bots.nav.climbCostMultiplier`; top ->
 *   bottom (walking the route back down) costs the route length. Bots jump where a route rise exceeds stepHeight.
 *
 * Pure and deterministic: no RNG, no module-level state (scratch buffers live in the World-owned PathCache). A* breaks
 * ties by node id. The graph is built once per map (prepareMap cache) and shared by every World on that map.
 */
import type { Balance, BotNavBalance } from '../balance';
import type { IndoorMapData, Vec3 } from '../types';
import { type ColliderSet, containsPoint, forEachColliderNear, overlapsCircle } from './colliders';

export type NavNodeId = number;

export interface NavGraph {
  readonly mapId: string;
  readonly nodeCount: number;
  /** Stable digest of nodes and links (determinism tests: same map + balance -> same hash). */
  readonly hash: string;
}

export interface NavPath {
  points: Vec3[];
  /** true where reaching points[i] needs a jump (rise > stepHeight). */
  jump: boolean[];
  /** true where points[i] is a climb-route waypoint (followers commit to a route once on it). */
  route: boolean[];
  /** Polyline length, metres (zone urgency). */
  length: number;
  /** Climb-up links on the path (bots do not chase a target up a climb route). */
  climbs: number;
}

/** `balance.bots.nav` (required since the C-gate). Kept as an accessor for callers; it adds nothing. */
export const navTuning = (b: Balance): BotNavBalance => b.bots.nav;

/** Nav plumbing (geometry tolerances and search limits, not design tuning). */
export const NAV_AI = {
  /** Extra clearance beyond player.radius when testing a cell (keeps paths off wall faces). */
  clearanceMargin: 0.15,
  /** Extra cost (m) to enter a node next to a drop edge (paths keep off plateau rims). */
  edgePenalty: 0.75,
  /** Climb-route ends snap to a node within this horizontal radius (m) and this vertical difference (m). */
  routeSnapRadius: 3,
  routeSnapDy: 1.0,
  /** nearestNode searches rings of cells up to this radius (m). */
  snapRadius: 16,
  /** Start-node lookup: nearest node within this radius (m) when the bot's own cell is blocked. */
  startSnapRadius: 2.5,
  /** Path smoothing: sample spacing as a fraction of cellSize, and the max nodes skipped by one straight segment. */
  smoothSampleFraction: 0.25,
  smoothMaxSkip: 48,
  /**
   * The A* heuristic is scaled by this: it breaks the many equal-f ties of a grid toward the goal, so open floor is not
   * flooded. Paths stay within this factor of the shortest (0.1%). Remaining ties still go by node id.
   */
  heuristicTieBreak: 1.001,
  /**
   * A* node expansions per World tick across all bot searches (server tick budget, ARCHITECTURE §11). A search that
   * needs more continues on the next ticks. About 0.15-0.3 ms per 1,000 on the office.
   */
  maxExpansionsPerTick: 8000,
  /** Surfaces closer than this (m) are the same surface. */
  epsilon: 1e-4,
};

const EDGE_WALK = 0;
const EDGE_DROP = 1;
const EDGE_CLIMB = 2;
const EDGE_CLIMB_DOWN = 3;

/** Internal graph representation. Exported for bots.ts helpers and tests; treat as read-only. */
export class NavGraphData implements NavGraph {
  readonly mapId: string;
  readonly nodeCount: number;
  readonly hash: string;
  readonly cell: number;
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly stepHeight: number;
  /** Nodes of column c are colStart[c] .. colStart[c + 1] - 1, sorted by y ascending. */
  readonly colStart: Int32Array;
  readonly nodeY: Float64Array;
  readonly nodeCol: Int32Array;
  /** Cell-centre x and z per node (derived from nodeCol; the A* heuristic). */
  readonly nodeX: Float64Array;
  readonly nodeZ: Float64Array;
  /** CSR adjacency. */
  readonly adjStart: Int32Array;
  readonly adjTo: Int32Array;
  readonly adjCost: Float64Array;
  readonly adjKind: Uint8Array;
  /** Climb route index for climb links, -1 otherwise. */
  readonly adjRoute: Int32Array;
  /** 1 = in the main strongly connected component (reachable from and back to everywhere that matters). */
  readonly main: Uint8Array;
  /** Main-component nodes above the jump cap (desk plateaus, tables, perches), ascending id. */
  readonly plateauNodes: Int32Array;
  readonly routes: readonly (readonly Vec3[])[];
  readonly routeIds: readonly string[];
  /** Route mode 'walk' (ramps): never jump on it, whatever the waypoint rises. */
  readonly routeWalk: readonly boolean[];
  /** Climb route ids whose ends did not snap to two distinct nodes (level tests). */
  readonly unlinkedRoutes: readonly string[];
  readonly colliders: ColliderSet;
  readonly standHeight: number;
  readonly clearance: number;

  constructor(f: Omit<NavGraphData, 'nodeCount' | 'nodeX' | 'nodeZ'>) {
    this.mapId = f.mapId;
    this.hash = f.hash;
    this.cell = f.cell;
    this.minX = f.minX;
    this.minZ = f.minZ;
    this.cols = f.cols;
    this.rows = f.rows;
    this.stepHeight = f.stepHeight;
    this.colStart = f.colStart;
    this.nodeY = f.nodeY;
    this.nodeCol = f.nodeCol;
    this.nodeCount = f.nodeY.length;
    this.nodeX = new Float64Array(this.nodeCount);
    this.nodeZ = new Float64Array(this.nodeCount);
    for (let n = 0; n < this.nodeCount; n++) {
      const c = f.nodeCol[n]!;
      const col = c % f.cols;
      this.nodeX[n] = f.minX + (col + 0.5) * f.cell;
      this.nodeZ[n] = f.minZ + ((c - col) / f.cols + 0.5) * f.cell;
    }
    this.adjStart = f.adjStart;
    this.adjTo = f.adjTo;
    this.adjCost = f.adjCost;
    this.adjKind = f.adjKind;
    this.adjRoute = f.adjRoute;
    this.main = f.main;
    this.plateauNodes = f.plateauNodes;
    this.routes = f.routes;
    this.routeIds = f.routeIds;
    this.routeWalk = f.routeWalk;
    this.unlinkedRoutes = f.unlinkedRoutes;
    this.colliders = f.colliders;
    this.standHeight = f.standHeight;
    this.clearance = f.clearance;
  }
}

const data = (g: NavGraph): NavGraphData => g as NavGraphData;

/** World position of a node (cell centre at the surface height). */
export function nodePos(g: NavGraph, id: NavNodeId): Vec3 {
  const d = data(g);
  const c = d.nodeCol[id]!;
  const col = c % d.cols;
  const row = (c - col) / d.cols;
  return { x: d.minX + (col + 0.5) * d.cell, y: d.nodeY[id]!, z: d.minZ + (row + 0.5) * d.cell };
}

/** The static colliders the graph was built from (bots' jump probes). */
export const navColliders = (g: NavGraph): ColliderSet => data(g).colliders;

/** Main-component plateau nodes (ids ascending). */
export const plateauNodes = (g: NavGraph): Int32Array => data(g).plateauNodes;

/** Is the node in the main strongly connected component? */
export const isReachableNode = (g: NavGraph, id: NavNodeId): boolean => id >= 0 && id < g.nodeCount && data(g).main[id] === 1;

// ---------------------------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------------------------

/** FNV-1a over 32-bit words, two lanes. */
class Hasher {
  private a = 0x811c9dc5;
  private b = 0x01000193 ^ 0x5bd1e995;
  word(v: number): void {
    const w = v | 0;
    for (let k = 0; k < 4; k++) {
      const byte = (w >>> (k * 8)) & 0xff;
      this.a = Math.imul(this.a ^ byte, 0x01000193);
      this.b = Math.imul(this.b ^ byte, 0x01000197);
    }
  }
  num(v: number): void {
    this.word(Math.round(v * 1000));
  }
  hex(): string {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }
}

export function buildNavGraph(map: IndoorMapData, colliders: ColliderSet, b: Balance): NavGraph {
  const tun = navTuning(b);
  const cell = tun.cellSize;
  const step = b.movement.stepHeight;
  const standH = b.movement.stances.stand.height;
  const radius = b.player.radius;
  const clear = radius + NAV_AI.clearanceMargin;
  const eps = NAV_AI.epsilon;
  const f = map.floor;
  const minX = f.minX;
  const minZ = f.minZ;
  const cols = Math.max(1, Math.floor((f.maxX - f.minX) / cell));
  const rows = Math.max(1, Math.floor((f.maxZ - f.minZ) / cell));
  const nCols = cols * rows;
  const ceiling = map.ceilingHeight;

  // Per column: every support top (floor 0 plus each collider top containing the centre), ascending, unique.
  const topStart = new Int32Array(nCols + 1);
  const topsList: number[] = [];
  const colStart = new Int32Array(nCols + 1);
  const nodeYList: number[] = [];
  const nodeColList: number[] = [];
  const scratch: number[] = [];
  const cx = (c: number): number => minX + ((c % cols) + 0.5) * cell;
  const cz = (c: number): number => minZ + (Math.floor(c / cols) + 0.5) * cell;
  const insideFloor = (x: number, z: number): boolean =>
    x >= f.minX + radius && x <= f.maxX - radius && z >= f.minZ + radius && z <= f.maxZ - radius;
  const bodyClear = (x: number, z: number, lo: number, hi: number): boolean => {
    // Body feet at `lo` (ground) up to head `hi`: no collider spanning it above stepping height.
    let ok = true;
    forEachColliderNear(colliders, x, z, clear, (c) => {
      if (!ok) return;
      if (c.top > lo + step + eps && c.bottom < hi - eps && overlapsCircle(c, x, z, clear)) ok = false;
    });
    return ok;
  };

  for (let c = 0; c < nCols; c++) {
    topStart[c] = topsList.length;
    colStart[c] = nodeYList.length;
    const x = cx(c);
    const z = cz(c);
    if (!insideFloor(x, z)) continue;
    scratch.length = 0;
    scratch.push(0);
    forEachColliderNear(colliders, x, z, 0, (col) => {
      if (col.top > eps && containsPoint(col, x, z)) scratch.push(col.top);
    });
    scratch.sort((p, q) => p - q);
    const tops: number[] = [];
    for (const t of scratch) if (tops.length === 0 || t - tops[tops.length - 1]! > eps) tops.push(t);
    for (const t of tops) topsList.push(t);
    for (let i = 0; i < tops.length; i++) {
      const h = tops[i]!;
      // Stable ground: no higher top within stepHeight (the ground rule would lift the feet onto it).
      if (i + 1 < tops.length && tops[i + 1]! <= h + step + eps) continue;
      if (h + standH > ceiling) continue;
      if (!bodyClear(x, z, h, h + standH)) continue;
      nodeYList.push(h);
      nodeColList.push(c);
    }
  }
  topStart[nCols] = topsList.length;
  colStart[nCols] = nodeYList.length;
  const tops = Float64Array.from(topsList);
  const nodeY = Float64Array.from(nodeYList);
  const nodeCol = Int32Array.from(nodeColList);
  const N = nodeY.length;

  /** Ground in column c for feet at y (movement rule), or -Infinity outside the floor. */
  const groundIn = (c: number, y: number): number => {
    let g = -Infinity;
    for (let k = topStart[c]!; k < topStart[c + 1]!; k++) {
      const t = tops[k]!;
      if (t <= y + step + eps) g = t;
      else break;
    }
    return g;
  };
  const nodeIn = (c: number, y: number): number => {
    for (let k = colStart[c]!; k < colStart[c + 1]!; k++) if (Math.abs(nodeY[k]! - y) <= eps) return k;
    return -1;
  };

  // Edge lists (insertion order is deterministic: node id, then direction order).
  const eFrom: number[] = [];
  const eTo: number[] = [];
  const eCost: number[] = [];
  const eKind: number[] = [];
  const eRoute: number[] = [];
  const add = (a: number, t: number, cost: number, kind: number, route: number): void => {
    eFrom.push(a);
    eTo.push(t);
    eCost.push(cost);
    eKind.push(kind);
    eRoute.push(route);
  };
  const ORTHO: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAG: readonly [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const gravity = b.movement.gravity;
  const safeFall = (b.movement.fallDamageMinSpeed * b.movement.fallDamageMinSpeed) / (2 * gravity);
  const hasDrop = new Uint8Array(N);
  const walkTo = (n: number, dc: number, dr: number): number => {
    const c = nodeCol[n]!;
    const col = (c % cols) + dc;
    const row = Math.floor(c / cols) + dr;
    if (col < 0 || col >= cols || row < 0 || row >= rows) return -1;
    const c2 = row * cols + col;
    const h = nodeY[n]!;
    const g = groundIn(c2, h);
    if (g < h - step - eps) return -2 - c2; // lower: a potential drop into column c2
    return nodeIn(c2, g);
  };
  for (let n = 0; n < N; n++) {
    const h = nodeY[n]!;
    const ortho: number[] = [];
    for (const [dc, dr] of ORTHO) {
      const m = walkTo(n, dc, dr);
      ortho.push(m);
      if (m >= 0) {
        add(n, m, cell, EDGE_WALK, -1);
      } else if (m <= -2) {
        const c2 = -2 - m;
        const g = groundIn(c2, h);
        const target = nodeIn(c2, g);
        if (target < 0 || h - g > safeFall + eps) continue;
        if (!bodyClear(cx(c2), cz(c2), g, h + standH)) continue;
        add(n, target, cell + tun.dropCost, EDGE_DROP, -1);
        hasDrop[n] = 1;
      }
    }
    for (let k = 0; k < DIAG.length; k++) {
      const [dc, dr] = DIAG[k]!;
      const a = ortho[dc > 0 ? 0 : 1]!;
      const c = ortho[dr > 0 ? 2 : 3]!;
      if (a < 0 || c < 0) continue;
      const m = walkTo(n, dc, dr);
      if (m >= 0) add(n, m, cell * Math.SQRT2, EDGE_WALK, -1);
    }
  }

  // Climb links.
  const routes: Vec3[][] = [];
  const routeIds: string[] = [];
  const routeWalk: boolean[] = [];
  const unlinked: string[] = [];
  const snapRoute = (p: Vec3): number => {
    const r = Math.ceil(NAV_AI.routeSnapRadius / cell);
    const pc = Math.floor((p.x - minX) / cell);
    const pr = Math.floor((p.z - minZ) / cell);
    let best = -1;
    let bestD = Infinity;
    for (let row = pr - r; row <= pr + r; row++) {
      if (row < 0 || row >= rows) continue;
      for (let col = pc - r; col <= pc + r; col++) {
        if (col < 0 || col >= cols) continue;
        const c = row * cols + col;
        const dx = cx(c) - p.x;
        const dz = cz(c) - p.z;
        const dxz = dx * dx + dz * dz;
        if (dxz > NAV_AI.routeSnapRadius * NAV_AI.routeSnapRadius) continue;
        for (let k = colStart[c]!; k < colStart[c + 1]!; k++) {
          const dy = nodeY[k]! - p.y;
          if (Math.abs(dy) > NAV_AI.routeSnapDy) continue;
          const d = dxz + dy * dy;
          if (d < bestD || (d === bestD && k < best)) {
            bestD = d;
            best = k;
          }
        }
      }
    }
    return best;
  };
  map.climbRoutes.forEach((route) => {
    const pts = route.points;
    const idx = routes.length;
    routes.push(pts.map((p) => ({ x: p.x, y: p.y, z: p.z })));
    routeIds.push(route.id);
    routeWalk.push(route.mode === 'walk');
    if (pts.length < 2) {
      unlinked.push(route.id);
      return;
    }
    const s = snapRoute(pts[0]!);
    const e = snapRoute(pts[pts.length - 1]!);
    if (s < 0 || e < 0 || s === e) {
      unlinked.push(route.id);
      return;
    }
    let len = 0;
    for (let k = 1; k < pts.length; k++) {
      len += Math.hypot(pts[k]!.x - pts[k - 1]!.x, pts[k]!.y - pts[k - 1]!.y, pts[k]!.z - pts[k - 1]!.z);
    }
    const sp = { x: cx(nodeCol[s]!), z: cz(nodeCol[s]!) };
    const ep = { x: cx(nodeCol[e]!), z: cz(nodeCol[e]!) };
    len += Math.hypot(sp.x - pts[0]!.x, sp.z - pts[0]!.z) + Math.hypot(ep.x - pts[pts.length - 1]!.x, ep.z - pts[pts.length - 1]!.z);
    const up = nodeY[e]! >= nodeY[s]!;
    add(up ? s : e, up ? e : s, len * tun.climbCostMultiplier, EDGE_CLIMB, idx);
    add(up ? e : s, up ? s : e, len, EDGE_CLIMB_DOWN, idx);
  });

  // Pack CSR (stable: edges grouped by source in insertion order).
  const E = eFrom.length;
  const adjStart = new Int32Array(N + 1);
  for (let i = 0; i < E; i++) adjStart[eFrom[i]! + 1]!++;
  for (let n = 0; n < N; n++) adjStart[n + 1]! += adjStart[n]!;
  const fill = adjStart.slice(0, N);
  const adjTo = new Int32Array(E);
  const adjCost = new Float64Array(E);
  const adjKind = new Uint8Array(E);
  const adjRoute = new Int32Array(E);
  for (let i = 0; i < E; i++) {
    const k = fill[eFrom[i]!]!++;
    const to = eTo[i]!;
    adjTo[k] = to;
    adjCost[k] = eCost[i]! + (eKind[i] === EDGE_WALK && hasDrop[to] ? NAV_AI.edgePenalty : 0);
    adjKind[k] = eKind[i]!;
    adjRoute[k] = eRoute[i]!;
  }

  const main = mainComponent(N, adjStart, adjTo);
  const plateau: number[] = [];
  for (let n = 0; n < N; n++) if (main[n] && nodeY[n]! > JUMP_CAP) plateau.push(n);

  const hs = new Hasher();
  hs.word(cols);
  hs.word(rows);
  hs.num(cell);
  hs.num(minX);
  hs.num(minZ);
  hs.word(N);
  for (let n = 0; n < N; n++) {
    hs.word(nodeCol[n]!);
    hs.num(nodeY[n]!);
    hs.word(main[n]!);
    for (let k = adjStart[n]!; k < adjStart[n + 1]!; k++) {
      hs.word(adjTo[k]!);
      hs.num(adjCost[k]!);
      hs.word(adjKind[k]!);
    }
  }

  return new NavGraphData({
    mapId: map.id,
    hash: hs.hex(),
    cell,
    minX,
    minZ,
    cols,
    rows,
    stepHeight: step,
    colStart,
    nodeY,
    nodeCol,
    adjStart,
    adjTo,
    adjCost,
    adjKind,
    adjRoute,
    main,
    plateauNodes: Int32Array.from(plateau),
    routes,
    routeIds,
    routeWalk,
    unlinkedRoutes: unlinked,
    colliders,
    standHeight: standH,
    clearance: clear,
  });
}

/** A surface above this (m) counts as a plateau (out of single-jump reach from the floor; maps.md 2.4). */
const JUMP_CAP = 0.95;

/** Largest strongly connected component (iterative Tarjan); ties -> the one containing the lowest node id. */
function mainComponent(N: number, adjStart: Int32Array, adjTo: Int32Array): Uint8Array {
  const index = new Int32Array(N).fill(-1);
  const low = new Int32Array(N);
  const onStack = new Uint8Array(N);
  const comp = new Int32Array(N).fill(-1);
  const stack: number[] = [];
  const callNode: number[] = [];
  const callEdge: number[] = [];
  let counter = 0;
  let nComp = 0;
  const sizes: number[] = [];
  const minIds: number[] = [];
  for (let root = 0; root < N; root++) {
    if (index[root] !== -1) continue;
    callNode.push(root);
    callEdge.push(adjStart[root]!);
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (callNode.length > 0) {
      const v = callNode[callNode.length - 1]!;
      const e = callEdge[callEdge.length - 1]!;
      if (e < adjStart[v + 1]!) {
        callEdge[callEdge.length - 1] = e + 1;
        const w = adjTo[e]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          callNode.push(w);
          callEdge.push(adjStart[w]!);
        } else if (onStack[w]) {
          if (index[w]! < low[v]!) low[v] = index[w]!;
        }
        continue;
      }
      callNode.pop();
      callEdge.pop();
      if (callNode.length > 0) {
        const u = callNode[callNode.length - 1]!;
        if (low[v]! < low[u]!) low[u] = low[v]!;
      }
      if (low[v] === index[v]) {
        let size = 0;
        let minId = Infinity;
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp[w] = nComp;
          size++;
          if (w < minId) minId = w;
        } while (w !== v);
        sizes.push(size);
        minIds.push(minId);
        nComp++;
      }
    }
  }
  let best = -1;
  for (let i = 0; i < nComp; i++) {
    if (best < 0 || sizes[i]! > sizes[best]! || (sizes[i] === sizes[best] && minIds[i]! < minIds[best]!)) best = i;
  }
  const main = new Uint8Array(N);
  for (let n = 0; n < N; n++) if (comp[n] === best) main[n] = 1;
  return main;
}

// ---------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------

const clampI = (v: number, n: number): number => (v < 0 ? 0 : v >= n ? n - 1 : v);
const colOf = (d: NavGraphData, x: number, z: number): number =>
  clampI(Math.floor((z - d.minZ) / d.cell), d.rows) * d.cols + clampI(Math.floor((x - d.minX) / d.cell), d.cols);

/** Node a walker at `pos` stands on (the ground rule in its cell), or -1. */
function groundNode(d: NavGraphData, c: number, feetY: number): number {
  let best = -1;
  for (let k = d.colStart[c]!; k < d.colStart[c + 1]!; k++) {
    if (d.nodeY[k]! <= feetY + d.stepHeight + NAV_AI.epsilon) best = k;
    else break;
  }
  return best;
}

/**
 * Ring search for the closest node (3D distance) within `radius` metres horizontally that passes `ok`.
 * Ties -> lowest id.
 */
function searchNodes(d: NavGraphData, pos: Vec3, radius: number, ok: (n: number) => boolean): number {
  const pc = Math.floor((pos.x - d.minX) / d.cell);
  const pr = Math.floor((pos.z - d.minZ) / d.cell);
  const maxRing = Math.ceil(radius / d.cell) + 1;
  let best = -1;
  let bestD = Infinity;
  for (let ring = 0; ring <= maxRing; ring++) {
    // Every cell in this ring is at least (ring - 1) cells away horizontally.
    const minDist = Math.max(0, ring - 1) * d.cell;
    if (best >= 0 && minDist * minDist > bestD) break;
    for (let row = pr - ring; row <= pr + ring; row++) {
      if (row < 0 || row >= d.rows) continue;
      const edge = row === pr - ring || row === pr + ring;
      for (let col = pc - ring; col <= pc + ring; col += edge ? 1 : 2 * ring || 1) {
        if (col < 0 || col >= d.cols) continue;
        const c = row * d.cols + col;
        const x = d.minX + (col + 0.5) * d.cell;
        const z = d.minZ + (row + 0.5) * d.cell;
        const dxz = (x - pos.x) ** 2 + (z - pos.z) ** 2;
        if (dxz > radius * radius) continue;
        for (let k = d.colStart[c]!; k < d.colStart[c + 1]!; k++) {
          if (!ok(k)) continue;
          const dd = dxz + (d.nodeY[k]! - pos.y) ** 2;
          if (dd < bestD || (dd === bestD && k < best)) {
            bestD = dd;
            best = k;
          }
        }
      }
    }
  }
  return best;
}

/** Nearest node of the main component (a reachable cell) to `pos`, 3D distance, or -1 within NAV_AI.snapRadius. */
export function nearestNode(g: NavGraph, pos: Vec3): NavNodeId | -1 {
  const d = data(g);
  return searchNodes(d, pos, NAV_AI.snapRadius, (n) => d.main[n] === 1);
}

/**
 * Node a walker at `pos` is on: its own cell's ground node, else the closest node within NAV_AI.startSnapRadius whose
 * height is within stepHeight of the ground rule, else nearestNode. Any component (a bot on a chair top drops off).
 */
export function startNode(g: NavGraph, pos: Vec3): NavNodeId | -1 {
  const d = data(g);
  const own = groundNode(d, colOf(d, pos.x, pos.z), pos.y);
  if (own >= 0 && pos.y - d.nodeY[own]! <= d.stepHeight + NAV_AI.epsilon) return own;
  const near = searchNodes(d, pos, NAV_AI.startSnapRadius, (n) => Math.abs(d.nodeY[n]! - pos.y) <= d.stepHeight + 0.05);
  if (near >= 0) return near;
  if (own >= 0) return own; // airborne above a lower surface
  return nearestNode(g, pos);
}

// ---------------------------------------------------------------------------------------------------------------
// A*
// ---------------------------------------------------------------------------------------------------------------

interface Scratch {
  graph: NavGraphData;
  gen: Uint32Array;
  closedGen: Uint32Array;
  gScore: Float64Array;
  came: Int32Array;
  heapF: number[];
  heapN: number[];
  stamp: number;
  /** The search in flight (resumable across ticks by requestPath); -1 = none. */
  start: number;
  goal: number;
}

/** A search requestPath has started but not finished (its A* state lives in the cache scratch). */
interface PendingSearch {
  key: number;
  start: number;
  goal: number;
  from: Vec3;
  /** Already restarted from the main component (isolated start). */
  retried: boolean;
}

/** LRU path cache keyed by (start node, goal node). Owned by a World; also holds the A* scratch buffers. */
export class PathCache {
  readonly size: number;
  private readonly map = new Map<number, NavPath | null>();
  private graph: NavGraph | null = null;
  /** @internal */
  scratch: Scratch | null = null;
  /** @internal The search requestPath is running across ticks (at most one per cache). */
  pending: PendingSearch | null = null;
  hits = 0;
  misses = 0;
  constructor(size: number) {
    this.size = Math.max(1, Math.floor(size));
  }
  /** @internal */
  bind(g: NavGraph): void {
    if (this.graph !== g) {
      this.graph = g;
      this.map.clear();
      this.scratch = null;
      this.pending = null;
    }
  }
  /** @internal undefined = not cached. */
  get(key: number): NavPath | null | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    this.hits++;
    return v;
  }
  /** @internal */
  has(key: number): boolean {
    return this.map.has(key);
  }
  /** @internal */
  set(key: number, v: NavPath | null): void {
    this.misses++;
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.size) {
      const oldest = this.map.keys().next().value as number;
      this.map.delete(oldest);
    }
  }
  get entries(): number {
    return this.map.size;
  }
}

function scratchFor(cache: PathCache, d: NavGraphData): Scratch {
  let s = cache.scratch;
  if (!s || s.graph !== d) {
    s = {
      graph: d,
      gen: new Uint32Array(d.nodeCount),
      closedGen: new Uint32Array(d.nodeCount),
      gScore: new Float64Array(d.nodeCount),
      came: new Int32Array(d.nodeCount),
      heapF: [],
      heapN: [],
      stamp: 0,
      start: -1,
      goal: -1,
    };
    cache.scratch = s;
  }
  return s;
}

const less = (fa: number, na: number, fb: number, nb: number): boolean => fa < fb || (fa === fb && na < nb);

function heapPush(s: Scratch, f: number, n: number): void {
  const F = s.heapF;
  const H = s.heapN;
  let i = F.length;
  F.push(f);
  H.push(n);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!less(F[i]!, H[i]!, F[p]!, H[p]!)) break;
    const tf = F[i]!;
    F[i] = F[p]!;
    F[p] = tf;
    const tn = H[i]!;
    H[i] = H[p]!;
    H[p] = tn;
    i = p;
  }
}

function heapPop(s: Scratch): number {
  const F = s.heapF;
  const H = s.heapN;
  const top = H[0]!;
  const lf = F.pop()!;
  const ln = H.pop()!;
  if (F.length > 0) {
    F[0] = lf;
    H[0] = ln;
    let i = 0;
    const n = F.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && less(F[l]!, H[l]!, F[m]!, H[m]!)) m = l;
      if (r < n && less(F[r]!, H[r]!, F[m]!, H[m]!)) m = r;
      if (m === i) break;
      const tf = F[i]!;
      F[i] = F[m]!;
      F[m] = tf;
      const tn = H[i]!;
      H[i] = H[m]!;
      H[m] = tn;
      i = m;
    }
  }
  return top;
}

/** Starts an A* search in the scratch (replacing any search in flight). */
function astarBegin(d: NavGraphData, s: Scratch, start: number, goal: number): void {
  s.stamp = (s.stamp + 1) >>> 0;
  if (s.stamp === 0) {
    s.gen.fill(0);
    s.closedGen.fill(0);
    s.stamp = 1;
  }
  s.heapF.length = 0;
  s.heapN.length = 0;
  s.start = start;
  s.goal = goal;
  s.gen[start] = s.stamp;
  s.gScore[start] = 0;
  s.came[start] = -1;
  heapPush(s, heuristic(d, start, goal), start);
}

function heuristic(d: NavGraphData, n: number, goal: number): number {
  const dx = Math.abs(d.nodeX[n]! - d.nodeX[goal]!);
  const dz = Math.abs(d.nodeZ[n]! - d.nodeZ[goal]!);
  return (dx > dz ? dx - dz + dz * Math.SQRT2 : dz - dx + dx * Math.SQRT2) * NAV_AI.heuristicTieBreak;
}

/**
 * Runs the search in flight for at most `maxExpansions` node expansions. Returns the edge index used to enter each node
 * on the path (start first, edge -1), null when the goal is unreachable, or undefined when it needs more expansions
 * (resume with another call; the state stays in the scratch). `used.n` is increased by the expansions done.
 */
function astarRun(d: NavGraphData, s: Scratch, maxExpansions: number, used: { n: number }): number[] | null | undefined {
  const stamp = s.stamp;
  const start = s.start;
  const goal = s.goal;
  let left = maxExpansions;
  while (s.heapN.length > 0) {
    if (left <= 0) return undefined;
    const n = heapPop(s);
    if (s.closedGen[n] === stamp) continue;
    s.closedGen[n] = stamp;
    left--;
    used.n++;
    if (n === goal) {
      const edges: number[] = [];
      let v = goal;
      while (v !== start) {
        const e = s.came[v]!;
        edges.push(e);
        v = edgeSource(d, e);
      }
      edges.push(-1);
      edges.reverse();
      return edges;
    }
    const gn = s.gScore[n]!;
    for (let k = d.adjStart[n]!; k < d.adjStart[n + 1]!; k++) {
      const m = d.adjTo[k]!;
      if (s.closedGen[m] === stamp) continue;
      const ng = gn + d.adjCost[k]!;
      if (s.gen[m] === stamp && ng >= s.gScore[m]!) continue;
      s.gen[m] = stamp;
      s.gScore[m] = ng;
      s.came[m] = k;
      heapPush(s, ng + heuristic(d, m, goal), m);
    }
  }
  return null;
}

/** Complete A* (tools, tests, findPath). */
function astar(d: NavGraphData, s: Scratch, start: number, goal: number): number[] | null {
  astarBegin(d, s, start, goal);
  return astarRun(d, s, Infinity, { n: 0 }) ?? null;
}

/** Source node of CSR edge k (binary search over adjStart). */
function edgeSource(d: NavGraphData, k: number): number {
  let lo = 0;
  let hi = d.nodeCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (d.adjStart[mid]! <= k) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

interface RawPoint {
  p: Vec3;
  jump: boolean;
  route: boolean;
  /** Entered by a walk link (smoothing may skip it). */
  walk: boolean;
}

function buildPoints(d: NavGraphData, start: number, edges: number[]): { raw: RawPoint[]; climbs: number } {
  const raw: RawPoint[] = [{ p: nodePos(d, start), jump: false, route: false, walk: false }];
  let climbs = 0;
  let prev = start;
  for (let i = 1; i < edges.length; i++) {
    const e = edges[i]!;
    const to = d.adjTo[e]!;
    const kind = d.adjKind[e]!;
    if (kind === EDGE_CLIMB || kind === EDGE_CLIMB_DOWN) {
      const route = d.routes[d.adjRoute[e]!]!;
      const up = kind === EDGE_CLIMB && !d.routeWalk[d.adjRoute[e]!];
      if (kind === EDGE_CLIMB) climbs++;
      const seq = kind === EDGE_CLIMB ? route : [...route].reverse();
      let lastY = d.nodeY[prev]!;
      for (let k = 1; k < seq.length; k++) {
        const q = seq[k]!;
        raw.push({ p: { x: q.x, y: q.y, z: q.z }, jump: up && q.y - lastY > d.stepHeight + NAV_AI.epsilon, route: true, walk: false });
        lastY = q.y;
      }
      const end = nodePos(d, to);
      const last = seq[seq.length - 1]!;
      if (Math.hypot(end.x - last.x, end.z - last.z) > 0.3 || Math.abs(end.y - last.y) > NAV_AI.epsilon) {
        raw.push({ p: end, jump: up && end.y - lastY > d.stepHeight + NAV_AI.epsilon, route: false, walk: false });
      }
    } else {
      raw.push({ p: nodePos(d, to), jump: false, route: false, walk: kind === EDGE_WALK });
    }
    prev = to;
  }
  return { raw, climbs };
}

/** Can a walker go straight from a to b on one surface (no drop, no blocking collider)? */
function straightWalkable(d: NavGraphData, a: Vec3, b: Vec3): boolean {
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const stepLen = d.cell * NAV_AI.smoothSampleFraction;
  const n = Math.max(1, Math.ceil(dist / stepLen));
  let y = a.y;
  const set = d.colliders;
  const step = d.stepHeight;
  const r = d.clearance - NAV_AI.clearanceMargin * 0.5;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const c = colOf(d, x, z);
    const gn = groundNode(d, c, y);
    if (gn < 0) return false;
    const gy = d.nodeY[gn]!;
    if (gy < y - step - NAV_AI.epsilon) return false;
    y = gy;
    let blocked = false;
    forEachColliderNear(set, x, z, r, (col) => {
      if (blocked) return;
      if (col.top > y + step + NAV_AI.epsilon && col.bottom < y + d.standHeight && overlapsCircle(col, x, z, r)) blocked = true;
    });
    if (blocked) return false;
  }
  return Math.abs(y - b.y) <= step + NAV_AI.epsilon;
}

function smooth(d: NavGraphData, raw: RawPoint[]): RawPoint[] {
  if (raw.length <= 2) return raw;
  const out: RawPoint[] = [raw[0]!];
  let i = 0;
  while (i < raw.length - 1) {
    let j = i + 1;
    // Extend over walk-entered points while the straight segment stays walkable.
    for (let k = i + 2; k < raw.length && k - i <= NAV_AI.smoothMaxSkip; k++) {
      if (!raw[k]!.walk || !raw[k - 1]!.walk) break;
      if (!straightWalkable(d, raw[i]!.p, raw[k]!.p)) break;
      j = k;
    }
    out.push(raw[j]!);
    i = j;
  }
  return out;
}

function toPath(d: NavGraphData, start: number, edges: number[]): NavPath {
  const { raw, climbs } = buildPoints(d, start, edges);
  const pts = smooth(d, raw);
  let length = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!.p;
    const b = pts[k]!.p;
    length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return { points: pts.map((q) => q.p), jump: pts.map((q) => q.jump), route: pts.map((q) => q.route), length, climbs };
}

/** Cache key of a search, or -1 when either end does not snap. */
function keyOf(g: NavGraph, from: Vec3, to: Vec3): { key: number; s: number; t: number } {
  const s = startNode(g, from);
  const t = nearestNode(g, to);
  return { key: s < 0 || t < 0 ? -1 : s * g.nodeCount + t, s, t };
}

/**
 * @internal Unbudgeted: tools, tests and requestPath only. Bot code must call requestPath, which spends the World's
 * per-tick search budget (bots.nav.maxPathsPerTick; REVIEW-M2b M2).
 *
 * A* path from `from` (snapped to the node the walker is on) to `to` (snapped to the nearest reachable node).
 * Points run from the start node centre to the goal node centre (climb routes inline). Null when unreachable.
 */
export function findPath(g: NavGraph, from: Vec3, to: Vec3, cache: PathCache): NavPath | null {
  const d = data(g);
  cache.bind(g);
  const { key, s, t } = keyOf(g, from, to);
  if (key < 0) return null;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  cache.pending = null; // a complete search reuses the scratch
  let start = s;
  let edges = s === t ? [-1] : astar(d, scratchFor(cache, d), s, t);
  if (!edges && d.main[s] !== 1) {
    // A walker on an isolated surface (a stair tread, a chair seat): start from the nearest reachable cell instead.
    const m = nearestNode(g, from);
    if (m >= 0) {
      start = m;
      edges = m === t ? [-1] : astar(d, scratchFor(cache, d), m, t);
    }
  }
  const path = edges ? toPath(d, start, edges) : null;
  cache.set(key, path);
  return path;
}

/**
 * @internal Unbudgeted (tools and tests). Bots measure zone walks with requestPath(...).length under the budget.
 * Path length (m); Infinity when unreachable.
 */
export function pathLength(g: NavGraph, from: Vec3, to: Vec3, cache: PathCache): number {
  const p = findPath(g, from, to, cache);
  return p ? p.length : Infinity;
}

/**
 * Per-tick A* budget, owned by a World; resets when `now` changes. At most `perTick` (bots.nav.maxPathsPerTick)
 * search activities per tick (starting a search, or resuming the one in flight), and at most `expansionsPerTick`
 * (NAV_AI.maxExpansionsPerTick) node expansions in total, so a long search over the office spreads over several ticks
 * instead of breaking the server tick budget (ARCHITECTURE §11, REVIEW-M2b M4).
 */
export class NavBudget {
  private at = Number.NaN;
  private used = 0;
  /** @internal Expansions spent this tick. */
  readonly expanded = { n: 0 };
  constructor(
    readonly perTick: number,
    readonly expansionsPerTick: number = NAV_AI.maxExpansionsPerTick,
  ) {}
  private sync(now: number): void {
    if (now !== this.at) {
      this.at = now;
      this.used = 0;
      this.expanded.n = 0;
    }
  }
  /** Takes one search activity from this tick's budget; false when spent. */
  take(now: number): boolean {
    this.sync(now);
    if (this.used >= this.perTick || this.expanded.n >= this.expansionsPerTick) return false;
    this.used++;
    return true;
  }
  /** Expansions left this tick. */
  expansionsLeft(now: number): number {
    this.sync(now);
    return Math.max(0, this.expansionsPerTick - this.expanded.n);
  }
}

/** Runs the cache's search in flight under the budget; on completion stores the result. Returns true when it finished. */
function advancePending(d: NavGraphData, cache: PathCache, budget: NavBudget, now: number): boolean {
  const p = cache.pending!;
  const sc = scratchFor(cache, d);
  if (sc.start !== p.start || sc.goal !== p.goal) astarBegin(d, sc, p.start, p.goal); // scratch was reused
  const edges = astarRun(d, sc, budget.expansionsLeft(now), budget.expanded);
  if (edges === undefined) return false;
  if (edges === null && !p.retried && d.main[p.start] !== 1) {
    // Isolated start (a stair tread, a chair seat): restart from the nearest reachable cell.
    const m = nearestNode(d, p.from);
    if (m >= 0 && m !== p.start) {
      p.start = m;
      p.retried = true;
      if (m === p.goal) {
        cache.set(p.key, toPath(d, m, [-1]));
        cache.pending = null;
        return true;
      }
      astarBegin(d, sc, m, p.goal);
      return false;
    }
  }
  cache.set(p.key, edges ? toPath(d, p.start, edges) : null);
  cache.pending = null;
  return true;
}

/**
 * The bots' path query: cached results are free; otherwise the search runs under the World's per-tick budget
 * (NavBudget). 'wait' = no result this tick (the budget is spent, or the search is still running or queued behind the
 * one in flight); the caller keeps its old path and asks again next tick.
 */
export function requestPath(g: NavGraph, from: Vec3, to: Vec3, cache: PathCache, budget: NavBudget, now: number): NavPath | null | 'wait' {
  const d = data(g);
  cache.bind(g);
  const { key, s, t } = keyOf(g, from, to);
  if (key < 0) return null;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (cache.pending) {
    if (!budget.take(now)) return 'wait';
    const own = cache.pending.key === key;
    if (!advancePending(d, cache, budget, now) || !own) return 'wait';
    return cache.get(key) ?? null;
  }
  if (!budget.take(now)) return 'wait';
  if (s === t) {
    const path = toPath(d, s, [-1]);
    cache.set(key, path);
    return path;
  }
  cache.pending = { key, start: s, goal: t, from: { x: from.x, y: from.y, z: from.z }, retried: false };
  astarBegin(d, scratchFor(cache, d), s, t);
  if (!advancePending(d, cache, budget, now)) return 'wait';
  return cache.get(key) ?? null;
}
