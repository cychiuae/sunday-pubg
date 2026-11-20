/**
 * M2c item levels (art): the level colour scale, the level collar with N pips, the per-level weapon dressing and the
 * per-level tone. Owner: graphics-designer. Spec: docs/art/M2c.md §1 (colours, collar) and §15 (per-level models).
 *
 * Level colours are the "heat ladder" (Breezy, Warm, Hot, Scorcher). They are ALWAYS paired with a numeral or pips.
 *
 * Per-level model rule (Addendum 2 + Addendum 4, docs/art/M2c.md §15 / §17). Every level is its own BODY (bespoke
 * per weapon, `WeaponDesign.levels` in weapons.ts / melee.ts). On top of that body, `levelDressPieces` adds the small
 * shared "level language" that is the same on every weapon:
 *   L1 salvaged   family colour dulled toward driftwood, 2 tape wraps, a frayed cord loop
 *   L2 standard   the clean M2b model (no extras)
 *   L3 upgraded   ribbed rubber grip wrap (+ a muzzle device where the weapon lists one)
 *   L4 premium    chrome side trims and a star badge (+ a swept fin where the weapon lists one); colour a touch brighter
 * Anchors never move between levels (muzzle, sight eye, rail, hand points); extras stay within ±10 % of the length.
 */
import * as THREE from 'three';
import type { ItemLevel } from '../../shared/types';
import { xf, type Piece, type V3 } from './builder';
import { mixHex, palette } from './materials';

/** Level base colours (world, badge fill, ground ring, collar). docs/art/M2c.md §1.1. */
export const LEVEL_COLORS: Readonly<Record<ItemLevel, number>> = { 1: 0xb8e7ff, 2: 0xfff14d, 3: 0xf2590d, 4: 0xb963e3 };
/** Text-on-dark-panel variants (HUD text on `#1D2B4A`, >= 4.5 : 1). */
export const LEVEL_TEXT_COLORS: Readonly<Record<ItemLevel, number>> = { 1: 0xb8e7ff, 2: 0xfff14d, 3: 0xff7a3d, 4: 0xd08bf0 };
/** Additive glow variants (beams, sparkles). */
export const LEVEL_GLOW_COLORS: Readonly<Record<ItemLevel, number>> = { 1: 0xb8e7ff, 2: 0xfff14d, 3: 0xff8048, 4: 0xd494f2 };
/** Numeral / pip colour on the level fill (ink on all four: >= 4.5 : 1). */
export const LEVEL_NUMERAL_COLOR = palette.ink;
/** Cream supply marker for non-levelled items (ammo, heals, throwables, scopes). */
export const SUPPLY_MARKER_COLOR = 0xfff3d6;

/** Clamp anything to a valid ItemLevel (1..4). */
export function clampLevel(level: number): ItemLevel {
  const l = Math.round(Number.isFinite(level) ? level : 1);
  return (l <= 1 ? 1 : l >= 4 ? 4 : l) as ItemLevel;
}

const DRIFT = 0xa8957c;
/** Per-level tone of a weapon family colour: L1 worn (dulled), L2/L3 as authored, L4 a little brighter. */
export function levelTone(hex: number, level: ItemLevel | undefined): number {
  if (level === 1) return mixHex(hex, DRIFT, 0.38);
  if (level === 4) return mixHex(hex, 0xffffff, 0.12);
  return hex;
}

// -------------------------------------------------------------------------------------------------
// Collar
// -------------------------------------------------------------------------------------------------
/**
 * Where the collar wraps, in the weapon frame. 'box': a rectangular receiver (w x h at centre y); 'round': a tube of
 * radius r. The collar is `len` long along Z and centred at z. Its top must stay below the sight line.
 */
export type CollarSpec =
  | { shape: 'box'; y: number; z: number; w: number; h: number; len?: number }
  | { shape: 'round'; y: number; z: number; r: number; len?: number };

export const COLLAR_LEN = 0.048;
const PIP = 0.009;
const PIP_STEP = 0.0115;

/**
 * Level collar: a raised wrap band (level colour, inked) + N pip studs on both side faces (ink). Pips are single
 * boxes running through the band, so each pip shows on the left AND right face for 12 tris. <= 60 colour tris.
 */
export function collarPieces(c: CollarSpec, level: ItemLevel): Piece[] {
  const len = c.len ?? COLLAR_LEN;
  const col = LEVEL_COLORS[level];
  const P: Piece[] = [];
  let halfW: number;
  if (c.shape === 'box') {
    P.push({ geo: new THREE.BoxGeometry(c.w + 0.008, c.h + 0.004, len), color: col, matrix: xf([0, c.y - 0.002, c.z]) });
    halfW = c.w / 2 + 0.004;
  } else {
    P.push({ geo: new THREE.CylinderGeometry(c.r + 0.005, c.r + 0.005, len, 10).rotateX(Math.PI / 2), color: col, matrix: xf([0, c.y, c.z]) });
    halfW = c.r + 0.005;
  }
  const span = (level - 1) * PIP_STEP;
  for (let i = 0; i < level; i++) {
    const z = c.z - span / 2 + i * PIP_STEP;
    P.push({ geo: new THREE.BoxGeometry(halfW * 2 + 0.008, PIP, PIP), color: LEVEL_NUMERAL_COLOR, matrix: xf([0, c.y, z]), outline: false });
  }
  return P;
}

// -------------------------------------------------------------------------------------------------
// Per-level dressing
// -------------------------------------------------------------------------------------------------
/** Anchors for the per-level extras of one weapon (weapon frame). All optional: a weapon lists what fits it. */
export interface LevelDress {
  /** L1: tape wraps (same shapes as a collar, tape grey, no pips). */
  wraps?: CollarSpec[];
  /** L1: frayed cord loop hanging from this point (stock end / pommel). */
  loop?: V3;
  /** L3: muzzle device (round): centre, radius and length. Must end behind the toy tip / muzzle. */
  brake?: { c: V3; r: number; len: number; /** Y squash (flat blade caps). */ flatY?: number };
  /** L3: ribbed rubber grip wrap: a box slightly bigger than the grip, centre c, size, tilt about X. */
  grip?: { c: V3; w: number; h: number; d: number; rx: number };
  /** L4: a swept fin under the weapon: centre, length along Z, height (h > 0 hangs down; h < 0 stands up). */
  fin?: { c: V3; len: number; h: number; tilt?: number };
  /** L4: chrome side trims along Z at height y, from z0 to z1, at +-x. */
  trim?: { y: number; z0: number; z1: number; x: number };
  /** L4: star badge on the left face (-X) at this point. */
  star?: V3;
}

export const LEVEL_DRESS_COLORS = {
  tape: 0xc9ced6,
  tapeDark: 0xa9aeb8,
  cord: 0xd9c49a,
  rubber: 0x2e2b3a,
  chrome: 0xe9eef5,
  star: 0xffc43d,
} as const;

/** Flat 5-point star in the YZ plane facing -X (a decal). 10 tris. */
function starGeometry(r: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  // Shape is in XY facing +Z: turn it to face -X (normal -X), shape x -> world Z, shape y -> world Y.
  return new THREE.ShapeGeometry(shape).rotateY(-Math.PI / 2);
}

/** The shared per-level extra pieces of a weapon (see the module comment for the rule). L2 has none. */
export function levelDressPieces(d: LevelDress, level: ItemLevel | undefined): Piece[] {
  if (level === undefined || level === 2) return [];
  const C = LEVEL_DRESS_COLORS;
  const P: Piece[] = [];
  if (level === 1) {
    (d.wraps ?? []).forEach((w, i) => {
      const len = (w.len ?? 0.03) * 0.8;
      const col = i % 2 ? C.tapeDark : C.tape;
      if (w.shape === 'box') {
        P.push({ geo: new THREE.BoxGeometry(w.w + 0.007, w.h + 0.006, len), color: col, matrix: xf([0, w.y, w.z], [0, 0, i % 2 ? 0.08 : -0.06]) });
      } else {
        P.push({ geo: new THREE.CylinderGeometry(w.r + 0.004, w.r + 0.004, len, 8).rotateX(Math.PI / 2), color: col, matrix: xf([0, w.y, w.z], [0, 0, 0.3]) });
      }
    });
    if (d.loop) {
      P.push({ geo: new THREE.TorusGeometry(0.03, 0.005, 3, 8), color: C.cord, matrix: xf([d.loop[0], d.loop[1] - 0.03, d.loop[2]], [0, Math.PI / 2, 0.3]), outline: false });
    }
    return P;
  }
  if (level === 3 && d.brake) {
    const b = d.brake;
    P.push({ geo: new THREE.CylinderGeometry(b.r, b.r, b.len, 8).rotateX(Math.PI / 2), color: palette.gunDark, matrix: xf(b.c, [0, 0, 0], [1, b.flatY ?? 1, 1]) });
    // two port slots per side (decal boxes, no hull)
    for (const dz of [-b.len * 0.22, b.len * 0.22]) {
      P.push({ geo: new THREE.BoxGeometry(b.r * 2 + 0.004, b.r * 0.7 * (b.flatY ?? 1), b.len * 0.18), color: palette.ink, matrix: xf([b.c[0], b.c[1], b.c[2] + dz]), outline: false });
    }
  }
  if (level === 3 && d.grip) {
    const g = d.grip;
    const tilt = xf(g.c, [g.rx, 0, 0]);
    for (const k of [-1, 0, 1]) {
      P.push({ geo: new THREE.BoxGeometry(g.w + 0.008, g.h * 0.2, g.d + 0.008), color: C.rubber, matrix: tilt.clone().multiply(xf([0, k * g.h * 0.3, 0])), outline: false });
    }
  }
  if (level === 4) {
    if (d.fin) {
      const f = d.fin;
      // a swept blade-like fin: a thin box sheared back (rotated) hanging under the weapon
      const h = Math.abs(f.h);
      P.push({ geo: new THREE.BoxGeometry(0.008, h, f.len), color: C.chrome, matrix: xf([f.c[0], f.c[1] - f.h / 2, f.c[2]], [f.tilt ?? (f.h > 0 ? 0.35 : 0), 0, 0]) });
    }
    if (d.trim) {
      const t = d.trim;
      const len = Math.abs(t.z1 - t.z0);
      const zc = (t.z0 + t.z1) / 2;
      P.push({ geo: new THREE.BoxGeometry(t.x * 2 + 0.006, 0.008, len), color: C.chrome, matrix: xf([0, t.y, zc]), outline: false });
    }
    if (d.star) {
      P.push({ geo: starGeometry(0.016), color: C.star, matrix: xf([d.star[0] - 0.002, d.star[1], d.star[2]]), outline: false });
    }
  }
  return P;
}
