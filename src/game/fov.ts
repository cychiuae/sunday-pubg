/**
 * First-person field of view math (camera.md "Field of view" and "ADS in first person", ADR 0005 §9). Pure.
 *
 * - Settings.fovDeg is a HORIZONTAL FOV at the 16:9 reference (FP_FOV_REFERENCE_ASPECT). It is converted once to a
 *   vertical FOV that the camera keeps for every window shape (Hor+): vFov = 2 atan(tan(hFov / 2) / refAspect).
 * - ADS is true magnification relative to the DEFAULT FOV (so the slider gives no ADS advantage):
 *   vFovAds = 2 atan(tan(vFovDefault / 2) / adsZoom). The current FOV blends linearly from the player's own vFov to
 *   vFovAds by cameraBlend.
 * - AdsView.zoom = tan(vFovPlayer / 2) / tan(vFovCurrent / 2): the look-speed divisor that keeps screen-space speed
 *   constant while zooming.
 */
import { DEFAULT_FP_FOV_DEG, FP_FOV_MAX_DEG, FP_FOV_MIN_DEG, FP_FOV_REFERENCE_ASPECT } from '../shared/contracts';
import { DEG2RAD, RAD2DEG } from '../shared/math';

/** Vertical FOV (deg) of a horizontal FOV (deg) at `aspect` (width / height). */
export function verticalFromHorizontalDeg(hDeg: number, aspect = FP_FOV_REFERENCE_ASPECT): number {
  return 2 * Math.atan(Math.tan((hDeg * DEG2RAD) / 2) / aspect) * RAD2DEG;
}

/** Settings.fovDeg clamped to FP_FOV_MIN_DEG..FP_FOV_MAX_DEG (absent or non-finite = DEFAULT_FP_FOV_DEG). */
export function clampFovSetting(fovDeg: number | undefined): number {
  if (typeof fovDeg !== 'number' || !Number.isFinite(fovDeg)) return DEFAULT_FP_FOV_DEG;
  return Math.min(FP_FOV_MAX_DEG, Math.max(FP_FOV_MIN_DEG, fovDeg));
}

/** The vertical FOV bases of the first-person camera. */
export interface FovBase {
  /** The player's own vertical FOV (from Settings.fovDeg). */
  playerDeg: number;
  /** The vertical FOV of DEFAULT_FP_FOV_DEG (the ADS magnification reference). */
  defaultDeg: number;
}

export function fovBaseOf(settingsFovDeg: number | undefined): FovBase {
  return {
    playerDeg: verticalFromHorizontalDeg(clampFovSetting(settingsFovDeg)),
    defaultDeg: verticalFromHorizontalDeg(DEFAULT_FP_FOV_DEG),
  };
}

/** Full-ADS vertical FOV for a sight magnification `adsZoom` (true magnification from the default FOV). */
export function adsFullFovDeg(defaultDeg: number, adsZoom: number): number {
  const z = Number.isFinite(adsZoom) && adsZoom > 0 ? adsZoom : 1;
  return 2 * Math.atan(Math.tan((defaultDeg * DEG2RAD) / 2) / z) * RAD2DEG;
}

/** Current vertical FOV: the player's FOV blended to the full-ADS FOV by cameraBlend (0..1). */
export function adsBlendedFovDeg(base: FovBase, adsZoom: number, blend: number): number {
  const t = blend > 0 ? (blend < 1 ? blend : 1) : 0;
  if (t === 0) return base.playerDeg;
  return base.playerDeg + (adsFullFovDeg(base.defaultDeg, adsZoom) - base.playerDeg) * t;
}

/** Look-speed divisor: tan(vFovPlayer / 2) / tan(vFovCurrent / 2). 1 when not zoomed. */
export function lookZoomOf(playerDeg: number, currentDeg: number): number {
  if (!(currentDeg > 0) || currentDeg === playerDeg) return 1;
  return Math.tan((playerDeg * DEG2RAD) / 2) / Math.tan((currentDeg * DEG2RAD) / 2);
}
