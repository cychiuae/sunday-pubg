/**
 * M2a aim-down-sights overlays (STYLE.md §17), driven by HudView.ads through logic.adsReticle:
 * - SightReticle: the small centre reticle for over-shoulder ADS (iron = cream dot, red_dot = glowing red dot).
 *   Lives in the HUD centre, next to the hip crosshair it replaces.
 * - ScopeOverlay: the full-screen scope frame for scope_4x (chevron + mil ticks) and scope_8x (fine crosshair +
 *   mil-dots). Sits at the bottom of the Ui root (under every HUD panel, above the canvas) and covers the whole
 *   viewport, not just the 2.2:1 HUD box. 120 ms iris-in, 80 ms fade-out (CSS); no iris with reduced motion.
 * M2c (docs/art/M2c.md §14.5, UI M2c §16.5): scope_2x, a wider 46vmin lens with a coral rim, a lighter 88% outside and
 *   the "sunrise ring" reticle. Rims follow the SCOPE type (CSS data-sight), not the weapon.
 * Marks are decorative: the screen centre is the exact aim point (hitscan).
 * Owner: ui-ux-designer.
 */
import { SCOPE_2X_RETICLE_SVG, SCOPE_RIM_COLOR } from '../render/procedural/icons';
import type { AdsReticle, DotSight, ScopeSight } from './logic';
import { Flags, h, StyleVar } from './dom';

/** STYLE.md §17 iron-sight dot (32 × 32). */
const IRON_SVG =
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='-16 -16 32 32'>` +
  `<circle r='4.6' fill='#2A1D33' fill-opacity='0.85'/><circle r='3' fill='#FFFAF0'/></svg>`;

/** STYLE.md §17 red dot (48 × 48): housing ring, glow, ink ring, red dot, toy highlight. */
const RED_DOT_SVG =
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='-24 -24 48 48'>` +
  `<defs><radialGradient id='rdGlow'><stop offset='0' stop-color='#FF3B5C' stop-opacity='0.5'/>` +
  `<stop offset='1' stop-color='#FF3B5C' stop-opacity='0'/></radialGradient></defs>` +
  `<circle r='22' fill='none' stroke='#2A1D33' stroke-opacity='0.22' stroke-width='2.5'/>` +
  `<circle r='13' fill='url(#rdGlow)'/><circle r='4.8' fill='#2A1D33' fill-opacity='0.85'/>` +
  `<circle r='3.3' fill='#FF3B5C'/><circle cx='-1.1' cy='-1.1' r='1' fill='#FFE1E7'/></svg>`;

/** STYLE.md §17 4x reticle: slate posts, thin ink lines, red chevron at the aim point, mil ticks. */
const SCOPE_4X_SVG =
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='-100 -100 200 200' class='ui-scope__reticle'>` +
  `<g fill='none' stroke-linecap='round' stroke-linejoin='round'>` +
  `<g stroke='#2A1D33' stroke-width='7'>` +
  `<path vector-effect='non-scaling-stroke' d='M-100 0 H-42 M42 0 H100 M0 100 V48'/>` +
  `<path vector-effect='non-scaling-stroke' d='M-9 9 L0 0 L9 9'/></g>` +
  `<g stroke='#2A1D33' stroke-width='2.4'>` +
  `<path vector-effect='non-scaling-stroke' d='M-42 0 H-14 M14 0 H42 M0 14 V48'/>` +
  `<path vector-effect='non-scaling-stroke' d='M-24 -4 V4 M-34 -3 V3 M24 -4 V4 M34 -3 V3'/>` +
  `<path vector-effect='non-scaling-stroke' d='M-5 22 H5 M-4 30 H4 M-5 38 H5'/></g>` +
  `<g stroke='#3D3A4B' stroke-width='4'><path vector-effect='non-scaling-stroke' d='M-100 0 H-42 M42 0 H100 M0 100 V48'/></g>` +
  `<g stroke='#FF3B5C' stroke-width='3.2'><path vector-effect='non-scaling-stroke' d='M-9 9 L0 0 L9 9'/></g>` +
  `</g></svg>`;

function milDots(): string {
  let out = '';
  for (const v of [-50, -40, -30, -20, -10, 10, 20, 30, 40, 50]) out += `<circle cx='${v}' r='1.3'/><circle cy='${v}' r='1.3'/>`;
  return out;
}

/** STYLE.md §17 8x reticle: duplex posts, 1.6 px ink crosshair with a centre gap, mil-dots, tiny red centre dot. */
const SCOPE_8X_SVG =
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='-100 -100 200 200' class='ui-scope__reticle'>` +
  `<g fill='none' stroke-linecap='round'>` +
  `<g stroke='#2A1D33' stroke-width='7'><path vector-effect='non-scaling-stroke' d='M-100 0 H-60 M60 0 H100 M0 -100 V-60 M0 60 V100'/></g>` +
  `<g stroke='#2A1D33' stroke-width='1.6'><path vector-effect='non-scaling-stroke' d='M-60 0 H-2.5 M2.5 0 H60 M0 -60 V-2.5 M0 2.5 V60'/></g>` +
  `</g><g fill='#2A1D33'>${milDots()}</g>` +
  `<circle r='1.1' fill='#FF3B5C' stroke='#2A1D33' stroke-width='1' vector-effect='non-scaling-stroke'/></svg>`;

/** Parses one of the constant SVG strings above (never game data). */
function parseSvg(markup: string): Element {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const el = document.importNode(doc.documentElement, true);
  // An inline <style> in an SVG would apply to the whole page: turn it into per-element attributes instead.
  el.querySelectorAll('style').forEach((st) => {
    if (/vector-effect\s*:\s*non-scaling-stroke/.test(st.textContent ?? '')) {
      el.querySelectorAll('path, circle').forEach((n) => n.setAttribute('vector-effect', 'non-scaling-stroke'));
    }
    st.remove();
  });
  el.removeAttribute('style');
  return el;
}

// ---------------------------------------------------------------------------------------------
// Centre reticle (iron / red dot)
// ---------------------------------------------------------------------------------------------
export class SightReticle {
  readonly el: HTMLDivElement;
  private readonly flags: Flags;
  private readonly opacity: StyleVar;
  private sight: DotSight | null = null;

  constructor() {
    const iron = h('div', 'ui-sight__iron');
    iron.appendChild(parseSvg(IRON_SVG));
    const red = h('div', 'ui-sight__red');
    red.appendChild(parseSvg(RED_DOT_SVG));
    this.el = h('div', 'ui-sight', { 'aria-hidden': 'true' }, iron, red);
    this.el.hidden = true;
    this.flags = new Flags(this.el);
    this.opacity = new StyleVar(this.el, '--o');
  }

  update(r: AdsReticle): void {
    const on = r.dot !== null && r.dotOpacity > 0;
    if (this.el.hidden === on) this.el.hidden = !on;
    if (!on) return;
    if (r.dot !== this.sight) {
      this.sight = r.dot;
      this.flags.set('is-red', r.dot === 'red_dot');
    }
    this.opacity.set(r.dotOpacity.toFixed(2));
  }
}

// ---------------------------------------------------------------------------------------------
// Full-screen scope
// ---------------------------------------------------------------------------------------------
export class ScopeOverlay {
  readonly el: HTMLDivElement;
  private readonly flags: Flags;
  private shownSight: ScopeSight | null = null;
  private on = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const r2 = h('div', 'ui-scope__mark ui-scope__mark--2x');
    // docs/art/M2c.md §14.5 "sunrise ring" (graphics-designer's art, src/render/procedural/icons.ts).
    r2.appendChild(parseSvg(SCOPE_2X_RETICLE_SVG));
    const r4 = h('div', 'ui-scope__mark ui-scope__mark--4x');
    r4.appendChild(parseSvg(SCOPE_4X_SVG));
    const r8 = h('div', 'ui-scope__mark ui-scope__mark--8x');
    r8.appendChild(parseSvg(SCOPE_8X_SVG));
    const lens = h('div', 'ui-scope__lens', null, h('div', 'ui-scope__glass'), r2, r4, r8);
    this.el = h('div', 'ui-scope', { 'aria-hidden': 'true' }, lens);
    this.el.hidden = true;
    this.flags = new Flags(this.el);
  }

  /** `scope` = AdsReticle.scope, or null (also used to force it off outside the match screen). */
  update(scope: ScopeSight | null): void {
    if (scope !== null) {
      if (this.hideTimer !== null) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
      if (scope !== this.shownSight) {
        this.shownSight = scope;
        this.el.dataset['sight'] = scope;
        // Rim = the scope's accent (SCOPE_RIM_COLOR), the same on any gun.
        this.el.style.setProperty('--scope-c', SCOPE_RIM_COLOR[scope]);
      }
      if (!this.on) {
        this.on = true;
        this.el.hidden = false;
        this.flags.set('is-out', false);
        this.flags.set('is-in', false);
        requestAnimationFrame(() => {
          if (this.on) this.flags.set('is-in', true);
        });
      }
      return;
    }
    if (!this.on) return;
    this.on = false;
    // 80 ms fade-out, then hide (keeps the layer out of hit-testing and compositing while unused).
    this.flags.set('is-in', false);
    this.flags.set('is-out', true);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (!this.on) this.el.hidden = true;
    }, 90);
  }

  dispose(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
  }
}
