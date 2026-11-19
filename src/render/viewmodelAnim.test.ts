/** First-person viewmodel animation math and the viewmodel pass pose (no GL). Owner: graphics-engineer (viewmodel). */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/balance';
import type { CameraView, FrameView, ViewmodelView } from '../shared/contracts';
import { viewmodelActive, ViewmodelPass } from './ViewmodelPass';
import {
  createVmOut,
  easeInOut,
  envelope,
  landingDip,
  lookLagTarget,
  punchWeight,
  recoilDecay,
  recoilStack,
  reloadTilt,
  stanceDip,
  stanceWeight,
  swapCurve,
  VM_ANIM_DEFAULTS,
  VM_FREEFALL_HAND,
  VM_MAG_POINT,
  VM_CHUTE_HAND,
  ViewmodelAnimator,
  viewmodelFovFromBalance,
  viewmodelItemFor,
  vmAnimConfigFromBalance,
  type VmOut,
} from './viewmodelAnim';

const GUNS = ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper'] as const;

function vmView(over: Partial<ViewmodelView> = {}): ViewmodelView {
  return {
    playerId: 1,
    appearance: { skin: 1, outfit: 2, hair: 0 },
    vestTier: 0,
    item: 'rifle',
    cooking: false,
    action: 'idle',
    actionProgress: 0,
    adsBlend: 0,
    visible: true,
    shotCount: 0,
    stance: 'stand',
    stanceFrom: 'stand',
    stanceProgress: 1,
    dropPhase: null,
    bobPhase: 0,
    bobAmount: 0,
    sprinting: false,
    lookRate: { yaw: 0, pitch: 0 },
    motionScale: 1,
    ...over,
  };
}

const ctx = { airborne: false };
const DT = 1 / 120;

/** Run `ms` of frames with a fixed view; returns the last output. */
function run(a: ViewmodelAnimator, v: ViewmodelView, ms: number, out: VmOut = createVmOut()): VmOut {
  const n = Math.max(1, Math.round(ms / (DT * 1000)));
  for (let i = 0; i < n; i++) a.step(v, ctx, DT, out);
  return out;
}

describe('viewmodel easing and curves', () => {
  it('ease and envelope endpoints', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9);
    expect(envelope(0.5, 0, 0.2, 0.8, 1)).toBe(1);
    expect(envelope(0, 0, 0.2, 0.8, 1)).toBe(0);
    expect(envelope(1, 0, 0.2, 0.8, 1)).toBe(0);
  });

  it('reload tilt: in by t 0.15, held, back to the reference pose at t 1 (STYLE §21.3)', () => {
    expect(reloadTilt(0)).toBe(0);
    expect(reloadTilt(0.15)).toBe(1);
    expect(reloadTilt(0.5)).toBe(1);
    expect(reloadTilt(0.85)).toBe(1);
    expect(reloadTilt(1)).toBe(0);
  });

  it('stance weights and the stance dip', () => {
    expect(stanceWeight('crouch', 'stand', 'crouch', 0.25)).toBeCloseTo(0.25, 9);
    expect(stanceWeight('stand', 'stand', 'crouch', 0.25)).toBeCloseTo(0.75, 9);
    expect(stanceDip('stand', 'stand', 1)).toBe(0);
    expect(stanceDip('stand', 'crouch', 1)).toBe(0);
    expect(stanceDip('stand', 'crouch', 0.5)).toBeCloseTo(-0.025, 9);
  });

  it('landing dip: down 0.03 at 120 ms, back by 320 ms', () => {
    expect(landingDip(Infinity)).toBe(0);
    expect(landingDip(0)).toBeCloseTo(0, 12);
    expect(landingDip(120)).toBeCloseTo(-0.03, 9);
    expect(landingDip(320)).toBe(0);
  });

  it('recoil stacks to at most 2x and decays to under 1% within returnMs', () => {
    expect(recoilStack(0, 1)).toBe(1);
    expect(recoilStack(1.6, 1)).toBe(2);
    expect(recoilStack(0, 5)).toBe(2);
    expect(recoilDecay(1, 90, 90)).toBeLessThan(0.01);
    expect(recoilDecay(1, 0, 90)).toBe(1);
  });

  it('punch: out in 90 ms (ease-out), hold 30 ms, back by 280 ms', () => {
    expect(punchWeight(0)).toBe(0);
    expect(punchWeight(90)).toBe(1);
    expect(punchWeight(110)).toBe(1);
    expect(punchWeight(280)).toBe(0);
    expect(punchWeight(45)).toBeGreaterThan(0.5); // ease-out: past half way at half time
  });

  it('swap: the old item drops in the first 45%, the new one rises in the rest', () => {
    expect(swapCurve(0.2, true).showOld).toBe(true);
    expect(swapCurve(0.44, true).lower).toBeGreaterThan(0.9);
    expect(swapCurve(0.5, true).showOld).toBe(false);
    expect(swapCurve(1, true).lower).toBe(0);
    expect(swapCurve(0, false).lower).toBe(1);
  });

  it('look lag is opposite to the turn and capped at vmSwayMaxDeg', () => {
    const per = 1.5 * (Math.PI / 180), max = 3 * (Math.PI / 180);
    expect(lookLagTarget(1, per, max)).toBeCloseTo(-per, 9);
    expect(lookLagTarget(-100, per, max)).toBeCloseTo(max, 9);
  });

  it('item mapping', () => {
    expect(viewmodelItemFor('grenade', true)).toBe('grenade_cooking');
    expect(viewmodelItemFor('grenade', false)).toBe('grenade');
    expect(viewmodelItemFor('medkit', false)).toBe('medkit');
    expect(viewmodelItemFor('sniper', false)).toBe('sniper');
  });
});

describe('viewmodel config from balance', () => {
  it('reads fpRecoil, fpAdsRecoilFactor, vm sway and the viewmodel FOV (balance wins over VIEWMODEL_FOV)', () => {
    const c = vmAnimConfigFromBalance(BALANCE);
    expect(c.recoil.rifle?.returnMs).toBe(90);
    expect(c.recoil.sniper?.kickBack).toBeCloseTo(0.08, 9);
    expect(c.adsRecoilFactor).toBeCloseTo(0.5, 9);
    expect(c.swapMs).toBe(BALANCE.combat.swapMs);
    expect(c.throwRecoveryMs).toBe(BALANCE.items.grenade.throwRecoveryMs);
    expect(c.punchMs).toBe(BALANCE.weapons.fists.fireIntervalMs);
    expect(viewmodelFovFromBalance(BALANCE, 50)).toBe(55);
    expect(viewmodelFovFromBalance({ ...BALANCE, clientFeel: {} }, 50)).toBe(50);
  });
});

describe('ViewmodelAnimator', () => {
  it('one rifle shot kicks back and up, and is back at rest within returnMs (camera.md AC8)', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = createVmOut();
    a.step(vmView({ motionScale: 0 }), ctx, DT, out);
    a.step(vmView({ motionScale: 0, shotCount: 1 }), ctx, DT, out);
    expect(out.sockPos[2]).toBeGreaterThan(0.015);
    expect(out.sockRot[0]).toBeGreaterThan(0.025);
    run(a, vmView({ motionScale: 0, shotCount: 1 }), 90, out);
    expect(Math.abs(out.sockPos[2])).toBeLessThan(0.02 * 0.01 + 1e-6);
    expect(Math.abs(out.sockRot[0])).toBeLessThan(0.035 * 0.01 + 1e-6);
  });

  it('automatic fire stacks to 2x the single kick, then holds; ADS scales it by fpAdsRecoilFactor', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = createVmOut();
    a.step(vmView({ item: 'smg', motionScale: 0 }), ctx, DT, out);
    for (let i = 1; i <= 20; i++) a.step(vmView({ item: 'smg', motionScale: 0, shotCount: i }), ctx, DT, out);
    expect(a.recoilAmp).toBeLessThanOrEqual(2);
    expect(a.recoilAmp).toBeGreaterThan(1.9);
    const hip = out.sockPos[2];
    const b = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const o2 = createVmOut();
    b.step(vmView({ item: 'smg', motionScale: 0, adsBlend: 1 }), ctx, DT, o2);
    for (let i = 1; i <= 20; i++) b.step(vmView({ item: 'smg', motionScale: 0, adsBlend: 1, shotCount: i }), ctx, DT, o2);
    expect(o2.sockPos[2]).toBeCloseTo(hip * 0.5, 6);
  });

  it('no kick on the first frame or when switching subject (counter resync)', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = createVmOut();
    a.step(vmView({ shotCount: 57, motionScale: 0 }), ctx, DT, out);
    expect(out.sockPos[2]).toBe(0);
    a.step(vmView({ playerId: 2, shotCount: 3, motionScale: 0 }), ctx, DT, out);
    expect(out.sockPos[2]).toBe(0);
  });

  it('full ADS at rest: no x/y offset and no pitch/yaw (the sight stays on the centre), only a small roll', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = run(a, vmView({ adsBlend: 1, lookRate: { yaw: 0, pitch: 0 } }), 1700);
    expect(out.ads).toBe(1);
    expect(Math.abs(out.sockPos[0])).toBeLessThan(1e-9);
    expect(Math.abs(out.sockPos[1])).toBeLessThan(1e-9);
    expect(Math.abs(out.sockRot[0])).toBeLessThan(1e-9);
    expect(Math.abs(out.sockRot[1])).toBeLessThan(1e-9);
    expect(Math.abs(out.sockRot[2])).toBeLessThan(0.003);
  });

  it('reduced motion: idle sway scales with motionScale (0.3x)', () => {
    const peak = (ms: number) => {
      const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
      const out = createVmOut();
      let m = 0;
      for (let i = 0; i < 400; i++) {
        a.step(vmView({ motionScale: ms }), ctx, DT, out);
        m = Math.max(m, Math.abs(out.sockRot[2]));
      }
      return m;
    };
    expect(peak(0.3) / peak(1)).toBeCloseTo(0.3, 3);
  });

  it('walk bob: amplitude from bobAmount; sprint tilts the gun across the chest', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = createVmOut();
    a.step(vmView({ motionScale: 1, bobAmount: 1, bobPhase: Math.PI }), ctx, DT, out);
    expect(out.sockPos[0]).toBeGreaterThan(0.009); // sin(phase/2) = 1 -> 0.010 walk x
    expect(out.sockPos[1]).toBeLessThan(-0.004); // -0.008 walk y, plus idle sway y
    const s = run(new ViewmodelAnimator(VM_ANIM_DEFAULTS), vmView({ sprinting: true, motionScale: 0 }), 600);
    expect(s.sockRot[1]).toBeCloseTo(0.35, 2);
    expect(s.sockPos[1]).toBeCloseTo(-0.05, 2);
  });

  it('landing dip after airborne -> grounded', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = createVmOut();
    const v = vmView({ motionScale: 1 });
    a.step(v, { airborne: true }, DT, out);
    a.step(v, { airborne: false }, DT, out);
    run(a, v, 110, out);
    expect(out.sockPos[1]).toBeLessThan(-0.02);
    run(a, v, 400, out);
    expect(out.sockPos[1]).toBeGreaterThan(-0.01);
  });

  it('swap shows the old item dropping, then the new one rising', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = createVmOut();
    run(a, vmView({ item: 'pistol', motionScale: 0 }), 50, out);
    a.step(vmView({ item: 'rifle', action: 'swapIn', actionProgress: 0.3, motionScale: 0 }), ctx, DT, out);
    expect(out.item).toBe('pistol');
    expect(out.sockPos[1]).toBeLessThan(-0.08);
    a.step(vmView({ item: 'rifle', action: 'swapIn', actionProgress: 0.6, motionScale: 0 }), ctx, DT, out);
    expect(out.item).toBe('rifle');
    a.step(vmView({ item: 'rifle', action: 'swapIn', actionProgress: 1, motionScale: 0 }), ctx, DT, out);
    expect(out.sockPos[1]).toBeCloseTo(0, 9);
  });

  it('reload mid-way: gun tilted, left hand at the mag or below; hip pose forced', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = createVmOut();
    a.step(vmView({ action: 'reload', actionProgress: 0.3, adsBlend: 1, motionScale: 0 }), ctx, DT, out);
    expect(out.ads).toBe(0);
    expect(out.sockRot[2]).toBeCloseTo(0.35, 6);
    expect(out.handL.magW).toBe(1);
    a.step(vmView({ action: 'reload', actionProgress: 0.41, motionScale: 0 }), ctx, DT, out);
    expect(out.handL.pos[1]).toBeLessThan(-0.2);
  });

  it('grenade: pin pull (pin model, left hand back) then the cooking model in the wind-up with fuse sparks', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = createVmOut();
    run(a, vmView({ item: 'grenade', motionScale: 0 }), 30, out);
    a.step(vmView({ item: 'grenade', cooking: true, action: 'cook', actionProgress: 0.01, motionScale: 0 }), ctx, DT, out);
    run(a, vmView({ item: 'grenade', cooking: true, action: 'cook', actionProgress: 0.02, motionScale: 0 }), 80, out);
    expect(out.item).toBe('grenade');
    expect(out.handL.pos[0]).toBeLessThan(-0.03);
    run(a, vmView({ item: 'grenade', cooking: true, action: 'cook', actionProgress: 0.2, motionScale: 0 }), 400, out);
    expect(out.item).toBe('grenade_cooking');
    expect(out.ads).toBe(1);
    expect(out.fuse).toBe(1);
  });

  it('throw: the grenade leaves the hand at 60% of 120 ms and the fingers open', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = createVmOut();
    const at = (ms: number) => a.step(vmView({ item: 'grenade', action: 'throw', actionProgress: ms / 600, motionScale: 0 }), ctx, DT, out);
    at(30);
    expect(out.showItem).toBe(true);
    expect(out.sockAbsW).toBeGreaterThan(0.3);
    at(100);
    expect(out.showItem).toBe(false);
    expect(out.handR.curl).toBe(0);
    at(550);
    expect(out.sockPos[1]).toBeLessThan(0); // the next item is still rising
  });

  it('swap while cooking drops the grenade at the feet', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = createVmOut();
    run(a, vmView({ item: 'grenade', cooking: true, action: 'cook', actionProgress: 0.3, motionScale: 0 }), 300, out);
    a.step(vmView({ item: 'rifle', action: 'swapIn', actionProgress: 0.05, motionScale: 0 }), ctx, DT, out);
    run(a, vmView({ item: 'rifle', action: 'swapIn', actionProgress: 0.3, motionScale: 0 }), 150, out);
    expect(out.sockPos[1]).toBeLessThan(-0.2);
  });

  it('punch alternates hands on consecutive hits', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = createVmOut();
    run(a, vmView({ item: 'fists', motionScale: 0 }), 20, out);
    run(a, vmView({ item: 'fists', action: 'punch', actionProgress: 0.2, motionScale: 0 }), 1, out); // 90 ms of 450
    const first = out.handR.absW > 0.5 ? 'R' : 'L';
    expect(out.rootRot[0]).toBeGreaterThan(0.005);
    run(a, vmView({ item: 'fists', motionScale: 0 }), 300, out);
    run(a, vmView({ item: 'fists', action: 'punch', actionProgress: 0.2, motionScale: 0 }), 1, out);
    const second = out.handR.absW > 0.5 ? 'R' : 'L';
    expect(second).not.toBe(first);
  });

  it('freefall: item hidden, hands spread to the screen edges; chute: hands up, canopy deploys over 350 ms', () => {
    const a = new ViewmodelAnimator(VM_ANIM_DEFAULTS);
    const out = run(new ViewmodelAnimator(VM_ANIM_DEFAULTS), vmView({ dropPhase: 'freefall', motionScale: 0 }), 500);
    expect(out.showItem).toBe(false);
    expect(out.handR.absPos[0]).toBeCloseTo(VM_FREEFALL_HAND[0], 6);
    expect(out.handL.absPos[0]).toBeCloseTo(-VM_FREEFALL_HAND[0], 6);
    expect(out.canopy).toBe(-1);
    run(a, vmView({ dropPhase: 'freefall' }), 200, out);
    run(a, vmView({ dropPhase: 'chute', motionScale: 0 }), 100, out);
    expect(out.canopy).toBeGreaterThan(0.2);
    expect(out.canopy).toBeLessThan(0.4);
    run(a, vmView({ dropPhase: 'chute', motionScale: 0 }), 400, out);
    expect(out.canopy).toBe(1);
    expect(out.handR.absPos[1]).toBeCloseTo(VM_CHUTE_HAND[1], 6);
    // landing: canopy gone, item rises back
    a.step(vmView({ dropPhase: null, motionScale: 0 }), ctx, DT, out);
    expect(out.canopy).toBe(-1);
    expect(out.showItem).toBe(true);
    expect(out.sockPos[1]).toBeLessThan(-0.1);
  });
});

// -------------------------------------------------------------------------------------------------
// The pass (three.js objects only; no WebGL context)
// -------------------------------------------------------------------------------------------------
function frame(vm: ViewmodelView | null, cam: Partial<CameraView> = {}, time = 0): FrameView {
  return {
    time, serverTime: 0, phase: 'playing', localId: 1,
    camera: { mode: 'follow', target: { x: 0, y: 1.2, z: 0 }, yaw: 0, pitch: 0, distance: 0, shoulderOffset: 0, fovDeg: 70, firstPerson: true, view: 'firstPerson', subjectId: 1, roll: 0, ...cam },
    players: [], loot: [], highlightLootId: null, zone: null, grenades: [], grenadeArc: null, ads: null, viewmodel: vm, reducedMotion: false,
    // M2c (gate: required on FrameView)
    rockets: [], smokes: [], brokenPanes: [], look: 'noon',
  };
}

describe('ViewmodelPass', () => {
  it('is active only in the FP camera case with a visible viewmodel', () => {
    expect(viewmodelActive(frame(vmView()))).toBe(true);
    expect(viewmodelActive(frame(vmView({ visible: false })))).toBe(false); // scope overlay, aboard, dead
    expect(viewmodelActive(frame(null))).toBe(false);
    expect(viewmodelActive(frame(vmView(), { view: 'chase', firstPerson: false }))).toBe(false);
    expect(viewmodelActive(frame(vmView(), { view: 'death', mode: 'orbit', firstPerson: false }))).toBe(false);
  });

  for (const gun of GUNS) {
    it(`${gun}: at adsBlend 1 the sight anchor is on the view axis even with idle sway running (camera.md AC6)`, () => {
      const pass = new ViewmodelPass(BALANCE);
      for (let i = 0; i < 300; i++) pass.update(frame(vmView({ item: gun, adsBlend: 1 }), {}, i * DT), DT);
      const root = pass.scene.getObjectByName('viewmodel')!;
      root.updateMatrixWorld(true);
      const sight = root.getObjectByName('sight')!;
      const eye = sight.getWorldPosition(new THREE.Vector3());
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(sight.getWorldQuaternion(new THREE.Quaternion()));
      // the line of sight passes through the origin along -Z (roll is allowed)
      expect(Math.hypot(eye.x, eye.y)).toBeLessThan(1e-4);
      expect(fwd.z).toBeLessThan(-0.99999);
      pass.dispose();
    });
  }

  it('hands follow the gun rigidly under recoil; reload brings the left hand to the mag', () => {
    const pass = new ViewmodelPass(BALANCE);
    pass.update(frame(vmView({ motionScale: 0 })), DT);
    const root = pass.scene.getObjectByName('viewmodel')!;
    const sock = root.getObjectByName('itemSocket')!;
    const handR = root.getObjectByName('handR')!;
    const rel = () => {
      root.updateMatrixWorld(true);
      return handR.getWorldPosition(new THREE.Vector3()).applyMatrix4(sock.matrixWorld.clone().invert());
    };
    const before = rel();
    pass.update(frame(vmView({ motionScale: 0, shotCount: 1 })), DT);
    expect(sock.position.z).toBeGreaterThan(-0.47 + 0.01);
    expect(rel().distanceTo(before)).toBeLessThan(1e-6);
    const handL = root.getObjectByName('handL')!;
    pass.update(frame(vmView({ motionScale: 0, action: 'reload', actionProgress: 0.25, shotCount: 1 })), DT);
    root.updateMatrixWorld(true);
    const mag = new THREE.Vector3(...VM_MAG_POINT.rifle).applyMatrix4(sock.matrixWorld);
    expect(handL.getWorldPosition(new THREE.Vector3()).distanceTo(mag)).toBeLessThan(0.01);
    pass.dispose();
  });

  it('hidden under the scope overlay; FP canopy in the world group only during the chute', () => {
    const pass = new ViewmodelPass(BALANCE);
    const players = [{ state: { id: 1, pos: { x: 3, y: 40, z: 4 }, yaw: 0.5, anim: { airborne: true } }, isLocal: true, isSpectateTarget: false }];
    const f = (vm: ViewmodelView) => ({ ...frame(vm), players } as unknown as FrameView);
    pass.update(f(vmView({ visible: false })), DT);
    expect(pass.isActive).toBe(false);
    pass.update(f(vmView({ dropPhase: 'chute' })), DT);
    expect(pass.isActive).toBe(true);
    expect(pass.worldGroup.visible).toBe(true);
    const chute = pass.worldGroup.getObjectByName('fpParachute')!;
    expect(chute.position.y).toBe(40);
    pass.update(f(vmView({ dropPhase: 'freefall' })), DT);
    expect(pass.worldGroup.visible).toBe(false);
    pass.dispose();
  });

  it('lit materials are pass-private clones (the world materials never see the viewmodel lights)', () => {
    const pass = new ViewmodelPass(BALANCE);
    pass.update(frame(vmView()), DT);
    let toon = 0;
    pass.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && (m as THREE.MeshToonMaterial).isMeshToonMaterial) {
        toon++;
        expect(m.name.endsWith(':vm')).toBe(true);
      }
    });
    expect(toon).toBeGreaterThan(0);
    pass.dispose();
  });
});
