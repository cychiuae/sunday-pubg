/**
 * First-person viewmodel art (M2b addendum 3): chibi forearms + mitten hands, and per-item hold / ADS poses.
 * Owner: graphics-designer. Spec: docs/art/STYLE.md §21; budgets: docs/art/ASSET_LIST.md "First-person viewmodel".
 *
 * CAMERA SPACE: the viewmodel root sits at the viewmodel camera (origin = eye), looking down -Z, +X right, +Y up.
 * Render it in its own pass with VIEWMODEL_FOV (vertical degrees) and a near plane of ~0.01 m.
 *
 * Rig (createViewmodel):
 *   root 'viewmodel'
 *   ├─ 'itemSocket'  the held item (gun / grenade / heal item); pose.hip / pose.ads place THIS in camera space
 *   │    └─ item model (weapon frame: origin at the grip, barrel -Z; see weapons.ts)
 *   ├─ 'handR' hand bone (palm centre). Local frame: fingers -Z, back of hand +Y, forearm along +Z (to the elbow)
 *   │    └─ 'fingersR' knuckle pivot: rotation.x < 0 curls the mitten toward the palm (grip / fist)
 *   └─ 'handL' / 'fingersL' (mirror: thumb on +X)
 * Hand bones are children of the root (not of the item) so the hands can leave the gun (reload, throw, punch);
 * applyViewmodelPose() places them at the item's hand targets.
 */
import * as THREE from 'three';
import type { Appearance } from '../../shared/types';
import { buildMerged, xf, type Merged, type Piece, type V3 } from './builder';
import { OUTFITS, outfitSleeve, SKIN_TONES } from './chibi';
import type { ItemLevel, ScopeId } from '../../shared/types';
import { createGrenadeModel } from './grenade';
import { getLootItemGeometry } from './loot';
import { outlineMaterial, palette, vertexColorToon } from './materials';
import { createSmokeModel } from './smokeCan';
import { createWeaponModel, getWeaponSight } from './weapons';

/**
 * FALLBACK viewmodel vertical FOV in degrees. The renderer uses `clientFeel.viewmodelFovDeg` (55; ARCHITECTURE
 * §15.6, the balance key wins); this matches it and is only used when the key is missing.
 */
export const VIEWMODEL_FOV = 55;
/** The FOV the hold poses were framed at (first-person renders, M2b Phase A). */
export const VIEWMODEL_AUTHORED_FOV = 50;
/**
 * Depth factor that keeps the authored framing at VIEWMODEL_FOV: a camera-space point (x, y, z) projects to the same
 * pixel, at the same size, at (x, y, z * k) with k = tan(authored / 2) / tan(fov / 2) (0.896 for 50 -> 55).
 */
export const VIEWMODEL_FOV_DEPTH = Math.tan((VIEWMODEL_AUTHORED_FOV * Math.PI) / 360) / Math.tan((VIEWMODEL_FOV * Math.PI) / 360);
/** Suggested viewmodel near plane (m). */
export const VIEWMODEL_NEAR = 0.01;

export type ViewmodelItemId =
  | 'fists' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'lmg' | 'dmr' | 'sniper'
  | 'grenade' | 'grenade_cooking' | 'bandage' | 'medkit'
  // M2c (docs/art/M2c.md §7)
  | 'revolver' | 'dbshotgun' | 'rpg' | 'knife' | 'machete' | 'paddle' | 'smoke' | 'smoke_cooking';
export const VIEWMODEL_ITEM_IDS: readonly ViewmodelItemId[] = [
  'fists', 'pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper', 'grenade', 'grenade_cooking', 'bandage', 'medkit',
  'revolver', 'dbshotgun', 'rpg', 'knife', 'machete', 'paddle', 'smoke', 'smoke_cooking',
];
/** M2c melee items (no ADS; swing arcs in MELEE_SWING_KEYS). */
export type ViewmodelMeleeId = 'knife' | 'machete' | 'paddle';
export const VIEWMODEL_MELEE_IDS: readonly ViewmodelMeleeId[] = ['knife', 'machete', 'paddle'];

/** Position (m) + Euler XYZ rotation (rad). */
export interface VmXf { pos: V3; rot: V3 }
export interface ViewmodelPose {
  /** itemSocket in camera space, hip fire. */
  hip: VmXf;
  /** itemSocket in camera space, aiming. For guns: rot 0 and pos = -sight.eye, so the `sight` anchor is the eye. */
  ads: VmXf;
  /** Hand bone targets in ITEM space (they follow the item). null = that hand is lowered / hidden. */
  handR: VmXf | null;
  handL: VmXf | null;
  /** Finger curl (fingers pivot rotation.x; 0 = flat mitten, -1.6 = fist). */
  curlR: number;
  curlL: number;
  /** Uniform scale of the held item model (heal items are shrunk to fit the view). */
  itemScale: number;
}

const PI = Math.PI;
const H = PI / 2;
const xfm = (pos: V3, rot: V3 = [0, 0, 0]): VmXf => ({ pos, rot });
/** Camera-space transform authored at VIEWMODEL_AUTHORED_FOV, re-framed for VIEWMODEL_FOV (depth scaled). */
const cxf = (pos: V3, rot: V3 = [0, 0, 0]): VmXf => ({ pos: [pos[0], pos[1], pos[2] * VIEWMODEL_FOV_DEPTH], rot });
/** Right hand wrapped around a pistol grip: palm faces -X, forearm down-back, elbow out. */
const GRIP_R = (pos: V3, tilt = 0.55): VmXf => xfm(pos, [tilt, 0.18, -H]);
/** Left (support) hand palm-up under a fore-end, forearm down-back-left. */
const SUPPORT_L = (pos: V3, tilt = 0.6): VmXf => xfm(pos, [tilt, -0.4, PI]);

/** ADS socket for a gun: the sight anchor lands on the camera origin (eye) with no rotation. With a scope: its eye. */
function adsFor(id: string, scope: ScopeId | null = null): VmXf {
  const s = getWeaponSight(id, { scope });
  const e = s ? s.eye : [0, 0, 0];
  return xfm([-e[0], -e[1], -e[2]]);
}

function gun(id: string, hip: V3, hipRot: V3, handR: VmXf, handL: VmXf): ViewmodelPose {
  return { hip: cxf(hip, hipRot), ads: adsFor(id), handR, handL, curlR: -1.25, curlL: -0.95, itemScale: 1 };
}
/** Melee hold: no ADS (ads = hip). */
function melee(hip: V3, hipRot: V3, handR: VmXf, handL: VmXf | null, curlR: number, curlL: number): ViewmodelPose {
  const h = cxf(hip, hipRot);
  return { hip: h, ads: h, handR, handL, curlR, curlL, itemScale: 1 };
}

/** Level and scope of the held item (M2c): picks the per-level model and the mounted scope. */
export interface ViewmodelItemOptions {
  level?: ItemLevel | null;
  scope?: ScopeId | null;
}

/**
 * Reference hold poses per item, authored at VIEWMODEL_AUTHORED_FOV (50) and re-framed for VIEWMODEL_FOV (55) by
 * scaling camera-space depth (cxf): same on-screen place and size as the approved renders. Gun ADS is unaffected
 * (the sight sits on the eye). The engineer animates on
 * top of these (STYLE.md §21 keyframes) and lerps hip -> ads with the ADS amount.
 */
export const VIEWMODEL_POSES: Readonly<Record<ViewmodelItemId, ViewmodelPose>> = {
  fists: {
    hip: xfm([0, 0, 0]),
    ads: xfm([0, 0.02, 0.02]),
    // fists: the item socket is the camera origin, so the hand targets are camera space
    handR: cxf([0.15, -0.13, -0.36], [0.6, 0.3, -H]),
    handL: cxf([-0.16, -0.15, -0.42], [0.6, -0.3, H]),
    curlR: -1.6, curlL: -1.6, itemScale: 1,
  },
  pistol: gun('pistol', [0.12, -0.13, -0.46], [0.02, 0.07, 0], GRIP_R([0.004, -0.035, 0.03], 0.35), xfm([-0.035, -0.07, 0.0], [0.45, -0.35, H])),
  smg: gun('smg', [0.16, -0.17, -0.46], [0.03, 0.14, -0.05], GRIP_R([0.004, -0.04, 0.045]), SUPPORT_L([0, -0.045, -0.15], 0.75)),
  shotgun: gun('shotgun', [0.18, -0.2, -0.47], [0.03, 0.16, -0.06], GRIP_R([0.004, -0.045, 0.04]), SUPPORT_L([0, -0.03, -0.3])),
  rifle: gun('rifle', [0.18, -0.2, -0.47], [0.03, 0.16, -0.06], GRIP_R([0.004, -0.045, 0.06]), SUPPORT_L([0, -0.025, -0.3])),
  lmg: gun('lmg', [0.19, -0.23, -0.48], [0.04, 0.16, -0.06], GRIP_R([0.004, -0.045, 0.08]), SUPPORT_L([0, -0.03, -0.36])),
  dmr: gun('dmr', [0.19, -0.22, -0.5], [0.03, 0.16, -0.06], GRIP_R([0.004, -0.045, 0.06]), SUPPORT_L([0, -0.025, -0.33])),
  sniper: gun('sniper', [0.2, -0.23, -0.55], [0.03, 0.16, -0.06], GRIP_R([0.004, -0.045, 0.07]), SUPPORT_L([0, -0.04, -0.36])),
  grenade: {
    hip: cxf([0.16, -0.12, -0.46], [0, 0.3, 0]),
    // "ads" = wind-up: grenade raised beside the head, ready to throw (arc preview showing)
    ads: cxf([0.22, -0.01, -0.42], [-0.3, 0.3, 0.2]),
    handR: xfm([0, -0.06, 0.01], [0.5, 0.2, PI]),
    handL: xfm([-0.085, 0.05, 0.02], [0.2, -0.4, H]),
    curlR: -0.9, curlL: -0.7, itemScale: 1,
  },
  grenade_cooking: {
    hip: cxf([0.16, -0.11, -0.45], [0, 0.3, 0]),
    ads: cxf([0.22, -0.01, -0.42], [-0.3, 0.3, 0.2]),
    handR: xfm([0, -0.06, 0.01], [0.5, 0.2, PI]),
    handL: null,
    curlR: -1.0, curlL: -0.4, itemScale: 1,
  },
  bandage: {
    hip: cxf([0.02, -0.15, -0.5], [0.35, 0.25, 0]),
    ads: cxf([0.02, -0.15, -0.5], [0.35, 0.25, 0]),
    handR: xfm([0.24, -0.06, 0.05], [0.4, 0.3, -H]),
    handL: xfm([-0.22, -0.03, 0.02], [0.4, -0.3, H]),
    curlR: -1.0, curlL: -1.0, itemScale: 0.6,
  },
  medkit: {
    hip: cxf([0.0, -0.17, -0.46], [0.6, 0.12, 0]),
    ads: cxf([0.0, -0.17, -0.46], [0.6, 0.12, 0]),
    handR: xfm([0.27, -0.03, 0.02], [0.2, 0.25, -H]),
    handL: xfm([-0.27, -0.03, 0.02], [0.2, -0.25, H]),
    curlR: -0.7, curlL: -0.7, itemScale: 0.65,
  },
  // ---- M2c guns (art M2c.md §7.1) ----
  revolver: gun('revolver', [0.12, -0.13, -0.46], [0.02, 0.07, 0], GRIP_R([0.004, -0.035, 0.025], 0.35), xfm([-0.035, -0.07, 0.0], [0.45, -0.35, H])),
  dbshotgun: gun('dbshotgun', [0.18, -0.2, -0.47], [0.03, 0.16, -0.06], GRIP_R([0.004, -0.045, 0.04]), SUPPORT_L([0, -0.0, -0.22])),
  // tube along the view on the right; its rear end passes behind the camera (the near plane clips it)
  rpg: gun('rpg', [0.2, -0.14, -0.3], [0.02, 0.1, -0.03], GRIP_R([0.004, -0.05, 0.0], 0.3), xfm([-0.004, -0.045, -0.25], [0.4, -0.18, H])),
  // ---- M2c melee: no ADS (ads = hip). The left hand is lowered for the knife and machete (one-handed). ----
  knife: melee([0.17, -0.16, -0.38], [0.35, 0.15, -0.25], GRIP_R([0, -0.01, 0.03], 0.1), null, -1.5, -1.6),
  machete: melee([0.2, -0.2, -0.42], [0.55, 0.1, -0.35], GRIP_R([0, -0.01, 0.04], 0.1), null, -1.5, -1.6),
  paddle: melee([0.1, -0.26, -0.5], [0.45, 0.55, 0.85], GRIP_R([0, -0.01, 0.1], 0.1), xfm([0, -0.01, -0.38], [0.3, -0.2, H]), -1.4, -1.3),
  // ---- M2c smoke can: the frag's poses (the left hand pinches the cream ring) ----
  smoke: {
    hip: cxf([0.16, -0.12, -0.46], [0, 0.3, 0]),
    ads: cxf([0.22, -0.01, -0.42], [-0.3, 0.3, 0.2]),
    handR: xfm([0, -0.06, 0.01], [0.5, 0.2, PI]),
    handL: xfm([-0.085, 0.05, 0.02], [0.2, -0.4, H]),
    curlR: -0.9, curlL: -0.7, itemScale: 1,
  },
  smoke_cooking: {
    hip: cxf([0.16, -0.11, -0.45], [0, 0.3, 0]),
    ads: cxf([0.22, -0.01, -0.42], [-0.3, 0.3, 0.2]),
    handR: xfm([0, -0.06, 0.01], [0.5, 0.2, PI]),
    handL: null,
    curlR: -1.0, curlL: -0.4, itemScale: 1,
  },
};

/**
 * The reference pose for an item with a mounted scope: same hip pose and hands; for guns the ADS socket is the mounted
 * sight's eye (eye = rail + SCOPE_GEOMETRY[scope].eye), so ADS lines up for every gun/scope pair.
 */
export function viewmodelPoseFor(id: ViewmodelItemId, opts: ViewmodelItemOptions = {}): ViewmodelPose {
  const base = VIEWMODEL_POSES[id];
  if (!opts.scope || !getWeaponSight(id)) return base;
  return { ...base, ads: adsFor(id, opts.scope) };
}

// -------------------------------------------------------------------------------------------------
// M2c melee swing arcs (art M2c.md §7.2). Socket keyframes in CAMERA space, authored at 50 deg (cxf).
// t = 0..1 of the swing (weapons.<id>.fireIntervalMs); h = hitFrameMs / fireIntervalMs. The blade crosses the screen
// centre exactly at t = h (the sim's single hit test). Rotation sign: +Y yaw turns the blade to the LEFT, +X pitches it
// UP. Backhand swings (every second swing) mirror x and yaw (knife).
// -------------------------------------------------------------------------------------------------
export interface MeleeSwingKeys {
  /** Socket at the end of the wind-up (t = 0.7 h). */
  windup: VmXf;
  /** Socket at the hit frame (t = h): the blade crosses the view centre. */
  centre: VmXf;
  /** Socket at the end of the strike (t = h + follow). */
  follow: VmXf;
  /** Strike follow-through after the hit frame, as a fraction of the swing. */
  followT: number;
  /** View kick at the hit frame (camera rotation x, y). */
  kick: readonly [number, number];
  /** Swing-trail arc width (m) for the VFX. */
  trailWidth: number;
  /** Alternate forehand / backhand on consecutive swings. */
  alternate: boolean;
}

export const MELEE_SWING_KEYS: Readonly<Record<ViewmodelMeleeId, MeleeSwingKeys>> = {
  knife: {
    windup: cxf([0.26, -0.12, -0.34], [0.3, -0.55, -0.2]),
    centre: cxf([0.06, -0.14, -0.46], [0.25, 0.05, -0.1]),
    follow: cxf([-0.14, -0.15, -0.5], [0.2, 0.75, 0]),
    followT: 0.12, kick: [0.004, 0], trailWidth: 0.2, alternate: true,
  },
  machete: {
    windup: cxf([0.28, 0.03, -0.3], [1.3, -0.2, 0.4]),
    centre: cxf([0.08, -0.12, -0.45], [0.2, 0.15, -0.1]),
    follow: cxf([-0.1, -0.3, -0.5], [-0.6, 0.35, -0.5]),
    followT: 0.12, kick: [0.012, 0], trailWidth: 0.3, alternate: false,
  },
  paddle: {
    windup: cxf([0.36, -0.1, -0.24], [0.2, -0.95, 0.3]),
    centre: cxf([0.02, -0.14, -0.5], [0.15, 0.0, 0.1]),
    follow: cxf([-0.32, -0.16, -0.56], [0.15, 0.95, -0.2]),
    followT: 0.14, kick: [0, -0.02], trailWidth: 0.5, alternate: false,
  },
};

/** Hit-frame fraction from balance (hitFrameMs / fireIntervalMs), clamped to a sane range. */
export function meleeHitFraction(w: { hitFrameMs?: number; fireIntervalMs: number }): number {
  const h = (w.hitFrameMs ?? w.fireIntervalMs * 0.35) / Math.max(1, w.fireIntervalMs);
  return Math.min(0.8, Math.max(0.1, h));
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (k: number) => k * k * (3 - 2 * k);
const lerpXf = (a: VmXf, b: VmXf, k: number): VmXf => ({
  pos: [lerp(a.pos[0], b.pos[0], k), lerp(a.pos[1], b.pos[1], k), lerp(a.pos[2], b.pos[2], k)],
  rot: [lerp(a.rot[0], b.rot[0], k), lerp(a.rot[1], b.rot[1], k), lerp(a.rot[2], b.rot[2], k)],
});
const mirror = (x: VmXf): VmXf => ({ pos: [-x.pos[0] + 0.12, x.pos[1], x.pos[2]], rot: [x.rot[0], -x.rot[1], -x.rot[2]] });

/**
 * Absolute item-socket transform (camera space) of a melee swing at t (0..1) with hit fraction h. Keys: hold (0) ->
 * wind-up (0.7 h, ease-in-out) -> centre (h, fast linear strike) -> follow (h + followT) -> hold (1, ease-out).
 * `backhand` mirrors the arc (only used when the item alternates). The engineer layers recoil-like kicks on top.
 */
export function meleeSwingPose(id: ViewmodelMeleeId, t: number, h: number, backhand = false): VmXf {
  const k = MELEE_SWING_KEYS[id];
  const hold = VIEWMODEL_POSES[id].hip;
  const m = backhand && k.alternate;
  const W = m ? mirror(k.windup) : k.windup, C = m ? mirror(k.centre) : k.centre, F = m ? mirror(k.follow) : k.follow;
  const tt = Math.min(1, Math.max(0, t));
  const tw = 0.7 * h, tf = Math.min(0.95, h + k.followT);
  if (tt <= tw) return lerpXf(hold, W, ease(tw > 0 ? tt / tw : 1));
  if (tt <= h) return lerpXf(W, C, (tt - tw) / Math.max(1e-6, h - tw));
  if (tt <= tf) return lerpXf(C, F, (tt - h) / Math.max(1e-6, tf - h));
  return lerpXf(F, hold, ease((tt - tf) / Math.max(1e-6, 1 - tf)));
}

// -------------------------------------------------------------------------------------------------
// Arms
// -------------------------------------------------------------------------------------------------
/** Close-up outline: tiny world width + ~2 px screen minimum, so ink stays thin at 3 cm and visible at 1 m. */
export const VIEWMODEL_OUTLINE = { thickness: 0.00011, minScreen: 0.0018 } as const;
let vmOutline: THREE.MeshBasicMaterial | null = null;
/** Shared viewmodel outline material (a private instance: its screen minimum is raised for close-up). */
export function viewmodelOutlineMaterial(): THREE.MeshBasicMaterial {
  if (!vmOutline) {
    vmOutline = outlineMaterial(VIEWMODEL_OUTLINE.thickness, palette.ink);
    const u = vmOutline.userData.outlineUniforms as { outlineMinScreen: { value: number } };
    u.outlineMinScreen.value = VIEWMODEL_OUTLINE.minScreen;
  }
  return vmOutline;
}

/** Swap every outline hull under `obj` to the thin viewmodel outline (call on held item models). */
export function applyViewmodelOutlines(obj: THREE.Object3D): void {
  const mat = viewmodelOutlineMaterial();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.name === 'outline') m.material = mat;
    if (m.isMesh) {
      m.castShadow = false;
      m.receiveShadow = false;
    }
  });
}

const wrap = (i: number, n: number) => ((Math.floor(i) % n) + n) % n;
const tubeZ = (r0: number, r1: number, len: number, seg: number, c: V3, color: number, outline?: boolean): Piece =>
  ({ geo: new THREE.CylinderGeometry(r1, r0, len, seg, 1, true).rotateX(H), color, matrix: xf(c), outline });

/** Hand + cuff + forearm in the hand-bone frame (fingers excluded). side +1 = right. */
function armPieces(side: 1 | -1, skin: number, sleeve: number, cuff: number): Piece[] {
  return [
    { geo: new THREE.SphereGeometry(1, 8, 6), color: skin, matrix: xf([0, 0, 0], [0, 0, 0], [0.047, 0.034, 0.05]) },
    { geo: new THREE.SphereGeometry(1, 6, 4), color: skin, matrix: xf([-side * 0.04, 0.004, -0.018], [0, side * 0.5, 0], [0.018, 0.017, 0.032]) },
    tubeZ(0.041, 0.041, 0.024, 8, [0, 0, 0.05], cuff, false),
    tubeZ(0.034, 0.042, 0.34, 8, [0, 0, 0.21], sleeve),
  ];
}
function fingerPieces(skin: number): Piece[] {
  return [{ geo: new THREE.SphereGeometry(1, 8, 5), color: skin, matrix: xf([0, -0.004, -0.028], [0, 0, 0], [0.044, 0.028, 0.04]) }];
}

const armCache = new Map<string, Merged>();
function cachedArm(key: string, make: () => Piece[]): Merged {
  let m = armCache.get(key);
  if (!m) armCache.set(key, (m = buildMerged(make(), `viewmodel:${key}`)));
  return m;
}

/** Arm colours from an appearance: skin; sleeve = outfit top for long sleeves, else skin; cuff = outfit accent. */
export function viewmodelArmColors(ap: Pick<Appearance, 'skin' | 'outfit'>): { skin: number; sleeve: number; cuff: number } {
  const skin = SKIN_TONES[wrap(ap.skin, SKIN_TONES.length)];
  const o = OUTFITS[wrap(ap.outfit, OUTFITS.length)];
  const long = outfitSleeve(ap.outfit) === 'long';
  return { skin, sleeve: long ? o.top : skin, cuff: long ? o.accent : o.style === 'hawaiian' || o.style === 'trunksTank' ? o.top : o.accent };
}

export interface ViewmodelRig {
  root: THREE.Group;
  itemSocket: THREE.Group;
  handR: THREE.Group;
  handL: THREE.Group;
  fingersR: THREE.Group;
  fingersL: THREE.Group;
  /** Currently held item id (null = none). */
  item: ViewmodelItemId | null;
  /** Level / scope of the current item (M2c). */
  itemOpts: ViewmodelItemOptions;
  /** Swap the held item model (cached per id + level + scope inside the rig). */
  setItem(id: ViewmodelItemId | null, opts?: ViewmodelItemOptions): void;
  /** Recolour the arms (skin, sleeve, cuff). */
  setAppearance(ap: Pick<Appearance, 'skin' | 'outfit'>): void;
}

function meshFor(m: Merged, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(m.geometry, vertexColorToon());
  mesh.name = name;
  if (m.outline) {
    const o = new THREE.Mesh(m.outline, viewmodelOutlineMaterial());
    o.name = 'outline';
    o.raycast = () => {};
    mesh.add(o);
  }
  return mesh;
}

/** Held item model for the viewmodel (thin outlines, no shadows), or null for fists. M2c: level and scope. */
export function createViewmodelItem(id: ViewmodelItemId, opts: ViewmodelItemOptions = {}): THREE.Object3D | null {
  let obj: THREE.Object3D | null = null;
  if (id === 'grenade' || id === 'grenade_cooking') obj = createGrenadeModel({ pin: id === 'grenade' });
  else if (id === 'smoke' || id === 'smoke_cooking') obj = createSmokeModel({ pin: id === 'smoke' });
  else if (id === 'bandage' || id === 'medkit') {
    const g = getLootItemGeometry(id);
    if (g) {
      const holder = new THREE.Group();
      g.merged.geometry.computeBoundingBox();
      const mesh = meshFor(g.merged, 'item');
      mesh.position.copy(g.merged.geometry.boundingBox!.getCenter(new THREE.Vector3()).negate());
      holder.add(mesh);
      obj = holder;
    }
  } else if (id !== 'fists') obj = createWeaponModel(id, { level: opts.level ?? null, scope: opts.scope ?? null });
  if (obj) {
    obj.name = `vmItem:${id}`;
    applyViewmodelOutlines(obj);
  }
  return obj;
}

/** First-person arms rig for one appearance. Add `root` to the viewmodel scene at the viewmodel camera. */
export function createViewmodel(appearance: Pick<Appearance, 'skin' | 'outfit'>): ViewmodelRig {
  const root = new THREE.Group();
  root.name = 'viewmodel';
  const itemSocket = new THREE.Group();
  itemSocket.name = 'itemSocket';
  root.add(itemSocket);
  const mkHand = (side: 1 | -1) => {
    const hand = new THREE.Group();
    hand.name = side > 0 ? 'handR' : 'handL';
    const fingers = new THREE.Group();
    fingers.name = side > 0 ? 'fingersR' : 'fingersL';
    fingers.position.set(0, 0, -0.03);
    hand.add(fingers);
    root.add(hand);
    return { hand, fingers };
  };
  const R = mkHand(1);
  const L = mkHand(-1);
  const items = new Map<string, THREE.Object3D | null>();

  const rig: ViewmodelRig = {
    root, itemSocket, handR: R.hand, handL: L.hand, fingersR: R.fingers, fingersL: L.fingers, item: null, itemOpts: {},
    setItem(id, opts = {}) {
      for (const c of [...itemSocket.children]) itemSocket.remove(c);
      rig.item = id;
      rig.itemOpts = { level: opts.level ?? null, scope: opts.scope ?? null };
      if (!id) return;
      const key = `${id}|${opts.level ?? '-'}|${opts.scope ?? '-'}`;
      let obj = items.get(key);
      if (obj === undefined) items.set(key, (obj = createViewmodelItem(id, opts)));
      if (obj) itemSocket.add(obj);
    },
    setAppearance(ap) {
      const c = viewmodelArmColors(ap);
      const key = `${c.skin}|${c.sleeve}|${c.cuff}`;
      for (const [side, h] of [[1, R], [-1, L]] as const) {
        for (const ch of [...h.hand.children]) if ((ch as THREE.Mesh).isMesh) h.hand.remove(ch);
        for (const ch of [...h.fingers.children]) h.fingers.remove(ch);
        h.hand.add(meshFor(cachedArm(`arm${side}|${key}`, () => armPieces(side, c.skin, c.sleeve, c.cuff)), 'arm'));
        h.fingers.add(meshFor(cachedArm(`fingers|${c.skin}`, () => fingerPieces(c.skin)), 'fingers'));
      }
    },
  };
  rig.setAppearance(appearance);
  return rig;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _scaleOut = new THREE.Vector3();

/**
 * Put the rig in the reference pose for `id`, blended hip -> ADS by `ads` (0..1). Sets the item, item socket,
 * hand bones (from the item-space targets) and finger curl. Animation offsets go on top (STYLE.md §21).
 */
export function applyViewmodelPose(rig: ViewmodelRig, id: ViewmodelItemId, ads = 0, opts?: ViewmodelItemOptions): void {
  const o = opts ?? (rig.item === id ? rig.itemOpts : {});
  const p = viewmodelPoseFor(id, o);
  if (rig.item !== id || (opts && ((opts.level ?? null) !== (rig.itemOpts.level ?? null) || (opts.scope ?? null) !== (rig.itemOpts.scope ?? null)))) rig.setItem(id, o);
  const k = Math.min(1, Math.max(0, ads));
  const s = rig.itemSocket;
  s.position.set(
    p.hip.pos[0] + (p.ads.pos[0] - p.hip.pos[0]) * k,
    p.hip.pos[1] + (p.ads.pos[1] - p.hip.pos[1]) * k,
    p.hip.pos[2] + (p.ads.pos[2] - p.hip.pos[2]) * k,
  );
  _q.setFromEuler(_e.set(p.hip.rot[0], p.hip.rot[1], p.hip.rot[2]));
  _q2.setFromEuler(_e.set(p.ads.rot[0], p.ads.rot[1], p.ads.rot[2]));
  s.quaternion.copy(_q).slerp(_q2, k);
  s.scale.setScalar(p.itemScale);
  s.updateMatrix();
  const place = (bone: THREE.Object3D, t: VmXf | null) => {
    bone.visible = !!t;
    if (!t) return;
    // item-space target -> camera space; positions follow the item scale, the hand size does not
    _p.set(t.pos[0] * p.itemScale, t.pos[1] * p.itemScale, t.pos[2] * p.itemScale);
    _m2.compose(_p, _q.setFromEuler(_e.set(t.rot[0], t.rot[1], t.rot[2])), _s);
    _m.compose(s.position, s.quaternion, _s).multiply(_m2);
    _m.decompose(bone.position, bone.quaternion, _scaleOut);
  };
  place(rig.handR, p.handR);
  place(rig.handL, p.handL);
  rig.fingersR.rotation.x = p.curlR;
  rig.fingersL.rotation.x = p.curlL;
}
