/**
 * One chibi per player from FrameView (interpolated remotes, predicted local). Pooled views, held item in the right
 * hand (guns, M2a grenade), procedural animation (characterPose.ts) with M2a stance blending, worn armor merged into
 * the skinned mesh (chibiSkin.ts), hit flash, death topple / prone side roll + poof, outline LOD, remote scope glint
 * and the cooking-grenade fuse spark. Owner: graphics-engineer.
 */
import * as THREE from 'three';
import { isScopeSight, sightOf, type Balance } from '../shared/balance';
import type { PlayerView } from '../shared/contracts';
import type { DropPhase, HeldId, PlayerAnim, PlayerDropFields, PlayerId, PlayerState, SightType, Vec3 } from '../shared/types';
import { computePose, DEATH_POOF_AT_S, makePose, stanceBlend, type Pose, type PoseInput, type StanceBlend } from './characterPose';
import { skinChibi, skinKey, type ChibiWear, type SkinnedChibi } from './chibiSkin';
import {
  createCharacter, createGrenadeModel, createParachute, createWeaponModel, getWeaponSight, GRENADE_DIMENSIONS,
  setParachuteDeploy, type CharacterModel,
} from './procedural';
import { PARTICLE_SHAPE } from './shaders/particles';
import type { Markers } from './vfx/Markers';

/** Metres per full walk cycle (visual) by stance: crouch steps and the prone frog-kick are shorter. */
const STRIDE_M = 1.15;
const STRIDE_CROUCH_M = 0.9;
const STRIDE_PRONE_M = 0.62;
const RECOIL_DECAY = 12; // 1/s
const HIT_DECAY = 7;
const HIT_FLASH_S = 0.09;
/** Stance weight smoothing (1/s): hides snapshot steps and interrupted transitions without visible lag. */
const STANCE_SMOOTH = 22;
/** Remote ADS pose smoothing (1/s); anim.ads is a boolean. */
const ADS_SMOOTH = 10;
/** Fuse spark pop interval while cooking (s), and in the last second of the fuse. STYLE.md §15. */
const SPARK_INTERVAL_S = 0.12;
const SPARK_INTERVAL_FAST_S = 0.06;
/**
 * Followed-character fade (camera pulled in by a rock, wall or slope): fully visible beyond FADE_FAR metres from the
 * camera to the body axis, fully hidden inside FADE_NEAR. Outline hulls hide as soon as fading starts (an inverted
 * hull seen through a translucent body reads as a dark smudge); the held weapon hides below WEAPON_MIN_ALPHA.
 */
const FADE_NEAR = 0.45;
const FADE_FAR = 1.15;
const WEAPON_MIN_ALPHA = 0.6;
/** M2b parachute timings (STYLE.md §20.2): deploy pop and the collapse after landing (s). */
export const CHUTE_DEPLOY_S = 0.35;
export const CHUTE_COLLAPSE_S = 0.4;
/** Steering estimate smoothing (1/s). */
const STEER_SMOOTH = 6;
const DEG = Math.PI / 180;

/** PlayerState with the C-gate drop fields (present on the wire from the M2b server; optional until the gate). */
type DropAware = PlayerState & Partial<PlayerDropFields>;
/** Drop phase of a player for the pose: null when not dropping; a pre-gate drop (no dropPhase) is freefall. */
export function dropPhaseOf(s: PlayerState): DropPhase | null {
  if (!s.anim.dropping) return null;
  return (s as DropAware).dropPhase ?? 'freefall';
}
/** True while riding the carrier (not drawn; the carrier model stands in). */
export function isAboard(s: PlayerState): boolean {
  return (s as DropAware).aboard === true;
}

/**
 * Parachute deploy value for setParachuteDeploy from the drop phase and its timers: 0 packed (freefall), 0..1 opening
 * over CHUTE_DEPLOY_S after the chute opens, 1..2 collapsing over CHUTE_COLLAPSE_S after landing, -1 = not shown.
 * Pure; exported for tests.
 */
export function chuteDeployValue(phase: DropPhase | null, sinceChute: number, sinceLand: number): number {
  if (phase === 'freefall') return 0;
  if (phase === 'chute') return Math.min(1, Math.max(0, sinceChute) / CHUTE_DEPLOY_S);
  if (sinceLand >= 0 && sinceLand < CHUTE_COLLAPSE_S) return 1 + sinceLand / CHUTE_COLLAPSE_S;
  return -1;
}

/** Scope glint: visible when the scope's line of sight is within ~30 deg of the camera, full within ~8 deg. */
export const GLINT_COS_MIN = Math.cos((30 * Math.PI) / 180);
export const GLINT_COS_FULL = Math.cos((8 * Math.PI) / 180);
/** On-screen glint size (px at 1080p-equivalent scale), from faint to full. */
const GLINT_PX_MIN = 10;
const GLINT_PX_MAX = 30;
/** Distance from the sight's eye anchor forward to the objective lens (m), per scope. */
const GLINT_FORWARD: Partial<Record<SightType, number>> = { scope_4x: 0.34, scope_8x: 0.54 };

/** Glint is shown only on living remote players who are aiming a scoped weapon. Pure; exported for tests. */
export function scopeGlintVisible(isLocal: boolean, alive: boolean, anim: Pick<PlayerAnim, 'ads'>, sight: SightType): boolean {
  return !isLocal && alive && !!anim.ads && isScopeSight(sight);
}

/**
 * Glint strength 0..1 from the scope's forward axis `f` and the unit direction from the lens to the camera `t`
 * (both unit vectors): smoothstep between GLINT_COS_MIN and GLINT_COS_FULL. Pure; exported for tests.
 */
export function glintStrength(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): number {
  const d = fx * tx + fy * ty + fz * tz;
  const k = (d - GLINT_COS_MIN) / (GLINT_COS_FULL - GLINT_COS_MIN);
  const c = k < 0 ? 0 : k > 1 ? 1 : k;
  return c * c * (3 - 2 * c);
}

interface View {
  id: PlayerId;
  model: CharacterModel;
  skin: SkinnedChibi;
  outlines: THREE.Object3D[];
  colourMeshes: THREE.Mesh[];
  /** Held models by key (weapon id, 'grenade:pin', 'grenade:cook'); null = nothing in hand (fists). */
  held: Map<string, THREE.Object3D | null>;
  heldKey: string;
  heldObj: THREE.Object3D | null;
  baseKey: string;
  wear: ChibiWear;
  walkPhase: number;
  lastX: number;
  lastZ: number;
  speed: number;
  recoil: number;
  hit: number;
  hitFlash: number;
  flashing: boolean;
  /** Client time of death, or -1. */
  diedAt: number;
  poofed: boolean;
  seed: number;
  seen: number;
  pose: Pose;
  /** Smoothed stance weights (frozen at death). */
  blend: StanceBlend;
  blendInit: boolean;
  ads: number;
  /** Server ms the cooking grenade explodes (from grenadeCooked), or 0. */
  cookExplodesAt: number;
  sparkT: number;
  /** M2b drop: parachute (lazy, on the stance pivot), last phase, client time the chute opened / we landed. */
  chute: THREE.Object3D | null;
  dropPhase: DropPhase | null;
  chuteAt: number;
  landAt: number;
  velX: number;
  velZ: number;
}

export interface PlayerViewsEvents {
  /** Called once when a dead body should vanish in a puff. */
  onPoof(x: number, y: number, z: number): void;
  /** Cooking grenade fuse spark at the fuse (world). */
  onFuseSpark?(x: number, y: number, z: number): void;
}

/** Per-frame options for PlayerViews.update. */
export interface PlayerViewsFrame {
  time: number;
  dt: number;
  /** Server ms (FrameView.serverTime) for the fuse timers. */
  serverTime: number;
  cam: THREE.Vector3;
  /** Over-the-shoulder camera: the followed character fades when the camera is close. */
  follow: boolean;
  /**
   * M2b first person (CameraView.firstPerson): this player's body, armor, held item and parachute are not drawn (the
   * FP subject: CameraView.subjectId, else the local player). Null in the 3P cases.
   */
  hideId: PlayerId | null;
  /** Local ADS weapon pose (FrameView.ads.cameraBlend), 0 when none. */
  localAds: number;
}

const _blend: StanceBlend = { crouch: 0, prone: 0 };
const _wear: ChibiWear = { vest: 0, helmet: 0 };
const GLINT_RGB: [number, number, number] = [1, 0.97, 0.82];

export class PlayerViews {
  readonly group = new THREE.Group();
  private readonly views = new Map<PlayerId, View>();
  private readonly pool: View[] = [];
  private readonly flashMaterial: THREE.MeshBasicMaterial;
  /** Translucent clone of the chibi toon material, created on first use (only the followed character fades). */
  private fadeMaterial: THREE.Material | null = null;
  private frame = 0;
  private time = 0;
  private outlineDist2 = 45 * 45;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly removeList: PlayerId[] = [];
  private markers: Markers | null = null;
  private crawlSpeed = 1;
  private freefallSteer = 14;
  private chuteSteer = 6;
  private pronePitchMin: number | undefined;
  private pronePitchMax: number | undefined;
  /** Reused every call (no per-player per-frame allocation). */
  private readonly poseIn: PoseInput = {
    time: 0,
    anim: { moving: false, sprinting: false, airborne: false, dropping: false, inWater: false, firing: false, reloading: false, healing: false, ads: false, cooking: false },
    weapon: 'fists', pitch: 0, speed: 0, sprintSpeed: 1, crawlSpeed: 1, velY: 0, walkPhase: 0, recoil: 0, hit: 0, deathTime: -1,
    seed: 0, crouch: 0, prone: 0, ads: 0, deathSide: 1, dropPhase: null, chute: 0, steerX: 0, steerZ: 0,
  };

  constructor(
    private balance: Balance,
    private readonly events: PlayerViewsEvents,
  ) {
    this.group.name = 'players';
    this.flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.flashMaterial.name = 'chibi:hitFlash';
    this.setBalance(balance);
  }

  /** M2b: the per-match balance (mapChanged.balance). */
  setBalance(balance: Balance): void {
    this.balance = balance;
    const mv = balance.movement;
    this.crawlSpeed = mv.walkSpeed * (mv.stances?.prone?.speedMultiplier ?? 0.25);
    this.freefallSteer = Math.max(0.1, balance.drop?.freefallSteerSpeed ?? 14);
    this.chuteSteer = Math.max(0.1, mv.dropSteerSpeed ?? 6);
    const st = mv.stances;
    this.pronePitchMin = st?.pronePitchMinDeg !== undefined ? st.pronePitchMinDeg * DEG : undefined;
    this.pronePitchMax = st?.pronePitchMaxDeg !== undefined ? st.pronePitchMaxDeg * DEG : undefined;
  }

  setOutlineDistance(d: number): void {
    this.outlineDist2 = d * d;
  }

  /** Marker batch for scope glints (Renderer owns begin/end). */
  setMarkers(m: Markers): void {
    this.markers = m;
  }

  private static wearOf(p: PlayerView, out: ChibiWear): ChibiWear {
    out.vest = p.state.vestTier ?? 0;
    out.helmet = p.state.helmetTier ?? 0;
    return out;
  }

  private acquire(p: PlayerView): View {
    const ap = p.state.appearance;
    const baseKey = `${ap.skin}|${ap.outfit}|${ap.hair}`;
    const wear = PlayerViews.wearOf(p, _wear);
    let v = this.pool.pop();
    if (v) {
      this.setLook(v, baseKey, wear, p);
    } else {
      const model = createCharacter(ap);
      if (wear.helmet > 0) model.chibi.setVariant({ helmet: true });
      const key = skinKey(ap.skin, ap.outfit, ap.hair, wear);
      // 12 part meshes (+ armor) -> 1 skinned colour mesh + 1 skinned outline (see chibiSkin.ts).
      const skin = skinChibi(model, key, wear);
      const outlines: THREE.Object3D[] = [skin.outline];
      const colourMeshes: THREE.Mesh[] = [skin.colour];
      model.root.rotation.order = 'YXZ';
      v = {
        id: p.state.id, model, skin, outlines, colourMeshes, held: new Map(), heldKey: '', heldObj: null, baseKey,
        wear: { vest: wear.vest, helmet: wear.helmet }, walkPhase: 0, lastX: 0, lastZ: 0, speed: 0, recoil: 0, hit: 0,
        hitFlash: 0, flashing: false, diedAt: -1, poofed: false, seed: 0, seen: 0, pose: makePose(),
        blend: { crouch: 0, prone: 0 }, blendInit: false, ads: 0, cookExplodesAt: 0, sparkT: 0,
        chute: null, dropPhase: null, chuteAt: -1, landAt: -1, velX: 0, velZ: 0,
      };
    }
    v.id = p.state.id;
    v.seed = (p.state.id * 1.618) % 7;
    v.lastX = p.state.pos.x;
    v.lastZ = p.state.pos.z;
    v.speed = 0;
    v.recoil = 0;
    v.hit = 0;
    v.hitFlash = 0;
    v.blendInit = false;
    v.ads = 0;
    v.cookExplodesAt = 0;
    v.sparkT = 0;
    v.dropPhase = null;
    v.chuteAt = -1;
    v.landAt = -1;
    v.velX = 0;
    v.velZ = 0;
    if (v.chute) v.chute.visible = false;
    this.setMaterialState(v, false, 1);
    // Joined mid-match / first seen already dead: no topple, just absent.
    v.diedAt = -1;
    v.poofed = !p.state.alive;
    v.model.root.visible = p.state.alive;
    v.model.chibi.resetPose();
    this.group.add(v.model.root);
    this.views.set(v.id, v);
    return v;
  }

  /** Appearance or worn armor changed: swap hair variant and the merged skinned geometry (cached per key). */
  private setLook(v: View, baseKey: string, wear: ChibiWear, p: PlayerView): void {
    if (v.baseKey === baseKey && v.wear.vest === wear.vest && v.wear.helmet === wear.helmet) return;
    const ap = p.state.appearance;
    v.model.chibi.setVariant({ skin: ap.skin, outfit: ap.outfit, hair: ap.hair, helmet: wear.helmet > 0 });
    v.skin.setAppearanceKey(skinKey(ap.skin, ap.outfit, ap.hair, wear), wear);
    v.baseKey = baseKey;
    v.wear.vest = wear.vest;
    v.wear.helmet = wear.helmet;
  }

  private release(v: View): void {
    this.group.remove(v.model.root);
    this.views.delete(v.id);
    this.pool.push(v);
  }

  private setHeld(v: View, w: HeldId, cooking: boolean): void {
    const key = w === 'grenade' ? (cooking ? 'grenade:cook' : 'grenade:pin') : w;
    if (v.heldKey === key) return;
    if (v.heldObj) v.model.handR.remove(v.heldObj);
    let obj = v.held.get(key);
    if (obj === undefined) {
      if (w === 'grenade') {
        obj = createGrenadeModel({ pin: !cooking });
        const o = GRENADE_DIMENSIONS.handOffset;
        obj.position.set(o[0], o[1], o[2]);
      } else {
        obj = createWeaponModel(w);
      }
      v.held.set(key, obj);
      if (obj) obj.traverse((o) => o.name === 'outline' && v.outlines.push(o));
    }
    if (obj) v.model.handR.add(obj);
    v.heldObj = obj;
    v.heldKey = key;
  }

  /** Hit flash wins over fade; otherwise a translucent material while fading, else the shared toon material. */
  private setMaterialState(v: View, flash: boolean, fade: number): void {
    v.flashing = flash;
    for (const m of v.colourMeshes) {
      const base = (m.userData.baseMaterial ??= m.material) as THREE.Material;
      let target = base;
      if (flash) target = this.flashMaterial;
      else if (fade < 0.999) target = this.getFadeMaterial(base, fade);
      if (m.material !== target) m.material = target;
    }
  }

  private getFadeMaterial(base: THREE.Material, alpha: number): THREE.Material {
    if (!this.fadeMaterial) {
      const mat = base.clone();
      mat.name = 'chibi:fade';
      mat.transparent = true;
      mat.depthWrite = true; // one mesh: keep self-occlusion so the far side does not show through
      this.fadeMaterial = mat;
    }
    this.fadeMaterial.opacity = alpha;
    return this.fadeMaterial;
  }

  /** Bus hooks (Vfx forwards these). */
  onShot(id: PlayerId): void {
    const v = this.views.get(id);
    if (v) v.recoil = 1;
  }

  /** grenadeThrown (not dropped): throw follow-through. */
  onThrow(id: PlayerId): void {
    const v = this.views.get(id);
    if (!v) return;
    v.recoil = 1;
    v.cookExplodesAt = 0;
  }

  /** grenadeCooked: start the in-hand fuse spark clock. */
  onCooked(id: PlayerId, explodesAt: number): void {
    const v = this.views.get(id);
    if (!v) return;
    v.cookExplodesAt = explodesAt;
    v.sparkT = 0;
  }

  onDamaged(id: PlayerId): void {
    const v = this.views.get(id);
    if (!v) return;
    v.hit = 1;
    v.hitFlash = HIT_FLASH_S;
  }

  onKilled(id: PlayerId): boolean {
    const v = this.views.get(id);
    if (!v || v.poofed) return false;
    if (v.diedAt < 0) v.diedAt = this.time;
    return true;
  }

  /** World position of the muzzle (or right hand for fists / grenade). False if the player has no view. */
  getMuzzle(id: PlayerId, out: Vec3): boolean {
    const v = this.views.get(id);
    if (!v || !v.model.root.visible) return false;
    const muzzle = v.heldObj?.getObjectByName('muzzle') ?? v.model.handR;
    muzzle.getWorldPosition(this.tmp);
    out.x = this.tmp.x;
    out.y = this.tmp.y;
    out.z = this.tmp.z;
    return true;
  }

  /** Visual stance weights of a player (for anchors such as name tags), or null without a view. */
  getStanceBlend(id: PlayerId): Readonly<StanceBlend> | null {
    return this.views.get(id)?.blend ?? null;
  }

  getRoot(id: PlayerId): THREE.Object3D | null {
    return this.views.get(id)?.model.root ?? null;
  }

  update(players: readonly PlayerView[], f: PlayerViewsFrame): void {
    const { time, dt, cam } = f;
    this.time = time;
    this.frame++;
    const sprint = this.balance.movement.sprintSpeed;
    const kStance = 1 - Math.exp(-dt * STANCE_SMOOTH);
    const kAds = 1 - Math.exp(-dt * ADS_SMOOTH);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const s = p.state;
      let v = this.views.get(s.id);
      if (!v) v = this.acquire(p);
      v.seen = this.frame;
      this.setLook(v, `${s.appearance.skin}|${s.appearance.outfit}|${s.appearance.hair}`, PlayerViews.wearOf(p, _wear), p);

      // Revived (new match reusing an id): clear death state. The kill event arrives ~INTERP_DELAY before the
      // interpolated state says alive = false, so a recent death is never undone by a stale alive flag.
      if (s.alive && (v.diedAt >= 0 ? time - v.diedAt > 3 : v.poofed)) {
        v.diedAt = -1;
        v.poofed = false;
        v.blendInit = false;
        v.model.root.visible = true;
        v.model.root.scale.setScalar(1);
      }
      // Died without a playerKilled event reaching us (or before it): start the topple now.
      if (!s.alive && v.diedAt < 0 && !v.poofed) v.diedAt = time;

      // Stance weights: smoothed toward the snapshot's transition; frozen once dead (the body stays as it fell).
      if (v.diedAt < 0) {
        stanceBlend(s.stance ?? 'stand', s.stanceFrom ?? s.stance ?? 'stand', s.stanceProgress ?? 1, _blend);
        if (!v.blendInit) {
          v.blend.crouch = _blend.crouch;
          v.blend.prone = _blend.prone;
          v.blendInit = true;
        } else {
          v.blend.crouch += (_blend.crouch - v.blend.crouch) * kStance;
          v.blend.prone += (_blend.prone - v.blend.prone) * kStance;
        }
      }
      const adsTarget = p.isLocal ? f.localAds : s.anim.ads ? 1 : 0;
      v.ads = p.isLocal ? adsTarget : v.ads + (adsTarget - v.ads) * kAds;

      // Speed estimate from rendered positions (works for predicted and interpolated states).
      if (dt > 1e-4) {
        const dx = s.pos.x - v.lastX, dz = s.pos.z - v.lastZ;
        const dist = Math.hypot(dx, dz);
        const inst = dist / dt;
        const sp = inst > 30 ? 0 : inst; // teleport guard
        v.speed += (sp - v.speed) * (1 - Math.exp(-dt * 12));
        const ks = 1 - Math.exp(-dt * STEER_SMOOTH);
        v.velX += ((inst > 30 ? 0 : dx / dt) - v.velX) * ks;
        v.velZ += ((inst > 30 ? 0 : dz / dt) - v.velZ) * ks;
        const c = v.blend.crouch, pr = v.blend.prone;
        const stride = STRIDE_M + (STRIDE_CROUCH_M - STRIDE_M) * c + (STRIDE_PRONE_M - STRIDE_CROUCH_M) * pr;
        v.walkPhase = (v.walkPhase + ((dist > 2 ? 0 : dist) / stride) * Math.PI * 2) % (Math.PI * 200);
      }
      v.lastX = s.pos.x;
      v.lastZ = s.pos.z;
      v.recoil *= Math.exp(-dt * RECOIL_DECAY);
      v.hit *= Math.exp(-dt * HIT_DECAY);
      v.hitFlash -= dt;

      // M2b drop phase timers (pose blend and parachute), tracked even while hidden so FP -> 3P stays continuous.
      const phase = dropPhaseOf(s);
      if (phase !== v.dropPhase) {
        if (phase === 'chute') v.chuteAt = time;
        if (phase === null && v.dropPhase === 'chute') v.landAt = time;
        if (phase !== null) v.landAt = -1;
        v.dropPhase = phase;
      }

      const root = v.model.root;
      // First person (M2b; M2a scope view): the subject's body, armor and held item are not drawn. Aboard players
      // ride inside the carrier model.
      if (s.id === f.hideId || isAboard(s)) {
        root.visible = false;
        continue;
      }
      const flash = v.hitFlash > 0 && s.alive;
      const fade = f.follow && (p.isLocal || p.isSpectateTarget) ? bodyFade(s.pos, this.stanceHeight(v), cam) : 1;
      this.setMaterialState(v, flash, fade);

      if (v.poofed) {
        root.visible = false;
        continue;
      }
      const deathTime = v.diedAt >= 0 ? time - v.diedAt : -1;
      if (deathTime >= DEATH_POOF_AT_S) {
        v.poofed = true;
        root.visible = false;
        this.events.onPoof(s.pos.x, s.pos.y + 0.5 - 0.3 * v.blend.prone, s.pos.z);
        continue;
      }

      const cooking = s.weapon === 'grenade' && !!s.anim.cooking;
      this.setHeld(v, s.weapon, cooking);
      const pi = this.poseIn;
      pi.time = time;
      pi.anim = s.anim;
      pi.weapon = s.weapon;
      pi.pitch = s.pitch;
      pi.speed = v.speed;
      pi.sprintSpeed = sprint;
      pi.crawlSpeed = this.crawlSpeed;
      pi.velY = s.velY;
      pi.walkPhase = v.walkPhase;
      pi.recoil = v.recoil;
      pi.hit = v.hit;
      pi.deathTime = deathTime;
      pi.seed = v.seed;
      pi.crouch = v.blend.crouch;
      pi.prone = v.blend.prone;
      pi.ads = v.ads;
      pi.deathSide = s.id % 2 === 0 ? 1 : -1;
      pi.pronePitchMin = this.pronePitchMin;
      pi.pronePitchMax = this.pronePitchMax;
      pi.dropPhase = phase;
      pi.chute = phase === 'chute' ? Math.min(1, (time - v.chuteAt) / CHUTE_DEPLOY_S) : 0;
      if (phase) {
        const ref = phase === 'chute' ? this.chuteSteer : this.freefallSteer;
        const sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
        pi.steerX = (v.velX * cy - v.velZ * sy) / ref;
        pi.steerZ = (-v.velX * sy - v.velZ * cy) / ref;
      } else {
        pi.steerX = 0;
        pi.steerZ = 0;
      }
      const pose = computePose(pi, v.pose);
      this.applyPose(v, pose);
      this.updateChute(v, phase, time, deathTime);
      root.position.set(s.pos.x, s.pos.y, s.pos.z);
      root.rotation.set(pose.rootTiltX, s.yaw, pose.rootTiltZ);
      root.visible = fade > 0.02;
      if (v.heldObj && fade < WEAPON_MIN_ALPHA) v.heldObj.visible = false;

      const d2 = (s.pos.x - cam.x) ** 2 + (s.pos.y - cam.y) ** 2 + (s.pos.z - cam.z) ** 2;
      const showOutline = d2 < this.outlineDist2 && fade >= 0.999;
      for (let k = 0; k < v.outlines.length; k++) v.outlines[k].visible = showOutline;

      if (deathTime < 0 && root.visible) {
        if (cooking && v.heldObj?.visible) this.fuseSpark(v, f);
        if (scopeGlintVisible(p.isLocal, s.alive, s.anim, s.weapon === 'grenade' ? 'none' : sightOf(this.balance, s.weapon))) {
          this.glint(v, s.weapon, cam, time);
        }
      }
    }

    // Players no longer in the view list (left / new match): return to the pool.
    this.removeList.length = 0;
    for (const v of this.views.values()) if (v.seen !== this.frame) this.removeList.push(v.id);
    for (const id of this.removeList) {
      const v = this.views.get(id);
      if (v) this.release(v);
    }
  }

  /** Visual body height for the fade axis: standing height, lower when crouched or prone. */
  private stanceHeight(v: View): number {
    const st = this.balance.movement.stances;
    const h = this.balance.player.height;
    if (!st) return h;
    const hc = h + (st.crouch.height - h) * v.blend.crouch;
    return hc + (st.prone.height - hc) * v.blend.prone;
  }

  private fuseSpark(v: View, f: PlayerViewsFrame): void {
    const remaining = v.cookExplodesAt > 0 ? v.cookExplodesAt - f.serverTime : Infinity;
    const interval = remaining <= 1000 ? SPARK_INTERVAL_FAST_S : SPARK_INTERVAL_S;
    v.sparkT -= f.dt;
    if (v.sparkT > 0) return;
    v.sparkT += interval;
    if (v.sparkT < 0) v.sparkT = interval;
    const fuse = v.heldObj?.getObjectByName('fuse');
    if (!fuse || !this.events.onFuseSpark) return;
    v.model.root.updateMatrixWorld(true);
    fuse.getWorldPosition(this.tmp);
    this.events.onFuseSpark(this.tmp.x, this.tmp.y, this.tmp.z);
  }

  /** Scope glint at the objective lens (sight anchor + forward), sized in screen pixels so it reads at any range. */
  private glint(v: View, weapon: HeldId, cam: THREE.Vector3, time: number): void {
    const m = this.markers;
    const obj = v.heldObj;
    if (!m || !obj || weapon === 'grenade') return;
    const sight = getWeaponSight(weapon);
    if (!sight) return;
    v.model.root.updateMatrixWorld(true);
    // Forward (-Z of the weapon frame) and the lens point in world space.
    obj.getWorldQuaternion(this.quat);
    const fwd = this.tmp2.set(0, 0, -1).applyQuaternion(this.quat);
    const ahead = GLINT_FORWARD[sight.type] ?? 0.3;
    const lens = this.tmp.set(sight.rear[0], sight.rear[1], sight.rear[2] - ahead);
    obj.localToWorld(lens);
    const tx = cam.x - lens.x, ty = cam.y - lens.y, tz = cam.z - lens.z;
    const dist = Math.hypot(tx, ty, tz) || 1;
    const k = glintStrength(fwd.x, fwd.y, fwd.z, tx / dist, ty / dist, tz / dist);
    if (k <= 0.01) return;
    const twinkle = 0.85 + 0.15 * Math.sin(time * 9 + v.seed * 3);
    const px = (GLINT_PX_MIN + (GLINT_PX_MAX - GLINT_PX_MIN) * k) * twinkle;
    const size = Math.max(0.12, m.worldSizeForPixels(px, dist));
    // Nudge toward the camera so the gun's own hull never hides it.
    const nx = lens.x + (tx / dist) * 0.06, ny = lens.y + (ty / dist) * 0.06, nz = lens.z + (tz / dist) * 0.06;
    m.add(nx, ny, nz, size, GLINT_RGB[0], GLINT_RGB[1], GLINT_RGB[2], Math.min(1, 0.35 + k), PARTICLE_SHAPE.flash, time * 0.6 + v.seed);
  }

  /** Parachute on the stance pivot: packed in freefall, deploy pop, collapse after landing, then hidden. */
  private updateChute(v: View, phase: DropPhase | null, time: number, deathTime: number): void {
    const k = deathTime >= 0 ? -1 : chuteDeployValue(phase, time - v.chuteAt, v.landAt >= 0 ? time - v.landAt : -1);
    if (k < 0) {
      if (v.chute) v.chute.visible = false;
      return;
    }
    if (!v.chute) {
      v.chute = createParachute({ stripe: v.id, deploy: 0 });
      v.model.chibi.parts.stance.add(v.chute);
    }
    v.chute.visible = true;
    setParachuteDeploy(v.chute, k);
  }

  private applyPose(v: View, p: Pose): void {
    const m = v.model;
    const st = m.chibi.parts.stance;
    st.rotation.set(p.stanceX, p.stanceRotY, 0);
    st.position.set(0, p.stanceY, p.stanceZ);
    const hipY = m.body.userData.restY ?? (m.body.userData.restY = m.body.position.y);
    m.body.position.y = (hipY as number) + p.bodyY;
    m.body.rotation.set(p.bodyX, p.bodyY_rot, p.bodyZ);
    m.head.rotation.set(p.headX, p.headY, 0);
    m.armL.rotation.set(p.armLX, p.armLY, p.armLZ);
    m.armR.rotation.set(p.armRX, p.armRY, p.armRZ);
    m.legL.rotation.set(p.legLX, 0, p.legLZ);
    m.legR.rotation.set(p.legRX, 0, p.legRZ);
    m.root.scale.setScalar(p.scale);
    if (v.heldObj) v.heldObj.visible = p.weaponVisible;
  }

  clear(): void {
    for (const v of [...this.views.values()]) this.release(v);
  }

  dispose(): void {
    this.clear();
    for (const v of this.pool) v.skin.dispose();
    this.pool.length = 0;
    this.flashMaterial.dispose();
    this.fadeMaterial?.dispose();
    this.group.clear();
  }
}

/**
 * Opacity for a followed character: smoothstep of the camera's distance to the body axis (feet + 0.15 m up to the
 * top of the head). Pure; exported for tests.
 */
export function bodyFade(feet: Vec3, height: number, cam: { x: number; y: number; z: number }): number {
  const top = Math.max(feet.y + 0.15, feet.y + height);
  const y = Math.min(Math.max(cam.y, feet.y + 0.15), top);
  const d = Math.hypot(cam.x - feet.x, cam.y - y, cam.z - feet.z);
  const t = Math.min(1, Math.max(0, (d - FADE_NEAR) / (FADE_FAR - FADE_NEAR)));
  return t * t * (3 - 2 * t);
}
