/**
 * Procedural chibi animation: anim flags + speed + timers -> joint angles. Pure (no three.js), allocation-free,
 * unit-testable. Owner: graphics-engineer.
 *
 * Rig conventions (src/render/procedural/chibi.ts): character faces -Z; limbs hang along -Y; rotation.x > 0 swings
 * a limb forward (PI/2 = pointing straight ahead); rotation.z > 0 swings a hanging limb toward +X. Head/body
 * rotation.x > 0 tilts the face up / leans back.
 */
import type { PlayerAnim, WeaponId } from '../shared/types';

export interface Pose {
  /** Root tilt about X (topple / skydive), applied after yaw. */
  rootTiltX: number;
  rootTiltZ: number;
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

export function makePose(): Pose {
  return {
    rootTiltX: 0, rootTiltZ: 0, bodyY: 0, bodyX: 0, bodyY_rot: 0, bodyZ: 0, headX: 0, headY: 0,
    armLX: 0, armLY: 0, armLZ: 0, armRX: 0, armRY: 0, armRZ: 0, legLX: 0, legLZ: 0, legRX: 0, legRZ: 0,
    scale: 1, weaponVisible: true,
  };
}

export interface PoseInput {
  time: number;
  anim: PlayerAnim;
  weapon: WeaponId;
  pitch: number;
  /** Horizontal speed m/s (render-estimated). */
  speed: number;
  /** Reference speed for full stride amplitude (balance movement.sprintSpeed). */
  sprintSpeed: number;
  velY: number;
  /** Walk cycle phase (radians), advanced by the caller from distance travelled. */
  walkPhase: number;
  /** 1 right after a shot, decays to 0. */
  recoil: number;
  /** 1 right after taking damage, decays to 0. */
  hit: number;
  /** Seconds since death, or < 0 when alive. */
  deathTime: number;
  /** Per-player phase offset so idles do not sync. */
  seed: number;
}

/** Seconds the topple takes and how long the body lies before the poof. */
export const DEATH_TOPPLE_S = 0.35;
export const DEATH_POOF_AT_S = 1.1;

const HALF_PI = Math.PI / 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function computePose(i: PoseInput, out: Pose): Pose {
  const t = i.time + i.seed;
  const a = i.anim;
  const armed = i.weapon !== 'fists';
  const twoHanded = i.weapon === 'smg' || i.weapon === 'shotgun' || i.weapon === 'rifle';
  const pitch = i.pitch < -1.2 ? -1.2 : i.pitch > 1.2 ? 1.2 : i.pitch;

  // Reset
  out.rootTiltX = 0;
  out.rootTiltZ = 0;
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
    const shrinkStart = DEATH_POOF_AT_S - 0.15;
    if (i.deathTime > shrinkStart) out.scale = Math.max(0, 1 - (i.deathTime - shrinkStart) / 0.15);
    out.weaponVisible = false;
    return out;
  }

  // ---- Drop (skydive): tilt face-down, arms and legs spread, flutter.
  if (a.dropping) {
    const fl = Math.sin(t * 9) * 0.08;
    out.rootTiltX = -1.05;
    out.headX = 0.7;
    out.armLX = 0.35;
    out.armRX = 0.35;
    out.armLZ = -1.35 + fl;
    out.armRZ = 1.35 - fl;
    out.legLZ = -0.3 - fl;
    out.legRZ = 0.3 + fl;
    out.legLX = -0.25;
    out.legRX = -0.25;
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
