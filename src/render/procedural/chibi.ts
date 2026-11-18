/**
 * Chibi character factory. Owner: graphics-designer. Spec: docs/art/STYLE.md "Characters".
 *
 * Conventions: feet at y = 0, faces -Z, ~1.3 m tall, head 0.5 m diameter (~40% of height).
 * Six vertex-coloured meshes (torso, head, armL, armR, legL, legR) + six outline hulls = 12 draw calls,
 * all sharing ONE toon material and ONE outline material. Geometry is cached per variant and shared.
 *
 * Hierarchy (pivots are the animatable parts; rotate them, not the meshes):
 *   root (Group, feet at origin)               world position + yaw (+ death tilt)
 *   └─ stance (Group at the origin, M2a)       crouch drop / prone lie-down; identity when standing
 *       ├─ body   pivot at hips   (0, 0.42, 0)   lean / bob the upper body (vests attach here, identity)
 *       │   ├─ torso (Mesh)
 *       │   ├─ head  pivot at neck  (0, 0.38, 0) rel body  -> world y 0.80 (helmets attach here, identity)
 *       │   ├─ armL  pivot at shoulder (-0.215, 0.31, 0) rel body -> world (-0.215, 0.73, 0)
 *       │   │   └─ hand_L_socket
 *       │   └─ armR  pivot at shoulder (+0.215, 0.31, 0) rel body
 *       │       └─ hand_R_socket (attach weapon models here)
 *       ├─ legL  pivot at hip (-0.085, 0.42, 0)
 *       └─ legR  pivot at hip (+0.085, 0.42, 0)
 *
 * Right = +X (character faces -Z). Arms/legs hang along -Y; rotation.x > 0 swings them FORWARD
 * (arm.rotation.x = PI/2 points the arm straight ahead). Hand sockets are pre-rotated (x = -PI/2) so a
 * weapon's -Z (muzzle) points down the arm: arm hanging = gun pointing at the ground, arm raised to
 * PI/2 = gun pointing forward, top of the gun up.
 */
import * as THREE from 'three';
import { alongY, alongZ, buildMerged, xf, type Merged, type Piece, type V3 } from './builder';
import { addOutline, mixHex, OUTLINE, palette, vertexColorToon } from './materials';

// -------------------------------------------------------------------------------------------------
// Dimensions
// -------------------------------------------------------------------------------------------------
export const CHIBI_DIMENSIONS = {
  height: 1.3,
  headRadius: 0.25,
  hipY: 0.42,
  neckY: 0.8,
  headCenterY: 1.05,
  shoulderY: 0.73,
  shoulderX: 0.215,
  hipX: 0.085,
  /** Eye line in world space; use for camera look-at / head-hit centre. */
  eyeY: 1.04,
  /** Approximate radius of the body for culling / hit volumes (sim owns real hitboxes). */
  radius: 0.32,
} as const;

const D = CHIBI_DIMENSIONS;

/** Hip-to-sole length of a straight chibi leg (shoe flattened). */
export const CHIBI_LEG_LENGTH = 0.42;

/**
 * Leg swing (rad) that keeps the sole on the ground when the stance pivot is dropped by `drop` metres:
 * acos((hipY - drop) / legLength). Use +angle for the front leg and -angle for the back leg.
 */
export function crouchLegAngle(drop: number): number {
  const c = (D.hipY - drop) / CHIBI_LEG_LENGTH;
  return Math.acos(c >= 1 ? 1 : c <= 0 ? 0 : c);
}

/**
 * Key poses for crouch and prone (M2a), for the pose code in src/render/characterPose.ts (graphics-engineer).
 * Values are joint rotations in radians / offsets in metres on the ChibiParts pivots. Full spec with the
 * transitions and the crawl cycle: docs/art/STYLE.md "Stances". Checked in headless renders.
 */
export const CHIBI_STANCES = {
  crouch: {
    /**
     * stance.position.y = -drop. BUG-008 (stance.md "Visual fit"): deep squat so the head fits the 0.95 m crouch
     * cylinder: head top 1.39 -> ~1.03 m (hair 0; <= 1.05 for every hair), face centre ~0.70 m (eyeHeight 0.72).
     */
    drop: 0.32,
    /** legL.rotation.x = +legSwing (front), legR.rotation.x = -legSwing (back); = crouchLegAngle(drop) (1.330). */
    legSwing: 1.33,
    /** legL.rotation.z = -legSplay, legR.rotation.z = +legSplay. */
    legSplay: 0.06,
    /** body.rotation.x (forward lean). Subtract it from the arm aim angles so the gun stays on target. */
    bodyLean: -0.4,
    /** Added to head.rotation.x: cancels the lean, so the face is level (world head tilt 0 at aim pitch 0). */
    headComp: 0.4,
    /** Crouch-walk: legs swing +-walkSwing around their crouch angles (feet then float or dip a few cm). */
    walkSwing: 0.28,
  },
  prone: {
    /** stance.rotation.x: lie face down along the yaw (head toward -Z / the aim direction). */
    pitch: -Math.PI / 2,
    /**
     * stance.position = (0, lift, back): belly on the sand, body inside the sim prone box (1.5 x 0.8 x 0.6, centred on
     * the root), head in its front 0.5 m. BUG-008: body moved forward (back 0.62 -> 0.34) so the head centre is at
     * z ~ -0.52; the hips ride a little higher than the chest.
     */
    lift: 0.16,
    back: 0.34,
    /** body.rotation.x: negative = chest flat on the sand, slightly lower than the hips (BUG-008; was 0.22 propped up). */
    chestUp: -0.2,
    /**
     * head.rotation.x: chin just above the sand, face looking forward and a little down (world head tilt -0.22 rad).
     * Head centre ~0.33 m (eyeHeight 0.35), head top ~0.67 m (box 0.6). Aim pitch adds pitch * k (characterPose.ts);
     * k <= 0.3 keeps the head centre at z <= -0.45 at the +45 deg limit (k 0.4 gives -0.42).
     */
    headUp: 1.55,
    /** Arms forward along the ground: arm.rotation.x = PI - chestUp + aimPitch (two-handed); armL.z = armLSplay. */
    armLSplay: 0.45,
    /** legs: rotation.x = legLift (heels up a little), rotation.z = -/+legSplay. */
    legLift: -0.12,
    legSplay: 0.14,
    /** Crawl: legs alternate legSplay +- crawlSwing on z, arms alternate x +- crawlArm, body rolls +- crawlRoll on y. */
    crawlSwing: 0.22,
    crawlArm: 0.18,
    crawlRoll: 0.08,
  },
} as const;

/**
 * Plane-drop poses (M2b) for characterPose.ts (graphics-engineer). Spec: docs/art/STYLE.md §20.
 * freefall: belly-down, limbs spread, rotated about the HIPS via the stance pivot:
 *   stance.rotation.x = pitch; stance.position = (0, hipY - hipY*cos(pitch), -hipY*sin(pitch)) (= freefallStanceOffset()).
 * hang: upright under the canopy, hands up on the risers, legs dangling.
 */
export const CHIBI_FREEFALL = {
  freefall: {
    pitch: -1.35,
    headX: 1.0,
    armX: 0.5,
    /** armL.z = -armSpread, armR.z = +armSpread */
    armSpread: 1.25,
    legX: -0.35,
    legSpread: 0.35,
    /** flutter amplitude (rad) on arms / legs z, ~9 rad/s */
    flutter: 0.08,
    /** steering: bank the stance z by steerX * bank, pitch nose-down by diveK * dive */
    bank: 0.35,
    dive: 0.35,
  },
  hang: {
    armX: 2.75,
    /** armL.z = -armOut, armR.z = +armOut */
    armOut: 0.25,
    legLX: 0.22,
    legRX: 0.12,
    legSpread: 0.05,
    bodyX: -0.05,
    headX: 0.1,
    /** idle sway on root/stance z: sin(t * swayRate) * sway; steering bank up to bank */
    sway: 0.06,
    swayRate: 1.3,
    bank: 0.25,
  },
} as const;

/** Stance-pivot position that makes the freefall pitch rotate about the hips. */
export function freefallStanceOffset(pitch: number = CHIBI_FREEFALL.freefall.pitch): [number, number, number] {
  return [0, D.hipY - D.hipY * Math.cos(pitch), -D.hipY * Math.sin(pitch)];
}
const HEAD_C: V3 = [0, D.headCenterY - D.neckY, 0]; // head centre relative to neck pivot
const R = D.headRadius;

// -------------------------------------------------------------------------------------------------
// Variant tables (indices wrap)
// -------------------------------------------------------------------------------------------------
export const SKIN_TONES: readonly number[] = [
  0xffe3cc, // porcelain
  0xf7c9a0, // light
  0xe2a878, // medium
  0xc68654, // tan
  0x8f5b3b, // brown
  0x5e3a26, // deep
];

export type HairStyle = 'spiky' | 'bob' | 'ponytail' | 'bun' | 'sunhat';
export const HAIR_STYLES: readonly HairStyle[] = ['spiky', 'bob', 'ponytail', 'bun', 'sunhat'];
export const HAIR_COLORS: readonly number[] = [
  0x2b2530, // ink black
  0x6b4226, // chocolate
  0xf2c66d, // sunny blonde
  0xe8693c, // ginger
  0xff8fb1, // bubblegum pink
  0x46b5d1, // lagoon aqua
];
/** hair index -> style = hair % 5, colour = hair % 6, so indices 0..29 are all distinct combos. */
export function hairVariant(hair: number): { style: HairStyle; color: number } {
  const h = Math.abs(Math.floor(hair));
  return { style: HAIR_STYLES[h % HAIR_STYLES.length], color: HAIR_COLORS[h % HAIR_COLORS.length] };
}

export type OutfitStyle = 'trunksTank' | 'sundress' | 'hawaiian' | 'wetsuit' | 'rashguard' | 'onePiece';
export interface OutfitDef {
  style: OutfitStyle;
  /** Main colour: shirt / dress / suit. */
  top: number;
  /** Shorts / trunks colour (ignored by one-colour styles). */
  bottom: number;
  /** Pattern / trim colour (flowers, stripes, belt, hem). */
  accent: number;
  /** Sandal / bootie colour, or null for bare feet. */
  shoe: number | null;
}
export const OUTFITS: readonly OutfitDef[] = [
  { style: 'trunksTank', top: 0xffd23f, bottom: 0x2e86de, accent: 0xffffff, shoe: null },
  { style: 'sundress', top: 0xff7aa2, bottom: 0xff7aa2, accent: 0xfff3c4, shoe: 0xffb627 },
  { style: 'hawaiian', top: 0x2ec4b6, bottom: 0xe9d8a6, accent: 0xff9f1c, shoe: 0x8a5a34 },
  { style: 'wetsuit', top: 0x2b2d42, bottom: 0x2b2d42, accent: 0xff6b35, shoe: 0x2b2d42 },
  { style: 'rashguard', top: 0x4d96ff, bottom: 0xff6b6b, accent: 0xffffff, shoe: null },
  { style: 'onePiece', top: 0xe63946, bottom: 0xe63946, accent: 0xf1faee, shoe: 0xf1faee },
  { style: 'trunksTank', top: 0xffffff, bottom: 0xff5a5f, accent: 0xff5a5f, shoe: 0xff5a5f },
  { style: 'sundress', top: 0x8ac926, bottom: 0x8ac926, accent: 0xffffff, shoe: null },
  { style: 'hawaiian', top: 0xff595e, bottom: 0x1982c4, accent: 0xffca3a, shoe: null },
  { style: 'wetsuit', top: 0x1982c4, bottom: 0x1982c4, accent: 0xffca3a, shoe: 0x1982c4 },
];

export const CHIBI_VARIANT_COUNTS = {
  skin: SKIN_TONES.length,
  outfit: OUTFITS.length,
  hair: HAIR_STYLES.length * HAIR_COLORS.length, // 30 unique (lcm 5,6)
} as const;

const wrap = (i: number, n: number) => ((Math.floor(i) % n) + n) % n;
const skinOf = (i: number) => SKIN_TONES[wrap(i, SKIN_TONES.length)];
const outfitOf = (i: number) => OUTFITS[wrap(i, OUTFITS.length)];

export type Sleeve = 'none' | 'short' | 'long';
type LegWear = 'none' | 'shorts' | 'knee' | 'full';
const SLEEVES: Record<OutfitStyle, Sleeve> = {
  trunksTank: 'none', sundress: 'none', hawaiian: 'short', wetsuit: 'long', rashguard: 'long', onePiece: 'none',
};
/** Sleeve length of an outfit index (wraps): used by the first-person viewmodel arms. */
export function outfitSleeve(outfit: number): Sleeve {
  return SLEEVES[OUTFITS[((Math.floor(outfit) % OUTFITS.length) + OUTFITS.length) % OUTFITS.length].style];
}
const LEGWEAR: Record<OutfitStyle, LegWear> = {
  trunksTank: 'shorts', sundress: 'none', hawaiian: 'shorts', wetsuit: 'full', rashguard: 'knee', onePiece: 'none',
};

// -------------------------------------------------------------------------------------------------
// Shared source primitives (never rendered directly; baked into merged geometry)
// -------------------------------------------------------------------------------------------------
const unitSphere = (w: number, h: number) => new THREE.SphereGeometry(1, w, h);
/**
 * Unit sphere with its poles on +-Z (pass through `alongZ`): the front silhouette is the `w`-gon
 * equator, so flat face decals keep a round outline with very few rows. With h = 3 the widest rings
 * sit at sin(60 deg) of the radius, so callers scale x/y by LENS3 to keep the authored size.
 */
const lens = (w: number, h: number) => new THREE.SphereGeometry(1, w, h).rotateX(Math.PI / 2);
const LENS3 = 1 / Math.sin(Math.PI / 3);
/** Open-ended limb tube along Y (ends are buried in the shoulder/hand/torso/shoe spheres). */
const tube = (rTop: number, rBot: number, h: number, radial: number) => new THREE.CylinderGeometry(rTop, rBot, h, radial, 1, true);
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Point on the head sphere (relative to neck pivot) at local face coords (x, y), pushed to radius r. */
function headSurface(x: number, y: number, r: number): { p: V3; n: THREE.Vector3 } {
  const z = -Math.sqrt(Math.max(0, R * R - x * x - y * y));
  const n = v(x, y, z).normalize();
  return { p: [HEAD_C[0] + n.x * r, HEAD_C[1] + n.y * r, HEAD_C[2] + n.z * r], n };
}

// -------------------------------------------------------------------------------------------------
// Part builders
// -------------------------------------------------------------------------------------------------
function headPieces(skin: number, hair: number, helmet = false): Piece[] {
  const { style, color: hc } = hairVariant(hair);
  const P: Piece[] = [];
  const C = HEAD_C;
  const at = (dx: number, dy: number, dz: number): V3 => [C[0] + dx, C[1] + dy, C[2] + dz];

  // Head + ears
  // Head stays the roundest part (14 x 10); everything else is budgeted down (docs/art/ASSET_LIST.md).
  P.push({ geo: new THREE.SphereGeometry(R, 14, 10), color: skin, matrix: xf(C) });
  for (const s of [-1, 1]) {
    P.push({ geo: unitSphere(5, 3), color: skin, matrix: xf(at(s * 0.245, -0.02, 0.01), [0, 0, 0], [0.028, 0.05, 0.042]), outline: false });
  }

  // Face: eyes (tall ink ellipses), highlights (upper-left, same on both eyes), blush, smile
  for (const s of [-1, 1]) {
    const e = headSurface(s * 0.09, -0.01, R - 0.006);
    P.push({ geo: lens(10, 3), color: palette.ink, matrix: alongZ(e.p, e.n, [0.042 * LENS3, 0.062 * LENS3, 0.022]), outline: false });
    const h = headSurface(s * 0.09 - 0.016, 0.014, R + 0.012);
    P.push({ geo: lens(6, 2), color: 0xffffff, matrix: alongZ(h.p, h.n, [0.016, 0.018, 0.008]), outline: false });
    const b = headSurface(s * 0.155, -0.075, R - 0.002);
    P.push({ geo: lens(7, 2), color: mixHex(skin, 0xff6f86, 0.5), matrix: alongZ(b.p, b.n, [0.042, 0.024, 0.008]), outline: false });
  }
  // Smile: the torus arc is the upper half (an n-shape). alongZ turns +Z onto the face normal (which
  // points -Z and slightly down) by rotating ~157 deg about X, and that already flips it into a U-shaped
  // smile, so no extra roll. (A roll of PI here rendered a frown.)
  const m = headSurface(0, -0.1, R - 0.002);
  P.push({ geo: new THREE.TorusGeometry(0.024, 0.0065, 3, 6, Math.PI), color: palette.ink, matrix: alongZ(m.p, m.n, 1), outline: false });

  // Hair
  const cap = (radius: number, thetaLen: number, tilt: number) =>
    P.push({ geo: new THREE.SphereGeometry(radius, 12, 5, 0, Math.PI * 2, 0, thetaLen), color: hc, matrix: xf(at(0, 0.008, 0), [tilt, 0, 0]) });
  const bang = (x: number, y: number, sx: number, sy: number) => {
    const b = headSurface(x, y, R + 0.012);
    P.push({ geo: unitSphere(6, 3), color: hc, matrix: alongZ(b.p, b.n, [sx, sy, 0.03]), outline: false });
  };
  // Direction from azimuth (0 = back/+Z, PI = front/-Z) and elevation.
  const dirAE = (az: number, el: number) => v(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));

  switch (style) {
    case 'spiky': {
      cap(0.268, Math.PI * 0.56, 0.32);
      // Under a helmet the crown spikes would pierce the shell: flare short spikes out below the rim instead
      // (back and sides, pointing down-out), plus a fringe under the front rim.
      const spikes: [number, number][] = helmet
        ? [[0, -0.5], [0.75, -0.45], [-0.75, -0.45], [1.45, -0.32], [-1.45, -0.32]]
        : [
            [0, 1.35], [0, 0.85], [1.1, 0.75], [-1.1, 0.75], [2.0, 0.6], [-2.0, 0.6], [0.6, 0.35], [-0.6, 0.35], [Math.PI, 0.95],
          ];
      for (const [az, el] of spikes) {
        const d = dirAE(az, el);
        P.push({ geo: new THREE.ConeGeometry(0.075, 0.17, 5, 1, true) /* base buried in the cap */, color: hc, matrix: alongY(at(d.x * 0.26, d.y * 0.26, d.z * 0.26), d, helmet ? 0.8 : 1) });
      }
      if (helmet) {
        bang(-0.08, 0.075, 0.075, 0.045);
        bang(0.07, 0.08, 0.075, 0.045);
      }
      break;
    }
    case 'bob': {
      cap(0.272, Math.PI * 0.5, 0.42);
      P.push({
        geo: new THREE.CylinderGeometry(0.272, 0.297, 0.24, 12, 1, true, -Math.PI * 0.62, Math.PI * 1.24),
        color: hc,
        matrix: xf(at(0, -0.07, 0.005)),
      });
      bang(-0.09, 0.13, 0.08, 0.05);
      bang(0, 0.145, 0.08, 0.05);
      bang(0.09, 0.13, 0.08, 0.05);
      break;
    }
    case 'ponytail': {
      cap(0.27, Math.PI * 0.56, 0.36);
      P.push({ geo: unitSphere(6, 4), color: palette.hibiscus, matrix: xf(at(0, 0.06, 0.262), [0, 0, 0], 0.045) });
      P.push({ geo: new THREE.CapsuleGeometry(0.075, 0.16, 2, 6), color: hc, matrix: xf(at(0, -0.06, 0.33), [-0.45, 0, 0]) });
      bang(-0.1, 0.12, 0.07, 0.05);
      bang(0.07, 0.135, 0.09, 0.05);
      break;
    }
    case 'bun': {
      cap(0.27, Math.PI * 0.56, 0.3);
      // Under a helmet the top bun drops to a low bun at the nape (below the helmet's back rim).
      if (helmet) P.push({ geo: new THREE.SphereGeometry(0.09, 8, 6), color: hc, matrix: xf(at(0, -0.1, 0.25)) });
      else P.push({ geo: new THREE.SphereGeometry(0.105, 8, 6), color: hc, matrix: xf(at(0, 0.24, 0.1)) });
      bang(-0.08, 0.135, 0.075, 0.05);
      bang(0.08, 0.135, 0.075, 0.05);
      break;
    }
    case 'sunhat': {
      cap(0.266, Math.PI * 0.6, 0.35);
      if (helmet) {
        // The helmet replaces the sun hat: plain cap + a soft fringe under the front rim.
        bang(-0.085, 0.075, 0.08, 0.045);
        bang(0.085, 0.075, 0.08, 0.045);
        break;
      }
      const tilt: V3 = [0.12, 0, 0];
      P.push({ geo: new THREE.CylinderGeometry(0.43, 0.43, 0.024, 16), color: 0xf7d774, matrix: xf(at(0, 0.15, 0.02), tilt) });
      P.push({ geo: new THREE.CylinderGeometry(0.19, 0.235, 0.15, 12), color: 0xf7d774, matrix: xf(at(0, 0.235, 0.03), tilt) });
      P.push({ geo: new THREE.CylinderGeometry(0.238, 0.241, 0.04, 12, 1, true), color: hc, matrix: xf(at(0, 0.185, 0.025), tilt), outline: false });
      break;
    }
  }
  return P;
}

function torsoPieces(skin: number, o: OutfitDef): Piece[] {
  const P: Piece[] = [];
  const DEPTH = 0.82;
  // Torso capsule: world y 0.37..0.83 (rel hips -0.05..0.41)
  P.push({ geo: new THREE.CapsuleGeometry(0.16, 0.14, 3, 10), color: o.top, matrix: xf([0, 0.18, 0], [0, 0, 0], [1, 1, DEPTH]) });

  const band = (h: number, y: number, color: number, rTop = 0.168, rBot = 0.175) =>
    P.push({ geo: new THREE.CylinderGeometry(rTop, rBot, h, 12), color, matrix: xf([0, y, 0], [0, 0, 0], [1, 1, 0.86]) });
  /** Trim stripe: a thin open band standing just proud of the surface (was a 128-tri torus). */
  const ring = (y: number, color: number, r = 0.163) =>
    P.push({ geo: tube(r + 0.006, r + 0.006, 0.028, 12), color, matrix: xf([0, y, 0], [0, 0, 0], [1, 1, DEPTH]), outline: false });
  /** Small flat dot on the torso surface at azimuth a (0 = front) and rel height y. */
  const dot = (a: number, y: number, r: number, color: number, radius = 0.16) => {
    const x = Math.sin(a) * radius;
    const z = -Math.cos(a) * radius * DEPTH;
    const n = v(x / (radius * radius), 0, z / (radius * DEPTH * radius * DEPTH)).normalize();
    P.push({ geo: lens(5, 2), color, matrix: alongZ([x, y, z], n, [r, r, 0.008]), outline: false });
  };

  switch (o.style) {
    case 'trunksTank':
      band(0.15, 0.03, o.bottom);
      ring(0.06, o.accent, 0.17); // waistband
      break;
    case 'sundress':
      P.push({ geo: new THREE.CylinderGeometry(0.165, 0.26, 0.24, 12), color: o.top, matrix: xf([0, 0.0, 0], [0, 0, 0], [1, 1, 0.9]) });
      P.push({ geo: new THREE.CylinderGeometry(0.262, 0.268, 0.035, 12, 1, true), color: o.accent, matrix: xf([0, -0.105, 0], [0, 0, 0], [1, 1, 0.9]), outline: false });
      for (const [a, y] of [[-0.5, 0.2], [0.45, 0.13], [0.1, 0.27], [Math.PI - 0.4, 0.18], [Math.PI + 0.5, 0.24]] as const) dot(a, y, 0.028, o.accent);
      break;
    case 'hawaiian':
      band(0.15, 0.03, o.bottom);
      for (const [a, y] of [[-0.55, 0.14], [0.5, 0.22], [0.05, 0.08], [-0.25, 0.27], [1.3, 0.12], [-1.3, 0.2], [Math.PI - 0.5, 0.2], [Math.PI + 0.4, 0.12], [Math.PI, 0.28]] as const) {
        dot(a, y, 0.03, o.accent);
      }
      // open collar: skin-coloured V on the chest
      P.push({ geo: new THREE.ConeGeometry(0.055, 0.1, 3), color: skin, matrix: xf([0, 0.33, -0.112], [-0.55, 0, Math.PI], [1, 1, 0.35]), outline: false });
      break;
    case 'wetsuit':
      band(0.15, 0.03, o.top);
      ring(0.24, o.accent);
      P.push({ geo: new THREE.BoxGeometry(0.025, 0.24, 0.012), color: o.accent, matrix: xf([0, 0.2, -0.128]), outline: false });
      break;
    case 'rashguard':
      band(0.19, 0.01, o.bottom);
      ring(0.24, o.accent);
      break;
    case 'onePiece':
      band(0.09, 0.0, o.top, 0.166, 0.17);
      ring(0.14, o.accent);
      break;
  }
  return P;
}

function armPieces(side: 1 | -1, skin: number, o: OutfitDef): Piece[] {
  const P: Piece[] = [];
  const sleeve = SLEEVES[o.style];
  const tilt: V3 = [0, 0, side * 0.14];
  const armColor = sleeve === 'long' ? o.top : skin;
  // Shoulder ball + open tube + hand ball. The tube runs from inside the shoulder ball to inside the
  // hand ball (tapering slightly to the wrist so its rim stays buried), so no open end is visible.
  P.push({ geo: new THREE.SphereGeometry(0.066, 7, 5), color: sleeve === 'none' ? skin : o.top, matrix: xf([0, 0, 0]) });
  P.push({ geo: tube(0.055, 0.05, 0.29, 7), color: armColor, matrix: xf([side * 0.02, -0.152, 0], tilt) });
  if (sleeve === 'short') {
    // Slightly belled sleeve; the narrow top tucks inside the shoulder ball.
    P.push({ geo: tube(0.058, 0.07, 0.11, 7), color: o.top, matrix: xf([side * 0.01, -0.06, 0], tilt) });
  }
  if (sleeve === 'long' && o.style === 'wetsuit') {
    P.push({ geo: tube(0.058, 0.058, 0.03, 7), color: o.accent, matrix: xf([side * 0.036, -0.25, 0], tilt), outline: false });
  }
  P.push({ geo: new THREE.SphereGeometry(0.064, 7, 5), color: skin, matrix: xf([side * 0.045, -0.3, 0]) });
  return P;
}

function legPieces(skin: number, o: OutfitDef): Piece[] {
  const P: Piece[] = [];
  const wear = LEGWEAR[o.style];
  // Open tubes: the tops reach y +0.03..0.04 (inside every outfit's hip band / skirt, even with the leg
  // swung ~1 rad), the bottom is buried in the shoe.
  P.push({ geo: tube(0.068, 0.068, 0.415, 8), color: wear === 'full' ? o.top : skin, matrix: xf([0, -0.1775, 0]) });
  if (wear === 'shorts') P.push({ geo: tube(0.084, 0.082, 0.17, 8), color: o.bottom, matrix: xf([0, -0.045, 0]) });
  if (wear === 'knee') P.push({ geo: tube(0.084, 0.08, 0.25, 8), color: o.bottom, matrix: xf([0, -0.085, 0]) });
  if (wear === 'full') P.push({ geo: tube(0.071, 0.071, 0.03, 8), color: o.accent, matrix: xf([0, -0.3, 0]), outline: false });
  P.push({ geo: new THREE.SphereGeometry(0.075, 8, 5), color: o.shoe ?? skin, matrix: xf([0, -0.38, -0.035], [0, 0, 0], [1, 0.55, 1.4]) });
  return P;
}

// -------------------------------------------------------------------------------------------------
// Geometry cache
// -------------------------------------------------------------------------------------------------
const geoCache = new Map<string, Merged>();
function cached(key: string, make: () => Piece[]): Merged {
  let g = geoCache.get(key);
  if (!g) {
    g = buildMerged(make(), `chibi:${key}`);
    geoCache.set(key, g);
  }
  return g;
}

interface PartGeos { head: Merged; torso: Merged; armL: Merged; armR: Merged; leg: Merged }
function partGeos(opts: ChibiOptions): PartGeos {
  const s = wrap(opts.skin, SKIN_TONES.length);
  const of = wrap(opts.outfit, OUTFITS.length);
  const h = Math.abs(Math.floor(opts.hair)) % CHIBI_VARIANT_COUNTS.hair;
  const hm = opts.helmet ? 1 : 0;
  const skin = skinOf(s);
  const o = outfitOf(of);
  return {
    head: cached(`head|${s}|${h}|${hm}`, () => headPieces(skin, h, hm === 1)),
    torso: cached(`torso|${s}|${of}`, () => torsoPieces(skin, o)),
    armL: cached(`armL|${s}|${of}`, () => armPieces(-1, skin, o)),
    armR: cached(`armR|${s}|${of}`, () => armPieces(1, skin, o)),
    leg: cached(`leg|${s}|${of}`, () => legPieces(skin, o)),
  };
}

// -------------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------------
export interface ChibiOptions {
  skin: number;
  outfit: number;
  hair: number;
  /**
   * Helmet-safe hair (M2a): set true while a helmet is worn. Removes the sun hat, flares spiky hair out below
   * the helmet rim and drops a top bun to the nape, so nothing pokes through the shell. Default false.
   * After `setVariant({ helmet })`, a skinned chibi must also call `setAppearanceKey(key)` with a key that
   * includes this flag (chibiSkin caches geometry per key).
   */
  helmet?: boolean;
}

export interface ChibiParts {
  /**
   * Stance pivot at the feet origin (child of root, parent of body and legs). Identity when standing. Crouch:
   * drop it (position.y < 0). Prone: rotation.x = -PI/2 plus a lift / back offset. See CHIBI_STANCES and
   * docs/art/STYLE.md "Stances".
   */
  stance: THREE.Object3D;
  /** Upper-body pivot at the hips. */
  body: THREE.Object3D;
  /** Neck pivot (head mesh is its child). */
  head: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  /** Empty socket at the right hand; add the weapon model here. */
  hand_R_socket: THREE.Object3D;
  hand_L_socket: THREE.Object3D;
}

export interface ChibiMeshes { torso: THREE.Mesh; head: THREE.Mesh; armL: THREE.Mesh; armR: THREE.Mesh; legL: THREE.Mesh; legR: THREE.Mesh }

export interface ChibiModel {
  root: THREE.Group;
  parts: ChibiParts;
  /** The six colour meshes (each has one child named 'outline'). Swap `material` for hit flashes. */
  meshes: ChibiMeshes;
  options: ChibiOptions;
  /** Rebuild the look in place (geometry swap from cache; no allocation for already-seen variants). */
  setVariant(opts: Partial<ChibiOptions>): void;
  setOutfit(outfit: number): void;
  /** Reset all pivots to the rest pose. */
  resetPose(): void;
}

function partMesh(name: string, m: Merged): THREE.Mesh {
  const mesh = new THREE.Mesh(m.geometry, vertexColorToon());
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  if (m.outline) addOutline(mesh, OUTLINE.character, palette.ink, m.outline);
  return mesh;
}

function swap(mesh: THREE.Mesh, m: Merged): void {
  mesh.geometry = m.geometry;
  const o = mesh.children.find((c) => c.name === 'outline') as THREE.Mesh | undefined;
  if (o && m.outline) o.geometry = m.outline;
}

export function createChibi(opts: ChibiOptions): ChibiModel {
  const options: ChibiOptions = { skin: opts.skin, outfit: opts.outfit, hair: opts.hair, helmet: !!opts.helmet };
  const g = partGeos(options);

  const root = new THREE.Group();
  root.name = 'chibi';

  // Stance pivot (M2a): everything below hangs off it, so crouch / prone never fight the root's position + yaw.
  const stance = new THREE.Group();
  stance.name = 'stance';
  root.add(stance);

  const body = new THREE.Group();
  body.name = 'body';
  body.position.set(0, D.hipY, 0);
  stance.add(body);

  const torso = partMesh('torso', g.torso);
  body.add(torso);

  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, D.neckY - D.hipY, 0);
  body.add(head);
  const headMesh = partMesh('headMesh', g.head);
  head.add(headMesh);

  const mkArm = (side: 1 | -1, m: Merged) => {
    const pivot = new THREE.Group();
    pivot.name = side > 0 ? 'armR' : 'armL';
    pivot.position.set(side * D.shoulderX, D.shoulderY - D.hipY, 0);
    const mesh = partMesh(`${pivot.name}Mesh`, m);
    pivot.add(mesh);
    const socket = new THREE.Object3D();
    socket.name = side > 0 ? 'hand_R_socket' : 'hand_L_socket';
    socket.position.set(side * 0.045, -0.31, 0);
    socket.rotation.x = -Math.PI / 2;
    pivot.add(socket);
    body.add(pivot);
    return { pivot, mesh, socket };
  };
  const armL = mkArm(-1, g.armL);
  const armR = mkArm(1, g.armR);

  const mkLeg = (side: 1 | -1) => {
    const pivot = new THREE.Group();
    pivot.name = side > 0 ? 'legR' : 'legL';
    pivot.position.set(side * D.hipX, D.hipY, 0);
    const mesh = partMesh(`${pivot.name}Mesh`, g.leg);
    pivot.add(mesh);
    stance.add(pivot);
    return { pivot, mesh };
  };
  const legL = mkLeg(-1);
  const legR = mkLeg(1);

  const parts: ChibiParts = {
    stance, body, head, armL: armL.pivot, armR: armR.pivot, legL: legL.pivot, legR: legR.pivot,
    hand_R_socket: armR.socket, hand_L_socket: armL.socket,
  };
  const meshes: ChibiMeshes = { torso, head: headMesh, armL: armL.mesh, armR: armR.mesh, legL: legL.mesh, legR: legR.mesh };

  const model: ChibiModel = {
    root,
    parts,
    meshes,
    options,
    setVariant(next) {
      Object.assign(options, next);
      const ng = partGeos(options);
      swap(torso, ng.torso);
      swap(headMesh, ng.head);
      swap(armL.mesh, ng.armL);
      swap(armR.mesh, ng.armR);
      swap(legL.mesh, ng.leg);
      swap(legR.mesh, ng.leg);
    },
    setOutfit(outfit) {
      model.setVariant({ outfit });
    },
    resetPose() {
      for (const p of [stance, body, head, armL.pivot, armR.pivot, legL.pivot, legR.pivot]) p.rotation.set(0, 0, 0);
      stance.position.set(0, 0, 0);
      body.position.set(0, D.hipY, 0);
    },
  };
  root.userData.chibi = model;
  return model;
}
