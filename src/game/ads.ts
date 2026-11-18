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
import { isScopeSight, sightOf, type Balance } from '../shared/balance';
import type { AdsView } from '../shared/contracts';
import { adsProgressOf } from '../shared/sim/combat';
import type { HeldId, MovementState, WeaponId } from '../shared/types';
import { adsBlendedFovDeg, lookZoomOf, type FovBase } from './fov';

/** Sight magnification of the item in hand (weapons.<id>.adsZoom; 1 for the grenade). */
export function adsZoomOf(balance: Balance, held: HeldId): number {
  return held === 'grenade' ? 1 : balance.weapons[held].adsZoom;
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
  /** Weapon whose zoom the blend-out uses (the one that was aimed). */
  private weapon: WeaponId | null = null;
  private fov: number | null = null;

  reset(): void {
    this.blend = 0;
    this.exitFrom = 0;
    this.weapon = null;
    this.fov = null;
  }

  /** Vertical FOV of the last update (null after reset: use the player's FOV). */
  get fovDeg(): number | null {
    return this.fov;
  }

  /**
   * Advance by `dtMs` with this frame's sim progress and return the view.
   * `held` is the predicted item in hand, `m` the predicted movement state, `fov` the FP FOV bases (Settings).
   */
  update(m: Pick<MovementState, 'adsMs'>, held: HeldId, balance: Balance, dtMs: number, exitBlendMs: number, fov: FovBase): AdsView {
    const sight = sightOf(balance, held);
    const progress = held === 'grenade' ? 0 : clamp01(adsProgressOf(m, held, balance));
    if (progress > 0 && held !== 'grenade') {
      this.blend = progress;
      this.exitFrom = progress;
      this.weapon = held;
    } else if (this.blend > 0) {
      const step = exitBlendMs > 0 ? (this.exitFrom * Math.max(0, dtMs)) / exitBlendMs : this.blend;
      this.blend = Math.max(0, this.blend - step);
      if (this.blend === 0) this.weapon = null;
    }
    const zoomWeapon: HeldId = progress > 0 ? held : (this.weapon ?? held);
    this.fov = adsBlendedFovDeg(fov, adsZoomOf(balance, zoomWeapon), this.blend);
    return {
      sight,
      progress,
      cameraBlend: this.blend,
      zoom: lookZoomOf(fov.playerDeg, this.fov),
      scoped: isScopeSight(sight) && progress >= 1,
    };
  }
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
