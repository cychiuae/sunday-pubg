/**
 * Armor wearables (M2a, M2c level 4): helmets and vests, tiers (= item levels) 1-4. Owner: graphics-designer.
 * Spec: docs/art/STYLE.md "Armor and helmets"; budgets and attach transforms: docs/art/ASSET_LIST.md.
 *
 * Tier language (read at a glance, also without colour):
 *   1  soft cloth, beach-y     faded denim + tan canvas     bucket hat / open-front cloth vest
 *   2  padded, sporty          cobalt + white               vented skate-style helmet with a padded rim / ribbed puffer vest
 *   3  hard shell, tropical    slate + hot orange           faceted shell, brow lip, crest, ear guards / plate carrier
 *   4  from the wreck          brass / UV violet            ship's bell helmet with a top loop / surfboard vest with a tail fin
 * M2c: each tier's accent is its LEVEL colour (ice, lemon, orange, violet) and every vest carries a level badge with N pips.
 *
 * ATTACH (identity transforms; the geometry is authored in the bone's local frame):
 *   helmet -> CharacterModel.head (= chibi parts.head, the NECK pivot; head centre is at (0, 0.25, 0) in it)
 *   vest   -> CharacterModel.body (= chibi parts.body, the HIP pivot at world y 0.42)
 * position (0,0,0), rotation (0,0,0), scale 1. These pivots are the bones of the skinned chibi (chibiSkin.ts), so
 * the wearables follow every pose. When a helmet is worn, rebuild the head with `setVariant({ helmet: true })` so
 * the hair is tucked in (and the sun hat is removed); see `helmetHairHint`.
 */
import * as THREE from 'three';
import { alongY, alongZ, buildMerged, xf, type Merged, type Piece, type V3 } from './builder';
import { CHIBI_DIMENSIONS, hairVariant, type HairStyle } from './chibi';
import { addOutline, mixHex, OUTLINE, palette, vertexColorToon } from './materials';

export type WearableKind = 'helmet' | 'vest';
export type ArmorTier = 1 | 2 | 3 | 4;

export interface WearableAttach {
  /** Which CharacterModel pivot to parent to ('head' = neck pivot, 'body' = hip pivot). */
  bone: 'head' | 'body';
  position: V3;
  rotation: V3;
  scale: number;
}

/** Exact attach transforms (local to the bone). Identity by construction. */
export const WEARABLE_ATTACH: Readonly<Record<WearableKind, WearableAttach>> = {
  helmet: { bone: 'head', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  vest: { bone: 'body', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
};

const HALF_PI = Math.PI / 2;
/** Head centre in the neck-pivot frame. */
const HC: V3 = [0, CHIBI_DIMENSIONS.headCenterY - CHIBI_DIMENSIONS.neckY, 0];
const V2 = (r: number, y: number) => new THREE.Vector2(r, y);
const lathe = (pts: [number, number][], seg: number, phiStart = 0, phiLen = Math.PI * 2) =>
  new THREE.LatheGeometry(pts.map(([r, y]) => V2(r, y)), seg, phiStart, phiLen);
/** Unit sphere with its poles on +-Z: a flat "decal" lens when squashed along Z (see chibi.ts). */
const lens = (w: number, h: number) => new THREE.SphereGeometry(1, w, h).rotateX(HALF_PI);
const mul = (a: THREE.Matrix4, b: THREE.Matrix4) => a.clone().multiply(b);

// -------------------------------------------------------------------------------------------------
// Helmets (neck-pivot frame)
// -------------------------------------------------------------------------------------------------
/** Tier 1: denim bucket hat with a tan band and a sloped brim. */
function helmet1(): Piece[] {
  const c = palette.armor1, t = palette.armor1Trim;
  const hat = xf([HC[0], HC[1] + 0.06, HC[2]], [0.15, 0, 0]);
  return [
    { geo: lathe([[0.292, 0], [0.29, 0.09], [0.262, 0.175], [0.19, 0.222], [0.001, 0.232]], 12), color: c, matrix: hat },
    { geo: new THREE.CylinderGeometry(0.3, 0.4, 0.035, 14), color: mixHex(c, 0xffffff, 0.22), matrix: mul(hat, xf([0, 0.0, 0])) },
    { geo: new THREE.CylinderGeometry(0.297, 0.297, 0.045, 12, 1, true), color: palette.armor1Level, matrix: mul(hat, xf([0, 0.042, 0])), outline: false },
    // little tan tab on the band (left side) so the hat is not perfectly plain
    { geo: new THREE.BoxGeometry(0.02, 0.06, 0.05), color: t, matrix: mul(hat, xf([-0.3, 0.05, 0.04])), outline: false },
  ];
}

/** Tier 2: cobalt skate-style shell, padded rim roll, white top stripe, dark vents. */
function helmet2(): Piece[] {
  const r = 0.302;
  const shell = xf([HC[0], HC[1] + 0.015, HC[2]], [0.32, 0, 0]);
  const stripeArc = Math.PI * 0.82;
  const P: Piece[] = [
    { geo: new THREE.SphereGeometry(r, 14, 6, 0, Math.PI * 2, 0, HALF_PI), color: palette.armor2, matrix: shell },
    { geo: new THREE.TorusGeometry(r - 0.004, 0.027, 3, 14).rotateX(HALF_PI), color: palette.armor2Dark, matrix: shell },
    {
      geo: new THREE.TorusGeometry(r + 0.002, 0.026, 3, 8, stripeArc).rotateZ(HALF_PI - stripeArc / 2).rotateY(HALF_PI),
      color: palette.armor2Level,
      matrix: shell,
    },
  ];
  // Vents: four dark slots, two each side of the stripe.
  for (const [az, el] of [[0.75, 0.95], [-0.75, 0.95], [2.3, 0.9], [-2.3, 0.9]] as const) {
    const n = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const p: V3 = [n.x * r, n.y * r, n.z * r];
    P.push({ geo: new THREE.BoxGeometry(1, 1, 1), color: palette.ink, matrix: mul(shell, alongY(p, n, [0.026, 0.014, 0.07])), outline: false });
  }
  return P;
}

/** Tier 3: faceted slate shell, hibiscus-pink brow lip, mango crest, ear guards with flower emblems. */
function helmet3(): Piece[] {
  const r = 0.315;
  const theta = Math.PI * 0.52;
  const rimY = r * Math.cos(theta);
  const rimR = r * Math.sin(theta);
  // Tilted back so the brow lip sits above the eyes (lip bottom ~0.08 m above head centre at the front).
  const shell = xf([HC[0], HC[1] + 0.03, HC[2]], [0.34, 0, 0]);
  const browArc = Math.PI * 0.9;
  const crestArc = Math.PI * 0.62;
  const P: Piece[] = [
    { geo: new THREE.SphereGeometry(r, 10, 5, 0, Math.PI * 2, 0, theta), color: palette.armor3, matrix: shell, flat: true },
    {
      geo: new THREE.TorusGeometry(rimR + 0.004, 0.032, 4, 7, browArc).rotateZ(-HALF_PI - browArc / 2).rotateX(HALF_PI),
      color: palette.armor3Level,
      matrix: mul(shell, xf([0, rimY, 0])),
      flat: true,
    },
    {
      geo: new THREE.TorusGeometry(r + 0.004, 0.028, 4, 6, crestArc).rotateZ(HALF_PI - crestArc / 2).rotateY(HALF_PI),
      color: palette.armor3Level,
      matrix: mul(shell, xf([0, 0, 0], [0, 0, 0], [1.4, 1, 1])),
      flat: true,
    },
  ];
  for (const s of [-1, 1]) {
    const gx = s * 0.282;
    P.push({ geo: new THREE.CylinderGeometry(0.074, 0.074, 0.042, 8).rotateZ(HALF_PI), color: palette.armor3Dark, matrix: xf([gx, HC[1] - 0.035, 0.025]), flat: true });
    const dir = new THREE.Vector3(s, 0, 0);
    P.push({ geo: lens(7, 2), color: palette.armor3Level, matrix: alongZ([gx + s * 0.021, HC[1] - 0.035, 0.025], dir, [0.042, 0.042, 0.006]), outline: false });
    P.push({ geo: lens(6, 2), color: palette.boardCream, matrix: alongZ([gx + s * 0.025, HC[1] - 0.035, 0.025], dir, [0.016, 0.016, 0.005]), outline: false });
  }
  return P;
}

// -------------------------------------------------------------------------------------------------
// Vests (hip-pivot frame). Torso capsule: r 0.16, rel y -0.05..0.41, depth x0.82. Head sphere bottom at y 0.38.
// -------------------------------------------------------------------------------------------------
const VEST_DEPTH = 0.86;
/** Point + outward normal on the (elliptic) vest shell at azimuth phi (pi = front, lathe convention) and height y. */
function onShell(phi: number, y: number, r: number): { p: V3; n: THREE.Vector3 } {
  const n = new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi) / VEST_DEPTH).normalize();
  return { p: [Math.sin(phi) * r, y, Math.cos(phi) * r * VEST_DEPTH], n };
}
const shellScale = xf([0, 0, 0], [0, 0, 0], [1, 1, VEST_DEPTH]);
const scaleProfile = (pts: [number, number][], k: number): [number, number][] => pts.map(([r, y]) => [r * k, y]);

/** Tier 1: open-front denim cloth vest (the shirt shows through the gap), tan edge trim, hem cord, pockets. */
function vest1(): Piece[] {
  const c = palette.armor1, t = palette.armor1Trim;
  const gap = 0.56;
  const prof: [number, number][] = [[0.187, 0.1], [0.19, 0.18], [0.186, 0.28], [0.165, 0.345], [0.126, 0.392]];
  const edge = scaleProfile(prof, 1.025);
  const P: Piece[] = [
    { geo: lathe(prof, 12, Math.PI + gap / 2, Math.PI * 2 - gap), color: c, matrix: shellScale },
    { geo: lathe(edge, 1, Math.PI + gap / 2, 0.09), color: t, matrix: shellScale, outline: false },
    { geo: lathe(edge, 1, Math.PI - gap / 2 - 0.09, 0.09), color: t, matrix: shellScale, outline: false },
    { geo: lathe([[0.194, 0.098], [0.196, 0.126]], 10, Math.PI + gap / 2, Math.PI * 2 - gap), color: palette.armor1Level, matrix: shellScale, outline: false },
  ];
  for (const s of [-1, 1]) {
    const o = onShell(Math.PI + s * 0.62, 0.19, 0.196);
    P.push({ geo: new THREE.BoxGeometry(0.075, 0.065, 0.014), color: palette.armor1Level, matrix: alongZ(o.p, o.n, 1), outline: false });
  }
  P.push(...vestBadge(Math.PI + 0.62, 0.3, 0.19, 1));
  return P;
}

/** Tier 2: cobalt ribbed puffer vest, white rolled collar, front zip and side stripes. */
function vest2(): Piece[] {
  const prof: [number, number][] = [
    [0.19, 0.09], [0.204, 0.12], [0.193, 0.155], [0.206, 0.19], [0.195, 0.225], [0.206, 0.26], [0.19, 0.3], [0.163, 0.345], [0.128, 0.382],
  ];
  const w = palette.armor2Level;
  const strip = scaleProfile(prof, 1.02);
  return [
    { geo: lathe(prof, 12), color: palette.armor2, matrix: shellScale },
    { geo: lathe([[0.122, 0.37], [0.142, 0.384], [0.13, 0.4]], 12), color: w, matrix: shellScale },
    { geo: lathe(strip, 1, Math.PI - 0.022, 0.044), color: palette.armor2Dark, matrix: shellScale, outline: false },
    { geo: lathe(strip, 1, HALF_PI - 0.09, 0.18), color: w, matrix: shellScale, outline: false },
    { geo: lathe(strip, 1, Math.PI * 1.5 - 0.09, 0.18), color: w, matrix: shellScale, outline: false },
    ...vestBadge(Math.PI + 0.5, 0.31, 0.2, 2),
  ];
}

/** Tier 3: slate plate carrier: dark carrier, faceted front/back plates with pink rims, straps, hibiscus badge. */
function vest3(): Piece[] {
  const a = palette.armor3, dk = palette.armor3Dark, pink = palette.armor3Level;
  const P: Piece[] = [
    { geo: lathe([[0.188, 0.1], [0.19, 0.3], [0.16, 0.35], [0.125, 0.39]], 10), color: dk, matrix: shellScale },
  ];
  for (const s of [-1, 1]) {
    // s = -1 front, +1 back
    P.push({ geo: new THREE.BoxGeometry(0.29, 0.25, 0.036), color: pink, matrix: xf([0, 0.225, s * 0.162]), flat: true });
    P.push({ geo: new THREE.BoxGeometry(0.27, 0.23, 0.05), color: a, matrix: xf([0, 0.225, s * 0.172]), flat: true });
    P.push({ geo: new THREE.BoxGeometry(0.05, 0.03, 0.3), color: a, matrix: xf([s * 0.1, 0.365, 0]), flat: true });
  }
  P.push({ geo: lens(7, 2), color: pink, matrix: xf([0, 0.25, -0.198], [0, 0, 0], [0.048, 0.048, 0.006]), outline: false });
  P.push({ geo: lens(6, 2), color: palette.boardCream, matrix: xf([0, 0.25, -0.203], [0, 0, 0], [0.018, 0.018, 0.005]), outline: false });
  P.push(...badgeAt([-0.085, 0.32, -0.2], new THREE.Vector3(0, 0, -1), 3));
  return P;
}


/** M2c level badge: a 0.07 m disc in the level colour with N ink pip dots, facing along n at p. ≤ 40 tris, no hull. */
function badgeAt(p: V3, n: THREE.Vector3, level: 1 | 2 | 3 | 4): Piece[] {
  const col = [palette.armor1Level, palette.armor2Level, palette.armor3Level, palette.armor4Level][level - 1];
  const P: Piece[] = [{ geo: lens(8, 2), color: col, matrix: alongZ(p, n, [0.035, 0.035, 0.006]), outline: false }];
  const t = new THREE.Vector3(0, 1, 0).cross(n).normalize(); // tangent along the chest
  const out = n.clone().normalize().multiplyScalar(0.004);
  for (let i = 0; i < level; i++) {
    const o = (i - (level - 1) / 2) * 0.016;
    const q: V3 = [p[0] + t.x * o + out.x, p[1] + t.y * o + out.y, p[2] + t.z * o + out.z];
    P.push({ geo: lens(4, 2), color: palette.ink, matrix: alongZ(q, n, [0.0055, 0.0055, 0.004]), outline: false });
  }
  return P;
}
/** Level badge on a vest shell at azimuth phi (lathe convention, pi = front), height y, shell radius r. */
function vestBadge(phi: number, y: number, r: number, level: 1 | 2 | 3 | 4): Piece[] {
  const o = onShell(phi, y, r + 0.008);
  return badgeAt(o.p, o.n, level);
}

// -------------------------------------------------------------------------------------------------
// Level 4 (M2c, docs/art/M2c.md §6): Ship's Bell Helmet and Surfboard Vest
// -------------------------------------------------------------------------------------------------
/** helmet_4: a brass ship's bell: flared lip above the eyes, hanging loop on top, UV-violet rope band, cream lanyard. */
function helmet4(): Piece[] {
  const bell = xf([HC[0], HC[1], HC[2]], [0.1, 0, 0]);
  const prof: [number, number][] = [[0.31, 0.08], [0.275, 0.13], [0.262, 0.2], [0.25, 0.26], [0.17, 0.325], [0.001, 0.34]];
  return [
    { geo: lathe(prof, 12), color: palette.bellBrass, matrix: bell },
    // underside of the lip (closes the bell seen from below)
    { geo: new THREE.RingGeometry(0.23, 0.31, 12, 1).rotateX(HALF_PI), color: palette.bellLip, matrix: mul(bell, xf([0, 0.08, 0])) },
    { geo: lathe([[0.2645, 0.205], [0.2565, 0.235]], 12), color: palette.bellHighlight, matrix: bell, outline: false },
    { geo: new THREE.TorusGeometry(0.271, 0.011, 3, 12).rotateX(HALF_PI), color: palette.armor4Level, matrix: mul(bell, xf([0, 0.15, 0])) },
    { geo: new THREE.TorusGeometry(0.045, 0.012, 3, 8), color: palette.bellBrass, matrix: mul(bell, xf([0, 0.38, 0])) },
    { geo: new THREE.BoxGeometry(0.03, 0.12, 0.012), color: palette.boardCream, matrix: mul(bell, xf([0.02, 0.09, 0.28], [0.1, 0, 0.1])), outline: false },
    { geo: new THREE.BoxGeometry(0.03, 0.09, 0.012), color: palette.boardCream, matrix: mul(bell, xf([-0.03, 0.1, 0.28], [0.1, 0, -0.15])), outline: false },
  ];
}

/** vest_4: two halves of a short violet surfboard taped front and back, cream stringer, a tail fin out the back. */
function vest4(): Piece[] {
  const P: Piece[] = [
    // front board: nose up under the chin, tilted out a little
    { geo: new THREE.SphereGeometry(1, 8, 5), color: palette.armor4Level, matrix: xf([0, 0.245, -0.19], [-0.08, 0, 0], [0.15, 0.158, 0.02]) },
    { geo: new THREE.BoxGeometry(0.012, 0.29, 0.006), color: palette.boardCream, matrix: xf([0, 0.245, -0.211], [-0.08, 0, 0]), outline: false },
    // back board (the tail half) and its fin
    { geo: new THREE.SphereGeometry(1, 8, 5), color: palette.armor4Level, matrix: xf([0, 0.24, 0.19], [0.06, 0, 0], [0.15, 0.15, 0.02]) },
    { geo: new THREE.BoxGeometry(0.012, 0.27, 0.006), color: palette.boardCream, matrix: xf([0, 0.24, 0.211], [0.06, 0, 0]), outline: false },
    { geo: new THREE.BoxGeometry(0.008, 0.06, 0.055), color: palette.boardCream, matrix: xf([0, 0.17, 0.236], [-0.5, 0, 0]) },
    // tape: shoulder straps and a waist band
    { geo: new THREE.BoxGeometry(0.04, 0.022, 0.37), color: palette.tapeGrey, matrix: xf([-0.1, 0.37, 0]) },
    { geo: new THREE.BoxGeometry(0.04, 0.022, 0.37), color: palette.tapeGrey, matrix: xf([0.1, 0.37, 0]) },
    { geo: lathe([[0.2, 0.12], [0.2, 0.15]], 12), color: palette.tapeGrey, matrix: shellScale },
  ];
  for (const [x, y] of [[0.05, 0.3], [-0.04, 0.2], [0.06, 0.15]] as const) {
    P.push({ geo: lens(4, 2), color: palette.waxDot, matrix: xf([x, y, -0.211], [0, 0, 0], [0.011, 0.011, 0.004]), outline: false });
  }
  P.push(...badgeAt([-0.085, 0.33, -0.214], new THREE.Vector3(0, 0, -1), 4));
  return P;
}

const BUILDERS: Record<WearableKind, readonly [() => Piece[], () => Piece[], () => Piece[], () => Piece[]]> = {
  helmet: [helmet1, helmet2, helmet3, helmet4],
  vest: [vest1, vest2, vest3, vest4],
};

/** Clamp any number to a valid tier (1..4; M2c adds level 4). */
export function clampTier(tier: number): ArmorTier {
  const t = Math.round(Number.isFinite(tier) ? tier : 1);
  return (t <= 1 ? 1 : t >= 4 ? 4 : t) as ArmorTier;
}

const cache = new Map<string, Merged>();
/**
 * Shared geometry for a wearable, in its bone's local frame (see WEARABLE_ATTACH). `geometry` has
 * position/normal/color, `outline` has position/outlineNormal, so it can also be merged into the skinned chibi.
 */
export function getWearableGeometry(kind: WearableKind, tier: number): Merged {
  const t = clampTier(tier);
  const key = `${kind}${t}`;
  let m = cache.get(key);
  if (!m) {
    m = buildMerged(BUILDERS[kind][t - 1](), `wearable:${key}`);
    cache.set(key, m);
  }
  return m;
}

function wearableModel(kind: WearableKind, tier: number): THREE.Object3D {
  const t = clampTier(tier);
  const m = getWearableGeometry(kind, t);
  const root = new THREE.Group();
  root.name = `${kind}:${t}`;
  root.userData.kind = kind;
  root.userData.tier = t;
  root.userData.attach = WEARABLE_ATTACH[kind];
  const mesh = new THREE.Mesh(m.geometry, vertexColorToon());
  mesh.name = kind;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  if (m.outline) addOutline(mesh, OUTLINE.character, palette.ink, m.outline);
  root.add(mesh);
  return root;
}

/**
 * Helmet for tier 1..4 (other numbers are clamped). Parent it to CharacterModel.head (the neck pivot) with an
 * identity transform. One colour mesh named 'helmet' + one 'outline' child (character outline width).
 */
export function createHelmetModel(tier: number): THREE.Object3D {
  return wearableModel('helmet', tier);
}

/**
 * Vest for tier 1..4 (other numbers are clamped). Parent it to CharacterModel.body (the hip pivot) with an
 * identity transform. One colour mesh named 'vest' + one 'outline' child (character outline width).
 */
export function createVestModel(tier: number): THREE.Object3D {
  return wearableModel('vest', tier);
}

/** Parent a wearable from createHelmetModel / createVestModel to the right pivot with the documented transform. */
export function attachWearable(character: { head: THREE.Object3D; body: THREE.Object3D }, wearable: THREE.Object3D): void {
  const a = (wearable.userData.attach as WearableAttach | undefined) ?? WEARABLE_ATTACH.vest;
  const parent = a.bone === 'head' ? character.head : character.body;
  parent.add(wearable);
  wearable.position.set(a.position[0], a.position[1], a.position[2]);
  wearable.rotation.set(a.rotation[0], a.rotation[1], a.rotation[2]);
  wearable.scale.setScalar(a.scale);
}

/**
 * Parse an armor item id. Accepts 'vest_1'..'vest_4', 'helmet_1'..'helmet_4' and the legacy M1 'vest' (tier 1).
 * Returns null for anything else.
 */
export function armorFromItemId(id: string): { kind: WearableKind; tier: ArmorTier } | null {
  const m = /^(vest|helmet)(?:_(\d))?$/.exec(id);
  if (!m) return null;
  return { kind: m[1] as WearableKind, tier: clampTier(m[2] ? Number(m[2]) : 1) };
}

/**
 * What a helmet does to each hair style when worn. 'hide' = the hat is removed (sun hat); 'tuck' = the
 * helmet-safe hair variant changes the silhouette (spikes flare below the rim, the bun drops to the nape);
 * 'keep' = unchanged (bob curtain and ponytail hang below the rim).
 * Use `setVariant({ helmet: true })` on the chibi to get the helmet-safe hair for every style.
 */
export const HELMET_HAIR_HINT: Readonly<Record<HairStyle, 'hide' | 'tuck' | 'keep'>> = {
  sunhat: 'hide', spiky: 'tuck', bun: 'tuck', bob: 'keep', ponytail: 'keep',
};

/** True if wearing a helmet hides part of this hair index's look (the sun hat). */
export function hairHiddenByHelmet(hair: number): boolean {
  return HELMET_HAIR_HINT[hairVariant(hair).style] === 'hide';
}
