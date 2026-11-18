import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/balance';
import { DEFAULT_FP_FOV_DEG, type AdsView } from '../shared/contracts';
import { carrierPosAt } from '../shared/maps';
import { aimDirection, DEG2RAD } from '../shared/math';
import { eyePoint } from '../shared/sim/stance';
import type { DropRoute, IndoorMapData } from '../shared/types';
import { AdsBlend, adsLookScale, adsZoomOf } from './ads';
import {
  BobTracker,
  bobAmountOf,
  carrierCamera,
  chaseCamera,
  deathCamSubject,
  firstPersonCamera,
  fpCameraOffset,
  headBob,
  LandDip,
  orbitAround,
  playerEyeHeight,
  RecoilKick,
  relabel,
  stanceFieldsOf,
  titleCamera,
} from './camera';
import { adsBlendedFovDeg, adsFullFovDeg, clampFovSetting, fovBaseOf, lookZoomOf, verticalFromHorizontalDeg } from './fov';
import { makeMovement, makePlayer, TEST_MAP } from './testFixtures';
import { resolveClientTuning } from './tuning';

const T = resolveClientTuning(BALANCE);
const S = BALANCE.movement.stances;
const FEET = { x: 1, y: 2, z: 3 };
const ZERO = { x: 0, y: 0, z: 0 };

describe('FOV (camera.md "Field of view", QA 4-5)', () => {
  it('default 80 deg horizontal at 16:9 is 50.5 deg vertical; the setting clamps to 70..100', () => {
    expect(verticalFromHorizontalDeg(DEFAULT_FP_FOV_DEG)).toBeCloseTo(50.53, 1);
    expect(clampFovSetting(undefined)).toBe(DEFAULT_FP_FOV_DEG);
    expect(clampFovSetting(Number.NaN)).toBe(DEFAULT_FP_FOV_DEG);
    expect(clampFovSetting(40)).toBe(70);
    expect(clampFovSetting(130)).toBe(100);
    expect(fovBaseOf(130).playerDeg).toBeCloseTo(verticalFromHorizontalDeg(100));
  });

  it('Hor+: the vertical FOV does not depend on the window aspect (21:9 keeps it)', () => {
    // The camera only ever receives the vertical FOV; it is converted once at the 16:9 reference.
    expect(fovBaseOf(90).playerDeg).toBeCloseTo(2 * Math.atan(Math.tan((45 * Math.PI) / 180) / (16 / 9)) * (180 / Math.PI));
  });

  it('ADS is true magnification from the DEFAULT FOV: identical at slider 70 and 100 (rifle 32.8 deg)', () => {
    const z = BALANCE.weapons.rifle.adsZoom;
    const at70 = adsBlendedFovDeg(fovBaseOf(70), z, 1);
    const at100 = adsBlendedFovDeg(fovBaseOf(100), z, 1);
    expect(at70).toBeCloseTo(at100, 9);
    expect(at70).toBeCloseTo(2 * Math.atan(Math.tan(25.27 * DEG2RAD) / z) / DEG2RAD, 1);
    if (z === 1.6) expect(Math.abs(at70 - 32.8)).toBeLessThanOrEqual(0.2); // QA 5: +-0.2
    // Blend is linear from the player's own FOV.
    const b = fovBaseOf(100);
    expect(adsBlendedFovDeg(b, z, 0)).toBe(b.playerDeg);
    expect(adsBlendedFovDeg(b, z, 0.5)).toBeCloseTo((b.playerDeg + adsFullFovDeg(b.defaultDeg, z)) / 2);
  });

  it('AdsView.zoom (look divisor) = tan(vPlayer / 2) / tan(vCurrent / 2)', () => {
    expect(lookZoomOf(50, 50)).toBe(1);
    const b = fovBaseOf(DEFAULT_FP_FOV_DEG);
    // At the default FOV, full ADS zoom equals the sight magnification.
    expect(lookZoomOf(b.playerDeg, adsBlendedFovDeg(b, 4, 1))).toBeCloseTo(4, 9);
  });
});

describe('first person (camera.md, QA 1, 10)', () => {
  it('the camera sits at the eye plus the offset; forward = aimDirection(yaw, pitch); FOV punch folded in', () => {
    const m = makeMovement({ stance: 'crouch', stanceFrom: 'crouch' });
    const eye = eyePoint(FEET, m, BALANCE);
    const c = firstPersonCamera({ eye, yaw: 0.7, pitch: -0.2, fovDeg: 50, offset: ZERO, roll: 0.01, fovPunchDeg: 0.3, subjectId: 1 });
    expect(c).toMatchObject({ mode: 'follow', firstPerson: true, view: 'firstPerson', subjectId: 1, distance: 0, shoulderOffset: 0, roll: 0.01 });
    expect(c.target).toEqual(eye);
    expect(c.yaw).toBe(0.7);
    expect(c.pitch).toBe(-0.2);
    expect(c.fovDeg).toBeCloseTo(50.3);
    const d = aimDirection(c.yaw, c.pitch);
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1);
  });

  it('bob + landing dip are capped at fpMaxCameraOffset; 0 at full ADS and when disabled', () => {
    const big = { lateral: 1, vertical: 1 };
    const o = fpCameraOffset(0.3, big, 0.5, 0, true, T);
    expect(Math.hypot(o.x, o.y, o.z)).toBeCloseTo(T.fpMaxCameraOffset, 9);
    expect(fpCameraOffset(0.3, big, 0.5, 1, true, T)).toEqual(ZERO);
    expect(fpCameraOffset(0.3, big, 0.5, 0, false, T)).toEqual(ZERO);
    const half = fpCameraOffset(0.3, big, 0.5, 0.5, true, T);
    expect(Math.hypot(half.x, half.y, half.z)).toBeCloseTo(T.fpMaxCameraOffset / 2, 9);
    // Lateral runs along the camera right vector; small offsets pass uncapped.
    const lat = fpCameraOffset(0, { lateral: 0.01, vertical: 0 }, 0, 0, true, T);
    expect(lat.x).toBeCloseTo(0.01);
    expect(lat.z).toBeCloseTo(0);
    expect(fpCameraOffset(0, { lateral: 0, vertical: 0 }, 0.02, 0, true, T).y).toBeCloseTo(-0.02);
  });

  it('head bob: one vertical cycle per stride, one lateral cycle per two; sprint amplitudes; stance factors', () => {
    const quarter = headBob(Math.PI / 2, 1, false, T);
    expect(quarter.vertical).toBeCloseTo(T.fpBobWalkVertical);
    expect(headBob(Math.PI, 1, false, T).lateral).toBeCloseTo(T.fpBobWalkLateral);
    expect(headBob(Math.PI / 2, 1, true, T).vertical).toBeCloseTo(T.fpBobSprintVertical);
    expect(headBob(1, 0, true, T)).toEqual({ lateral: 0, vertical: 0 });
    const walk = BALANCE.movement.walkSpeed;
    expect(bobAmountOf(walk, 'stand', true, BALANCE, T)).toBe(1);
    expect(bobAmountOf(walk * 2, 'stand', true, BALANCE, T)).toBe(1);
    expect(bobAmountOf(walk / 2, 'stand', true, BALANCE, T)).toBeCloseTo(0.5);
    expect(bobAmountOf(walk, 'crouch', true, BALANCE, T)).toBeCloseTo(T.fpBobCrouchFactor);
    expect(bobAmountOf(walk, 'prone', true, BALANCE, T)).toBeCloseTo(T.fpBobProneFactor);
    expect(bobAmountOf(walk, 'stand', false, BALANCE, T)).toBe(0);
  });

  it('BobTracker advances 2 PI per stride, skips teleports and restarts on a new subject', () => {
    const b = new BobTracker();
    b.update(1, { x: 0, y: 0, z: 0 }, 2, 5);
    expect(b.update(1, { x: 1, y: 0, z: 0 }, 2, 5)).toBeCloseTo(Math.PI);
    expect(b.update(1, { x: 50, y: 0, z: 0 }, 2, 5)).toBeCloseTo(Math.PI);
    expect(b.update(2, { x: 51, y: 0, z: 0 }, 2, 5)).toBe(0);
  });

  it('landing dip: fpLandDip at touchdown, back to 0 over fpLandDipMs', () => {
    const d = new LandDip();
    expect(d.sample(0, T)).toBe(0);
    d.trigger(10);
    expect(d.sample(10, T)).toBeCloseTo(T.fpLandDip);
    expect(d.sample(10 + T.fpLandDipMs / 2000, T)).toBeCloseTo(T.fpLandDip / 2);
    expect(d.sample(10 + T.fpLandDipMs / 1000, T)).toBe(0);
  });

  it('recoil (QA 8): roll + FOV punch per shot, back within returnMs, stacking to 2x, off with reduced motion', () => {
    const r = new RecoilKick();
    const e = T.fpRecoil.rifle!;
    r.onShot('rifle', 1, T);
    expect(r.sample(1, T, false)).toEqual({ roll: e.rollDeg * DEG2RAD, fovPunchDeg: e.fovPunchDeg });
    expect(r.sample(1 + e.returnMs / 1000, T, false)).toEqual({ roll: 0, fovPunchDeg: 0 });
    for (let i = 0; i < 5; i++) r.onShot('rifle', 2 + i * 0.001, T);
    expect(r.sample(2.004, T, false).fovPunchDeg).toBeLessThanOrEqual(e.fovPunchDeg * RecoilKick.MAX_STACK + 1e-9);
    expect(r.sample(2.004, T, false).fovPunchDeg).toBeGreaterThan(e.fovPunchDeg * 1.5);
    expect(r.sample(2.004, T, true)).toEqual({ roll: 0, fovPunchDeg: 0 });
  });
});

describe('third-person cases', () => {
  const route: DropRoute = {
    mapId: 'test', entry: { x: -100, z: 0 }, exit: { x: 100, z: 0 }, eject: { x: 80, z: 0 },
    altitude: 120, speed: 10, startsAt: 1000, noJumpUntil: 4000, ejectAt: 19_000, endsAt: 21_000,
  };

  it('carrier: boom around carrierPosAt at the route altitude, free look, carrierCameraDistance, 3P FOV', () => {
    const c = carrierCamera(route, 11_000, 0.4, -0.3, T);
    const p = carrierPosAt(route, 11_000);
    expect(c).toMatchObject({ mode: 'follow', view: 'carrier', firstPerson: false, yaw: 0.4, pitch: -0.3, subjectId: null });
    expect(c.target).toEqual({ x: p.x, y: 120, z: p.z });
    expect(c.target.x).toBeCloseTo(0);
    expect(c.distance).toBe(T.carrierCameraDistance);
    expect(c.fovDeg).toBe(T.cameraFovDeg);
  });

  it('chase (V spectate): the 3P boom at the eye', () => {
    const c = chaseCamera(FEET, 0.3, -0.1, S.stand.eyeHeight, 7, T);
    expect(c).toMatchObject({ mode: 'follow', view: 'chase', firstPerson: false, subjectId: 7, distance: T.cameraDistance, shoulderOffset: T.cameraShoulderOffset, fovDeg: T.cameraFovDeg });
    expect(c.target).toEqual({ x: 1, y: 2 + S.stand.eyeHeight, z: 3 });
  });

  it('death and results: slow orbit around a point at orbitDegPerSecond', () => {
    const a = orbitAround('death', FEET, 0, 0, 1, T);
    const b = orbitAround('death', FEET, 0, 2, 1, T);
    expect(a).toMatchObject({ mode: 'orbit', view: 'death', firstPerson: false, distance: T.cameraDistance });
    expect(Math.abs(b.yaw - a.yaw)).toBeCloseTo(2 * T.orbitDegPerSecond * DEG2RAD);
    expect(orbitAround('results', FEET, 0, 0, 3, T).view).toBe('results');
  });

  it('death cam subject: the killer when alive within clientFeel.deathCamKillerRange (30), else the body', () => {
    const body = makePlayer(1, { alive: false, pos: { x: 0, y: 0, z: 0 } });
    const near = makePlayer(2, { pos: { x: T.deathCamKillerRange - 1, y: 0, z: 0 } });
    expect(deathCamSubject(body, near, T).id).toBe(2);
    expect(deathCamSubject(body, { ...near, pos: { x: T.deathCamKillerRange + 1, y: 0, z: 0 } }, T).id).toBe(1);
    expect(deathCamSubject(body, { ...near, alive: false }, T).id).toBe(1);
    expect(deathCamSubject(body, null, T).id).toBe(1);
  });

  it('title orbit: island centre at baseHeight; indoor at the floor with the map extent', () => {
    const c = titleCamera(TEST_MAP, 1, T);
    expect(c).toMatchObject({ mode: 'orbit', view: 'title', firstPerson: false });
    expect(c.target.y).toBe(TEST_MAP.baseHeight);
    expect(c.distance).toBeCloseTo(TEST_MAP.islandRadius * T.orbitDistanceFactor);
    const indoor = { kind: 'indoor', floor: { minX: -30, minZ: -40, maxX: 30, maxZ: 40 } } as unknown as IndoorMapData;
    const i = titleCamera(indoor, 1, T);
    expect(i.target.y).toBe(0);
    expect(i.distance).toBeCloseTo(50 * T.orbitDistanceFactor);
  });

  it('relabel keeps the pose (results with no winner: the last camera frozen)', () => {
    const c = firstPersonCamera({ eye: FEET, yaw: 1, pitch: 0, fovDeg: 50, offset: ZERO, roll: 0, fovPunchDeg: 0, subjectId: 1 });
    expect(relabel(c, 'results')).toEqual({ ...c, view: 'results' });
  });
});

describe('stance eye height', () => {
  it('settled stances use their eyeHeight; transitions lerp by progress (stance.md test 13)', () => {
    expect(playerEyeHeight(makePlayer(1, { stance: 'crouch', stanceFrom: 'crouch', stanceProgress: 1 }), BALANCE)).toBeCloseTo(S.crouch.eyeHeight);
    expect(playerEyeHeight(makePlayer(1, { stance: 'prone', stanceFrom: 'prone', stanceProgress: 1 }), BALANCE)).toBeCloseTo(S.prone.eyeHeight);
    const half = playerEyeHeight(makePlayer(1, { stance: 'prone', stanceFrom: 'stand', stanceProgress: 0.5 }), BALANCE);
    expect(half).toBeCloseTo(S.stand.eyeHeight + (S.prone.eyeHeight - S.stand.eyeHeight) * 0.5);
    const start = playerEyeHeight(makePlayer(1, { stance: 'crouch', stanceFrom: 'stand', stanceProgress: 0 }), BALANCE);
    expect(start).toBeCloseTo(S.stand.eyeHeight);
  });

  it('stanceFieldsOf rebuilds the remaining transition ms', () => {
    expect(stanceFieldsOf('prone', 'stand', 0.25, BALANCE)).toEqual({ stance: 'prone', stanceFrom: 'stand', stanceMs: 0.75 * S.transitionMs.stand_prone });
    expect(stanceFieldsOf('crouch', 'crouch', 0.3, BALANCE).stanceMs).toBe(0);
  });
});

describe('AdsBlend', () => {
  const rifleT = BALANCE.weapons.rifle.adsTimeMs;
  const F = fovBaseOf(90);
  const fovAt = (w: 'rifle', t: number): number => adsBlendedFovDeg(F, adsZoomOf(BALANCE, w), t);

  it('progress = adsMs / adsTimeMs; cameraBlend follows it; FOV and the look divisor follow the blend', () => {
    const blend = new AdsBlend();
    const half = blend.update(makeMovement({ adsMs: rifleT / 2 }), 'rifle', BALANCE, 16, T.adsExitBlendMs, F);
    expect(half).toMatchObject({ sight: 'red_dot', progress: 0.5, cameraBlend: 0.5, scoped: false });
    expect(blend.fovDeg).toBeCloseTo(fovAt('rifle', 0.5));
    expect(half.zoom).toBeCloseTo(lookZoomOf(F.playerDeg, fovAt('rifle', 0.5)));
    const full = blend.update(makeMovement({ adsMs: rifleT }), 'rifle', BALANCE, 16, T.adsExitBlendMs, F);
    expect(full.progress).toBe(1);
    expect(blend.fovDeg).toBeCloseTo(adsFullFovDeg(F.defaultDeg, BALANCE.weapons.rifle.adsZoom));
  });

  it('exit is instant for progress but cameraBlend/FOV ease out over adsExitBlendMs', () => {
    const blend = new AdsBlend();
    blend.update(makeMovement({ adsMs: rifleT }), 'rifle', BALANCE, 16, 120, F);
    const a = blend.update(makeMovement({ adsMs: 0 }), 'rifle', BALANCE, 60, 120, F);
    expect(a.progress).toBe(0);
    expect(a.cameraBlend).toBeCloseTo(0.5);
    expect(blend.fovDeg).toBeCloseTo(fovAt('rifle', 0.5));
    // Swapping to fists mid blend-out keeps the aimed weapon's zoom curve.
    const b = blend.update(makeMovement({ adsMs: 0 }), 'fists', BALANCE, 30, 120, F);
    expect(b.cameraBlend).toBeCloseTo(0.25);
    expect(b.sight).toBe('none');
    expect(blend.fovDeg).toBeCloseTo(fovAt('rifle', 0.25));
    const c = blend.update(makeMovement({ adsMs: 0 }), 'fists', BALANCE, 100, 120, F);
    expect(c.cameraBlend).toBe(0);
    expect(c.zoom).toBe(1);
    expect(blend.fovDeg).toBe(F.playerDeg);
  });

  it('scope sights are scoped only at full progress', () => {
    const blend = new AdsBlend();
    const dmrT = BALANCE.weapons.dmr.adsTimeMs;
    expect(blend.update(makeMovement({ adsMs: dmrT * 0.9 }), 'dmr', BALANCE, 16, 120, F).scoped).toBe(false);
    expect(blend.update(makeMovement({ adsMs: dmrT }), 'dmr', BALANCE, 16, 120, F)).toMatchObject({ sight: 'scope_4x', scoped: true });
    expect(blend.update(makeMovement({ adsMs: 0 }), 'dmr', BALANCE, 16, 120, F).scoped).toBe(false);
  });

  it('the grenade never aims', () => {
    const v = new AdsBlend().update(makeMovement({ adsMs: 500 }), 'grenade', BALANCE, 16, 120, F);
    expect(v).toEqual({ sight: 'none', progress: 0, cameraBlend: 0, zoom: 1, scoped: false });
  });
});

describe('adsLookScale (ADS sensitivity)', () => {
  it('1 when not aiming; 1 / zoom x adsSensitivity at full ADS; lerped sensitivity while blending', () => {
    expect(adsLookScale(null, 2)).toBe(1);
    const full: AdsView = { sight: 'scope_8x', progress: 1, cameraBlend: 1, zoom: 8, scoped: true };
    expect(adsLookScale(full, 1)).toBeCloseTo(1 / 8);
    expect(adsLookScale(full, 2)).toBeCloseTo(2 / 8);
    const half: AdsView = { sight: 'red_dot', progress: 0.5, cameraBlend: 0.5, zoom: 1.3, scoped: false };
    expect(adsLookScale(half, 3)).toBeCloseTo(2 / 1.3);
    expect(adsLookScale({ ...half, cameraBlend: 0 }, 3)).toBe(1);
    expect(adsLookScale(full, Number.NaN)).toBeCloseTo(1 / 8);
  });
});
