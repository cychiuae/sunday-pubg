/**
 * Client feel tuning (camera, mouse, smoothing, footstep cadence, first person). Owner: game-developer.
 *
 * Presentation values, not sim rules. They come from the optional `clientFeel` section of
 * docs/design/balance.json (typed as `ClientFeelBalance` in src/shared/balance.ts, key names = `ClientTuning`).
 * Any key the designer has not set yet falls back to DEFAULT_CLIENT_TUNING below; non-finite values are ignored.
 *
 * M2b: resolve from the EFFECTIVE per-map balance (balanceForMap), so `maps.<id>.clientFeel` overrides apply
 * (e.g. the office's closer carrierCameraDistance). ClientGame re-resolves on every map change.
 * M2b first person (camera.md "Tunable values"): the FP_TUNING_KEYS below plus `fpRecoil` (per gun, visual only).
 * The obsolete M2a `adsCameraDistance` / `adsCameraShoulderOffset` are gone (there is no 3P ADS in first person).
 */
import type { Balance, FpRecoilBalance } from '../shared/balance';
import type { GunId } from '../shared/types';
import { GUN_IDS } from '../shared/types';

/** M2b: first-person number keys (same names as CLIENT_FEEL_FP_KEYS in balance.ts; tuning.test pins the set). */
export const FP_TUNING_KEYS = [
  'viewmodelFovDeg', 'fpBobWalkVertical', 'fpBobWalkLateral', 'fpBobSprintVertical', 'fpBobSprintLateral',
  'fpBobCrouchFactor', 'fpBobProneFactor', 'fpMaxCameraOffset', 'fpLandDip', 'fpLandDipMs', 'vmBobFactor',
  'vmSwayIdleDeg', 'vmSwayIdlePeriodMs', 'vmSwayLookFactor', 'vmSwayMaxDeg', 'reducedMotionViewmodelFactor',
  'adsCrosshairFadeStart', 'adsCrosshairFadeEnd', 'scopeOverlayFadeMs', 'fpAdsRecoilFactor', 'carrierCameraDistance',
] as const;
export type FpTuningKey = (typeof FP_TUNING_KEYS)[number];

/** M2b: visual recoil per gun (camera.md "Recoil"). Guns without an entry have no camera recoil. */
export type FpRecoilTuning = Readonly<Partial<Record<GunId, FpRecoilBalance>>>;

export interface ClientTuning {
  /** Base look speed; multiplied by Settings.mouseSensitivity. */
  mouseRadiansPerPixel: number;
  /** Third-person boom (M2b: only the 3P cases: V chase spectate). */
  cameraDistance: number;
  /** Metres to the right of the pivot. ARCHITECTURE §6 requires < 0.6 so the eye ray stays close to the camera ray. */
  cameraShoulderOffset: number;
  /** Vertical FOV of the 3P cases (carrier, chase, death, results, title). FP uses Settings.fovDeg. */
  cameraFovDeg: number;
  /** Title/lobby attract orbit: distance = map extent * factor. */
  orbitDistanceFactor: number;
  /** Negative = looking down at the island. Also the death and results orbit pitch. */
  orbitPitchDeg: number;
  orbitDegPerSecond: number;
  /** Reconciliation: corrections larger than this snap instead of smoothing (ARCHITECTURE §6: 3 m). */
  correctionSnapDistance: number;
  /** Reconciliation: visual offset decay time constant (ARCHITECTURE §6: about 100 ms). */
  correctionDecayMs: number;
  /** Safety cap on unacknowledged inputs kept for replay. */
  maxPendingInputs: number;
  /** Horizontal metres travelled per footstep while walking / sprinting (also one FP bob cycle). */
  footstepStrideWalk: number;
  footstepStrideSprint: number;
  /** Local horizontal speed (m/s) above which the predicted anim counts as moving. */
  animMoveSpeed: number;
  /** A remote moving further than this in one frame is a teleport (spawn, respawn), not walking. */
  maxFrameTravel: number;
  /** M2a: cosmetic camera/zoom blend-out after ADS ends (the sim exit is instant). */
  adsExitBlendMs: number;
  /** M2a: seconds of flight simulated by the grenade arc preview. */
  grenadeArcPreviewSeconds: number;
  // ---- M2b first person (camera.md) ----
  /** Fixed vertical FOV of the viewmodel pass (renderer). */
  viewmodelFovDeg: number;
  fpBobWalkVertical: number;
  fpBobWalkLateral: number;
  fpBobSprintVertical: number;
  fpBobSprintLateral: number;
  fpBobCrouchFactor: number;
  fpBobProneFactor: number;
  /** Cap on the total cosmetic camera offset (bob + landing dip), m. */
  fpMaxCameraOffset: number;
  fpLandDip: number;
  fpLandDipMs: number;
  vmBobFactor: number;
  vmSwayIdleDeg: number;
  vmSwayIdlePeriodMs: number;
  vmSwayLookFactor: number;
  vmSwayMaxDeg: number;
  /** Viewmodel bob and sway multiplier with reduced motion (ViewmodelView.motionScale). */
  reducedMotionViewmodelFactor: number;
  adsCrosshairFadeStart: number;
  adsCrosshairFadeEnd: number;
  scopeOverlayFadeMs: number;
  fpAdsRecoilFactor: number;
  /** 3P orbit distance from the carrier while aboard (CameraView view 'carrier'). */
  carrierCameraDistance: number;
  fpRecoil: FpRecoilTuning;
  /** camera.md "Camera mode per state": the death cam orbits the killer instead of the body within this range (m). */
  deathCamKillerRange: number;
}

export const DEFAULT_CLIENT_TUNING: Readonly<ClientTuning> = {
  mouseRadiansPerPixel: 0.0022,
  cameraDistance: 3.2,
  cameraShoulderOffset: 0.5,
  cameraFovDeg: 70,
  orbitDistanceFactor: 1.15,
  orbitPitchDeg: -24,
  orbitDegPerSecond: 3,
  correctionSnapDistance: 3,
  correctionDecayMs: 100,
  maxPendingInputs: 90,
  footstepStrideWalk: 1.4,
  footstepStrideSprint: 1.75,
  animMoveSpeed: 0.3,
  maxFrameTravel: 5,
  adsExitBlendMs: 120,
  grenadeArcPreviewSeconds: 2.5,
  viewmodelFovDeg: 55,
  fpBobWalkVertical: 0.02,
  fpBobWalkLateral: 0.012,
  fpBobSprintVertical: 0.035,
  fpBobSprintLateral: 0.02,
  fpBobCrouchFactor: 0.6,
  fpBobProneFactor: 0.5,
  fpMaxCameraOffset: 0.06,
  fpLandDip: 0.05,
  fpLandDipMs: 150,
  vmBobFactor: 1.5,
  vmSwayIdleDeg: 0.6,
  vmSwayIdlePeriodMs: 3000,
  vmSwayLookFactor: 1.5,
  vmSwayMaxDeg: 3,
  reducedMotionViewmodelFactor: 0.3,
  adsCrosshairFadeStart: 0.3,
  adsCrosshairFadeEnd: 0.7,
  scopeOverlayFadeMs: 80,
  fpAdsRecoilFactor: 0.5,
  carrierCameraDistance: 26,
  fpRecoil: {
    pistol: { kickBack: 0.03, kickPitchDeg: 4, rollDeg: 0.4, fovPunchDeg: 0.5, returnMs: 120 },
    smg: { kickBack: 0.015, kickPitchDeg: 1.5, rollDeg: 0.25, fovPunchDeg: 0.2, returnMs: 70 },
    shotgun: { kickBack: 0.06, kickPitchDeg: 8, rollDeg: 1, fovPunchDeg: 1.5, returnMs: 250 },
    rifle: { kickBack: 0.02, kickPitchDeg: 2, rollDeg: 0.3, fovPunchDeg: 0.3, returnMs: 90 },
    lmg: { kickBack: 0.025, kickPitchDeg: 2.5, rollDeg: 0.35, fovPunchDeg: 0.35, returnMs: 100 },
    dmr: { kickBack: 0.045, kickPitchDeg: 5, rollDeg: 0.6, fovPunchDeg: 0.8, returnMs: 180 },
    sniper: { kickBack: 0.08, kickPitchDeg: 10, rollDeg: 1.2, fovPunchDeg: 2, returnMs: 400 },
  },
  deathCamKillerRange: 30,
};

type NumberKey = Exclude<keyof ClientTuning, 'fpRecoil'>;
const NUMBER_KEYS = (Object.keys(DEFAULT_CLIENT_TUNING) as (keyof ClientTuning)[]).filter(
  (k): k is NumberKey => k !== 'fpRecoil',
);
const RECOIL_KEYS: readonly (keyof FpRecoilBalance)[] = ['kickBack', 'kickPitchDeg', 'rollDeg', 'fovPunchDeg', 'returnMs'];

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One gun's recoil entry when every key is a finite number, else null (ignored). */
function recoilEntry(v: unknown): FpRecoilBalance | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  for (const k of RECOIL_KEYS) if (!isFiniteNum(o[k])) return null;
  return { kickBack: o['kickBack'] as number, kickPitchDeg: o['kickPitchDeg'] as number, rollDeg: o['rollDeg'] as number, fovPunchDeg: o['fovPunchDeg'] as number, returnMs: o['returnMs'] as number };
}

/** Tuning keys as a loose record (balance.clientFeel before and after the C-gate, test overrides). */
type TuningSource = { readonly [K in keyof ClientTuning]?: unknown };

/** Defaults, overridden by `balance.clientFeel` (if present), then by explicit overrides (tests). */
export function resolveClientTuning(balance: Balance, overrides: Partial<ClientTuning> = {}): ClientTuning {
  const out: ClientTuning = { ...DEFAULT_CLIENT_TUNING };
  const recoil: Partial<Record<GunId, FpRecoilBalance>> = { ...DEFAULT_CLIENT_TUNING.fpRecoil };
  const apply = (src: TuningSource | undefined): void => {
    if (!src) return;
    for (const key of NUMBER_KEYS) {
      const v = src[key];
      if (isFiniteNum(v)) out[key] = v;
    }
    const r = src.fpRecoil;
    if (typeof r === 'object' && r !== null) {
      for (const gun of GUN_IDS) {
        const e = recoilEntry((r as Record<string, unknown>)[gun]);
        if (e) recoil[gun] = e;
      }
    }
  };
  apply(balance.clientFeel as TuningSource | undefined);
  apply(overrides);
  out.fpRecoil = recoil;
  return out;
}
