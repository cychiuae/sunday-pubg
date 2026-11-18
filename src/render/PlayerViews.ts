/**
 * One chibi per player from FrameView (interpolated remotes, predicted local). Pooled views, weapon models in the
 * right hand, procedural animation (characterPose.ts), hit flash, death topple + poof, outline LOD.
 * Owner: graphics-engineer.
 */
import * as THREE from 'three';
import type { Balance } from '../shared/balance';
import type { PlayerView } from '../shared/contracts';
import type { PlayerId, Vec3, WeaponId } from '../shared/types';
import { computePose, DEATH_POOF_AT_S, makePose, type Pose, type PoseInput } from './characterPose';
import { skinChibi, type SkinnedChibi } from './chibiSkin';
import { createCharacter, createWeaponModel, type CharacterModel } from './procedural';

const STRIDE_M = 1.15; // metres per full walk cycle (visual)
const RECOIL_DECAY = 12; // 1/s
const HIT_DECAY = 7;
const HIT_FLASH_S = 0.09;

interface View {
  id: PlayerId;
  model: CharacterModel;
  skin: SkinnedChibi;
  outlines: THREE.Object3D[];
  colourMeshes: THREE.Mesh[];
  weapons: Map<WeaponId, THREE.Object3D | null>;
  weaponId: WeaponId | null;
  weaponObj: THREE.Object3D | null;
  appearanceKey: string;
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
}

export interface PlayerViewsEvents {
  /** Called once when a dead body should vanish in a puff. */
  onPoof(x: number, y: number, z: number): void;
}

export class PlayerViews {
  readonly group = new THREE.Group();
  private readonly views = new Map<PlayerId, View>();
  private readonly pool: View[] = [];
  private readonly flashMaterial: THREE.MeshBasicMaterial;
  private frame = 0;
  private time = 0;
  private outlineDist2 = 45 * 45;
  private readonly tmp = new THREE.Vector3();
  private readonly removeList: PlayerId[] = [];
  /** Reused every call (no per-player per-frame allocation). */
  private readonly poseIn: PoseInput = {
    time: 0, anim: { moving: false, sprinting: false, airborne: false, dropping: false, inWater: false, firing: false, reloading: false, healing: false },
    weapon: 'fists', pitch: 0, speed: 0, sprintSpeed: 1, velY: 0, walkPhase: 0, recoil: 0, hit: 0, deathTime: -1, seed: 0,
  };

  constructor(
    private readonly balance: Balance,
    private readonly events: PlayerViewsEvents,
  ) {
    this.group.name = 'players';
    this.flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.flashMaterial.name = 'chibi:hitFlash';
  }

  setOutlineDistance(d: number): void {
    this.outlineDist2 = d * d;
  }

  private acquire(p: PlayerView): View {
    const ap = p.state.appearance;
    const key = `${ap.skin}|${ap.outfit}|${ap.hair}`;
    let v = this.pool.pop();
    if (v) {
      if (v.appearanceKey !== key) {
        v.model.chibi.setVariant({ skin: ap.skin, outfit: ap.outfit, hair: ap.hair });
        v.skin.setAppearanceKey(key);
      }
      v.appearanceKey = key;
    } else {
      const model = createCharacter(ap);
      // 12 part meshes -> 1 skinned colour mesh + 1 skinned outline (see chibiSkin.ts).
      const skin = skinChibi(model, key);
      const outlines: THREE.Object3D[] = [skin.outline];
      const colourMeshes: THREE.Mesh[] = [skin.colour];
      model.root.rotation.order = 'YXZ';
      v = {
        id: p.state.id, model, skin, outlines, colourMeshes, weapons: new Map(), weaponId: null, weaponObj: null,
        appearanceKey: key, walkPhase: 0, lastX: 0, lastZ: 0, speed: 0, recoil: 0, hit: 0, hitFlash: 0,
        flashing: false, diedAt: -1, poofed: false, seed: 0, seen: 0, pose: makePose(),
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
    this.setFlash(v, false);
    // Joined mid-match / first seen already dead: no topple, just absent.
    v.diedAt = -1;
    v.poofed = !p.state.alive;
    v.model.root.visible = p.state.alive;
    v.model.chibi.resetPose();
    this.group.add(v.model.root);
    this.views.set(v.id, v);
    return v;
  }

  private release(v: View): void {
    this.group.remove(v.model.root);
    this.views.delete(v.id);
    this.pool.push(v);
  }

  private setWeapon(v: View, w: WeaponId): void {
    if (v.weaponId === w) return;
    if (v.weaponObj) v.model.handR.remove(v.weaponObj);
    let obj = v.weapons.get(w);
    if (obj === undefined) {
      obj = createWeaponModel(w);
      v.weapons.set(w, obj);
      if (obj) obj.traverse((o) => o.name === 'outline' && v.outlines.push(o));
    }
    if (obj) v.model.handR.add(obj);
    v.weaponObj = obj;
    v.weaponId = w;
  }

  private setFlash(v: View, on: boolean): void {
    if (v.flashing === on) return;
    v.flashing = on;
    for (const m of v.colourMeshes) {
      if (on) {
        m.userData.baseMaterial ??= m.material;
        m.material = this.flashMaterial;
      } else if (m.userData.baseMaterial) {
        m.material = m.userData.baseMaterial as THREE.Material;
      }
    }
  }

  /** Bus hooks (Vfx forwards these). */
  onShot(id: PlayerId): void {
    const v = this.views.get(id);
    if (v) v.recoil = 1;
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

  /** World position of the muzzle (or right hand for fists). False if the player has no view. */
  getMuzzle(id: PlayerId, out: Vec3): boolean {
    const v = this.views.get(id);
    if (!v || !v.model.root.visible) return false;
    const muzzle = v.weaponObj?.getObjectByName('muzzle') ?? v.model.handR;
    muzzle.getWorldPosition(this.tmp);
    out.x = this.tmp.x;
    out.y = this.tmp.y;
    out.z = this.tmp.z;
    return true;
  }

  getRoot(id: PlayerId): THREE.Object3D | null {
    return this.views.get(id)?.model.root ?? null;
  }

  update(players: readonly PlayerView[], time: number, dt: number, cam: THREE.Vector3, hideLocal: boolean): void {
    this.time = time;
    this.frame++;
    const sprint = this.balance.movement.sprintSpeed;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const s = p.state;
      let v = this.views.get(s.id);
      if (!v) v = this.acquire(p);
      v.seen = this.frame;

      // Revived (new match reusing an id): clear death state. The kill event arrives ~INTERP_DELAY before the
      // interpolated state says alive = false, so a recent death is never undone by a stale alive flag.
      if (s.alive && (v.diedAt >= 0 ? time - v.diedAt > 3 : v.poofed)) {
        v.diedAt = -1;
        v.poofed = false;
        v.model.root.visible = true;
        v.model.root.scale.setScalar(1);
      }
      // Died without a playerKilled event reaching us (or before it): start the topple now.
      if (!s.alive && v.diedAt < 0 && !v.poofed) v.diedAt = time;

      // Speed estimate from rendered positions (works for predicted and interpolated states).
      if (dt > 1e-4) {
        const dx = s.pos.x - v.lastX, dz = s.pos.z - v.lastZ;
        const inst = Math.hypot(dx, dz) / dt;
        const sp = inst > 30 ? 0 : inst; // teleport guard
        v.speed += (sp - v.speed) * (1 - Math.exp(-dt * 12));
        v.walkPhase = (v.walkPhase + ((Math.hypot(dx, dz) > 2 ? 0 : Math.hypot(dx, dz)) / STRIDE_M) * Math.PI * 2) % (Math.PI * 200);
      }
      v.lastX = s.pos.x;
      v.lastZ = s.pos.z;
      v.recoil *= Math.exp(-dt * RECOIL_DECAY);
      v.hit *= Math.exp(-dt * HIT_DECAY);
      v.hitFlash -= dt;
      this.setFlash(v, v.hitFlash > 0 && s.alive);

      const root = v.model.root;
      if (v.poofed) {
        root.visible = false;
        continue;
      }
      const deathTime = v.diedAt >= 0 ? time - v.diedAt : -1;
      if (deathTime >= DEATH_POOF_AT_S) {
        v.poofed = true;
        root.visible = false;
        this.events.onPoof(s.pos.x, s.pos.y + 0.5, s.pos.z);
        continue;
      }

      this.setWeapon(v, s.weapon);
      const pi = this.poseIn;
      pi.time = time;
      pi.anim = s.anim;
      pi.weapon = s.weapon;
      pi.pitch = s.pitch;
      pi.speed = v.speed;
      pi.sprintSpeed = sprint;
      pi.velY = s.velY;
      pi.walkPhase = v.walkPhase;
      pi.recoil = v.recoil;
      pi.hit = v.hit;
      pi.deathTime = deathTime;
      pi.seed = v.seed;
      const pose = computePose(pi, v.pose);
      this.applyPose(v, pose);
      root.position.set(s.pos.x, s.pos.y, s.pos.z);
      root.rotation.set(pose.rootTiltX, s.yaw, pose.rootTiltZ);
      root.visible = !(hideLocal && p.isLocal);

      const d2 = (s.pos.x - cam.x) ** 2 + (s.pos.y - cam.y) ** 2 + (s.pos.z - cam.z) ** 2;
      const showOutline = d2 < this.outlineDist2;
      for (let k = 0; k < v.outlines.length; k++) v.outlines[k].visible = showOutline;
    }

    // Players no longer in the view list (left / new match): return to the pool.
    this.removeList.length = 0;
    for (const v of this.views.values()) if (v.seen !== this.frame) this.removeList.push(v.id);
    for (const id of this.removeList) {
      const v = this.views.get(id);
      if (v) this.release(v);
    }
  }

  private applyPose(v: View, p: Pose): void {
    const m = v.model;
    const hipY = m.body.userData.restY ?? (m.body.userData.restY = m.body.position.y);
    m.body.position.y = (hipY as number) + p.bodyY;
    m.body.rotation.set(p.bodyX, p.bodyY_rot, p.bodyZ);
    m.head.rotation.set(p.headX, p.headY, 0);
    m.armL.rotation.set(p.armLX, p.armLY, p.armLZ);
    m.armR.rotation.set(p.armRX, p.armRY, p.armRZ);
    m.legL.rotation.set(p.legLX, 0, p.legLZ);
    m.legR.rotation.set(p.legRX, 0, p.legRZ);
    m.root.scale.setScalar(p.scale);
    if (v.weaponObj) v.weaponObj.visible = p.weaponVisible;
  }

  clear(): void {
    for (const v of [...this.views.values()]) this.release(v);
  }

  dispose(): void {
    this.clear();
    this.pool.length = 0;
    this.flashMaterial.dispose();
    this.group.clear();
  }
}
