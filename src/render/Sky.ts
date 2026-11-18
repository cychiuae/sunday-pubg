/**
 * Sky dome (gradient + toon sun), a ring of chunky low-poly clouds, and the lights: one shadow-casting sun whose
 * tight orthographic shadow frustum follows the camera target (texel-snapped to stop shimmering) plus a hemisphere
 * fill light. Owner: graphics-engineer.
 */
import * as THREE from 'three';
import { skyFragment, skyVertex } from './shaders/sky';
import { buildMerged, palette, type Piece } from './procedural';

/** Direction TO the sun (normalised). Late-morning sun from the south-east so shadows fall north-west. */
export const SUN_DIRECTION = new THREE.Vector3(0.48, 0.78, 0.4).normalize();

/** Light intensities tuned for MeshToonMaterial (lit = albedo * (sun * ramp + hemi) / PI). */
export const LIGHTING = {
  sun: 1.65,
  hemi: 1.55,
  fogNear: 140,
  fogFar: 900,
  skyRadius: 2000,
} as const;

export class Sky {
  readonly group = new THREE.Group();
  private readonly dome: THREE.Mesh;
  private readonly clouds: THREE.Mesh;
  private readonly materials: THREE.Material[] = [];

  constructor() {
    this.group.name = 'sky';
    const domeGeo = new THREE.SphereGeometry(LIGHTING.skyRadius, 32, 16);
    const domeMat = new THREE.ShaderMaterial({
      name: 'sky',
      uniforms: {
        uTop: { value: new THREE.Color(palette.skyTop) },
        uHorizon: { value: new THREE.Color(palette.skyHorizon) },
        uSun: { value: new THREE.Color(palette.sunLight).lerp(new THREE.Color(0xffffff), 0.5) },
        uSunDir: { value: SUN_DIRECTION.clone() },
      },
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(domeGeo, domeMat);
    this.dome.name = 'skyDome';
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    this.materials.push(domeMat);
    this.group.add(this.dome);

    this.clouds = this.buildClouds();
    this.group.add(this.clouds);
  }

  private buildClouds(): THREE.Mesh {
    const pieces: Piece[] = [];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const COUNT = 14;
    for (let i = 0; i < COUNT; i++) {
      const a = (i / COUNT) * Math.PI * 2 + rnd() * 0.3;
      const dist = 1150 + rnd() * 350;
      const cx = Math.cos(a) * dist, cz = Math.sin(a) * dist, cy = 170 + rnd() * 200;
      const scale = 40 + rnd() * 45;
      const blobs = 4 + Math.floor(rnd() * 3);
      for (let b = 0; b < blobs; b++) {
        const t = b / (blobs - 1) - 0.5;
        const r = scale * (0.55 + rnd() * 0.45) * (1 - Math.abs(t) * 0.6);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(cx + Math.cos(a + Math.PI / 2) * t * scale * 2.4, cy + r * 0.2, cz + Math.sin(a + Math.PI / 2) * t * scale * 2.4),
          new THREE.Quaternion(),
          new THREE.Vector3(r, r * 0.62, r),
        );
        pieces.push({
          geo: new THREE.IcosahedronGeometry(1, 1),
          color: 0xffffff,
          matrix: m,
          flat: true,
          outline: false,
          colorFn: (n) => (n.y < -0.25 ? 0xd9ecfa : n.y < 0.2 ? 0xf1f8ff : 0xffffff),
        });
      }
    }
    const merged = buildMerged(pieces, 'clouds');
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false });
    mat.name = 'clouds';
    this.materials.push(mat);
    const mesh = new THREE.Mesh(merged.geometry, mat);
    mesh.name = 'clouds';
    mesh.frustumCulled = false;
    mesh.renderOrder = -9;
    return mesh;
  }

  /** Keep the dome and clouds centred on the camera (infinitely far). */
  update(camera: THREE.Camera, time: number): void {
    this.group.position.copy(camera.position);
    this.clouds.rotation.y = time * 0.002;
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.clouds.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }
}

/**
 * M2b: the per-map light and atmosphere (island = late-morning sun; office = STYLE.md §19.4 fluorescent key light).
 * Applied by Renderer on a map change.
 */
export interface SceneLook {
  /** Direction TO the key light (normalised by the rig). */
  sunDir: THREE.Vector3;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  /** Clear colour and scene background. */
  background: number;
  /** Shadow depth bias and normal bias (the office's tall walls under an overhead light need more). */
  shadowBias?: number;
  shadowNormalBias?: number;
}

export const ISLAND_LOOK: SceneLook = {
  sunDir: SUN_DIRECTION,
  sunColor: palette.sunLight,
  sunIntensity: LIGHTING.sun,
  hemiSky: palette.hemiSky,
  hemiGround: palette.hemiGround,
  hemiIntensity: LIGHTING.hemi,
  fogColor: palette.fog,
  fogNear: LIGHTING.fogNear,
  fogFar: LIGHTING.fogFar,
  background: palette.fog,
};

export class SunRig {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly dir = SUN_DIRECTION.clone();
  private halfExtent = 40;
  private mapSize = 2048;
  private readonly lightSpace = new THREE.Matrix4();
  private readonly lightSpaceInv = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector3();

  constructor() {
    this.sun = new THREE.DirectionalLight(palette.sunLight, LIGHTING.sun);
    this.sun.name = 'sun';
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.hemi = new THREE.HemisphereLight(palette.hemiSky, palette.hemiGround, LIGHTING.hemi);
    this.hemi.name = 'hemi';
    this.setBasis();
  }

  /** M2b: switch the key/fill light to a map's look (direction, colours, intensities). */
  setLook(look: SceneLook): void {
    this.dir.copy(look.sunDir).normalize();
    this.sun.color.setHex(look.sunColor);
    this.sun.intensity = look.sunIntensity;
    this.hemi.color.setHex(look.hemiSky);
    this.hemi.groundColor.setHex(look.hemiGround);
    this.hemi.intensity = look.hemiIntensity;
    this.sun.shadow.bias = look.shadowBias ?? -0.0004;
    this.sun.shadow.normalBias = look.shadowNormalBias ?? 0.035;
    this.setBasis();
  }

  private setBasis(): void {
    // Light space basis (rotation only) for texel snapping. lookAt needs an up that is not parallel to the view.
    const up = Math.abs(this.dir.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    this.lightSpace.lookAt(new THREE.Vector3(), this.dir.clone().negate(), up);
    this.lightSpaceInv.copy(this.lightSpace).invert();
  }

  configure(enabled: boolean, mapSize: number, halfExtent: number): void {
    this.sun.castShadow = enabled;
    this.halfExtent = halfExtent;
    if (mapSize !== this.mapSize || this.sun.shadow.map === null) {
      this.mapSize = mapSize;
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    const cam = this.sun.shadow.camera;
    cam.left = -halfExtent;
    cam.right = halfExtent;
    cam.top = halfExtent;
    cam.bottom = -halfExtent;
    cam.updateProjectionMatrix();
  }

  /** Centre the shadow frustum on `focus`, snapped to whole shadow texels in light space. */
  follow(focus: THREE.Vector3): void {
    const texel = (this.halfExtent * 2) / this.mapSize;
    const p = this.tmp.copy(focus).applyMatrix4(this.lightSpaceInv);
    p.x = Math.round(p.x / texel) * texel;
    p.y = Math.round(p.y / texel) * texel;
    p.applyMatrix4(this.lightSpace);
    this.sun.target.position.copy(p);
    this.sun.position.copy(p).addScaledVector(this.dir, 120);
    this.sun.target.updateMatrixWorld();
  }
}
