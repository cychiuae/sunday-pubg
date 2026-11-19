/**
 * M2c smoke clouds (art M2c §4.2, smoke.md, ADR 0007 §6-§7). Owner: graphics-engineer.
 *
 * Every live cloud shares 3 draw calls (opaque core, instanced puffs, instanced puff hulls), plus 1 full-screen veil
 * while the camera is inside a cloud. The shape is a pure function of the server time: `radius` = `smokeRadiusAt`
 * (src/shared/smoke.ts, the sim's own curve) and the puff layout is seeded by the cloud id, so every client draws the
 * same cloud. FAIRNESS: no quality knob is read here; size, opacity and the veil are identical on low, medium and high.
 *
 * The volume is UNLIT (vertex colours with the lit / mid / shade bands baked by normal): smoke must read the same in
 * every look preset (art §10 guardrail), including the dark office After Hours. The core (0.88 r) is fully opaque and
 * depth-writing, so it hides whatever is behind it without blending. The puffs sit on a shell up to 1.02 r, flattened on
 * the ground side. Fade: a screen-space 4x4 Bayer dissolve, top puffs first, core last, on top of the sim's shrinking
 * radius. Reduced motion: no churn, no pop overshoot; growth and fade still follow r(t).
 *
 * Input: `SmokeCloudView[]` (FrameView.smokes; `radius` and `center` already computed by ClientGame). Until
 * ClientGame fills it, `cloudViewsFrom` builds the same views from plain `SmokeCloudState`s with smoke.ts.
 */
import * as THREE from 'three';
import type { SmokeCloudBalance } from '../shared/balance';
import type { SmokeCloudView } from '../shared/contracts';
import { smokeCenter, smokeGoneAt, smokeRadiusAt } from '../shared/smoke';
import type { SmokeCloudState } from '../shared/types';

/** Puffs per cloud (art §4.2). */
export const SMOKE_PUFFS = 22;
/** Visual core radius as a share of the sim radius (always inside it). */
export const SMOKE_CORE_SCALE = 0.88;
/** Puff shell: inner and outer extent as a share of the sim radius; puff radius range. */
const SHELL_IN = 0.7;
const SHELL_OUT = 1.02;
const PUFF_R_MIN = 0.28;
const PUFF_R_MAX = 0.42;
/** No puff below ground + this share of r. */
const GROUND_CLEAR = 0.15;
/** Veil reaches full strength at this share of r from the centre (art: smoothstep(r, 0.75 r, d) x 0.96). */
const VEIL_FULL_AT = 0.75;
const VEIL_MAX = 0.96;
const HULL_WIDTH = 0.035;
const HULL_MIN_SCREEN = 0.0012;
const POP_MS = 300;
const POP_PUFFS = 6;
/** Absolute cap (the art budget assumes 8; balance maxActive is 12). */
const MAX_CLOUDS = 16;

export const SMOKE_PALETTE = {
  lit: 0xfbeaf6,
  mid: 0xebcff0,
  shadow: 0xc9aedf,
  hull: 0x4a3a52,
  veil: 0xefddf2,
  vignette: 0xc9aedf,
} as const;

/** Deterministic 32-bit PRNG (mulberry32) for the puff layout of one cloud id. Pure; exported for tests. */
export function puffRng(seed: number): () => number {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Puff layout in units of r, centred on the cloud centre: x, y, z, radius, phase, period (s), height rank 0..1. */
export interface PuffLayout {
  data: Float32Array;
}
const PUFF_STRIDE = 7;

/**
 * The 22 puffs of a cloud, seeded by its id. `groundBelow` = (centre height above the deploy point) / r at full size:
 * puffs are pushed up so none reaches below ground + 0.15 r. Pure; exported for tests.
 */
export function puffLayout(id: number, groundBelow: number, out = new Float32Array(SMOKE_PUFFS * PUFF_STRIDE)): Float32Array {
  const rnd = puffRng(id);
  for (let i = 0; i < SMOKE_PUFFS; i++) {
    // Uniform direction, biased up a little (a mound, not a ball).
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    let dx = s * Math.cos(th), dy = u * 0.8 + 0.2, dz = s * Math.sin(th);
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    const pr = PUFF_R_MIN + rnd() * (PUFF_R_MAX - PUFF_R_MIN);
    const outer = SHELL_IN + rnd() * (SHELL_OUT - SHELL_IN);
    const d = Math.max(0, outer - pr);
    let y = dy * d;
    const minY = -groundBelow + GROUND_CLEAR + pr;
    if (y < minY) y = minY;
    const o = i * PUFF_STRIDE;
    out[o] = dx * d;
    out[o + 1] = y;
    out[o + 2] = dz * d;
    out[o + 3] = pr;
    out[o + 4] = rnd() * Math.PI * 2;
    out[o + 5] = 3 + rnd() * 2;
    out[o + 6] = 0;
  }
  // Height rank (0 = lowest, 1 = highest): the fade dissolves the top puffs first.
  const order = Array.from({ length: SMOKE_PUFFS }, (_, i) => i).sort((a, b) => out[a * PUFF_STRIDE + 1] - out[b * PUFF_STRIDE + 1]);
  order.forEach((idx, rank) => (out[idx * PUFF_STRIDE + 6] = rank / (SMOKE_PUFFS - 1)));
  return out;
}

/** Veil opacity for a camera `d` metres from a cloud centre of radius `r`: smoothstep(r, 0.75 r, d) x 0.96. Pure. */
export function veilOpacity(d: number, r: number): number {
  if (!(r > 0) || d >= r) return 0;
  const e0 = r, e1 = r * VEIL_FULL_AT;
  let x = (d - e0) / (e1 - e0);
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  return x * x * (3 - 2 * x) * VEIL_MAX;
}

/**
 * Dissolve amounts (0 = solid, 1 = gone) for the fade progress `k` (0..1): a puff at height rank h starts at
 * (1 - h) x 0.5 and is gone 0.5 later (top first); the core starts at 0.6 and is gone at 1. Pure; exported for tests.
 */
export function puffDissolve(k: number, rank: number): number {
  if (k <= 0) return 0;
  const start = (1 - rank) * 0.5;
  return Math.min(1, Math.max(0, (k - start) / 0.5));
}
export function coreDissolve(k: number): number {
  return k <= 0.6 ? 0 : Math.min(1, (k - 0.6) / 0.4);
}

/**
 * Fill `out` with SmokeCloudViews for `clouds` at server time `t` (the producer side ClientGame will own; used by the
 * prototype harness and tests). Clouds with radius 0 are skipped. Reuses `out`'s objects.
 */
export function cloudViewsFrom(
  clouds: readonly SmokeCloudState[],
  t: number,
  cfg: SmokeCloudBalance,
  out: SmokeCloudView[],
): SmokeCloudView[] {
  let n = 0;
  for (const c of clouds) {
    if (t >= smokeGoneAt(c, cfg)) continue;
    const r = smokeRadiusAt(c, t, cfg);
    if (r <= 0) continue;
    let v = out[n];
    if (!v) out[n] = v = { id: c.id, ownerId: c.ownerId, pos: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 }, radius: 0, deployedAt: 0, fadeAt: 0 };
    v.id = c.id;
    v.ownerId = c.ownerId;
    v.pos.x = c.pos.x; v.pos.y = c.pos.y; v.pos.z = c.pos.z;
    smokeCenter(c, cfg, v.center);
    v.radius = r;
    v.deployedAt = c.deployedAt;
    v.fadeAt = c.fadeAt;
    n++;
  }
  out.length = n;
  return out;
}

const DISSOLVE_ATTR = 'instanceDissolve';

/** Unlit vertex colour + per-instance Bayer dissolve (screen space, fixed: it does not shimmer with a still camera). */
function dissolveChunks(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute float ${DISSOLVE_ATTR};\nvarying float vDissolve;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\nvDissolve = ${DISSOLVE_ATTR};`);
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
varying float vDissolve;
float bayer4(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}`,
    )
    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vDissolve > 0.0 && bayer4(gl_FragCoord.xy) < vDissolve) discard;');
}

function volumeMaterial(name: string, side: THREE.Side): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, side, toneMapped: false });
  m.name = name;
  m.onBeforeCompile = dissolveChunks;
  m.customProgramCacheKey = () => `smoke:volume:${side}`;
  return m;
}

function hullMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: SMOKE_PALETTE.hull, side: THREE.BackSide });
  m.name = 'smoke:hull';
  m.onBeforeCompile = (shader) => {
    dissolveChunks(shader);
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      {
        vec3 olN = normal;
        #ifdef USE_INSTANCING
          olN = mat3( instanceMatrix ) * olN;
        #endif
        olN = normalize( normalMatrix * olN );
        float olW = max( ${HULL_WIDTH.toFixed(4)}, -mvPosition.z * ${HULL_MIN_SCREEN.toFixed(5)} );
        mvPosition.xyz += olN * olW;
        gl_Position = projectionMatrix * mvPosition;
      }`,
    );
  };
  m.customProgramCacheKey = () => 'smoke:hull';
  return m;
}

/** Bake the toon bands into vertex colours by normal y (lit on top, shadow underneath). */
function bandedSphere(detail: number, bands: boolean): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const n = g.getAttribute('normal');
  const col = new Float32Array(n.count * 3);
  const lit = new THREE.Color(SMOKE_PALETTE.lit), mid = new THREE.Color(SMOKE_PALETTE.mid), sh = new THREE.Color(SMOKE_PALETTE.shadow);
  for (let i = 0; i < n.count; i++) {
    const y = n.getY(i);
    const c = !bands ? mid : y > 0.35 ? lit : y > -0.3 ? mid : sh;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

interface CloudSlot {
  id: number;
  layout: Float32Array;
  groundBelow: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class SmokeLayer {
  readonly group = new THREE.Group();
  readonly core: THREE.InstancedMesh;
  readonly puffs: THREE.InstancedMesh;
  readonly hulls: THREE.InstancedMesh;
  /** Full-screen veil (clip-space quad), drawn last in the world pass, i.e. before the viewmodel pass. */
  readonly veil: THREE.Mesh;
  private readonly veilMat: THREE.ShaderMaterial;
  private readonly coreDis: THREE.InstancedBufferAttribute;
  private readonly puffDis: THREE.InstancedBufferAttribute;
  private readonly hullDis: THREE.InstancedBufferAttribute;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly slots = new Map<number, CloudSlot>();
  private readonly seen = new Set<number>();
  /** Current veil opacity (tests / dev). */
  veilAmount = 0;

  constructor() {
    this.group.name = 'smoke';
    const coreGeo = bandedSphere(2, false);
    const puffGeo = bandedSphere(1, true);
    this.geos.push(coreGeo, puffGeo);
    const coreMat = volumeMaterial('smoke:core', THREE.FrontSide);
    const puffMat = volumeMaterial('smoke:puffs', THREE.DoubleSide);
    const hullMat = hullMaterial();
    this.mats.push(coreMat, puffMat, hullMat);

    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string): [THREE.InstancedMesh, THREE.InstancedBufferAttribute] => {
      // Each mesh gets its own geometry wrapper so the per-instance dissolve attribute is not shared.
      const g = geo.clone();
      this.geos.push(g);
      const dis = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      dis.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(DISSOLVE_ATTR, dis);
      const m = new THREE.InstancedMesh(g, mat, cap);
      m.name = name;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      this.group.add(m);
      return [m, dis];
    };
    [this.core, this.coreDis] = mk(coreGeo, coreMat, MAX_CLOUDS, 'smoke:core');
    [this.puffs, this.puffDis] = mk(puffGeo, puffMat, MAX_CLOUDS * SMOKE_PUFFS, 'smoke:puffs');
    [this.hulls, this.hullDis] = mk(puffGeo, hullMat, MAX_CLOUDS * SMOKE_PUFFS, 'smoke:puffHulls');

    const veilGeo = new THREE.PlaneGeometry(2, 2);
    this.geos.push(veilGeo);
    this.veilMat = new THREE.ShaderMaterial({
      name: 'smoke:veil',
      uniforms: {
        uColor: { value: new THREE.Color(SMOKE_PALETTE.veil) },
        uVignette: { value: new THREE.Color(SMOKE_PALETTE.vignette) },
        uAmount: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform vec3 uVignette;
        uniform float uAmount;
        varying vec2 vUv;
        void main() {
          float e = smoothstep(0.35, 0.75, length(vUv - 0.5));
          vec3 c = mix(uColor, uVignette, e * 0.3);
          gl_FragColor = vec4(c, clamp(uAmount + e * 0.3 * step(0.001, uAmount), 0.0, 1.0));
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.mats.push(this.veilMat);
    this.veil = new THREE.Mesh(veilGeo, this.veilMat);
    this.veil.name = 'smoke:veil';
    this.veil.frustumCulled = false;
    this.veil.renderOrder = 10000;
    this.veil.visible = false;
    this.group.add(this.veil);
  }

  /**
   * @param clouds live clouds (radius and centre at the frame's server time)
   * @param serverTime FrameView.serverTime (ms)
   * @param cfg items.smoke.cloud (fade length, centre height); null = draw nothing
   * @param cam camera world position (veil)
   * @param time render clock (s) for the churn
   */
  update(
    clouds: readonly SmokeCloudView[],
    serverTime: number,
    cfg: SmokeCloudBalance | null,
    cam: THREE.Vector3,
    time: number,
    reducedMotion: boolean,
  ): void {
    let nc = 0, np = 0, veil = 0;
    this.seen.clear();
    if (cfg) {
      for (let ci = 0; ci < clouds.length && nc < MAX_CLOUDS; ci++) {
        const c = clouds[ci];
        const r = c.radius;
        if (!(r > 0)) continue;
        this.seen.add(c.id);
        let slot = this.slots.get(c.id);
        if (!slot) {
          const groundBelow = cfg.radius > 0 ? cfg.centerHeight / cfg.radius : 0;
          slot = { id: c.id, groundBelow, layout: puffLayout(c.id, groundBelow) };
          this.slots.set(c.id, slot);
        }
        const age = serverTime - c.deployedAt;
        const k = cfg.fadeMs > 0 ? Math.min(1, Math.max(0, (serverTime - c.fadeAt) / cfg.fadeMs)) : serverTime >= c.fadeAt ? 1 : 0;
        const cx = c.center.x, cy = c.center.y, cz = c.center.z;

        // Core.
        _s.setScalar(r * SMOKE_CORE_SCALE);
        _m.compose(_p.set(cx, cy, cz), _q.identity(), _s);
        this.core.setMatrixAt(nc, _m);
        this.coreDis.setX(nc, coreDissolve(k));
        nc++;

        // Puffs (+ hulls with the same matrix).
        const L = slot.layout;
        for (let i = 0; i < SMOKE_PUFFS; i++) {
          const o = i * PUFF_STRIDE;
          let pr = L[o + 3] * r;
          let bob = 0;
          if (!reducedMotion) {
            const w = (Math.PI * 2) / L[o + 5];
            bob = Math.sin(time * w + L[o + 4]) * 0.04 * r;
            if (i < POP_PUFFS && age >= 0 && age < POP_MS) pr *= 1 + 0.1 * Math.sin((Math.PI * age) / POP_MS);
            _e.set(0, time * w * 0.15 + L[o + 4], 0);
            _q.setFromEuler(_e);
          } else {
            _q.identity();
          }
          _s.set(pr, pr * 0.9, pr);
          _m.compose(_p.set(cx + L[o] * r, cy + L[o + 1] * r + bob, cz + L[o + 2] * r), _q, _s);
          this.puffs.setMatrixAt(np, _m);
          this.hulls.setMatrixAt(np, _m);
          const dis = puffDissolve(k, L[o + 6]);
          this.puffDis.setX(np, dis);
          this.hullDis.setX(np, dis);
          np++;
        }

        // Veil: the camera inside this cloud's sim sphere.
        const d = Math.hypot(cam.x - cx, cam.y - cy, cam.z - cz);
        const v = veilOpacity(d, r);
        if (v > veil) veil = v;
      }
    }
    // Forget clouds that are gone (layouts are cheap to rebuild if an id comes back).
    if (this.slots.size > this.seen.size) for (const id of this.slots.keys()) if (!this.seen.has(id)) this.slots.delete(id);

    this.flush(this.core, this.coreDis, nc);
    this.flush(this.puffs, this.puffDis, np);
    this.flush(this.hulls, this.hullDis, np);
    this.veilAmount = veil;
    this.veilMat.uniforms.uAmount.value = veil;
    this.veil.visible = veil > 0.001;
  }

  private flush(m: THREE.InstancedMesh, dis: THREE.InstancedBufferAttribute, n: number): void {
    m.count = n;
    m.visible = n > 0;
    if (n > 0) {
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, n * 16);
      m.instanceMatrix.needsUpdate = true;
      dis.clearUpdateRanges();
      dis.addUpdateRange(0, n);
      dis.needsUpdate = true;
    }
  }

  get cloudCount(): number {
    return this.core.count;
  }

  dispose(): void {
    for (const m of [this.core, this.puffs, this.hulls]) m.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.slots.clear();
    this.group.clear();
  }
}
