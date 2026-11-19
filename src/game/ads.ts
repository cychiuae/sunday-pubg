/**
 * Client ADS view (ADR 0004 §5, combat.md "Aim down sights", camera.md "ADS in first person"). Owner: game-developer.
 *
 * Built once per frame from the PREDICTED MovementState.adsMs. The same object goes to FrameView.ads, HudView.ads
 * and the camera. `progress` is the sim value (instant exit); `cameraBlend` follows it while aiming and eases out
 * over clientFeel.adsExitBlendMs after an exit, so the camera and crosshair never pop.
 *
 * M2b (ADR 0005 §9): the FOV is true magnification from the default FOV (fov.ts), and `AdsView.zoom` is the
 * look-speed divisor tan(vFovPlayer / 2) / tan(vFovCurrent / 2). `AdsBlend.fovDeg` is this frame's vertical FOV.
 * Pure apart from AdsBlend's small cosmetic state.
 */
import { effectiveWeapon, hasScopeOverlay, type Balance } from '../shared/balance';
import type { AdsView } from '../shared/contracts';
import type { HeldId, ItemLevel, M2cSightType, MovementState, ScopeId } from '../shared/types';
import { isM2cThrowableId } from '../shared/types';
import { adsBlendedFovDeg, lookZoomOf, type FovBase } from './fov';

/**
 * M2c (ADR 0007 §5): the effective ADS numbers of the item in hand (effectiveWeapon with its level and mounted scope);
 * throwables have none. The same values fill MovementInput.adsSpec so ADS prediction matches the server.
 */
export interface AdsSpec {
  sight: M2cSightType;
  adsTimeMs: number;
  adsZoom: number;
  adsMoveMultiplier: number;
  adsSpreadMultiplier: number;
}

/** Effective ADS spec of `held` at `level` with `scope` (cached per balance object and key: hot path, every frame). */
export function adsSpecOf(balance: Balance, held: HeldId, level: ItemLevel = 1, scope: ScopeId | null = null): AdsSpec {
  // Throwables have no sight: the same "no ADS" numbers as fists (balance-validated sight 'none', adsTimeMs 0).
  if (isM2cThrowableId(held)) return adsSpecOf(balance, 'fists');
  let cache = SPEC_CACHE.get(balance);
  if (!cache) {
    cache = new Map();
    SPEC_CACHE.set(balance, cache);
  }
  const key = `${held}|${level}|${scope ?? ''}`;
  let spec = cache.get(key);
  if (!spec) {
    const w = effectiveWeapon(balance, held, level, scope);
    spec = {
      sight: w.sight,
      adsTimeMs: w.adsTimeMs,
      adsZoom: w.adsZoom,
      adsMoveMultiplier: w.adsMoveMultiplier,
      adsSpreadMultiplier: w.adsSpreadMultiplier,
    };
    cache.set(key, spec);
  }
  return spec;
}
const SPEC_CACHE = new WeakMap<Balance, Map<string, AdsSpec>>();

/** Sight magnification of the item in hand (effective adsZoom; 1 for throwables). */
export function adsZoomOf(balance: Balance, held: HeldId, spec: AdsSpec | null = null): number {
  return isM2cThrowableId(held) ? 1 : (spec ?? adsSpecOf(balance, held)).adsZoom;
}

/** ADS progress 0..1 = adsMs / effective adsTimeMs (combat.md "ADS"); 0 without a sight (the sim's adsProgressOf rule). */
export function adsProgressWith(m: Pick<MovementState, 'adsMs'>, spec: AdsSpec): number {
  if (spec.sight === 'none' || !(spec.adsTimeMs > 0) || !(m.adsMs > 0)) return 0;
  return clamp01(m.adsMs / spec.adsTimeMs);
}

/** Look multiplier while aiming: lerp(1, adsSensitivity, cameraBlend) / zoom. 1 when not aiming. */
export function adsLookScale(ads: AdsView | null, adsSensitivity: number): number {
  if (!ads || ads.cameraBlend <= 0) return 1;
  const sens = Number.isFinite(adsSensitivity) && adsSensitivity > 0 ? adsSensitivity : 1;
  const zoom = ads.zoom > 0 ? ads.zoom : 1;
  return (1 + (sens - 1) * ads.cameraBlend) / zoom;
}

/** Cosmetic ADS camera blend with an eased exit. One instance per ClientGame. */
export class AdsBlend {
  private blend = 0;
  /** Blend at the moment ADS ended (the exit runs from here to 0 over adsExitBlendMs). */
  private exitFrom = 0;
  /** Spec whose zoom the blend-out uses (the one that was aimed). */
  private aimed: AdsSpec | null = null;
  private fov: number | null = null;

  reset(): void {
    this.blend = 0;
    this.exitFrom = 0;
    this.aimed = null;
    this.fov = null;
  }

  /** Vertical FOV of the last update (null after reset: use the player's FOV). */
  get fovDeg(): number | null {
    return this.fov;
  }

  /**
   * Advance by `dtMs` with this frame's sim progress and return the view.
   * `held` is the predicted item in hand, `m` the predicted movement state, `fov` the FP FOV bases (Settings).
   * M2c: `spec` = the held item's effective ADS numbers (level and mounted scope; adsSpecOf). Absent = level 1, built-in
   * sight. `scoped` follows the overlay rule (hasScopeOverlay: 2x, 4x, 8x at full ADS).
   */
  update(
    m: Pick<MovementState, 'adsMs'>,
    held: HeldId,
    balance: Balance,
    dtMs: number,
    exitBlendMs: number,
    fov: FovBase,
    spec: AdsSpec | null = null,
  ): AdsView {
    const s = spec ?? adsSpecOf(balance, held);
    const throwable = isM2cThrowableId(held);
    const sight = throwable ? 'none' : s.sight;
    const progress = throwable ? 0 : adsProgressWith(m, s);
    if (progress > 0) {
      this.blend = progress;
      this.exitFrom = progress;
      this.aimed = s;
    } else if (this.blend > 0) {
      const step = exitBlendMs > 0 ? (this.exitFrom * Math.max(0, dtMs)) / exitBlendMs : this.blend;
      this.blend = Math.max(0, this.blend - step);
      if (this.blend === 0) this.aimed = null;
    }
    const zoom = progress > 0 ? s.adsZoom : (this.aimed?.adsZoom ?? (throwable ? 1 : s.adsZoom));
    this.fov = adsBlendedFovDeg(fov, zoom, this.blend);
    return {
      sight,
      progress,
      cameraBlend: this.blend,
      zoom: lookZoomOf(fov.playerDeg, this.fov),
      scoped: hasScopeOverlay(sight) && progress >= 1,
    };
  }
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
