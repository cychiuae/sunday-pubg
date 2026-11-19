import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/balance';
import { SIM_DT } from '../shared/constants';
import { actionsFromSnapshot, stepActions, type PredictedActions } from './actionPrediction';
import { input as simInput } from '../shared/sim/testkit';
import { buildViewmodel, localVmAction, LookRate, remoteVmAction, ShotCounter, SpectateAdsClock } from './viewmodel';
import { makeAmmo, makeLocal, makeMovement, makePlayer } from './testFixtures';

const B = BALANCE;
const M = makeMovement();
const acts = (over: Parameters<typeof makeLocal>[1] = {}, hp = 50): PredictedActions =>
  actionsFromSnapshot(
    makeLocal(1, { slots: [{ weapon: 'rifle', mag: 5 }, null], activeSlot: 0, ammo: makeAmmo({ ammo_light: 0, ammo_heavy: 60, ammo_shell: 0, ammo_sniper: 0 }), heals: { bandage: 1, medkit: 0 }, grenades: 2, ...over }),
    hp,
    100,
  );

describe('localVmAction (viewmodel time bases)', () => {
  it('idle; reload over reloadMs; heal over useMs (item = the heal); swap over combat.swapMs', () => {
    expect(localVmAction(acts(), B)).toEqual({ item: 'rifle', cooking: false, action: 'idle', actionProgress: 0 });
    const r = localVmAction(acts({ reloadRemainingMs: B.weapons.rifle.reloadMs / 4, reloadTotalMs: B.weapons.rifle.reloadMs }), B);
    expect(r).toMatchObject({ item: 'rifle', action: 'reload' });
    expect(r.actionProgress).toBeCloseTo(0.75);
    const h = localVmAction(acts({ healRemainingMs: B.items.bandage.useMs / 2, healTotalMs: B.items.bandage.useMs, healItem: 'bandage' }), B);
    expect(h).toMatchObject({ item: 'bandage', action: 'heal' });
    expect(h.actionProgress).toBeCloseTo(0.5);
    const s = localVmAction(acts({ swapRemainingMs: B.combat.swapMs / 2 }), B);
    expect(s.action).toBe('swapIn');
    expect(s.actionProgress).toBeCloseTo(0.5);
  });

  it('cook = cookMs / fuseMs; throw over throwRecoveryMs; punch over fists fireIntervalMs', () => {
    let a = acts({ activeSlot: 3 });
    a = stepActions(a, simInput({ fire: true }), M, B);
    a = stepActions(a, simInput({ fire: true }), M, B);
    const c = localVmAction(a, B);
    expect(c).toMatchObject({ item: 'grenade', action: 'cook', cooking: true });
    expect(c.actionProgress).toBeCloseTo((SIM_DT * 1000) / B.items.grenade.fuseMs);
    const t = localVmAction(acts({ activeSlot: 3, throwRecoveryMs: B.items.grenade.throwRecoveryMs / 4 }), B);
    expect(t.action).toBe('throw');
    expect(t.actionProgress).toBeCloseTo(0.75);
    let f = acts({ activeSlot: 2 }, 100);
    f = stepActions(f, simInput({ fire: true }), M, B);
    const p = localVmAction(f, B);
    expect(p).toMatchObject({ item: 'fists', action: 'punch' });
    expect(p.actionProgress).toBe(0);
    const later = localVmAction({ ...f, tick: f.tick + 2 }, B);
    expect(later.actionProgress).toBeCloseTo(Math.min(1, (2 * SIM_DT * 1000) / B.weapons.fists.fireIntervalMs));
  });
});

describe('remoteVmAction (FP spectate)', () => {
  it('from anim flags, progress 0', () => {
    const anim = makePlayer(2).anim;
    expect(remoteVmAction(makePlayer(2, { weapon: 'smg' }))).toEqual({ item: 'smg', cooking: false, action: 'idle', actionProgress: 0 });
    expect(remoteVmAction(makePlayer(2, { weapon: 'smg', anim: { ...anim, reloading: true } })).action).toBe('reload');
    expect(remoteVmAction(makePlayer(2, { anim: { ...anim, healing: true } })).action).toBe('heal');
    expect(remoteVmAction(makePlayer(2, { weapon: 'grenade', anim: { ...anim, cooking: true } }))).toMatchObject({ action: 'cook', cooking: true });
    expect(remoteVmAction(makePlayer(2, { weapon: 'fists', anim: { ...anim, firing: true } })).action).toBe('punch');
  });
});

describe('viewmodel helpers', () => {
  it('buildViewmodel copies the fields (lookRate copied)', () => {
    const lookRate = { yaw: 1, pitch: 2 };
    const v = buildViewmodel({
      playerId: 1, appearance: { skin: 1, outfit: 2, hair: 3 }, vestTier: 2, act: { item: 'rifle', cooking: false, action: 'idle', actionProgress: 0 },
      adsBlend: 0.5, visible: true, shotCount: 3, stance: 'crouch', stanceFrom: 'stand', stanceProgress: 0.4, dropPhase: null,
      bobPhase: 1, bobAmount: 0.3, sprinting: false, lookRate, motionScale: 1,
    });
    expect(v).toMatchObject({ playerId: 1, item: 'rifle', adsBlend: 0.5, shotCount: 3, stance: 'crouch', vestTier: 2 });
    expect(v.lookRate).toEqual(lookRate);
    expect(v.lookRate).not.toBe(lookRate);
  });

  it('LookRate converges on the look speed and restarts per subject', () => {
    const r = new LookRate();
    r.update(1, 0, 0, 0.016);
    let v = { yaw: 0, pitch: 0 };
    for (let i = 1; i <= 60; i++) v = r.update(1, -i * 0.016, 0, 0.016); // turning right at 1 rad/s (yaw decreasing)
    expect(v.yaw).toBeCloseTo(-1, 2);
    expect(r.update(2, 5, 0, 0.016)).toEqual({ yaw: 0, pitch: 0 });
  });

  it('SpectateAdsClock: ms since anim.ads rose; 0 when off or on a new subject', () => {
    const c = new SpectateAdsClock();
    expect(c.update(1, true, 1000)).toBe(0);
    expect(c.update(1, true, 1250)).toBe(250);
    expect(c.update(1, false, 1300)).toBe(0);
    c.update(1, true, 2000);
    expect(c.update(2, true, 2100)).toBe(0);
  });

  it('ShotCounter counts per player', () => {
    const s = new ShotCounter();
    s.add(1);
    s.add(1);
    s.add(2);
    expect([s.of(1), s.of(2), s.of(3)]).toEqual([2, 1, 0]);
    s.reset();
    expect(s.of(1)).toBe(0);
  });
});
