/**
 * Canvas minimap: north-up (north = -Z), whole island in view.
 * Static layer (sea, coastline, grass, hills, POIs) is cached to an offscreen canvas and rebuilt only on
 * map or size change. Dynamic layer (tide circles, self arrow) redraws at MINIMAP_HZ.
 * Owner: ui-ux-designer.
 */
import { t } from '../content/strings';
import type { HudMinimapView, HudZoneView } from '../shared/contracts';
import type { MapData } from '../shared/types';
import { h } from './dom';
import { fitProjection, minimapArrowRotation, projectXZ, type MapProjection } from './logic';

export type CoastlineFn = (angle: number, map: MapData) => number;

export const MINIMAP_HZ = 10;
const COAST_SEGMENTS = 96;

/** Colours mirror the art palette (src/render/procedural/materials.ts) and docs/ui/UI.md. */
const C = {
  ink: '#2a1d33',
  sea: '#1f7fbf',
  seaShallow: '#4fd8d0',
  sand: '#f7e4b5',
  grass: '#7cc84f',
  hill: '#5aa844',
  tide: '#46b8ff',
  tideOutside: 'rgba(18, 90, 150, 0.45)',
  target: '#fffaf0',
  self: '#ffc43d',
  poi: '#fffaf0',
};

export class Minimap {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private staticLayer: HTMLCanvasElement | null = null;
  private staticKey = '';
  private map: MapData | null = null;
  private sizeCss = 0;
  private dpr = 1;
  private proj: MapProjection = { scale: 1, cx: 0, cy: 0 };
  private lastDrawMs = -Infinity;
  private dirty = true;
  private readonly resizeObs: ResizeObserver | null = null;

  constructor(private readonly coastline: CoastlineFn | null) {
    this.canvas = h('canvas', 'ui-minimap__canvas');
    this.el = h('div', 'ui-minimap', { 'aria-hidden': 'true' }, this.canvas);
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
  update(view: HudMinimapView, zone: HudZoneView | null, nowMs: number): void {
    if (!this.ctx || this.sizeCss <= 0) return;
    if (view.map !== this.map) {
      this.map = view.map;
      this.dirty = true;
    }
    if (!this.dirty && nowMs - this.lastDrawMs < 1000 / MINIMAP_HZ) return;
    this.lastDrawMs = nowMs;
    this.dirty = false;
    this.draw(this.ctx, view, zone);
  }

  private ensureStatic(map: MapData): HTMLCanvasElement {
    const key = `${map.id}|${this.sizeCss}|${this.dpr}`;
    if (this.staticLayer && key === this.staticKey) return this.staticLayer;
    const layer = document.createElement('canvas');
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const g = layer.getContext('2d');
    this.proj = fitProjection(map.worldRadius, this.sizeCss, 4);
    if (g) {
      g.scale(this.dpr, this.dpr);
      this.drawStatic(g, map);
    }
    this.staticLayer = layer;
    this.staticKey = key;
    return layer;
  }

  private coastPath(g: CanvasRenderingContext2D, map: MapData, inset: number): void {
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

  private drawStatic(g: CanvasRenderingContext2D, map: MapData): void {
    const s = this.sizeCss;
    const p = this.proj;
    // Sea
    g.fillStyle = C.sea;
    g.fillRect(0, 0, s, s);
    g.fillStyle = C.seaShallow;
    g.beginPath();
    g.arc(p.cx, p.cy, (map.islandRadius + 10) * p.scale, 0, Math.PI * 2);
    g.globalAlpha = 0.45;
    g.fill();
    g.globalAlpha = 1;
    // Sand, grass, hills
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
    // POIs: ink-ringed dot + name (names only when there is room)
    const showNames = s >= 150;
    const fontPx = Math.max(9, Math.round(s / 19));
    g.font = `800 ${fontPx}px ui-rounded, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.lineJoin = 'round';
    for (const poi of map.pois) {
      const { px, py } = projectXZ(p, poi.x, poi.z);
      g.beginPath();
      g.arc(px, py, 2.5, 0, Math.PI * 2);
      g.fillStyle = C.poi;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = C.ink;
      g.stroke();
      if (showNames) {
        const label = t(poi.nameKey);
        const y = py - 4;
        const x = Math.min(s - 4, Math.max(4, px));
        g.lineWidth = 3;
        g.strokeStyle = C.ink;
        g.strokeText(label, x, y, s * 0.42);
        g.fillStyle = C.poi;
        g.fillText(label, x, y, s * 0.42);
      }
    }
  }

  private draw(g: CanvasRenderingContext2D, view: HudMinimapView, zone: HudZoneView | null): void {
    const layer = this.ensureStatic(view.map);
    const p = this.proj;
    const s = this.sizeCss;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(layer, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (zone) {
      const cur = projectXZ(p, zone.center.x, zone.center.z);
      const r = Math.max(0, zone.radius * p.scale);
      // Shade the surf outside the safe circle (even-odd: square minus circle).
      g.beginPath();
      g.rect(0, 0, s, s);
      g.moveTo(cur.px + r, cur.py);
      g.arc(cur.px, cur.py, r, 0, Math.PI * 2, true);
      g.fillStyle = C.tideOutside;
      g.fill('evenodd');
      // Current edge: solid thick line with ink under-stroke.
      g.beginPath();
      g.arc(cur.px, cur.py, r, 0, Math.PI * 2);
      g.lineWidth = 4;
      g.strokeStyle = C.ink;
      g.stroke();
      g.lineWidth = 2;
      g.strokeStyle = C.tide;
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

  dispose(): void {
    this.resizeObs?.disconnect();
    this.el.remove();
  }
}
