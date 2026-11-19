/**
 * Item / weapon glyphs. Every item has a distinct SHAPE as well as its family colour, so nothing is told
 * apart by colour alone (docs/ui/UI.md, "Accessibility"). Two kinds:
 * - CSS clip-path shapes + family colour (guns, ammo, heals): no image assets.
 * - M2a: full-colour inline SVG icons for the armor pieces and the grenade (STYLE.md §18), used as a data-URI
 *   background so they stay a single element. Armor tier is also shown by pips next to the icon (hud.ts).
 * - M2c (docs/ui/M2c.md §1, §16; docs/art/M2c.md §12, §14.6): SVGs for every new item come from the graphics-designer's
 *   M2C_ICON_SVG (src/render/procedural/icons.ts); the clip-path shapes and family colours below stay as the
 *   tiny-chip fallback (iconCssShape) and the non-SVG path.
 * Owner: ui-ux-designer.
 */
import { M2C_ICON_SVG } from '../render/procedural/icons';
import type { ItemLevel, M2cArmorTier, M2cHeldId, M2cItemId } from '../shared/types';
import { h } from './dom';

export type IconId = M2cItemId | M2cHeldId;

const SHAPE: Record<IconId, string> = {
  fists: 'ring',
  pistol: 'circle',
  smg: 'triangle',
  shotgun: 'square',
  rifle: 'diamond',
  lmg: 'octagon',
  dmr: 'hexagon',
  sniper: 'star',
  ammo_light: 'circle',
  ammo_heavy: 'diamond',
  ammo_shell: 'square',
  ammo_sniper: 'star',
  bandage: 'plus',
  medkit: 'crossbox',
  vest_1: 'shield',
  vest_2: 'shield',
  vest_3: 'shield',
  helmet_1: 'dome',
  helmet_2: 'dome',
  helmet_3: 'dome',
  grenade: 'pineapple',
  // M2c
  knife: 'blade',
  machete: 'machete',
  paddle: 'paddle',
  dbshotgun: 'barrels',
  revolver: 'pentagon',
  rpg: 'rocket',
  ammo_rocket: 'rocket',
  smoke: 'cloud',
  vest_4: 'shield',
  helmet_4: 'dome',
  scope_red_dot: 'circle',
  scope_2x: 'square',
  scope_4x: 'capsule',
  scope_8x: 'capsule',
};

/** Armor tier main colours (STYLE.md §2 "Armor tiers"; level 4 from docs/art/M2c.md §6). */
export const ARMOR_TIER_COLOUR: Record<M2cArmorTier, string> = { 1: '#7fa8c8', 2: '#3a6fd8', 3: '#3d4a5c', 4: '#b963e3' };

/**
 * M2c level scale (docs/art/M2c.md §1.1, final): `base` fills the badge, pips and collars; `text` is the variant for
 * text or thin strokes on a dark panel. The numeral on the badge is always ink #2A1D33 (contrast >= 4.5 : 1).
 */
export const LEVEL_COLOUR: Record<ItemLevel, { base: string; text: string }> = {
  1: { base: '#b8e7ff', text: '#b8e7ff' },
  2: { base: '#fff14d', text: '#fff14d' },
  3: { base: '#f2590d', text: '#ff7a3d' },
  4: { base: '#b963e3', text: '#d08bf0' },
};

/** M2c scope accents (docs/art/M2c.md §14.3): the chip fill and the overlay rim. */
export const SCOPE_ACCENT: Record<'scope_red_dot' | 'scope_2x' | 'scope_4x' | 'scope_8x', string> = {
  scope_red_dot: '#fff3d6',
  scope_2x: '#ff7a5c',
  scope_4x: '#5b8def',
  scope_8x: '#ff6fa8',
};

/** Family colours (palette: weapons/ammo share a family colour; see materials.ts and STYLE.md §18). */
const COLOUR: Record<IconId, string> = {
  fists: '#fffaf0',
  pistol: '#ffc43d',
  smg: '#2ec4b6',
  shotgun: '#e94f37',
  rifle: '#3e9b5a',
  lmg: '#ff8a3d',
  dmr: '#5b8def',
  sniper: '#ff6fa8',
  ammo_light: '#ffc43d',
  ammo_heavy: '#3e9b5a',
  ammo_shell: '#e94f37',
  ammo_sniper: '#ff6fa8',
  bandage: '#ff8fb1',
  medkit: '#2fb36b',
  vest_1: ARMOR_TIER_COLOUR[1],
  vest_2: ARMOR_TIER_COLOUR[2],
  vest_3: ARMOR_TIER_COLOUR[3],
  helmet_1: ARMOR_TIER_COLOUR[1],
  helmet_2: ARMOR_TIER_COLOUR[2],
  helmet_3: ARMOR_TIER_COLOUR[3],
  grenade: '#ff9f1c',
  // M2c (docs/art/M2c.md §12)
  knife: '#d3dce6',
  machete: '#34983f',
  paddle: '#d09a62',
  dbshotgun: '#7fddb8',
  revolver: '#4fb4ee',
  rpg: '#ff5a5f',
  ammo_rocket: '#ff5a5f',
  smoke: '#c9b6f2',
  vest_4: ARMOR_TIER_COLOUR[4],
  helmet_4: '#c98b2e',
  scope_red_dot: SCOPE_ACCENT.scope_red_dot,
  scope_2x: SCOPE_ACCENT.scope_2x,
  scope_4x: SCOPE_ACCENT.scope_4x,
  scope_8x: SCOPE_ACCENT.scope_8x,
};

const NS = "xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'";

/** STYLE.md §18 SVG icons (32 × 32, 2 px ink outline, flat fills, one highlight). Static markup, never game data. */
const SVG: Partial<Record<IconId, string>> = {
  grenade:
    `<svg ${NS}><g stroke='#2A1D33' stroke-width='2' stroke-linejoin='round'>` +
    `<path d='M16 1.5 L18.5 7 H13.5 Z M10.5 3.5 L14 7.5 H11 Z M21.5 3.5 L18 7.5 H21 Z' fill='#4CBB4A'/>` +
    `<rect x='12' y='7' width='8' height='5' rx='1.5' fill='#3D3A4B'/>` +
    `<ellipse cx='16' cy='20.5' rx='9.5' ry='9.8' fill='#FF9F1C'/>` +
    `<circle cx='25.5' cy='9.5' r='3' fill='none' stroke-width='4'/></g>` +
    `<circle cx='25.5' cy='9.5' r='3' fill='none' stroke='#FF3B5C' stroke-width='2'/>` +
    `<path d='M8 17 H24 M7 22 H25 M9 27 H23 M16 11 V30' stroke='#D97A12' stroke-width='1.5' fill='none'/>` +
    `<ellipse cx='12.5' cy='15.5' rx='2.6' ry='1.5' fill='#FFF3D6' fill-opacity='0.7'/></svg>`,
  helmet_1:
    `<svg ${NS}><g stroke='#2A1D33' stroke-width='2' stroke-linejoin='round'>` +
    `<path d='M9 19 L11 8.5 Q16 6 21 8.5 L23 19 Z' fill='#7FA8C8'/>` +
    `<path d='M2 21 Q16 16 30 21 L28.5 24.5 Q16 20.5 3.5 24.5 Z' fill='#9BBBD4'/></g>` +
    `<path d='M10 16.5 H22' stroke='#D9B26F' stroke-width='2.5'/></svg>`,
  helmet_2:
    `<svg ${NS}><g stroke='#2A1D33' stroke-width='2' stroke-linejoin='round'>` +
    `<path d='M4 22 C4 12 9.5 6 16 6 C22.5 6 28 12 28 22 Z' fill='#3A6FD8'/>` +
    `<rect x='2.5' y='21' width='27' height='4.5' rx='2.2' fill='#2B55B0'/></g>` +
    `<path d='M16 7 V21' stroke='#F4F7FB' stroke-width='2.5'/>` +
    `<path d='M9.5 13 L11.5 11 M22.5 13 L20.5 11' stroke='#2A1D33' stroke-width='2' stroke-linecap='round'/></svg>`,
  helmet_3:
    `<svg ${NS}><g stroke='#2A1D33' stroke-width='2' stroke-linejoin='round'>` +
    `<path d='M14 7 L16 3 L18 7 Z' fill='#FFC43D'/>` +
    `<path d='M4 22 L5.5 13 L10 8 L16 6.5 L22 8 L26.5 13 L28 22 Z' fill='#3D4A5C'/>` +
    `<rect x='3' y='18.5' width='26' height='4.5' rx='1.5' fill='#FF5C8A'/>` +
    `<circle cx='7' cy='25' r='3.5' fill='#2A3342'/></g>` +
    `<circle cx='7' cy='25' r='1.3' fill='#FFC43D'/></svg>`,
  vest_1:
    `<svg ${NS}><g stroke='#2A1D33' stroke-width='2' stroke-linejoin='round' fill='#7FA8C8'>` +
    `<path d='M8 5 H13 L14.5 12 V28 H6 V12 Z'/><path d='M24 5 H19 L17.5 12 V28 H26 V12 Z'/></g>` +
    `<path d='M8 20 h4 M20 20 h4' stroke='#D9B26F' stroke-width='3'/></svg>`,
  vest_2:
    `<svg ${NS}><g stroke='#2A1D33' stroke-width='2' stroke-linejoin='round'>` +
    `<path d='M10 4 Q16 7 22 4 L26 10 V28 H6 V10 Z' fill='#3A6FD8'/></g>` +
    `<path d='M7 15 H25 M7 21 H25' stroke='#2B55B0' stroke-width='2'/>` +
    `<path d='M11 5.5 Q16 8.5 21 5.5' stroke='#F4F7FB' stroke-width='2.5' fill='none'/>` +
    `<path d='M16 8 V27' stroke='#2B55B0' stroke-width='1.5'/></svg>`,
  vest_3:
    `<svg ${NS}><g stroke='#2A1D33' stroke-width='2' stroke-linejoin='round'>` +
    `<path d='M9 4 H13 L14 8 H18 L19 4 H23 L26 10 V28 H6 V10 Z' fill='#2A3342'/>` +
    `<rect x='9' y='11' width='14' height='13' rx='1.5' fill='#3D4A5C' stroke='#FF5C8A' stroke-width='2'/></g>` +
    `<circle cx='16' cy='17.5' r='2.6' fill='#FF5C8A'/><circle cx='16' cy='17.5' r='1' fill='#FFC43D'/></svg>`,
};

const urlCache = new Map<IconId, string>();

/** `url("data:…")` for an SVG icon, or null when the id uses a CSS shape. Cached per id. */
export function svgIconUrl(id: IconId): string | null {
  const cached = urlCache.get(id);
  if (cached) return cached;
  const markup = svgMarkup(id);
  if (!markup) return null;
  const url = `url("data:image/svg+xml,${encodeURIComponent(markup)}")`;
  urlCache.set(id, url);
  return url;
}

/**
 * SVG markup for an id: M2c items from the graphics-designer's art (src/render/procedural/icons.ts, pure data), else
 * the M2a STYLE §18 icons above; undefined = CSS shape.
 */
function svgMarkup(id: IconId): string | undefined {
  return M2C_ICON_SVG[id] ?? SVG[id];
}

/** Visual code of an icon: the SVG silhouette when there is one, else the CSS shape. */
export function iconShape(id: IconId): string {
  return svgMarkup(id) ? 'svg' : SHAPE[id];
}

/** CSS-shape name for an id (also used where only a shape fits, e.g. tiny chips). */
export function iconCssShape(id: IconId): string {
  return SHAPE[id];
}

export function iconColour(id: IconId): string {
  return COLOUR[id];
}

/** A decorative glyph; the accompanying text label carries the meaning for assistive tech. */
export function icon(id: IconId | null, extraCls = ''): HTMLSpanElement {
  const el = h('span', `ui-icon ${extraCls}`.trim(), { 'aria-hidden': 'true' });
  setIcon(el, id);
  return el;
}

/** Diffed: writes only when the id changes. */
export function setIcon(el: HTMLElement, id: IconId | null): void {
  if (el.dataset['icon'] === (id ?? '')) return;
  el.dataset['icon'] = id ?? '';
  const url = id ? svgIconUrl(id) : null;
  el.dataset['shape'] = id ? (url ? 'svg' : SHAPE[id]) : 'none';
  el.style.setProperty('--icon-colour', id ? COLOUR[id] : 'transparent');
  if (url) el.style.setProperty('--icon-svg', url);
  else el.style.removeProperty('--icon-svg');
}

// ---------------------------------------------------------------------------------------------
// M2c level badge (docs/ui/M2c.md §1.1): rounded square, ink outline, level fill (CSS --lvN), ink numeral; L4 adds a
// sparkle corner. The numeral is the primary non-colour tell. aria-hidden: the parent's label names the level.
// ---------------------------------------------------------------------------------------------
export function levelBadge(extraCls = ''): HTMLSpanElement {
  const el = h('span', `ui-lv ${extraCls}`.trim(), { 'aria-hidden': 'true' });
  el.hidden = true;
  return el;
}

/** Diffed: shows the badge for a level, hides it for null. */
export function setLevelBadge(el: HTMLElement, level: ItemLevel | null): void {
  const v = level === null ? '' : String(level);
  if (el.dataset['level'] === v) return;
  el.dataset['level'] = v;
  el.textContent = v;
  el.hidden = level === null;
}
