/**
 * M2c (ADR 0007 §1.4): cross-engine deterministic math. Owner: tech-lead.
 *
 * The per-match layout generator (src/game/levels/layout/) runs on the server (Node/V8) and in every browser
 * (Chromium, Firefox, Safari), and every accept/reject decision must agree bit for bit. IEEE `+ - * /`, comparisons,
 * `Math.sqrt`, `Math.round`, `Math.floor` and `Math.imul` are exactly specified; `Math.sin/cos/atan2/hypot/exp/pow`
 * are NOT (engines may differ in the last bit). So a decision path may use only the former plus the helpers here.
 *
 * - Rotations are quantised to 1/TURN_STEPS of a turn. detSin/detCos read a table built at module load from a fixed
 *   Taylor polynomial evaluated with `+` and `*` only, so every engine builds the identical table.
 * - Seeds: mixSeed (the same function as server/common.ts) and fnv1a32 for named streams.
 * - Outputs are rounded to mm (positions) and mrad (angles) before any check reads them (roundMm / roundMrad).
 * - Arbitrary angles (level data at module load, `wallFrame`): sinRad / cosRad / atan2Det / hypot2.
 *
 * Pure, allocation-free after load, no imports. Safe for sim, game, levels, render, ui and the server.
 */

/** Rotation quantum: 1024 steps per turn (0.35 deg). */
export const TURN_STEPS = 1024;
const QUARTER = TURN_STEPS / 4; // 256
const EIGHTH = TURN_STEPS / 8; // 128
/** Exact IEEE double nearest to PI (a literal, so it is the same everywhere). */
const PI = 3.141592653589793;
const STEP_RAD = (2 * PI) / TURN_STEPS;

/** sin(x) for |x| <= PI/4 by Horner on the Taylor series to x^17 (error < 1e-17 there); `+` and `*` only. */
function polySin(x: number): number {
  const x2 = x * x;
  // 1/3!, 1/5!, ..., 1/17! as literals.
  let p = -2.8114572543455206e-15; // -1/17!
  p = p * x2 + 7.647163731819816e-13; // 1/15!
  p = p * x2 + -1.6059043836821613e-10; // -1/13!
  p = p * x2 + 2.505210838544172e-8; // 1/11!
  p = p * x2 + -2.755731922398589e-6; // -1/9!
  p = p * x2 + 1.984126984126984e-4; // 1/7!
  p = p * x2 + -8.333333333333333e-3; // -1/5!
  p = p * x2 + 1.6666666666666666e-1; // 1/3!
  return x - x * x2 * p;
}
/** cos(x) for |x| <= PI/4 (Taylor to x^16). */
function polyCos(x: number): number {
  const x2 = x * x;
  let p = 4.779477332387385e-14; // 1/16!
  p = p * x2 + -1.1470745597729725e-11; // -1/14!
  p = p * x2 + 2.08767569878681e-9; // 1/12!
  p = p * x2 + -2.755731922398589e-7; // -1/10!
  p = p * x2 + 2.48015873015873e-5; // 1/8!
  p = p * x2 + -1.388888888888889e-3; // -1/6!
  p = p * x2 + 4.1666666666666664e-2; // 1/4!
  p = p * x2 + -0.5; // -1/2!
  return 1 + x2 * p;
}

const SIN = new Float64Array(TURN_STEPS);
const COS = new Float64Array(TURN_STEPS);
for (let k = 0; k < TURN_STEPS; k++) {
  const q = Math.floor(k / QUARTER); // quadrant 0..3
  const r = k - q * QUARTER; // 0..255
  // First-octant values by symmetry: r <= 128 directly, else the complement with sin and cos swapped.
  let s: number;
  let c: number;
  if (r <= EIGHTH) {
    s = polySin(r * STEP_RAD);
    c = polyCos(r * STEP_RAD);
  } else {
    s = polyCos((QUARTER - r) * STEP_RAD);
    c = polySin((QUARTER - r) * STEP_RAD);
  }
  // Rotate by q quarter turns: sin(t + PI/2) = cos t, cos(t + PI/2) = -sin t.
  if (q === 0) {
    SIN[k] = s;
    COS[k] = c;
  } else if (q === 1) {
    SIN[k] = c;
    COS[k] = -s;
  } else if (q === 2) {
    SIN[k] = -s;
    COS[k] = -c;
  } else {
    SIN[k] = -c;
    COS[k] = s;
  }
}

/** Wraps any integer step into [0, TURN_STEPS). */
export const wrapStep = (step: number): number => ((step % TURN_STEPS) + TURN_STEPS) % TURN_STEPS;
/** Deterministic sine of `step / TURN_STEPS` turns. `step` must be an integer. */
export const detSin = (step: number): number => SIN[wrapStep(step)] as number;
/** Deterministic cosine of `step / TURN_STEPS` turns. */
export const detCos = (step: number): number => COS[wrapStep(step)] as number;
/** Radians -> nearest step in [0, TURN_STEPS) (uses only `/`, `*` and Math.round). */
export const radToStep = (rad: number): number => wrapStep(Math.round((rad / (2 * PI)) * TURN_STEPS));
/** Degrees -> nearest step. */
export const degToStep = (deg: number): number => wrapStep(Math.round((deg / 360) * TURN_STEPS));
/** Step -> radians in [0, 2 PI). The value written into placements (rotY), before roundMrad. */
export const stepToRad = (step: number): number => wrapStep(step) * STEP_RAD;

/** Round to millimetres (positions) and milliradians (angles); apply before any check reads a value. */
export const roundMm = (v: number): number => Math.round(v * 1000) / 1000;
export const roundMrad = (v: number): number => Math.round(v * 1000) / 1000;

/** FNV-1a 32-bit over the UTF-16 code units of `s` (stream names, canonical hash strings). Returns a uint32. */
export function fnv1a32(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Two-input seed mixer. Identical to server/common.ts `mixSeed` (room and world seeds). Returns a uint32. */
export function mixSeed(seed: number, a: number): number {
  let h = Math.imul(seed ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(a + 0x3c6ef372, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/** Seed of a named sub-stream (variety.md §2.2): mixSeed(seed, fnv1a32(name)). */
export const streamSeed = (seed: number, name: string): number => mixSeed(seed, fnv1a32(name));

// -------------------------------------------------------------------------------------------------
// Arbitrary angles (REVIEW-M2c final). The same functions as src/game/levels/detTrig.ts (level-designer), bit for bit
// except the sign of a zero atan; detTrig.ts is to become a re-export of these. Same polynomials as the table above; only `+ - * /`, Math.round and Math.sqrt.
// -------------------------------------------------------------------------------------------------
const HALF_PI = 1.5707963267948966;
/** pi/2 split so that k * PIO2_HI is exact (fdlibm pio2_1 / pio2_1t). */
const PIO2_HI = 1.5707963267341256;
const PIO2_LO = 6.077100506506192e-11;
const SQRT3 = 1.7320508075688772;
const TAN_PI_12 = 0.2679491924311227;

/** a = k * pi/2 + r with |r| <= pi/4 (Cody-Waite). Returns [quadrant 0..3, r]. */
function reduceQuadrant(a: number): [number, number] {
  const k = Math.round(a / HALF_PI);
  const r = a - k * PIO2_HI - k * PIO2_LO;
  return [((k % 4) + 4) % 4, r];
}

/** Deterministic sin of any angle in radians (|a| up to a few thousand; within about 1 ulp of Math.sin). */
export function sinRad(a: number): number {
  const [q, r] = reduceQuadrant(a);
  return q === 0 ? polySin(r) : q === 1 ? polyCos(r) : q === 2 ? -polySin(r) : -polyCos(r);
}

/** Deterministic cos of any angle in radians. */
export function cosRad(a: number): number {
  const [q, r] = reduceQuadrant(a);
  return q === 0 ? polyCos(r) : q === 1 ? -polySin(r) : q === 2 ? -polyCos(r) : polySin(r);
}

/** (-1)^k / (2k + 1) for the atan series (correctly rounded division, so the same on every engine). */
const ATAN_C: number[] = Array.from({ length: 16 }, (_, k) => (k % 2 === 0 ? 1 : -1) / (2 * k + 1));

/**
 * Deterministic atan: reduction to |t| <= tan(pi/12), then the series to t^31. atanDet(-0) = -0 like Math.atan, so
 * atan2Det keeps Math.atan2's signed zeros (detTrig.ts returned +0 there; every non-zero result is bit-identical).
 */
export function atanDet(t: number): number {
  const neg = t < 0 || Object.is(t, -0);
  let x = neg ? -t : t;
  let inv = false;
  if (x > 1) {
    x = 1 / x;
    inv = true;
  }
  let base = 0;
  if (x > TAN_PI_12) {
    // atan(x) = pi/6 + atan((x * sqrt3 - 1) / (x + sqrt3))
    base = PI / 6;
    x = (x * SQRT3 - 1) / (x + SQRT3);
  }
  const x2 = x * x;
  let s = 0;
  for (let k = ATAN_C.length - 1; k >= 0; k--) s = s * x2 + (ATAN_C[k] as number);
  let r = base + x * s;
  if (inv) r = HALF_PI - r;
  return neg ? -r : r;
}

/** Deterministic atan2 with Math.atan2's quadrant and signed-zero conventions. */
export function atan2Det(y: number, x: number): number {
  const yNeg = y < 0 || Object.is(y, -0);
  if (x > 0) return atanDet(y / x);
  if (x < 0) return yNeg ? atanDet(y / x) - PI : atanDet(y / x) + PI;
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return x === 0 && Object.is(x, -0) ? (yNeg ? -PI : PI) : y;
}

/** Deterministic 2D hypot (Math.sqrt is correctly rounded; no overflow guard, fine at map scale). Exact |x| when z = 0. */
export const hypot2 = (x: number, z: number): number => Math.sqrt(x * x + z * z);
