/**
 * First-person viewmodel pass (M2b: ARCHITECTURE §15.7 "Viewmodel pass", ADR 0005 §9, camera.md, STYLE.md §21).
 * Owner: graphics-engineer (viewmodel). Reads FrameView only; never touches simulation state.
 *
 * The arms + held item (src/render/procedural/viewmodel.ts) live in their own small scene in VIEWMODEL CAMERA SPACE
 * (the viewmodel camera sits at the origin looking down -Z) and are drawn after the world with a depth clear, at the
 * fixed vertical FOV `clientFeel.viewmodelFovDeg` (fallback VIEWMODEL_FOV) and near plane VIEWMODEL_NEAR. So they
 * never clip into walls and look the same at every FOV setting. The pass has its own sun + hemisphere light, copied
 * every frame from the world lights (setLights) and rotated into camera space, so the toon bands match. No shadows.
 * Toon materials are cloned per pass, so the shared world materials never switch light setups between the passes.
 *
 * The local parachute canopy (dropPhase 'chute') is a WORLD object: `worldGroup` goes into the main scene and is
 * depth-tested with the world (visible when looking up, camera.md AC12).
 *
 * --------------------------------------------------------------------------------------------------------------
 * INTEGRATION (Renderer.ts, owned by the world graphics-engineer). Exactly these lines:
 *
 *   import { ViewmodelPass } from './ViewmodelPass';
 *   private readonly viewmodel: ViewmodelPass;
 *
 *   // constructor, after the SunRig exists:
 *   this.viewmodel = new ViewmodelPass(this.balance);
 *   this.viewmodel.init(this.gl);
 *   this.viewmodel.setLights(this.sunRig.sun, this.sunRig.hemi);   // again with the office key light on map switch
 *   this.scene.add(this.viewmodel.worldGroup);                       // FP canopy; re-add after a scene rebuild
 *
 *   // render(), after the camera pose (position, rotation incl. roll and shake) is final:
 *   this.viewmodel.update(view, dt);
 *   // render(), right after this.gl.render(this.scene, this.camera):
 *   this.viewmodel.render(this.gl, this.camera);
 *
 *   // on mapChanged: this.viewmodel.reset();   in dispose(): this.viewmodel.dispose();
 *   // on a balance change (mapChanged.balance): this.viewmodel.setBalance(balance);
 *
 * Also: in FP, PlayerViews must not draw `camera.subjectId`'s parachute (the whole body is hidden already); the
 * pass draws that canopy. render() keeps renderer.info totals for the whole frame (it adds the world pass back).
 * --------------------------------------------------------------------------------------------------------------
 */
import * as THREE from 'three';
import type { Balance } from '../shared/balance';
import type { FrameView, ViewmodelView } from '../shared/contracts';
import type { GunId } from '../shared/types';
import { palette } from './procedural/materials';
import { createParachute, setParachuteDeploy } from './procedural/carrier';
import {
  applyViewmodelPose,
  createViewmodel,
  VIEWMODEL_FOV,
  VIEWMODEL_NEAR,
  VIEWMODEL_POSES,
  type ViewmodelRig,
} from './procedural/viewmodel';
import { LIGHTING, SUN_DIRECTION } from './Sky';
import {
  createVmOut,
  isGun,
  VM_MAG_POINT,
  ViewmodelAnimator,
  viewmodelFovFromBalance,
  vmAnimConfigFromBalance,
  type VmHandOut,
  type VmOut,
} from './viewmodelAnim';

const VIEWMODEL_FAR = 10;
const UP = new THREE.Vector3(0, 1, 0);

/** True when FrameView asks for the viewmodel this frame (FP camera case and a visible ViewmodelView). */
export function viewmodelActive(view: FrameView): boolean {
  const vm = view.viewmodel;
  const cam = view.camera;
  if (!vm || !vm.visible) return false;
  if (cam.mode !== 'follow' || !cam.firstPerson) return false;
  return (cam.view ?? 'firstPerson') === 'firstPerson';
}

export class ViewmodelPass {
  /** World-space extras for the main scene (the FP parachute canopy). */
  readonly worldGroup = new THREE.Group();
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private rig: ViewmodelRig | null = null;
  private readonly anim: ViewmodelAnimator;
  private readonly out: VmOut = createVmOut();
  private readonly sun = new THREE.DirectionalLight(palette.sunLight, LIGHTING.sun);
  private readonly hemi = new THREE.HemisphereLight(palette.hemiSky, palette.hemiGround, LIGHTING.hemi);
  private worldSun: THREE.DirectionalLight | null = null;
  private worldHemi: THREE.HemisphereLight | null = null;
  private readonly matClones = new Map<THREE.Material, THREE.Material>();
  private readonly spark: THREE.Mesh;
  private parachute: THREE.Object3D | null = null;
  private active = false;
  private appearanceKey = '';
  private remappedItem: string | null = null;
  private disposed = false;
  /** Draw calls / triangles of the last viewmodel pass (for budgets and tests). */
  readonly lastStats = { calls: 0, triangles: 0 };

  constructor(balance: Balance) {
    this.anim = new ViewmodelAnimator(vmAnimConfigFromBalance(balance));
    this.camera = new THREE.PerspectiveCamera(viewmodelFovFromBalance(balance, VIEWMODEL_FOV), 1, VIEWMODEL_NEAR, VIEWMODEL_FAR);
    this.scene.name = 'viewmodel';
    this.scene.matrixWorldAutoUpdate = true;
    this.sun.name = 'vmSun';
    this.sun.castShadow = false;
    this.hemi.name = 'vmHemi';
    this.scene.add(this.sun, this.sun.target, this.hemi);
    // No depth test: the fuse top faces up and the cap rim hides it from the eye; a spark glow may overdraw the rim.
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false });
    this.spark = new THREE.Mesh(new THREE.IcosahedronGeometry(0.013, 0), sparkMat);
    this.spark.name = 'vmFuseSpark';
    this.spark.visible = false;
    this.spark.renderOrder = 2;
    this.scene.add(this.spark);
    this.worldGroup.name = 'viewmodelWorld';
    this.worldGroup.visible = false;
  }

  /** Hook: called once with the WebGL renderer (nothing to allocate on the GPU up front; kept for symmetry). */
  init(renderer: THREE.WebGLRenderer): void {
    void renderer;
  }

  /** Copy colour, intensity and direction from these world lights every frame (null = the island defaults). */
  setLights(sun: THREE.DirectionalLight | null, hemi: THREE.HemisphereLight | null): void {
    this.worldSun = sun;
    this.worldHemi = hemi;
  }

  /** Per-match balance (mapChanged.balance). */
  setBalance(balance: Balance): void {
    this.anim.setConfig(vmAnimConfigFromBalance(balance));
    const fov = viewmodelFovFromBalance(balance, VIEWMODEL_FOV);
    if (fov !== this.camera.fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Forget animation state (map change, new match). */
  reset(): void {
    this.anim.reset();
  }

  /** True when the last update() decided to draw the viewmodel. */
  get isActive(): boolean {
    return this.active;
  }

  /** Hook: animate from FrameView. Allocation-free after the first frame of each item / appearance. */
  update(view: FrameView, dt: number): void {
    if (this.disposed) return;
    const vm = view.viewmodel ?? null;
    let airborne = false;
    let subject: FrameView['players'][number]['state'] | null = null;
    if (vm) {
      for (let i = 0; i < view.players.length; i++) {
        const s = view.players[i].state;
        if (s.id === vm.playerId) {
          subject = s;
          airborne = s.anim.airborne;
          break;
        }
      }
    }
    const out = this.anim.step(vm, { airborne }, dt, this.out);
    this.active = viewmodelActive(view) && out.visible;
    this.updateCanopy(out, subject, this.active);
    if (!this.active || !vm) {
      if (this.rig) this.rig.root.visible = false;
      this.spark.visible = false;
      return;
    }
    const rig = this.ensureRig(vm);
    rig.root.visible = true;
    this.pose(rig, vm, out, view.time);
  }

  /** Hook: draw after the world pass. `camera` is the main camera (for the light directions and the aspect). */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    if (this.disposed || !this.active) return;
    if (this.camera.aspect !== camera.aspect) {
      this.camera.aspect = camera.aspect;
      this.camera.updateProjectionMatrix();
    }
    this.syncLights(camera);
    const info = renderer.info;
    const calls = info.render.calls, tris = info.render.triangles, points = info.render.points, lines = info.render.lines;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
    if (info.autoReset) {
      this.lastStats.calls = info.render.calls;
      this.lastStats.triangles = info.render.triangles;
      info.render.calls += calls;
      info.render.triangles += tris;
      info.render.points += points;
      info.render.lines += lines;
    } else {
      this.lastStats.calls = info.render.calls - calls;
      this.lastStats.triangles = info.render.triangles - tris;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Geometry is shared with the world models (procedural caches), so only pass-owned resources are freed here.
    for (const m of this.matClones.values()) m.dispose();
    this.matClones.clear();
    this.spark.geometry.dispose();
    (this.spark.material as THREE.Material).dispose();
    this.scene.clear();
    this.worldGroup.removeFromParent();
    this.worldGroup.clear();
    this.rig = null;
    this.parachute = null;
  }

  // ------------------------------------------------------------------------------------------------
  private ensureRig(vm: ViewmodelView): ViewmodelRig {
    const ap = vm.appearance;
    const key = `${ap.skin}|${ap.outfit}`;
    if (!this.rig) {
      this.rig = createViewmodel(ap);
      this.scene.add(this.rig.root);
      this.appearanceKey = key;
      this.remapMaterials(this.rig.root);
    } else if (key !== this.appearanceKey) {
      this.rig.setAppearance(ap);
      this.appearanceKey = key;
      this.remapMaterials(this.rig.root);
    }
    return this.rig;
  }

  /** Swap lit (toon) materials for pass-private clones; unlit ones (outline hulls, lens) are shared as is. */
  private remapMaterials(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh === this.spark) return;
      const swap = (m: THREE.Material): THREE.Material => {
        if (!(m as THREE.MeshToonMaterial).isMeshToonMaterial) return m;
        if ([...this.matClones.values()].includes(m)) return m;
        let c = this.matClones.get(m);
        if (!c) {
          c = m.clone();
          c.name = `${m.name}:vm`;
          this.matClones.set(m, c);
        }
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
    });
  }

  private pose(rig: ViewmodelRig, vm: ViewmodelView, o: VmOut, time: number): void {
    applyViewmodelPose(rig, o.item, o.ads, { level: o.level, scope: o.scope });
    const key = `${o.item}|${o.level ?? '-'}|${o.scope ?? '-'}`;
    if (this.remappedItem !== key) {
      this.remappedItem = key;
      this.remapMaterials(rig.root);
    }
    const sock = rig.itemSocket;
    // Posed socket S0 (from the reference pose) -> final socket S1.
    _p0.copy(sock.position);
    _q0.copy(sock.quaternion);
    const p1 = _p1.copy(_p0);
    const q1 = _q1.copy(_q0);
    if (o.sockAbsW > 0) {
      p1.lerp(_v.set(o.sockAbsPos[0], o.sockAbsPos[1], o.sockAbsPos[2]), o.sockAbsW);
      q1.slerp(_qa.setFromEuler(_e.set(o.sockAbsRot[0], o.sockAbsRot[1], o.sockAbsRot[2])), o.sockAbsW);
    }
    // Rigid offset: rotate about the pivot (socket at hip, the sight eye = origin at full ADS), then translate.
    const pivot = _pv.copy(p1).multiplyScalar(1 - o.ads);
    _qa.setFromEuler(_e.set(o.sockRot[0], o.sockRot[1], o.sockRot[2]));
    p1.sub(pivot).applyQuaternion(_qa).add(pivot);
    p1.x += o.sockPos[0];
    p1.y += o.sockPos[1];
    p1.z += o.sockPos[2];
    q1.premultiply(_qa);
    sock.position.copy(p1);
    sock.quaternion.copy(q1);
    sock.visible = o.showItem;
    // D = S1 * S0^-1 moves the hands rigidly with the socket.
    _m0.compose(_p0, _q0, ONE).invert();
    _d.compose(p1, q1, ONE).multiply(_m0);
    const pose = VIEWMODEL_POSES[o.item];
    this.placeHand(rig.handR, rig.fingersR, o.handR, pose.curlR, null);
    this.placeHand(rig.handL, rig.fingersL, o.handL, pose.curlL, isGun(o.item) ? o.item : null, pose.itemScale);
    // Item spin (bandage roll) and the whole-viewmodel kick.
    const itemObj = sock.children[0];
    if (itemObj) itemObj.rotation.x = o.itemSpinX;
    rig.root.rotation.set(o.rootRot[0], o.rootRot[1], o.rootRot[2]);
    // Fuse spark.
    if (o.fuse > 0 && o.showItem && itemObj) {
      const fuse = itemObj.getObjectByName('fuse');
      if (fuse) {
        rig.root.updateMatrixWorld(true);
        fuse.getWorldPosition(this.spark.position);
        const f = 0.7 + 0.6 * Math.abs(Math.sin(time * 61.3) * Math.sin(time * 23.7 + 1));
        this.spark.scale.setScalar(f);
        this.spark.rotation.set(time * 9, time * 13, 0);
        this.spark.visible = true;
      } else this.spark.visible = false;
    } else this.spark.visible = false;
    void vm;
  }

  private placeHand(
    hand: THREE.Object3D,
    fingers: THREE.Object3D,
    h: VmHandOut,
    poseCurl: number,
    magGun: GunId | null,
    itemScale = 1,
  ): void {
    if (!hand.visible || !h.visible) {
      // A lowered hand (pose null) can still be driven by an absolute target (drop arms).
      if (!(h.absW > 0 && h.visible)) {
        hand.visible = false;
        return;
      }
      hand.visible = true;
    }
    _m1.compose(hand.position, hand.quaternion, ONE).premultiply(_d);
    _m1.decompose(hand.position, hand.quaternion, _s);
    if (magGun && h.magW > 0) {
      const mp = VM_MAG_POINT[magGun];
      _v.set(mp[0] * itemScale, mp[1] * itemScale, mp[2] * itemScale).applyMatrix4(_m2.compose(_p1, _q1, ONE));
      hand.position.lerp(_v, h.magW);
    }
    if (h.absW > 0) {
      hand.position.lerp(_v.set(h.absPos[0], h.absPos[1], h.absPos[2]), h.absW);
      if (Number.isFinite(h.absRot[0])) hand.quaternion.slerp(_qa.setFromEuler(_e.set(h.absRot[0], h.absRot[1], h.absRot[2])), h.absW);
    }
    if (h.rot[0] !== 0 || h.rot[1] !== 0 || h.rot[2] !== 0) hand.quaternion.premultiply(_qa.setFromEuler(_e.set(h.rot[0], h.rot[1], h.rot[2])));
    hand.position.x += h.pos[0];
    hand.position.y += h.pos[1];
    hand.position.z += h.pos[2];
    fingers.rotation.x = Number.isFinite(h.curl) ? h.curl : poseCurl;
  }

  private updateCanopy(o: VmOut, subject: FrameView['players'][number]['state'] | null, active: boolean): void {
    const show = active && o.canopy >= 0 && !!subject;
    if (show && !this.parachute) {
      this.parachute = createParachute({ stripe: 0 });
      this.parachute.name = 'fpParachute';
      this.worldGroup.add(this.parachute);
    }
    this.worldGroup.visible = show;
    if (!show || !this.parachute || !subject) return;
    const stripe = typeof subject.id === 'number' ? subject.id : 0;
    if (this.parachute.userData.stripeFor !== stripe) {
      this.worldGroup.remove(this.parachute);
      this.parachute = createParachute({ stripe });
      this.parachute.name = 'fpParachute';
      this.parachute.userData.stripeFor = stripe;
      this.worldGroup.add(this.parachute);
    }
    this.parachute.position.set(subject.pos.x, subject.pos.y, subject.pos.z);
    this.parachute.rotation.set(0, subject.yaw, 0);
    setParachuteDeploy(this.parachute, o.canopy);
  }

  /** World lights -> camera space (the viewmodel camera is the identity). */
  private syncLights(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    _qc.setFromRotationMatrix(camera.matrixWorld).invert();
    const ws = this.worldSun;
    if (ws) {
      this.sun.color.copy(ws.color);
      this.sun.intensity = ws.intensity;
      _v.copy(ws.position).sub(ws.target.position);
      if (_v.lengthSq() < 1e-9) _v.copy(SUN_DIRECTION);
    } else _v.copy(SUN_DIRECTION);
    _v.normalize().applyQuaternion(_qc);
    this.sun.position.copy(_v);
    this.sun.target.position.set(0, 0, 0);
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
    const wh = this.worldHemi;
    if (wh) {
      this.hemi.color.copy(wh.color);
      this.hemi.groundColor.copy(wh.groundColor);
      this.hemi.intensity = wh.intensity;
    }
    this.hemi.position.copy(UP).applyQuaternion(_qc);
    this.hemi.updateMatrixWorld();
  }
}

const ONE = new THREE.Vector3(1, 1, 1);
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m0 = new THREE.Matrix4();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _d = new THREE.Matrix4();
