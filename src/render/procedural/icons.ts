/**
 * M2c icon art (32 x 32 SVG) and the 2x scope overlay art, as plain strings. Owner: graphics-designer.
 * Spec: docs/art/M2c.md §12 (item icons), §14.5 (2x overlay), §14.6 (scope icons); style: docs/art/STYLE.md §18
 * (2 px ink outline, flat fills, one top highlight, the same shapes as the 3D items, weapons point left).
 *
 * PURE DATA: no three.js, no DOM. The ui-ux-designer imports these into src/ui/icons.ts (or copies them there).
 * Icons stay ONE per weapon (no per-level icons, Addendum 2); the HUD level badge carries the level.
 */

const INK = '#2A1D33';
const svg = (body: string) => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
const g = (inner: string) => `<g stroke="${INK}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">${inner}</g>`;

/** 32 x 32 SVG icons for the M2c items, keyed by item id. */
export const M2C_ICON_SVG: Readonly<Record<string, string>> = {
  // Shucking Knife: short leaf blade, round guard, bulb coral handle (45 deg, blade up-left)
  knife: svg(
    g(`<path d="M5 5 L14 9 L17 14 L14 17 L9 14 Z" fill="#D3DCE6"/>
<circle cx="17" cy="17" r="4" fill="#3D3A4B"/>
<path d="M19 19 L26 26 Q28.5 28.5 26.5 29.5 Q24.5 30 22.5 28 L17.5 22 Z" fill="#FF7A5C"/>`) +
    `<path d="M7 6.5 L13 9.5" stroke="#F4F8FB" stroke-width="1.5"/>`,
  ),
  // Coconut Machete: long broad blade with a square tip, green handle
  machete: svg(
    g(`<path d="M2.5 9 L6.5 3.5 L20 15 L16 19 Z" fill="#D3DCE6"/>
<path d="M17 17.5 L19.5 15 L21.5 17 L19 19.5 Z" fill="#3D3A4B"/>
<path d="M20 19 L27.5 26.5 Q29 28.5 27 29.5 Q25.5 30 24 28.5 L18.5 21 Z" fill="#34983F"/>`) +
    `<path d="M5 5.5 L18 16" stroke="#9AA6B4" stroke-width="1.5"/><path d="M22 22 L23.5 20.5 M24.5 24.5 L26 23" stroke="#4CBB4A" stroke-width="1.5"/>`,
  ),
  // Lifeboat Paddle: long shaft, leaf blade with a teal tip, T-grip
  paddle: svg(
    g(`<path d="M27 3 L30 6 L27.5 7.5 L24.5 4.5 Z" fill="#B07E4C"/>
<path d="M26 6 L11 21" stroke-width="5"/><path d="M26 6 L11 21" stroke="#D09A62" stroke-width="2.6"/>
<ellipse cx="8" cy="24" rx="4.2" ry="7.5" transform="rotate(45 8 24)" fill="#D09A62"/>`) +
    `<path d="M2.6 28.6 Q3.5 25.5 5.4 26.6" fill="none" stroke="#2EC4B6" stroke-width="2.4"/><path d="M8 22 L10.3 24.3" stroke="#FFF4E2" stroke-width="1.5"/>`,
  ),
  // Double Scoop Shotgun: two mint barrels, two scoops at the muzzle, waffle-cone stock
  dbshotgun: svg(
    g(`<rect x="4" y="9" width="17" height="4" rx="1" fill="#7FDDB8"/>
<rect x="4" y="13" width="17" height="4" rx="1" fill="#7FDDB8"/>
<rect x="20" y="9" width="4" height="9" rx="1" fill="#3D3A4B"/>
<path d="M23.5 11 L30 13 L30 22 L23 17 Z" fill="#D9A05B"/>`) +
    `<circle cx="3.5" cy="11" r="2" fill="#FF8FB1" stroke="${INK}" stroke-width="1.2"/><circle cx="3.5" cy="15" r="2" fill="#FFF3D6" stroke="${INK}" stroke-width="1.2"/>` +
    `<path d="M25 14 L29 18 M25.5 16.5 L28 14.5" stroke="#B07A3A" stroke-width="1"/><path d="M6 10.4 H19" stroke="#FFF4E2" stroke-opacity="0.6" stroke-width="1.2"/>`,
  ),
  // Sand Dollar Revolver: sky barrel, sand-dollar drum with 5 petals, walnut bird's-head grip
  revolver: svg(
    g(`<rect x="3" y="10" width="13" height="4" rx="1" fill="#4FB4EE"/>
<path d="M15 9 H22 V17 H15 Z" fill="#4FB4EE"/>
<path d="M21 15 L24 25 Q24.5 28 21.5 28 L18.5 27 L17.5 17 Z" fill="#8A5A34"/>
<circle cx="18" cy="13" r="4.2" fill="#F2E2C2"/>`) +
    `<g fill="#C9A273"><circle cx="18" cy="11" r="0.8"/><circle cx="19.9" cy="12.4" r="0.8"/><circle cx="19.2" cy="14.6" r="0.8"/><circle cx="16.8" cy="14.6" r="0.8"/><circle cx="16.1" cy="12.4" r="0.8"/></g>` +
    `<path d="M8 10 V14" stroke="#3E9B5A" stroke-width="1.8"/><path d="M4.5 11 H13" stroke="#FFFFFF" stroke-opacity="0.5" stroke-width="1"/>`,
  ),
  // Sunburst Launcher: fat cream tube with coral spiral stripes, sunburst decal, grips
  rpg: svg(
    g(`<rect x="2" y="9" width="28" height="9" rx="2" fill="#FFF4E2"/>
<path d="M17 18 V25 H21 V18 M8 18 V23 H11 V18" fill="#3D3A4B"/>`) +
    `<path d="M7 9.5 L11 17.5 M14 9.5 L18 17.5 M21 9.5 L25 17.5" stroke="#FF5A5F" stroke-width="2.4"/>` +
    `<circle cx="22.5" cy="13.5" r="2.4" fill="#FFC43D" stroke="${INK}" stroke-width="1"/><circle cx="2.8" cy="13.5" r="1.6" fill="#FF5A5F"/>`,
  ),
  // Fireworks (ammo_rocket): one rocket pointing up-right
  ammo_rocket: svg(
    g(`<path d="M8 24 L21 11 L25 15 L12 28 Z" fill="#FFF4E2"/>
<path d="M21 11 Q25 5 29 3 Q27 7 25 15 Z" fill="#FF5A5F"/>
<path d="M8 24 L4 23 L7 20 Z M12 28 L13 32 L10 29 Z M8 24 L12 28 L9 29 L7 27 Z" fill="#FFC43D"/>`) +
    `<path d="M13 20 L17 24" stroke="#FF5A5F" stroke-width="2"/>`,
  ),
  // Candyfloss Smoke Bomb: lilac can, pink hoops, three-puff cap, cream ring
  smoke: svg(
    g(`<circle cx="12.5" cy="8" r="3.5" fill="#F2B8F0"/><circle cx="19.5" cy="8" r="3.5" fill="#F2B8F0"/><circle cx="16" cy="5.5" r="4" fill="#FFD1E6"/>
<rect x="9" y="10" width="14" height="19" rx="2.5" fill="#C9B6F2"/>
<circle cx="26" cy="9" r="2.6" fill="none" stroke-width="3.6"/>`) +
    `<circle cx="26" cy="9" r="2.6" fill="none" stroke="#FFF3D6" stroke-width="1.8"/>` +
    `<path d="M9.5 15.5 H22.5 M9.5 23 H22.5" stroke="#FFB3D1" stroke-width="2.2"/><path d="M11.5 12.5 V26" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="1.4"/>`,
  ),
  // Surfboard Vest (vest_4): violet surfboard half with a cream stringer and grey tape straps
  vest_4: svg(
    g(`<path d="M16 2.5 Q24 6 24 17 Q24 27 16 30 Q8 27 8 17 Q8 6 16 2.5 Z" fill="#B963E3"/>
<path d="M4 9 H28 V12 H4 Z M4 22 H28 V25 H4 Z" fill="#C9CED6"/>`) +
    `<path d="M16 4 V29" stroke="#FFF4E2" stroke-width="1.6"/><circle cx="12" cy="17" r="1" fill="#FFF14D"/><circle cx="20" cy="15" r="1" fill="#FFF14D"/>`,
  ),
  // Ship's Bell Helmet (helmet_4): brass bell, top loop, violet rope band, flared lip
  helmet_4: svg(
    g(`<circle cx="16" cy="5" r="2.6" fill="none" stroke-width="3.6"/>
<path d="M9 23 Q9 8 16 7.5 Q23 8 23 23 Z" fill="#C98B2E"/>
<path d="M4 26 Q16 20 28 26 L27 28.5 Q16 24 5 28.5 Z" fill="#8E5F1E"/>
<rect x="8.5" y="17" width="15" height="3" rx="1" fill="#B963E3"/>`) +
    `<circle cx="16" cy="5" r="2.6" fill="none" stroke="#C98B2E" stroke-width="1.8"/><path d="M12.5 11 Q13 9.5 15 9" stroke="#F2C46A" stroke-width="1.6" fill="none"/>`,
  ),
  // Scopes (docs/art/M2c.md §14.6): ring / box / short tube / long tube; accent = the scope's colour
  scope_red_dot: svg(
    g(`<rect x="8" y="22" width="16" height="5" rx="1.2" fill="#3D3A4B"/>
<circle cx="16" cy="14" r="8.5" fill="#9FE8F0" fill-opacity="0.55"/>`) +
    `<circle cx="16" cy="14" r="8.5" fill="none" stroke="#3D3A4B" stroke-width="3"/>` +
    `<path d="M10.5 7.5 A8.5 8.5 0 0 1 21.5 7.5" stroke="#FFF3D6" stroke-width="2" fill="none"/>` +
    `<circle cx="16" cy="14" r="2.4" fill="#FF3B5C" stroke="${INK}" stroke-width="1"/>`,
  ),
  scope_2x: svg(
    g(`<rect x="13.5" y="7" width="5" height="4" rx="1" fill="#FF7A5C"/>
<rect x="9" y="10.5" width="16" height="11" rx="1.5" fill="#3D3A4B"/>
<rect x="3" y="11.5" width="6.5" height="9" rx="2" fill="#FF7A5C"/>
<rect x="25" y="12" width="4" height="8" rx="1" fill="#3D3A4B"/>
<rect x="11" y="21.5" width="12" height="4.5" rx="1" fill="#3D3A4B"/>`) +
    `<path d="M11 13 H21" stroke="#FFF3D6" stroke-opacity="0.6" stroke-width="1.5"/>`,
  ),
  scope_4x: svg(
    g(`<rect x="13" y="8.5" width="4" height="4" rx="1" fill="#5B8DEF"/>
<path d="M3 10 L9 12.5 H23 L27 11.5 V20.5 L23 19.5 H9 L3 22 Z" fill="#3D3A4B"/>
<rect x="1.5" y="9.5" width="3" height="13" rx="1" fill="#5B8DEF"/>
<rect x="26.5" y="11" width="3" height="10" rx="1" fill="#5B8DEF"/>
<path d="M10 19.5 V24 H13 V19.5 M19 19.5 V24 H22 V19.5" fill="#3D3A4B"/>`) +
    `<path d="M9 14.5 H22" stroke="#FFF3D6" stroke-opacity="0.6" stroke-width="1.5"/>`,
  ),
  scope_8x: svg(
    g(`<rect x="14" y="9.5" width="4" height="3.5" rx="1" fill="#FF6FA8"/>
<path d="M2.5 8 L8 13 H25 L29 12 V20 L25 19 H8 L2.5 24 Z" fill="#3D3A4B"/>
<rect x="1" y="7.5" width="3" height="17" rx="1" fill="#FF6FA8"/>
<rect x="28" y="11.5" width="2.5" height="9" rx="1" fill="#FF6FA8"/>
<path d="M9.5 19 V23.5 H12.5 V19 M20.5 19 V23.5 H23.5 V19" fill="#3D3A4B"/>`) +
    `<path d="M8 15 H24" stroke="#FFF3D6" stroke-opacity="0.6" stroke-width="1.5"/><path d="M17 19 V22" stroke="#FF6FA8" stroke-width="2"/>`,
  ),
};

/** 2x scope: the "sunrise ring" reticle (viewBox -100..100, sized to the lens diameter, 92vmin). Centre = aim point. */
export const SCOPE_2X_RETICLE_SVG = `<svg viewBox="-100 -100 200 200" xmlns="http://www.w3.org/2000/svg" style="width:92vmin;height:92vmin">
  <style>path, circle { vector-effect: non-scaling-stroke; }</style>
  <g fill="none" stroke-linecap="round">
    <g stroke="${INK}" stroke-width="7"><path d="M-100 0 H-34 M34 0 H100 M0 100 V34"/></g>
    <g stroke="#3D3A4B" stroke-width="4"><path d="M-100 0 H-34 M34 0 H100 M0 100 V34"/></g>
    <circle r="14" stroke="${INK}" stroke-width="5"/>
    <circle r="14" stroke="#FF7A5C" stroke-width="2.6"/>
  </g>
  <circle r="2.2" fill="#FF3B5C" stroke="${INK}" stroke-width="1.2"/>
</svg>`;

/**
 * 2x scope frame (full-screen layer after adsTimeMs): a wider lens (46vmin) and a lighter frame (88%) than the 4x / 8x
 * (42vmin, 100%), a coral inner rim. Iris in: 34 -> 46vmin over 120 ms; out: 80 ms fade.
 */
export const SCOPE_2X_FRAME = {
  lensRadiusVmin: 46,
  irisFromVmin: 34,
  outsideColor: 'rgba(20,14,26,0.88)',
  rimColor: '#FF7A5C',
  background: 'radial-gradient(circle at 50% 50%, transparent 0 45.6vmin, #2A1D33 45.6vmin 46.6vmin, rgba(20,14,26,0.88) 46.6vmin)',
  innerShadow: { from: 0.92, to: 1, color: '#140E1A', maxOpacity: 0.35 },
} as const;

/** Overlay rim colour per scoped sight (the scope's accent; 4x / 8x are the M2a colours). */
export const SCOPE_RIM_COLOR = { scope_2x: '#FF7A5C', scope_4x: '#5B8DEF', scope_8x: '#FF6FA8' } as const;
