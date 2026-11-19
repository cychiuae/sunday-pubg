/**
 * Renderer facade (IRenderer). Owner: graphics-engineer. Pipeline and budgets: docs/tech/RENDERING.md.
 *
 * Reads FrameView every frame and bus events for VFX; never mutates simulation state and never emits on the bus.
 * M2b: the static world is a swappable MapScene (IslandScene: sky, terrain, sea, tide wall, island props; IndoorScene:
 * floor, walls, glass, merged kit props, ceiling, rain curtain), rebuilt on `mapChanged` and disposed without leaks
 * (ADR 0005 §5). Map-independent layers stay: pooled chibis (freefall / parachute poses), loot, grenades, VFX, the
 * carrier (seaplane / drone on the DropRoute) and the first-person viewmodel pass (ViewmodelPass.ts, drawn after the
 * world with a depth clear). One shadow-casting key light whose tight frustum follows the camera target.
 * Camera by CameraView.view: first person = exactly at the eye (roll, near 0.05, no boom, subject hidden); the 3P
 * cases (carrier, chase, death, results) use the collision rig plus the indoor ceiling / bounds clamps and the
 * cut-away of anything between the camera and the subject.
 */
import * as THREE from 'three';
import type { Balance, ZoneTheme } from '../shared/balance';
import { CONTEXT_RESTORE_TIMEOUT_MS } from '../shared/constants';
import type { CameraCase, CameraView, FrameView, GraphicsStatus, IRenderer, ListenerPose, QualityLevel, RocketView, SmokeCloudView } from '../shared/contracts';
import type { EventBus, GameEvents } from '../shared/events';
import { isIndoor } from '../shared/maps';
import type { AnyMapData, CarrierModel, LookId, MatchLayout, PlayerId } from '../shared/types';
import { CameraRig } from './cameraRig';
import { CarrierLayer } from './CarrierLayer';
import { disposeSkinCache } from './chibiSkin';
import { ContextHealth } from './contextHealth';
import { GrenadeLayer } from './GrenadeLayer';
import { IndoorScene } from './IndoorScene';
import { INDOOR_FX, resetIndoorFx } from './indoorFx';
import { IslandScene } from './IslandScene';
import { sceneLookFor } from './looks';
import { LootLayer } from './LootLayer';
import { ModelBatch } from './ModelBatch';
import type { MapScene, MapSceneFrame } from './mapScene';
import { NameTags } from './NameTags';
import { dropPhaseOf, PlayerViews, type PlayerViewsFrame } from './PlayerViews';
import { palette } from './procedural';
import { DEFAULT_QUALITY, QUALITY_PRESETS, type QualityPreset, type QualitySettings } from './quality';
import { SunRig } from './Sky';
import { RocketLayer } from './RocketLayer';
import { SmokeLayer } from './SmokeLayer';
import { SpeedLines } from './SpeedLines';
import { ViewmodelPass } from './ViewmodelPass';
import { Markers } from './vfx/Markers';
import { Vfx } from './vfx/Vfx';

const FRAME_SAMPLES = 240;
const NO_SMOKES: readonly SmokeCloudView[] = [];
const NO_ROCKETS: readonly RocketView[] = [];
const NO_PANES: readonly number[] = [];
/** Camera shake at amount 1 (explosion at the eye): position jitter (m) and roll/pitch jitter (rad), decay (1/s). */
const SHAKE_POS = 0.12;
const SHAKE_ROT = 0.012;
const SHAKE_DECAY = 7;
/** Draw / LOD distances grow with zoom so scoped targets keep outlines and loot, capped for cost. */
const MAX_LOD_ZOOM = 4;
const DEFAULT_FOV = 70;
const MARKER_CAPACITY = 512;
/** Near plane (m): first person sits at the eye 0.3-0.4 m from a wall (ARCHITECTURE §15.7: <= 0.05). */
const NEAR_FP = 0.05;
const NEAR_3P = 0.1;

export interface RenderStats {
  fps: number;
  frameMsAvg: number;
  frameMsP95: number;
  cpuRenderMsAvg: number;
  calls: number;
  triangles: number;
  points: number;
  geometries: number;
  textures: number;
  programs: number;
  particles: number;
  quality: QualityPreset;
  /** True while the WebGL context is lost (no frames are drawn). */
  contextLost: boolean;
  /** Number of context losses this session. */
  contextLosses: number;
  /** M2b: id and kind of the map scene on screen. */
  mapId: string;
  mapKind: 'island' | 'indoor';
}

/** The camera case of a CameraView (pre-gate producers may omit `view`). Pure; exported for tests. */
export function cameraCaseOf(cam: CameraView): CameraCase {
  if (cam.view) return cam.view;
  if (cam.mode === 'follow') return cam.firstPerson ? 'firstPerson' : 'chase';
  return 'title';
}

export class Renderer implements IRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly fog: THREE.Fog;
  private readonly camera: THREE.PerspectiveCamera;
  private balance: Balance;
  private world: MapScene;
  private map: AnyMapData;
  private readonly sunRig: SunRig;
  private readonly loot: LootLayer;
  /**
   * M2c (Addendum 2): every ground item and every held item (all weapons x levels x scopes, grenades, smoke cans) in
   * one BatchedMesh pair by material: 2 draw calls (+1 shadow) whatever the mix. Shared by LootLayer and PlayerViews.
   */
  private readonly items: ModelBatch;
  private readonly players: PlayerViews;
  private readonly tags: NameTags;
  private readonly vfx: Vfx;
  private readonly markers: Markers;
  private readonly grenades: GrenadeLayer;
  private readonly carrier: CarrierLayer;
  private readonly speedLines: SpeedLines;
  /** M2c smoke clouds (FrameView.smokes; same on every quality preset). */
  private readonly smoke: SmokeLayer;
  /** M2c rockets in flight (FrameView.rockets; instances in the shared item batch, trail through the particles). */
  private readonly rockets: RocketLayer;
  private readonly viewmodel: ViewmodelPass;
  private readonly rig: CameraRig;
  private baseFov: number;
  private zoneTheme: ZoneTheme;
  /** M2c: this match's look preset (mapChanged.look) and layout seed (mapChanged.layout.seed); null = baseline. */
  private lookId: LookId | null = null;
  private layoutSeed: number | null = null;
  /** M2c: this match's layout (decor, lit panels); null = baseline / none. */
  private layout: MatchLayout | null = null;
  private shakeAmount = 0;
  private readonly drawSize = new THREE.Vector2();
  private readonly playersFrame: PlayerViewsFrame = {
    time: 0, dt: 0, serverTime: 0, cam: new THREE.Vector3(), follow: false, hideId: null, localAds: 0,
  };
  private readonly sceneFrame: MapSceneFrame;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly focus = new THREE.Vector3();
  private readonly listener: ListenerPose = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
  private readonly unsubs: (() => void)[] = [];
  private quality: QualitySettings;
  private qualityName: QualityPreset;
  private lastMode: 'follow' | 'orbit' | null = null;
  private lastFov = -1;
  private maxPointPx = 256;
  private disposed = false;
  /** Lost/restored tracking for getGraphicsStatus (ADR 0003 §5). While lost, render() does no work. */
  private readonly health = new ContextHealth(CONTEXT_RESTORE_TIMEOUT_MS);
  // Frame stats (dev hook)
  private readonly frameMs = new Float32Array(FRAME_SAMPLES);
  private readonly cpuMs = new Float32Array(FRAME_SAMPLES);
  private frameIdx = 0;
  private frameCount = 0;
  /**
   * M4: preventDefault tells the browser we will handle a restore (without it, the context never comes back).
   * three.js registers its own listeners first (in its constructor), so by the time ours run it has already marked
   * the context lost or re-created its GL state.
   */
  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.health.lost(performance.now());
  };
  private readonly onContextRestored = (): void => this.restoreGpuState();

  /**
   * @param map the map shown before the first `mapChanged` (title screen); ClientGame's mapChanged switches it.
   * @param balance the base balance; per-match values arrive with mapChanged.balance.
   */
  constructor(
    private readonly container: HTMLElement,
    map: AnyMapData,
    bus: EventBus<GameEvents>,
    balance: Balance,
  ) {
    // Contract revision 1 #10: the composition root (main.ts) injects balance; render never imports BALANCE.
    this.balance = balance;
    this.map = map;
    this.zoneTheme = isIndoor(map) ? 'sprinklers' : 'tide';
    this.qualityName = DEFAULT_QUALITY;
    this.quality = QUALITY_PRESETS[this.qualityName];

    this.gl = new THREE.WebGLRenderer({
      antialias: this.quality.antialias,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.NeutralToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.gl.setClearColor(palette.fog, 1);
    this.canvas = this.gl.domElement;
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    container.appendChild(this.canvas);
    this.readPointSizeRange();

    this.camera = new THREE.PerspectiveCamera(70, 1, NEAR_3P, 2600);
    this.camera.rotation.order = 'YXZ';
    this.fog = new THREE.Fog(palette.fog, 140, 900);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(palette.fog);

    this.sunRig = new SunRig();
    this.scene.add(this.sunRig.sun, this.sunRig.sun.target, this.sunRig.hemi);

    this.items = new ModelBatch('items', { instances: 128, vertices: 1 << 15, receiveShadow: false });
    this.scene.add(this.items.body, this.items.hull);
    this.loot = new LootLayer(map, this.balance, this.items);
    this.scene.add(this.loot.group);

    this.players = new PlayerViews(this.balance, {
      onPoof: (x, y, z) => this.vfx.poof(x, y, z),
      onFuseSpark: (x, y, z) => this.vfx.fuseSpark(x, y, z),
    }, this.items);
    this.scene.add(this.players.group);
    this.baseFov = this.balance.clientFeel?.cameraFovDeg ?? DEFAULT_FOV;

    this.tags = new NameTags(this.balance.player.height);
    this.scene.add(this.tags.mesh);

    const cameraPosition = this.camera.position;
    this.vfx = new Vfx(
      bus,
      {
        cameraPosition,
        getMuzzle: (id, out) => this.players.getMuzzle(id, out),
        onShot: (id) => this.players.onShot(id),
        onDamaged: (id) => this.players.onDamaged(id),
        onKilled: (id) => this.players.onKilled(id),
        // The current map scene (swapped on mapChanged).
        surfaceAt: (x, z) => this.world.surfaceAt(x, z),
        pulseTide: () => this.world.pulseZone(),
        playerHeight: this.balance.player.height,
        heightAt: (x, z) => this.world.heightAt(x, z),
        onThrow: (id) => this.players.onThrow(id),
        onCooked: (id, at) => this.players.onCooked(id, at),
        onExploded: (id) => this.grenades.onExploded(id),
        shake: (amount) => {
          this.shakeAmount = Math.max(this.shakeAmount, Math.min(1, amount));
        },
      },
      this.quality.maxParticles,
    );
    this.scene.add(this.vfx.particles.points, this.vfx.tracers.mesh, this.vfx.decals.group);

    this.markers = new Markers(MARKER_CAPACITY, palette.ink);
    this.scene.add(this.markers.points);
    this.players.setMarkers(this.markers);
    this.grenades = new GrenadeLayer(
      this.markers,
      { fuseSpark: (x, y, z) => this.vfx.fuseSpark(x, y, z), trailPuff: (x, y, z) => this.vfx.trailPuff(x, y, z) },
      (x, z) => this.world.visualHeight(x, z),
      this.items,
    );
    this.scene.add(this.grenades.group);
    this.tags.setHeightFn((id, fallback) => {
      const b = this.players.getStanceBlend(id);
      const st = this.balance.movement.stances;
      if (!b || !st) return fallback;
      const hc = fallback + (st.crouch.height - fallback) * b.crouch;
      return hc + (st.prone.height - hc) * b.prone;
    });

    this.carrier = new CarrierLayer();
    this.scene.add(this.carrier.group);
    this.speedLines = new SpeedLines();
    this.scene.add(this.speedLines.mesh);
    this.smoke = new SmokeLayer();
    this.scene.add(this.smoke.group);
    this.rockets = new RocketLayer(this.items, this.vfx);

    // M2b first-person viewmodel pass (ViewmodelPass.ts, viewmodel graphics-engineer): own scene + depth clear.
    this.viewmodel = new ViewmodelPass(this.balance);
    this.viewmodel.init(this.gl);
    this.viewmodel.setLights(this.sunRig.sun, this.sunRig.hemi);
    this.scene.add(this.viewmodel.worldGroup);

    this.world = this.buildWorld(map);
    this.rig = new CameraRig(this.world.obstacles);
    this.sceneFrame = {
      time: 0, dt: 0, serverTime: 0, camera: this.camera, view: null as unknown as CameraView, frustum: this.frustum,
      quality: this.quality, lod: 1, zone: null, firstPerson: false, carrier: null,
    };
    this.applyWorld();

    this.unsubs.push(
      bus.on('mapChanged', (e) => this.setMap(e.map, e.balance, e.zoneTheme, e.look ?? null, e.layout?.seed ?? null, e.layout ?? null)),
      bus.on('carrierDeparted', (e) => this.carrier.setRoute(e.route)),
    );

    this.applyQuality();
    this.resize();
    this.installDevHook();
  }

  // ------------------------------------------------------------------------------------------------
  // Map switching (ADR 0005 §5)
  // ------------------------------------------------------------------------------------------------
  private buildWorld(map: AnyMapData): MapScene {
    if (isIndoor(map)) {
      return new IndoorScene(map, this.quality, {
        zoneTheme: this.zoneTheme,
        preset: this.qualityName,
        splash: (x, y, z) => this.vfx.rainSplash(x, y, z),
        look: sceneLookFor('indoor', this.lookId),
        decor: this.layout?.decor ?? [],
        lightsOn: this.layout?.lightsOn ?? null,
      });
    }
    resetIndoorFx();
    return new IslandScene(map, this.quality, sceneLookFor('island', this.lookId), this.layout?.decor ?? []);
  }

  /** Light, fog, camera limits and the carrier model for the current world. */
  private applyWorld(): void {
    const w = this.world;
    this.scene.add(w.group);
    const look = w.look;
    this.sunRig.setLook(look);
    this.fog.color.setHex(look.fogColor);
    this.fog.near = look.fogNear;
    this.fog.far = look.fogFar;
    (this.scene.background as THREE.Color).setHex(look.background);
    this.gl.setClearColor(look.background, 1);
    this.gl.toneMappingExposure = look.exposure ?? 1;
    this.camera.far = w.cameraFar;
    this.camera.updateProjectionMatrix();
    this.rig.setObstacles(w.obstacles);
    this.rig.reset();
    const kind: CarrierModel = this.map.carrier ?? (isIndoor(this.map) ? 'drone' : 'seaplane');
    this.carrier.setMap(kind, isIndoor(this.map) ? this.map.floor : null);
    this.loot.setMap(this.map);
    this.viewmodel.setLights(this.sunRig.sun, this.sunRig.hemi);
    // Re-add the FP canopy group in case a caller cleared the scene.
    if (this.viewmodel.worldGroup.parent !== this.scene) this.scene.add(this.viewmodel.worldGroup);
    this.lastMode = null; // re-apply the per-mode shadow frustum next frame
  }

  /**
   * mapChanged: dispose the old map's world and build the new one. The same id keeps the scene (ADR 0005 §5) but takes
   * the new per-match balance. M2c: the same id is rebuilt when the look preset or the layout seed changes (per-match
   * layouts replace the props; the island chunks and the office merge are baked at build time).
   */
  setMap(
    map: AnyMapData, balance: Balance, zoneTheme: ZoneTheme, look: LookId | null = null, layoutSeed: number | null = null,
    layout: MatchLayout | null = null,
  ): void {
    if (this.disposed) return;
    this.balance = balance;
    this.players.setBalance(balance);
    this.viewmodel.reset();
    this.viewmodel.setBalance(balance);
    this.baseFov = balance.clientFeel?.cameraFovDeg ?? DEFAULT_FOV;
    if (map.id === this.world.mapId && zoneTheme === this.zoneTheme && look === this.lookId && layoutSeed === this.layoutSeed) {
      this.map = map;
      this.carrier.setRoute(null);
      return;
    }
    this.lookId = look;
    this.layoutSeed = layoutSeed;
    this.layout = layout;
    this.scene.remove(this.world.group);
    this.world.dispose();
    this.vfx.clear();
    this.rockets.clear();
    this.map = map;
    this.zoneTheme = zoneTheme;
    this.world = this.buildWorld(map);
    this.applyWorld();
  }

  // ------------------------------------------------------------------------------------------------
  // IRenderer
  // ------------------------------------------------------------------------------------------------
  render(view: FrameView, dt: number): void {
    if (this.disposed || this.health.isLost) return;
    const t0 = performance.now();
    const time = view.time;
    const cam = view.camera;
    const camCase = cameraCaseOf(cam);
    const firstPerson = cam.mode === 'follow' && cam.firstPerson === true;

    if (cam.mode !== this.lastMode) {
      this.lastMode = cam.mode;
      this.rig.reset();
      this.sunRig.configure(
        this.quality.shadows,
        this.quality.shadowMapSize,
        cam.mode === 'orbit' ? this.world.orbitShadowExtent : this.quality.shadowHalfExtent,
      );
    }
    const near = firstPerson ? NEAR_FP : NEAR_3P;
    if (cam.fovDeg !== this.lastFov || this.camera.near !== near) {
      this.lastFov = cam.fovDeg;
      this.camera.fov = cam.fovDeg;
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
      this.updatePointProjection();
      this.tags.setFov(cam.fovDeg);
    }

    // First person (M2b every FP case; M2a scope): exactly at the eye, no boom, no collision.
    if (firstPerson) {
      this.camera.position.set(cam.target.x, cam.target.y, cam.target.z);
    } else {
      const p = this.rig.update(cam, dt, cam.mode === 'follow' || camCase === 'carrier');
      this.camera.position.set(p.x, p.y, p.z);
    }
    let shakeX = 0, shakeZ = 0;
    if (this.shakeAmount > 0.001 && !view.reducedMotion) {
      const a = this.shakeAmount;
      const t = time * 47;
      this.camera.position.x += Math.sin(t * 1.3) * SHAKE_POS * a;
      this.camera.position.y += Math.sin(t * 1.7 + 1.1) * SHAKE_POS * a;
      this.camera.position.z += Math.sin(t * 1.1 + 2.3) * SHAKE_POS * a;
      shakeX = Math.sin(t * 1.9 + 0.4) * SHAKE_ROT * a;
      shakeZ = Math.sin(t * 1.5 + 2.9) * SHAKE_ROT * a;
      this.shakeAmount *= Math.exp(-dt * SHAKE_DECAY);
    } else {
      this.shakeAmount = 0;
    }
    this.camera.rotation.set(cam.pitch + shakeX, cam.yaw, (cam.roll ?? 0) + shakeZ);
    this.camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    this.focus.set(cam.target.x, cam.target.y, cam.target.z);
    if (cam.mode === 'orbit') this.focus.set(cam.target.x, 0, cam.target.z);
    this.sunRig.follow(this.focus);

    const cp = this.camera.position;
    // Indoor 3P cut-away: anything between the camera and the subject dithers away (title orbit excluded).
    const cut = this.world.kind === 'indoor' && !firstPerson && camCase !== 'title';
    INDOOR_FX.uCutOn.value = cut ? 1 : 0;
    if (cut) {
      INDOOR_FX.uCutA.value.copy(cp);
      INDOOR_FX.uCutB.value.set(cam.target.x, cam.target.y, cam.target.z);
    }

    const q = this.quality;
    const lod = lodZoom(this.baseFov, cam.fovDeg);
    this.carrier.update(view.serverTime, cam, time);
    const sf = this.sceneFrame;
    sf.time = time;
    sf.dt = dt;
    sf.serverTime = view.serverTime;
    sf.view = cam;
    sf.quality = q;
    sf.lod = lod;
    sf.zone = view.zone;
    sf.firstPerson = firstPerson;
    sf.carrier = this.carrier.visible ? this.carrier.position : null;
    this.world.update(sf);

    this.loot.update(view.loot, view.highlightLootId, time, this.frustum, cp, q.lootDrawDistance * lod);
    this.players.setOutlineDistance(q.characterOutlineDistance * lod);
    this.markers.begin();
    const pf = this.playersFrame;
    pf.time = time;
    pf.dt = dt;
    pf.serverTime = view.serverTime;
    pf.cam.copy(cp);
    pf.follow = cam.mode === 'follow' && !firstPerson;
    const subject: PlayerId | null = firstPerson ? (cam.subjectId ?? view.localId) : null;
    pf.hideId = subject;
    pf.localAds = view.ads?.cameraBlend ?? 0;
    this.players.update(view.players, pf);
    this.grenades.update(view.grenades, view.grenadeArc, view.serverTime, dt, time);
    this.markers.end();
    this.tags.update(view.players, cp);
    this.speedLines.update(firstPerson && this.subjectInFreefall(view, subject), cp, time, dt, this.balance.drop?.freefallSpeed ?? 20);
    // M2c: rockets (rocketPosAt positions from ClientGame) and the broken office panes.
    this.vfx.reducedMotion = view.reducedMotion;
    this.rockets.update(view.rockets ?? NO_ROCKETS, time, view.reducedMotion);
    this.world.setBrokenPanes?.(view.brokenPanes ?? NO_PANES);
    this.vfx.update(dt);
    // M2c: FrameView.smokes is optional until the C-gate (absent = no clouds). The veil draws last in the world pass,
    // so it sits before the viewmodel pass (own hands visible).
    this.smoke.update(view.smokes ?? NO_SMOKES, view.serverTime, this.balance.items.smoke?.cloud ?? null, cp, time, view.reducedMotion);
    this.viewmodel.update(view, dt);

    this.gl.render(this.scene, this.camera);
    this.viewmodel.render(this.gl, this.camera);

    this.listener.pos.x = cp.x;
    this.listener.pos.y = cp.y;
    this.listener.pos.z = cp.z;
    this.listener.yaw = cam.yaw;

    this.frameMs[this.frameIdx] = dt * 1000;
    this.cpuMs[this.frameIdx] = performance.now() - t0;
    this.frameIdx = (this.frameIdx + 1) % FRAME_SAMPLES;
    this.frameCount++;
  }

  private subjectInFreefall(view: FrameView, id: PlayerId | null): boolean {
    if (id === null || view.reducedMotion) return false;
    for (let i = 0; i < view.players.length; i++) {
      const s = view.players[i].state;
      if (s.id === id) return dropPhaseOf(s) === 'freefall';
    }
    return false;
  }

  resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.gl.setPixelRatio(Math.min(dpr, this.quality.maxPixelRatio));
    this.gl.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.updatePointProjection();
  }

  /** Camera pose after the last render(). Returns the same object every call (copy it if you keep it). */
  getListenerPose(): ListenerPose {
    return this.listener;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.viewmodel.dispose();
    this.vfx.dispose();
    this.markers.dispose();
    this.tags.dispose();
    this.players.dispose();
    this.rockets.dispose();
    this.grenades.dispose();
    disposeSkinCache();
    this.loot.dispose();
    this.items.dispose();
    this.carrier.dispose();
    this.speedLines.dispose();
    this.smoke.dispose();
    this.world.dispose();
    resetIndoorFx();
    this.sunRig.sun.shadow.map?.dispose();
    this.scene.clear();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.gl.dispose();
    this.canvas.remove();
    if (import.meta.env.DEV) delete (window as unknown as { __render?: unknown }).__render;
  }

  /**
   * IRenderer.setQuality (Contract revision 1 #7): switch preset at runtime. Antialias only applies at construction
   * (WebGL limitation). Unknown values are ignored. main.ts calls it only when the setting changes, because this
   * reallocates the shadow map when the size differs.
   */
  setQuality(quality: QualityLevel): void {
    if (this.disposed || !Object.prototype.hasOwnProperty.call(QUALITY_PRESETS, quality)) return;
    this.qualityName = quality;
    this.quality = QUALITY_PRESETS[quality];
    this.applyQuality();
    this.resize();
  }

  /**
   * IRenderer.getGraphicsStatus (ADR 0003 §5): 'restoring' while the context is lost, 'failed' once
   * CONTEXT_RESTORE_TIMEOUT_MS passes without webglcontextrestored, 'ok' otherwise (also after a late restore).
   * main.ts polls it after each render(). Allocation-free.
   */
  getGraphicsStatus(): GraphicsStatus {
    return this.health.status(performance.now());
  }

  // ------------------------------------------------------------------------------------------------
  // Extras (not in IRenderer)
  // ------------------------------------------------------------------------------------------------

  getStats(): RenderStats {
    const n = Math.min(this.frameCount, FRAME_SAMPLES);
    let sum = 0, cpu = 0;
    const sorted: number[] = [];
    for (let i = 0; i < n; i++) {
      sum += this.frameMs[i];
      cpu += this.cpuMs[i];
      sorted.push(this.frameMs[i]);
    }
    sorted.sort((a, b) => a - b);
    const info = this.gl.info;
    const avg = n ? sum / n : 0;
    return {
      fps: avg > 0 ? 1000 / avg : 0,
      frameMsAvg: avg,
      frameMsP95: n ? sorted[Math.min(n - 1, Math.floor(n * 0.95))] : 0,
      cpuRenderMsAvg: n ? cpu / n : 0,
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      particles: this.vfx.particles.liveCount,
      quality: this.qualityName,
      contextLost: this.health.isLost,
      contextLosses: this.health.lossCount,
      mapId: this.world.mapId,
      mapKind: this.world.kind,
    };
  }

  /**
   * M4: called after three.js has re-created its GL state on webglcontextrestored. three re-uploads every geometry,
   * texture and render target from its CPU copy on the next render (all of ours keep one: DataTextures, canvas
   * textures and BufferAttributes; nothing frees its array after upload) and recompiles programs. What it cannot know
   * about is renderer-side state derived from the old context, so rebuild that here.
   */
  private restoreGpuState(): void {
    if (this.disposed) return;
    this.health.restored();
    this.readPointSizeRange();
    // Force the per-mode shadow frustum, projection, point-size and name-tag scale to be re-applied next frame.
    this.lastMode = null;
    this.lastFov = -1;
    this.applyQuality();
    this.resize();
  }

  private readPointSizeRange(): void {
    const ctx = this.gl.getContext();
    const range = ctx.getParameter(ctx.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
    if (range && range.length > 1) this.maxPointPx = Math.min(512, range[1]);
  }

  private applyQuality(): void {
    const q = this.quality;
    this.gl.shadowMap.enabled = q.shadows;
    this.sunRig.configure(
      q.shadows,
      q.shadowMapSize,
      this.lastMode === 'orbit' ? this.world.orbitShadowExtent : q.shadowHalfExtent,
    );
    this.world.setQuality(q);
    this.players.setOutlineDistance(q.characterOutlineDistance);
  }

  private updatePointProjection(): void {
    const h = this.gl.getDrawingBufferSize(this.drawSize).y;
    this.vfx.particles.setProjection(h, this.camera.fov, this.maxPointPx);
    this.markers.setProjection(h, this.camera.fov, this.maxPointPx);
  }

  private installDevHook(): void {
    if (!import.meta.env.DEV || typeof window === 'undefined') return;
    (window as unknown as { __render?: unknown }).__render = {
      info: this.gl.info,
      renderer: this.gl,
      scene: this.scene,
      camera: this.camera,
      stats: () => this.getStats(),
      setQuality: (p: QualityPreset) => this.setQuality(p),
      presets: QUALITY_PRESETS,
      world: () => this.world,
    };
  }
}

/**
 * LOD distance multiplier for a zoomed camera: tan(base/2) / tan(fov/2), clamped to [1, MAX_LOD_ZOOM]. A target
 * seen through a 4x scope keeps the outline and loot it would have at a quarter of the distance. Pure; exported
 * for tests.
 */
export function lodZoom(baseFovDeg: number, fovDeg: number): number {
  if (!(fovDeg > 0) || !(baseFovDeg > 0)) return 1;
  const z = Math.tan((baseFovDeg * Math.PI) / 360) / Math.tan((fovDeg * Math.PI) / 360);
  return z < 1 ? 1 : z > MAX_LOD_ZOOM ? MAX_LOD_ZOOM : z;
}
