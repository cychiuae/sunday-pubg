/**
 * Canvas minimap: north-up (north = -Z), the whole map in view.
 * - Island: sea, coastline, grass, hills, POIs.
 * - M2b indoor (IndoorMapData): ceiling-dark surround, the floor rectangle with its floor zones (wood / carpet / tile),
 *   desk-size plateaus from the kit `size`, walls (solid ink, glass light cyan), POIs.
 * - M2c (UI M2c §7.1): the map is the LAYOUT-APPLIED map of the match, so office desks follow the layout; on the island,
 *   big collidable props (huts, big rocks) draw as small blocks. The static layer is rebuilt when the map object or
 *   the layout seed changes (once per match) and on resize. Decoration, clutter, loot and smoke are never drawn.
 * The static layer is cached to an offscreen canvas and rebuilt only on map or size change. The dynamic layer (zone
 * circles in the map's theme colours, the M2b flight route with the moving carrier, the self arrow) redraws at
 * MINIMAP_HZ.
 * Owner: ui-ux-designer.
 */
import type { ZoneTheme } from '../shared/balance';
import type { HudMinimapView, HudZoneView, MinimapRouteView } from '../shared/contracts';
import { isIndoor, mapBounds, wallFrame } from '../shared/maps';
import { PROP_SHAPES } from '../shared/sim/colliders';
import type { AnyMapData, FloorMaterial, IndoorMapData, IslandMapData, PropKind } from '../shared/types';
import { h } from './dom';
import {
  fitProjection,
  fitRectProjection,
  layoutMapLabels,
  minimapArrowRotation,
  minimapPoiLabel,
  projectXZ,
  routeEntryPoint,
  wrapLabel,
  type MapProjection,
} from './logic';

/** Island coastline radius by angle (src/shared/sim/terrain.ts coastlineRadius). */
export type CoastlineFn = (angle: number, map: IslandMapData) => number;

export const MINIMAP_HZ = 10;
const COAST_SEGMENTS = 96;

/** Colours mirror the art palette (src/render/procedural/materials.ts, STYLE.md §19.1) and docs/ui/UI.md. */
const C = {
  ink: '#2a1d33',
  sea: '#1f7fbf',
  seaShallow: '#4fd8d0',
  sand: '#f7e4b5',
  grass: '#7cc84f',
  hill: '#5aa844',
  // M2c island props (huts, big cover)
  prop: '#c99a5b',
  target: '#fffaf0',
  self: '#ffc43d',
  poi: '#fffaf0',
  // M2b indoor (STYLE.md §19.1)
  ceiling: '#3a3f47',
  wood: '#d9ae7a',
  carpet: '#5e6f8a',
  tile: '#e6eef0',
  desk: '#f7f7f4',
  wall: '#2a1d33',
  glass: '#bfe6f0',
  route: '#fffaf0',
  carrier: '#ffc43d',
};

const FLOOR: Record<FloorMaterial, string> = { wood: C.wood, carpet: C.carpet, tile: C.tile };

/** Zone ring colours per fiction (ADR 0005 §7). Outside = the shaded area; the next circle stays white dashed. */
const ZONE_STYLE: Record<ZoneTheme, { ring: string; outside: string }> = {
  tide: { ring: '#46b8ff', outside: 'rgba(18, 90, 150, 0.45)' },
  sprinklers: { ring: '#46b8ff', outside: 'rgba(40, 110, 200, 0.42)' },
  lightsOut: { ring: '#ffd84a', outside: 'rgba(14, 16, 30, 0.62)' },
};

/** Indoor props drawn as plateaus: floor props with colliders, at least this footprint (m², desks are ~86) and height. */
const PLATEAU_MIN_AREA = 25;
const PLATEAU_MIN_HEIGHT = 3;
/** M2c island props drawn as blocks: main collider part footprint (m², scaled) and top height (m). Presentation only. */
export const ISLAND_PROP_MIN_AREA = 8;
export const ISLAND_PROP_MIN_HEIGHT = 1.2;

/** M2c: an island prop's minimap block (main collider part, scaled), or null when it is too small or soft. */
export function islandPropBlock(
  kind: PropKind,
  scale: number,
): { shape: 'box'; hx: number; hz: number } | { shape: 'circle'; r: number } | null {
  const part = PROP_SHAPES[kind]?.[0];
  if (!part || kind === 'dock') return null;
  const s = scale > 0 ? scale : 1;
  if (part.top * s < ISLAND_PROP_MIN_HEIGHT) return null;
  if (part.shape === 'box') {
    const hx = part.hx * s;
    const hz = part.hz * s;
    return 4 * hx * hz >= ISLAND_PROP_MIN_AREA ? { shape: 'box', hx, hz } : null;
  }
  const r = part.r * s;
  return Math.PI * r * r >= ISLAND_PROP_MIN_AREA ? { shape: 'circle', r } : null;
}

export interface MinimapOptions {
  /** HudView.zoneTheme (ring and outside colours). */
  theme?: ZoneTheme;
  /** Before the flight starts (lobby / countdown): the carrier icon waits at the entry point. */
  preFlight?: boolean;
}

export class Minimap {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private staticLayer: HTMLCanvasElement | null = null;
  /** POI names, drawn above the zone rings (so the rings never cut through text) and below the arrows. */
  private labelLayer: HTMLCanvasElement | null = null;
  private staticKey = '';
  private map: AnyMapData | null = null;
  /** M2c: bumps when the map object or the layout seed changes (the applied map is a new object every match). */
  private mapGen = 0;
  private layoutSeed: number | null = null;
  /** Static-layer rebuild count (tests / AC M2C-UI-27). */
  staticBuilds = 0;
  private sizeCss = 0;
  private dpr = 1;
  private proj: MapProjection = { scale: 1, cx: 0, cy: 0 };
  private lastDrawMs = -Infinity;
  private dirty = true;
  private readonly resizeObs: ResizeObserver | null = null;

  constructor(
    private readonly coastline: CoastlineFn | null,
    extraClass = '',
  ) {
    this.canvas = h('canvas', 'ui-minimap__canvas');
    this.el = h('div', `ui-minimap${extraClass ? ` ${extraClass}` : ''}`, { 'aria-hidden': 'true' }, this.canvas);
    this.ctx = this.canvas.getContext('2d');
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box) this.setSize(Math.round(Math.min(box.width, box.height)));
      });
      this.resizeObs.observe(this.el);
    }
  }

  private setSize(css: number): void {
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    if (css === this.sizeCss && dpr === this.dpr) return;
    this.sizeCss = css;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(css * dpr));
    this.canvas.height = Math.max(1, Math.round(css * dpr));
    this.dirty = true;
  }

  /** Called every frame; draws at most MINIMAP_HZ times per second (or immediately when dirty). */
  update(view: HudMinimapView, zone: HudZoneView | null, nowMs: number, opts: MinimapOptions = {}): void {
    if (!this.ctx || this.sizeCss <= 0) return;
    const map = view.map as AnyMapData;
    const seed = view.layout?.seed ?? null;
    if (map !== this.map || seed !== this.layoutSeed) {
      this.map = map;
      this.layoutSeed = seed;
      this.mapGen++;
      this.dirty = true;
      this.el.classList.toggle('is-indoor', isIndoor(map));
    }
    if (!this.dirty && nowMs - this.lastDrawMs < 1000 / MINIMAP_HZ) return;
    this.lastDrawMs = nowMs;
    this.dirty = false;
    this.draw(this.ctx, map, view, zone, opts);
  }

  private ensureStatic(map: AnyMapData): HTMLCanvasElement {
    const key = `${map.id}|${map.kind ?? 'island'}|${this.mapGen}|${this.sizeCss}|${this.dpr}`;
    if (this.staticLayer && key === this.staticKey) return this.staticLayer;
    const layer = document.createElement('canvas');
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const g = layer.getContext('2d');
    this.proj = isIndoor(map) ? fitRectProjection(mapBounds(map), this.sizeCss, 4) : fitProjection(map.worldRadius, this.sizeCss, 4);
    if (g) {
      g.scale(this.dpr, this.dpr);
      if (isIndoor(map)) this.drawIndoor(g, map);
      else this.drawIsland(g, map);
      this.drawPoiDots(g, map);
    }
    this.staticLayer = layer;
    this.staticBuilds++;
    this.labelLayer = this.buildLabels(map);
    this.staticKey = key;
    return layer;
  }

  // ------------------------------------------------------------------------------------------
  // Island
  // ------------------------------------------------------------------------------------------
  private coastPath(g: CanvasRenderingContext2D, map: IslandMapData, inset: number): void {
    const p = this.proj;
    g.beginPath();
    for (let i = 0; i <= COAST_SEGMENTS; i++) {
      const a = (i / COAST_SEGMENTS) * Math.PI * 2;
      const r = Math.max(0, (this.coastline ? this.coastline(a, map) : map.islandRadius) - inset);
      // coastlineRadius uses atan2 angles in the XZ plane: x = r cos a, z = r sin a.
      const { px, py } = projectXZ(p, Math.cos(a) * r, Math.sin(a) * r);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
  }

  private drawIsland(g: CanvasRenderingContext2D, map: IslandMapData): void {
    const s = this.sizeCss;
    const p = this.proj;
    g.fillStyle = C.sea;
    g.fillRect(0, 0, s, s);
    g.fillStyle = C.seaShallow;
    g.beginPath();
    g.arc(p.cx, p.cy, (map.islandRadius + 10) * p.scale, 0, Math.PI * 2);
    g.globalAlpha = 0.45;
    g.fill();
    g.globalAlpha = 1;
    this.coastPath(g, map, 0);
    g.fillStyle = C.sand;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = C.ink;
    g.stroke();
    this.coastPath(g, map, map.beachWidth);
    g.fillStyle = C.grass;
    g.fill();
    g.fillStyle = C.hill;
    for (const hill of map.hills) {
      const { px, py } = projectXZ(p, hill.x, hill.z);
      g.beginPath();
      g.arc(px, py, Math.max(2, hill.radius * p.scale * 0.6), 0, Math.PI * 2);
      g.fill();
    }
    // M2c: huts and big cover from this match's layout (small sand-brown blocks with an ink edge).
    g.lineJoin = 'round';
    for (const prop of map.props) {
      const b = islandPropBlock(prop.kind, prop.scale);
      if (!b) continue;
      const minPx = 1.5 / p.scale;
      if (b.shape === 'box') this.box(g, prop.x, prop.z, Math.max(b.hx, minPx), Math.max(b.hz, minPx), prop.rotY);
      else {
        const { px, py } = projectXZ(p, prop.x, prop.z);
        g.beginPath();
        g.arc(px, py, Math.max(1.5, b.r * p.scale), 0, Math.PI * 2);
      }
      g.fillStyle = C.prop;
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = C.ink;
      g.stroke();
    }
  }

  // ------------------------------------------------------------------------------------------
  // M2b indoor
  // ------------------------------------------------------------------------------------------
  private rect(g: CanvasRenderingContext2D, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const a = projectXZ(this.proj, minX, minZ);
    const b = projectXZ(this.proj, maxX, maxZ);
    g.rect(a.px, a.py, b.px - a.px, b.py - a.py);
  }

  /** A rotated box centred at (cx, cz), half sizes along its local x and z, Three.js rotY (canvas angle = -rotY). */
  private box(g: CanvasRenderingContext2D, cx: number, cz: number, hx: number, hz: number, rotY: number): void {
    const { px, py } = projectXZ(this.proj, cx, cz);
    const sx = hx * this.proj.scale;
    const sz = hz * this.proj.scale;
    g.save();
    g.translate(px, py);
    g.rotate(-rotY);
    g.beginPath();
    g.rect(-sx, -sz, sx * 2, sz * 2);
    g.restore();
  }

  private drawIndoor(g: CanvasRenderingContext2D, map: IndoorMapData): void {
    const s = this.sizeCss;
    const f = map.floor;
    g.fillStyle = C.ceiling;
    g.fillRect(0, 0, s, s);
    // Floor and finish zones (later zones win, as in the sim).
    g.beginPath();
    this.rect(g, f.minX, f.minZ, f.maxX, f.maxZ);
    g.fillStyle = FLOOR[map.floorMaterial] ?? C.wood;
    g.fill();
    for (const z of map.floorZones) {
      g.beginPath();
      this.rect(g, z.minX, z.minZ, z.maxX, z.maxZ);
      g.fillStyle = FLOOR[z.material] ?? C.wood;
      g.fill();
    }
    // Plateaus (desks, tables, counters): white tops with a thin ink edge.
    g.lineJoin = 'round';
    for (const prop of map.props) {
      const kit = map.kit[prop.kind];
      if (!kit || kit.origin !== 'floor' || kit.colliders.length === 0) continue;
      const sc = prop.scale > 0 ? prop.scale : 1;
      const w = kit.size[0] * sc;
      const ht = kit.size[1] * sc;
      const d = kit.size[2] * sc;
      if (w * d < PLATEAU_MIN_AREA || ht < PLATEAU_MIN_HEIGHT) continue;
      this.box(g, prop.x, prop.z, w / 2, d / 2, prop.rotY);
      g.fillStyle = C.desk;
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(42, 29, 51, 0.55)';
      g.stroke();
    }
    // Walls: floor-standing only (lintels over doorways would close the gaps on the map).
    const minPx = Math.max(1.5, this.sizeCss / 110);
    for (const wall of map.walls) {
      if (wall.bottom > 0.01) continue;
      const fr = wallFrame(wall);
      const half = Math.max(fr.halfThickness, minPx / 2 / this.proj.scale);
      this.box(g, fr.cx, fr.cz, fr.halfLength, half, fr.rotY);
      if (wall.material === 'glass') {
        g.fillStyle = C.glass;
        g.fill();
        g.lineWidth = 0.75;
        g.strokeStyle = C.ink;
        g.stroke();
      } else {
        g.fillStyle = C.wall;
        g.fill();
      }
    }
    // Outer frame.
    g.beginPath();
    this.rect(g, f.minX, f.minZ, f.maxX, f.maxZ);
    g.lineWidth = 2;
    g.strokeStyle = C.ink;
    g.stroke();
  }

  private drawPoiDots(g: CanvasRenderingContext2D, map: AnyMapData): void {
    for (const poi of map.pois) {
      const { px, py } = projectXZ(this.proj, poi.x, poi.z);
      g.beginPath();
      g.arc(px, py, 2.5, 0, Math.PI * 2);
      g.fillStyle = C.poi;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = C.ink;
      g.stroke();
    }
  }

  /**
   * POI names, laid out so each one is fully inside the map and clear of other labels and dots (BUG-004). Long names
   * wrap to two lines; names with no free spot are dropped rather than clipped. Hidden below 150 px (too small to read).
   */
  private buildLabels(map: AnyMapData): HTMLCanvasElement | null {
    const s = this.sizeCss;
    if (s < 150) return null;
    const layer = document.createElement('canvas');
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const g = layer.getContext('2d');
    if (!g) return null;
    g.scale(this.dpr, this.dpr);
    const fontPx = Math.max(10, Math.round(s / 17));
    const lineH = Math.round(fontPx * 1.1);
    g.font = `800 ${fontPx}px ui-rounded, system-ui, sans-serif`;
    const measure = (text: string): number => g.measureText(text).width;
    const outline = 3;
    const pad = 6;
    const maxLine = s * 0.5;
    const labels = map.pois.map((poi) => {
      const { px, py } = projectXZ(this.proj, poi.x, poi.z);
      const lines = wrapLabel(minimapPoiLabel(poi.nameKey), maxLine, measure);
      const w = Math.ceil(Math.max(...lines.map(measure))) + outline;
      return { px, py, lines, w, h: lines.length * lineH + outline };
    });
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = outline;
    for (const { index, box } of layoutMapLabels(labels, s, pad)) {
      const label = labels[index];
      if (!label) continue;
      const cx = box.x + box.w / 2;
      label.lines.forEach((line, i) => {
        const y = box.y + outline / 2 + lineH * (i + 0.5);
        g.strokeStyle = C.ink;
        g.strokeText(line, cx, y);
        g.fillStyle = C.poi;
        g.fillText(line, cx, y);
      });
    }
    return layer;
  }

  // ------------------------------------------------------------------------------------------
  // Dynamic layer
  // ------------------------------------------------------------------------------------------
  private draw(g: CanvasRenderingContext2D, map: AnyMapData, view: HudMinimapView, zone: HudZoneView | null, opts: MinimapOptions): void {
    const layer = this.ensureStatic(map);
    const p = this.proj;
    const s = this.sizeCss;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(layer, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (zone) {
      const style = ZONE_STYLE[opts.theme ?? 'tide'] ?? ZONE_STYLE.tide;
      const cur = projectXZ(p, zone.center.x, zone.center.z);
      const r = Math.max(0, zone.radius * p.scale);
      // Shade outside the safe circle (even-odd: square minus circle).
      g.beginPath();
      g.rect(0, 0, s, s);
      g.moveTo(cur.px + r, cur.py);
      g.arc(cur.px, cur.py, r, 0, Math.PI * 2, true);
      g.fillStyle = style.outside;
      g.fill('evenodd');
      // Current edge: solid thick line with ink under-stroke.
      g.beginPath();
      g.arc(cur.px, cur.py, r, 0, Math.PI * 2);
      g.lineWidth = 4;
      g.strokeStyle = C.ink;
      g.stroke();
      g.lineWidth = 2;
      g.strokeStyle = style.ring;
      g.stroke();
      // Next circle: dashed white (shape differs from the current ring, not just colour).
      if (zone.targetRadius !== zone.radius || zone.targetCenter.x !== zone.center.x || zone.targetCenter.z !== zone.center.z) {
        const tc = projectXZ(p, zone.targetCenter.x, zone.targetCenter.z);
        g.beginPath();
        g.arc(tc.px, tc.py, Math.max(0, zone.targetRadius * p.scale), 0, Math.PI * 2);
        g.setLineDash([4, 3]);
        g.lineWidth = 2;
        g.strokeStyle = C.target;
        g.stroke();
        g.setLineDash([]);
      }
    }

    if (view.route) this.drawRoute(g, view.route);

    if (this.labelLayer) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(this.labelLayer, 0, 0);
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    if (view.route) this.drawCarrier(g, map, view.route, opts.preFlight === true);

    if (view.self) {
      const { px, py } = projectXZ(p, view.self.x, view.self.z);
      const size = Math.max(6, s / 22);
      g.save();
      g.translate(px, py);
      g.rotate(minimapArrowRotation(view.self.yaw));
      g.beginPath();
      g.moveTo(0, -size);
      g.lineTo(size * 0.75, size * 0.75);
      g.lineTo(0, size * 0.35);
      g.lineTo(-size * 0.75, size * 0.75);
      g.closePath();
      g.lineJoin = 'round';
      g.lineWidth = 3;
      g.strokeStyle = C.ink;
      g.stroke();
      g.fillStyle = C.self;
      g.fill();
      g.restore();
    }
  }

  /** Dashed flight path (ink under-stroke, cream dashes), an arrow head at the exit and a ring at the auto-eject point. */
  private drawRoute(g: CanvasRenderingContext2D, route: MinimapRouteView): void {
    const p = this.proj;
    const a = projectXZ(p, route.from.x, route.from.z);
    const b = projectXZ(p, route.to.x, route.to.z);
    const dash = Math.max(4, this.sizeCss / 40);
    g.save();
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(a.px, a.py);
    g.lineTo(b.px, b.py);
    g.lineWidth = 4;
    g.strokeStyle = C.ink;
    g.stroke();
    g.setLineDash([dash, dash * 0.7]);
    g.lineWidth = 2;
    g.strokeStyle = C.route;
    g.stroke();
    g.setLineDash([]);
    // Arrow head at the exit (direction cue that survives without colour).
    const ang = Math.atan2(b.py - a.py, b.px - a.px);
    const head = Math.max(5, this.sizeCss / 28);
    g.translate(b.px, b.py);
    g.rotate(ang);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(-head, -head * 0.6);
    g.lineTo(-head, head * 0.6);
    g.closePath();
    g.fillStyle = C.route;
    g.lineWidth = 1.5;
    g.strokeStyle = C.ink;
    g.fill();
    g.stroke();
    g.restore();
    // Auto-eject marker: an ink ring with a cream X.
    const e = projectXZ(p, route.eject.x, route.eject.z);
    const r = Math.max(3.5, this.sizeCss / 45);
    g.beginPath();
    g.arc(e.px, e.py, r, 0, Math.PI * 2);
    g.fillStyle = C.ink;
    g.fill();
    g.beginPath();
    g.moveTo(e.px - r * 0.5, e.py - r * 0.5);
    g.lineTo(e.px + r * 0.5, e.py + r * 0.5);
    g.moveTo(e.px + r * 0.5, e.py - r * 0.5);
    g.lineTo(e.px - r * 0.5, e.py + r * 0.5);
    g.lineWidth = 1.5;
    g.strokeStyle = C.route;
    g.stroke();
  }

  /** Carrier silhouette (a chunky plane / drone cross) on the route, pointing along the heading. */
  private drawCarrier(g: CanvasRenderingContext2D, map: AnyMapData, route: MinimapRouteView, preFlight: boolean): void {
    // Before the flight the carrier waits where the route enters the map frame (the real entry is off the map).
    const pos = route.carrier?.pos ?? (preFlight ? (routeEntryPoint(route.from, route.to, mapBounds(map)) ?? route.from) : null);
    if (!pos) return;
    const heading = route.carrier?.heading ?? Math.atan2(-(route.to.x - route.from.x), -(route.to.z - route.from.z));
    const { px, py } = projectXZ(this.proj, pos.x, pos.z);
    const u = Math.max(7, this.sizeCss / 18);
    g.save();
    g.translate(px, py);
    g.rotate(minimapArrowRotation(heading));
    g.beginPath();
    // Fuselage (nose up = heading), wings, tail.
    g.moveTo(0, -u);
    g.lineTo(u * 0.18, -u * 0.55);
    g.lineTo(u * 0.95, -u * 0.05);
    g.lineTo(u * 0.95, u * 0.2);
    g.lineTo(u * 0.18, u * 0.05);
    g.lineTo(u * 0.14, u * 0.55);
    g.lineTo(u * 0.45, u * 0.8);
    g.lineTo(u * 0.45, u * 0.95);
    g.lineTo(0, u * 0.82);
    g.lineTo(-u * 0.45, u * 0.95);
    g.lineTo(-u * 0.45, u * 0.8);
    g.lineTo(-u * 0.14, u * 0.55);
    g.lineTo(-u * 0.18, u * 0.05);
    g.lineTo(-u * 0.95, u * 0.2);
    g.lineTo(-u * 0.95, -u * 0.05);
    g.lineTo(-u * 0.18, -u * 0.55);
    g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = 3;
    g.strokeStyle = C.ink;
    g.stroke();
    g.fillStyle = C.carrier;
    if (preFlight) g.globalAlpha = 0.85;
    g.fill();
    g.restore();
  }

  /** Forces a redraw on the next update (e.g. after the element was shown again). */
  invalidate(): void {
    this.dirty = true;
  }

  dispose(): void {
    this.resizeObs?.disconnect();
    this.el.remove();
  }
}
