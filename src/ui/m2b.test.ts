import { describe, expect, it } from 'vitest';
import { hasKey } from '../content/strings';
import { ZONE_THEMES } from '../shared/balance';
import type { AdsView, HudDropView, HudZoneView } from '../shared/contracts';
import { CONTROL_IDS } from './screens';
import {
  adsReticle,
  dangerBlink,
  dropHudModel,
  fitRectProjection,
  flightCue,
  isScopeSight,
  projectXZ,
  reticleMode,
  routeEntryPoint,
  roomInPlay,
  roomInResults,
  selectScreen,
  tideStatus,
  zoneKey,
  type ScreenInputs,
} from './logic';

describe('M2b: screen selection with rooms', () => {
  const base: ScreenInputs = {
    joinRequested: true,
    connection: 'connected',
    joined: false,
    phase: 'lobby',
    resultsDismissed: false,
    rooms: { location: 'browser', roomPhase: null, localSpectating: false },
    hasLocal: false,
    spectating: false,
  };
  const inRoom = (roomPhase: 'waiting' | 'countdown' | 'playing' | 'results', p: Partial<ScreenInputs> = {}): ScreenInputs => ({
    ...base,
    rooms: { location: 'room', roomPhase, localSpectating: false },
    ...p,
  });

  it('title, connecting, browser', () => {
    expect(selectScreen({ ...base, joinRequested: false })).toBe('title');
    expect(selectScreen({ ...base, rooms: { location: 'none', roomPhase: null, localSpectating: false } })).toBe('connecting');
    expect(selectScreen(base)).toBe('browser');
    expect(selectScreen({ ...base, connection: 'disconnected' })).toBe('connectionLost');
  });

  it('waiting room through the countdown, match while playing or spectating', () => {
    expect(selectScreen(inRoom('waiting'))).toBe('room');
    expect(selectScreen(inRoom('countdown', { phase: 'countdown', hasLocal: true }))).toBe('room');
    expect(selectScreen(inRoom('playing', { phase: 'playing', hasLocal: true }))).toBe('match');
    // A room update lagging the snapshot: the World is playing, the room still says countdown.
    expect(selectScreen(inRoom('countdown', { phase: 'playing', hasLocal: true }))).toBe('match');
    // Joined mid-match: spectating the running match.
    expect(selectScreen({ ...base, phase: 'playing', rooms: { location: 'room', roomPhase: 'playing', localSpectating: true } })).toBe('match');
    // Not watching (no local, not spectating): stay in the waiting room.
    expect(selectScreen(inRoom('playing', { phase: 'playing' }))).toBe('room');
  });

  it('results, Play again back to the same room, and a stale World phase never wins', () => {
    expect(selectScreen(inRoom('results', { phase: 'results', hasLocal: true }))).toBe('results');
    expect(selectScreen(inRoom('results', { phase: 'results', hasLocal: true, resultsDismissed: true }))).toBe('room');
    expect(selectScreen(inRoom('waiting', { phase: 'results', hasLocal: true }))).toBe('room');
    expect(selectScreen(inRoom('waiting', { phase: 'playing', hasLocal: true }))).toBe('room');
    expect(roomInResults('results', 'playing')).toBe(true);
    expect(roomInResults('results', 'waiting')).toBe(false);
    expect(roomInPlay('playing', 'countdown')).toBe(true);
    expect(roomInPlay('results', 'playing')).toBe(false);
  });

  it('without rooms (before the C-gate) the legacy lobby flow still works', () => {
    expect(selectScreen({ ...base, rooms: null, joined: true })).toBe('lobby');
    expect(selectScreen({ ...base, rooms: undefined, joined: true, phase: 'playing' })).toBe('match');
  });
});

describe('M2b: zone theme strings', () => {
  it('every theme has the hud, announcer and hint keys', () => {
    for (const th of ZONE_THEMES) {
      for (const s of ['phase', 'wait', 'shrinking', 'final', 'outside']) expect(hasKey(zoneKey('hud', th, s))).toBe(true);
      for (const s of ['warning', 'rising', 'final']) expect(hasKey(zoneKey('announcer', th, s))).toBe(true);
      expect(hasKey(zoneKey('hint', th))).toBe(true);
    }
    expect(zoneKey('hud', 'sprinklers', 'wait')).toBe('hud.sprinklers.wait');
    expect(zoneKey('announcer', 'lightsOut', 'rising')).toBe('announcer.lightsOut.rising');
    expect(zoneKey('hint', undefined)).toBe('hint.tide');
  });

  it('tideStatus picks the themed keys', () => {
    const zone: HudZoneView = {
      phaseIndex: 1,
      phaseCount: 6,
      shrinking: false,
      isFinal: false,
      secondsLeft: 65,
      center: { x: 0, z: 0 },
      radius: 50,
      targetCenter: { x: 0, z: 0 },
      targetRadius: 40,
      dps: 1,
    };
    expect(tideStatus(zone, 'lightsOut')).toEqual({ key: 'hud.lightsOut.wait', vars: { time: '1:05' }, urgent: false, clock: '' });
    expect(tideStatus({ ...zone, shrinking: true }, 'sprinklers')?.key).toBe('hud.sprinklers.shrinking');
    expect(tideStatus({ ...zone, isFinal: true })?.key).toBe('hud.tide.final');
  });
});

describe('M2b: first-person reticle', () => {
  const ads = (sight: AdsView['sight'], blend: number, scoped = false): AdsView => ({
    sight,
    progress: blend,
    cameraBlend: blend,
    zoom: 1,
    scoped,
  });

  it('FP ADS never shows a Ui dot; the hip reticle fades and closes for every sight', () => {
    for (const s of ['iron', 'red_dot', 'scope_4x', 'scope_8x'] as const) {
      const r = adsReticle(ads(s, 0.5), true);
      expect(r.dot).toBeNull();
      expect(r.hip).toBe(0.5);
      expect(r.gapScale).toBe(0.5);
    }
    expect(adsReticle(ads('scope_8x', 1, true), true).scope).toBe('scope_8x');
    // 3P (cameraView absent) keeps the M2a sight dot.
    expect(adsReticle(ads('red_dot', 1)).dot).toBe('red_dot');
    expect(isScopeSight('scope_4x')).toBe(true);
    expect(isScopeSight('iron')).toBe(false);
  });

  it('modes by camera case', () => {
    const live = { cameraView: 'firstPerson' as const, alive: true, airborne: false, weapon: 'rifle', spectating: false };
    expect(reticleMode(live)).toBe('full');
    expect(reticleMode({ ...live, weapon: 'fists' })).toBe('dot');
    expect(reticleMode({ ...live, weapon: 'grenade' })).toBe('dot');
    expect(reticleMode({ ...live, airborne: true })).toBe('none');
    expect(reticleMode({ ...live, cameraView: 'orbit' })).toBe('none');
    expect(reticleMode({ ...live, alive: false, weapon: null, spectating: true })).toBe('spectate');
    expect(reticleMode({ ...live, alive: false, weapon: null, spectating: true, cameraView: 'chase' })).toBe('none');
    expect(reticleMode({ ...live, alive: false, weapon: null })).toBe('none');
  });
});

describe('M2a addendum: danger blink', () => {
  it('faster as the fuse runs out; urgent in the last second; calm without the field', () => {
    expect(dangerBlink(undefined)).toEqual({ periodMs: 420, urgent: false });
    expect(dangerBlink(3000)).toEqual({ periodMs: 420, urgent: false });
    expect(dangerBlink(1500)).toEqual({ periodMs: 220, urgent: false });
    expect(dangerBlink(1000)).toEqual({ periodMs: 110, urgent: true });
    expect(dangerBlink(-5)).toEqual({ periodMs: 110, urgent: true });
    expect(dangerBlink(Number.NaN).periodMs).toBe(420);
  });
});

describe('M2b: indoor minimap projection', () => {
  it('fits the floor rectangle by its longer side, centred, north up', () => {
    const p = fitRectProjection({ minX: -117, minZ: -72, maxX: 117, maxZ: 72 }, 200, 4);
    expect(p.scale).toBeCloseTo(192 / 234);
    expect(projectXZ(p, 0, 0)).toEqual({ px: 100, py: 100 });
    expect(projectXZ(p, -117, 0).px).toBeCloseTo(4);
    expect(projectXZ(p, 117, 0).px).toBeCloseTo(196);
    // Off-centre rectangles are centred too.
    const q = fitRectProjection({ minX: 0, minZ: 0, maxX: 100, maxZ: 50 }, 100, 0);
    expect(projectXZ(q, 50, 25)).toEqual({ px: 50, py: 50 });
    expect(projectXZ(q, 50, 0).py).toBe(25);
  });
});

describe('M2b: route entry for the waiting carrier icon', () => {
  const r = { minX: -100, minZ: -50, maxX: 100, maxZ: 50 };
  it('clips the route to the map frame', () => {
    expect(routeEntryPoint({ x: -150, z: 0 }, { x: 150, z: 0 }, r)).toEqual({ x: -100, z: 0 });
    const p = routeEntryPoint({ x: -150, z: 60 }, { x: 150, z: -40 }, r);
    expect(p?.x).toBeCloseTo(-100);
    expect(p?.z).toBeCloseTo(60 - 50 / 3);
    expect(routeEntryPoint({ x: 0, z: 0 }, { x: 10, z: 0 }, r)).toEqual({ x: 0, z: 0 });
    expect(routeEntryPoint({ x: -150, z: 80 }, { x: 150, z: 80 }, r)).toBeNull();
  });
});

describe('M2b: drop HUD', () => {
  const aboard = (noJump: number, eject: number): HudDropView => ({
    stage: 'aboard',
    noJumpSecondsLeft: noJump,
    ejectSecondsLeft: eject,
    aboardCount: 9,
    altitude: 120,
    deployHeight: 30,
    canDeploy: false,
  });

  it('aboard: dimmed jump prompt with the doors timer, then the auto-eject timer', () => {
    const shut = dropHudModel(aboard(4, 40), 0);
    expect(shut).toMatchObject({ promptKey: 'hud.carrier.jump', promptBlocked: true, aboardCount: 9, altitude: null });
    expect(shut.timer).toEqual({ key: 'hud.carrier.doorsIn', time: '0:04', urgent: false });
    const open = dropHudModel(aboard(0, 30), 0);
    expect(open.promptBlocked).toBe(false);
    expect(open.timer).toEqual({ key: 'hud.carrier.eject', time: '0:30', urgent: false });
    expect(dropHudModel(aboard(0, 5), 0).timer?.urgent).toBe(true);
  });

  it('freefall / chute: steer prompt, open-chute while possible, altitude bar with the deploy mark', () => {
    const ff: HudDropView = { ...aboard(0, 0), stage: 'freefall', altitude: 60, canDeploy: true };
    const m = dropHudModel(ff, 120);
    expect(m.promptKey).toBe('hud.drop');
    expect(m.secondKey).toBe('hud.chute.open');
    expect(m.altitude).toEqual({ ratio: 0.5, deployRatio: 0.25, metres: 60, deployMetres: 30 });
    expect(dropHudModel({ ...ff, canDeploy: false }, 120).secondKey).toBeNull();
    expect(dropHudModel({ ...ff, stage: 'chute' }, 120).secondKey).toBeNull();
    // Unknown top: the bar uses the current altitude.
    expect(dropHudModel(ff, 0).altitude?.ratio).toBe(1);
    for (const k of ['hud.carrier.jump', 'hud.carrier.doorsIn', 'hud.carrier.eject', 'hud.carrier.aboard', 'hud.drop', 'hud.chute.open', 'hud.chute.auto']) {
      expect(hasKey(k)).toBe(true);
    }
  });

  it('flight announcer cues', () => {
    expect(flightCue(aboard(1, 40), aboard(0, 39))).toBe('doorsOpen');
    expect(flightCue(aboard(0, 6), aboard(0, 5))).toBe('lastCall');
    expect(flightCue(aboard(0, 5), aboard(0, 4))).toBeNull();
    expect(flightCue(null, aboard(0, 4))).toBeNull();
    expect(flightCue(aboard(0, 5), null)).toBeNull();
  });
});

describe('M2b: controls list', () => {
  it('includes the plane jump and the spectate view key, with strings', () => {
    expect(CONTROL_IDS).toContain('jumpPlane');
    expect(CONTROL_IDS).toContain('spectateView');
    for (const id of ['jumpPlane', 'spectateView']) {
      expect(hasKey(`menu.controls.${id}.key`)).toBe(true);
      expect(hasKey(`menu.controls.${id}.label`)).toBe(true);
    }
  });
});
