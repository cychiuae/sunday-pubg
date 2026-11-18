/**
 * Indoor map world (M2b office, STYLE.md §19; ARCHITECTURE §15.7; ADR 0005 §2, §5). Owner: graphics-engineer.
 *
 * Draw-call plan (all static, built once per map change, disposed on the next one):
 *   - floor: ONE plane; plank / carpet / tile pattern and seams computed per fragment from world xz and a nearest
 *     floor-zone texture (no big textures), plus the under-desk cover darkening and the sprinkler wet sheen.
 *   - kit props: merged per 40 m chunk into one body + one hull mesh (hull width per vertex), so ~510 placements of
 *     ~34 kinds cost ~2 calls per visible chunk instead of ~80 instanced calls. Office props never move.
 *   - walls (wallFrame): one body + one hull mesh for every run; glass panes (walls and kit parts) in ONE glass mesh and
 *     the frosted bands + glare in ONE frost mesh, both transparent and drawn after opaque (renderOrder 1 / 2).
 *   - ceiling: a dark plane at ceilingHeight (nothing renders above it), merged ducts, and the kit's 'ceiling' kinds
 *     (light panels, AC cassettes) instanced so they can retract (office.md T13, below).
 *   - zone: RainCurtain (sprinklers).
 * Materials are render-owned clones patched with the cover darkening and the 3P cut-away (indoorFx.ts).
 *
 * T13 (light panels hang at 20.9-21.6 m, below the 25 m drone and the jump start): ceiling props near the carrier, or
 * near a camera above them, retract toward the ceiling (render-only, eased). The drone never clips a panel or an AC
 * unit, and a player falling past a panel does not see its inside.
 */
import * as THREE from 'three';
import { isIndoor } from '../shared/maps';
import { wallFrame } from '../shared/maps';
import type { FloorMaterial, IndoorMapData, IndoorPropPlacement, KitCollider, PropKitEntry, Rect } from '../shared/types';
import { CameraObstacles } from './cameraRig';
import { COVER_HEIGHT_STEP, createMergedOutlineMaterial, INDOOR_FX, patchIndoor, resetIndoorFx } from './indoorFx';
import type { MapScene, MapSceneFrame } from './mapScene';
import { MergeBucket } from './mergeBuilder';
import {
  buildMerged, getOfficePropParts, getOfficeWallParts, getToonGradient, OFFICE_PROP_KINDS, OFFICE_WALL_HEIGHT,
  officeFrostMaterial, officeGlassMaterial, officeGlowMaterial, officePalette, OUTLINE, vertexColorToon,
  type OfficePropKind, type PropPart,
} from './procedural';
import { type QualityPreset, type QualitySettings } from './quality';
import { RainCurtain, RAIN_STREAKS } from './RainCurtain';
import type { SceneLook } from './Sky';

/** Chunk edge for merged props (m). */
const CHUNK = 40;
/** Cover / zone texture cell (m). */
const COVER_CELL = 0.5;
const ZONE_CELL = 0.45;
/** Raised collider boxes whose underside is this high above their support cover a crawlspace (m). */
const COVER_MIN_GAP = 1.4;
const COVER_MAX_GAP = 10;
/** Wall module thickness the wall geometry is authored with (0.1 m real x 9). */
const WALL_MODEL_THICKNESS = 0.9;
/** T13: retract when the carrier is within this horizontal distance of a ceiling prop (m) ... */
const RETRACT_CARRIER_R = 10;
/** ... or a camera is within this distance and above (lowest point - CAMERA_BAND). */
const RETRACT_CAMERA_R = 6;
const RETRACT_CAMERA_BAND = 3;
/** Retracted ceiling props keep their lowest point at least this far above... the ceiling minus this (m). */
const RETRACT_CLEAR = 1.0;
const RETRACT_RATE = 7;

/** STYLE.md §19.4 office light (fluorescent key light almost overhead, warm wood bounce, dark fog). */
export const OFFICE_LOOK: SceneLook = {
  sunDir: new THREE.Vector3(-0.25, 0.9, -0.35).normalize(),
  sunColor: 0xf2f8ff,
  sunIntensity: 1.8,
  hemiSky: 0xeef6ff,
  hemiGround: 0xd9ae7a,
  hemiIntensity: 1.25,
  fogColor: officePalette.ceiling,
  fogNear: 120,
  fogFar: 300,
  background: officePalette.ceiling,
  shadowBias: -0.0006,
  shadowNormalBias: 0.09,
};

const FLOOR_IDS: Record<FloorMaterial, number> = { wood: 0, carpet: 1, tile: 2 };

/** Floor material at (x, z): later zones win, else the floor's own material (ADR 0005 §2). Pure; exported for tests. */
export function floorMaterialAt(map: Pick<IndoorMapData, 'floorZones' | 'floorMaterial'>, x: number, z: number): FloorMaterial {
  const zs = map.floorZones;
  for (let i = zs.length - 1; i >= 0; i--) {
    const r = zs[i];
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return r.material;
  }
  return map.floorMaterial;
}

/** T(x, y, z) * Ry(rotY) * S(scale) (same convention as PropLayer.propMatrix and the sim's placement transform). */
export function placementMatrix(p: IndoorPropPlacement, out = new THREE.Matrix4()): THREE.Matrix4 {
  const c = Math.cos(p.rotY) * p.scale;
  const s = Math.sin(p.rotY) * p.scale;
  return out.set(c, 0, s, p.x, 0, p.scale, 0, p.y, -s, 0, c, p.z, 0, 0, 0, 1);
}

/** World matrix of a wall run's model (authored along X, centred, y 0..OFFICE_WALL_HEIGHT, 0.9 m thick). */
export function wallMatrix(w: IndoorMapData['walls'][number], modelLength: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  const f = wallFrame(w);
  const sx = (f.halfLength * 2) / Math.max(1e-6, modelLength);
  const sy = (w.top - w.bottom) / OFFICE_WALL_HEIGHT;
  const sz = (f.halfThickness * 2) / WALL_MODEL_THICKNESS;
  const c = Math.cos(f.rotY), s = Math.sin(f.rotY);
  // T * Ry * S(sx, sy, sz)
  return out.set(c * sx, 0, s * sz, f.cx, 0, sy, 0, w.bottom, -s * sx, 0, c * sz, f.cz, 0, 0, 0, 1);
}

/**
 * Top-down cover data (STYLE.md §19.4 "Under desks"): R = covered (255), G = the covering underside height and
 * B = the highest walkable top, both in COVER_HEIGHT_STEP units. Built from the kit's collider boxes and cylinders.
 * Pure (no GPU); exported for tests.
 */
export interface CoverData {
  data: Uint8Array;
  width: number;
  height: number;
  rect: Rect;
  cell: number;
}

export function buildCoverData(map: IndoorMapData, cell = COVER_CELL): CoverData {
  const f = map.floor;
  const rect: Rect = { minX: f.minX - cell, minZ: f.minZ - cell, maxX: f.maxX + cell, maxZ: f.maxZ + cell };
  const width = Math.ceil((rect.maxX - rect.minX) / cell);
  const height = Math.ceil((rect.maxZ - rect.minZ) / cell);
  const under = new Float32Array(width * height).fill(Infinity);
  const top = new Float32Array(width * height);
  const enc = (h: number) => Math.max(0, Math.min(255, Math.round(h / COVER_HEIGHT_STEP)));
  const stamp = (p: IndoorPropPlacement, c: KitCollider, entry: PropKitEntry) => {
    const s = p.scale;
    const cs = Math.cos(p.rotY), sn = Math.sin(p.rotY);
    let x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, round = false, cr = 0;
    if (c.type === 'cylinder') {
      x0 = c.x - c.r; x1 = c.x + c.r; z0 = c.z - c.r; z1 = c.z + c.r; y0 = c.y0; y1 = c.y1; round = true; cr = c.r;
    } else {
      x0 = c.min[0]; x1 = c.max[0]; z0 = c.min[2]; z1 = c.max[2]; y0 = c.min[1]; y1 = c.max[1];
    }
    const gap = y0 * s;
    const covers = c.type === 'box' && entry.origin !== 'ceiling' && gap >= COVER_MIN_GAP && gap <= COVER_MAX_GAP;
    const ub = p.y + y0 * s, tb = p.y + y1 * s;
    // World AABB of the rotated footprint.
    const lx = [x0, x1, x1, x0], lz = [z0, z0, z1, z1];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < 4; k++) {
      const wx = p.x + (lx[k] * cs + lz[k] * sn) * s;
      const wz = p.z + (-lx[k] * sn + lz[k] * cs) * s;
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
    }
    const i0 = Math.max(0, Math.floor((minX - rect.minX) / cell)), i1 = Math.min(width - 1, Math.floor((maxX - rect.minX) / cell));
    const j0 = Math.max(0, Math.floor((minZ - rect.minZ) / cell)), j1 = Math.min(height - 1, Math.floor((maxZ - rect.minZ) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const wx = rect.minX + (i + 0.5) * cell - p.x, wz = rect.minZ + (j + 0.5) * cell - p.z;
        // World -> local (inverse rotation, unscaled).
        const ux = (wx * cs - wz * sn) / s, uz = (wx * sn + wz * cs) / s;
        if (round) {
          const cx0 = ux - (x0 + cr), cz0 = uz - (z0 + cr);
          if (cx0 * cx0 + cz0 * cz0 > cr * cr) continue;
        } else if (ux < x0 || ux > x1 || uz < z0 || uz > z1) continue;
        const k = j * width + i;
        if (tb > top[k]) top[k] = tb;
        if (covers && ub < under[k]) under[k] = ub;
      }
    }
  };
  for (const p of map.props) {
    const entry = map.kit[p.kind];
    if (!entry) continue;
    for (const c of entry.colliders) if (c.type !== 'ramp') stamp(p, c, entry);
  }
  const data = new Uint8Array(width * height * 4);
  for (let k = 0; k < width * height; k++) {
    const covered = Number.isFinite(under[k]);
    data[k * 4] = covered ? 255 : 0;
    data[k * 4 + 1] = covered ? enc(under[k]) : 0;
    data[k * 4 + 2] = enc(top[k]);
    data[k * 4 + 3] = 255;
  }
  // Dilate the underside height one cell into uncovered neighbours, so linear filtering at the edges of a cover
  // still reads the right height (R carries the soft edge).
  const g = new Uint8Array(width * height);
  for (let k = 0; k < width * height; k++) g[k] = data[k * 4 + 1];
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      if (data[k * 4] !== 0) continue;
      let best = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= width || jj >= height) continue;
          const v = g[jj * width + ii];
          if (v > 0 && (best === 0 || v < best)) best = v;
        }
      }
      if (best > 0) data[k * 4 + 1] = best;
    }
  }
  return { data, width, height, rect, cell };
}

/** Sample the B channel (walkable top) of cover data at (x, z), nearest cell. */
export function coverTopAt(c: CoverData, x: number, z: number): number {
  const i = Math.floor((x - c.rect.minX) / c.cell), j = Math.floor((z - c.rect.minZ) / c.cell);
  if (i < 0 || j < 0 || i >= c.width || j >= c.height) return 0;
  return c.data[(j * c.width + i) * 4 + 2] * COVER_HEIGHT_STEP;
}

const isOfficeModel = (kind: string): kind is OfficePropKind => (OFFICE_PROP_KINDS as readonly string[]).includes(kind);
const outlineWidthOf = (m: THREE.Material): number =>
  ((m.userData?.outlineUniforms as { outlineThickness?: { value: number } } | undefined)?.outlineThickness?.value) ?? OUTLINE.prop;

interface Chunk {
  body: THREE.Mesh | null;
  hull: THREE.Mesh | null;
  box: THREE.Box3;
}

/** Instanced, retractable ceiling props of one kind (T13). */
interface CeilingSet {
  meshes: THREE.InstancedMesh[];
  base: THREE.Matrix4[];
  /** Local rectangle (x0, z0, x1, z1) and inverse rotation per instance for the proximity test. */
  px: Float32Array;
  pz: Float32Array;
  cos: Float32Array;
  sin: Float32Array;
  hx: Float32Array;
  hz: Float32Array;
  /** Lowest point (world y) and the full lift to the retracted pose. */
  low: Float32Array;
  lift: Float32Array;
  k: Float32Array;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _box = new THREE.Box3();
const _v = new THREE.Vector3();

export class IndoorScene implements MapScene {
  readonly kind = 'indoor' as const;
  readonly mapId: string;
  readonly group = new THREE.Group();
  readonly look = OFFICE_LOOK;
  readonly obstacles: CameraObstacles;
  readonly orbitShadowExtent: number;
  readonly cameraFar: number;
  readonly cover: CoverData;
  private readonly map: IndoorMapData;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly chunks: Chunk[] = [];
  private readonly ceilingSets: CeilingSet[] = [];
  private readonly rain: RainCurtain;
  private readonly bodyMat: THREE.MeshToonMaterial;
  private readonly hullMat: THREE.MeshBasicMaterial;
  /** Triangle counts per layer (dev stats / RENDERING.md). */
  readonly stats = { chunks: 0, propTris: 0, hullTris: 0, wallTris: 0, glassTris: 0, ceilingInstances: 0 };

  constructor(map: IndoorMapData, quality: QualitySettings, opts: { zoneTheme: string; preset: QualityPreset; splash: (x: number, y: number, z: number) => void }) {
    if (!isIndoor(map)) throw new Error('IndoorScene needs an indoor map');
    this.map = map;
    this.mapId = map.id;
    this.group.name = `indoor:${map.id}`;
    const f = map.floor;
    const w = f.maxX - f.minX, d = f.maxZ - f.minZ;
    this.orbitShadowExtent = Math.min(160, Math.max(w, d) * 0.6);
    this.cameraFar = Math.max(400, Math.hypot(w, d) + 100);

    this.bodyMat = this.own(patchIndoor(vertexColorToon().clone(), 'officeBody', { cover: true, cut: true }));
    this.bodyMat.name = 'office:body';
    this.hullMat = this.own(createMergedOutlineMaterial('office:hull'));

    // Cover texture (under-desk darkening, rain stop, splash heights).
    this.cover = buildCoverData(map);
    const coverTex = new THREE.DataTexture(this.cover.data, this.cover.width, this.cover.height, THREE.RGBAFormat);
    coverTex.magFilter = THREE.LinearFilter;
    coverTex.minFilter = THREE.LinearFilter;
    coverTex.generateMipmaps = false;
    coverTex.needsUpdate = true;
    coverTex.name = 'office:cover';
    this.textures.push(coverTex);
    INDOOR_FX.uCoverTex.value = coverTex;
    const cr = this.cover.rect;
    INDOOR_FX.uCoverRect.value.set(cr.minX, cr.minZ, 1 / (this.cover.width * this.cover.cell), 1 / (this.cover.height * this.cover.cell));
    INDOOR_FX.uCoverOn.value = 1;

    this.rain = new RainCurtain({
      ceiling: map.ceilingHeight,
      rain: opts.zoneTheme === 'sprinklers',
      streaks: RAIN_STREAKS[opts.preset],
      topAt: (x, z) => coverTopAt(this.cover, x, z),
      splash: opts.splash,
    });

    this.buildFloor();
    this.buildWallsAndProps();
    this.buildCeiling();
    this.group.add(this.rain.group);

    this.obstacles = new CameraObstacles(() => 0, [], Math.max(w, d));
    this.obstacles.setLimits(map.ceilingHeight, f);
    void quality;
  }

  private own<T extends THREE.Material>(m: T): T {
    this.mats.push(m);
    return m;
  }

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, cast: boolean, receive: boolean, order = 0): THREE.Mesh {
    this.geos.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.renderOrder = order;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    this.group.add(m);
    return m;
  }

  // ------------------------------------------------------------------------------------------------
  // Floor
  // ------------------------------------------------------------------------------------------------
  private buildFloor(): void {
    const map = this.map;
    const f = map.floor;
    // Zone ids, nearest-sampled.
    const zr: Rect = { minX: f.minX - 2, minZ: f.minZ - 2, maxX: f.maxX + 2, maxZ: f.maxZ + 2 };
    const zw = Math.ceil((zr.maxX - zr.minX) / ZONE_CELL), zh = Math.ceil((zr.maxZ - zr.minZ) / ZONE_CELL);
    const zd = new Uint8Array(zw * zh);
    for (let j = 0; j < zh; j++) {
      for (let i = 0; i < zw; i++) {
        zd[j * zw + i] = FLOOR_IDS[floorMaterialAt(map, zr.minX + (i + 0.5) * ZONE_CELL, zr.minZ + (j + 0.5) * ZONE_CELL)] ?? 0;
      }
    }
    const zoneTex = new THREE.DataTexture(zd, zw, zh, THREE.RedFormat, THREE.UnsignedByteType);
    zoneTex.magFilter = THREE.NearestFilter;
    zoneTex.minFilter = THREE.NearestFilter;
    zoneTex.generateMipmaps = false;
    zoneTex.needsUpdate = true;
    zoneTex.name = 'office:floorZones';
    this.textures.push(zoneTex);

    const P = officePalette;
    const col = (hex: number) => new THREE.Color(hex);
    const uniforms = {
      uZoneTex: { value: zoneTex },
      uZoneRect: { value: new THREE.Vector4(zr.minX, zr.minZ, 1 / (zw * ZONE_CELL), 1 / (zh * ZONE_CELL)) },
      uPlankA: { value: col(P.floorPlank) },
      uPlankB: { value: col(P.floorPlank2) },
      uSeam: { value: col(P.floorSeam) },
      uCarpetA: { value: col(P.carpet) },
      uCarpetB: { value: col(P.carpet2) },
      uTile: { value: col(P.tile) },
      uGrout: { value: col(P.tileGrout) },
      uWetCol: { value: col(0x8fa6b5) },
      uWet: this.rain.wet,
    };
    const mat = this.own(new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: getToonGradient() }));
    mat.name = 'office:floor';
    patchIndoor(mat, 'officeFloor', { cover: true });
    const indoorCompile = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      indoorCompile.call(mat, shader, r);
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <clipping_planes_pars_fragment>', `#include <clipping_planes_pars_fragment>\n${FLOOR_GLSL}`)
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( officeFloor( vIndoorW.xz ), opacity );');
    };
    const geo = new THREE.PlaneGeometry(f.maxX - f.minX + 2, f.maxZ - f.minZ + 2).rotateX(-Math.PI / 2);
    geo.translate((f.minX + f.maxX) / 2, 0, (f.minZ + f.maxZ) / 2);
    geo.name = 'office:floor';
    this.mesh(geo, mat, 'office:floor', false, true);
  }

  // ------------------------------------------------------------------------------------------------
  // Walls + kit props (merged)
  // ------------------------------------------------------------------------------------------------
  private buildWallsAndProps(): void {
    const map = this.map;
    const f = map.floor;
    const nx = Math.max(1, Math.ceil((f.maxX - f.minX) / CHUNK));
    const nz = Math.max(1, Math.ceil((f.maxZ - f.minZ) / CHUNK));
    const bodies = Array.from({ length: nx * nz }, () => new MergeBucket());
    const hulls = Array.from({ length: nx * nz }, () => new MergeBucket(true));
    const wallBody = new MergeBucket(), wallHull = new MergeBucket(true);
    const glass = new MergeBucket(), frost = new MergeBucket(), glow = new MergeBucket();
    const ceilBody = new MergeBucket(), ceilHull = new MergeBucket(true);
    const placeholderGeos: THREE.BufferGeometry[] = [];

    const addParts = (parts: readonly PropPart[], m: THREE.Matrix4, body: MergeBucket, hull: MergeBucket) => {
      for (const part of parts) {
        const pm = part.matrix ? _m2.multiplyMatrices(m, part.matrix).clone() : m.clone();
        switch (part.name) {
          case 'outline': hull.add(part.geometry, pm, outlineWidthOf(part.material)); break;
          case 'glass': glass.add(part.geometry, pm); break;
          case 'frost': frost.add(part.geometry, pm); break;
          case 'glow': glow.add(part.geometry, pm); break;
          default: body.add(part.geometry, pm);
        }
      }
    };

    // Walls (wallFrame through wallMatrix).
    for (const w of map.walls) {
      const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
      if (!(len > 0)) continue;
      const parts = getOfficeWallParts(w.material, len);
      const body = parts[0].geometry;
      if (!body.boundingBox) body.computeBoundingBox();
      const modelLen = body.boundingBox!.max.x - body.boundingBox!.min.x;
      addParts(parts, wallMatrix(w, modelLen, _m), wallBody, wallHull);
    }

    // Kit props, by origin: 'ceiling' kinds are instanced (retractable), the rest merged per chunk.
    const ceilingByKind = new Map<string, IndoorPropPlacement[]>();
    for (const p of map.props) {
      const entry = map.kit[p.kind];
      if (!entry) continue;
      if (entry.origin === 'ceiling' && isOfficeModel(p.kind)) {
        let list = ceilingByKind.get(p.kind);
        if (!list) ceilingByKind.set(p.kind, (list = []));
        list.push(p);
        continue;
      }
      const parts = isOfficeModel(p.kind) ? getOfficePropParts(p.kind) : this.placeholder(p.kind, entry, placeholderGeos);
      const ci = Math.min(nx - 1, Math.max(0, Math.floor((p.x - f.minX) / CHUNK)));
      const cj = Math.min(nz - 1, Math.max(0, Math.floor((p.z - f.minZ) / CHUNK)));
      const k = cj * nx + ci;
      placementMatrix(p, _m);
      if (entry.origin === 'ceiling') addParts(parts, _m, ceilBody, ceilHull);
      else addParts(parts, _m, bodies[k], hulls[k]);
    }

    for (let k = 0; k < bodies.length; k++) {
      const bg = bodies[k].build(`office:chunk${k}:body`);
      const hg = hulls[k].build(`office:chunk${k}:hull`);
      if (!bg && !hg) continue;
      this.stats.propTris += bodies[k].triangles;
      this.stats.hullTris += hulls[k].triangles;
      const box = new THREE.Box3();
      if (bg) box.union(bg.boundingBox!);
      if (hg) box.union(hg.boundingBox!);
      this.chunks.push({
        body: bg ? this.mesh(bg, this.bodyMat, `office:chunk${k}:body`, true, true) : null,
        hull: hg ? this.mesh(hg, this.hullMat, `office:chunk${k}:hull`, false, false) : null,
        box,
      });
    }
    this.stats.chunks = this.chunks.length;
    this.stats.wallTris = wallBody.triangles + wallHull.triangles;
    this.stats.glassTris = glass.triangles + frost.triangles;
    const wb = wallBody.build('office:walls');
    if (wb) this.mesh(wb, this.bodyMat, 'office:walls', true, true);
    const wh = wallHull.build('office:wallHull');
    if (wh) this.mesh(wh, this.hullMat, 'office:wallHull', false, false);
    const cb = ceilBody.build('office:ceilingProps');
    if (cb) this.mesh(cb, this.bodyMat, 'office:ceilingProps', false, false);
    const ch = ceilHull.build('office:ceilingHull');
    if (ch) this.mesh(ch, this.hullMat, 'office:ceilingHull', false, false);

    const gm = glass.build('office:glass');
    if (gm) this.mesh(gm, this.own(patchIndoor(officeGlassMaterial().clone(), 'officeGlass', { cut: true })), 'office:glass', false, false, 1);
    const fm = frost.build('office:frost');
    if (fm) this.mesh(fm, this.own(patchIndoor(officeFrostMaterial().clone(), 'officeFrost', { cut: true })), 'office:frost', false, false, 2);
    const glowMat = this.own(patchIndoor(officeGlowMaterial().clone(), 'officeGlow', { cut: true }));
    const gl = glow.build('office:glow');
    if (gl) this.mesh(gl, glowMat, 'office:glow', false, false);
    for (const g of placeholderGeos) g.dispose();

    for (const [kind, list] of ceilingByKind) this.buildCeilingSet(kind as OfficePropKind, list, glowMat);
  }

  /** Box of the kit's drawn size for kinds without a render model (never expected for the office kit). */
  private placeholder(kind: string, entry: PropKitEntry, owned: THREE.BufferGeometry[]): PropPart[] {
    const [sx, sy, sz] = entry.size;
    const y0 = entry.origin === 'ceiling' ? -sy : 0;
    const zc = entry.origin === 'wall' ? -sz / 2 : 0;
    const m = buildMerged([{ geo: new THREE.BoxGeometry(sx, sy, sz).translate(0, y0 + sy / 2, zc), color: officePalette.wallShade, flat: true }], `office:placeholder:${kind}`);
    owned.push(m.geometry);
    const parts: PropPart[] = [{ name: 'body', geometry: m.geometry, material: this.bodyMat, matrix: new THREE.Matrix4(), castShadow: true, receiveShadow: true }];
    if (m.outline) {
      owned.push(m.outline);
      parts.push({ name: 'outline', geometry: m.outline, material: this.hullMat, matrix: new THREE.Matrix4(), castShadow: false, receiveShadow: false });
    }
    return parts;
  }

  private buildCeilingSet(kind: OfficePropKind, list: IndoorPropPlacement[], glowMat: THREE.Material): void {
    const parts = getOfficePropParts(kind);
    const bodyGeo = parts.find((p) => p.name === 'body')?.geometry;
    if (!bodyGeo) return;
    if (!bodyGeo.boundingBox) bodyGeo.computeBoundingBox();
    const bb = bodyGeo.boundingBox!;
    const n = list.length;
    const meshes: THREE.InstancedMesh[] = [];
    for (const part of parts) {
      let geo = part.geometry, mat: THREE.Material = this.bodyMat;
      if (part.name === 'outline') {
        const b = new MergeBucket(true);
        b.add(part.geometry, new THREE.Matrix4(), outlineWidthOf(part.material));
        geo = b.build(`office:${kind}:hull`)!;
        this.geos.push(geo);
        mat = this.hullMat;
      } else if (part.name === 'glow') {
        mat = glowMat;
      } else if (part.name !== 'body') {
        continue;
      }
      const im = new THREE.InstancedMesh(geo, mat, n);
      im.name = `office:${kind}:${part.name}`;
      im.castShadow = false;
      im.receiveShadow = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(im);
      meshes.push(im);
    }
    const set: CeilingSet = {
      meshes, base: [], px: new Float32Array(n), pz: new Float32Array(n), cos: new Float32Array(n), sin: new Float32Array(n),
      hx: new Float32Array(n), hz: new Float32Array(n), low: new Float32Array(n), lift: new Float32Array(n), k: new Float32Array(n),
    };
    const ceil = this.map.ceilingHeight;
    list.forEach((p, i) => {
      const m = placementMatrix(p, new THREE.Matrix4());
      set.base.push(m);
      set.px[i] = p.x;
      set.pz[i] = p.z;
      set.cos[i] = Math.cos(p.rotY);
      set.sin[i] = Math.sin(p.rotY);
      set.hx[i] = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)) * p.scale;
      set.hz[i] = Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z)) * p.scale;
      set.low[i] = p.y + bb.min.y * p.scale;
      set.lift[i] = Math.max(0, ceil - RETRACT_CLEAR - set.low[i]);
      for (const im of meshes) im.setMatrixAt(i, m);
    });
    for (const im of meshes) {
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    }
    this.stats.ceilingInstances += n;
    this.ceilingSets.push(set);
  }

  // ------------------------------------------------------------------------------------------------
  // Ceiling plane + ducts
  // ------------------------------------------------------------------------------------------------
  private buildCeiling(): void {
    const f = this.map.floor;
    const H = this.map.ceilingHeight;
    const w = f.maxX - f.minX + 4, d = f.maxZ - f.minZ + 4;
    const cx = (f.minX + f.maxX) / 2, cz = (f.minZ + f.maxZ) / 2;
    const geo = new THREE.PlaneGeometry(w, d).rotateX(Math.PI / 2).translate(cx, H, cz);
    geo.name = 'office:ceiling';
    const mat = this.own(new THREE.MeshBasicMaterial({ color: officePalette.ceiling }));
    mat.name = 'office:ceiling';
    this.mesh(geo, mat, 'office:ceiling', false, false);

    // Exposed ducts and pipes (graphics-engineer, office.md §6): long runs tight under the ceiling, above the drone.
    const P = officePalette;
    const pieces: Parameters<typeof buildMerged>[0] = [];
    const len = f.maxX - f.minX;
    for (const z of [cz - d * 0.3, cz + d * 0.05, cz + d * 0.32]) {
      pieces.push({ geo: new THREE.BoxGeometry(len, 0.9, 1.6), color: P.duct, matrix: new THREE.Matrix4().makeTranslation(cx, H - 0.55, z) });
      for (let x = f.minX + 12; x < f.maxX; x += 24) {
        pieces.push({ geo: new THREE.BoxGeometry(0.4, 0.6, 2.4), color: 0x6f757e, matrix: new THREE.Matrix4().makeTranslation(x, H - 0.4, z), outline: false });
      }
    }
    const lenZ = f.maxZ - f.minZ;
    for (const x of [cx - len * 0.36, cx + len * 0.12]) {
      pieces.push({
        geo: new THREE.CylinderGeometry(0.35, 0.35, lenZ, 8, 1, true),
        color: P.duct,
        matrix: new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(x, H - 0.45, cz)),
      });
    }
    const merged = buildMerged(pieces, 'office:ducts');
    for (const p of pieces) p.geo.dispose();
    this.mesh(merged.geometry, this.bodyMat, 'office:ducts', false, false);
    if (merged.outline) {
      const b = new MergeBucket(true);
      b.add(merged.outline, new THREE.Matrix4(), OUTLINE.large);
      const hg = b.build('office:ductsHull');
      merged.outline.dispose();
      if (hg) this.mesh(hg, this.hullMat, 'office:ductsHull', false, false);
    }
  }

  // ------------------------------------------------------------------------------------------------
  // MapScene
  // ------------------------------------------------------------------------------------------------
  heightAt(): number {
    return 0;
  }

  visualHeight(): number {
    return 0;
  }

  surfaceAt(x: number, z: number): FloorMaterial {
    return floorMaterialAt(this.map, x, z);
  }

  update(f: MapSceneFrame): void {
    const cp = f.camera.position;
    const outlineD2 = (f.quality.outlineDistance * f.lod) ** 2;
    for (const c of this.chunks) {
      if (!c.hull) continue;
      c.box.clampPoint(cp, _v);
      c.hull.visible = _v.distanceToSquared(cp) < outlineD2;
    }
    this.updateCeiling(cp, f.carrier, f.dt);
    this.rain.update(f.zone, cp, f.time, f.dt);
  }

  /** T13 retraction: ease each ceiling prop toward its lifted pose while the carrier or a camera is close. */
  private updateCeiling(cam: THREE.Vector3, carrier: THREE.Vector3 | null, dt: number): void {
    const a = 1 - Math.exp(-dt * RETRACT_RATE);
    for (const s of this.ceilingSets) {
      let dirty = false;
      for (let i = 0; i < s.base.length; i++) {
        let target = 0;
        if (carrier && this.near(s, i, carrier.x, carrier.z, RETRACT_CARRIER_R)) target = 1;
        else if (cam.y > s.low[i] - RETRACT_CAMERA_BAND && this.near(s, i, cam.x, cam.z, RETRACT_CAMERA_R)) target = 1;
        const k0 = s.k[i];
        let k = k0 + (target - k0) * a;
        if (Math.abs(target - k) < 0.002) k = target;
        if (k === k0) continue;
        s.k[i] = k;
        _m.copy(s.base[i]);
        _m.elements[13] += s.lift[i] * k * k * (3 - 2 * k);
        for (const im of s.meshes) im.setMatrixAt(i, _m);
        dirty = true;
      }
      if (dirty) for (const im of s.meshes) im.instanceMatrix.needsUpdate = true;
    }
  }

  private near(s: CeilingSet, i: number, x: number, z: number, r: number): boolean {
    const dx = x - s.px[i], dz = z - s.pz[i];
    // World -> local (rotY), then distance to the half-extent rectangle.
    const lx = dx * s.cos[i] - dz * s.sin[i], lz = dx * s.sin[i] + dz * s.cos[i];
    const ex = Math.max(0, Math.abs(lx) - s.hx[i]), ez = Math.max(0, Math.abs(lz) - s.hz[i]);
    return ex * ex + ez * ez < r * r;
  }

  pulseZone(): void {
    this.rain.pulseNow();
  }

  setQuality(): void {
    // Office cost knobs are the shared ones (shadows, outline distance, pixel ratio); rain density is set per build.
  }

  /** Placement bounds of the merged chunks (debug). */
  chunkBounds(out: THREE.Box3[] = []): THREE.Box3[] {
    for (const c of this.chunks) out.push(_box.copy(c.box).clone());
    return out;
  }

  dispose(): void {
    this.rain.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.textures) t.dispose();
    for (const s of this.ceilingSets) for (const im of s.meshes) im.dispose();
    this.geos.length = 0;
    this.mats.length = 0;
    this.textures.length = 0;
    this.group.clear();
    resetIndoorFx();
  }
}

/** Floor pattern (STYLE.md §19.2): planks 1.8 x 10.8 m staggered by thirds with seams, carpet 4.5 m two-tone squares,
 * 2.7 m tiles with grout, the sprinkler wet tint outside the circle. Anti-aliased seams fade out with distance. */
const FLOOR_GLSL = /* glsl */ `
uniform sampler2D uZoneTex;
uniform vec4 uZoneRect;
uniform vec3 uPlankA;
uniform vec3 uPlankB;
uniform vec3 uSeam;
uniform vec3 uCarpetA;
uniform vec3 uCarpetB;
uniform vec3 uTile;
uniform vec3 uGrout;
uniform vec3 uWetCol;
uniform vec4 uWet;
float floorHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float floorLine( float e, float halfW ) {
  float fw = max( fwidth( e ), 1e-4 );
  float l = 1.0 - smoothstep( halfW - fw, halfW + fw, e );
  return l * clamp( 1.5 - fw * 12.0, 0.0, 1.0 );
}
vec3 officeFloor( vec2 p ) {
  vec2 zuv = ( p - uZoneRect.xy ) * uZoneRect.zw;
  float id = texture2D( uZoneTex, zuv ).r * 255.0;
  vec3 c;
  if ( id < 0.5 ) {
    float row = floor( p.y / 1.8 );
    float u = ( p.x + mod( row, 3.0 ) * 3.6 ) / 10.8;
    c = floorHash( vec2( row, floor( u ) ) ) < 0.4 ? uPlankB : uPlankA;
    float ez = ( 0.5 - abs( fract( p.y / 1.8 ) - 0.5 ) ) * 1.8;
    float ex = ( 0.5 - abs( fract( u ) - 0.5 ) ) * 10.8;
    c = mix( c, uSeam, floorLine( min( ez, ex ), 0.04 ) );
  } else if ( id < 1.5 ) {
    vec2 q = floor( p / 4.5 );
    c = mod( q.x + q.y, 2.0 ) < 0.5 ? uCarpetA : uCarpetB;
  } else {
    vec2 t = abs( fract( p / 2.7 ) - 0.5 ) * 2.7;
    float e = 1.35 - max( t.x, t.y );
    c = mix( uTile, uGrout, floorLine( e, 0.05 ) );
  }
  if ( uWet.w > 0.5 ) {
    float k = smoothstep( uWet.z - 1.0, uWet.z + 2.0, length( p - uWet.xy ) );
    c = mix( c, uWetCol, 0.25 * k );
  }
  return c;
}
`;
