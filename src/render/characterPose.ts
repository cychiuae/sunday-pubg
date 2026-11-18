/**
 * Procedural chibi animation: anim flags + speed + timers -> joint angles. Pure (no scene access), allocation-free,
 * unit-testable. Owner: graphics-engineer.
 *
 * Rig conventions (src/render/procedural/chibi.ts): character faces -Z; limbs hang along -Y; rotation.x > 0 swings
 * a limb forward (PI/2 = pointing straight ahead); rotation.z > 0 swings a hanging limb toward +X. Head/body
 * rotation.x > 0 tilts the face up / leans back.
 *
 * M2a stances (docs/art/STYLE.md §16): three full poses (stand, crouch, prone) are computed from the same input and
 * blended with the weights from `stanceBlend` (crouch weight c, then prone weight p on top). The stance pivot
 * (`parts.stance`) carries the crouch drop and the prone lie-down, so the root keeps world position + yaw.
 */
import type { DropPhase, HeldId, PlayerAnim, Stance } from '../shared/types';
import { CHIBI_FREEFALL, CHIBI_STANCES, freefallStanceOffset } from './procedural/chibi';

export interface Pose {
  /** Root tilt about X (topple / skydive), applied after yaw. */
  rootTiltX: number;
  rootTiltZ: number;
  /** M2a stance pivot: rotation.x and position (y, z). Identity when standing. */
  stanceX: number;
  /** M2b stance pivot rotation.y (Euler XYZ: a roll about the spine; the freefall bank). */
  stanceRotY: number;
  stanceY: number;
  stanceZ: number;
  /** Extra hip height (bob / squash), metres. */
  bodyY: number;
  bodyX: number;
  bodyY_rot: number;
  bodyZ: number;
  headX: number;
  headY: number;
  armLX: number;
  armLY: number;
  armLZ: number;
  armRX: number;
  armRY: number;
  armRZ: number;
  legLX: number;
  legLZ: number;
  legRX: number;
  legRZ: number;
  /** Uniform scale (death poof shrink). */
  scale: number;
  weaponVisible: boolean;
}

const POSE_KEYS = [
  'rootTiltX', 'rootTiltZ', 'stanceX', 'stanceRotY', 'stanceY', 'stanceZ', 'bodyY', 'bodyX', 'bodyY_rot', 'bodyZ', 'headX', 'headY',
  'armLX', 'armLY', 'armLZ', 'armRX', 'armRY', 'armRZ', 'legLX', 'legLZ', 'legRX', 'legRZ', 'scale',
] as const satisfies readonly (keyof Pose)[];

export function makePose(): Pose {
  return {
    rootTiltX: 0, rootTiltZ: 0, stanceX: 0, stanceRotY: 0, stanceY: 0, stanceZ: 0, bodyY: 0, bodyX: 0, bodyY_rot: 0, bodyZ: 0,
    headX: 0, headY: 0, armLX: 0, armLY: 0, armLZ: 0, armRX: 0, armRY: 0, armRZ: 0, legLX: 0, legLZ: 0, legRX: 0,
    legRZ: 0, scale: 1, weaponVisible: true,
  };
}

export interface PoseInput {
  time: number;
  anim: PlayerAnim;
  /** Item in hand (M2a: may be 'grenade'). */
  weapon: HeldId;
  pitch: number;
  /** Horizontal speed m/s (render-estimated). */
  speed: number;
  /** Reference speed for full stride amplitude (balance movement.sprintSpeed). */
  sprintSpeed: number;
  /** M2a: reference speed for a full crawl cycle amplitude (walkSpeed x stances.prone.speedMultiplier). */
  crawlSpeed?: number;
  velY: number;
  /** Walk cycle phase (radians), advanced by the caller from distance travelled. */
  walkPhase: number;
  /** 1 right after a shot (or a grenade throw), decays to 0. */
  recoil: number;
  /** 1 right after taking damage, decays to 0. */
  hit: number;
  /** Seconds since death, or < 0 when alive. */
  deathTime: number;
  /** Per-player phase offset so idles do not sync. */
  seed: number;
  /** M2a: crouch weight 0..1 (see stanceBlend). */
  crouch?: number;
  /** M2a: prone weight 0..1 (applied on top of crouch). */
  prone?: number;
  /** M2a: ADS weapon pose 0..1 (local: FrameView.ads.cameraBlend; remotes: smoothed anim.ads). */
  ads?: number;
  /** M2a: side of the prone death roll (+1 / -1). */
  deathSide?: number;
  /**
   * M2b drop phase while `anim.dropping` (PlayerState.dropPhase). Absent or null while dropping = 'freefall' (the
   * pre-gate M1 drop keeps its skydive look).
   */
  dropPhase?: DropPhase | null;
  /** M2b: 0 = freefall pose, 1 = parachute hang pose (eased over the deploy time by the caller). */
  chute?: number;
  /** M2b steering in the body frame, -1..1: right (+) / left, forward (+) / back. Banks and dives the drop poses. */
  steerX?: number;
  steerZ?: number;
  /**
   * M2b: prone pitch clamp (rad) from balance movement.stances.pronePitchMinDeg / MaxDeg (the sim's pitchLimits);
   * absent = PRONE_PITCH_MIN / PRONE_PITCH_MAX.
   */
  pronePitchMin?: number;
  pronePitchMax?: number;
}

/** Seconds the topple takes and how long the body lies before the poof. */
export const DEATH_TOPPLE_S = 0.35;
export const DEATH_POOF_AT_S = 1.1;
/** Prone aim pitch clamp fallback (chest on the ground; STYLE.md §16). Balance pronePitchMin/MaxDeg wins (M2b). */
export const PRONE_PITCH_MIN = -0.25;
export const PRONE_PITCH_MAX = 0.45;
/**
 * BUG-008 (stance.md "Visual fit"): share of the aim pitch the prone head follows, looking up / down. Tilting the
 * head about the neck swings the hair top up (looking down) and the head centre back (looking up), so both are kept
 * small: looking down the head keeps its pitch-0 pose (any downward tilt raises the hair top), looking up it follows
 * 0.2 of the pitch (lowers the top; 0.3 would put the head centre at the z -0.45 edge). Hair 0, precise mesh bounds,
 * at -30 / 0 / +45 deg: top 0.673 / 0.673 / 0.675 m, head centre z -0.51 / -0.51 / -0.47 (m2b.test.ts).
 */
export const PRONE_HEAD_PITCH_UP = 0.2;
export const PRONE_HEAD_PITCH_DOWN = 0;
/** BUG-008: max head tilt (rad) from the aim while crouched. */
export const CROUCH_HEAD_TILT_MAX = 0.4;
/** Side roll for a death while prone (root tilt z, rad). */
export const PRONE_DEATH_ROLL = 1.3;

const HALF_PI = Math.PI / 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (k: number) => 1 - (1 - k) * (1 - k);
const easeInOut = (k: number) => k * k * (3 - 2 * k);
/** Portion of the stand <-> prone transition spent on the crouch stage (STYLE.md §16: k 0 -> 0.4). */
const PRONE_VIA_CROUCH = 0.4;

const CR = CHIBI_STANCES.crouch;
const PR = CHIBI_STANCES.prone;

export interface StanceBlend {
  /** 0 = standing pose, 1 = crouch pose. */
  crouch: number;
  /** 0 = (stand/crouch) pose, 1 = prone pose. Applied after crouch. */
  prone: number;
}

const STANCE_POINT: Record<Stance, [number, number]> = { stand: [0, 0], crouch: [1, 0], prone: [1, 1] };

/**
 * Pose weights for a stance transition (PlayerState.stance / stanceFrom / stanceProgress), with the STYLE.md §16
 * staging: stand <-> crouch eases out; stand -> prone goes through the crouch pose first (k 0..0.4), then lies down
 * (k 0.4..1, ease-in-out); getting up reverses it; crouch <-> prone is a single ease-in-out. Pure; writes `out`.
 */
export function stanceBlend(stance: Stance, from: Stance, progress: number, out: StanceBlend): StanceBlend {
  const k = clamp01(Number.isFinite(progress) ? progress : 1);
  const [tc, tp] = STANCE_POINT[stance] ?? STANCE_POINT.stand;
  const [fc, fp] = STANCE_POINT[from] ?? STANCE_POINT.stand;
  if (k >= 1 || stance === from) {
    out.crouch = tc;
    out.prone = tp;
    return out;
  }
  if (fp === tp) {
    // stand <-> crouch
    const e = easeOut(k);
    out.crouch = fc + (tc - fc) * e;
    out.prone = tp;
  } else if (fc === tc) {
    // crouch <-> prone
    const e = easeInOut(k);
    out.crouch = 1;
    out.prone = fp + (tp - fp) * e;
  } else if (tp > fp) {
    // stand -> prone: crouch first, then lie down
    if (k < PRONE_VIA_CROUCH) {
      out.crouch = easeInOut(k / PRONE_VIA_CROUCH);
      out.prone = 0;
    } else {
      out.crouch = 1;
      out.prone = easeInOut((k - PRONE_VIA_CROUCH) / (1 - PRONE_VIA_CROUCH));
    }
  } else {
    // prone -> stand: push up to the crouch pose, then stand
    const up = 1 - PRONE_VIA_CROUCH;
    if (k < up) {
      out.crouch = 1;
      out.prone = 1 - easeInOut(k / up);
    } else {
      out.crouch = 1 - easeInOut((k - up) / PRONE_VIA_CROUCH);
      out.prone = 0;
    }
  }
  return out;
}

const TWO_HANDED: Readonly<Record<HeldId, boolean>> = {
  fists: false, pistol: false, grenade: false, smg: true, shotgun: true, rifle: true, dmr: true, sniper: true, lmg: true,
};

/** True when the held item is carried with both hands (long guns). */
export function isTwoHanded(w: HeldId): boolean {
  return TWO_HANDED[w] ?? false;
}

const crouchTmp = makePose();
const proneTmp = makePose();

function lerpPose(out: Pose, b: Pose, w: number): void {
  if (w <= 0) return;
  if (w >= 1) {
    for (const k of POSE_KEYS) out[k] = b[k];
    out.weaponVisible = b.weaponVisible;
    return;
  }
  for (const k of POSE_KEYS) out[k] += (b[k] - out[k]) * w;
  if (w >= 0.5) out.weaponVisible = b.weaponVisible;
}

export function computePose(i: PoseInput, out: Pose): Pose {
  const c = clamp01(i.crouch ?? 0);
  const p = clamp01(i.prone ?? 0);
  if (i.deathTime >= 0 && p >= 0.5) return proneDeath(i, out);

  if (i.anim.dropping && i.deathTime < 0) return dropPose(i, out);
  standPose(i, out);
  if (i.deathTime >= 0) {
    // Topple from a crouch: the bent legs straighten as the body falls.
    const e = clamp01(i.deathTime / DEATH_TOPPLE_S);
    const cw = c * (1 - e * e);
    out.stanceY = -CR.drop * cw;
    out.legLX += CR.legSwing * cw;
    out.legRX -= CR.legSwing * cw;
    return out;
  }
  if (c > 0) lerpPose(out, crouchPose(i, out, crouchTmp), c);
  if (p > 0) lerpPose(out, pronePose(i, proneTmp), p);
  return out;
}

/** Standing pose (M1 behaviour, plus ADS and the grenade hold). */
function standPose(i: PoseInput, out: Pose): Pose {
  const t = i.time + i.seed;
  const a = i.anim;
  const grenade = i.weapon === 'grenade';
  const armed = i.weapon !== 'fists';
  const twoHanded = isTwoHanded(i.weapon);
  const pitch = i.pitch < -1.2 ? -1.2 : i.pitch > 1.2 ? 1.2 : i.pitch;
  const ads = clamp01(i.ads ?? 0);

  // Reset
  out.rootTiltX = 0;
  out.rootTiltZ = 0;
  out.stanceX = 0;
  out.stanceRotY = 0;
  out.stanceY = 0;
  out.stanceZ = 0;
  out.bodyY = 0;
  out.bodyX = 0;
  out.bodyY_rot = 0;
  out.bodyZ = 0;
  out.headX = pitch * 0.5;
  out.headY = 0;
  out.armLX = 0;
  out.armLY = 0;
  out.armLZ = -0.12;
  out.armRX = 0;
  out.armRY = 0;
  out.armRZ = 0.12;
  out.legLX = 0;
  out.legLZ = 0;
  out.legRX = 0;
  out.legRZ = 0;
  out.scale = 1;
  out.weaponVisible = armed;

  // ---- Death: topple backward, limbs flop, then the caller poofs us.
  if (i.deathTime >= 0) {
    const k = clamp01(i.deathTime / DEATH_TOPPLE_S);
    const ease = k * k;
    const settle = i.deathTime > DEATH_TOPPLE_S ? Math.sin((i.deathTime - DEATH_TOPPLE_S) * 18) * Math.exp(-(i.deathTime - DEATH_TOPPLE_S) * 8) * 0.08 : 0;
    out.rootTiltX = ease * HALF_PI * 0.96 + settle;
    out.armLZ = -1.2 * ease;
    out.armRZ = 1.2 * ease;
    out.armLX = 0.3 * ease;
    out.armRX = 0.3 * ease;
    out.legLZ = -0.25 * ease;
    out.legRZ = 0.25 * ease;
    out.headX = 0.3 * ease;
    out.scale = deathScale(i.deathTime);
    out.weaponVisible = false;
    return out;
  }

  const speedK = clamp01(i.speed / Math.max(0.1, i.sprintSpeed));
  const moving = a.moving && i.speed > 0.2;
  const swing = moving ? (a.sprinting ? 0.95 : 0.65) * Math.max(0.35, speedK) : 0;
  const s = Math.sin(i.walkPhase);
  const water = a.inWater ? 0.6 : 1;

  // ---- Locomotion base
  if (a.airborne) {
    const falling = i.velY < 0;
    out.legLX = 0.55;
    out.legRX = -0.35;
    out.armLZ = falling ? -1.1 : -0.7;
    out.armRZ = falling ? 1.1 : 0.7;
    out.armLX = 0.25;
    out.armRX = 0.25;
    out.bodyX = falling ? 0.08 : -0.1;
  } else if (moving) {
    out.legLX = s * swing * water;
    out.legRX = -s * swing * water;
    out.armLX = -s * swing * 0.8;
    out.armRX = s * swing * 0.8;
    out.bodyY = Math.abs(Math.cos(i.walkPhase)) * 0.035 * swing;
    out.bodyX = a.sprinting ? -0.16 : -0.06;
    out.bodyY_rot = s * 0.08 * swing;
  } else {
    // Idle breathing
    out.bodyY = Math.sin(t * 2.1) * 0.008;
    out.armLZ = -0.12 - Math.sin(t * 2.1) * 0.03;
    out.armRZ = 0.12 + Math.sin(t * 2.1) * 0.03;
    out.headY = Math.sin(t * 0.37) * 0.12;
  }

  // ---- Upper body actions (override arms)
  if (a.healing) {
    const bob = Math.sin(t * 7) * 0.08;
    out.armLX = 1.25 + bob;
    out.armRX = 1.25 - bob;
    out.armLZ = 0.55;
    out.armRZ = -0.55;
    out.armLY = 0;
    out.armRY = 0;
    out.headX = -0.35;
    out.weaponVisible = false;
  } else if (grenade) {
    if (a.cooking) {
      // Wind-up: throwing arm up and back, the free arm points at the target.
      out.armRX = Math.PI + 0.35;
      out.armRZ = 0.22;
      out.armLX = HALF_PI + pitch;
      out.armLZ = 0.15;
      out.bodyY_rot = 0.25;
    } else {
      out.armRX = HALF_PI * 0.8 + pitch * 0.5;
      out.armRZ = -0.05;
    }
    if (i.recoil > 0.02) {
      // Throw follow-through: the arm whips from the wind-up to forward-down; the hand is empty mid-throw.
      const k = 1 - clamp01(i.recoil);
      out.armRX = Math.PI + 0.35 - (Math.PI - 0.1) * easeOut(clamp01(k * 3));
      out.armRZ = 0.1;
      out.bodyY_rot = -0.2 * (1 - k);
      out.weaponVisible = i.recoil < 0.25;
    }
  } else if (armed) {
    if (!a.airborne || twoHanded) {
      out.armRX = HALF_PI + pitch;
      out.armRZ = -0.08;
    }
    if (twoHanded) {
      out.armLX = HALF_PI + pitch - 0.08;
      out.armLZ = 0.62;
    }
    if (a.reloading) {
      const wob = Math.sin(t * 11);
      out.armRX = HALF_PI - 0.55 + wob * 0.06;
      out.armLX = HALF_PI * 0.75 + wob * 0.18;
      out.armLZ = 0.75;
      out.headX = -0.25;
    } else if (ads > 0) {
      // ADS: gun pulled in toward the body line under the face, head drops to the sight, idle look-around stops.
      out.armRZ += -0.22 * ads;
      if (twoHanded) out.armLZ += 0.08 * ads;
      out.headX += (pitch * 0.85 - 0.1 - out.headX) * ads;
      out.headY *= 1 - ads;
    }
    // Recoil kick: arm up, upper body back.
    out.armRX += i.recoil * 0.35;
    if (twoHanded) out.armLX += i.recoil * 0.3;
    out.bodyX += i.recoil * 0.06;
  } else if (i.recoil > 0) {
    // Fist punch: quick forward jab with the right arm.
    const p = Math.sin(clamp01(i.recoil) * Math.PI);
    out.armRX = HALF_PI * (0.4 + 0.6 * p);
    out.armRZ = -0.15;
    out.bodyY_rot = -0.25 * p;
  }

  // ---- Hit react: flinch back.
  if (i.hit > 0) {
    out.bodyX += i.hit * 0.22;
    out.headX += i.hit * 0.25;
    out.bodyY -= i.hit * 0.02;
  }
  return out;
}

const FF = CHIBI_FREEFALL.freefall;
const HG = CHIBI_FREEFALL.hang;
const clampS = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? 0 : v < -1 ? -1 : v > 1 ? 1 : v);
const hangTmp = makePose();

/**
 * M2b drop poses (STYLE.md §20.3 / §20.4, CHIBI_FREEFALL): the freefall "belly flop" rotates the stance pivot about
 * the hips (root keeps world position and yaw), banks about the spine with lateral steering and dives nose-down when
 * steering forward; the parachute hang is upright with hands on the risers, a slow sway and a bank on the root. The
 * caller eases `chute` 0 -> 1 over the deploy time, which blends freefall -> hang.
 */
function dropPose(i: PoseInput, out: Pose): Pose {
  const k = i.dropPhase === 'chute' ? clamp01(i.chute ?? 1) : 0;
  freefallPose(i, out);
  if (k > 0) lerpPose(out, hangPose(i, hangTmp), easeInOut(k));
  return out;
}

function zeroPose(out: Pose): void {
  for (const k of POSE_KEYS) out[k] = 0;
  out.scale = 1;
  out.weaponVisible = false;
}

function freefallPose(i: PoseInput, out: Pose): Pose {
  zeroPose(out);
  const t = i.time + i.seed;
  const sx = clampS(i.steerX), sz = clampS(i.steerZ);
  const fl = Math.sin(t * 9) * FF.flutter;
  const pitch = FF.pitch - FF.dive * Math.max(0, sz) + 0.2 * Math.max(0, -sz);
  const off = freefallStanceOffset(pitch);
  out.stanceX = pitch;
  out.stanceY = off[1];
  out.stanceZ = off[2];
  out.stanceRotY = sx * FF.bank;
  out.headX = FF.headX;
  out.armLX = FF.armX;
  out.armRX = FF.armX;
  out.armLZ = -FF.armSpread + fl;
  out.armRZ = FF.armSpread - fl;
  out.legLX = FF.legX;
  out.legRX = FF.legX;
  out.legLZ = -FF.legSpread - fl;
  out.legRZ = FF.legSpread + fl;
  return out;
}

function hangPose(i: PoseInput, out: Pose): Pose {
  zeroPose(out);
  const t = i.time + i.seed;
  const sx = clampS(i.steerX);
  const swing = Math.sin(t * 1.7) * 0.08;
  out.rootTiltZ = Math.sin(t * HG.swayRate) * HG.sway - sx * HG.bank;
  out.bodyX = HG.bodyX;
  out.headX = HG.headX;
  out.armLX = HG.armX;
  out.armRX = HG.armX;
  out.armLZ = -HG.armOut;
  out.armRZ = HG.armOut;
  out.legLX = HG.legLX + swing;
  out.legRX = HG.legRX - swing;
  out.legLZ = -HG.legSpread;
  out.legRZ = HG.legSpread;
  return out;
}

/** Crouch ("ready lunge", STYLE.md §16) derived from the standing pose `stand`. */
function crouchPose(i: PoseInput, stand: Pose, out: Pose): Pose {
  for (const k of POSE_KEYS) out[k] = stand[k];
  out.weaponVisible = stand.weaponVisible;
  const moving = i.anim.moving && i.speed > 0.2;
  const amp = moving ? Math.max(0.35, clamp01(i.speed / Math.max(0.1, i.sprintSpeed * 0.55))) : 0;
  const s = Math.sin(i.walkPhase);
  out.stanceY = -CR.drop;
  out.legLX = CR.legSwing + s * CR.walkSwing * amp;
  out.legRX = -CR.legSwing - s * CR.walkSwing * amp;
  out.legLZ = -CR.legSplay;
  out.legRZ = CR.legSplay;
  // Lean forward; the arms (children of the body) get the lean back so the aim does not change.
  const lean = CR.bodyLean;
  out.bodyX = stand.bodyX - (moving ? (i.anim.sprinting ? -0.16 : -0.06) : 0) + lean;
  out.bodyY = moving ? Math.abs(Math.cos(i.walkPhase)) * 0.015 * amp : stand.bodyY;
  // BUG-008: the crouched head follows the aim only up to +-CROUCH_HEAD_TILT_MAX (more tilt lifts the hair top over
  // the 0.95 m crouch cylinder + 0.1).
  const ht = stand.headX;
  out.headX = (ht < -CROUCH_HEAD_TILT_MAX ? -CROUCH_HEAD_TILT_MAX : ht > CROUCH_HEAD_TILT_MAX ? CROUCH_HEAD_TILT_MAX : ht) + CR.headComp;
  out.armLX = stand.armLX - lean;
  out.armRX = stand.armRX - lean;
  return out;
}

/** Prone ("belly flop, elbows up", STYLE.md §16). Independent of the standing pose. */
function pronePose(i: PoseInput, out: Pose, still = false): Pose {
  const a = i.anim;
  const t = i.time + i.seed;
  const lo = i.pronePitchMin ?? PRONE_PITCH_MIN, hi = i.pronePitchMax ?? PRONE_PITCH_MAX;
  const pitch = i.pitch < lo ? lo : i.pitch > hi ? hi : i.pitch;
  const moving = !still && a.moving && i.speed > 0.05;
  const crawlRef = Math.max(0.1, i.crawlSpeed ?? i.sprintSpeed * 0.2);
  const amp = moving ? Math.max(0.4, clamp01(i.speed / crawlRef)) : 0;
  const s = Math.sin(i.walkPhase) * amp;

  out.rootTiltX = 0;
  out.rootTiltZ = 0;
  out.stanceX = PR.pitch;
  out.stanceRotY = 0;
  out.stanceY = PR.lift;
  out.stanceZ = PR.back;
  out.bodyY = 0;
  out.bodyX = PR.chestUp + i.recoil * 0.04 + i.hit * 0.08;
  out.bodyY_rot = s * PR.crawlRoll;
  out.bodyZ = 0;
  out.headX = PR.headUp + pitch * (pitch < 0 ? PRONE_HEAD_PITCH_DOWN : PRONE_HEAD_PITCH_UP) + i.hit * 0.1;
  out.headY = moving ? 0 : Math.sin(t * 0.37) * 0.08 * (1 - clamp01(i.ads ?? 0));
  out.legLX = PR.legLift;
  out.legRX = PR.legLift;
  out.legLZ = -PR.legSplay - s * PR.crawlSwing;
  out.legRZ = PR.legSplay - s * PR.crawlSwing;
  out.scale = 1;
  out.weaponVisible = i.weapon !== 'fists';

  // Arms forward along the sand (two-handed hold for every item), crawl alternation.
  out.armRX = Math.PI - PR.chestUp + pitch + s * PR.crawlArm + i.recoil * 0.2;
  out.armRY = 0;
  out.armRZ = 0;
  out.armLX = Math.PI - 0.27 + pitch - s * PR.crawlArm;
  out.armLY = 0;
  out.armLZ = PR.armLSplay;
  if (a.healing || a.reloading) {
    // Keep the base, swap the arm block: arms come in under the chin.
    const bob = Math.sin(t * (a.healing ? 7 : 11)) * 0.08;
    out.armRX = HALF_PI + 0.55 - bob;
    out.armLX = HALF_PI + 0.55 + bob;
    out.armRZ = -0.5;
    out.armLZ = 0.5;
    if (a.healing) out.weaponVisible = false;
  } else if (i.weapon === 'grenade' && a.cooking) {
    // Lob from the ground: throwing arm cocked up beside the head.
    out.armRX = Math.PI * 0.62;
    out.armRZ = 0.35;
  }
  return out;
}

/** Death while prone: no backward topple; roll onto the side, arms flop, then the usual poof. */
function proneDeath(i: PoseInput, out: Pose): Pose {
  pronePose(i, out, true);
  const k = clamp01(i.deathTime / DEATH_TOPPLE_S);
  const ease = easeOut(k);
  const side = (i.deathSide ?? 1) >= 0 ? 1 : -1;
  out.rootTiltZ = side * PRONE_DEATH_ROLL * ease;
  out.bodyY_rot = 0;
  out.legLZ = -PR.legSplay;
  out.legRZ = PR.legSplay;
  out.armRX += (HALF_PI + 0.3 - out.armRX) * ease;
  out.armLX += (HALF_PI + 0.1 - out.armLX) * ease;
  out.armRZ = -0.6 * ease;
  out.armLZ = PR.armLSplay + 0.5 * ease;
  out.headX = PR.headUp * (1 - 0.4 * ease);
  out.bodyX = PR.chestUp * (1 - ease);
  out.scale = deathScale(i.deathTime);
  out.weaponVisible = false;
  return out;
}

function deathScale(deathTime: number): number {
  const shrinkStart = DEATH_POOF_AT_S - 0.15;
  return deathTime > shrinkStart ? Math.max(0, 1 - (deathTime - shrinkStart) / 0.15) : 1;
}
