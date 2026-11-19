/**
 * First-person viewmodel animation math (M2b, ARCHITECTURE §15.7, ADR 0005 §9, camera.md, STYLE.md §21.3).
 * Owner: graphics-engineer (viewmodel pass). Pure TypeScript: no three.js, no DOM, so every curve is unit-testable.
 *
 * `ViewmodelAnimator.step(view, ctx, dt, out)` turns the plain-data `ViewmodelView` (built by ClientGame) into a
 * small set of offsets that `ViewmodelPass` applies on top of the graphics-designer's reference pose
 * (`applyViewmodelPose`). All offsets are in VIEWMODEL CAMERA SPACE (origin at the eye, -Z forward, +X right, +Y up),
 * metres and radians, Euler XYZ.
 *
 * Number sources (balance wins over the art table where both exist):
 * - recoil kick back / pitch and return time: `clientFeel.fpRecoil.<gun>` (kickBack, kickPitchDeg, returnMs);
 *   the viewmodel roll, SMG jitter, shotgun pump, sniper bolt and LMG sag are the STYLE §21.3 art extras.
 * - ADS recoil: position x `fpAdsRecoilFactor`, rotation x `fpAdsRecoilFactor` x 1.2 (STYLE 0.5 / 0.6 ratio).
 * - idle sway: `vmSwayIdleDeg` (roll amplitude) and `vmSwayIdlePeriodMs`; the STYLE position amplitudes.
 * - look lag: `vmSwayLookFactor` deg per rad/s, capped at `vmSwayMaxDeg`, settling in ~120 ms.
 * - walk / sprint / crouch / prone bob: STYLE rows, scaled by `bobAmount` (which already carries the stance factor,
 *   so the row is divided by `fpBobCrouchFactor` / `fpBobProneFactor` to land on the STYLE amplitude) and by
 *   `vmBobFactor / 1.5` (1 at the shipped value).
 * - action lengths: `actionProgress` from the view; ms keyframes convert with `combat.swapMs`,
 *   `items.grenade.throwRecoveryMs` and `weapons.fists.fireIntervalMs`.
 *
 * Sight rule (camera.md AC6): at adsBlend 1 the sight anchor is exactly on the eye. Idle sway, bob, stance and
 * landing offsets therefore keep only their roll and their along-axis (z) part in ADS, and the rigid offset pivots
 * about the sight eye (camera origin) at full ADS, so a roll never moves the screen-centre point. Recoil and actions
 * still play in ADS (they are transient).
 */
import type { Balance } from '../shared/balance';
import type { ViewmodelView } from '../shared/contracts';
import type { GunId, ItemLevel, M2cGunId, Stance } from '../shared/types';
import { heldScope, type DrawnScope } from './heldItem';
import { meleeSwingPose, MELEE_SWING_KEYS, type ViewmodelItemId, type ViewmodelMeleeId } from './procedural/viewmodel';

export type Vec3T = [number, number, number];

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// -------------------------------------------------------------------------------------------------
// Easing
// -------------------------------------------------------------------------------------------------
export const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);
export const easeInOut = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
export const easeOut = (x: number): number => {
  const t = clamp01(x);
  return 1 - (1 - t) * (1 - t);
};
export const easeIn = (x: number): number => {
  const t = clamp01(x);
  return t * t;
};
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
/** 0 -> 1 over [a, b], held at 1 until c, back to 0 over [c, d] (ease-in-out both ways). */
export function envelope(t: number, a: number, b: number, c: number, d: number): number {
  if (t <= a || t >= d) return 0;
  if (t < b) return easeInOut((t - a) / (b - a));
  if (t <= c) return 1;
  return 1 - easeInOut((t - c) / (d - c));
}
/** Exponential approach factor for time constant `tau` (s) over `dt` (s). */
export const approach = (dt: number, tau: number): number => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

// -------------------------------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------------------------------
export interface VmRecoil {
  kickBack: number;
  kickPitchDeg: number;
  returnMs: number;
}
export interface VmAnimConfig {
  swapMs: number;
  throwRecoveryMs: number;
  punchMs: number;
  recoil: Partial<Record<GunId, VmRecoil>>;
  adsRecoilFactor: number;
  /** vmBobFactor / 1.5 (1 at the shipped value). */
  bobScale: number;
  crouchBobFactor: number;
  proneBobFactor: number;
  swayIdleRad: number;
  swayIdlePeriodMs: number;
  /** rad of lag per rad/s of look speed. */
  swayLookPerRate: number;
  swayMaxRad: number;
}

/** camera.md defaults, used when a balance key is absent (the FP keys are optional until the C-gate). */
export const VM_ANIM_DEFAULTS: VmAnimConfig = {
  swapMs: 350,
  throwRecoveryMs: 600,
  punchMs: 450,
  recoil: {
    pistol: { kickBack: 0.03, kickPitchDeg: 4, returnMs: 120 },
    smg: { kickBack: 0.015, kickPitchDeg: 1.5, returnMs: 70 },
    shotgun: { kickBack: 0.06, kickPitchDeg: 8, returnMs: 250 },
    rifle: { kickBack: 0.02, kickPitchDeg: 2, returnMs: 90 },
    lmg: { kickBack: 0.025, kickPitchDeg: 2.5, returnMs: 100 },
    dmr: { kickBack: 0.045, kickPitchDeg: 5, returnMs: 180 },
    sniper: { kickBack: 0.08, kickPitchDeg: 10, returnMs: 400 },
  },
  adsRecoilFactor: 0.5,
  bobScale: 1,
  crouchBobFactor: 0.6,
  proneBobFactor: 0.5,
  swayIdleRad: 0.6 * DEG,
  swayIdlePeriodMs: 3000,
  swayLookPerRate: 1.5 * DEG,
  swayMaxRad: 3 * DEG,
};

const num = (o: unknown, k: string): number | undefined => {
  if (!o || typeof o !== 'object') return undefined;
  const v = (o as Record<string, unknown>)[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

/** Read the viewmodel numbers from balance (loosely: the FP keys join ClientFeelBalance only at the C-gate). */
export function vmAnimConfigFromBalance(b: Balance): VmAnimConfig {
  const d = VM_ANIM_DEFAULTS;
  const cf = b.clientFeel as unknown;
  const recoil: Partial<Record<GunId, VmRecoil>> = { ...d.recoil };
  const rb = cf && typeof cf === 'object' ? (cf as Record<string, unknown>)['fpRecoil'] : undefined;
  if (rb && typeof rb === 'object') {
    for (const [gun, r] of Object.entries(rb as Record<string, unknown>)) {
      const kb = num(r, 'kickBack'), kp = num(r, 'kickPitchDeg'), rm = num(r, 'returnMs');
      if (kb !== undefined && kp !== undefined && rm !== undefined) {
        recoil[gun as GunId] = { kickBack: kb, kickPitchDeg: kp, returnMs: rm };
      }
    }
  }
  return {
    swapMs: b.combat?.swapMs ?? d.swapMs,
    throwRecoveryMs: b.items?.grenade?.throwRecoveryMs ?? d.throwRecoveryMs,
    punchMs: b.weapons?.fists?.fireIntervalMs ?? d.punchMs,
    recoil,
    adsRecoilFactor: num(cf, 'fpAdsRecoilFactor') ?? d.adsRecoilFactor,
    bobScale: (num(cf, 'vmBobFactor') ?? 1.5) / 1.5,
    crouchBobFactor: num(cf, 'fpBobCrouchFactor') ?? d.crouchBobFactor,
    proneBobFactor: num(cf, 'fpBobProneFactor') ?? d.proneBobFactor,
    swayIdleRad: (num(cf, 'vmSwayIdleDeg') ?? 0.6) * DEG,
    swayIdlePeriodMs: num(cf, 'vmSwayIdlePeriodMs') ?? d.swayIdlePeriodMs,
    swayLookPerRate: (num(cf, 'vmSwayLookFactor') ?? 1.5) * DEG,
    swayMaxRad: (num(cf, 'vmSwayMaxDeg') ?? 3) * DEG,
  };
}

/** Viewmodel vertical FOV: `clientFeel.viewmodelFovDeg` wins (ARCHITECTURE §15.6); `fallback` = VIEWMODEL_FOV. */
export function viewmodelFovFromBalance(b: Balance, fallback: number): number {
  const v = num(b.clientFeel as unknown, 'viewmodelFovDeg');
  return v !== undefined && v > 1 && v < 179 ? v : fallback;
}

// -------------------------------------------------------------------------------------------------
// STYLE §21.3 art tables
// -------------------------------------------------------------------------------------------------
/** Viewmodel roll kick per shot (rad, random sign). Not in balance (camera roll is `fpRecoil.rollDeg`). */
export const VM_RECOIL_ROLL: Readonly<Record<M2cGunId, number>> = {
  pistol: 0.03, smg: 0.02, shotgun: 0.04, rifle: 0.02, lmg: 0.03, dmr: 0.02, sniper: 0.03,
  // M2c (art M2c §7.1 recoil table, rot z)
  dbshotgun: 0.05, revolver: 0.03, rpg: 0.02,
};
/** Bob rows: x amp, y amp, rot z amp. */
export const VM_BOB = {
  walk: [0.01, 0.008, 0.015],
  sprint: [0.022, 0.016, 0.04],
  crouch: [0.008, 0.006, 0.01],
  prone: [0.016, 0.01, 0.03],
} as const;
export const VM_SPRINT_POS: Vec3T = [0.04, -0.05, 0.03];
export const VM_SPRINT_ROT: Vec3T = [-0.25, 0.35, 0.3];
export const VM_PRONE_POS: Vec3T = [0, -0.04, 0.04];
export const VM_PRONE_ROT_X = -0.1;
export const VM_CROUCH_Y = -0.01;
export const VM_STANCE_DIP = -0.025;
export const VM_LAND_DIP = -0.03;
export const VM_LAND_OUT_MS = 120;
export const VM_LAND_BACK_MS = 200;
export const VM_PIN_PULL_MS = 150;
export const VM_WINDUP_MS = 200;
export const VM_THROW_MS = 120;
export const VM_THROW_DROP_END_MS = 400;
export const VM_THROW_TARGET: { pos: Vec3T; rot: Vec3T } = { pos: [0.05, -0.02, -0.6], rot: [-0.6, 0, 0] };
export const VM_DROP_MS = 200;
export const VM_RAISE_MS = 250;
export const VM_SWAP_DROP_FRACTION = 0.45;
export const VM_SWAP_OFFSET: { y: number; rotX: number } = { y: -0.25, rotX: 0.6 };
export const VM_PUNCH = {
  outMs: 90, holdMs: 30, backMs: 160,
  pos: [0.06, -0.06, -0.62] as Vec3T,
  rot: [-0.15, -0.25, 0] as Vec3T,
  pullBack: 0.03, viewKick: 0.01,
};
/**
 * STYLE §21.3 says freefall (±0.45, −0.05, −0.35) and chute (±0.18, +0.22, −0.25); at the 55° viewmodel FOV both
 * put the hands just outside the frame (headless check), so they are pulled in until the mittens show at the edges
 * (freefall) and the upper corners (chute).
 */
export const VM_FREEFALL_HAND: Vec3T = [0.3, -0.08, -0.38];
export const VM_CHUTE_HAND: Vec3T = [0.22, 0.15, -0.4];
export const VM_CHUTE_DEPLOY_MS = 350;
/** Hand frame: fingers -Z, back of hand +Y, forearm +Z. Right-hand rotations; the left mirrors y and z. */
const FREEFALL_ROT_R: Vec3T = [0.15, 0.9, -0.2];
/** Fingers up-forward on the riser toggle, forearm running down and back toward the shoulder. */
const CHUTE_ROT_R: Vec3T = [1.0, 0.25, 0.15];
/**
 * Where the left hand grabs the magazine (or the shotgun loading port), in ITEM space (weapon frame: origin at the
 * grip, barrel -Z). Estimated from weapons.ts piece placement.
 */
export const VM_MAG_POINT: Readonly<Record<M2cGunId, Vec3T>> = {
  pistol: [0, -0.075, 0.02],
  smg: [0, -0.09, -0.155],
  shotgun: [0, -0.045, -0.09],
  rifle: [0, -0.1, -0.13],
  lmg: [-0.06, -0.07, -0.13],
  dmr: [0, -0.085, -0.145],
  sniper: [0, -0.035, -0.1],
  // M2c (art M2c §2.2 anchors, §7.1 reloads; framed in Phase 2): dbshotgun loads at the open breech, the revolver at the
  // swung-out cylinder (-X), the rpg at the muzzle (`rocketSeat`).
  dbshotgun: [0, 0.09, -0.06],
  revolver: [-0.03, 0.06, -0.03],
  rpg: [0, 0.1, -0.52],
};

const GUNS: readonly string[] = ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper', 'revolver', 'dbshotgun', 'rpg'];
export const isGun = (id: string): id is GunId => GUNS.includes(id);
const MELEE: readonly string[] = ['knife', 'machete', 'paddle'];
export const isMeleeVm = (id: string): id is ViewmodelMeleeId => MELEE.includes(id);
/** Throwables: the frag and the M2c smoke can (each with a pin-pulled model). */
const isThrowableVm = (id: string): boolean => id === 'grenade' || id === 'smoke';

/** Map the view's held item to a VIEWMODEL_POSES key. */
export function viewmodelItemFor(item: string, cooking: boolean): ViewmodelItemId {
  if (item === 'grenade') return cooking ? 'grenade_cooking' : 'grenade';
  if (item === 'smoke') return cooking ? 'smoke_cooking' : 'smoke';
  if (item === 'bandage' || item === 'medkit' || item === 'fists' || isGun(item) || isMeleeVm(item)) return item as ViewmodelItemId;
  return 'fists';
}

/** The pin-in / pin-pulled pose key of the throwable in hand. */
const throwPose = (item: string, pulled: boolean): ViewmodelItemId =>
  item === 'smoke' ? (pulled ? 'smoke_cooking' : 'smoke') : pulled ? 'grenade_cooking' : 'grenade';

// -------------------------------------------------------------------------------------------------
// Pure curves (exported for tests)
// -------------------------------------------------------------------------------------------------
/** Weight of `s` in a stance transition from -> to at progress p (1 = settled). */
export function stanceWeight(s: Stance, from: Stance, to: Stance, p: number): number {
  const k = clamp01(p);
  return (from === s ? 1 - k : 0) + (to === s ? k : 0);
}

/** Stance-change dip: y offset (m), 0 when settled. */
export function stanceDip(from: Stance, to: Stance, p: number): number {
  if (from === to || p >= 1) return 0;
  return VM_STANCE_DIP * Math.sin(Math.PI * clamp01(p));
}

/** Landing dip y offset for `ms` since touchdown (Infinity = none). */
export function landingDip(ms: number): number {
  if (!(ms >= 0) || ms >= VM_LAND_OUT_MS + VM_LAND_BACK_MS) return 0;
  if (ms < VM_LAND_OUT_MS) return VM_LAND_DIP * easeOut(ms / VM_LAND_OUT_MS);
  return VM_LAND_DIP * (1 - easeInOut((ms - VM_LAND_OUT_MS) / VM_LAND_BACK_MS));
}

/** Recoil amplitude after `n` shots added to `amp` (stacking cap 2x). */
export const recoilStack = (amp: number, n: number): number => Math.min(2, amp + n);
/** Recoil decay over dtMs: exponential, time constant returnMs / 5 (under 1% left at returnMs). */
export const recoilDecay = (amp: number, dtMs: number, returnMs: number): number =>
  amp * Math.exp((-5 * dtMs) / Math.max(1, returnMs));

/** Shotgun pump (0..1) for ms since the shot: after the kick, 180 ms back, 160 ms return. */
export const shotgunPump = (ms: number): number => envelope(ms, 100, 280, 280, 440);
/** Sniper bolt (0..1): 200 ms pull, 180 ms back. */
export const sniperBolt = (ms: number): number => envelope(ms, 150, 350, 350, 530);

/** Punch jab weight (0..1) for ms since the punch started. */
export function punchWeight(ms: number): number {
  const P = VM_PUNCH;
  if (!(ms >= 0)) return 0;
  if (ms < P.outMs) return easeOut(ms / P.outMs);
  if (ms < P.outMs + P.holdMs) return 1;
  if (ms < P.outMs + P.holdMs + P.backMs) return 1 - easeInOut((ms - P.outMs - P.holdMs) / P.backMs);
  return 0;
}

/** Swap: drop (0..1) for the old item and rise (1 = fully lowered, 0 = up) for the new one. */
export function swapCurve(p: number, hasOld: boolean): { showOld: boolean; lower: number } {
  const t = clamp01(p);
  if (hasOld && t < VM_SWAP_DROP_FRACTION) return { showOld: true, lower: easeIn(t / VM_SWAP_DROP_FRACTION) };
  const u = hasOld ? (t - VM_SWAP_DROP_FRACTION) / (1 - VM_SWAP_DROP_FRACTION) : t;
  return { showOld: false, lower: 1 - easeOut(u) };
}

/** Reload socket tilt weight (0..1): tilt in over 0..0.15, hold, back over 0.85..1. */
export const reloadTilt = (p: number): number => envelope(p, 0, 0.15, 0.85, 1);

/** Look lag target (rad) for a look rate (rad/s): opposite to the turn, capped. */
export function lookLagTarget(rate: number, perRate: number, max: number): number {
  const v = -rate * perRate;
  return v > max ? max : v < -max ? -max : v;
}

// -------------------------------------------------------------------------------------------------
// Output
// -------------------------------------------------------------------------------------------------
export interface VmHandOut {
  /** Additive camera-space offset, applied last. */
  pos: Vec3T;
  rot: Vec3T;
  /** Absolute camera-space target (pos + rot), blended in by absW. */
  absPos: Vec3T;
  absRot: Vec3T;
  absW: number;
  /** Blend toward the gun's magazine point (VM_MAG_POINT, item space). */
  magW: number;
  /** Finger curl override; NaN = the pose value. */
  curl: number;
  visible: boolean;
}
export interface VmOut {
  visible: boolean;
  /** Pose / model key; drop phases use 'fists' with the item hidden. */
  item: ViewmodelItemId;
  showItem: boolean;
  /** Eased hip -> ADS pose blend. */
  ads: number;
  /** Rigid offset for the socket and the hands (camera space). Rotation pivots at the socket (hip) / the eye (ADS). */
  sockPos: Vec3T;
  sockRot: Vec3T;
  /** Absolute socket target blended in by sockAbsW (the overhand throw). */
  sockAbsPos: Vec3T;
  sockAbsRot: Vec3T;
  sockAbsW: number;
  /** Whole-viewmodel rotation about the eye (punch view kick). */
  rootRot: Vec3T;
  handR: VmHandOut;
  handL: VmHandOut;
  /** Item spin about its own X (bandage roll). */
  itemSpinX: number;
  drop: 'freefall' | 'chute' | null;
  /** Parachute deploy for setParachuteDeploy (0..1), or -1 = no canopy. */
  canopy: number;
  /** Fuse spark intensity (0 = off). */
  fuse: number;
  /** M2c: the held weapon's level and the drawn scope (per-level model, mounted scope, ADS pose from it). */
  level: ItemLevel | null;
  scope: DrawnScope | null;
}

const hand = (): VmHandOut => ({
  pos: [0, 0, 0], rot: [0, 0, 0], absPos: [0, 0, 0], absRot: [0, 0, 0], absW: 0, magW: 0, curl: NaN, visible: true,
});
export function createVmOut(): VmOut {
  return {
    visible: false, item: 'fists', showItem: true, ads: 0,
    sockPos: [0, 0, 0], sockRot: [0, 0, 0], sockAbsPos: [0, 0, 0], sockAbsRot: [0, 0, 0], sockAbsW: 0,
    rootRot: [0, 0, 0], handR: hand(), handL: hand(), itemSpinX: 0, drop: null, canopy: -1, fuse: 0, level: null, scope: null,
  };
}
const set3 = (v: Vec3T, x: number, y: number, z: number): void => {
  v[0] = x; v[1] = y; v[2] = z;
};
function resetHand(h: VmHandOut): void {
  set3(h.pos, 0, 0, 0);
  set3(h.rot, 0, 0, 0);
  h.absW = 0;
  h.magW = 0;
  h.curl = NaN;
  h.visible = true;
}

export interface VmStepContext {
  /** The subject is airborne (PlayerState.anim.airborne); used for the landing dip. */
  airborne: boolean;
}

// -------------------------------------------------------------------------------------------------
// Animator (state + per-frame step; allocation-free)
// -------------------------------------------------------------------------------------------------
export class ViewmodelAnimator {
  /** Animation clock (s). */
  t = 0;
  private playerId: number | string | null = null;
  private shotCount = 0;
  private recoilGun: GunId | null = null;
  recoilAmp = 0;
  private rollAmp = 0;
  private jitterX = 0;
  private jitterY = 0;
  private msSinceShot = Infinity;
  lagYaw = 0;
  lagPitch = 0;
  private sprintW = 0;
  private dropW = 0;
  private landMs = Infinity;
  private wasAirborne = false;
  private lastDrop: 'freefall' | 'chute' | null = null;
  private chuteMs = 0;
  private raiseMs = Infinity;
  private prevAction: ViewmodelView['action'] = 'idle';
  private prevProgress = 0;
  private punchMs = Infinity;
  private punchLeft = true;
  private cookMs = Infinity;
  private wasCooking = false;
  private dropGrenadeMs = Infinity;
  private shownItem: ViewmodelItemId = 'fists';
  /** M2c melee: swings started (knife alternates forehand / backhand). */
  private swingCount = 0;
  private swapFrom: ViewmodelItemId | null = null;
  private seed = 0x2545f491;

  constructor(private cfg: VmAnimConfig = VM_ANIM_DEFAULTS) {}

  setConfig(cfg: VmAnimConfig): void {
    this.cfg = cfg;
  }

  /** Deterministic -1..1 noise (seedable for tests). */
  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return (this.seed / 0xffffffff) * 2 - 1;
  }

  /** Forget per-player state (new subject, map change). */
  reset(): void {
    this.playerId = null;
    this.recoilAmp = this.rollAmp = 0;
    this.msSinceShot = this.landMs = this.raiseMs = this.punchMs = this.cookMs = this.dropGrenadeMs = Infinity;
    this.lagYaw = this.lagPitch = this.sprintW = this.dropW = 0;
    this.wasAirborne = this.wasCooking = false;
    this.lastDrop = null;
    this.prevAction = 'idle';
    this.prevProgress = 0;
    this.swapFrom = null;
  }

  step(v: ViewmodelView | null | undefined, ctx: VmStepContext, dt: number, out: VmOut): VmOut {
    const c = this.cfg;
    const dts = dt > 0 && dt < 0.25 ? dt : dt >= 0.25 ? 0.25 : 0;
    const dms = dts * 1000;
    this.t += dts;
    out.visible = !!v && v.visible;
    if (!v) {
      this.reset();
      return out;
    }
    if (v.playerId !== this.playerId) {
      this.reset();
      this.playerId = v.playerId;
      this.shotCount = v.shotCount;
      this.shownItem = viewmodelItemFor(v.item, v.cooking);
    }

    // Reset the output.
    set3(out.sockPos, 0, 0, 0);
    set3(out.sockRot, 0, 0, 0);
    set3(out.rootRot, 0, 0, 0);
    out.sockAbsW = 0;
    resetHand(out.handR);
    resetHand(out.handL);
    out.itemSpinX = 0;
    out.fuse = 0;
    out.canopy = -1;
    out.showItem = true;
    out.level = v.level ?? null;
    out.scope = heldScope(v.item, v.sight ?? null);

    const p = clamp01(v.actionProgress);
    const action = v.action;
    const adsRaw = clamp01(v.adsBlend);
    const ms = Math.max(0, v.motionScale);
    let item = viewmodelItemFor(v.item, v.cooking || action === 'cook');

    // ---- timers -------------------------------------------------------------------------------
    this.msSinceShot += dms;
    this.landMs += dms;
    this.raiseMs += dms;
    this.punchMs += dms;
    this.dropGrenadeMs += dms;

    // Landing: airborne -> grounded, or the drop ended.
    const drop = v.dropPhase ?? null;
    if ((this.wasAirborne && !ctx.airborne && !drop) || (this.lastDrop && !drop)) this.landMs = 0;
    if (this.lastDrop && !drop) this.raiseMs = 0;
    this.wasAirborne = ctx.airborne;
    if (drop === 'chute') this.chuteMs = this.lastDrop === 'chute' ? this.chuteMs + dms : 0;
    this.lastDrop = drop;

    // Cook timer and drop-at-feet detection (cooking ended without a throw).
    const cooking = v.cooking || action === 'cook';
    if (cooking) this.cookMs = this.wasCooking ? this.cookMs + dms : 0;
    else {
      if (this.wasCooking && action !== 'throw') this.dropGrenadeMs = 0;
      this.cookMs = Infinity;
    }
    this.wasCooking = cooking;

    // Punch: a new punch when the action starts or its progress wraps.
    if (action === 'punch' && (this.prevAction !== 'punch' || p < this.prevProgress - 0.2)) {
      this.punchMs = p * c.punchMs;
      this.punchLeft = !this.punchLeft;
    }
    // Melee: a new swing when the action starts or its progress wraps.
    if (action === 'swing' && (this.prevAction !== 'swing' || p < this.prevProgress - 0.2)) this.swingCount++;
    // Swap: remember what was in hand before the swap started.
    if (action === 'swapIn' && this.prevAction !== 'swapIn') {
      this.swapFrom = this.shownItem !== item ? this.shownItem : null;
    }
    this.prevAction = action;
    this.prevProgress = p;

    // ---- recoil ---------------------------------------------------------------------------------
    const gun = isGun(v.item) ? v.item : null;
    if (gun !== this.recoilGun) {
      this.recoilGun = gun;
      this.recoilAmp = this.rollAmp = 0;
      this.msSinceShot = Infinity;
    }
    const shots = v.shotCount - this.shotCount;
    this.shotCount = v.shotCount;
    const rc = gun ? c.recoil[gun] : undefined;
    if (rc) {
      this.recoilAmp = recoilDecay(this.recoilAmp, dms, rc.returnMs);
      this.rollAmp = recoilDecay(this.rollAmp, dms, rc.returnMs);
      if (shots > 0 && shots < 1000) {
        this.recoilAmp = recoilStack(this.recoilAmp, shots);
        const sgn = this.rand() >= 0 ? 1 : -1;
        this.rollAmp = Math.max(-2, Math.min(2, this.rollAmp + sgn * Math.min(shots, 2)));
        this.jitterX = this.rand() * 0.004;
        this.jitterY = this.rand() * 0.004;
        this.msSinceShot = 0;
      }
    } else {
      this.recoilAmp = this.rollAmp = 0;
    }

    // ---- drop phases (freefall / chute arms) -----------------------------------------------------
    this.dropW += ((drop ? 1 : 0) - this.dropW) * approach(dts, 0.08);
    out.drop = drop;
    if (drop) {
      out.item = 'fists';
      out.showItem = false;
      out.ads = 0;
      const k = drop === 'chute' ? easeInOut(this.chuteMs / VM_CHUTE_DEPLOY_MS) : 0;
      if (drop === 'chute') out.canopy = clamp01(this.chuteMs / VM_CHUTE_DEPLOY_MS);
      const flutter = (drop === 'freefall' ? 0.08 : 0.03) * ms;
      for (const side of [1, -1] as const) {
        const h = side > 0 ? out.handR : out.handL;
        set3(
          h.absPos,
          side * lerp(VM_FREEFALL_HAND[0], VM_CHUTE_HAND[0], k),
          lerp(VM_FREEFALL_HAND[1], VM_CHUTE_HAND[1], k),
          lerp(VM_FREEFALL_HAND[2], VM_CHUTE_HAND[2], k),
        );
        set3(
          h.absRot,
          lerp(FREEFALL_ROT_R[0], CHUTE_ROT_R[0], k),
          side * lerp(FREEFALL_ROT_R[1], CHUTE_ROT_R[1], k),
          side * lerp(FREEFALL_ROT_R[2], CHUTE_ROT_R[2], k) + side * flutter * Math.sin(this.t * 9 + (side > 0 ? 0 : 1.7)),
        );
        h.absW = clamp01(this.dropW);
        h.curl = lerp(-0.35, -1.6, k);
      }
      // the chute sways gently
      out.sockRot[2] = 0.06 * ms * Math.sin(this.t * 1.3) * k;
      this.shownItem = 'fists';
      return out;
    }

    // ---- item shown and its action ----------------------------------------------------------------
    let ads = adsRaw;
    let lower = 0; // swap-style lowering 0..1 (1 = off-screen)

    if (action === 'cycle') {
      // M2c throwable cycle (frag <-> smoke): a quick dip and rise, same curve as a swap.
      const s = swapCurve(p, false);
      lower = Math.max(lower, s.lower * 0.6);
      ads = 0;
    }
    if (action === 'scopeSwap') {
      // M2c T sight switch: tilt the gun toward the camera (the left hand works the rail), then back.
      const w = reloadTilt(p);
      out.sockRot[0] += 0.1 * w;
      out.sockRot[2] += -0.3 * w;
      out.handL.magW = 0;
      out.handL.pos[1] += 0.04 * w;
      ads = 0;
    }
    if (action === 'swing' && isMeleeVm(item)) {
      // M2c melee (art M2c §7.2): absolute socket arc from the designer's keys; the blade crosses the centre at h.
      const h = clamp01(v.hitFraction ?? 0.35);
      const xf = meleeSwingPose(item, p, h, this.swingCount % 2 === 0);
      out.sockAbsW = 1;
      set3(out.sockAbsPos, xf.pos[0], xf.pos[1], xf.pos[2]);
      set3(out.sockAbsRot, xf.rot[0], xf.rot[1], xf.rot[2]);
      const k = MELEE_SWING_KEYS[item].kick;
      const kw = envelope(p, h - 0.03, h, h + 0.02, h + 0.12) * ms;
      out.rootRot[0] += k[0] * kw;
      out.rootRot[1] += k[1] * kw;
      ads = 0;
    }

    if (action === 'swapIn') {
      const s = swapCurve(p, this.swapFrom !== null);
      if (s.showOld && this.swapFrom) item = this.swapFrom;
      lower = s.lower;
      ads = 0;
    }

    if (action === 'reload' && gun) {
      const w = reloadTilt(p);
      out.sockRot[0] += 0.15 * w;
      out.sockRot[1] += 0.25 * w;
      out.sockRot[2] += 0.35 * w;
      out.sockPos[1] += 0.03 * w + 0.01 * envelope(p, 0.63, 0.65, 0.65, 0.7);
      this.reloadHand(gun, p, out.handL, out);
      ads = 0;
    }

    if (action === 'heal') {
      const env = envelope(p, 0, 0.1, 0.9, 1);
      if (item === 'bandage') {
        const th = 3 * TAU * p;
        out.handR.pos[0] += 0.03 * Math.cos(th) * env;
        out.handR.pos[1] += 0.03 * Math.sin(th) * env;
        out.handL.pos[0] += 0.03 * Math.cos(th + Math.PI) * env;
        out.handL.pos[1] += 0.03 * Math.sin(th + Math.PI) * env;
        out.itemSpinX = 2 * TAU * p;
        out.sockPos[1] += -0.02 * env;
      } else if (item === 'medkit') {
        const rise = envelope(p, 0, 0.2, 0.85, 1);
        out.sockPos[1] += 0.04 * rise;
        out.sockRot[0] += -0.3 * rise;
        if (p > 0.2 && p < 0.85) {
          const tap = Math.sin(TAU * 6 * this.t);
          out.handR.pos[1] += 0.015 * Math.max(0, tap) * rise;
          out.handL.pos[1] += 0.015 * Math.max(0, -tap) * rise;
        }
      }
    }

    if (cooking && action !== 'throw') {
      const cm = this.cookMs;
      if (cm < VM_PIN_PULL_MS) {
        // Pull the pin: the pin model is still in, the left hand pulls back with the ring.
        item = throwPose(v.item, false);
        const k = easeOut(cm / VM_PIN_PULL_MS);
        out.handL.pos[0] += -0.06 * k;
        out.handL.pos[2] += 0.05 * k;
        out.sockRot[2] += 0.012 * Math.sin(this.t * 70);
      } else {
        item = throwPose(v.item, true);
        ads = Math.max(ads, easeInOut((cm - VM_PIN_PULL_MS) / VM_WINDUP_MS));
        out.fuse = v.item === 'smoke' ? 0 : 1;
        // jitter grows as the fuse runs out (actionProgress = fuse fraction)
        out.sockRot[2] += 0.02 * p * Math.sin(this.t * 43) * Math.sin(this.t * 17 + 0.5);
      }
    }

    if (action === 'throw') {
      const tm = p * this.cfg.throwRecoveryMs;
      if (tm < VM_THROW_DROP_END_MS) {
        item = throwPose(isThrowableVm(v.item) ? v.item : 'grenade', true);
        ads = 1;
        out.sockAbsW = easeOut(tm / VM_THROW_MS);
        set3(out.sockAbsPos, VM_THROW_TARGET.pos[0], VM_THROW_TARGET.pos[1], VM_THROW_TARGET.pos[2]);
        set3(out.sockAbsRot, VM_THROW_TARGET.rot[0], VM_THROW_TARGET.rot[1], VM_THROW_TARGET.rot[2]);
        if (tm >= VM_THROW_MS * 0.6) {
          out.showItem = false;
          out.handR.curl = 0;
        }
        if (tm > VM_THROW_MS) out.sockPos[1] += -0.3 * easeIn((tm - VM_THROW_MS) / (VM_THROW_DROP_END_MS - VM_THROW_MS));
        out.handL.visible = false;
      } else {
        const span = Math.max(1, this.cfg.throwRecoveryMs - VM_THROW_DROP_END_MS);
        lower = Math.max(lower, 1 - easeOut((tm - VM_THROW_DROP_END_MS) / span));
        ads = 0;
      }
    } else if (this.dropGrenadeMs < VM_DROP_MS + VM_RAISE_MS) {
      // Swap while cooking: the live grenade drops at the feet, then the next item rises.
      const dm = this.dropGrenadeMs;
      if (dm < VM_DROP_MS) {
        item = throwPose(isThrowableVm(v.item) ? v.item : 'grenade', true);
        out.sockPos[1] += -0.3 * easeIn(dm / VM_DROP_MS);
        out.handR.curl = 0;
        out.showItem = dm < VM_DROP_MS * 0.5;
      } else lower = Math.max(lower, 1 - easeOut((dm - VM_DROP_MS) / VM_RAISE_MS));
      ads = 0;
    }

    if (item === 'fists' && this.punchMs < VM_PUNCH.outMs + VM_PUNCH.holdMs + VM_PUNCH.backMs) {
      const w = punchWeight(this.punchMs);
      const side = this.punchLeft ? -1 : 1;
      const jab = side > 0 ? out.handR : out.handL;
      const other = side > 0 ? out.handL : out.handR;
      set3(jab.absPos, side * VM_PUNCH.pos[0], VM_PUNCH.pos[1], VM_PUNCH.pos[2]);
      set3(jab.absRot, NaN, NaN, NaN); // position only; rotation stays the guard + the additive twist
      jab.absW = w;
      jab.rot[0] += VM_PUNCH.rot[0] * w;
      jab.rot[1] += side * VM_PUNCH.rot[1] * w;
      other.pos[2] += VM_PUNCH.pullBack * w;
      out.rootRot[0] += VM_PUNCH.viewKick * w;
    }

    // Raise after landing from the chute.
    if (this.raiseMs < VM_RAISE_MS) lower = Math.max(lower, 1 - easeOut(this.raiseMs / VM_RAISE_MS));
    if (lower > 0) {
      out.sockPos[1] += VM_SWAP_OFFSET.y * lower;
      out.sockRot[0] += VM_SWAP_OFFSET.rotX * lower;
    }

    // ---- recoil offsets -----------------------------------------------------------------------
    if (rc && gun) {
      const fPos = lerp(1, c.adsRecoilFactor, adsRaw);
      const fRot = lerp(1, Math.min(1, c.adsRecoilFactor * 1.2), adsRaw);
      const a = this.recoilAmp;
      out.sockPos[2] += rc.kickBack * a * fPos;
      out.sockRot[0] += rc.kickPitchDeg * DEG * a * fRot;
      out.sockRot[2] += VM_RECOIL_ROLL[gun] * this.rollAmp * fRot;
      if (gun === 'smg') {
        out.sockPos[0] += this.jitterX * Math.min(1, a) * fPos;
        out.sockPos[1] += this.jitterY * Math.min(1, a) * fPos;
      }
      if (gun === 'lmg') out.sockPos[1] += -0.01 * Math.min(1, a) * fPos;
      if (gun === 'shotgun') {
        const w = shotgunPump(this.msSinceShot);
        out.sockPos[1] += -0.02 * w;
        out.handL.pos[2] += 0.08 * w;
      }
      if (gun === 'sniper') {
        const w = sniperBolt(this.msSinceShot);
        out.handR.pos[0] += 0.06 * w;
        out.handR.pos[2] += 0.07 * w;
      }
    }

    // ---- motion: sway, look lag, bob, stance, landing, sprint (scaled for ADS) --------------------
    const hipK = 1 - adsRaw;
    let mx = 0, my = 0, mz = 0, rx = 0, ry = 0, rz = 0;
    // idle sway
    const w0 = TAU / Math.max(1, c.swayIdlePeriodMs / 1000);
    mx += 0.004 * Math.sin(w0 * this.t) * ms;
    my += 0.003 * Math.sin(2 * w0 * this.t + 0.6) * ms;
    const swayRoll = c.swayIdleRad * Math.sin(w0 * this.t) * ms;
    // look lag (settles ~120 ms)
    const lk = approach(dts, 0.03);
    this.lagYaw += (lookLagTarget(v.lookRate?.yaw ?? 0, c.swayLookPerRate, c.swayMaxRad) - this.lagYaw) * lk;
    this.lagPitch += (lookLagTarget(v.lookRate?.pitch ?? 0, c.swayLookPerRate, c.swayMaxRad) - this.lagPitch) * lk;
    ry += this.lagYaw * ms;
    rx += this.lagPitch * ms;
    // bob
    const stance = v.stanceProgress >= 0.5 ? v.stance : v.stanceFrom;
    const row = v.sprinting && stance === 'stand' ? VM_BOB.sprint : stance === 'crouch' ? VM_BOB.crouch : stance === 'prone' ? VM_BOB.prone : VM_BOB.walk;
    const sf = stance === 'crouch' ? c.crouchBobFactor : stance === 'prone' ? c.proneBobFactor : 1;
    const bobK = (clamp01(v.bobAmount) / Math.max(0.05, sf)) * c.bobScale * ms;
    const half = v.bobPhase * 0.5;
    mx += row[0] * Math.sin(half) * bobK;
    my += -row[1] * Math.abs(Math.sin(half)) * bobK;
    const bobRoll = row[2] * Math.sin(half) * bobK;
    // stance extras and dip
    const wc = stanceWeight('crouch', v.stanceFrom, v.stance, v.stanceProgress);
    const wp = stanceWeight('prone', v.stanceFrom, v.stance, v.stanceProgress);
    my += VM_CROUCH_Y * wc + VM_PRONE_POS[1] * wp + stanceDip(v.stanceFrom, v.stance, v.stanceProgress);
    mz += VM_PRONE_POS[2] * wp;
    rx += VM_PRONE_ROT_X * wp;
    // landing
    my += landingDip(this.landMs) * ms;
    // sprint carry
    const sprintTarget = v.sprinting && action === 'idle' && adsRaw < 0.5 && !cooking ? 1 : 0;
    this.sprintW += (sprintTarget - this.sprintW) * approach(dts, 0.08);
    const sw = this.sprintW;
    mx += VM_SPRINT_POS[0] * sw;
    my += VM_SPRINT_POS[1] * sw;
    mz += VM_SPRINT_POS[2] * sw;
    rx += VM_SPRINT_ROT[0] * sw;
    ry += VM_SPRINT_ROT[1] * sw;
    rz += VM_SPRINT_ROT[2] * sw;

    out.sockPos[0] += mx * hipK;
    out.sockPos[1] += my * hipK;
    out.sockPos[2] += mz * hipK;
    out.sockRot[0] += rx * hipK;
    out.sockRot[1] += ry * hipK;
    out.sockRot[2] += rz * hipK + swayRoll * lerp(1, 0.25, adsRaw) + bobRoll * lerp(1, 0.2, adsRaw);

    out.item = item;
    out.ads = easeInOut(ads);
    this.shownItem = action === 'swapIn' && item === this.swapFrom ? this.shownItem : item;
    return out;
  }

  /** The left hand leaves the fore-end (fades out while it is at the mag). */
  private leaveForeEnd(p: number, h: VmHandOut): void {
    const leave = envelope(p, 0, 0.15, 0.85, 1) * (1 - h.magW);
    h.pos[0] += -0.02 * leave;
    h.pos[1] += -0.04 * leave;
    h.pos[2] += 0.03 * leave;
  }

  /** Left hand during a gun reload (STYLE §21.3 "Reload"). */
  private reloadHand(gun: GunId, p: number, h: VmHandOut, out?: VmOut): void {
    if (gun === 'dbshotgun') {
      // Break-open (art M2c §7.1): barrels drop 0-0.2, the left hand dips twice 0.35-0.75, snap shut 0.75-0.85.
      const open = envelope(p, 0, 0.2, 0.75, 0.85);
      if (out) {
        out.sockRot[0] += 0.5 * open;
        out.sockPos[1] += 0.015 * envelope(p, 0.75, 0.8, 0.8, 0.85);
      }
      h.magW = envelope(p, 0.3, 0.38, 0.75, 0.85);
      this.leaveForeEnd(p, h);
      if (p > 0.35 && p < 0.75) h.pos[1] += -0.1 * (0.5 - 0.5 * Math.cos(4 * Math.PI * ((p - 0.35) / 0.4)));
      return;
    }
    if (gun === 'revolver') {
      // Swing-out: tilt left 0-0.2, tip up 0.2-0.35, speed-loader 0.35-0.7, snap back 0.7-0.85.
      if (out) {
        out.sockRot[2] += 0.4 * envelope(p, 0, 0.2, 0.7, 0.85);
        out.sockRot[0] += -0.5 * envelope(p, 0.2, 0.3, 0.35, 0.45);
      }
      h.magW = envelope(p, 0.3, 0.4, 0.65, 0.75);
      this.leaveForeEnd(p, h);
      if (p > 0.3 && p < 0.55) h.pos[1] += -0.2 * envelope(p, 0.3, 0.38, 0.42, 0.55);
      return;
    }
    if (gun === 'rpg') {
      // Front load: lower the tube 0-0.2, the left hand brings a rocket up from below 0.2-0.5 and pushes it home.
      if (out) {
        const low = envelope(p, 0, 0.2, 0.7, 1);
        out.sockPos[1] += -0.06 * low;
        out.sockRot[0] += 0.2 * low;
      }
      h.magW = envelope(p, 0.35, 0.5, 0.65, 0.75);
      this.leaveForeEnd(p, h);
      if (p > 0.15 && p < 0.45) h.pos[1] += -0.3 * envelope(p, 0.15, 0.25, 0.3, 0.45);
      return;
    }
    if (gun === 'shotgun') {
      // to the loading port, down for shells, three dips in, back to the pump
      h.magW = envelope(p, 0.15, 0.3, 0.85, 1);
      this.leaveForeEnd(p, h);
      if (p > 0.3 && p < 0.4) h.pos[1] += -0.12 * easeInOut((p - 0.3) / 0.1);
      else if (p >= 0.4 && p < 0.85) h.pos[1] += -0.12 * (0.5 + 0.5 * Math.cos(6 * Math.PI * ((p - 0.4) / 0.45)));
      return;
    }
    h.magW = envelope(p, 0.15, 0.25, 0.7, 0.85);
    this.leaveForeEnd(p, h);
    // down off-screen with the old mag, back up with the new one, push in at 0.65
    if (p > 0.25 && p < 0.6) h.pos[1] += -0.25 * envelope(p, 0.25, 0.4, 0.42, 0.6);
    h.pos[1] += 0.02 * envelope(p, 0.6, 0.64, 0.64, 0.68);
    // slap the side / charge (lmg: lid over the top)
    const slap = envelope(p, 0.7, 0.76, 0.79, 0.85);
    if (gun === 'lmg') h.pos[1] += 0.06 * slap;
    else h.pos[0] += -0.04 * slap;
  }
}
