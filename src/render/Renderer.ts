/**
 * Renderer facade (IRenderer). Owner: graphics-engineer. Pipeline and budgets: docs/tech/RENDERING.md.
 *
 * Reads FrameView every frame and bus events for VFX; never mutates simulation state and never emits on the bus.
 * Scene: sky dome + clouds, terrain (polar grid on heightAt), toon water (one mesh to the horizon), instanced props
 * and loot, pooled chibis, tide wall, pooled particles and tracers. One shadow-casting sun whose tight frustum
 * follows the camera target.
 */
import * as THREE from 'three';
import type { Balance } from '../shared/balance';
import { CONTEXT_RESTORE_TIMEOUT_MS } from '../shared/constants';
import type { FrameView, GraphicsStatus, IRenderer, ListenerPose, QualityLevel } from '../shared/contracts';
import type { EventBus, GameEvents } from '../shared/events';
import type { MapData, Surface } from '../shared/types';
import { heightAt as simHeightAt, surfaceAt as simSurfaceAt } from '../shared/sim/terrain';
import { CameraObstacles, CameraRig } from './cameraRig';
import { disposeSkinCache } from './chibiSkin';
import { bakeHeightField, type HeightField } from './heightField';
import { ContextHealth } from './contextHealth';
import { LootLayer } from './LootLayer';
import { NameTags } from './NameTags';
import { PlayerViews } from './PlayerViews';
import { palette } from './procedural';
import { PropLayer } from './PropLayer';
import { DEFAULT_QUALITY, QUALITY_PRESETS, type QualityPreset, type QualitySettings } from './quality';
import { LIGHTING, Sky, SUN_DIRECTION, SunRig } from './Sky';
import { buildTerrain } from './TerrainMesh';
import { TideWall } from './TideWall';
import { Vfx } from './vfx/Vfx';
import { visualHeight } from './visualTerrain';
import { Water } from './Water';

/** Terrain / height-field coverage beyond the world boundary (m). */
const TERRAIN_MARGIN = 45;
const HORIZON_RADIUS = 2400;
const CAMERA_FAR = 2600;
const FRAME_SAMPLES = 240;

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
}

export class Renderer implements IRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly balance: Balance;
  private readonly heightField: HeightField;
  private readonly terrain: THREE.Mesh;
  private readonly water: Water;
  private readonly sky: Sky;
  private readonly sunRig: SunRig;
  private readonly props: PropLayer;
  private readonly loot: LootLayer;
  private readonly players: PlayerViews;
  private readonly tide: TideWall;
  private readonly tags: NameTags;
  private readonly vfx: Vfx;
  private readonly rig: CameraRig;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly focus = new THREE.Vector3();
  private readonly listener: ListenerPose = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
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

  constructor(
    private readonly container: HTMLElement,
    private readonly map: MapData,
    bus: EventBus<GameEvents>,
    balance: Balance,
  ) {
    // Contract revision 1 #10: the composition root (main.ts) injects balance; render never imports BALANCE.
    this.balance = balance;
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

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, CAMERA_FAR);
    this.camera.rotation.order = 'YXZ';
    this.scene.fog = new THREE.Fog(palette.fog, LIGHTING.fogNear, LIGHTING.fogFar);
    this.scene.background = new THREE.Color(palette.fog);

    const terrainRadius = map.worldRadius + TERRAIN_MARGIN;
    const vh = (x: number, z: number): number => visualHeight(x, z, map);
    const simH = (x: number, z: number): number => simHeightAt(x, z, map);
    const surf = (x: number, z: number): Surface => simSurfaceAt(x, z, map);

    // Height texture for water depth / foam and the tide wall skirt.
    const dryR = Math.max(0, map.islandRadius - map.shoreNoise.amplitude - map.beachWidth);
    this.heightField = bakeHeightField(vh, terrainRadius + 5, 512, dryR);

    this.sky = new Sky();
    this.scene.add(this.sky.group);
    this.sunRig = new SunRig();
    this.scene.add(this.sunRig.sun, this.sunRig.sun.target, this.sunRig.hemi);

    this.terrain = buildTerrain(map, vh, surf, terrainRadius).mesh;
    this.scene.add(this.terrain);

    this.water = new Water(map, this.heightField, SUN_DIRECTION, {
      detail: this.quality.waterDetail,
      denseRadius: terrainRadius,
      horizonRadius: HORIZON_RADIUS,
    });
    this.scene.add(this.water.mesh);

    this.props = new PropLayer(map, simH);
    this.scene.add(this.props.group);

    this.loot = new LootLayer(map, this.balance);
    this.scene.add(this.loot.group);

    this.players = new PlayerViews(this.balance, { onPoof: (x, y, z) => this.vfx.poof(x, y, z) });
    this.scene.add(this.players.group);

    this.tide = new TideWall(this.heightField, simH);
    this.scene.add(this.tide.group);

    this.tags = new NameTags(this.balance.player.height);
    this.scene.add(this.tags.mesh);

    this.rig = new CameraRig(new CameraObstacles(simH, this.props.colliders, terrainRadius));

    const cameraPosition = this.camera.position;
    this.vfx = new Vfx(
      bus,
      {
        cameraPosition,
        getMuzzle: (id, out) => this.players.getMuzzle(id, out),
        onShot: (id) => this.players.onShot(id),
        onDamaged: (id) => this.players.onDamaged(id),
        onKilled: (id) => this.players.onKilled(id),
        surfaceAt: surf,
        pulseTide: () => this.tide.pulseNow(),
        playerHeight: this.balance.player.height,
      },
      this.quality.maxParticles,
    );
    this.scene.add(this.vfx.particles.points, this.vfx.tracers.mesh);

    this.applyQuality();
    this.resize();
    this.installDevHook();
  }

  // ------------------------------------------------------------------------------------------------
  // IRenderer
  // ------------------------------------------------------------------------------------------------
  render(view: FrameView, dt: number): void {
    if (this.disposed || this.health.isLost) return;
    const t0 = performance.now();
    const time = view.time;
    const cam = view.camera;

    if (cam.mode !== this.lastMode) {
      this.lastMode = cam.mode;
      this.rig.reset();
      this.sunRig.configure(
        this.quality.shadows,
        this.quality.shadowMapSize,
        cam.mode === 'orbit' ? this.map.islandRadius + 15 : this.quality.shadowHalfExtent,
      );
    }
    if (cam.fovDeg !== this.lastFov) {
      this.lastFov = cam.fovDeg;
      this.camera.fov = cam.fovDeg;
      this.camera.updateProjectionMatrix();
      this.updatePointProjection();
      this.tags.setFov(cam.fovDeg);
    }

    const p = this.rig.update(cam, dt, cam.mode === 'follow');
    this.camera.position.set(p.x, p.y, p.z);
    this.camera.rotation.set(cam.pitch, cam.yaw, 0);
    this.camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    this.focus.set(cam.target.x, cam.target.y, cam.target.z);
    if (cam.mode === 'orbit') this.focus.set(cam.target.x, 0, cam.target.z);
    this.sunRig.follow(this.focus);

    const cp = this.camera.position;
    const q = this.quality;
    this.props.update(this.frustum, cp, time, q.propDrawDistance, q.outlineDistance);
    this.loot.update(view.loot, view.highlightLootId, time, this.frustum, cp, q.lootDrawDistance);
    const hideLocal = cam.mode === 'follow' && this.rig.actualDistance < 0.55;
    this.players.update(view.players, time, dt, cp, hideLocal);
    this.tags.update(view.players, cp);
    this.tide.update(view.zone, time, dt);
    this.water.update(time);
    this.sky.update(this.camera, time);
    this.vfx.update(dt);

    this.gl.render(this.scene, this.camera);

    this.listener.pos.x = cp.x;
    this.listener.pos.y = cp.y;
    this.listener.pos.z = cp.z;
    this.listener.yaw = cam.yaw;

    this.frameMs[this.frameIdx] = dt * 1000;
    this.cpuMs[this.frameIdx] = performance.now() - t0;
    this.frameIdx = (this.frameIdx + 1) % FRAME_SAMPLES;
    this.frameCount++;
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
    this.vfx.dispose();
    this.tags.dispose();
    this.players.dispose();
    disposeSkinCache();
    this.loot.dispose();
    this.props.dispose();
    this.tide.dispose();
    this.water.dispose();
    this.sky.dispose();
    this.terrain.geometry.dispose();
    this.heightField.texture.dispose();
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
      this.lastMode === 'orbit' ? this.map.islandRadius + 15 : q.shadowHalfExtent,
    );
    this.water.setDetail(q.waterDetail);
    this.players.setOutlineDistance(q.characterOutlineDistance);
  }

  private updatePointProjection(): void {
    const h = this.gl.getDrawingBufferSize(new THREE.Vector2()).y;
    this.vfx.particles.setProjection(h, this.camera.fov, this.maxPointPx);
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
    };
  }
}
