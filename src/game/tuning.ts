/**
 * Client feel tuning (camera, mouse, smoothing, footstep cadence). Owner: game-developer.
 *
 * Presentation values, not sim rules. They come from the optional `clientFeel` section of
 * docs/design/balance.json (typed as `ClientFeelBalance` in src/shared/balance.ts, key names = `ClientTuning`).
 * Any key the designer has not set yet falls back to DEFAULT_CLIENT_TUNING below; non-finite values are ignored.
 */
import type { Balance } from '../shared/balance';

export interface ClientTuning {
  /** Base look speed; multiplied by Settings.mouseSensitivity. */
  mouseRadiansPerPixel: number;
  /** Over-the-shoulder follow camera. */
  cameraDistance: number;
  /** Metres to the right of the pivot. ARCHITECTURE §6 requires < 0.6 so the eye ray stays close to the camera ray. */
  cameraShoulderOffset: number;
  cameraFovDeg: number;
  /** Title/lobby attract orbit: distance = map.islandRadius * factor. */
  orbitDistanceFactor: number;
  /** Negative = looking down at the island. */
  orbitPitchDeg: number;
  orbitDegPerSecond: number;
  /** Reconciliation: corrections larger than this snap instead of smoothing (ARCHITECTURE §6: 3 m). */
  correctionSnapDistance: number;
  /** Reconciliation: visual offset decay time constant (ARCHITECTURE §6: about 100 ms). */
  correctionDecayMs: number;
  /** Safety cap on unacknowledged inputs kept for replay. */
  maxPendingInputs: number;
  /** Horizontal metres travelled per footstep while walking / sprinting. */
  footstepStrideWalk: number;
  footstepStrideSprint: number;
  /** Local horizontal speed (m/s) above which the predicted anim counts as moving. */
  animMoveSpeed: number;
  /** A remote moving further than this in one frame is a teleport (spawn, respawn), not walking. */
  maxFrameTravel: number;
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
};

const TUNING_KEYS = Object.keys(DEFAULT_CLIENT_TUNING) as (keyof ClientTuning)[];

/** Defaults, overridden by `balance.clientFeel` (if present), then by explicit overrides (tests). */
export function resolveClientTuning(balance: Balance, overrides: Partial<ClientTuning> = {}): ClientTuning {
  const out: ClientTuning = { ...DEFAULT_CLIENT_TUNING };
  const apply = (src: Partial<Record<keyof ClientTuning, number>> | undefined): void => {
    if (!src) return;
    for (const key of TUNING_KEYS) {
      const v = src[key];
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    }
  };
  apply(balance.clientFeel);
  apply(overrides);
  return out;
}
