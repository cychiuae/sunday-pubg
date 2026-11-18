/**
 * Camera pose for FrameView (contracts.ts CameraView), one builder per CameraCase (camera.md "Camera mode per state",
 * ADR 0005 §9). ClientGame decides what to look at and from where; the renderer applies it (it adds boom collision
 * and wall fade only in the 3P cases).
 *
 * - 'firstPerson' (on foot, freefall, chute, FP spectate): the camera is exactly at the sim eye (`eyePoint`) plus the
 *   cosmetic offsets (head bob, landing dip) whose total length is capped at clientFeel.fpMaxCameraOffset and scaled by
 *   (1 - ADS cameraBlend), so it is 0 at full ADS. Rotation = look yaw and pitch exactly: recoil is a roll about the
 *   view axis plus an FOV punch, so the screen centre always stays on the shot ray.
 * - 'carrier': 3P boom around the carrier (carrierPosAt), free mouse look, distance clientFeel.carrierCameraDistance.
 * - 'chase' (V spectate): the M1 over-the-shoulder boom.
 * - 'death', 'results', 'title': slow orbits (around the body or the killer, the winner, the map centre).
 * Vertical FOVs: FP from Settings.fovDeg (Hor+, fov.ts); 3P cases use clientFeel.cameraFovDeg.
 */
import type { Balance } from '../shared/balance';
import type { CameraCase, CameraView } from '../shared/contracts';
import { isIndoor, carrierPosAt, mapExtent } from '../shared/maps';
import { DEG2RAD, rightFromYaw, wrapAngle } from '../shared/math';
import { eyeHeightOf } from '../shared/sim/stance';
import type { AnyMapData, DropRoute, GunId, PlayerId, PlayerState, Stance, Vec3 } from '../shared/types';
import { stanceTransitionKey } from '../shared/types';
import type { ClientTuning } from './tuning';

// ---------------------------------------------------------------------------------------------
// First person
// ---------------------------------------------------------------------------------------------

export interface FirstPersonArgs {
  /** The sim eye point (feet + stance eye height, lerped in transitions). */
  eye: Vec3;
  yaw: number;
  pitch: number;
  /** Vertical FOV after ADS (fov.ts adsBlendedFovDeg). */
  fovDeg: number;
  /** Cosmetic offset (fpCameraOffset): already capped and ADS-scaled. */
  offset: Vec3;
  /** Recoil sample (RecoilKick): roll radians and FOV punch degrees. */
  roll: number;
  fovPunchDeg: number;
  subjectId: PlayerId | null;
}

export function firstPersonCamera(a: FirstPersonArgs): CameraView {
  return {
    mode: 'follow',
    target: { x: a.eye.x + a.offset.x, y: a.eye.y + a.offset.y, z: a.eye.z + a.offset.z },
    yaw: a.yaw,
    pitch: a.pitch,
    distance: 0,
    shoulderOffset: 0,
    fovDeg: a.fovDeg + a.fovPunchDeg,
    firstPerson: true,
    view: 'firstPerson',
    subjectId: a.subjectId,
    roll: a.roll,
  };
}

/** Head bob components in the view frame (m): `lateral` along the camera right, `vertical` along +Y. */
export interface BobOffset {
  lateral: number;
  vertical: number;
}
const NO_BOB: BobOffset = { lateral: 0, vertical: 0 };

/** Stance multiplier of the bob amplitude (fpBobCrouchFactor / fpBobProneFactor). */
export function bobStanceFactor(stance: Stance, t: ClientTuning): number {
  return stance === 'crouch' ? t.fpBobCrouchFactor : stance === 'prone' ? t.fpBobProneFactor : 1;
}

/**
 * Bob amount 0..1 before ADS: speed relative to the stance's walk speed (capped at 1), times the stance factor;
 * 0 when not on the ground (airborne, dropping).
 */
export function bobAmountOf(horizontalSpeed: number, stance: Stance, onGround: boolean, balance: Balance, t: ClientTuning): number {
  if (!onGround) return 0;
  const walk = balance.movement.walkSpeed * balance.movement.stances[stance].speedMultiplier;
  const speed = walk > 0 ? Math.min(1, Math.max(0, horizontalSpeed / walk)) : 0;
  return speed * bobStanceFactor(stance, t);
}

/**
 * Head bob (camera.md "Head bob"): one vertical cycle per footstep (`phase` advances 2 PI per stride), one lateral
 * cycle per two steps. Amplitudes are the walk or sprint keys times `amount` (bobAmountOf).
 */
export function headBob(phase: number, amount: number, sprinting: boolean, t: ClientTuning): BobOffset {
  if (!(amount > 0)) return NO_BOB;
  const v = sprinting ? t.fpBobSprintVertical : t.fpBobWalkVertical;
  const l = sprinting ? t.fpBobSprintLateral : t.fpBobWalkLateral;
  return { lateral: l * amount * Math.sin(phase / 2), vertical: v * amount * Math.sin(phase) };
}

/**
 * Total cosmetic FP camera offset: bob plus the landing dip (down), capped at fpMaxCameraOffset, then x (1 - adsBlend).
 * Zero when `enabled` is false (Settings.headBob off or reduced motion).
 */
export function fpCameraOffset(yaw: number, bob: BobOffset, dip: number, adsBlend: number, enabled: boolean, t: ClientTuning): Vec3 {
  if (!enabled) return { x: 0, y: 0, z: 0 };
  const r = rightFromYaw(yaw);
  let x = r.x * bob.lateral;
  let y = bob.vertical - dip;
  let z = r.z * bob.lateral;
  const len = Math.hypot(x, y, z);
  const cap = Math.max(0, t.fpMaxCameraOffset);
  const k = (len > cap && len > 0 ? cap / len : 1) * (1 - Math.min(1, Math.max(0, adsBlend)));
  x *= k;
  y *= k;
  z *= k;
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y, z: z === 0 ? 0 : z };
}

/** Bob phase per followed player: advances 2 PI per footstep stride of horizontal travel; teleports are skipped. */
export class BobTracker {
  private subject: PlayerId | null = null;
  private last: { x: number; z: number } | null = null;
  private value = 0;

  get phase(): number {
    return this.value;
  }

  reset(): void {
    this.subject = null;
    this.last = null;
    this.value = 0;
  }

  update(subject: PlayerId, pos: Vec3, stride: number, maxFrameTravel: number): number {
    if (subject !== this.subject) {
      this.subject = subject;
      this.last = null;
      this.value = 0;
    }
    if (this.last) {
      const d = Math.hypot(pos.x - this.last.x, pos.z - this.last.z);
      if (d <= maxFrameTravel && stride > 0) this.value = (this.value + (2 * Math.PI * d) / stride) % (4 * Math.PI);
    }
    this.last = { x: pos.x, z: pos.z };
    return this.value;
  }
}

/** Landing dip (camera.md): fpLandDip metres down at touchdown, back to 0 over fpLandDipMs. `time` in seconds. */
export class LandDip {
  private at: number | null = null;

  trigger(time: number): void {
    this.at = time;
  }

  reset(): void {
    this.at = null;
  }

  sample(time: number, t: ClientTuning): number {
    if (this.at === null || !(t.fpLandDipMs > 0)) return 0;
    const k = 1 - ((time - this.at) * 1000) / t.fpLandDipMs;
    if (k <= 0) {
      this.at = null;
      return 0;
    }
    return t.fpLandDip * Math.min(1, k);
  }
}

/** Camera recoil now: roll (radians) and FOV punch (degrees). */
export interface RecoilSample {
  roll: number;
  fovPunchDeg: number;
}
const NO_RECOIL: RecoilSample = { roll: 0, fovPunchDeg: 0 };

/**
 * Visual recoil of the camera (camera.md "Recoil: visual only"): each shot adds one kick of clientFeel.fpRecoil[gun]
 * (roll and FOV punch), stacking up to 2x for automatic fire, decaying linearly to 0 over returnMs. Never pitch or yaw.
 * `time` in seconds.
 */
export class RecoilKick {
  /** Stacked kicks at `at` (1 = one single kick). */
  private level = 0;
  private at = 0;
  private gun: GunId | null = null;

  /** Max stacked kicks (camera.md "Automatic fire stacks kicks up to 2x the single kick"). */
  static readonly MAX_STACK = 2;

  reset(): void {
    this.level = 0;
    this.gun = null;
  }

  onShot(gun: GunId, time: number, t: ClientTuning): void {
    const now = this.current(time, t);
    this.gun = gun;
    this.at = time;
    this.level = Math.min(RecoilKick.MAX_STACK, now + 1);
  }

  sample(time: number, t: ClientTuning, reducedMotion: boolean): RecoilSample {
    const k = this.current(time, t);
    const e = this.gun ? t.fpRecoil[this.gun] : undefined;
    if (reducedMotion || k <= 0 || !e) return NO_RECOIL;
    return { roll: e.rollDeg * DEG2RAD * k, fovPunchDeg: e.fovPunchDeg * k };
  }

  /** Stacked kicks remaining at `time`. */
  private current(time: number, t: ClientTuning): number {
    const e = this.gun ? t.fpRecoil[this.gun] : undefined;
    if (!e || this.level <= 0) return 0;
    const f = e.returnMs > 0 ? 1 - ((time - this.at) * 1000) / e.returnMs : 0;
    return f > 0 ? this.level * Math.min(1, f) : 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Third-person cases
// ---------------------------------------------------------------------------------------------

/** 'carrier': boom around the carrier (aboard), free mouse look. `now` = server ms. */
export function carrierCamera(route: DropRoute, now: number, yaw: number, pitch: number, t: ClientTuning): CameraView {
  const p = carrierPosAt(route, now);
  return {
    mode: 'follow',
    target: { x: p.x, y: route.altitude, z: p.z },
    yaw,
    pitch,
    distance: t.carrierCameraDistance,
    shoulderOffset: 0,
    fovDeg: t.cameraFovDeg,
    firstPerson: false,
    view: 'carrier',
    subjectId: null,
    roll: 0,
  };
}

/** 'chase' (V spectate): the M1 over-the-shoulder boom at the followed player's eye. */
export function chaseCamera(feet: Vec3, yaw: number, pitch: number, eyeHeight: number, subjectId: PlayerId, t: ClientTuning): CameraView {
  return {
    mode: 'follow',
    target: { x: feet.x, y: feet.y + eyeHeight, z: feet.z },
    yaw,
    pitch,
    distance: t.cameraDistance,
    shoulderOffset: t.cameraShoulderOffset,
    fovDeg: t.cameraFovDeg,
    firstPerson: false,
    view: 'chase',
    subjectId,
    roll: 0,
  };
}

/**
 * A slow orbit around a point (death cam, results): starts at `startYaw`, turns orbitDegPerSecond, pitched
 * orbitPitchDeg, at the 3P boom distance. `elapsed` in seconds.
 */
export function orbitAround(
  view: Extract<CameraCase, 'death' | 'results'>,
  center: Vec3,
  startYaw: number,
  elapsed: number,
  subjectId: PlayerId | null,
  t: ClientTuning,
): CameraView {
  return {
    mode: 'orbit',
    target: { ...center },
    yaw: wrapAngle(startYaw + elapsed * t.orbitDegPerSecond * DEG2RAD),
    pitch: t.orbitPitchDeg * DEG2RAD,
    distance: t.cameraDistance,
    shoulderOffset: 0,
    fovDeg: t.cameraFovDeg,
    firstPerson: false,
    view,
    subjectId,
    roll: 0,
  };
}

/**
 * The death cam subject: the killer when alive and within clientFeel.deathCamKillerRange of the body, else the body.
 */
export function deathCamSubject(body: PlayerState, killer: PlayerState | null, t: ClientTuning): PlayerState {
  if (killer && killer.alive && Math.hypot(killer.pos.x - body.pos.x, killer.pos.z - body.pos.z) <= t.deathCamKillerRange) {
    return killer;
  }
  return body;
}

/** 'title': slow attract orbit around the map centre (title, browser, waiting room, nothing to watch). */
export function titleCamera(map: AnyMapData, timeSeconds: number, t: ClientTuning): CameraView {
  const indoor = isIndoor(map);
  return {
    mode: 'orbit',
    target: { x: 0, y: indoor ? 0 : map.baseHeight, z: 0 },
    yaw: wrapAngle(timeSeconds * t.orbitDegPerSecond * DEG2RAD),
    pitch: t.orbitPitchDeg * DEG2RAD,
    distance: (indoor ? mapExtent(map) : map.islandRadius) * t.orbitDistanceFactor,
    shoulderOffset: 0,
    fovDeg: t.cameraFovDeg,
    firstPerson: false,
    view: 'title',
    subjectId: null,
    roll: 0,
  };
}

/** The same pose relabelled (results with no winner to orbit: the last camera frozen behind the panel). */
export function relabel(cam: CameraView, view: CameraCase): CameraView {
  return { ...cam, target: { ...cam.target }, view };
}

// ---------------------------------------------------------------------------------------------
// Eye height of snapshot players
// ---------------------------------------------------------------------------------------------

/**
 * Eye height of a snapshot/interpolated player (spectate target, own body on the death screen). Rebuilds the
 * remaining transition ms from `stanceProgress` and uses the sim's eyeHeightOf, so there is one formula.
 */
export function playerEyeHeight(
  p: Pick<PlayerState, 'stance' | 'stanceFrom' | 'stanceProgress'>,
  balance: Balance,
): number {
  return eyeHeightOf(stanceFieldsOf(p.stance, p.stanceFrom, p.stanceProgress, balance), balance);
}

/** MovementState stance fields from (stance, stanceFrom, progress). */
export function stanceFieldsOf(
  stance: Stance,
  stanceFrom: Stance,
  progress: number,
  balance: Balance,
): { stance: Stance; stanceFrom: Stance; stanceMs: number } {
  if (stance === stanceFrom || !(progress < 1)) return { stance, stanceFrom, stanceMs: 0 };
  const total = balance.movement.stances.transitionMs[stanceTransitionKey(stanceFrom, stance)];
  const p = progress > 0 ? progress : 0;
  return { stance, stanceFrom, stanceMs: (1 - p) * total };
}
