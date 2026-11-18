/**
 * Office prop kit (M2b "tiny heroes" office map). Owner: graphics-designer.
 * Spec: docs/art/STYLE.md §19 "Office map"; budgets + collider dimensions: docs/art/ASSET_LIST.md "Office props".
 *
 * Every prop is authored in REAL-WORLD metres and baked at OFFICE_SCALE (9x), so scale 1 = map size: a desk top is
 * 6.66 m up and a chibi (1.3 m) runs underneath. Same chibi toon look as the island: one vertex-coloured mesh
 * ('body', the shared toon material) + one inverted hull ('outline'). Some kinds add:
 *   'glass'  tinted transparent panes (officeGlassMaterial)
 *   'frost'  frosted band + toon glare streaks on glass (officeFrostMaterial)
 *   'glow'   unlit emissive light diffusers (officeGlowMaterial; switch to officeGlowOffMaterial for "Lights Out")
 * All part matrices are identity, so every kind is instanceable exactly like island props:
 *   instanceMatrix = T(x, y, z) * R_y(rotY) * S(scale) * part.matrix
 *
 * Origins (see OFFICE_KIT[kind].origin in src/shared/kits/office.ts):
 *   'floor'    centre of the footprint at floor level (y = 0)
 *   'surface'  centre of the footprint at the bottom; place on a desk top (y = OFFICE_DESK_TOP_Y) or the floor
 *   'wall'     floor level, back face on the local z = 0 plane, the prop extends toward -Z (hang on a wall face)
 *   'ceiling'  top centre (hang from the ceiling height; the prop extends downward)
 * Fronts face -Z (desk users, chair seats, screens, faces of plushies, doors of pods).
 *
 * Colliders, sizes and origins are pure data in src/shared/kits/office.ts (OFFICE_KIT, no three.js; the sim reads it
 * through map.kit). getOfficePropInfo(kind) = that kit entry + the render budget and notes. When a model changes
 * shape, update the kit too: office.test.ts checks every collider and `size` against the drawn mesh.
 */
import * as THREE from 'three';
import { buildMerged, xf, type ColorFn, type Merged, type Piece, type V3 } from './builder';
import { ensureOutlineNormals, OUTLINE, outlineMaterial, palette, vertexColorToon } from './materials';
import type { KitCollider, PropKitEntry } from '../../shared/types';
import {
  OFFICE_DESK_TOP_Y, OFFICE_KIT, OFFICE_KIT_KINDS, OFFICE_SCALE, OFFICE_WALL_HEIGHT, OFFICE_WALL_MODULE,
  OFFICE_WALL_THICKNESS, OFFICE_BOOK_STAIRS_TOP_REAL, type OfficeKitKind,
} from '../../shared/kits/office';
import type { PropPart } from './props';

export { OFFICE_DESK_TOP_Y, OFFICE_KIT, OFFICE_SCALE, OFFICE_WALL_HEIGHT, OFFICE_WALL_MODULE };
/** The office prop kinds (= OFFICE_KIT keys, src/shared/kits/office.ts). */
export const OFFICE_PROP_KINDS = OFFICE_KIT_KINDS;
export type OfficePropKind = OfficeKitKind;

/** Office palette (sRGB). Mirrors docs/art/STYLE.md §19. */
export const officePalette = {
  floorPlank: 0xd9ae7a, floorPlank2: 0xcb9c66, floorSeam: 0xa97c4d,
  carpet: 0x5e6f8a, carpet2: 0x56667f, tile: 0xe6eef0, tileGrout: 0xc5d2d6,
  wall: 0xf3f1ea, wallShade: 0xdcd8cd, skirting: 0xc8a06e, ceiling: 0x3a3f47, duct: 0x8a9099,
  deskTop: 0xf7f7f4, deskWood: 0xe2be8a, deskWoodDark: 0xc9a06a, frameWhite: 0xe9e7e1,
  chairMesh: 0x363a44, chairMeshLight: 0x4e5462, chairPlastic: 0x262a31,
  bezel: 0x2a2d34, screen: 0x36507a, screenWindow: 0x6c8fc2, screenBar: 0xa9c4e8,
  laptop: 0xc9cdd3, laptopDark: 0x3b3f47, keyboard: 0xf2f2ee, keys: 0xd6d6cf,
  bookColours: [0xe4572e, 0x2e86ab, 0xf2c14e, 0x4c9f70, 0x8e6cbf, 0xf28fad] as readonly number[],
  pages: 0xfff8e7, cardboard: 0xc89a63, cardboardDark: 0xa87c48, tape: 0xe8d3a8,
  whiteboard: 0xfafaf8, alu: 0xb9bec6, aluDark: 0x8d939c,
  plushSeal: 0xdcd6f0, plushCrab: 0xff7a5c, plushWhale: 0x8edfd0, plushBelly: 0xfff5e1,
  bottle: 0x9ed6f0, bottleCap: 0x2e86ab, mug: 0x2ec4b6, coffee: 0x6b4428,
  potWhite: 0xefede6, soil: 0x5b3a29, leaf: 0x4cbb4a, leafDark: 0x34983f, leafEdge: 0xd8e36a,
  cabinet: 0xd5d8dc, cabinetDark: 0xaeb3ba, handle: 0x3d3a4b,
  printer: 0xe7e9ec, printerDark: 0x3a3f47, paper: 0xffffff,
  cork: 0xc99a5b, notes: [0xfff07a, 0xff9fb8, 0x9fe8f0, 0xb8f28c, 0xffc98a] as readonly number[],
  extinguisher: 0xe23b2e, hose: 0x2a2d34,
  pod: 0xf5f5f2, podTrim: 0xd9d9d4, podWood: 0xd6b07c, podFelt: 0x5e6f8a,
  glass: 0xbfe6f0, frost: 0xf4fafc,
  pingPong: 0x2f6db5, pingPongLine: 0xffffff, net: 0x2a2d34,
  foosWood: 0xb97f48, foosField: 0x3e9b5a, rod: 0xc9cdd3, foosRed: 0xe94f37, foosBlue: 0x2e86de,
  weightPink: 0xff6fa8, weightTeal: 0x2ec4b6, weightMango: 0xffc43d, rackDark: 0x3a3f47,
  guitar: 0xe7a45c, guitarRim: 0x7e5333, guitarNeck: 0x5b3a29,
  counterTop: 0x9aa3ad, steel: 0xc3c9cf, machine: 0x2e3138, beans: 0x8a5a34, ledRed: 0xff3b5c,
  lightHousing: 0xd9dce0, lightGlow: 0xf4fbff, acBody: 0x3a3f47, acPanel: 0xedeeef,
} as const;
const O = officePalette;

/** Kept for existing callers: the shared kit collider type. */
export type OfficeCollider = KitCollider;

/** The kit entry (origin, size, colliders; src/shared/kits/office.ts) plus render-only budget and notes. */
export interface OfficePropInfo extends PropKitEntry {
  /** Colour-mesh triangle budget (unit-tested); the hull is about the same or less. */
  budget: number;
  notes: string;
}

// -------------------------------------------------------------------------------------------------
// Authoring helpers (REAL metres)
// -------------------------------------------------------------------------------------------------
interface Opt { r?: V3; outline?: boolean; flat?: boolean; colorFn?: ColorFn }
/** Box w x h x d with its BOTTOM at y0, centred on x / z. */
const bx = (w: number, h: number, d: number, x: number, y0: number, z: number, color: number, o: Opt = {}): Piece => ({
  geo: new THREE.BoxGeometry(w, h, d), color, matrix: xf([x, y0 + h / 2, z], o.r ?? [0, 0, 0]),
  outline: o.outline, flat: o.flat, colorFn: o.colorFn,
});
/** Box centred at (x, y, z) with rotation (for tilted pieces). */
const bc = (w: number, h: number, d: number, c: V3, color: number, o: Opt = {}): Piece => ({
  geo: new THREE.BoxGeometry(w, h, d), color, matrix: xf(c, o.r ?? [0, 0, 0]), outline: o.outline, flat: o.flat, colorFn: o.colorFn,
});
/** Vertical cylinder with its bottom at y0. */
const cy = (rTop: number, rBot: number, h: number, x: number, y0: number, z: number, color: number, seg = 8, o: Opt & { open?: boolean } = {}): Piece => ({
  geo: new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, !!o.open), color, matrix: xf([x, y0 + h / 2, z], o.r ?? [0, 0, 0]),
  outline: o.outline, flat: o.flat, colorFn: o.colorFn,
});
/** Ellipsoid centred at c with radii s. */
const el = (c: V3, s: V3, color: number, w = 8, h = 6, o: Opt = {}): Piece => ({
  geo: new THREE.SphereGeometry(1, w, h), color, matrix: xf(c, o.r ?? [0, 0, 0], s), outline: o.outline, flat: o.flat, colorFn: o.colorFn,
});
/** Flat face decal on a -Z facing surface (eyes, blush): a squashed lens. */
const dot = (c: V3, r: number, color: number, ry = r): Piece => ({
  geo: new THREE.SphereGeometry(1, 6, 3), color, matrix: xf(c, [Math.PI / 2, 0, 0], [r, 0.004, ry]), outline: false,
});

const Sx = OFFICE_SCALE;

interface Spec {
  body: Piece[];
  glass?: Piece[];
  frost?: Piece[];
  glow?: Piece[];
  outline: number;
  origin: OfficePropInfo['origin'];
  budget: number;
  notes: string;
}

/** Two toon glare streaks (frost part) on a pane in the x/y plane at depth z, inside w x h centred at (cx, cy). */
function glare(cx: number, cyy: number, z: number, w: number, h: number): Piece[] {
  const len = Math.min(h * 0.45, w * 0.9);
  return [
    bc(len, 0.03, 0.004, [cx - w * 0.18, cyy + h * 0.22, z], O.frost, { r: [0, 0, 0.9], outline: false }),
    bc(len * 0.6, 0.015, 0.004, [cx - w * 0.04, cyy + h * 0.22, z], O.frost, { r: [0, 0, 0.9], outline: false }),
  ];
}

// -------------------------------------------------------------------------------------------------
// Furniture
// -------------------------------------------------------------------------------------------------
function desk(wood: boolean): Spec {
  const W = 1.4, D = 0.75, H = 0.74, T = 0.03;
  const top = wood ? O.deskWood : O.deskTop;
  const frame = wood ? O.frameWhite : O.deskWood;
  const frameDark = wood ? O.wallShade : O.deskWoodDark;
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 90,
    notes: wood ? 'light-wood top on a white frame' : 'white top on light-wood leg panels',
    body: [
      bx(W, T, D, 0, H - T, 0, top),
      bx(W + 0.004, 0.012, D + 0.004, 0, H - 0.022, 0, wood ? O.deskWoodDark : O.deskWood, { outline: false }), // edge band
      bx(0.04, H - T, 0.6, -0.66, 0, 0, frame),
      bx(0.04, H - T, 0.6, 0.66, 0, 0, frame),
      bx(0.07, 0.03, 0.7, -0.66, 0, 0, frameDark),
      bx(0.07, 0.03, 0.7, 0.66, 0, 0, frameDark),
      bx(1.28, 0.06, 0.04, 0, 0.6, 0.3, frame), // back beam (cable tray), 5.4 m up: head-clear
    ],
  };
}

/** Mesh office chair, seat front toward -Z. */
function chair(): Spec {
  const m = O.chairMesh, pl = O.chairPlastic;
  // Mesh look: horizontal stripes on the backrest.
  const meshStripes: ColorFn = (_n, c) => (Math.floor(c.y / 0.045) % 2 === 0 ? O.chairMesh : O.chairMeshLight);
  const P: Piece[] = [
    bx(0.5, 0.07, 0.48, 0, 0.42, 0, m),
    { geo: new THREE.BoxGeometry(0.46, 0.5, 0.05, 1, 6, 1), color: m, matrix: xf([0, 0.86, 0.25], [-0.12, 0, 0]), colorFn: meshStripes },
    bx(0.07, 0.24, 0.04, 0, 0.47, 0.25, pl),
    cy(0.026, 0.026, 0.36, 0, 0.07, 0, O.aluDark, 6, { open: true }),
    cy(0.045, 0.045, 0.05, 0, 0.05, 0, pl, 6),
  ];
  for (const s of [-1, 1]) {
    P.push(bx(0.03, 0.2, 0.03, s * 0.27, 0.48, 0.06, pl));
    P.push(bx(0.05, 0.03, 0.26, s * 0.27, 0.66, 0.02, pl));
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
    const cx = Math.cos(a) * 0.16, cz = -Math.sin(a) * 0.16;
    P.push(bc(0.05, 0.035, 0.32, [cx, 0.07, cz], pl, { r: [0, a - Math.PI / 2, 0] }));
    P.push(bx(0.045, 0.045, 0.045, Math.cos(a) * 0.31, 0, -Math.sin(a) * 0.31, pl, { outline: false }));
  }
  return {
    outline: OUTLINE.prop, origin: 'floor', budget: 300, body: P,
    notes: 'seat top 0.49 real; back to 1.12; arms at 0.69',
  };
}

/** One screen with its face toward -Z, centred at (x, y, z), turned by ry. */
function screen(x: number, y: number, z: number, ry: number): Piece[] {
  const r: V3 = [0, ry, 0];
  const off = (dx: number, dy: number, dz: number): V3 => {
    const c = Math.cos(ry), s = Math.sin(ry);
    return [x + dx * c + dz * s, y + dy, z - dx * s + dz * c];
  };
  return [
    bc(0.55, 0.33, 0.03, [x, y, z], O.bezel, { r }),
    bc(0.52, 0.3, 0.004, off(0, 0, -0.016), O.screen, { r, outline: false }),
    bc(0.22, 0.13, 0.004, off(-0.1, 0.05, -0.0185), O.screenWindow, { r, outline: false }),
    bc(0.52, 0.025, 0.004, off(0, -0.135, -0.0185), O.screenBar, { r, outline: false }),
  ];
}

function monitor(dual: boolean): Spec {
  const P: Piece[] = [
    bx(0.08, 0.02, 0.12, 0, 0, 0.12, O.bezel), // desk clamp
    cy(0.018, 0.018, 0.42, 0, 0.02, 0.12, O.aluDark, 6),
  ];
  if (dual) {
    P.push(bx(0.62, 0.03, 0.03, 0, 0.3, 0.06, O.aluDark));
    P.push(bx(0.03, 0.03, 0.08, 0, 0.3, 0.1, O.aluDark));
    P.push(...screen(-0.29, 0.32, 0.0, -0.2), ...screen(0.29, 0.32, 0.0, 0.2));
  } else {
    P.push(bx(0.035, 0.03, 0.12, 0, 0.3, 0.06, O.aluDark));
    P.push(...screen(0, 0.32, 0, 0));
  }
  return {
    outline: OUTLINE.prop, origin: 'surface', budget: dual ? 160 : 100, body: P,
    notes: 'origin on the desk top at the screen centre; clamp 0.12 real behind (keep origin >= 0.2 real from the back edge)',
  };
}

function laptop(): Spec {
  return {
    outline: OUTLINE.prop, origin: 'surface', budget: 60, notes: 'lid open ~105 degrees, hinge at +Z',
    body: [
      bx(0.31, 0.015, 0.22, 0, 0, 0, O.laptop),
      bx(0.27, 0.003, 0.1, 0, 0.015, -0.02, O.laptopDark, { outline: false }),
      bc(0.31, 0.21, 0.008, [0, 0.015 + 0.105 * Math.cos(0.26), 0.11 + 0.105 * Math.sin(0.26)], O.laptop, { r: [-0.26, 0, 0] }),
      bc(0.27, 0.17, 0.003, [0, 0.015 + 0.105 * Math.cos(0.26), 0.11 + 0.105 * Math.sin(0.26) - 0.005], O.screen, { r: [-0.26, 0, 0], outline: false }),
    ],
  };
}

function keyboardPieces(): Piece[] {
  return [
    bx(0.44, 0.025, 0.14, 0, 0, 0, O.keyboard),
    bx(0.41, 0.006, 0.05, 0, 0.025, -0.03, O.keys, { outline: false }),
    bx(0.41, 0.006, 0.035, 0, 0.025, 0.025, O.keys, { outline: false }),
    bx(0.16, 0.006, 0.02, -0.02, 0.025, 0.055, O.keys, { outline: false }),
  ];
}

function keyboard(): Spec {
  return {
    outline: OUTLINE.prop, origin: 'surface', budget: 48, body: keyboardPieces(), notes: '0.27 m world tall: a walkable step',
  };
}

/** Keyboard tipped up as a ramp: long axis along Z, low edge at +Z on the floor, high edge on a bookStack. */
function keyboardRamp(): Spec {
  const L = 0.44, T = 0.025, rise = 0.105; // rise = bookStack height
  const a = Math.asin((rise - T) / L);
  // Authored flat with the long axis on X and the bottom at y = 0: turn it along Z, tilt the -Z end up, lift the
  // low (+Z) edge back onto the floor.
  const m = new THREE.Matrix4().makeTranslation(0, (L / 2) * Math.sin(a), 0)
    .multiply(new THREE.Matrix4().makeRotationX(a))
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  const body = keyboardPieces().map((p) => ({ ...p, matrix: m.clone().multiply(p.matrix!) }));
  const run = L * Math.cos(a);
  return {
    outline: OUTLINE.prop, origin: 'floor', budget: 48, body,
    notes: `rise ${(rise * Sx).toFixed(2)} m over ${(run * Sx).toFixed(2)} m (${((a * 180) / Math.PI).toFixed(0)} deg): pair with a bookStack at its -Z end`,
  };
}

const BOOK_T = 0.035;
/** One hardcover book, bottom at y0: cover colour, cream fore-edge on +X. */
function book(x: number, y0: number, z: number, ry: number, color: number, w = 0.21, d = 0.28): Piece[] {
  return [
    bx(w, BOOK_T, d, x, y0, z, color, { r: [0, ry, 0] }),
    { geo: new THREE.BoxGeometry(w - 0.012, BOOK_T - 0.01, d - 0.014), color: O.pages, matrix: xf([x + 0.008 * Math.cos(ry), y0 + BOOK_T / 2, z - 0.008 * Math.sin(ry)], [0, ry, 0]), outline: false },
  ];
}

function bookStack(): Spec {
  const C = O.bookColours;
  return {
    outline: OUTLINE.prop, origin: 'surface', budget: 80, notes: '3 books = 0.95 m world: one jump step',
    body: [...book(0, 0, 0, 0.05, C[0]), ...book(0.01, BOOK_T, -0.01, -0.12, C[1]), ...book(-0.008, BOOK_T * 2, 0.008, 0.1, C[2], 0.19, 0.26)],
  };
}

/**
 * Book staircase: 7 piles of books along -Z, each pile 3 books (0.945 m world) higher than the last, ending at desk
 * height. Each pile is ONE box segmented per book (cheap) with book-colour bands and a cream fore-edge on the sides.
 */
function bookStairs(): Spec {
  const STEPS = 7, TREAD = 0.2, W = 0.25, D = TREAD + 0.02;
  const C = O.bookColours;
  const bands: ColorFn = (n, c) => {
    const k = Math.floor((c.y + 1e-4) / BOOK_T);
    if (Math.abs(n.x) > 0.7) return k % 2 ? O.pages : 0xf3e9cf;
    return C[(k * 5 + Math.floor((c.z + 10) / TREAD)) % C.length];
  };
  const P: Piece[] = [];
  for (let i = 1; i <= STEPS; i++) {
    const h = i === STEPS ? OFFICE_BOOK_STAIRS_TOP_REAL : BOOK_T * 3 * i;
    const z = TREAD * (STEPS / 2 - i + 0.5);
    P.push({ geo: new THREE.BoxGeometry(W, h, D, 1, Math.max(1, Math.round(h / BOOK_T)), 1), color: C[0], matrix: xf([((i % 2) - 0.5) * 0.012, h / 2, z]), colorFn: bands });
  }
  return {
    outline: OUTLINE.prop, origin: 'floor', budget: 760, body: P,
    notes: '7 steps of 0.945 m (jump), treads 1.8 m deep, top step 6.615 m (desk top 6.66 is a 0.045 m walk-up); climbs toward -Z (put the -Z end against a desk)',
  };
}

function cardboard(w: number, h: number, d: number, budget: number, notes: string): Spec {
  return {
    outline: OUTLINE.prop, origin: 'surface', budget, notes,
    body: [
      bx(w, h, d, 0, 0, 0, O.cardboard),
      bx(0.06, 0.003, d + 0.004, 0, h, 0, O.tape, { outline: false }),
      bx(0.06, h * 0.35, 0.003, 0, h * 0.65, -d / 2 - 0.0015, O.tape, { outline: false }),
      bx(w + 0.003, 0.004, d + 0.003, 0, h * 0.5, 0, O.cardboardDark, { outline: false }),
    ],
  };
}

/** Fallen whiteboard as a ramp from the floor (+Z end) up to desk height (-Z end). */
function whiteboardRamp(): Spec {
  const W = 1.2, L = 1.8, T = 0.02, H = 0.74;
  const a = Math.asin((H - T) / L);
  const cyy = H - (L / 2) * Math.sin(a) - (T / 2) * Math.cos(a);
  const tilt = xf([0, cyy, 0], [a, 0, 0]);
  const on = (p: Piece): Piece => ({ ...p, matrix: tilt.clone().multiply(p.matrix!) });
  const body: Piece[] = [
    bc(W, T, L, [0, 0, 0], O.whiteboard),
    bc(W + 0.04, T + 0.01, 0.025, [0, 0, -L / 2], O.alu),
    bc(W + 0.04, T + 0.01, 0.025, [0, 0, L / 2], O.alu),
    bc(0.025, T + 0.01, L, [-W / 2 - 0.01, 0, 0], O.alu),
    bc(0.025, T + 0.01, L, [W / 2 + 0.01, 0, 0], O.alu),
    bc(W * 0.8, 0.04, 0.05, [0, 0.02, L / 2 - 0.05], O.aluDark), // marker tray near the floor end
    // marker doodles
    bc(0.4, 0.002, 0.025, [-0.2, T / 2, -0.3], 0x2e86de, { r: [0, 0.3, 0], outline: false }),
    bc(0.3, 0.002, 0.025, [0.25, T / 2, -0.1], 0xe94f37, { r: [0, -0.5, 0], outline: false }),
    bc(0.25, 0.002, 0.025, [0.05, T / 2, 0.35], 0x3e9b5a, { r: [0, 1.2, 0], outline: false }),
  ].map(on);
  const run = L * Math.cos(a);
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 120, body,
    notes: `rise 6.66 m over ${(run * Sx).toFixed(1)} m (${((a * 180) / Math.PI).toFixed(0)} deg), 10.8 m wide; climbs toward -Z`,
  };
}

// -------------------------------------------------------------------------------------------------
// Clutter
// -------------------------------------------------------------------------------------------------
function face(y: number, z: number, spread: number, blush: number): Piece[] {
  const P: Piece[] = [];
  for (const s of [-1, 1]) {
    P.push(dot([s * spread, y, z], 0.016, palette.ink, 0.022));
    P.push(dot([s * spread - 0.005, y + 0.008, z - 0.002], 0.005, 0xffffff));
    P.push(dot([s * (spread + 0.03), y - 0.03, z + 0.004], 0.018, blush, 0.011));
  }
  return P;
}

function plushSeal(): Spec {
  const c = O.plushSeal;
  return {
    outline: OUTLINE.prop, origin: 'surface', budget: 420, notes: '"Mochi seal": lilac-grey blob, flippers, tail',
    body: [
      el([0, 0.13, 0], [0.17, 0.13, 0.15], c, 10, 7),
      el([-0.16, 0.06, -0.02], [0.07, 0.025, 0.05], c, 6, 4, { r: [0, 0, 0.5] }),
      el([0.16, 0.06, -0.02], [0.07, 0.025, 0.05], c, 6, 4, { r: [0, 0, -0.5] }),
      el([0, 0.05, 0.17], [0.08, 0.03, 0.05], c, 6, 4),
      el([0, 0.11, -0.145], [0.03, 0.022, 0.015], 0xffb3c1, 6, 3, { outline: false }), // nose
      ...face(0.16, -0.135, 0.06, 0xffa3b8),
    ],
  };
}

function plushCrab(): Spec {
  const c = O.plushCrab;
  const P: Piece[] = [el([0, 0.1, 0], [0.16, 0.09, 0.12], c, 10, 6)];
  for (const s of [-1, 1]) {
    P.push(el([s * 0.2, 0.13, -0.09], [0.06, 0.05, 0.05], c, 6, 4));
    P.push(el([s * 0.235, 0.17, -0.11], [0.03, 0.035, 0.025], c, 4, 3));
    P.push(cy(0.012, 0.012, 0.06, s * 0.05, 0.17, -0.06, c, 5, { open: true }));
    P.push(el([s * 0.05, 0.245, -0.06], [0.03, 0.03, 0.03], 0xffffff, 5, 4));
    P.push(dot([s * 0.05, 0.245, -0.09], 0.013, palette.ink, 0.016));
    for (let k = 0; k < 3; k++) P.push({ geo: new THREE.OctahedronGeometry(1, 0), color: c, matrix: xf([s * 0.15, 0.03, 0.02 + k * 0.05], [0, s * 0.3, s * 0.5], [0.06, 0.015, 0.015]), outline: false });
  }
  P.push({ geo: new THREE.TorusGeometry(0.03, 0.006, 3, 6, Math.PI), color: palette.ink, matrix: xf([0, 0.12, -0.118], [Math.PI, 0, 0]), outline: false });
  return {
    outline: OUTLINE.prop, origin: 'surface', budget: 420, body: P, notes: 'coral beach crab: big claws, eye stalks',
  };
}

function plushWhale(): Spec {
  const c = O.plushWhale;
  const belly: ColorFn = (_n, p) => (p.y < 0.075 ? O.plushBelly : c);
  return {
    outline: OUTLINE.prop, origin: 'surface', budget: 420, notes: 'mint whale: cream belly, tail fluke up at the back',
    body: [
      el([0, 0.13, 0], [0.14, 0.13, 0.2], c, 10, 7, { colorFn: belly }),
      { geo: new THREE.OctahedronGeometry(1, 0), color: c, matrix: xf([-0.07, 0.2, 0.25], [0.6, 0.5, 0], [0.08, 0.02, 0.06]) },
      { geo: new THREE.OctahedronGeometry(1, 0), color: c, matrix: xf([0.07, 0.2, 0.25], [0.6, -0.5, 0], [0.08, 0.02, 0.06]) },
      el([0, 0.15, 0.19], [0.05, 0.06, 0.06], c, 6, 4),
      el([-0.13, 0.06, -0.04], [0.06, 0.015, 0.035], c, 5, 3, { r: [0, 0.4, 0.4] }),
      el([0.13, 0.06, -0.04], [0.06, 0.015, 0.035], c, 5, 3, { r: [0, -0.4, -0.4] }),
      ...face(0.15, -0.185, 0.065, 0xff9fb8),
    ],
  };
}

function waterBottle(): Spec {
  return {
    outline: OUTLINE.prop, origin: 'surface', budget: 110, notes: 'pale aqua bottle, blue cap and label band',
    body: [
      cy(0.035, 0.035, 0.19, 0, 0, 0, O.bottle, 8),
      cy(0.02, 0.035, 0.03, 0, 0.19, 0, O.bottle, 8, { open: true }),
      cy(0.022, 0.022, 0.035, 0, 0.215, 0, O.bottleCap, 8),
      cy(0.036, 0.036, 0.05, 0, 0.07, 0, 0xffffff, 8, { open: true, outline: false }),
    ],
  };
}

function mug(): Spec {
  return {
    outline: OUTLINE.prop, origin: 'surface', budget: 130, notes: 'teal mug with coffee, handle on +X',
    body: [
      cy(0.045, 0.042, 0.095, 0, 0, 0, O.mug, 10),
      cy(0.04, 0.04, 0.004, 0, 0.088, 0, O.coffee, 10, { outline: false }),
      { geo: new THREE.TorusGeometry(0.028, 0.009, 4, 6, Math.PI), color: O.mug, matrix: xf([0.045, 0.048, 0], [0, 0, -Math.PI / 2]) },
    ],
  };
}

function pottedPlant(): Spec {
  const P: Piece[] = [
    cy(0.15, 0.12, 0.28, 0, 0, 0, O.potWhite, 8),
    cy(0.14, 0.14, 0.01, 0, 0.26, 0, O.soil, 8, { outline: false }),
  ];
  const leaves: [number, number, number, number][] = [
    [0, 0, 0.62, 0], [0.06, 0.05, 0.5, 0.9], [-0.06, 0.04, 0.55, 2.0], [0.05, -0.06, 0.45, 3.1], [-0.05, -0.05, 0.4, 4.2], [0.0, 0.08, 0.36, 5.1], [0.08, -0.01, 0.3, 1.5],
  ];
  leaves.forEach(([x, z, h, yaw], i) => {
    P.push({
      geo: new THREE.ConeGeometry(0.045, h, 4, 1).translate(0, h / 2, 0),
      color: i % 2 ? O.leafDark : O.leaf,
      matrix: xf([x, 0.26, z], [x * 2.2, yaw, -z * 2.2], [1, 1, 0.35]),
      flat: true,
    });
  });
  return {
    outline: OUTLINE.prop, origin: 'floor', budget: 120, body: P, notes: 'white pot + snake-plant blades, 0.88 real tall',
  };
}

function filingCabinet(): Spec {
  const W = 0.45, H = 1.0, D = 0.6;
  const P: Piece[] = [bx(W, H, D, 0, 0, 0, O.cabinet)];
  for (let i = 0; i < 3; i++) {
    const y0 = 0.04 + i * 0.32;
    P.push(bx(W - 0.04, 0.29, 0.012, 0, y0, -D / 2 - 0.005, O.cabinet, { outline: false }));
    P.push(bx(0.16, 0.025, 0.03, 0, y0 + 0.2, -D / 2 - 0.02, O.handle, { outline: false }));
    P.push(bx(0.08, 0.04, 0.004, 0, y0 + 0.24, -D / 2 - 0.013, 0xffffff, { outline: false }));
  }
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 130, body: P, notes: '3 drawers, front -Z; top is a 9 m high platform',
  };
}

function printer(): Spec {
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 130, notes: 'office MFP: paper drawers, scanner lid, control panel, output tray',
    body: [
      bx(0.6, 0.55, 0.6, 0, 0, 0, O.printer),
      bx(0.56, 0.008, 0.01, 0, 0.18, -0.305, O.printerDark, { outline: false }),
      bx(0.56, 0.008, 0.01, 0, 0.36, -0.305, O.printerDark, { outline: false }),
      bx(0.58, 0.33, 0.56, 0, 0.55, 0.01, O.printer),
      bx(0.5, 0.06, 0.3, 0, 0.62, -0.12, O.printerDark, { outline: false }), // output slot shadow
      bx(0.3, 0.012, 0.22, 0.03, 0.66, -0.1, O.paper, { outline: false }),
      bx(0.58, 0.08, 0.5, 0, 0.88, 0.03, O.cabinetDark),
      bc(0.26, 0.03, 0.12, [-0.12, 0.93, -0.27], O.printerDark, { r: [0.5, 0, 0] }),
      bx(0.04, 0.012, 0.03, -0.05, 0.94, -0.27, 0x5ee06a, { outline: false }),
    ],
  };
}

function pinboard(): Spec {
  const N = O.notes;
  const P: Piece[] = [
    bx(1.2, 0.9, 0.03, 0, 0.9, -0.015, O.deskWood),
    bx(1.14, 0.84, 0.01, 0, 0.93, -0.035, O.cork, { outline: false }),
  ];
  const notes: [number, number, number, number][] = [[-0.42, 1.55, 0.1, 0.12], [-0.2, 1.35, -0.08, 0.1], [0.05, 1.6, 0.05, 0.12], [0.3, 1.4, -0.12, 0.11], [0.45, 1.15, 0.08, 0.09], [-0.35, 1.1, 0.04, 0.1], [0.1, 1.1, -0.06, 0.13]];
  notes.forEach(([x, y, rz, s], i) => {
    P.push(bc(s, s, 0.004, [x, y, -0.042], N[i % N.length], { r: [0, 0, rz], outline: false }));
    P.push(bc(0.014, 0.014, 0.008, [x, y + s * 0.4, -0.046], palette.danger, { outline: false }));
  });
  return {
    outline: OUTLINE.prop, origin: 'wall', budget: 200, body: P,
    notes: 'wall-mounted 0.9..1.8 real (8.1..16.2 m world), 0.27 m deep; back on z = 0',
  };
}

function fireExtinguisher(): Spec {
  const r = O.extinguisher, k = O.hose;
  return {
    outline: OUTLINE.prop, origin: 'floor', budget: 230, notes: 'red cylinder, dark valve, hose and horn, white label band',
    body: [
      cy(0.075, 0.075, 0.4, 0, 0.02, 0, r, 10),
      { geo: new THREE.SphereGeometry(0.075, 10, 3, 0, Math.PI * 2, 0, Math.PI / 2), color: r, matrix: xf([0, 0.42, 0]) },
      cy(0.08, 0.08, 0.02, 0, 0, 0, k, 10),
      cy(0.076, 0.076, 0.1, 0, 0.18, 0, 0xffffff, 10, { open: true, outline: false }),
      cy(0.022, 0.022, 0.06, 0, 0.48, 0, k, 6),
      bx(0.03, 0.02, 0.12, 0, 0.53, 0.02, k, { r: [0.15, 0, 0] }),
      bc(0.02, 0.18, 0.02, [-0.1, 0.42, -0.03], k, { r: [0, 0, -0.4] }),
      cy(0.02, 0.012, 0.08, -0.13, 0.26, -0.03, k, 6),
    ],
  };
}

// -------------------------------------------------------------------------------------------------
// Rooms and architecture
// -------------------------------------------------------------------------------------------------
function phoneBooth(): Spec {
  const W = 1.0, H = 2.2, w = O.pod, t = O.podTrim;
  const body: Piece[] = [
    bx(W, 0.06, W, 0, 0, 0, t),
    bx(W, H - 0.14, 0.06, 0, 0.06, W / 2 - 0.03, w),
    bx(0.06, H - 0.14, W, -W / 2 + 0.03, 0.06, 0, w),
    bx(0.06, H - 0.14, W, W / 2 - 0.03, 0.06, 0, w),
    bx(W, 0.08, W, 0, H - 0.08, 0, w),
    bx(W - 0.1, 0.03, W - 0.1, 0, H - 0.1, 0, O.lightHousing, { outline: false }),
    bx(0.1, H - 0.14, 0.06, -0.45, 0.06, -W / 2 + 0.03, w),
    bx(0.1, H - 0.14, 0.06, 0.45, 0.06, -W / 2 + 0.03, w),
    bx(0.02, 0.4, 0.03, 0.3, 0.9, -W / 2 - 0.02, O.aluDark, { outline: false }),
    bx(0.8, 0.42, 0.42, 0, 0.06, 0.24, O.podWood), // bench
    bx(0.78, 0.06, 0.4, 0, 0.48, 0.24, O.podFelt, { outline: false }),
    bx(0.5, 0.03, 0.25, 0.32, 0.95, 0.0, O.podWood, { r: [0, Math.PI / 2, 0] }), // side shelf
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    body.push(cy(0.06, 0.06, H - 0.02, sx * (W / 2 - 0.03), 0.0, sz * (W / 2 - 0.03), w, 6, { open: true }));
  }
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 260, body,
    glass: [bx(0.8, H - 0.14, 0.012, 0, 0.06, -W / 2 + 0.03, O.glass, { outline: false })],
    frost: [bx(0.8, 0.22, 0.016, 0, 1.0, -W / 2 + 0.03, O.frost, { outline: false }), ...glare(0, 1.1, -W / 2 + 0.015, 0.8, 2.0)],
    glow: [bx(0.6, 0.01, 0.6, 0, H - 0.115, 0, O.lightGlow, { outline: false })],
    notes: 'white pod, glass door on -Z (closed: solid collider with glass impact), bench + shelf inside, ceiling light',
  };
}

const WALL_T = OFFICE_WALL_THICKNESS;
const WALL_H = 3.0;
function wallSolidPieces(len: number): Piece[] {
  return [
    bx(len, WALL_H, WALL_T, 0, 0, 0, O.wall),
    bx(len, 0.08, WALL_T + 0.024, 0, 0, 0, O.skirting, { outline: false }),
  ];
}
function wallSolid(): Spec {
  const L = OFFICE_WALL_MODULE;
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 24, body: wallSolidPieces(L),
    notes: 'module 10.8 x 27 x 0.9 m world, centred on the wall line along X; stretch along X freely (or use createOfficeWall)',
  };
}

function wallGlassParts(len: number): { body: Piece[]; glass: Piece[]; frost: Piece[] } {
  const a = O.alu;
  const body: Piece[] = [
    bx(len, 0.08, WALL_T, 0, 0, 0, a),
    bx(len, 0.08, WALL_T, 0, WALL_H - 0.08, 0, a),
  ];
  const n = Math.max(1, Math.round(len / OFFICE_WALL_MODULE));
  const m = len / n;
  const glass: Piece[] = [];
  const frost: Piece[] = [];
  for (let i = 0; i <= n; i++) {
    const x = -len / 2 + i * m;
    const mw = i === 0 || i === n ? 0.025 : 0.05;
    const mx = i === 0 ? x + 0.0125 : i === n ? x - 0.0125 : x;
    body.push(bx(mw, WALL_H - 0.16, WALL_T, mx, 0.08, 0, a));
  }
  glass.push(bx(len - 0.02, WALL_H - 0.16, 0.012, 0, 0.08, 0, O.glass, { outline: false }));
  frost.push(bx(len - 0.02, 0.5, 0.018, 0, 1.0, 0, O.frost, { outline: false }));
  for (let i = 0; i < n; i++) {
    const cx = -len / 2 + (i + 0.5) * m;
    frost.push(...glare(cx, 2.1, -0.012, m * 0.8, 1.1), ...glare(cx, 2.1, 0.012, m * 0.8, 1.1));
  }
  return { body, glass, frost };
}
function wallGlass(): Spec {
  const L = OFFICE_WALL_MODULE;
  const p = wallGlassParts(L);
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 60, ...p,
    notes: 'alu frame, tinted glass, frosted band at 1.0..1.5 real; half mullions at both ends so modules tile',
  };
}

function doorFrame(): Spec {
  const OW = 0.9, OH = 2.1, J = 0.06, D = 0.14;
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 60,
    notes: 'opening 8.1 x 18.9 m world; frame is 9.18 m wide: leave that gap in the wall; lintel fills up to wall height',
    body: [
      bx(J, OH, D, -OW / 2 - J / 2, 0, 0, O.skirting),
      bx(J, OH, D, OW / 2 + J / 2, 0, 0, O.skirting),
      bx(OW + 2 * J, J, D, 0, OH, 0, O.skirting),
      bx(OW + 2 * J, WALL_H - OH - J, WALL_T, 0, OH + J, 0, O.wall),
      bx(0.3, 0.12, 0.03, 0, OH + 0.25, -WALL_T / 2 - 0.015, 0x3e9b5a, { outline: false }), // plain green exit plate (no pictogram)
    ],
  };
}

function pingPongTable(): Spec {
  const W = 1.525, L = 2.74, H = 0.76, T = 0.03;
  const lw = O.pingPongLine, k = O.net;
  const P: Piece[] = [
    bx(W, T, L, 0, H - T, 0, O.pingPong),
    bx(0.02, 0.003, L, -W / 2 + 0.01, H, 0, lw, { outline: false }),
    bx(0.02, 0.003, L, W / 2 - 0.01, H, 0, lw, { outline: false }),
    bx(W, 0.003, 0.02, 0, H, -L / 2 + 0.01, lw, { outline: false }),
    bx(W, 0.003, 0.02, 0, H, L / 2 - 0.01, lw, { outline: false }),
    bx(0.006, 0.003, L, 0, H, 0, lw, { outline: false }),
    bx(1.83, 0.15, 0.008, 0, H, 0, k),
    bx(1.83, 0.02, 0.012, 0, H + 0.14, 0, lw, { outline: false }),
  ];
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) P.push(bx(0.05, H - T, 0.05, sx * 0.62, 0, sz * 0.95, k));
    P.push(bx(1.24, 0.04, 0.04, 0, 0.15, sz * 0.95, k));
  }
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 170, body: P, notes: 'blue top 6.84 m up (walkable), long axis Z, legs leave a 6.6 m crawlspace; net drawn 1.35 m, collider 1.6 m (a wall)',
  };
}

function foosballTable(): Spec {
  const W = 0.75, L = 1.2, H = 0.9;
  const w = O.foosWood;
  const P: Piece[] = [
    bx(W, 0.16, L, 0, 0.6, 0, w),
    bx(W - 0.08, 0.02, L - 0.06, 0, 0.74, 0, O.foosField, { outline: false }),
    bx(0.04, 0.18, L, -W / 2 + 0.02, 0.72, 0, w),
    bx(0.04, 0.18, L, W / 2 - 0.02, 0.72, 0, w),
    bx(W, 0.18, 0.04, 0, 0.72, -L / 2 + 0.02, w),
    bx(W, 0.18, 0.04, 0, 0.72, L / 2 - 0.02, w),
    bx(0.2, 0.06, 0.005, 0, 0.75, -L / 2 + 0.042, palette.ink, { outline: false }),
    bx(0.2, 0.06, 0.005, 0, 0.75, L / 2 - 0.042, palette.ink, { outline: false }),
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.push(bx(0.07, 0.6, 0.07, sx * 0.3, 0, sz * 0.52, w));
  const rods = [1, 2, 3, 2, 2, 3, 2, 1];
  rods.forEach((n, i) => {
    const z = -L / 2 + 0.11 + i * 0.14;
    const team = i % 2 === 0 ? (i < 4 ? O.foosBlue : O.foosRed) : i < 4 ? O.foosRed : O.foosBlue;
    const side = i % 2 === 0 ? -1 : 1;
    P.push({ geo: new THREE.CylinderGeometry(0.008, 0.008, 1.0, 4, 1, true).rotateZ(Math.PI / 2), color: O.rod, matrix: xf([0, 0.83, z]), outline: false });
    P.push({ geo: new THREE.CylinderGeometry(0.018, 0.018, 0.1, 4, 1, true).rotateZ(Math.PI / 2), color: palette.ink, matrix: xf([side * 0.47, 0.83, z]) });
    for (let k = 0; k < n; k++) {
      const x = (k - (n - 1) / 2) * 0.18;
      P.push(bx(0.032, 0.12, 0.024, x, 0.77, z, team, { outline: false }));
    }
  });
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 480, body: P, notes: 'wooden cabinet top rim 8.1 m, field 6.8 m, 8 rods (handles stick out 0.47 real)',
  };
}

function dumbbellRack(): Spec {
  const k = O.rackDark;
  const P: Piece[] = [
    bx(0.05, 0.75, 0.45, -0.58, 0, 0, k),
    bx(0.05, 0.75, 0.45, 0.58, 0, 0, k),
    bc(1.12, 0.03, 0.18, [0, 0.36, -0.1], k, { r: [0.2, 0, 0] }),
    bc(1.12, 0.03, 0.18, [0, 0.64, 0.08], k, { r: [0.2, 0, 0] }),
  ];
  const plates = [O.weightPink, O.weightTeal, O.weightMango];
  for (let tier = 0; tier < 2; tier++) {
    for (let i = 0; i < 3; i++) {
      const x = -0.36 + i * 0.36, y = tier ? 0.71 : 0.43, z = tier ? 0.08 : -0.1;
      const col = plates[(i + tier) % 3];
      P.push({ geo: new THREE.CylinderGeometry(0.014, 0.014, 0.16, 5, 1, true).rotateZ(Math.PI / 2), color: O.steel, matrix: xf([x, y, z]), outline: false });
      for (const s of [-1, 1]) P.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, 0.045, 6).rotateZ(Math.PI / 2), color: col, matrix: xf([x + s * 0.08, y, z]), flat: true });
    }
  }
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 400, body: P, notes: '2-tier rack, 6 dumbbells with pink / teal / mango plates',
  };
}

function guitarStand(): Spec {
  const k = O.rackDark;
  const lean = xf([0, 0.06, 0.04], [-0.22, 0, 0]);
  const g = (p: Piece): Piece => ({ ...p, matrix: lean.clone().multiply(p.matrix!) });
  const disc = (r: number, d: number, c: V3, color: number, seg = 12, o: Opt = {}): Piece =>
    ({ geo: new THREE.CylinderGeometry(r, r, d, seg).rotateX(Math.PI / 2), color, matrix: xf(c), outline: o.outline });
  const guitar: Piece[] = [
    disc(0.19, 0.1, [0, 0.22, 0], O.guitar),
    disc(0.145, 0.1, [0, 0.45, 0], O.guitar),
    disc(0.195, 0.096, [0, 0.22, 0], O.guitarRim, 12, { outline: false }),
    disc(0.05, 0.004, [0, 0.4, -0.051], O.guitarNeck, 8, { outline: false }),
    bx(0.12, 0.025, 0.012, 0, 0.17, -0.052, O.guitarNeck, { outline: false }),
    bx(0.05, 0.42, 0.03, 0, 0.55, 0, O.guitarNeck),
    bx(0.075, 0.14, 0.03, 0, 0.97, 0.015, O.guitarNeck, { r: [0.25, 0, 0] }),
    bx(0.012, 0.62, 0.003, 0, 0.17, -0.053, O.pages, { outline: false }), // strings
  ].map(g);
  return {
    outline: OUTLINE.prop, origin: 'floor', budget: 280,
    notes: 'original acoustic guitar leaning on an A-frame stand, 1.1 real tall',
    body: [
      ...guitar,
      bc(0.03, 0.03, 0.42, [0, 0.03, 0.02], k, { r: [0, 0, 0] }),
      bc(0.4, 0.03, 0.03, [0, 0.03, -0.15], k),
      bc(0.03, 0.62, 0.03, [0, 0.31, 0.2], k, { r: [0.35, 0, 0] }),
      bc(0.3, 0.04, 0.06, [0, 0.12, -0.08], k),
    ],
  };
}

function pantryCounter(): Spec {
  const W = 1.8, D = 0.6, H = 0.9;
  const P: Piece[] = [
    bx(W - 0.04, 0.08, D - 0.08, 0, 0, 0.04, O.printerDark, { outline: false }),
    bx(W, H - 0.12, D - 0.02, 0, 0.08, 0.01, O.wall),
    bx(W + 0.04, 0.04, D + 0.02, 0, H - 0.04, 0, O.counterTop),
  ];
  for (let i = 0; i < 4; i++) {
    const x = -W / 2 + (i + 0.5) * (W / 4);
    if (i) P.push(bx(0.008, H - 0.16, 0.006, x - W / 8, 0.1, -D / 2 + 0.003, O.wallShade, { outline: false }));
    P.push(bx(0.12, 0.02, 0.02, x, H - 0.16, -D / 2 - 0.006, O.handle, { outline: false }));
  }
  // sink + faucet
  P.push(bx(0.45, 0.004, 0.35, -0.5, H, 0, O.steel, { outline: false }));
  P.push(cy(0.015, 0.015, 0.25, -0.5, H, 0.2, O.steel, 6));
  P.push(bx(0.025, 0.025, 0.16, -0.5, H + 0.23, 0.13, O.steel));
  // coffee machine
  const mx = 0.45;
  P.push(bx(0.3, 0.42, 0.38, mx, H, 0.05, O.machine));
  P.push(bx(0.24, 0.2, 0.02, mx, H + 0.16, -0.15, O.steel, { outline: false }));
  P.push(bx(0.2, 0.02, 0.12, mx, H + 0.02, -0.18, O.steel));
  P.push(cy(0.03, 0.025, 0.06, mx, H + 0.04, -0.17, 0xffffff, 8));
  P.push(cy(0.08, 0.06, 0.12, mx, H + 0.42, 0.08, O.beans, 8));
  P.push(dot([mx + 0.07, H + 0.32, -0.162], 0.015, O.ledRed));
  return {
    outline: OUTLINE.large, origin: 'floor', budget: 300, body: P,
    notes: 'counter top 8.1 m (walkable), coffee machine to 13.2 m; sink at -X, machine at +X; doors face -Z',
  };
}

// -------------------------------------------------------------------------------------------------
// Ceiling (visual only)
// -------------------------------------------------------------------------------------------------
function lightPanel(): Spec {
  const W = 1.2, D = 0.3, T = 0.08;
  const P: Piece[] = [
    bx(W, T - 0.012, D, 0, -T + 0.012, 0, O.lightHousing),
    bx(0.006, 0.6, 0.006, -0.5, 0, 0, O.aluDark, { outline: false }),
    bx(0.006, 0.6, 0.006, 0.5, 0, 0, O.aluDark, { outline: false }),
  ];
  for (let i = 0; i < 7; i++) P.push(bx(0.012, 0.02, D - 0.03, -0.5 + (i * 1.0) / 6, -T - 0.004, 0, O.lightHousing, { outline: false }));
  return {
    outline: OUTLINE.prop, origin: 'ceiling', budget: 140, body: P,
    glow: [bx(W - 0.04, 0.008, D - 0.04, 0, -T + 0.004, 0, O.lightGlow, { outline: false })],
    notes: 'origin = top of the housing; hang 5.4 m below its wire anchors; louvred diffuser is the glow part',
  };
}

function acCassette(): Spec {
  const P: Piece[] = [
    bx(0.57, 0.25, 0.57, 0, -0.25, 0, O.acBody),
    bx(0.65, 0.04, 0.65, 0, -0.29, 0, O.acPanel),
    bx(0.32, 0.004, 0.32, 0, -0.294, 0, O.wallShade, { outline: false }),
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    P.push(bc(0.4, 0.004, 0.05, [Math.sin(a) * 0.24, -0.293, Math.cos(a) * 0.24], O.acBody, { r: [0, a, 0], outline: false }));
  }
  return { outline: OUTLINE.prop, origin: 'ceiling', budget: 90, body: P, notes: 'origin = top centre; white face panel 0.29 real below', };
}

// -------------------------------------------------------------------------------------------------
// Registry + public API
// -------------------------------------------------------------------------------------------------
const SPECS: Record<OfficePropKind, () => Spec> = {
  desk: () => desk(false),
  deskWood: () => desk(true),
  chair,
  monitor: () => monitor(false),
  monitorDual: () => monitor(true),
  laptop,
  keyboard,
  keyboardRamp,
  bookStack,
  bookStairs,
  box: () => cardboard(0.5, 0.3, 0.4, 48, '4.5 x 2.7 x 3.6 m world: a wall-like block (climb from a boxSmall)'),
  boxSmall: () => cardboard(0.33, 0.11, 0.22, 48, '2.97 x 0.99 x 1.98 m world: one jump step'),
  whiteboardRamp,
  plushSeal,
  plushCrab,
  plushWhale,
  waterBottle,
  mug,
  pottedPlant,
  filingCabinet,
  printer,
  pinboard,
  fireExtinguisher,
  phoneBooth,
  wallSolid,
  wallGlass,
  doorFrame,
  pingPongTable,
  foosballTable,
  dumbbellRack,
  guitarStand,
  pantryCounter,
  lightPanel,
  acCassette,
};

const SCALE_M = new THREE.Matrix4().makeScale(Sx, Sx, Sx);
const scaled = (ps: Piece[]): Piece[] => ps.map((p) => ({ ...p, matrix: SCALE_M.clone().multiply(p.matrix ?? new THREE.Matrix4()) }));

let glassMat: THREE.MeshBasicMaterial | null = null;
let frostMat: THREE.MeshBasicMaterial | null = null;
let glowMat: THREE.MeshBasicMaterial | null = null;
let glowOffMat: THREE.MeshBasicMaterial | null = null;

/** Tinted see-through glass (unlit, no depth write, both sides). */
export function officeGlassMaterial(): THREE.MeshBasicMaterial {
  return (glassMat ??= Object.assign(new THREE.MeshBasicMaterial({
    color: O.glass, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide,
  }), { name: 'office:glass' }));
}
/** Frosted band + glare streaks on glass (unlit, mostly opaque white). */
export function officeFrostMaterial(): THREE.MeshBasicMaterial {
  return (frostMat ??= Object.assign(new THREE.MeshBasicMaterial({
    color: O.frost, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide,
  }), { name: 'office:frost' }));
}
/** Lit fluorescent diffuser (unlit, not tone mapped). */
export function officeGlowMaterial(): THREE.MeshBasicMaterial {
  return (glowMat ??= Object.assign(new THREE.MeshBasicMaterial({ color: O.lightGlow, toneMapped: false }), { name: 'office:glow' }));
}
/** Switched-off diffuser for the "Lights Out" zone (swap per instance batch). */
export function officeGlowOffMaterial(): THREE.MeshBasicMaterial {
  return (glowOffMat ??= Object.assign(new THREE.MeshBasicMaterial({ color: 0x5a6270 }), { name: 'office:glowOff' }));
}

function buildParts(spec: Spec, name: string): PropPart[] {
  const merged: Merged = buildMerged(scaled(spec.body), name);
  const big = spec.origin !== 'surface';
  const parts: PropPart[] = [
    { name: 'body', geometry: merged.geometry, material: vertexColorToon(), matrix: new THREE.Matrix4(), castShadow: spec.origin !== 'ceiling', receiveShadow: big },
  ];
  if (merged.outline) {
    parts.push({ name: 'outline', geometry: ensureOutlineNormals(merged.outline), material: outlineMaterial(spec.outline), matrix: new THREE.Matrix4(), castShadow: false, receiveShadow: false });
  }
  const extra = (list: Piece[] | undefined, part: string, mat: THREE.Material) => {
    if (!list?.length) return;
    const g = buildMerged(scaled(list.map((p) => ({ ...p, outline: false }))), `${name}:${part}`).geometry;
    parts.push({ name: part, geometry: g, material: mat, matrix: new THREE.Matrix4(), castShadow: false, receiveShadow: false });
  };
  extra(spec.glass, 'glass', officeGlassMaterial());
  extra(spec.frost, 'frost', officeFrostMaterial());
  extra(spec.glow, 'glow', officeGlowMaterial());
  return parts;
}

const partsCache = new Map<string, PropPart[]>();
const infoCache = new Map<OfficePropKind, OfficePropInfo>();

/**
 * Instanceable parts of an office prop kind: 'body' + 'outline' (+ 'glass' / 'frost' / 'glow'). Geometry and
 * materials are cached and shared; do not dispose them per instance. All part matrices are identity.
 * Render order hint: glass and frost after opaque (renderOrder 1 / 2).
 */
export function getOfficePropParts(kind: OfficePropKind): PropPart[] {
  let p = partsCache.get(kind);
  if (!p) {
    const make = SPECS[kind];
    if (!make) throw new Error(`Unknown office prop kind: ${kind}`);
    p = buildParts(make(), `office:${kind}`);
    partsCache.set(kind, p);
  }
  return p;
}

/** A ready-to-add office prop (Group of shared meshes). Apply position / rotY / scale on the group. */
export function createOfficeProp(kind: OfficePropKind): THREE.Object3D {
  const g = new THREE.Group();
  g.name = `office:${kind}`;
  g.userData.kind = kind;
  for (const p of getOfficePropParts(kind)) {
    const m = new THREE.Mesh(p.geometry, p.material);
    m.name = p.name;
    m.castShadow = p.castShadow;
    m.receiveShadow = p.receiveShadow;
    if (p.name !== 'body') m.raycast = () => {};
    if (p.name === 'glass') m.renderOrder = 1;
    if (p.name === 'frost') m.renderOrder = 2;
    g.add(m);
  }
  return g;
}

/**
 * Origin + size + colliders (the OFFICE_KIT entry, world metres at scale 1) plus the render budget and notes.
 * Thin adapter over src/shared/kits/office.ts; the kit is the single source of the collision data.
 */
export function getOfficePropInfo(kind: OfficePropKind): OfficePropInfo {
  let info = infoCache.get(kind);
  if (!info) {
    const entry = OFFICE_KIT[kind];
    const make = SPECS[kind];
    if (!entry || !make) throw new Error(`Unknown office prop kind: ${kind}`);
    const s = make();
    info = { ...entry, budget: s.budget, notes: s.notes };
    infoCache.set(kind, info);
  }
  return info;
}

/** Render-side origin of a kind's model (must equal OFFICE_KIT[kind].origin; unit-tested). */
export function getOfficePropModelOrigin(kind: OfficePropKind): PropKitEntry['origin'] {
  return SPECS[kind]().origin;
}

/** Local-space bounds (scale 1, world metres) of an office prop's body mesh. */
export function getOfficePropBounds(kind: OfficePropKind): THREE.Box3 {
  const body = getOfficePropParts(kind)[0].geometry;
  if (!body.boundingBox) body.computeBoundingBox();
  return body.boundingBox!.clone();
}

const wallCache = new Map<string, PropPart[]>();
/**
 * A whole straight wall run of `length` WORLD metres, centred on the origin along X, wall line on z = 0, standing
 * on y = 0, OFFICE_WALL_HEIGHT tall, 0.9 m thick. Glass runs get evenly spaced mullions (about every 10.8 m), a
 * frosted band and glare streaks. Geometry is cached per (kind, length to the cm). Use for the map's wall
 * segments (there are only a few dozen); the 'wallSolid' / 'wallGlass' kinds are the instanceable modules.
 */
export function getOfficeWallParts(kind: 'solid' | 'glass', length: number): PropPart[] {
  const real = Math.max(0.05, Math.round((length / Sx) * 100) / 100);
  const key = `${kind}|${real}`;
  let p = wallCache.get(key);
  if (!p) {
    const spec: Spec = kind === 'solid'
      ? { body: wallSolidPieces(real), outline: OUTLINE.large, origin: 'floor', budget: 0, notes: '' }
      : { ...wallGlassParts(real), outline: OUTLINE.large, origin: 'floor', budget: 0, notes: '' };
    p = buildParts(spec, `office:wall:${key}`);
    wallCache.set(key, p);
  }
  return p;
}

/** Group version of getOfficeWallParts. */
export function createOfficeWall(kind: 'solid' | 'glass', length: number): THREE.Object3D {
  const g = new THREE.Group();
  g.name = `office:wall:${kind}`;
  for (const p of getOfficeWallParts(kind, length)) {
    const m = new THREE.Mesh(p.geometry, p.material);
    m.name = p.name;
    m.castShadow = p.castShadow;
    m.receiveShadow = p.receiveShadow;
    if (p.name === 'glass') m.renderOrder = 1;
    if (p.name === 'frost') m.renderOrder = 2;
    g.add(m);
  }
  return g;
}

/**
 * Floor plank colour at world (x, z) for a vertex-coloured or baked floor (STYLE.md §19): planks 1.8 m wide along
 * X, 10.8 m long, staggered by thirds; alternating two tones from a deterministic hash. Returns sRGB hex.
 */
export function officeFloorColorAt(x: number, z: number): number {
  const row = Math.floor(z / 1.8);
  const col = Math.floor((x + (((row % 3) + 3) % 3) * 3.6) / 10.8);
  const h = Math.abs(Math.imul(row * 73856093 ^ col * 19349663, 0x5bd1e595)) % 3;
  return h === 0 ? O.floorPlank2 : O.floorPlank;
}
